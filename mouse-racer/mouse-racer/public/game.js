// Mouse Racer client: pedal input, prediction, reconciliation, interpolation, rendering.
// Steering is automatic (racing line); players only work gas and brake.
import { DT, CAR, SPEED, TUNE, setSpeed, createCar, stepCar, rpmOf, GEARS, clamp, wrapAngle, lerp, lerpAngle } from './shared/physics.js';
import { TRACK, ROAD_HALF, WALL, pointAt, queryTrack } from './shared/track.js';
import { simulateCar, collideCars, gridSlot, playerSlot, newRace, updateRace, makeBot, botInput, decideLanes, applyTuning, setBotTuning, BOTS } from './shared/world.js';
import { LINE } from './shared/track.js';

// Asset URL: the single-file build inlines images into window.MR_ASSETS.
const asset = (p) => (window.MR_ASSETS && window.MR_ASSETS[p]) || `./${p}`;

// Practice field: you start at the back of the grid, with the bots ahead to pass.
const FIELD_MIN = 2, FIELD_MAX = 20, FIELD_DEFAULT = 4;
const INTERP_MS = 100;          // render remote cars this far in the past
const BOT_NAMES = ['Ferro', 'Nakamura', 'Okafor', 'Lindqvist', 'Moreau', 'Haddad', 'Kowalski', 'Ibarra', 'Tanaka', 'Osei',
  'Brandt', 'Rossi', 'Novak', 'Achebe', 'Varga', 'Silva', 'Duarte', 'Kim', 'Petrov'];
const BOT_COLORS = ['#3b82f6', '#22c55e', '#a855f7', '#f5b700', '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#6366f1', '#06b6d4',
  '#d946ef', '#facc15', '#10b981', '#8b5cf6', '#fb7185', '#38bdf8', '#a3e635', '#c084fc', '#2dd4bf'];
const FONT_D = '"Saira Condensed", "Arial Narrow", sans-serif';
const FONT_B = '"IBM Plex Sans", system-ui, sans-serif';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = canvas.clientWidth; H = canvas.clientHeight;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- input
const keys = { gas: false, brake: false, handbrake: false };
const KEYMAP = { KeyW: 'gas', ArrowUp: 'gas', KeyS: 'brake', ArrowDown: 'brake', Space: 'handbrake' };
// Touch or click: hold the right half of the screen for gas, the left half to brake.
const pointers = new Map();   // pointerId -> 'gas' | 'brake'
canvas.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, e.clientX > W / 2 ? 'gas' : 'brake');
  canvas.setPointerCapture?.(e.pointerId);
});
const release = (e) => pointers.delete(e.pointerId);
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
const pointerPedal = (k) => [...pointers.values()].includes(k);
let started = false;   // hides the first-run hint
addEventListener('blur', () => { keys.gas = keys.brake = keys.handbrake = false; pointers.clear(); });
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && (e.target.type === 'text' || e.code.startsWith('Arrow'))) return;   // typing / slider keys
  const k = KEYMAP[e.code];
  if (k) { keys[k] = true; e.preventDefault(); }
  if (e.code === 'KeyR' && !e.repeat) respawn();
});
addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) keys[k] = false; });

// Game controller (Xbox layout; any pad the browser reports with the "standard" mapping).
// RT = gas and LT = brake, both analog; A / X are full gas / brake as buttons.
// B or RB = handbrake, Y or View = back to the grid, Menu = show/hide settings.
const gpad = { gas: 0, brake: 0, handbrake: false, id: null, held: {} };
const PAD_DEAD = 0.06;
const trig = (v) => (v < PAD_DEAD ? 0 : Math.min(1, (v - PAD_DEAD) / (0.95 - PAD_DEAD)));
function activePad() {
  const list = navigator.getGamepads ? [...navigator.getGamepads()].filter((g) => g && g.connected) : [];
  return list.find((g) => g.mapping === 'standard') || list[0] || null;
}
addEventListener('gamepadconnected', (e) => {
  toast(`Controller connected · RT gas · LT brake`, '#7dd3fc');
  started = true;
  if (e.gamepad.mapping !== 'standard') toast('Controller layout not recognised: buttons may differ', '#ffc83d');
});
addEventListener('gamepaddisconnected', () => toast('Controller disconnected', '#ffc83d'));
function pollPad() {
  const gp = activePad();
  gpad.id = gp ? gp.id : null;
  if (!gp) { gpad.gas = gpad.brake = 0; gpad.handbrake = false; return; }
  const b = (i) => gp.buttons[i] || { value: 0, pressed: false };
  gpad.gas = Math.max(trig(b(7).value), b(0).pressed ? 1 : 0);
  gpad.brake = Math.max(trig(b(6).value), b(2).pressed ? 1 : 0);
  gpad.handbrake = b(1).pressed || b(5).pressed;
  // one-shot buttons fire on the press, not while held
  const tap = (i) => { const p = b(i).pressed, was = gpad.held[i]; gpad.held[i] = p; return p && !was; };
  if (tap(3) | tap(8)) respawn();
  if (tap(9)) $('set-toggle').click();
}
// Rumble (where the browser supports it): a spin, or a big hit that costs speed.
function rumble(strong, weak, ms) {
  const gp = activePad();
  try { gp?.vibrationActuator?.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }); } catch {}
}

// ---------------------------------------------------------------- your car
let myKind = 'gt';
try { const k = JSON.parse(localStorage.getItem('mr-car')); if (k === 'gt' || k === 'proto') myKind = k; } catch {}

// ---------------------------------------------------------------- settings panel
// Pace, tyre grip and acceleration change the car (room-wide when online);
// bot speed and bot mistakes only matter in practice mode.
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const PRESETS = {
  easy:   { grip: 1.2,  engine: 1.3, skill: 0.92, mistakes: 1.6 },
  normal: { grip: 1,    engine: 1,   skill: 1,    mistakes: 1 },
  hard:   { grip: 0.85, engine: 0.9, skill: 1.05, mistakes: 0.4 },
};
const AVG_SLOPPY = 0.38;   // average chance per corner that a bot makes a mistake, at 100%

function runFlatOut(c, steps) { for (let i = 0; i < steps; i++) stepCar(c, { tx: c.x + 300, ty: 0, throttle: true }); }
function estimateTopSpeed() {
  // the real car (gearbox included) flat out on a straight for 30 s
  const c = createCar(0, 0, 0);
  runFlatOut(c, 1800);
  return c.vx;
}
function timeToTop(top) {
  const c = createCar(0, 0, 0);
  let t = 0;
  while (c.vx < 0.9 * top && t < 3600) { runFlatOut(c, 1); t++; }
  return t / 60;
}

