// Mouse Racer client: pedal input, prediction, reconciliation, interpolation, rendering.
// Steering is automatic (racing line); players only work gas and brake.
import { DT, CAR, SPEED, TUNE, setSpeed, createCar, stepCar, rpmOf, GEARS, clamp, wrapAngle, lerp, lerpAngle } from './shared/physics.js';
import { TRACK, ROAD_HALF, WALL, pointAt, queryTrack } from './shared/track.js';
import { simulateCar, collideCars, gridSlot, playerSlot, newRace, updateRace, makeBot, botInput, decideLanes, applyTuning, setBotTuning, BOTS } from './shared/world.js';
import { LINE } from './shared/track.js';
import { createSound } from './sound.js';
import { account } from './account.js';
import { MODES, HOLD, newSess, createSession, beginSession, sessionClock, sessionLap, sessionTable } from './shared/session.js';

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
// served by the game server (rather than the single-file build or a local file)?
const servedByGame = !window.MR_OFFLINE && /^https?:$/.test(location.protocol);
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;
// Drawing resolution. Phones have very dense screens (often 3 device pixels per
// CSS pixel); drawing every one of them costs a lot and is hard to see while racing,
// so touch devices draw at 1.5× at most. If frames are still slow, perfMonitor()
// below drops it to 1× (each step is ~2× fewer pixels).
const IS_PHONE = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600;
let dprCap = IS_PHONE ? 1.5 : 2;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, dprCap);
  W = canvas.clientWidth; H = canvas.clientHeight;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- input
// One button, like a slot car: hold to go, let go to slow down. The car steers itself.
// Keyboard: W, up arrow or Space. Touch / mouse: hold anywhere on the track.
// Controller: the right trigger (analog: half pressed = half gas).
const keys = { gas: false };
const KEYMAP = { KeyW: 'gas', ArrowUp: 'gas', Space: 'gas' };
const pointers = new Map();   // pointerId -> 'gas'
canvas.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, 'gas');
  canvas.setPointerCapture?.(e.pointerId);
});
const release = (e) => pointers.delete(e.pointerId);
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
const pointerPedal = (k) => [...pointers.values()].includes(k);
let started = false;   // hides the first-run hint
addEventListener('blur', () => { keys.gas = false; pointers.clear(); });
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && (e.target.type === 'text' || e.code.startsWith('Arrow'))) return;   // typing / slider keys
  const k = KEYMAP[e.code];
  if (k) { keys[k] = true; e.preventDefault(); }
  if (e.code === 'KeyR' && !e.repeat) respawn();
  if (e.code === 'KeyF' && !e.repeat) { fpsMeter.on = !fpsMeter.on; store.set('mr-fps', fpsMeter.on); }
  if (e.code === 'KeyM' && !e.repeat) { setSound(!sound.enabled); toast(sound.enabled ? 'Sound on' : 'Sound off', '#a9b2a0'); }
});
addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) keys[k] = false; });

// Game controller (Xbox layout; any pad the browser reports with the "standard" mapping).
// RT = gas and LT = brake, both analog; A / X are full gas / brake as buttons.
// B or RB = handbrake, Y or View = back to the grid, Menu = show/hide settings.
const gpad = { gas: 0, brake: 0, handbrake: false, id: null, held: {} };
const PAD_DEAD = 0.06;
const trig = (v) => (v < PAD_DEAD ? 0 : Math.min(1, (v - PAD_DEAD) / (0.95 - PAD_DEAD)));
// Some pages block controllers (e.g. inside a frame without the "gamepad" permission):
// then asking throws, so after the first refusal we stop asking and the game simply
// runs without a controller instead of crashing.
let padBlocked = false;
function activePad() {
  if (padBlocked || !navigator.getGamepads) return null;
  let list;
  try { list = [...navigator.getGamepads()].filter((g) => g && g.connected); }
  catch { padBlocked = true; return null; }
  return list.find((g) => g.mapping === 'standard') || list[0] || null;
}
addEventListener('gamepadconnected', (e) => {
  toast(`Controller connected · right trigger = go`, '#7dd3fc');
  started = true;
  if (e.gamepad.mapping !== 'standard') toast('Controller layout not recognised: buttons may differ', '#ffc83d');
});
addEventListener('gamepaddisconnected', () => toast('Controller disconnected', '#ffc83d'));
function pollPad() {
  const gp = activePad();
  gpad.id = gp ? gp.id : null;
  if (!gp) { gpad.gas = 0; return; }
  const b = (i) => gp.buttons[i] || { value: 0, pressed: false };
  gpad.gas = trig(b(7).value);                     // right trigger only
  // one-shot buttons fire on the press, not while held
  const tap = (i) => { const p = b(i).pressed, was = gpad.held[i]; gpad.held[i] = p; return p && !was; };
  if (tap(3) | tap(8)) respawn();
  if (tap(9)) $('set-toggle').click();
  if (gp.buttons.some((x) => x.pressed)) sound.unlock();
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
// Graphics settings (Settings → Graphics), remembered per device:
//   map:   'painted' (the painted circuit) or 'classic' (built from the tile sheet)
//   res:   'auto' (1.5× on phones, 2× elsewhere, drops to 1× if frames are slow), 'high' 2×, 'low' 1×, 'lowest' 0.7×
//   crowd: 'anim' (fans react to passing cars), 'still', or 'off'
const GFX = { map: 'painted', res: 'auto', crowd: 'anim', ...(store.get('mr-gfx') || {}) };
const RES_CAP = { auto: null, high: 2, low: 1, lowest: 0.7 };
let refreshHz = 60;                    // the screen's refresh rate, measured (see perfMonitor)
function applyRes() {
  dprCap = RES_CAP[GFX.res] ?? (IS_PHONE ? 1.5 : 2);
  resize();
}
applyRes();

// Sound (Settings → Sound, M to mute). Browsers only allow audio after the player
// touches, clicks or presses something, so the first such event switches it on.
const sound = createSound();
{
  const sv = store.get('mr-sound');
  if (sv) { sound.setVolume(sv.vol ?? 0.7); sound.setEnabled(sv.on !== false); }
}
function setSound(on, vol) {
  sound.setEnabled(on);
  if (vol != null) sound.setVolume(vol);
  if (on) sound.unlock();
  store.set('mr-sound', { on: sound.enabled, vol: sound.volume });
  if (typeof showSettings === 'function') showSettings();
}
for (const ev of ['pointerdown', 'keydown', 'touchend']) addEventListener(ev, () => sound.unlock(), { capture: true, passive: true });

// Game modes (rules in shared/session.js; see startSession below). Offline the browser
// runs the session (local); online the server runs it and sends its state (net.S).
const local = createSession();
let session = local;

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
  if (document.activeElement !== $('name-input')) $('name-input').value = myName;
  showAccount();
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
  for (const btn of document.querySelectorAll('[data-gfx]')) btn.setAttribute('aria-pressed', String(GFX[btn.dataset.gfx] === btn.dataset.v));
  for (const btn of document.querySelectorAll('[data-mode]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === session.mode));
    btn.disabled = false;
  }
  $('mode-note').textContent = net.mode === 'online' ? 'Starts for everyone in the room' : session.mode === 'race' && session.fromQuali ? 'Race grid set by your qualifying' : 'Starts straight away · R restarts';
  for (const btn of document.querySelectorAll('[data-sound]')) btn.setAttribute('aria-pressed', String((btn.dataset.sound === 'on') === sound.enabled));
  $('vol').value = Math.round(sound.volume * 100); $('vol-out').textContent = Math.round(sound.volume * 100) + '%';
  $('row-vol').classList.toggle('off', !sound.enabled);
  $('gfx-note').textContent = GFX.res === 'auto' ? `Auto: lowers resolution until the game keeps up with your ${refreshHz} Hz screen` : `Drawing at ${+DPR.toFixed(2)}× · watch the FPS counter as you switch`;
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
// name box: saves as you type (once it's a valid name), tidies up when you leave it
$('name-input').addEventListener('input', () => setMyName($('name-input').value));
$('name-input').addEventListener('change', () => { setMyName($('name-input').value); $('name-input').value = myName; });
$('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('name-input').blur(); });

// ---- account (Settings → Account) and the leaderboard
// The game server's web address (for Google sign-in's return page, the leaderboard and
// deleting an account): the page's own server, or the server you've joined / saved.
function serverHttp() {
  if (servedByGame) return location.origin;
  const w = net.url || chosenServer();
  return w ? w.replace(/^ws/, 'http').replace(/\/+$/, '') : null;
}
let deleteArmed = 0;
function showAccount() {
  const row = $('row-account');
  row.hidden = !account.configured;
  if (!account.configured) return;
  const u = account.user, srv = serverHttp();
  $('acct-out').hidden = !!u; $('acct-in').hidden = !u;
  $('acct-google').disabled = !srv;
  $('acct-link').hidden = !(u && u.guest); $('acct-link').disabled = !srv;
  $('acct-board').hidden = !srv;
  if (u) {
    $('acct-name').textContent = myName;
    $('acct-kind').textContent = u.guest ? 'Guest · this device' : (u.email || 'Google');
  }
  $('acct-delete').textContent = deleteArmed > performance.now() ? 'Click again to delete for good' : 'Delete account';
  $('acct-note').textContent = !srv ? 'Google sign-in and the leaderboard need your server: join it first'
    : u ? (u.guest ? 'Add Google to keep this account on other devices' : 'Your name and online results are saved')
      : 'Saves your name and online results';
}
async function sendAuth() {
  if (net.mode !== 'online') return;
  send({ t: 'auth', token: account.configured ? await account.token() : null });
}
account.onChange(() => { showAccount(); });
$('acct-guest').addEventListener('click', async () => {
  $('acct-guest').blur();
  try { await account.signInGuest(); toast('Playing as a guest', '#7dd3fc'); sendAuth(); }
  catch (e) { toast(`Guest sign-in failed: ${e.message}`, '#ffc83d'); }
});
async function google(link) {
  const srv = serverHttp(); if (!srv) return;
  try {
    const u = await account.signInGoogle(`${srv}/auth-callback.html`);
    // a fresh account still called "Driver 123": use your first name from Google
    if (u && u.googleName && /^Driver \d+$/.test(myName)) setMyName(u.googleName.split(' ')[0]);
    toast(link ? 'Google added to your account' : `Signed in${u && u.email ? ' as ' + u.email : ''}`, '#7dd3fc');
    sendAuth();
  } catch (e) { if (!/closed/i.test(e.message)) toast(`Google sign-in failed: ${e.message}`, '#ffc83d'); }
}
$('acct-google').addEventListener('click', () => { $('acct-google').blur(); google(false); });
$('acct-link').addEventListener('click', () => { $('acct-link').blur(); google(true); });
$('acct-signout').addEventListener('click', async () => { $('acct-signout').blur(); await account.signOut(); sendAuth(); toast('Signed out', '#a9b2a0'); });
$('acct-delete').addEventListener('click', async () => {
  // two clicks, so it can't happen by accident
  if (deleteArmed < performance.now()) { deleteArmed = performance.now() + 4000; showAccount(); setTimeout(showAccount, 4100); return; }
  deleteArmed = 0;
  const srv = serverHttp(), token = await account.token();
  if (!srv || !token) { toast('Join your server to delete your account', '#ffc83d'); return; }
  try {
    const r = await fetch(`${srv}/api/account/delete`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    await account.signOut(); sendAuth();
    toast('Account deleted', '#a9b2a0');
  } catch (e) { toast(`Couldn't delete the account: ${e.message}`, '#ffc83d'); }
});
// leaderboard
$('acct-board').addEventListener('click', async () => {
  $('acct-board').blur();
  const srv = serverHttp(); if (!srv) return;
  $('board').hidden = false; $('board-sub').textContent = 'Loading…';
  $('board-wins').innerHTML = ''; $('board-laps').innerHTML = '';
  try {
    const r = await fetch(`${srv}/api/leaderboard`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);
    const esc = (t) => String(t).replace(/[<>&"]/g, '');
    const table = (rows, right) => rows.length
      ? `<tbody>${rows.map((x, i) => `<tr class="${x.name === myName ? 'me' : ''}"><td class="pos">${i + 1}</td><td>${esc(x.name)}</td><td class="num">${right(x)}</td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td>No results yet</td></tr></tbody>';
    $('board-wins').innerHTML = table(d.wins || [], (x) => `${x.wins} win${x.wins === 1 ? '' : 's'} · ${x.races} race${x.races === 1 ? '' : 's'}`);
    $('board-laps').innerHTML = table(d.laps || [], (x) => fmt(x.best_lap_ms / 1000));
    $('board-sub').textContent = 'Online sessions of signed-in players · lap times at standard settings';
  } catch (e) { $('board-sub').textContent = `Leaderboard unavailable (${e.message})`; }
});
$('board-close').addEventListener('click', () => { $('board').hidden = true; });

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
  if (net.mode === 'offline') { startSession(local.mode); toast(`${field} cars`); }
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
for (const btn of document.querySelectorAll('[data-mode]')) {
  btn.addEventListener('click', () => { startSession(btn.dataset.mode, btn.dataset.mode === 'race'); btn.blur(); });
}
for (const btn of document.querySelectorAll('[data-sound]')) {
  btn.addEventListener('click', () => { setSound(btn.dataset.sound === 'on'); btn.blur(); });
}
$('vol').addEventListener('input', () => setSound(true, Number($('vol').value) / 100));
for (const btn of document.querySelectorAll('[data-gfx]')) {
  btn.addEventListener('click', () => {
    const k = btn.dataset.gfx, v = btn.dataset.v;
    if (GFX[k] === v) return;
    GFX[k] = v;
    store.set('mr-gfx', { ...GFX });
    if (k === 'res') { applyRes(); perf.t0 = 0; perf.n = 0; perf.sum = 0; }
    if (k === 'map') {
      if (v === 'painted') ensurePainted().then(() => { if (GFX.map === 'painted') { drawTrackArt(); setupGrass(); } });
      else { dropPainted(); drawTrackArt(); setupGrass(); }
    }
    showSettings();
    btn.blur();
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

// Your name: up to 10 characters (letters, digits, spaces, _ . -), set in Settings and
// saved on this device, so it's there every time you open the game or join a server.
const NAME_MAX = 10;
const cleanName = (v) => String(v || '').replace(/[^\p{L}\p{N} _.-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
let myName = cleanName(params.get('name'));
if (!myName) { try { myName = cleanName(localStorage.getItem('mr-name')); } catch {} }
if (!myName) myName = 'Driver ' + Math.floor(100 + Math.random() * 900);
try { localStorage.setItem('mr-name', myName); } catch {}
function setMyName(v) {
  const n = cleanName(v);
  if (!n || n === myName) return;
  myName = n; me.name = n;
  try { localStorage.setItem('mr-name', n); } catch {}
  if (net.mode === 'online') send({ t: 'name', name: n });
}

const me = {
  id: 'me', name: myName, color: '#e94f37', sess: { laps: [], finishTick: -1 },
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
  ws.onopen = async () => {
    clearTimeout(connectTimer);
    const token = account.configured ? await account.token() : null;
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'hello', name: myName, car: myKind, token }));
  };
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

// ---------------------------------------------------------------- game modes
// Free practice, practice (3 min), qualifying (out lap + 2 timed laps) and race (6 laps,
// start lights). Offline you race the bots; online the server runs the session for the
// whole room and sends the clock and the table, so everyone sees the same thing.
const drivers = () => [me, ...bots];
const myRowId = () => (net.mode === 'online' ? net.myId : 'me');
const isMe = (row) => row.id === myRowId();

function makeBots() {
  bots = BOT_NAMES.slice(0, field - 1).map((name, i) => ({
    id: 'bot' + i, num: i + 1, name, color: BOT_COLORS[i], ai: makeBot(i + 1),
    car: null, race: newRace(), prev: null, sess: newSess(),
  }));
}
// line everyone up: order = driver ids, front to back
function placeGrid(order) {
  order.forEach((id, slot) => {
    const d = id === 'me' ? me : bots.find((b) => b.id === id);
    if (!d) return;
    d.car = id === 'me' ? playerSlot(slot) : gridSlot(slot);
    d.grid = slot;                                   // grid position (the order until the start)
  });
  me.race = newRace(); me.prev = null; me.vis = { x: 0, y: 0, a: 0 }; me.sess = newSess();
  lastSpeed = 0;
}

let resultsShownFor = -1;                          // which session the results were shown for
function startSession(mode, fromQuali = false) {
  if (net.mode === 'online') { send({ t: 'mode', mode, fromQuali }); return; }   // the server starts it for everyone
  session = local;
  makeBots();
  const order = beginSession(local, mode, tick, [...bots.map((b) => b.id), 'me'], fromQuali);   // you start last
  placeGrid(order);
  resultsShownFor = -1;
  hideResults();
  showSettings();
  announceSession(mode, null);
}
function announceSession(mode, by) {
  if (mode === 'free') { if (by) toast(`${by}: free practice`, '#a9b2a0'); return; }
  const what = mode === 'race' ? `Race · ${MODES.race.laps} laps` : mode === 'quali' ? `Qualifying · out lap + ${MODES.quali.laps} timed laps` : `Practice · ${MODES.practice.minutes} minutes`;
  toast(by ? `${by} started: ${what}` : what, '#ffc83d');
}
// lights, GO, time's up: the same sounds and messages offline and online
function sessionEvents(evs) {
  for (const e of evs) {
    if (e === 'light') sound.beep(440, 0.16);
    if (e === 'go') { sound.beep(880, 0.45, 0.3); toast('GO!', '#4ade80'); }
    if (e === 'timeup') toast("Time's up · finish your lap", '#ffc83d');
  }
}
function lapToast(lapsDone, ev) {
  const m = session.mode;
  const n = m === 'race' ? ` ${Math.min(lapsDone, MODES.race.laps)}/${MODES.race.laps}` : m === 'quali' ? (lapsDone === 1 ? ' (out lap)' : ` ${lapsDone - 1}/${MODES.quali.laps}`) : '';
  toast(`Lap${n} ${fmt(ev.time / 60)}${ev.best ? '  best' : ''}`, ev.best ? '#ffc83d' : '#f3f1e8');
  sound.lap(ev.best);
}
// offline: a driver completed a lap
function onLap(d, ev) {
  if (d === me) lapToast(d.race.laps, ev);
  const finished = sessionLap(local, d, ev, tick);
  if (!finished) return;
  if (local.mode === 'race' && drivers().filter((x) => x.sess.finishTick >= 0).length === 1 && d !== me) toast(`${d.name} wins`, '#a9b2a0');
}
// the table for the board and the results (offline: worked out here; online: from the server)
function boardRows() {
  if (net.mode === 'online') return net.rows || [];
  return sessionTable(local, drivers());
}
// seconds left in a practice session
function timeLeft() {
  if (net.mode === 'online') return Math.max(0, ((net.endAt || 0) - performance.now()) / 1000);
  return Math.max(0, (local.endTick - tick) / 60);
}
// show the results once, when you finish
function checkFinished(rows) {
  if (session.mode === 'free' || resultsShownFor === session.t0) return;
  const mine = rows.find(isMe);
  if (mine && mine.fin) { resultsShownFor = session.t0; sound.lap(true); showResults(); }
}

// ---- results table (an overlay; the game keeps running behind it)
let resultsAt = 0;
function hideResults() { $('results').hidden = true; }
function showResults() { renderResults(); $('results').hidden = false; }
function renderResults() {
  resultsAt = performance.now();
  const m = session.mode, rows = boardRows();
  if (!rows.length) return;
  const lead = rows[0], me1 = rows.find(isMe), myPos = me1 ? me1.pos : 0;
  $('res-title').textContent = m === 'race' ? 'Race result' : m === 'quali' ? 'Qualifying' : 'Practice';
  $('res-sub').textContent = m === 'race' ? `You finished P${myPos} of ${rows.length}` : m === 'quali' ? `You qualified P${myPos} of ${rows.length}` : `You were P${myPos} of ${rows.length} on best lap`;
  const head = m === 'race' ? ['', 'Driver', 'Time', 'Best'] : ['', 'Driver', 'Best lap', 'Gap'];
  const cell = (t, cls) => `<td${cls ? ` class="${cls}"` : ''}>${t}</td>`;
  let html = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>`;
  rows.forEach((r, i) => {
    const name = String(r.name).replace(/[<>&"]/g, '');
    let a, b;
    if (m === 'race') {
      if (r.fin && r.time >= 0) a = i === 0 ? fmt(r.time / 60) : `+${((r.time - lead.time) / 60).toFixed(3)}`;
      else { const down = lead.laps - r.laps; a = down >= 1 && lead.fin ? `+${down} lap${down > 1 ? 's' : ''}` : 'Running'; }
      b = r.best ? fmt(r.best / 60) : '–';
    } else {
      a = r.tbest ? fmt(r.tbest / 60) : 'No time';
      b = r.tbest && i > 0 && lead.tbest ? `+${((r.tbest - lead.tbest) / 60).toFixed(3)}` : '';
    }
    html += `<tr class="${isMe(r) ? 'me' : ''}">${cell(r.pos, 'pos')}<td><span class="dot" style="background:${/^#[0-9a-f]{3,8}$/i.test(r.color) ? r.color : '#888'}"></span>${name}</td>${cell(a, 'num')}${cell(b, 'num')}</tr>`;
  });
  $('res-table').innerHTML = html + '</tbody>';
  const btns = m === 'race' ? [['race', 'Race again'], ['quali', 'Qualify'], ['free', 'Free practice']]
    : m === 'quali' ? [['race-grid', 'Race from this grid'], ['quali', 'Qualify again'], ['free', 'Free practice']]
      : [['practice', 'Practice again'], ['quali', 'Qualify'], ['free', 'Free practice']];
  $('res-buttons').innerHTML = btns.map(([k, t], i) => `<button type="button" data-go="${k}" class="${i === 0 ? 'primary' : ''}">${t}</button>`).join('')
    + '<button type="button" data-go="close">Keep driving</button>'
    + (net.mode === 'online' ? '<small class="res-note">Online, these start the session for everyone in the room</small>' : '');
}
$('res-buttons').addEventListener('click', (e) => {
  const k = e.target.closest('button')?.dataset.go; if (!k) return;
  e.target.blur();
  if (k === 'close') hideResults();
  else if (k === 'race-grid') startSession('race', true);
  else startSession(k, k === 'race' && session.fromQuali);
});

// online: the server's session state
function applySession(m) {
  const S = net.S || (net.S = {});
  Object.assign(S, { mode: m.mode, phase: m.phase, lights: m.lights, expired: m.expired, fromQuali: m.fromQuali, t0: m.t0 });
  session = S;
  net.rows = m.rows || [];
  net.endAt = m.endIn >= 0 ? performance.now() + m.endIn * 1000 : 0;
  if (m.start) { resultsShownFor = -1; hideResults(); announceSession(m.mode, m.by); showSettings(); }
  if (m.ev) sessionEvents(m.ev);
  checkFinished(net.rows);
}

function startOffline() {
  if (net.mode === 'offline') return;
  net.mode = 'offline'; net.url = null;
  remotes.clear();
  session = local;
  startSession('free');
}

function onMessage(m) {
  if (m.t === 'welcome') {
    if (net.addr) { store.set('mr-server', net.addr); net.addr = null; }   // rejoin it next time
    hideResults();
    net.mode = 'online'; net.myId = m.id;
    applySession(m.session || { mode: 'free', phase: 'running', lights: 0, rows: [], endIn: -1 }); net.pending = []; net.synced = false; bots = [];
    if (m.speed) setSpeed(m.speed);          // the room's pace and car tuning win
    if (m.tune) applyTuning(m.tune);
    showSettings();
  } else if (m.t === 'account') {
    if (m.ok) {
      // the account's saved name wins (the same name on every device)
      if (m.name && m.name !== myName) { myName = m.name; me.name = m.name; try { localStorage.setItem('mr-name', m.name); } catch {} }
      showSettings();
    } else toast(m.error || 'Sign-in failed', '#ffc83d');
  } else if (m.t === 'session') {
    applySession(m);
  } else if (m.t === 's') {
    onSnapshot(m);
  } else if (m.t === 'lap') {
    const who = m.id === net.myId ? null : remotes.get(m.id)?.name;
    const txt = `${fmt(m.time / 60)}${m.best ? '  best' : ''}`;
    if (!who) lapToast(m.laps ?? 0, { time: m.time, best: m.best });
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
  c.lane = s.lane; c.laneAbs = s.la; c.pass = s.pass; c.passSide = s.ps; c.cap = s.cap; c.yieldTo = s.yt; c.gear = s.gr; c.shiftT = s.sh; c.sliding = s.sl; c.revHold = s.rh; c.rel = s.rl; c.miss = s.mi; c.passY = s.py; c.spin = s.sp; c.uturn = s.ut; c.stuckT = s.sk || 0; c.marshal = s.mk || 0;
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
  if (local.mode !== 'free') { startSession(local.mode, local.fromQuali); toast('Restarted', '#a9b2a0'); return; }
  me.car = playerSlot(myGrid()); me.race = newRace(); me.prev = null; me.sess = newSess();
  lastSpeed = 0;                 // so the jump back to the grid isn't felt as a crash
}

// ---------------------------------------------------------------- simulation
// Camera: fixed north-up at a constant zoom; it only slides to keep your car in view,
// leading a little in the direction you're travelling.
const cam = { x: me.car.x, y: me.car.y, zoom: 1, rot: 0, ay: 0.5 };

function readInput() {
  pollPad();
  // keyboard / touch are on-off; the controller's trigger gives anything in between
  const inp = {
    throttle: keys.gas || pointerPedal('gas') ? 1 : gpad.gas,
    brake: 0, handbrake: false,
  };
  if (inp.throttle) started = true;
  if (session.mode === 'race' && session.phase === 'countdown') return { ...HOLD };   // waiting for the lights
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

let wasSpin = false, lastSpeed = 0, lastMarshal = 0;
function fixedStep() {
  announcePass();
  if ((me.car.marshal || 0) !== lastMarshal) { lastMarshal = me.car.marshal || 0; if (lastMarshal) { toast('Back on track', '#7dd3fc'); lastSpeed = 0; } }
  if (me.car.spin && !wasSpin) { toast('SPUN OUT', '#ff5a4a'); rumble(1, 0.6, 450); }
  // a sudden loss of speed (barrier or a hard bump) gives a short jolt
  const spNow = Math.hypot(me.car.vx, me.car.vy);
  if (lastSpeed - spNow > 40 * SPEED) {
    const hit = Math.min(1, (lastSpeed - spNow) / (150 * SPEED));
    rumble(hit, 0.4, 160);
    sound.impact(hit);
  }
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
  sessionEvents(sessionClock(local, tick));
  const held = local.phase === 'countdown';            // on the grid, waiting for the lights
  decideLanes([{ id: 0, car: me.car }, ...bots.map((b) => ({ id: b.num, car: b.car }))]);
  const q = simulateCar(me.car, held ? HOLD : inp);
  const ev = updateRace(me.race, q.s, tick);
  if (ev) onLap(me, ev);
  const allCars = [me.car, ...bots.map((b) => b.car)];
  for (const b of bots) {
    b.prev = { x: b.car.x, y: b.car.y, a: b.car.a };
    const qb = simulateCar(b.car, held ? HOLD : botInput(b.ai, b.car, allCars));
    const evb = updateRace(b.race, qb.s, tick);
    if (evb) onLap(b, evb);
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
// The map is painted once into trackCanvas, then cut into small tiles for play (see
// sliceTiles): each frame draws only the tiles on screen, and a skid mark only changes
// the one small tile it lands on. With one huge image, browsers that draw with the
// graphics card can end up copying the whole ~37 MB map every frame a skid mark changed it.
const MAP_W = Math.ceil(B.maxX - B.minX + MARGIN * 2), MAP_H = Math.ceil(B.maxY - B.minY + MARGIN * 2);
// A fresh full-size canvas is made for each build and released straight after slicing,
// so nothing a previous build did to a canvas can carry over (see drawTrackArt).
let trackCanvas = null, tctx = null;
const TILE = 1024, TILE_PAD = 1;                // 1 px of overlap so no seams show between tiles
const TCOLS = Math.ceil(MAP_W / TILE), TROWS = Math.ceil(MAP_H / TILE);
let tiles = [];                                  // tiles[row][col] = { cv, g }
function sliceTiles() {
  // release the previous map's tiles right away: some phone browsers keep a canvas's
  // memory until it's garbage-collected, and switching maps would pile it up
  for (const row of tiles) for (const t of row) { t.cv.width = 0; t.cv.height = 0; }
  tiles = [];
  for (let j = 0; j < TROWS; j++) {
    const row = [];
    for (let i = 0; i < TCOLS; i++) {
      const cv = document.createElement('canvas');
      cv.width = TILE + 2 * TILE_PAD; cv.height = TILE + 2 * TILE_PAD;
      const g = cv.getContext('2d');
      g.drawImage(trackCanvas, -(i * TILE - TILE_PAD), -(j * TILE - TILE_PAD));
      row.push({ cv, g });
    }
    tiles.push(row);
  }
  trackCanvas.width = 0; trackCanvas.height = 0;   // the full-size copy isn't needed while playing
  trackCanvas = null; tctx = null;
}

// Artwork cut from the track tile sheet (public/track/*.png): ground textures, kerbs,
// armco, tyre stacks, signs, gantry, pit lane and buildings. The layout itself is
// still the spline in track.js, so handling, bots and the racing line are unchanged.
const ART = {};
const ART_NAMES = ['painted', 'grass_painted', 'grass', 'sand', 'asphalt', 'armco', 'gantry', 'pitlane', 'garage', 'office', 'tent',
  'chev_y1', 'chev_y2', 'cone', 'pole1', 'pole2', 'pole3',
  ...Array.from({ length: 8 }, (_, i) => `tyre${i}`), ...'ABCDEFGH'.split('').map((k) => 'stand' + k)];
const artReady = Promise.all(ART_NAMES.map((n) => new Promise((res) => {
  const img = new Image();
  img.onload = () => { ART[n] = img; res(); };
  img.onerror = () => res();               // missing art just falls back to plain colours
  img.src = asset(`track/${n}.${n === 'painted' ? 'jpg' : 'png'}`);
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

// ---------------------------------------------------------------- grandstands and fans
// Stands cut from the supplied sheet. For each: image size and its benches (rows of
// [top y, bottom y, [[x0, x1], ...]] in image pixels), found from the artwork.
const STAND_DATA = {"standA":[711,315,[[31,51,[[22,289],[368,684]]],[72,92,[[21,289],[368,684]]],[114,133,[[22,289],[368,684]]],[155,174,[[21,289],[368,684]]],[196,214,[[22,289],[368,684]]],[236,255,[[21,289],[368,684]]]]],"standB":[605,302,[[47,66,[[23,265],[346,580]]],[89,108,[[36,265],[346,581]]],[131,149,[[23,264],[346,579]]],[172,192,[[22,264],[346,582]]],[214,233,[[22,264],[346,582]]]]],"standC":[435,267,[[43,59,[[108,392]]],[79,95,[[102,410]]],[116,132,[[94,411]]],[153,169,[[88,411]]],[190,207,[[80,412]]]]],"standD":[474,242,[[61,76,[[31,201],[274,440]]],[98,114,[[28,200],[278,437]]],[134,150,[[26,200],[275,445]]],[176,190,[[22,200],[275,448]]]]],"standE":[397,242,[[37,50,[[33,313]]],[69,82,[[17,314]]],[101,115,[[17,314]]],[134,149,[[16,311]]],[168,182,[[15,316]]]]],"standF":[399,150,[[6,20,[[6,390]]],[41,55,[[6,391]]],[77,90,[[5,391]]]]],"standG":[322,36,[[3,18,[[6,317]]]]],"standH":[410,277,[[58,74,[[19,268],[341,391]]],[94,109,[[19,265],[342,392]]],[130,145,[[18,268],[342,392]]],[166,182,[[17,268],[342,393]]],[202,218,[[17,268],[342,393]]]]]};
const STAND_SCALE = 0.55;                      // world units per stand-image pixel
const PIT_S = 380, PIT_SIDE = -1;              // pit lane and garages (see drawTrackArt)

// Distance-to-track lookup on a coarse grid, so placing stands doesn't need tens of
// thousands of full track searches.
const DGRID = 20;
let distGrid = null;
function trackDist(x, y) {
  if (!distGrid) {
    const gw = Math.ceil(MAP_W / DGRID) + 1, gh = Math.ceil(MAP_H / DGRID) + 1;
    distGrid = { gw, gh, d: new Float32Array(gw * gh) };
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) distGrid.d[j * gw + i] = queryTrack(OX + i * DGRID, OY + j * DGRID).dist;
  }
  const i = Math.round((x - OX) / DGRID), j = Math.round((y - OY) / DGRID);
  if (i < 0 || j < 0 || i >= distGrid.gw || j >= distGrid.gh) return 1e9;
  return distGrid.d[j * distGrid.gw + i];
}

// Rotated rectangles: {x, y, a, hw, hh}
const inRect = (r, x, y) => {
  const dx = x - r.x, dy = y - r.y, c = Math.cos(r.a), s = Math.sin(r.a);
  return Math.abs(dx * c + dy * s) <= r.hw && Math.abs(-dx * s + dy * c) <= r.hh;
};
const rectPoints = (r, step) => {
  const pts = [], c = Math.cos(r.a), s = Math.sin(r.a);
  for (let u = -r.hw; u <= r.hw + 0.1; u += Math.min(step, r.hw)) for (let v = -r.hh; v <= r.hh + 0.1; v += Math.min(step, r.hh))
    pts.push([r.x + u * c - v * s, r.y + u * s + v * c]);
  return pts;
};
const rectsOverlap = (a, b) => rectPoints(a, 20).some(([x, y]) => inRect(b, x, y)) || rectPoints(b, 20).some(([x, y]) => inRect(a, x, y));

// Place the stands beside the track: front edge facing the track just behind the
// barrier, clear of the road, the pits and each other. Each stand goes where it is
// furthest from the stands already placed, with a bonus near the start/finish line and
// on the outside of the tight bends (where the action is). Same result every time.
function placeStands() {
  const order = ['standA', 'standB', 'standH', 'standC', 'standE', 'standD', 'standF', 'standF', 'standG', 'standG'];
  const pq = pointAt(PIT_S - 60);
  const taken = [{ x: pq.x + pq.nx * PIT_SIDE * (WALL + 175), y: pq.y + pq.ny * PIT_SIDE * (WALL + 175), a: pq.a, hw: 390, hh: 170 }];
  const hot = bends(420);
  const placed = [];
  const L = TRACK.length;
  for (const name of order) {
    const [iw, ih] = STAND_DATA[name];
    const hw = iw * STAND_SCALE / 2, hh = ih * STAND_SCALE / 2;
    let best = null;
    for (let s = 0; s < L; s += 50) {
      const p = pointAt(s);
      for (const side of [-1, 1]) for (const front of [WALL + 44, WALL + 70, WALL + 110]) {
        const x = p.x + p.nx * side * (front + hh), y = p.y + p.ny * side * (front + hh);
        const a = Math.atan2(side * p.nx, -side * p.ny);           // image bottom (the front) faces the track
        const r = { x, y, a, hw, hh };
        const pts = rectPoints(r, 22);
        if (pts.some(([px, py]) => trackDist(px, py) < WALL + 18 || px < OX + 20 || py < OY + 20 || px > OX + MAP_W - 20 || py > OY + MAP_H - 20)) continue;
        if (taken.some((t) => rectsOverlap(r, t))) continue;
        let score = Math.min(1400, ...placed.map((q) => Math.hypot(q.x - x, q.y - y)), 1400) - (front - WALL) * 2;
        const ds = Math.min(s, L - s);
        if (ds < 500) score += 450;
        if (hot.some((b) => b.side === side && s > b.s0 - 150 && s < b.s1 + 200)) score += 250;
        if (!best || score > best.score) best = { score, name, s, side, front, ...r };
      }
    }
    if (best) { placed.push(best); taken.push(best); }
  }
  return placed;
}

// The crowd. Every fan is drawn once, at load, into a few images per stand: two calm
// poses and one cheering pose. Each frame the game just copies one of those images for
// the (at most two or three) stands on screen, so a thousand fans cost about as much
// as drawing three pictures. Stands near a passing car switch to the cheering frames.
const SHIRTS = ['#e94f37', '#3b82f6', '#22c55e', '#f5b700', '#a855f7', '#ec4899', '#f3f1e8', '#1f2937', '#14b8a6', '#f97316', '#64748b', '#dc2626'];
const SKINS = ['#f1c7a5', '#e0ac85', '#c68863', '#a0694a', '#7a4c33', '#5a3825'];
const HAIR = ['#1b1410', '#3b2a1e', '#6b4a2b', '#c9a35b', '#8a8a8a', '#b5462f'];
// Crowd images are stored at about the detail the screen shows: a phone draws the
// stands at under one pixel per world unit, so storing more just costs time to shrink.
const CROWD_RES = IS_PHONE ? 0.9 : 1.6;          // image pixels per world unit
function buildCrowd(st, seed) {
  const [iw, ih, rows] = STAND_DATA[st.name];
  let r = seed >>> 0;
  const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const fans = [];
  for (const [y0, , segs] of rows) for (const [x0, x1] of segs) {
    for (let x = x0 + 7; x < x1 - 5; x += 10 + rnd() * 3) {
      if (rnd() < 0.18) continue;                            // empty seat
      fans.push({
        x: x + (rnd() - 0.5) * 2, y: y0 + 5, shirt: pick(SHIRTS), skin: pick(SKINS), hair: pick(HAIR),
        cap: rnd() < 0.25 ? pick(SHIRTS) : null, flag: rnd() < 0.12 ? pick(SHIRTS) : null,
        fidget: rnd(), keen: rnd(),
      });
    }
  }
  const top = Math.max(0, Math.min(...rows.map((q) => q[0])) - 40);
  const bottom = Math.max(...rows.map((q) => q[1]));
  const frame = (mode) => {
    const k = CROWD_RES * STAND_SCALE;             // canvas pixels per stand-image pixel
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(iw * k); cv.height = Math.ceil((bottom - top + 2) * k);
    const g = cv.getContext('2d');
    g.scale(k, k); g.translate(0, -top);
    g.lineCap = 'round';
    for (const f of fans) {
      // calm: everyone seated, a few shifting; alt: others shifting; cheer: most up, arms raised
      const up = mode === 'cheer' ? f.keen < 0.75 : mode === 'alt' ? f.fidget > 0.9 : f.fidget < 0.06;
      const arms = mode === 'cheer' && f.keen < 0.6;
      const lean = mode === 'alt' ? (f.fidget - 0.5) * 2.4 : 0;
      const lift = up ? 5 : 0, by = f.y - lift, x = f.x + lean;
      if (arms) {
        g.strokeStyle = f.shirt; g.lineWidth = 2.6;
        const spread = f.keen < 0.3 ? 6 : 4;
        g.beginPath(); g.moveTo(x - 3.5, by - 10); g.lineTo(x - spread, by - 22); g.moveTo(x + 3.5, by - 10); g.lineTo(x + spread, by - 22); g.stroke();
        g.fillStyle = f.skin;
        g.beginPath(); g.arc(x - spread, by - 23, 1.7, 0, 7); g.arc(x + spread, by - 23, 1.7, 0, 7); g.fill();
        if (f.flag) {
          g.strokeStyle = '#d9d4c3'; g.lineWidth = 1;
          g.beginPath(); g.moveTo(x + spread, by - 23); g.lineTo(x + spread, by - 34); g.stroke();
          g.fillStyle = f.flag; g.fillRect(x + spread, by - 34, 9, 6);
        }
      }
      g.fillStyle = f.shirt;
      g.beginPath(); g.roundRect(x - 5, by - 13, 10, 13 + lift * 0.4, 3); g.fill();
      g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x - 5, by - 3, 10, 3);
      const hx = x, hy = by - 17;
      g.fillStyle = f.skin; g.beginPath(); g.arc(hx, hy, 4.2, 0, 7); g.fill();
      g.fillStyle = f.cap || f.hair;
      g.beginPath(); g.arc(hx, hy - 0.6, 4.3, Math.PI * 1.05, Math.PI * 1.95); g.fill();
      if (f.cap) g.fillRect(hx - 1, hy - 3.4, 6.5, 1.8);
    }
    return cv;
  };
  return { calm: frame('calm'), alt: frame('alt'), cheer: frame('cheer'), top, iw, ih, fans: fans.length };
}

let STANDS = [];
function setupStands() {
  STANDS = placeStands().map((st, i) => {
    const front = { x: st.x - Math.sin(st.a) * st.hh, y: st.y + Math.cos(st.a) * st.hh };   // middle of the front edge
    return { ...st, front, crowd: buildCrowd(st, 1234 + i * 977), excite: 0, phase: i * 0.37 };
  });
}

// Per frame: copy one crowd image for each stand on screen.
function drawCrowds(cars, now, dtf) {
  if (GFX.crowd === 'off') return;
  const vx0 = cam.x - (W / 2) / cam.zoom, vy0 = cam.y - (H * cam.ay) / cam.zoom, vw = W / cam.zoom, vh = H / cam.zoom;
  for (const st of STANDS) {
    // excitement: a car close to the front of the stand gets everyone up; it fades after
    let near = 1e9;
    for (const c of cars) near = Math.min(near, Math.hypot(c.x - st.front.x, c.y - st.front.y));
    st.excite = near < 320 ? 1 : Math.max(0, st.excite - dtf / 1.6);
    const R = Math.hypot(st.hw, st.hh);
    if (st.x + R < vx0 || st.y + R < vy0 || st.x - R > vx0 + vw || st.y - R > vy0 + vh) continue;
    const t = now / 1000 + st.phase;
    const img = GFX.crowd === 'still' ? st.crowd.calm : st.excite > 0.05
      ? (Math.floor(t * 6) % 2 ? st.crowd.cheer : st.crowd.alt)        // bouncing
      : (Math.floor(t * 1.4) % 3 === 0 ? st.crowd.alt : st.crowd.calm);  // milling about
    ctx.save();
    ctx.translate(st.x, st.y); ctx.rotate(st.a); ctx.scale(STAND_SCALE, STAND_SCALE);
    ctx.drawImage(img, -st.crowd.iw / 2, -st.crowd.ih / 2 + st.crowd.top, st.crowd.iw, img.height / (CROWD_RES * STAND_SCALE));
    ctx.restore();
  }
}

// The circuit artwork. track/painted.jpg is a painted version of the whole map (warped
// so its road sits exactly on the road the cars drive, painted stands removed); it
// covers the whole pre-drawn area. The game's own stands go on top, with their fans.
// Without it (missing file) the map is built from the tile-sheet pieces as before.
const PAINTED_SCALE = () => MAP_W / ART.painted.width;   // game units per painted pixel
function drawStandArt(c, X, Y) {
  // grandstands (their fans are drawn separately, see drawCrowds), with a baked-in shadow
  for (const st of STANDS) {
    const img = ART[st.name]; if (!img) continue;
    c.save(); c.translate(X(st.x), Y(st.y)); c.rotate(st.a); c.scale(STAND_SCALE, STAND_SCALE);
    c.shadowColor = 'rgba(0,0,0,0.4)'; c.shadowBlur = 10;
    c.shadowOffsetX = 6; c.shadowOffsetY = 8;
    c.drawImage(img, -img.width / 2, -img.height / 2);
    c.restore();
  }
}

function drawTrackArt() {
  trackCanvas = document.createElement('canvas');
  trackCanvas.width = MAP_W; trackCanvas.height = MAP_H;
  tctx = trackCanvas.getContext('2d');
  paintTrackArt();
  sliceTiles();
}
// The painting, fully decoded into an ImageBitmap before it's used, and released again
// when you switch to the classic map (so painted mode leaves nothing behind).
let paintedBitmap = null;
async function ensurePainted() {
  if (paintedBitmap || !ART.painted) return;
  try { paintedBitmap = await createImageBitmap(ART.painted); } catch { paintedBitmap = null; }
}
function dropPainted() { if (paintedBitmap) { paintedBitmap.close?.(); paintedBitmap = null; } }
function paintTrackArt() {
  paintClassicArt();
  if (ART.painted && GFX.map === 'painted') {
    // The painting goes over the tile-sheet map rather than onto a blank canvas. The
    // result looks the same, but Chrome decides how to keep a canvas from how it was
    // drawn: with only one big image drawn into it, it kept the map in a slow mode and
    // the game froze for 1-2 s every few seconds (14 FPS on average). Drawing the full
    // map first keeps it on the graphics card. (Also no 'high' smoothing: that alone
    // made it slower still.)
    const c = tctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(paintedBitmap || ART.painted, 0, 0, MAP_W, MAP_H);
    drawStandArt(c, (x) => x - OX, (y) => y - OY);
  }
}
function paintClassicArt() {
  const c = tctx, Wc = MAP_W, Hc = MAP_H;
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
  const pside = PIT_SIDE;
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

  drawStandArt(c, X, Y);
  const inStand = (x, y, r = 0) => STANDS.some((st) => inRect({ ...st, hw: st.hw + r, hh: st.hh + r }, x, y));

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
      if (clearOf(x, y, 10) && !inStand(x, y, 20)) put(k % 2 ? 'chev_y1' : 'chev_y2', x, y, p.a + (b.side > 0 ? 0 : Math.PI), 0.8);
    }
  }

  // floodlight poles and a few cones around the outside
  for (let s2 = 150, k = 0; s2 < TRACK.length; s2 += 520, k++) {
    const p = pointAt(s2);
    for (const side of [-1, 1]) {
      const o = WALL + 55, x = p.x + p.nx * side * o, y = p.y + p.ny * side * o;
      if (clearOf(x, y, 30) && !inStand(x, y, 30) && (k + side) % 2 === 0) put(`pole${1 + (k % 3)}`, x, y, 0, 0.8);
    }
  }
  for (const b of tight) {
    const p = pointAt(b.s1 + 200);
    for (let k = 0; k < 3; k++) {
      const x = p.x + p.nx * -b.side * (WALL + 30 + k * 18), y = p.y + p.ny * -b.side * (WALL + 30 + k * 18);
      if (clearOf(x, y, 10) && !inStand(x, y, 10)) put('cone', x, y, 0, 0.5);
    }
  }
}
setupStands();
drawTrackArt();
// Redraw once the sheet artwork has loaded (skid marks so far are lost; it's at load time).
function setupGrass() {
  if (ART.painted && ART.grass_painted && GFX.map === 'painted') {
    // grass beyond the painted map, taken from the painting so the edge doesn't show
    // (made from a canvas copy, like the classic grass, not straight from the image)
    const g = document.createElement('canvas');
    g.width = ART.grass_painted.width; g.height = ART.grass_painted.height;
    g.getContext('2d').drawImage(ART.grass_painted, 0, 0);
    grassPattern = ctx.createPattern(g, 'repeat');
    grassPattern.setTransform(new DOMMatrix().translate(OX, OY).scale(PAINTED_SCALE()));
  } else if (ART.grass) {
    // the tint is baked into the tile, so the grass outside the map is one fill, not two
    const g = document.createElement('canvas');
    g.width = ART.grass.width; g.height = ART.grass.height;
    const gc = g.getContext('2d');
    gc.drawImage(ART.grass, 0, 0);
    gc.fillStyle = 'rgba(0,0,0,0.12)'; gc.fillRect(0, 0, g.width, g.height);
    grassPattern = ctx.createPattern(g, 'repeat');
    grassPattern.setTransform(new DOMMatrix().translate(OX, OY).scale(2));
  }
}
artReady.then(async () => {
  if (GFX.map === 'painted') await ensurePainted();
  drawTrackArt();
  setupGrass();
  buildGantry();
});

// Start gantry with its lights, drawn above the cars (they pass under it).
// It's drawn once, with its shadow, into its own image (blurred shadows are slow to
// draw every frame), then that image is copied above the cars each frame.
let gantryArt = null;
const GANTRY_RES = 2;                    // image pixels per world unit
function buildGantry() {
  const img = ART.gantry; if (!img) return;
  const p = pointAt(-6);
  const span = WALL * 2 + 30, sc = span / img.width, h = img.height * sc;
  // the gantry's corners in world space, to size the image
  const rot = p.a + Math.PI / 2, cs = Math.cos(rot), sn = Math.sin(rot);
  const pts = [[-span / 2, -h * 0.75], [span / 2, -h * 0.75], [span / 2, h * 0.25], [-span / 2, h * 0.25]]
    .map(([u, v]) => [p.x + u * cs - v * sn, p.y + u * sn + v * cs]);
  const PAD = 24;
  const x0 = Math.min(...pts.map((q) => q[0])) - PAD, y0 = Math.min(...pts.map((q) => q[1])) - PAD;
  const x1 = Math.max(...pts.map((q) => q[0])) + PAD, y1 = Math.max(...pts.map((q) => q[1])) + PAD;
  const cv = document.createElement('canvas');
  cv.width = Math.ceil((x1 - x0) * GANTRY_RES); cv.height = Math.ceil((y1 - y0) * GANTRY_RES);
  const g = cv.getContext('2d');
  g.scale(GANTRY_RES, GANTRY_RES); g.translate(-x0, -y0);
  g.translate(p.x, p.y); g.rotate(rot);
  // shadow offsets ignore the rotation, so the light comes from the same side as the cars'
  g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 6 * GANTRY_RES; g.shadowOffsetX = 8 * GANTRY_RES; g.shadowOffsetY = 10 * GANTRY_RES;
  g.drawImage(img, -span / 2, -h * 0.75, span, h);
  gantryArt = { cv, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function drawGantry() {
  if (gantryArt) ctx.drawImage(gantryArt.cv, gantryArt.x, gantryArt.y, gantryArt.w, gantryArt.h);
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
    const style = `rgba(15,15,15,${clamp(lat / (600 * SPEED), 0.12, 0.3)})`;
    for (let k = 0; k < 2; k++) {
      // paint the mark into whichever map tile(s) it touches (usually just one)
      const ax = prev[k][0] - OX, ay = prev[k][1] - OY, bx = wheels[k][0] - OX, by = wheels[k][1] - OY;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - 4 - TILE_PAD) / TILE)), i1 = Math.min(TCOLS - 1, Math.floor((Math.max(ax, bx) + 4 + TILE_PAD) / TILE));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by) - 4 - TILE_PAD) / TILE)), j1 = Math.min(TROWS - 1, Math.floor((Math.max(ay, by) + 4 + TILE_PAD) / TILE));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const t = tiles[j] && tiles[j][i]; if (!t) continue;
        const ox = i * TILE - TILE_PAD, oy = j * TILE - TILE_PAD, g = t.g;
        g.strokeStyle = style; g.lineWidth = 5; g.lineCap = 'round';
        g.beginPath(); g.moveTo(ax - ox, ay - oy); g.lineTo(bx - ox, by - oy); g.stroke();
      }
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

// Each car is a sprite with a soft drop shadow and a glow in its driver's colour.
// Blurring those every frame (2 blurs per car, 40 with 20 cars) was the most expensive
// thing on screen, so they're drawn once per car kind / colour into small images and
// just copied each frame. The shadow is its own image so it can stay on the same side
// (light from the top left) whichever way the car points.
const CAR_RES = 2.5;                     // image pixels per world unit (sharp up to ~2.5× zoom·resolution)
const GLOW = 12, SHADOW_BLUR = 3, SHADOW_DX = 3, SHADOW_DY = 4, CAR_PAD = 26;
const carArt = new Map();
function spriteArt(kind, color) {
  const key = kind + color;
  let art = carArt.get(key);
  if (art) return art;
  const img = SPRITES[kind];
  const len = SPRITE_LEN, wid = len * img.naturalWidth / img.naturalHeight;
  const make = (draw) => {
    const cv = document.createElement('canvas');
    cv.width = Math.ceil((wid + CAR_PAD * 2) * CAR_RES); cv.height = Math.ceil((len + CAR_PAD * 2) * CAR_RES);
    const g = cv.getContext('2d');
    g.scale(CAR_RES, CAR_RES); g.translate(wid / 2 + CAR_PAD, len / 2 + CAR_PAD);
    draw(g);
    return cv;
  };
  // glow + car
  const body = make((g) => {
    g.shadowColor = color; g.shadowBlur = GLOW * CAR_RES;
    g.drawImage(img, -wid / 2, -len / 2, wid, len);
  });
  // shadow only: draw the car far off the image and let its shadow fall back onto it
  let shadow = carArt.get('shadow' + kind);
  if (!shadow) {
    shadow = make((g) => {
      g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = SHADOW_BLUR * CAR_RES;
      g.shadowOffsetX = 10000 * CAR_RES;
      g.drawImage(img, -wid / 2 - 10000, -len / 2, wid, len);
    });
    carArt.set('shadow' + kind, shadow);
  }
  art = { body, shadow, w: wid + CAR_PAD * 2, h: len + CAR_PAD * 2 };
  carArt.set(key, art);
  return art;
}

function drawCar(x, y, a, steer, color, kind) {
  const img = SPRITES[kind];
  if (img && img.complete && img.naturalWidth) {
    const art = spriteArt(kind, color), rot = a + Math.PI / 2;   // sprite nose points up (-y)
    ctx.save();
    ctx.translate(x + SHADOW_DX, y + SHADOW_DY); ctx.rotate(rot);
    ctx.drawImage(art.shadow, -art.w / 2, -art.h / 2, art.w, art.h);
    ctx.rotate(-rot); ctx.translate(-SHADOW_DX, -SHADOW_DY); ctx.rotate(rot);
    ctx.drawImage(art.body, -art.w / 2, -art.h / 2, art.w, art.h);
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
  {
    // grass beyond the pre-rendered map, lined up with it; only needed near its edges
    const vx = cam.x - (W / 2) / cam.zoom, vy = cam.y - (H * cam.ay) / cam.zoom, vw = W / cam.zoom, vh = H / cam.zoom;
    const inside = vx >= OX && vy >= OY && vx + vw <= OX + MAP_W && vy + vh <= OY + MAP_H;
    if (!inside) {
      ctx.fillStyle = grassPattern || '#33511f'; ctx.fillRect(vx - 2, vy - 2, vw + 4, vh + 4);
    }
  }
  {
    // only the map tiles on screen
    const vx = cam.x - (W / 2) / cam.zoom, vy = cam.y - (H * cam.ay) / cam.zoom, vw = W / cam.zoom, vh = H / cam.zoom;
    const i0 = Math.max(0, Math.floor((vx - OX) / TILE)), i1 = Math.min(TCOLS - 1, Math.floor((vx + vw - OX) / TILE));
    const j0 = Math.max(0, Math.floor((vy - OY) / TILE)), j1 = Math.min(TROWS - 1, Math.floor((vy + vh - OY) / TILE));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const t = tiles[j] && tiles[j][i];
      if (t) ctx.drawImage(t.cv, OX + i * TILE - TILE_PAD, OY + j * TILE - TILE_PAD);
    }
  }
  drawCrowds(cars, now, dtf);
  updateSound(cars, myX, myY);

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

let predFrame = 0, lastFresh = null;
function drawDriverLine(x0, y0, dtf) {
  const c = me.car, ghost = { ...c };
  // The prediction re-runs ~150 physics steps; doing it every other frame halves that
  // cost, and the drawn line eases between predictions anyway.
  const recompute = !lastFresh || ++predFrame % 2 === 0;
  const hold = {
    throttle: c.rev ? lastInput.throttle : lastInput.throttle ? c.gas : 0,
    brake: lastInput.brake ? Math.max(c.brk, 0.02) : 0,          // pressure so far, not full brake
    handbrake: lastInput.handbrake,
  };
  const steps = recompute ? Math.round(150 / SPEED) : 0, every = Math.max(1, Math.round(3 / SPEED));
  const fresh = recompute ? [] : lastFresh;
  let worst = 0;
  for (let i = 1; i <= steps; i++) {
    const q = simulateCar(ghost, hold);
    worst = Math.max(worst, q.dist);
    if (i % every === 0) {
      // 0 = comfortably on the road, 1 = at the edge, 2 = well off it
      const bad = clamp((worst - (ROAD_HALF - 18)) / 22, 0, 1) + clamp((worst - (ROAD_HALF + 4)) / 26, 0, 1);
      // blue only while you're the one overtaking (pass = the car you're passing); when
      // another car passes you, your car eases aside too, but that's not your overtake
      fresh.push([ghost.x - c.x, ghost.y - c.y, bad, ghost.pass >= 0 ? ghost.lane : 0]);
      worst = 0;
    }
  }
  lastFresh = fresh;
  // ease toward the new prediction (~0.25 s time constant), in the car's own frame
  if (!shown || shown.length !== fresh.length) shown = fresh.map((p) => p.slice());
  const k = 1 - Math.exp(-dtf * 4);
  for (let i = 0; i < fresh.length; i++) for (let j = 0; j < 4; j++) shown[i][j] += (fresh[i][j] - shown[i][j]) * k;

  // flat ends where the pieces meet: the line is see-through, and overlapping round ends
  // showed as darker dots at every colour change and where the two parts join
  ctx.lineCap = 'butt'; ctx.lineJoin = 'round'; ctx.lineWidth = 6;
  // 1) the predicted stretch in its colours. Neighbouring segments of (nearly) the same
  // colour are drawn as one stroke: far fewer strokes, the same look.
  let px = x0, py = y0, off = false, style = null;
  for (const [dx, dy, bad, lane] of shown) {
    const bx = x0 + dx, by = y0 + dy;
    let rgb = mixRGB(LINE_RGB.ok, LINE_RGB.pass, clamp(lane, 0, 1));
    rgb = bad < 1 ? mixRGB(rgb, LINE_RGB.edge, bad) : mixRGB(LINE_RGB.edge, LINE_RGB.off, bad - 1);
    if (bad > 1.5) off = true;
    const st = `rgba(${rgb.map((v) => Math.round(v / 6) * 6).join(',')},${LINE_ALPHA})`;
    if (st !== style) {
      if (style) ctx.stroke();
      ctx.strokeStyle = style = st;
      ctx.beginPath(); ctx.moveTo(px, py);
    }
    ctx.lineTo(bx, by);
    px = bx; py = by;
  }
  if (style) ctx.stroke();
  // 2) then the racing line from where the prediction ends, all the way round to the car
  const n = LINE.n;
  // Only the part on screen is drawn: outlining the whole lap every frame was the single
  // most expensive thing in a frame on a phone.
  const M = 80, vx0 = cam.x - (W / 2) / cam.zoom - M, vy0 = cam.y - (H * cam.ay) / cam.zoom - M;
  const vx1 = vx0 + W / cam.zoom + 2 * M, vy1 = vy0 + H / cam.zoom + 2 * M;
  const inView = (x, y) => x > vx0 && x < vx1 && y > vy0 && y < vy1;
  const rest = new Path2D();
  let lx = px, ly = py, pen = false;
  const home = queryTrack(c.x, c.y, c.qi ?? -1).i;
  const seg = (x, y) => {
    if (inView(lx, ly) || inView(x, y)) { if (!pen) rest.moveTo(lx, ly); rest.lineTo(x, y); pen = true; } else pen = false;
    lx = x; ly = y;
  };
  // Join the prediction to the racing line with a smooth curve instead of a straight hop:
  // it leaves the end of the prediction in the direction the car is travelling there and
  // meets the racing line further on, running along it. The further the prediction ends
  // from the line (braking hard, running wide), the longer and gentler the merge.
  const i0 = queryTrack(px, py).i;
  const offLine = Math.hypot(px - LINE.x[i0], py - LINE.y[i0]);
  const mergeLen = clamp(150 + offLine * 3, 150, 450);
  let j = i0, along = 0;
  while (along < mergeLen) { along += Math.hypot(LINE.x[(j + 1) % n] - LINE.x[j], LINE.y[(j + 1) % n] - LINE.y[j]); j = (j + 1) % n; }
  // direction at the end of the prediction: its last real stretch, or the car / road heading
  let dx = 0, dy = 0;
  for (let k = shown.length - 1; k >= 0 && Math.hypot(dx, dy) < 12; k--) { dx = px - (x0 + shown[k][0]); dy = py - (y0 + shown[k][1]); }
  let tx = LINE.x[(i0 + 1) % n] - LINE.x[i0], ty = LINE.y[(i0 + 1) % n] - LINE.y[i0];
  const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
  const dl = Math.hypot(dx, dy);
  if (dl < 12) { dx = tx; dy = ty; } else { dx /= dl; dy /= dl; }
  // reversing, or a prediction pointing back down the road: follow the road instead
  // (no loops back over the kerb). Otherwise the curve leaves exactly along the
  // prediction, so there's no corner where the two meet.
  if (c.rev || dx * tx + dy * ty < 0.2) { dx = tx; dy = ty; }
  let ex = LINE.x[(j + 1) % n] - LINE.x[(j - 1 + n) % n], ey = LINE.y[(j + 1) % n] - LINE.y[(j - 1 + n) % n];
  const el = Math.hypot(ex, ey) || 1; ex /= el; ey /= el;
  const jx = LINE.x[j], jy = LINE.y[j];
  const h = Math.min(mergeLen * 0.4, Math.hypot(jx - px, jy - py) * 0.45);   // handles never longer than the gap: no overshoot
  const c1x = px + dx * h, c1y = py + dy * h, c2x = jx - ex * h, c2y = jy - ey * h;
  for (let k = 1; k <= 16; k++) {
    const t = k / 16, u = 1 - t;
    seg(u * u * u * px + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * jx,
        u * u * u * py + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * jy);
  }
  // then the racing line the rest of the way round, and a second smooth merge back into
  // the car from behind (a straight hop onto the car kinked whenever it was off the line),
  // ending under the car where the prediction starts, so the loop is unbroken
  const offCar = Math.hypot(x0 - LINE.x[home], y0 - LINE.y[home]);
  const backLen = clamp(150 + offCar * 3, 150, 450);
  let bIdx = home, back = 0;
  while (back < backLen) { const p = (bIdx - 1 + n) % n; back += Math.hypot(LINE.x[bIdx] - LINE.x[p], LINE.y[bIdx] - LINE.y[p]); bIdx = p; }
  for (let i = (j + 1) % n, guard = 0; guard < n && i !== bIdx; guard++, i = (i + 1) % n) seg(LINE.x[i], LINE.y[i]);
  {
    const bx = LINE.x[bIdx], by = LINE.y[bIdx];
    seg(bx, by);
    let sx = LINE.x[(bIdx + 1) % n] - LINE.x[(bIdx - 1 + n) % n], sy = LINE.y[(bIdx + 1) % n] - LINE.y[(bIdx - 1 + n) % n];
    const sl = Math.hypot(sx, sy) || 1; sx /= sl; sy /= sl;
    // arrive along the way the car points, unless it's facing back down the road
    let hx = Math.cos(c.a), hy = Math.sin(c.a);
    let rx = LINE.x[(home + 1) % n] - LINE.x[home], ry = LINE.y[(home + 1) % n] - LINE.y[home];
    const rl = Math.hypot(rx, ry) || 1; rx /= rl; ry /= rl;
    if (hx * rx + hy * ry < 0.2) { hx = rx; hy = ry; }
    const hh = Math.min(backLen * 0.4, Math.hypot(x0 - bx, y0 - by) * 0.45);
    const d1x = bx + sx * hh, d1y = by + sy * hh, d2x = x0 - hx * hh, d2y = y0 - hy * hh;
    for (let k = 1; k <= 16; k++) {
      const t = k / 16, u = 1 - t;
      seg(u * u * u * bx + 3 * u * u * t * d1x + 3 * u * t * t * d2x + t * t * t * x0,
          u * u * u * by + 3 * u * u * t * d1y + 3 * u * t * t * d2y + t * t * t * y0);
    }
  }
  ctx.strokeStyle = `rgba(${LINE_RGB.ok.join(',')},${LINE_ALPHA})`;
  ctx.stroke(rest);
  return off;
}

// Feed the sound engine: your car, the three nearest others, and the crowd near you.
const revsFromSpeed = (sp) => {
  // other cars: guess the gear from the speed, like the gearbox would
  const f = sp / CAR.maxSpeed;
  for (const g of GEARS) if (f < g.top) return f / g.top;
  return 1;
};
function updateSound(cars, myX, myY) {
  const c = me.car, sp = Math.hypot(c.vx, c.vy);
  const lat = Math.abs(-c.vx * Math.sin(c.a) + c.vy * Math.cos(c.a));
  const slide = c.spin ? 1 : clamp((lat - 40 * SPEED) / (220 * SPEED), 0, 1);
  const q = queryTrack(c.x, c.y, c.qi ?? -1);
  const mine = {
    rpm: c.rev ? clamp(sp / (CAR.maxReverse || 1), 0, 1) * 0.7 : rpmOf(c),
    gas: c.gas, speed: sp, top: CAR.maxSpeed, slide,
    braking: c.brk > 0.7 && sp > 30 * SPEED, offroad: q.dist > ROAD_HALF + 4 && sp > 8 * SPEED,
  };
  const near = [];
  for (let i = 1; i < cars.length; i++) {
    const o = cars[i], d = Math.hypot(o.x - myX, o.y - myY);
    if (d < 1200) near.push({ o, d });
  }
  near.sort((a, b) => a.d - b.d);
  const others3 = near.slice(0, 3).map(({ o, d }) => {
    const osp = Math.hypot(o.vx || 0, o.vy || 0);
    return { rpm: revsFromSpeed(osp), vol: (1 - d / 1200) ** 2 * (0.4 + 0.6 * clamp(osp / CAR.maxSpeed, 0, 1)), pan: (o.x - myX) / 700 };
  });
  let crowdLevel = 0, cheer = 0;
  if (GFX.crowd !== 'off') for (const st of STANDS) {
    const prox = clamp(1 - Math.hypot(st.front.x - myX, st.front.y - myY) / 900, 0, 1);
    crowdLevel = Math.max(crowdLevel, prox);
    cheer = Math.max(cheer, prox * st.excite);
  }
  sound.update(mine, others3, crowdLevel, crowdLevel > 0 ? clamp(cheer / crowdLevel, 0, 1) : 0);
}

const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
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

  // lap panel (top-left); in a practice / qualifying / race session it has one more line
  const sm = session.mode;
  const board = sm === 'free' ? [] : boardRows();
  if (sm !== 'free' && net.mode !== 'online') checkFinished(board);
  panel(pad, pad, 200, sm === 'free' ? 112 : 140);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#a9b2a0'; ctx.font = `600 11px ${FONT_B}`;
  ctx.fillText(sm === 'quali' && info.laps === 0 ? 'OUT LAP' : 'LAP', pad + 14, pad + 22);
  ctx.fillStyle = '#f3f1e8'; ctx.font = `800 30px ${FONT_D}`;
  const lapTxt = sm === 'race' ? `${Math.min(info.laps + 1, MODES.race.laps)}/${MODES.race.laps}`
    : sm === 'quali' ? (info.laps === 0 ? '–' : `${Math.min(info.laps, MODES.quali.laps)}/${MODES.quali.laps}`) : String(info.laps + 1);
  ctx.font = `800 ${lapTxt.length > 3 ? 24 : 30}px ${FONT_D}`;
  ctx.fillText(lapTxt, pad + 14, pad + 52);
  ctx.font = `700 22px ${FONT_D}`;
  ctx.fillText(fmt(info.cur), pad + 62, pad + 50);
  ctx.font = `500 15px ${FONT_D}`;
  ctx.fillStyle = '#a9b2a0'; ctx.fillText('LAST', pad + 14, pad + 78); ctx.fillText('BEST', pad + 14, pad + 98);
  ctx.fillStyle = '#f3f1e8'; ctx.fillText(fmt(info.last), pad + 62, pad + 78);
  ctx.fillStyle = '#ffc83d'; ctx.fillText(fmt(info.best), pad + 62, pad + 98);
  if (sm !== 'free') {
    const mine = board.find(isMe), pos = mine ? mine.pos : 0;
    ctx.fillStyle = '#a9b2a0'; ctx.fillText(sm === 'practice' ? 'TIME' : 'POS', pad + 14, pad + 124);
    ctx.fillStyle = '#f3f1e8';
    let v;
    if (sm === 'practice') v = session.expired ? 'Last lap' : fmtClock(timeLeft());
    else v = pos ? `P${pos} / ${board.length}` : '–';
    if (mine && mine.fin) v = sm === 'practice' ? `Done · P${pos}` : `Finished P${pos}`;
    ctx.fillText(v, pad + 62, pad + 124);
  }

  // start lights (race): five red lights, then all out = go
  if (sm === 'race' && session.phase === 'countdown') {
    const r = Math.min(24, W / 26), gap = r * 2.6, w = gap * 5 + r, x0 = W / 2 - w / 2, y0 = Math.max(110, H * 0.2);
    ctx.fillStyle = 'rgba(10,12,10,0.85)';
    ctx.beginPath(); ctx.roundRect(x0, y0 - r * 1.5, w, r * 3, r * 0.6); ctx.fill();
    for (let k = 0; k < 5; k++) {
      ctx.fillStyle = k < session.lights ? '#ff2a1f' : '#2a2f2a';
      ctx.beginPath(); ctx.arc(x0 + r * 1.3 + k * gap, y0, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  // speedo (bottom-centre)
  const kmh = Math.round(speed * 0.36);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f3f1e8'; ctx.font = `800 44px ${FONT_D}`;
  ctx.fillText(String(kmh), W / 2, H - 34);
  ctx.fillStyle = '#a9b2a0'; ctx.font = `600 11px ${FONT_B}`;
  ctx.fillText(me.car.rev ? 'KM/H · R' : 'KM/H', W / 2, H - 16);
  if (overshooting) {
    ctx.font = `800 22px ${FONT_D}`; ctx.fillStyle = '#ff5a4a';
    ctx.fillText('TOO FAST · LET GO', W / 2, H - 112);
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
  bar(W / 2 + 54, me.car.gas, '#4ade80');     // gas (the only pedal)

  // standings (top-right): sorted by best lap; in a session, the session's order
  let rows = [{ name: me.name, color: me.color, info, me: true }];
  for (const b of bots) rows.push({ name: b.name, color: b.color, info: localInfo(b.race) });
  for (const r of remotes.values()) rows.push({ name: r.name, color: r.color, info: snapInfo(r.info, now) });
  rows.sort((a, b) => (a.info.best || 1e9) - (b.info.best || 1e9) || b.info.laps - a.info.laps);
  let title = 'BEST LAPS';
  if (sm !== 'free') {
    title = sm === 'race' ? 'RACE' : sm === 'quali' ? 'QUALIFYING' : 'PRACTICE';
    rows = board.map((r) => {
      const right = sm === 'race' ? (r.fin ? 'FIN' : `Lap ${Math.min(r.laps + 1, MODES.race.laps)}`) : (r.tbest ? fmt(r.tbest / 60) : '–');
      return { name: r.name, color: r.color, me: isMe(r), right };
    });
  }
  const rw = 210, rx = W - rw - pad;
  const rh = rows.length > 8 ? 16 : 22, small = rows.length > 8;
  if (W > 520) {
    panel(rx, pad, rw, 30 + rows.length * rh);
    ctx.textAlign = 'left'; ctx.fillStyle = '#a9b2a0'; ctx.font = `600 11px ${FONT_B}`;
    ctx.fillText(title, rx + 12, pad + 20);
    rows.forEach((r, i) => {
      const y = pad + 42 + i * rh;
      ctx.fillStyle = r.color; ctx.fillRect(rx + 12, y - (small ? 8 : 10), 4, small ? 10 : 12);
      ctx.fillStyle = r.me ? '#f3f1e8' : '#d6d9cf'; ctx.font = `${r.me ? 600 : 400} ${small ? 11 : 13}px ${FONT_B}`;
      ctx.fillText(r.name.slice(0, 14), rx + 24, y);
      ctx.textAlign = 'right'; ctx.font = `500 ${small ? 13 : 15}px ${FONT_D}`;
      ctx.fillText(r.right ?? (r.info.best ? fmt(r.info.best) : `${r.info.laps} laps`), rx + rw - 12, y);
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
    : net.mode === 'offline' ? `${MODES[session.mode].label} · ${bots.length} bot${bots.length === 1 ? '' : 's'}` : 'Connecting…';
  // keep clear of the speedometer in the middle
  if (W > 860) {
    ctx.fillText(status, pad, H - 52);
    ctx.fillText('Hold W, Space or the screen to go · let go to slow down', pad, H - 32);
    ctx.fillText(gpad.id ? 'Controller: right trigger to go · Y reset · Menu settings'
      : 'R: reset · M: sound · F: FPS', pad, H - 14);
  } else {
    ctx.fillText(status, pad, H - 16);
  }

  // first-run hint
  if (!started) {
    ctx.textAlign = 'center'; ctx.font = `700 26px ${FONT_D}`; ctx.fillStyle = '#ffc83d';
    ctx.fillText(W > 700 ? 'HOLD TO GO · LET GO TO SLOW DOWN · THE CAR STEERS ITSELF' : 'HOLD TO GO · LET GO TO SLOW DOWN', W / 2, H * 0.32);
  }

  drawFps();
  if (!$('results').hidden && now - resultsAt > 500) renderResults();
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
// Auto resolution: aim for the screen's own refresh rate (60, 90, 120, 144 Hz...).
// The refresh rate is estimated from the quickest frames seen; every ~2 s, if the game
// averages below 90% of it (or below 55 FPS), the drawing resolution steps down one
// notch, as far as 0.75×. It only ever steps down, so it can't flicker back and forth.
const perf = { t0: 0, n: 0, sum: 0, fast: [] };
const AUTO_STEPS = [2, 1.5, 1.25, 1, 0.85, 0.75];

// FPS counter (F to hide/show): frames per second and the slowest frame over the
// last half second, plus the drawing resolution in use.
const fpsMeter = { on: store.get('mr-fps') !== false, n: 0, t0: 0, worst: 0, fps: 0, worstShown: 0 };
function countFrame(t, dtf) {
  if (!fpsMeter.t0) fpsMeter.t0 = t;
  fpsMeter.n++; fpsMeter.worst = Math.max(fpsMeter.worst, dtf * 1000);
  if (t - fpsMeter.t0 >= 500) {
    fpsMeter.fps = fpsMeter.n * 1000 / (t - fpsMeter.t0);
    fpsMeter.worstShown = fpsMeter.worst;
    fpsMeter.n = 0; fpsMeter.t0 = t; fpsMeter.worst = 0;
  }
}
function drawFps() {
  if (!fpsMeter.on || !fpsMeter.fps) return;
  const f = fpsMeter.fps;
  const color = f >= 50 ? '#4ade80' : f >= 30 ? '#ffc83d' : '#ff5a4a';
  const narrow = W <= 520, res = `${+DPR.toFixed(2)}×${GFX.res === 'auto' ? ` · ${refreshHz} Hz` : ''}`;
  const label = `${Math.round(f)} FPS`, detail = narrow ? res : `slowest ${Math.round(fpsMeter.worstShown)} ms · ${res}`;
  ctx.font = `700 15px ${FONT_D}`; const w1 = ctx.measureText(label).width;
  ctx.font = `400 11px ${FONT_B}`; const w2 = ctx.measureText(detail).width;
  const w = w1 + w2 + 30, h = 24;
  // top centre; on narrow screens (no standings panel) the top-right corner instead
  const x = narrow ? W - w - 16 : (W - w) / 2, y = narrow ? 16 : 8;
  ctx.fillStyle = 'rgba(12,16,12,0.62)';
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 4); ctx.fill();
  ctx.textAlign = 'left';
  ctx.fillStyle = color; ctx.font = `700 15px ${FONT_D}`; ctx.fillText(label, x + 10, y + 17);
  ctx.fillStyle = '#a9b2a0'; ctx.font = `400 11px ${FONT_B}`; ctx.fillText(detail, x + 20 + w1, y + 16);
}
function perfMonitor(t, dtf) {
  if (GFX.res !== 'auto' || document.hidden || dtf >= 0.1 || dtf <= 0) return;   // (skip pauses / background tabs)
  // refresh rate: from the quickest frames (rounded to a common rate)
  perf.fast.push(dtf); if (perf.fast.length > 240) perf.fast.shift();
  if (perf.fast.length >= 60) {
    const q = [...perf.fast].sort((a, b) => a - b)[Math.floor(perf.fast.length * 0.05)];
    const hz = 1 / q;
    refreshHz = Math.max(refreshHz, [60, 75, 90, 120, 144, 165, 240].reduce((b, r) => (Math.abs(r - hz) < Math.abs(b - hz) ? r : b), 60));
  }
  if (!perf.t0) perf.t0 = t + 3000;                           // let loading settle first
  if (t < perf.t0) return;
  perf.n++; perf.sum += dtf;
  if (perf.sum < 2) return;                                   // judge ~2 s at a time
  const fps = perf.n / perf.sum, target = Math.max(55, refreshHz * 0.9);
  if (fps < target) {
    const next = AUTO_STEPS.find((v) => v < DPR - 0.01);
    if (next) { dprCap = next; resize(); }
  }
  perf.n = 0; perf.sum = 0;
}

function frame(t) {
  const dtf = Math.min(0.1, (t - lastT) / 1000);
  lastT = t;
  perfMonitor(t, dtf);
  countFrame(t, dtf);
  acc += dtf;
  while (acc >= DT) { fixedStep(); acc -= DT; }
  render(acc / DT, dtf);
  requestAnimationFrame(frame);
}

connect();
requestAnimationFrame(frame);