function showSettings() {
  const pct = (v) => Math.round(v * 100) + '%';
  $('pace').value = Math.round(SPEED * 100); $('pace-out').textContent = pct(SPEED);
  $('grip').value = Math.round(TUNE.grip * 100); $('grip-out').textContent = pct(TUNE.grip);
  $('accel').value = Math.round(TUNE.engine * 100); $('accel-out').textContent = pct(TUNE.engine);
  $('botspeed').value = Math.round(BOTS.skill * 100); $('botspeed-out').textContent = pct(BOTS.skill);
  const where = (net.url || '').replace(/^wss?:\/\//, '');
  $('join-btn').textContent = net.mode === 'offline' ? 'JOIN' : 'LEAVE';
  $('join-note').textContent = net.mode === 'online' ? `Racing on ${where}`
    : net.mode === 'connecting' ? `Connecting to ${where}…` : 'Practice with bots. Enter an address to race people.';
  if (document.activeElement !== $('join-addr') && net.mode === 'offline' && !$('join-addr').value) $('join-addr').value = store.get('mr-server') || '';
  $('field').value = field; $('field-out').textContent = field;
  $('field-note').textContent = `You and ${field - 1} bot${field === 2 ? '' : 's'} · you start last`;
  $('mistakes').value = Math.round(BOTS.mistakes * 100); $('mistakes-out').textContent = pct(BOTS.mistakes);
  const top = estimateTopSpeed();
  $('pace-note').textContent = `Top speed ${Math.round(top * 0.36)} km/h`;
  $('accel-note').textContent = `0 to top speed in ${timeToTop(top).toFixed(1)} s`;
  $('grip-note').textContent = TUNE.grip < 0.97 ? 'Less grip: slides sooner, brake earlier'
    : TUNE.grip > 1.03 ? 'More grip: corners can be taken faster' : 'Lower: slides sooner, brake earlier';
  const p = Math.min(0.95, AVG_SLOPPY * BOTS.mistakes);
  $('mistakes-note').textContent = p <= 0 ? 'Bots never make mistakes' : p > 0.6 ? 'Mistakes at most corners' : `About 1 corner in ${Math.round(1 / p)}`;
  $('botspeed-note').textContent = BOTS.skill < 0.97 ? 'Bots drive more carefully' : BOTS.skill > 1.03 ? 'Bots push harder' : 'How hard the bots push';
  for (const btn of document.querySelectorAll('[data-car]')) btn.setAttribute('aria-pressed', String(btn.dataset.car === myKind));
  // which preset (if any) matches
  for (const btn of document.querySelectorAll('[data-preset]')) {
    const pr = PRESETS[btn.dataset.preset];
    const on = Math.abs(pr.grip - TUNE.grip) < 0.01 && Math.abs(pr.engine - TUNE.engine) < 0.01 &&
      Math.abs(pr.skill - BOTS.skill) < 0.005 && Math.abs(pr.mistakes - BOTS.mistakes) < 0.01;
    btn.setAttribute('aria-pressed', String(on));
  }
  // bot settings only apply in practice mode
  const online = net.mode === 'online';
  for (const id of ['field', 'botspeed', 'mistakes']) {
    $(id).disabled = online;
    $('row-' + id).classList.toggle('off', online);
  }
  if (online) { $('field-note').textContent = 'Practice mode only'; $('botspeed-note').textContent = 'Practice mode only'; $('mistakes-note').textContent = 'Practice mode only'; }
}

function applyPace(v, fromServer) {
  setSpeed(v);
  if (!fromServer) store.set('mr-pace100', SPEED);
  showSettings();
}
function applyCar(t, fromServer) {
  applyTuning(t);
  if (!fromServer) store.set('mr-tune', { ...TUNE });
  showSettings();
}
function applyBots(t) {
  setBotTuning(t);
  store.set('mr-bots', { ...BOTS });
  showSettings();
}
function sendTune() { if (net.mode === 'online') send({ t: 'tune', v: { ...TUNE } }); }

$('pace').addEventListener('input', () => {
  applyPace(Number($('pace').value) / 100);
  if (net.mode === 'online') send({ t: 'speed', v: SPEED });
});
$('grip').addEventListener('input', () => { applyCar({ grip: Number($('grip').value) / 100 }); sendTune(); });
$('accel').addEventListener('input', () => { applyCar({ engine: Number($('accel').value) / 100 }); sendTune(); });
$('botspeed').addEventListener('input', () => applyBots({ skill: Number($('botspeed').value) / 100 }));
function joinFromField() {
  if (net.mode !== 'offline') { leaveServer(); return; }
  const url = wsUrl($('join-addr').value);
  if (!url) { $('join-addr').focus(); return; }
  net.addr = $('join-addr').value.trim();      // remembered once the server answers
  connect(url, true);
  $('join-addr').blur();
}
$('join-btn').addEventListener('click', () => { joinFromField(); $('join-btn').blur(); });
$('join-addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFromField(); });
$('field').addEventListener('input', () => {
  field = clamp(Number($('field').value), FIELD_MIN, FIELD_MAX);
  store.set('mr-field', field);
  if (net.mode === 'offline') { net.mode = 'restart'; startOffline(); toast(`New race · ${field} cars`); }
  showSettings();
});
$('mistakes').addEventListener('input', () => applyBots({ mistakes: Number($('mistakes').value) / 100 }));
for (const btn of document.querySelectorAll('[data-preset]')) {
  btn.addEventListener('click', () => {
    const pr = PRESETS[btn.dataset.preset];
    applyCar({ grip: pr.grip, engine: pr.engine });
    applyBots({ skill: pr.skill, mistakes: pr.mistakes });
    sendTune();
    btn.blur();                               // so Space (handbrake) doesn't press it again
  });
}
for (const btn of document.querySelectorAll('[data-car]')) {
  btn.addEventListener('click', () => {
    myKind = btn.dataset.car;
    store.set('mr-car', myKind);
    if (net.mode === 'online') send({ t: 'car', car: myKind });
    showSettings();
    btn.blur();
  });
}
$('set-toggle').addEventListener('click', () => {
  const body = $('set-body'), open = body.hidden;
  body.hidden = !open;
  $('set-toggle').textContent = open ? 'Hide' : 'Show';
  $('set-toggle').setAttribute('aria-expanded', String(open));
  store.set('mr-settings-open', open);
  $('set-toggle').blur();
});
{
  const pace = store.get('mr-pace100'), tune = store.get('mr-tune'), bots = store.get('mr-bots');
  if (tune) applyTuning(tune);
  if (bots) setBotTuning(bots);
  setSpeed(Number.isFinite(pace) ? pace : SPEED);
  // settings start folded away every time; the Show button brings them back
  { $('set-body').hidden = true; $('set-toggle').textContent = 'Show'; $('set-toggle').setAttribute('aria-expanded', 'false'); }
}

// ---------------------------------------------------------------- state
let field = FIELD_DEFAULT;
{
  const f = Number(params.get('cars')) || window.MR_FIELD || store.get('mr-field');
  if (Number.isFinite(f)) field = clamp(Math.round(f), FIELD_MIN, FIELD_MAX);
}
const myGrid = () => field - 1;

let myName = params.get('name');
if (!myName) { try { myName = localStorage.getItem('mr-name'); } catch {} }
if (!myName) { myName = 'Driver ' + Math.floor(100 + Math.random() * 900); try { localStorage.setItem('mr-name', myName); } catch {} }

const me = {
  id: 'me', name: myName, color: '#e94f37',
  car: playerSlot(myGrid()), race: newRace(),
  prev: null, vis: { x: 0, y: 0, a: 0 }, info: null,
};
let bots = [];
const remotes = new Map();
const net = { ws: null, mode: 'connecting', myId: null, seq: 0, pending: [], ping: 0, synced: false };
showSettings();
let tick = 0;
let lastInput = { throttle: false, brake: false, handbrake: false };
const toasts = [];

function toast(text, color = '#f3f1e8') { toasts.push({ text, color, t: performance.now() }); if (toasts.length > 3) toasts.shift(); }

// ---------------------------------------------------------------- networking
// Where to race online. A page served by the game server joins that server; the
// single-file build (or ?offline) starts in practice unless you give it a server
// address (settings → Play online, or ?server=192.168.1.23:3000).
function wsUrl(addr) {
  addr = String(addr || '').trim();
  if (!addr) return null;
  if (/^wss?:\/\//i.test(addr)) return addr;
  if (/^https:\/\//i.test(addr)) return 'wss://' + addr.slice(8).replace(/\/+$/, '');
  if (/^http:\/\//i.test(addr)) return 'ws://' + addr.slice(7).replace(/\/+$/, '');
  return 'ws://' + addr.replace(/\/+$/, '');
}
const servedByGame = !window.MR_OFFLINE && /^https?:$/.test(location.protocol);
function chosenServer() {
  if (params.has('offline')) return null;
  const p = params.get('server') || store.get('mr-server');
  if (p) return wsUrl(p);
  return servedByGame ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}` : null;
}

let connectTimer = 0;
function connect(url = chosenServer(), explicit = false) {
  if (!url) return startOffline();
  if (net.ws) { const old = net.ws; net.ws = null; old.onclose = null; try { old.close(); } catch {} }
  clearTimeout(connectTimer);
  net.mode = 'connecting'; net.url = url;
  showSettings();
  let ws;
  const fail = () => {
    toast(`Couldn't reach ${url.replace(/^wss?:\/\//, '')}. Practice mode.`, '#ffc83d');
    startOffline();
  };
  try { ws = new WebSocket(url); } catch { return fail(); }
  net.ws = ws;
  connectTimer = setTimeout(() => { if (net.ws === ws && net.mode === 'connecting') { ws.onclose = null; try { ws.close(); } catch {} explicit || store.get('mr-server') ? fail() : startOffline(); } }, 4000);
  ws.onopen = () => { clearTimeout(connectTimer); ws.send(JSON.stringify({ t: 'hello', name: myName, car: myKind })); };
  ws.onmessage = (e) => { if (net.ws !== ws) return; try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => {
    if (net.ws !== ws) return;
    clearTimeout(connectTimer);
    net.ws = null;
    if (net.mode === 'online') { toast('Disconnected. Practice mode.', '#ffc83d'); startOffline(); }
    else if (net.mode === 'connecting') fail();
  };
  ws.onerror = () => {};
}
setInterval(() => { if (net.mode === 'online') send({ t: 'ping', c: performance.now() }); }, 2000);

function leaveServer() {
  store.set('mr-server', null);
  const ws = net.ws; net.ws = null;
  if (ws) { ws.onclose = null; try { ws.close(); } catch {} }
  toast('Left the server. Practice mode.', '#a9b2a0');
  startOffline();
}

function send(m) { if (net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify(m)); }

function startOffline() {
  if (net.mode === 'offline') return;
  net.mode = 'offline'; net.url = null;
  showSettings();
  remotes.clear();
  me.car = playerSlot(myGrid()); me.race = newRace(); me.prev = null; me.vis = { x: 0, y: 0, a: 0 };
  bots = BOT_NAMES.slice(0, field - 1).map((name, i) => ({
    id: 'bot' + i, num: i + 1, name, color: BOT_COLORS[i], ai: makeBot(i + 1),
    car: gridSlot(i), race: newRace(), prev: null,
  }));
}

function onMessage(m) {
  if (m.t === 'welcome') {
    if (net.addr) { store.set('mr-server', net.addr); net.addr = null; }   // rejoin it next time
    net.mode = 'online'; net.myId = m.id; net.pending = []; net.synced = false; bots = [];
    if (m.speed) setSpeed(m.speed);          // the room's pace and car tuning win
    if (m.tune) applyTuning(m.tune);
    showSettings();
  } else if (m.t === 's') {
    onSnapshot(m);
  } else if (m.t === 'lap') {
    const who = m.id === net.myId ? null : remotes.get(m.id)?.name;
    const txt = `${fmt(m.time / 60)}${m.best ? '  best' : ''}`;
    if (!who) toast(`Lap ${txt}`, m.best ? '#ffc83d' : '#f3f1e8');
    else toast(`${who}  ${txt}`, '#a9b2a0');
  } else if (m.t === 'tune') {
    applyCar(m.v, true);
    if (m.by !== me.name) toast(`${m.by} changed the car settings`, '#a9b2a0');
  } else if (m.t === 'speed') {
    applyPace(m.v, true);
    if (m.by !== me.name) toast(`${m.by} set pace ${Math.round(m.v * 100)}%`, '#a9b2a0');
  } else if (m.t === 'pong') {
    net.ping = Math.round(performance.now() - m.c);
  } else if (m.t === 'full') {
    toast('Server full. Practice mode.', '#ffc83d');
  }
}

function raceFromSnap(c, now) {
  return { laps: c.lap, curBase: c.cur >= 0 ? c.cur / 60 : null, at: now, last: c.last / 60, best: c.best / 60 };
}

function onSnapshot(m) {
  const now = performance.now();
  const seen = new Set();
  for (const c of m.cars) {
    seen.add(c.id);
    if (c.id === net.myId) {
      me.name = c.n; me.color = c.c; me.info = raceFromSnap(c, now);
      reconcile(c);
      continue;
    }
    let r = remotes.get(c.id);
    if (!r) { r = { id: c.id, buf: [] }; remotes.set(c.id, r); }
    r.name = c.n; r.color = c.c; r.kind = c.k; r.info = raceFromSnap(c, now);
    r.buf.push({ t: now, x: c.x, y: c.y, a: c.a, vx: c.vx, vy: c.vy, steer: c.st });
    if (r.buf.length > 40) r.buf.shift();
  }
  for (const id of remotes.keys()) if (!seen.has(id)) remotes.delete(id);
}

// Server state is the truth; replay the inputs it hasn't seen yet on top of it.
function reconcile(s) {
  const c = me.car;
  const bx = c.x, by = c.y, ba = c.a;
  c.x = s.x; c.y = s.y; c.a = s.a; c.vx = s.vx; c.vy = s.vy; c.w = s.w; c.steer = s.st;
  c.gas = s.gas; c.brk = s.brk; c.rev = s.rev;
  c.lane = s.lane; c.laneAbs = s.la; c.pass = s.pass; c.passSide = s.ps; c.cap = s.cap; c.yieldTo = s.yt; c.gear = s.gr; c.shiftT = s.sh; c.sliding = s.sl; c.revHold = s.rh; c.rel = s.rl; c.miss = s.mi; c.passY = s.py; c.spin = s.sp; c.uturn = s.ut;
  net.pending = net.pending.filter((i) => i.seq > s.ack);
  for (const inp of net.pending) simulateCar(c, inp);
  if (!net.synced) { net.synced = true; me.prev = null; me.vis = { x: 0, y: 0, a: 0 }; return; }
  // Hide the correction: render offset that decays over a few frames.
  const dx = bx - c.x, dy = by - c.y, da = wrapAngle(ba - c.a);
  me.vis.x += dx; me.vis.y += dy; me.vis.a += da;
  if (me.prev) { me.prev.x -= dx; me.prev.y -= dy; me.prev.a -= da; }
  if (Math.hypot(me.vis.x, me.vis.y) > 250) me.vis = { x: 0, y: 0, a: 0 };
}

function respawn() {
  if (net.mode === 'online') { send({ t: 'respawn' }); return; }
  me.car = playerSlot(myGrid()); me.race = newRace(); me.prev = null;
  lastSpeed = 0;                 // so the jump back to the grid isn't felt as a crash
}

// ---------------------------------------------------------------- simulation
// Camera: fixed north-up at a constant zoom; it only slides to keep your car in view,
// leading a little in the direction you're travelling.
const cam = { x: me.car.x, y: me.car.y, zoom: 1, rot: 0, ay: 0.5 };

function readInput() {
  pollPad();
  // keyboard / touch are on-off; the controller's triggers give anything in between
  const inp = {
    throttle: keys.gas || pointerPedal('gas') ? 1 : gpad.gas,
    brake: keys.brake || pointerPedal('brake') ? 1 : gpad.brake,
    handbrake: keys.handbrake || gpad.handbrake,
  };
  if (inp.throttle || inp.brake) started = true;
  return inp;
}
let overshooting = false;

let lastPass = -1;
function announcePass() {
  const p = me.car.pass;
  if (p >= 0 && p !== lastPass) {
    const who = net.mode === 'online' ? remotes.get(p)?.name : bots.find((b) => b.num === p)?.name;
    toast(`Overtaking${who ? ' ' + who : ''}`, '#7dd3fc');
  }
  lastPass = p;
}

let wasSpin = false, lastSpeed = 0;
function fixedStep() {
  announcePass();
  if (me.car.spin && !wasSpin) { toast('SPUN OUT', '#ff5a4a'); rumble(1, 0.6, 450); }
  // a sudden loss of speed (barrier or a hard bump) gives a short jolt
  const spNow = Math.hypot(me.car.vx, me.car.vy);
  if (lastSpeed - spNow > 40 * SPEED) rumble(Math.min(1, (lastSpeed - spNow) / (150 * SPEED)), 0.4, 160);
  lastSpeed = spNow;
  wasSpin = me.car.spin;
  tick++;
  const inp = readInput();
  lastInput = inp;
  me.prev = { x: me.car.x, y: me.car.y, a: me.car.a };

  if (net.mode === 'online') {
    inp.seq = ++net.seq;
    net.pending.push(inp);
    if (net.pending.length > 240) net.pending.shift();
    send({ t: 'i', seq: inp.seq, g: Math.round(inp.throttle * 100) / 100, b: Math.round(inp.brake * 100) / 100, h: inp.handbrake ? 1 : 0 });
    simulateCar(me.car, inp);
    return;
  }

  // offline: we're the authority, so we decide overtakes (ids: me = 0, bots 1..N)
  decideLanes([{ id: 0, car: me.car }, ...bots.map((b) => ({ id: b.num, car: b.car }))]);
  const q = simulateCar(me.car, inp);
  const ev = updateRace(me.race, q.s, tick);
  if (ev) toast(`Lap ${fmt(ev.time / 60)}${ev.best ? '  best' : ''}`, ev.best ? '#ffc83d' : '#f3f1e8');
  const allCars = [me.car, ...bots.map((b) => b.car)];
  for (const b of bots) {
    b.prev = { x: b.car.x, y: b.car.y, a: b.car.a };
    const qb = simulateCar(b.car, botInput(b.ai, b.car, allCars));
    updateRace(b.race, qb.s, tick);
  }
  collideCars([me.car, ...bots.map((b) => b.car)]);
}

function localInfo(race) {
  return {
    laps: race.laps,
    cur: race.lapStart >= 0 ? (tick - race.lapStart) / 60 : null,
    last: race.lastLap / 60, best: race.bestLap / 60,
  };
}
function snapInfo(i, now) {
  if (!i) return { laps: 0, cur: null, last: 0, best: 0 };
  return { laps: i.laps, cur: i.curBase != null ? i.curBase + (now - i.at) / 1000 : null, last: i.last, best: i.best };
}

// Interpolate a remote car between the two snapshots around (now - INTERP_MS).
function remotePose(r, now) {
  const b = r.buf, t = now - INTERP_MS;
  if (!b.length) return null;
  if (t <= b[0].t) return b[0];
  for (let i = 0; i < b.length - 1; i++) {
    const s0 = b[i], s1 = b[i + 1];
    if (t >= s0.t && t <= s1.t) {
      const k = (t - s0.t) / (s1.t - s0.t || 1);
      return {
        x: lerp(s0.x, s1.x, k), y: lerp(s0.y, s1.y, k), a: lerpAngle(s0.a, s1.a, k),
        vx: lerp(s0.vx, s1.vx, k), vy: lerp(s0.vy, s1.vy, k), steer: lerp(s0.steer, s1.steer, k),
      };
    }
  }
  // Ran out of snapshots: extrapolate briefly.
  const s = b[b.length - 1], e = Math.min((t - s.t) / 1000, 0.15);
  return { ...s, x: s.x + s.vx * e, y: s.y + s.vy * e };
}

// ---------------------------------------------------------------- track art (prerendered)
const MARGIN = WALL + 260;
const B = TRACK.bounds;
const OX = B.minX - MARGIN, OY = B.minY - MARGIN;
const trackCanvas = document.createElement('canvas');
trackCanvas.width = Math.ceil(B.maxX - B.minX + MARGIN * 2);
trackCanvas.height = Math.ceil(B.maxY - B.minY + MARGIN * 2);
const tctx = trackCanvas.getContext('2d');

// Artwork cut from the track tile sheet (public/track/*.png): ground textures, kerbs,
// armco, tyre stacks, signs, gantry, pit lane and buildings. The layout itself is
// still the spline in track.js, so handling, bots and the racing line are unchanged.
const ART = {};
const ART_NAMES = ['grass', 'sand', 'asphalt', 'armco', 'gantry', 'pitlane', 'garage', 'office', 'tent',
  'chev_y1', 'chev_y2', 'cone', 'pole1', 'pole2', 'pole3',
  ...Array.from({ length: 8 }, (_, i) => `tyre${i}`)];
const artReady = Promise.all(ART_NAMES.map((n) => new Promise((res) => {
  const img = new Image();
  img.onload = () => { ART[n] = img; res(); };
  img.onerror = () => res();               // missing art just falls back to plain colours
  img.src = asset(`track/${n}.png`);
})));
const TEX_SCALE = 1.6;                     // sheet tiles are drawn ~half the size of this road
let grassPattern = null;
function texPattern(c, name, scale = TEX_SCALE) {
  if (!ART[name]) return null;
  const p = c.createPattern(ART[name], 'repeat');
  p.setTransform(new DOMMatrix().scale(scale));
  return p;
}

// Signed curvature along the centreline (rad per px, smoothed over ~80 px).
// Positive turns towards +normal, so the outside of the bend is the -normal side.
function curvAt(s) {
  const a = pointAt(s - 40).a, b = pointAt(s + 40).a;
  return wrapAngle(b - a) / 80;
}
// Stretches of track tighter than radius r: [{s0, s1, side}] with side = outside normal sign.
function bends(r) {
  const out = [], step = 10;
  let cur = null;
  for (let s = 0; s < TRACK.length; s += step) {
    const k = curvAt(s), tight = Math.abs(k) > 1 / r;
    if (tight && (!cur || Math.sign(k) !== -cur.side)) {
      if (cur) out.push(cur);
      cur = { s0: s, s1: s, side: -Math.sign(k) };
    } else if (tight) cur.s1 = s;
    else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  // join a bend that runs over the start line
  if (out.length > 1 && out[0].s0 === 0 && out[out.length - 1].s1 >= TRACK.length - step && out[0].side === out[out.length - 1].side) {
    const last = out.pop(); out[0].s0 = last.s0 - TRACK.length;
  }
  return out;
}

function drawTrackArt() {
  const c = tctx, Wc = trackCanvas.width, Hc = trackCanvas.height;
  c.setTransform(1, 0, 0, 1, 0, 0);
  // ground: sheet grass, with mown stripes
  c.fillStyle = texPattern(c, 'grass', 2) || '#3f6533';
  c.fillRect(0, 0, Wc, Hc);
  c.fillStyle = 'rgba(0,0,0,0.12)';
  c.fillRect(0, 0, Wc, Hc);
  c.fillStyle = 'rgba(255,255,255,0.035)';
  for (let x = 0; x < Wc; x += 120) c.fillRect(x, 0, 60, Hc);

  const X = (x) => x - OX, Y = (y) => y - OY;
  const path = () => {
    c.beginPath();
    TRACK.pts.forEach((p, i) => (i ? c.lineTo(X(p[0]), Y(p[1])) : c.moveTo(X(p[0]), Y(p[1]))));
    c.closePath();
  };
  c.lineJoin = 'round'; c.lineCap = 'round';
  const stroke = (w, style, dash) => { path(); c.setLineDash(dash || []); c.lineWidth = w; c.strokeStyle = style; c.stroke(); c.setLineDash([]); };
  // A band beside the road between offsets o0..o1 on one side, from s0 to s1.
  const band = (s0, s1, side, o0, o1, style, taper = 0) => {
    const st = 8, pts0 = [], pts1 = [];
    for (let s = s0; s <= s1 + 0.1; s += st) {
      const p = pointAt(s);
      const t = taper ? Math.min(1, (s - s0) / taper, (s1 - s) / taper) : 1;
      const a = o0, b = o0 + (o1 - o0) * Math.max(0, t);
      pts0.push([p.x + p.nx * side * a, p.y + p.ny * side * a]);
      pts1.push([p.x + p.nx * side * b, p.y + p.ny * side * b]);
    }
    c.beginPath();
    pts0.forEach(([x, y], i) => (i ? c.lineTo(X(x), Y(y)) : c.moveTo(X(x), Y(y))));
    for (let i = pts1.length - 1; i >= 0; i--) c.lineTo(X(pts1[i][0]), Y(pts1[i][1]));
    c.closePath(); c.fillStyle = style; c.fill();
  };

  // runoff: slightly brighter, closely mown grass inside the barriers
  stroke(WALL * 2 - 4, 'rgba(120,170,60,0.10)');

  // gravel traps on the outside of the tight bends (from the sheet's sand islands)
  const sand = texPattern(c, 'sand') || '#c9a66b';
  const tight = bends(420);
  for (const b of tight) {
    const s0 = b.s0 - 60, s1 = b.s1 + 160;           // traps reach past the exit, where cars run wide
    band(s0, s1, b.side, ROAD_HALF + 22, WALL - 14, 'rgba(70,52,25,0.55)', 90);   // damp edge
    band(s0, s1, b.side, ROAD_HALF + 26, WALL - 20, sand, 90);
  }

  // asphalt with a painted white edge line, like the sheet's straights
  stroke(ROAD_HALF * 2 + 4, '#2a2c2f');
  stroke(ROAD_HALF * 2, '#e9e6dc');
  stroke(ROAD_HALF * 2 - 8, texPattern(c, 'asphalt', 1.2) || '#3a3c40');
  stroke(ROAD_HALF * 2 - 8, 'rgba(20,22,28,0.18)');
  stroke(ROAD_HALF * 2 - 50, 'rgba(0,0,0,0.10)');    // rubbered-in racing line
  stroke(3, 'rgba(255,255,255,0.22)', [30, 45]);    // centre dashes

  // red/white kerbs through the corners, both edges, as in the sheet's curve tiles
  const kerbs = bends(700);
  for (const b of kerbs) for (const side of [-1, 1]) {
    const s0 = b.s0 - 30, s1 = b.s1 + 30, blk = 20;
    for (let s = s0, k = 0; s < s1; s += blk, k++) {
      band(s, Math.min(s + blk, s1), side, ROAD_HALF - 6, ROAD_HALF + 10, k % 2 ? '#f2f0ea' : '#d22b30');
    }
    band(s0, s1, side, ROAD_HALF + 8, ROAD_HALF + 10, 'rgba(0,0,0,0.25)');
  }

  // start/finish chequer
  const s = pointAt(0);
  c.save();
  c.translate(X(s.x), Y(s.y)); c.rotate(s.a);
  const sq = 12, rows = Math.ceil((ROAD_HALF * 2 - 8) / sq);
  for (let r = 0; r < rows; r++) for (let k = 0; k < 2; k++) {
    c.fillStyle = (r + k) % 2 ? '#111' : '#f1ede2';
    c.fillRect(k * sq - sq, -ROAD_HALF + 4 + r * sq, sq, Math.min(sq, ROAD_HALF * 2 - 8 - r * sq));
  }
  c.restore();

  // grid boxes: white brackets like the sheet's grid tile
  c.strokeStyle = 'rgba(241,237,226,0.75)'; c.lineWidth = 3; c.lineCap = 'butt';
  for (let i = 0; i < FIELD_MAX; i++) {
    const g = gridSlot(i);
    c.save(); c.translate(X(g.x), Y(g.y)); c.rotate(g.a);
    const fx = CAR.length / 2 + 8, hw = CAR.width / 2 + 7;
    c.beginPath();
    c.moveTo(fx - 12, -hw); c.lineTo(fx, -hw); c.lineTo(fx, hw); c.lineTo(fx - 12, hw);
    c.stroke();
    c.restore();
  }
  c.lineCap = 'round';

  // sprite helper: centre at world (x, y), rotated, scaled
  const put = (name, x, y, a = 0, scale = 1, alpha = 1) => {
    const img = ART[name]; if (!img) return;
    c.save(); c.globalAlpha = alpha; c.translate(X(x), Y(y)); c.rotate(a); c.scale(scale, scale);
    c.drawImage(img, -img.width / 2, -img.height / 2);
    c.restore();
  };
  // is a prop of radius r at (x, y) clear of every bit of road and barrier?
  const clearOf = (x, y, r) => queryTrack(x, y).dist > WALL + 12 + r;
  const inCanvas = (x, y, r) => X(x) > r && Y(y) > r && X(x) < Wc - r && Y(y) < Hc - r;

  // pit lane and garages beside the start straight, on the outside of it
  const PIT_S = 380, pside = -1;
  const pitPlace = (off, name, scale, along = 0) => {
    const q = pointAt(PIT_S + along), img = ART[name];
    if (!img) return;
    const x = q.x + q.nx * pside * off, y = q.y + q.ny * pside * off;
    if (inCanvas(x, y, 10)) put(name, x, y, q.a, scale);
  };
  pitPlace(WALL + 100, 'pitlane', 1.1);
  pitPlace(WALL + 245, 'garage', 1.05, -60);
  pitPlace(WALL + 240, 'office', 0.95, 170);
  pitPlace(WALL + 242, 'tent', 0.95, -275);

  // armco along both barriers: the sheet's rail strip stamped along the wall
  const rail = ART.armco;
  if (rail) {
    const seg = 24, h = 14, srcW = rail.width - 2;
    for (const side of [-1, 1]) {
      for (let s2 = 0, u = 0; s2 < TRACK.length; s2 += seg, u += seg) {
        const p = pointAt(s2 + seg / 2);
        const x = p.x + p.nx * side * (WALL + h / 2), y = p.y + p.ny * side * (WALL + h / 2);
        const sx = u % (srcW - seg);
        // on the inside of a hairpin the offset curve folds back on itself: skip that part
        if (queryTrack(x, y).dist < WALL - 2) continue;
        c.save(); c.translate(X(x), Y(y)); c.rotate(p.a + (side > 0 ? 0 : Math.PI));
        c.drawImage(rail, sx, 0, seg, rail.height, -seg / 2 - 1, -h / 2, seg + 2, h);
        c.restore();
      }
    }
  }

  // tyre walls in front of the armco where the gravel traps are, and chevrons on the approach
  let rng = 7;
  const rand = () => ((rng = (rng * 16807) % 2147483647) / 2147483647);
  for (const b of tight) {
    for (let s2 = b.s0 - 20; s2 < b.s1 + 140; s2 += 22) {
      const p = pointAt(s2), o = WALL - 10;
      put(`tyre${Math.floor(rand() * 8)}`, p.x + p.nx * b.side * o, p.y + p.ny * b.side * o, p.a + Math.PI / 2, 0.6);
    }
    // chevron boards behind the barrier, facing the approach
    for (let k = 0; k < 3; k++) {
      const p = pointAt(b.s0 + 10 + k * 70), o = WALL + 34;
      const x = p.x + p.nx * b.side * o, y = p.y + p.ny * b.side * o;
      if (clearOf(x, y, 10)) put(k % 2 ? 'chev_y1' : 'chev_y2', x, y, p.a + (b.side > 0 ? 0 : Math.PI), 0.8);
    }
  }

  // floodlight poles and a few cones around the outside
  for (let s2 = 150, k = 0; s2 < TRACK.length; s2 += 520, k++) {
    const p = pointAt(s2);
    for (const side of [-1, 1]) {
      const o = WALL + 55, x = p.x + p.nx * side * o, y = p.y + p.ny * side * o;
      if (clearOf(x, y, 30) && (k + side) % 2 === 0) put(`pole${1 + (k % 3)}`, x, y, 0, 0.8);
    }
  }
  for (const b of tight) {
    const p = pointAt(b.s1 + 200);
    for (let k = 0; k < 3; k++) {
      const x = p.x + p.nx * -b.side * (WALL + 30 + k * 18), y = p.y + p.ny * -b.side * (WALL + 30 + k * 18);
      if (clearOf(x, y, 10)) put('cone', x, y, 0, 0.5);
    }
  }
}
drawTrackArt();
// Redraw once the sheet artwork has loaded (skid marks so far are lost; it's at load time).
artReady.then(() => {
  drawTrackArt();
  if (ART.grass) {
    grassPattern = ctx.createPattern(ART.grass, 'repeat');
    grassPattern.setTransform(new DOMMatrix().translate(OX, OY).scale(2));
  }
});

// Start gantry with its lights, drawn above the cars (they pass under it).
function drawGantry() {
  const img = ART.gantry; if (!img) return;
  const p = pointAt(-6);
  const span = WALL * 2 + 30, sc = span / img.width;
  ctx.save();
  ctx.translate(p.x, p.y); ctx.rotate(p.a + Math.PI / 2);
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 6 * DPR; ctx.shadowOffsetX = 8 * DPR * cam.zoom; ctx.shadowOffsetY = 10 * DPR * cam.zoom;
  ctx.drawImage(img, -span / 2, -img.height * sc * 0.75, span, img.height * sc);
  ctx.restore();
}

// Skid marks are painted straight into the track canvas, so they cost nothing to keep.
const skidPrev = new Map();
function skid(key, x, y, a, vx, vy, braking) {
  const lat = Math.abs(-vx * Math.sin(a) + vy * Math.cos(a));
  const sp = Math.hypot(vx, vy);
  const on = lat > 60 * SPEED || (braking && sp > 220 * SPEED);
  const fx = Math.cos(a), fy = Math.sin(a), rx = -fy, ry = fx;
  const back = -CAR.length * 0.3, half = CAR.width / 2 - 3;
  const wheels = [
    [x + fx * back + rx * half, y + fy * back + ry * half],
    [x + fx * back - rx * half, y + fy * back - ry * half],
  ];
  const prev = skidPrev.get(key);
  if (on && prev) {
    tctx.strokeStyle = `rgba(15,15,15,${clamp(lat / (600 * SPEED), 0.12, 0.3)})`;
    tctx.lineWidth = 5; tctx.lineCap = 'round';
    for (let i = 0; i < 2; i++) {
      tctx.beginPath();
      tctx.moveTo(prev[i][0] - OX, prev[i][1] - OY);
      tctx.lineTo(wheels[i][0] - OX, wheels[i][1] - OY);
      tctx.stroke();
    }
  }
  skidPrev.set(key, on ? wheels : null);
}

// ---------------------------------------------------------------- rendering
// Car artwork (top-down, nose up). Drawn about 50 px long, keeping each car's proportions.
const CAR_KINDS = ['gt', 'proto'];
const CAR_LABELS = { gt: 'Road car', proto: 'Prototype' };
const SPRITES = {};
for (const k of CAR_KINDS) { const img = new Image(); img.src = asset(`cars/${k}.png`); SPRITES[k] = img; }
const SPRITE_LEN = 50;
const otherKind = (k) => (k === 'gt' ? 'proto' : 'gt');

function drawCar(x, y, a, steer, color, kind) {
  const img = SPRITES[kind];
  if (img && img.complete && img.naturalWidth) {
    const len = SPRITE_LEN, wid = len * img.naturalWidth / img.naturalHeight;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(a + Math.PI / 2);          // sprite nose points up (-y)
    // drop shadow (shadow offsets ignore the rotation, so the light stays in one place)...
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 3 * DPR;
    ctx.shadowOffsetX = 3 * DPR * cam.zoom; ctx.shadowOffsetY = 4 * DPR * cam.zoom;
    ctx.drawImage(img, -wid / 2, -len / 2, wid, len);
    // ...then a soft glow in the driver's colour, so everyone stays recognisable
    ctx.shadowColor = color; ctx.shadowBlur = 12 * DPR * cam.zoom; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    ctx.drawImage(img, -wid / 2, -len / 2, wid, len);
    ctx.restore();
    return;
  }
  // (fallback until the artwork has loaded)
  const L = CAR.length, Wd = CAR.width;
  ctx.save();
  ctx.translate(x, y); ctx.rotate(a);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.roundRect(-L / 2 + 3, -Wd / 2 + 5, L, Wd, 7); ctx.fill();
  // wheels
  ctx.fillStyle = '#121212';
  const wheel = (wx, wy, rot) => { ctx.save(); ctx.translate(wx, wy); ctx.rotate(rot); ctx.fillRect(-6, -3, 12, 6); ctx.restore(); };
  wheel(-L * 0.3, -Wd / 2, 0); wheel(-L * 0.3, Wd / 2, 0);
  wheel(L * 0.3, -Wd / 2, steer); wheel(L * 0.3, Wd / 2, steer);
  // body
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.roundRect(-L / 2, -Wd / 2, L, Wd, 7); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(-L / 2 + 4, -2.5, L - 8, 5);            // stripe
  ctx.fillStyle = 'rgba(14,20,30,0.85)';
  ctx.beginPath(); ctx.roundRect(-4, -Wd / 2 + 3, 13, Wd - 6, 3); ctx.fill();   // canopy
  ctx.fillStyle = '#ffe9a8';
  ctx.fillRect(L / 2 - 3, -Wd / 2 + 3, 3, 4); ctx.fillRect(L / 2 - 3, Wd / 2 - 7, 3, 4);
  ctx.restore();
}

function worldToScreen(x, y) {
  const dx = x - cam.x, dy = y - cam.y;
  const c = Math.cos(cam.rot), s = Math.sin(cam.rot);
  return { x: (dx * c - dy * s) * cam.zoom + W / 2, y: (dx * s + dy * c) * cam.zoom + H * cam.ay };
}

function render(alpha, dtf) {
  const now = performance.now();

  // my render pose: interpolate between fixed steps, plus decaying correction
  const k = Math.exp(-dtf * 12);
  me.vis.x *= k; me.vis.y *= k; me.vis.a *= k;
  const p0 = me.prev || me.car;
  const myX = lerp(p0.x, me.car.x, alpha) + me.vis.x;
  const myY = lerp(p0.y, me.car.y, alpha) + me.vis.y;
  const myA = lerpAngle(p0.a, me.car.a, alpha) + me.vis.a;
  const speed = Math.hypot(me.car.vx, me.car.vy);

  // camera: fixed orientation and zoom, follows the car with a small lead
  cam.zoom = clamp(Math.min(W, H) / 900, 0.55, 1.3);
  const tx = myX + me.car.vx * 0.28 / SPEED, ty = myY + me.car.vy * 0.28 / SPEED;
  const ck = Math.min(1, dtf * 4);
  cam.x += (tx - cam.x) * ck; cam.y += (ty - cam.y) * ck;

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#1d2b1c';
  ctx.fillRect(0, 0, W, H);

  // gather cars to draw
  const cars = [{ key: 'me', x: myX, y: myY, a: myA, vx: me.car.vx, vy: me.car.vy, steer: me.car.steer, color: me.color, name: null, braking: me.car.brk > 0.8, kind: myKind }];
  for (const b of bots) {
    const q = b.prev || b.car;
    cars.push({ key: b.id, x: lerp(q.x, b.car.x, alpha), y: lerp(q.y, b.car.y, alpha), a: lerpAngle(q.a, b.car.a, alpha), vx: b.car.vx, vy: b.car.vy, steer: b.car.steer, color: b.color, name: b.name, kind: otherKind(myKind) });
  }
  for (const r of remotes.values()) {
    const s = remotePose(r, now);
    if (s) cars.push({ key: 'r' + r.id, ...s, color: r.color, name: r.name, kind: r.kind });
  }
  for (const c of cars) skid(c.key, c.x, c.y, c.a, c.vx, c.vy, c.braking);

  ctx.save();
  ctx.translate(W / 2, H * cam.ay); ctx.rotate(cam.rot); ctx.scale(cam.zoom, cam.zoom); ctx.translate(-cam.x, -cam.y);
  if (grassPattern) {
    // grass beyond the pre-rendered area, lined up with it
    const r = Math.hypot(W, H) / cam.zoom;
    ctx.fillStyle = grassPattern; ctx.fillRect(cam.x - r, cam.y - r, r * 2, r * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(cam.x - r, cam.y - r, r * 2, r * 2);
  }
  ctx.drawImage(trackCanvas, OX, OY);

  overshooting = drawDriverLine(myX, myY, dtf);

  for (let i = cars.length - 1; i >= 0; i--) drawCar(cars[i].x, cars[i].y, cars[i].a, cars[i].steer, cars[i].color, cars[i].kind);
  drawGantry();
  ctx.restore();

  // name tags in screen space so they stay readable at any zoom
  ctx.font = `600 12px ${FONT_B}`; ctx.textAlign = 'center';
  for (const c of cars) {
    if (!c.name) continue;
    const s = worldToScreen(c.x, c.y);
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillText(c.name, s.x + 1, s.y - 27);
    ctx.fillStyle = '#f3f1e8'; ctx.fillText(c.name, s.x, s.y - 28);
  }

  drawHud(now, speed, cars);
}

/**
 * Your driving line, around the entire lap.
 * The stretch ahead of the car is a live prediction: where the car will really go
 * if your pedals stay where they are now. Hold W and it bends wider through the
 * next corners; lift or brake and it tightens back. It is coloured green on the
 * road, amber near the edge, red off it, blue on an overtaking line. From the end
 * of that stretch it follows the racing line, in green, the rest of the way round.
 *
 * To keep it calm, the prediction uses the pedal pressure as it actually builds,
 * and the drawn line (shape and colour) eases toward each new prediction.
 * Returns true if the predicted stretch leaves the road (for the TOO FAST warning).
 */
const LINE_RGB = { ok: [74, 222, 128], edge: [255, 200, 61], off: [255, 90, 74], pass: [125, 211, 252] };
const mixRGB = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const LINE_ALPHA = 0.55;
let shown = null;                      // smoothed prediction, relative to the car: [dx, dy, badness, lane]

function drawDriverLine(x0, y0, dtf) {
  const c = me.car, ghost = { ...c };
  const hold = {
    throttle: c.rev ? lastInput.throttle : lastInput.throttle ? c.gas : 0,
    brake: lastInput.brake ? Math.max(c.brk, 0.02) : 0,          // pressure so far, not full brake
    handbrake: lastInput.handbrake,
  };
  const steps = Math.round(150 / SPEED), every = Math.max(1, Math.round(3 / SPEED));
  const fresh = [];
  let worst = 0;
  for (let i = 1; i <= steps; i++) {
    const q = simulateCar(ghost, hold);
    worst = Math.max(worst, q.dist);
    if (i % every === 0) {
      // 0 = comfortably on the road, 1 = at the edge, 2 = well off it
      const bad = clamp((worst - (ROAD_HALF - 18)) / 22, 0, 1) + clamp((worst - (ROAD_HALF + 4)) / 26, 0, 1);
      fresh.push([ghost.x - c.x, ghost.y - c.y, bad, ghost.lane]);
      worst = 0;
    }
  }
  // ease toward the new prediction (~0.25 s time constant), in the car's own frame
  if (!shown || shown.length !== fresh.length) shown = fresh.map((p) => p.slice());
  const k = 1 - Math.exp(-dtf * 4);
  for (let i = 0; i < fresh.length; i++) for (let j = 0; j < 4; j++) shown[i][j] += (fresh[i][j] - shown[i][j]) * k;

  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 6;
  // 1) the predicted stretch, segment by segment in its colour
  let px = x0, py = y0, off = false;
  for (const [dx, dy, bad, lane] of shown) {
    const bx = x0 + dx, by = y0 + dy;
    let rgb = mixRGB(LINE_RGB.ok, LINE_RGB.pass, clamp(lane, 0, 1));
    rgb = bad < 1 ? mixRGB(rgb, LINE_RGB.edge, bad) : mixRGB(LINE_RGB.edge, LINE_RGB.off, bad - 1);
    if (bad > 1.5) off = true;
    ctx.strokeStyle = `rgba(${rgb.map(Math.round).join(',')},${LINE_ALPHA})`;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(bx, by); ctx.stroke();
    px = bx; py = by;
  }
  // 2) then the racing line from where the prediction ends, all the way round to the car
  const n = LINE.n;
  const rest = new Path2D();
  rest.moveTo(px, py);
  let i = (queryTrack(px, py).i + 2) % n;
  const home = queryTrack(c.x, c.y).i;
  for (let guard = 0; guard < n && i !== home; guard++, i = (i + 1) % n) rest.lineTo(LINE.x[i], LINE.y[i]);
  rest.lineTo(x0, y0);
  ctx.strokeStyle = `rgba(${LINE_RGB.ok.join(',')},${LINE_ALPHA})`;
  ctx.stroke(rest);
  return off;
}

function fmt(sec) {
  if (sec == null || !(sec > 0)) return '–:––.–––';
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

function panel(x, y, w, h) {
  ctx.fillStyle = 'rgba(12,16,12,0.62)';
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 6); ctx.fill();
}

function drawHud(now, speed, cars) {
  const pad = 16;
  const info = net.mode === 'online' ? snapInfo(me.info, now) : localInfo(me.race);

  // lap panel (top-left)
  panel(pad, pad, 200, 112);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#a9b2a0'; ctx.font = `600 11px ${FONT_B}`;
  ctx.fillText('LAP', pad + 14, pad + 22);
  ctx.fillStyle = '#f3f1e8'; ctx.font = `800 30px ${FONT_D}`;
  ctx.fillText(String(info.laps + 1), pad + 14, pad + 52);
  ctx.font = `700 22px ${FONT_D}`;
  ctx.fillText(fmt(info.cur), pad + 62, pad + 50);
  ctx.font = `500 15px ${FONT_D}`;
  ctx.fillStyle = '#a9b2a0'; ctx.fillText('LAST', pad + 14, pad + 78); ctx.fillText('BEST', pad + 14, pad + 98);
  ctx.fillStyle = '#f3f1e8'; ctx.fillText(fmt(info.last), pad + 62, pad + 78);
  ctx.fillStyle = '#ffc83d'; ctx.fillText(fmt(info.best), pad + 62, pad + 98);

  // speedo (bottom-centre)
  const kmh = Math.round(speed * 0.36);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f3f1e8'; ctx.font = `800 44px ${FONT_D}`;
  ctx.fillText(String(kmh), W / 2, H - 34);
  ctx.fillStyle = '#a9b2a0'; ctx.font = `600 11px ${FONT_B}`;
  ctx.fillText(me.car.rev ? 'KM/H · R' : 'KM/H', W / 2, H - 16);
  if (overshooting) {
    ctx.font = `800 22px ${FONT_D}`; ctx.fillStyle = '#ff5a4a';
    ctx.fillText('TOO FAST · BRAKE', W / 2, H - 112);
  }
  // rev counter: 12 blocks across the top of the speedo, amber then red near the limiter
  const rpm = me.car.rev ? 0 : clamp(rpmOf(me.car), 0, 1);
  const shifting = me.car.shiftT > 0;
  for (let k = 0; k < 12; k++) {
    const lit = !shifting && rpm * 12 > k + 0.3;
    const col = k >= 10 ? '255,90,74' : k >= 8 ? '255,200,61' : '74,222,128';
    ctx.fillStyle = lit ? `rgb(${col})` : 'rgba(12,16,12,0.62)';
    ctx.fillRect(W / 2 - 54 + k * 9, H - 88, 7, 10);
  }
  // gear
  ctx.font = `800 30px ${FONT_D}`;
  ctx.fillStyle = shifting ? 'rgba(243,241,232,0.35)' : '#ffc83d';
  ctx.fillText(me.car.rev ? 'R' : String((me.car.gear || 0) + 1), W / 2 + 86, H - 34);
  ctx.fillStyle = '#a9b2a0'; ctx.font = `600 11px ${FONT_B}`;
  ctx.fillText('GEAR', W / 2 + 86, H - 16);
  const bar = (x, v, color) => {
    ctx.fillStyle = 'rgba(12,16,12,0.62)'; ctx.fillRect(x, H - 70, 8, 54);
    ctx.fillStyle = color; ctx.fillRect(x, H - 16 - 54 * v, 8, 54 * v);
  };
  bar(W / 2 - 62, me.car.brk, '#ff5a4a');     // brake pedal
  bar(W / 2 + 54, me.car.gas, '#4ade80');     // gas pedal

  // standings (top-right): sorted by best lap
  const rows = [{ name: me.name, color: me.color, info, me: true }];
  for (const b of bots) rows.push({ name: b.name, color: b.color, info: localInfo(b.race) });
  for (const r of remotes.values()) rows.push({ name: r.name, color: r.color, info: snapInfo(r.info, now) });
  rows.sort((a, b) => (a.info.best || 1e9) - (b.info.best || 1e9) || b.info.laps - a.info.laps);
  const rw = 210, rx = W - rw - pad;
  const rh = rows.length > 8 ? 16 : 22, small = rows.length > 8;
  if (W > 520) {
    panel(rx, pad, rw, 30 + rows.length * rh);
    ctx.textAlign = 'left'; ctx.fillStyle = '#a9b2a0'; ctx.font = `600 11px ${FONT_B}`;
    ctx.fillText('BEST LAPS', rx + 12, pad + 20);
    rows.forEach((r, i) => {
      const y = pad + 42 + i * rh;
      ctx.fillStyle = r.color; ctx.fillRect(rx + 12, y - (small ? 8 : 10), 4, small ? 10 : 12);
      ctx.fillStyle = r.me ? '#f3f1e8' : '#d6d9cf'; ctx.font = `${r.me ? 600 : 400} ${small ? 11 : 13}px ${FONT_B}`;
      ctx.fillText(r.name.slice(0, 14), rx + 24, y);
      ctx.textAlign = 'right'; ctx.font = `500 ${small ? 13 : 15}px ${FONT_D}`;
      ctx.fillText(r.info.best ? fmt(r.info.best) : `${r.info.laps} laps`, rx + rw - 12, y);
      ctx.textAlign = 'left';
    });
  }

  // minimap (bottom-right)
  const mm = Math.min(170, W * 0.3);
  const bw = B.maxX - B.minX, bh = B.maxY - B.minY;
  const sc = (mm - 24) / Math.max(bw, bh);
  const mx = W - mm - pad, my = H - mm * (bh / bw) - pad - 4;
  const mh = bh * sc + 24;
  panel(mx, my, mm, mh);
  const toMini = (x, y) => [mx + 12 + (x - B.minX) * sc, my + 12 + (y - B.minY) * sc];
  ctx.beginPath();
  TRACK.pts.forEach((p, i) => { const [x, y] = toMini(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.closePath(); ctx.strokeStyle = '#6b7366'; ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.stroke();
  for (let i = cars.length - 1; i >= 0; i--) {
    const [x, y] = toMini(cars[i].x, cars[i].y);
    ctx.fillStyle = cars[i].color; ctx.beginPath(); ctx.arc(x, y, i === 0 ? 4.5 : 3.5, 0, Math.PI * 2); ctx.fill();
  }

  // status + controls (bottom-left)
  ctx.textAlign = 'left'; ctx.font = `400 12px ${FONT_B}`; ctx.fillStyle = '#a9b2a0';
  const status = net.mode === 'online'
    ? `Online · ${remotes.size + 1} driver${remotes.size ? 's' : ''} · ${net.ping} ms`
    : net.mode === 'offline' ? `Practice · ${bots.length} bot${bots.length === 1 ? '' : 's'}` : 'Connecting…';
  // keep clear of the speedometer in the middle
  if (W > 860) {
    ctx.fillText(status, pad, H - 52);
    ctx.fillText('W: hold to drive, let go to coast · S: brake / reverse', pad, H - 32);
    ctx.fillText(gpad.id ? 'Controller: RT gas · LT brake · B handbrake · Y reset · Menu settings'
      : 'Space: handbrake · R: reset · Touch: right = gas, left = brake', pad, H - 14);
  } else {
    ctx.fillText(status, pad, H - 16);
  }

  // first-run hint
  if (!started) {
    ctx.textAlign = 'center'; ctx.font = `700 26px ${FONT_D}`; ctx.fillStyle = '#ffc83d';
    ctx.fillText('HOLD W TO DRIVE · LET GO TO COAST · S TO BRAKE · THE CAR STEERS AND OVERTAKES ITSELF', W / 2, H * 0.32);
  }

  // toasts
  ctx.textAlign = 'center';
  toasts.forEach((t, i) => {
    const age = (now - t.t) / 1000;
    if (age > 3) return;
    ctx.globalAlpha = clamp(3 - age, 0, 1);
    ctx.font = `800 28px ${FONT_D}`; ctx.fillStyle = t.color;
    ctx.fillText(t.text, W / 2, 56 + i * 34);
    ctx.globalAlpha = 1;
  });
  while (toasts.length && (now - toasts[0].t) > 3000) toasts.shift();
}

// ---------------------------------------------------------------- main loop
let acc = 0, lastT = performance.now();
function frame(t) {
  const dtf = Math.min(0.1, (t - lastT) / 1000);
  lastT = t;
  acc += dtf;
  while (acc >= DT) { fixedStep(); acc -= DT; }
  render(acc / DT, dtf);
  requestAnimationFrame(frame);
}

connect();
requestAnimationFrame(frame);
