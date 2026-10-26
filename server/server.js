// Authoritative game server: serves the client and simulates every car at 60 Hz.
// Clients send their one pedal; the server owns positions, lap times and the session
// (practice / qualifying / race, with the same rules as offline: shared/session.js).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { TICK_RATE, SPEED, setSpeed } from '../public/shared/physics.js';
import { simulateCar, collideCars, gridSlot, playerSlot, newRace, updateRace, decideLanes, applyTuning, marshalCar, MAX_PLAYERS } from '../public/shared/world.js';
import { accountsEnabled, verifyUser, getProfile, createProfile, renameProfile, saveResult, deleteUser, leaderboard, invalidateLeaderboard } from './accounts.js';
import { MODES, HOLD, newSess, createSession, beginSession, sessionClock, sessionLap, sessionTable } from '../public/shared/session.js';
import { TUNE } from '../public/shared/physics.js';

const PORT = Number(process.env.PORT) || 3000;
const SNAPSHOT_EVERY = 3;        // 60/3 = 20 snapshots per second
const MAX_STEPS_PER_TICK = 3;    // lets a lagging client catch up, but not speed-hack
const MAX_QUEUE = 30;
const IDLE_TICKS = 30;           // no input for 0.5s → park the car

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

// Small web API for accounts (the game file may be opened from anywhere, so CORS is open;
// nothing here is readable without a valid sign-in except the public leaderboard).
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS }); res.end(JSON.stringify(obj)); };
async function api(req, res, p) {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  if (p === '/api/config') return json(res, 200, { accounts: accountsEnabled });
  if (!accountsEnabled) return json(res, 503, { error: 'Accounts are not set up on this server' });
  if (p === '/api/leaderboard' && req.method === 'GET') {
    try { return json(res, 200, await leaderboard()); } catch (e) { console.warn('leaderboard:', e.message); return json(res, 502, { error: 'Leaderboard unavailable' }); }
  }
  if (p === '/api/account/delete' && req.method === 'POST') {
    // delete your own account (and with it your profile and results): needs your sign-in
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    try {
      const user = await verifyUser(token);
      await deleteUser(user.id);
      for (const pl of players.values()) if (pl.user && pl.user.id === user.id) pl.user = null;
      invalidateLeaderboard();
      console.log(`  account deleted (${user.guest ? 'guest' : 'google'})`);
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, e.status === 401 || e.status === 403 ? 401 : 502, { error: e.message }); }
  }
  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (p.startsWith('/api/')) { api(req, res, p).catch((e) => json(res, 500, { error: e.message })); return; }
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const COLORS = ['#e94f37', '#3b82f6', '#f5b700', '#22c55e', '#a855f7', '#ec4899', '#14b8a6', '#f97316'];
const players = new Map();
let nextId = 1;
let tick = 0;

// Player names: up to 10 letters, digits, spaces and _ . -
const NAME_MAX = 10;
const cleanName = (v) => String(v || '').replace(/[^\p{L}\p{N} _.-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const broadcast = (msg) => { const s = JSON.stringify(msg); for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(s); };

// ---- the room's session: free practice, practice, qualifying or race, for everyone
const S = createSession();
const SESSION_EVERY = 15;        // send the clock and the table 4 times a second
const entries = () => [...players.values()];
function sessionPayload(extra = {}) {
  return {
    t: 'session', mode: S.mode, phase: S.phase, lights: S.lights, expired: S.expired, fromQuali: S.fromQuali, t0: S.t0,
    endIn: S.endTick >= 0 ? Math.max(0, (S.endTick - tick) / 60) : -1,
    rows: S.mode === 'free' ? [] : sessionTable(S, entries()),
    ...extra,
  };
}
// Anyone in the room can start a session; it starts for everybody, lined up on the grid
// (in qualifying order for "race from this grid").
function startRoomSession(mode, fromQuali, by) {
  if (!MODES[mode]) return;
  const ids = entries().sort((a, b) => a.slot - b.slot).map((p) => p.id);
  const order = beginSession(S, mode, tick, ids, fromQuali);
  order.forEach((id, slot) => {
    const p = players.get(id);
    p.sess = newSess(); p.grid = slot;
    if (mode !== 'free') { p.car = playerSlot(slot); p.race = newRace(); }
  });
  broadcast(sessionPayload({ start: true, by }));
  console.log(`  ${by} started ${MODES[S.mode].label}`);
}

// ---- accounts: check the sign-in, use the account's saved name (or save this one)
async function signIn(p, token) {
  if (!accountsEnabled) { send(p.ws, { t: 'account', ok: false, error: 'Accounts are not set up on this server' }); return; }
  try {
    const user = await verifyUser(token);
    p.user = user;
    const prof = await getProfile(user.id);
    if (prof && prof.name) p.name = prof.name;
    else await createProfile(user.id, p.name);
    send(p.ws, { t: 'account', ok: true, name: p.name, guest: user.guest });
    console.log(`  ${p.name} signed in (${user.guest ? 'guest' : 'google'})`);
  } catch (e) {
    p.user = null;
    send(p.ws, { t: 'account', ok: false, error: e.status === 401 || e.status === 403 ? 'Your sign-in has expired: please sign in again' : 'Could not reach the account service' });
    console.warn('sign-in:', e.message);
  }
}
// a signed-in player finished an online session: save it
function recordResult(p) {
  if (!p.user || S.mode === 'free') return;
  const row = sessionTable(S, entries()).find((r) => r.id === p.id);
  if (!row) return;
  const ms = (t) => (t > 0 ? Math.round(t * 1000 / 60) : null);
  saveResult({
    user_id: p.user.id, mode: S.mode, position: row.pos, field_size: players.size,
    best_lap_ms: ms(row.tbest), race_time_ms: S.mode === 'race' ? ms(row.time) : null, laps: row.laps,
    pace: SPEED, grip: TUNE.grip, engine: TUNE.engine,
  }).then(invalidateLeaderboard).catch((e) => console.warn('save result:', e.message));
}

function freeSlot() {
  const used = new Set([...players.values()].map((p) => p.slot));
  for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return 0;
}

wss.on('connection', (ws) => {
  if (players.size >= MAX_PLAYERS) { send(ws, { t: 'full' }); ws.close(); return; }
  const id = nextId++;
  const slot = freeSlot();
  const p = {
    id, ws, slot,
    name: `Driver ${id}`,
    color: COLORS[slot % COLORS.length],
    car: playerSlot(slot),
    race: newRace(), sess: newSess(), grid: slot,   // (joining mid-session: you start from the grid)
    queue: [], lastQueued: 0, ack: 0, idle: 0,
  };
  players.set(id, p);
  send(ws, { t: 'welcome', id, tickRate: TICK_RATE, speed: SPEED, tune: { ...TUNE }, session: sessionPayload() });
  console.log(`+ ${p.name} (${players.size} online)`);

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'i') {
      if (!Number.isFinite(m.seq)) return;
      if (m.seq <= p.lastQueued) return;
      p.lastQueued = m.seq;
      // pedals: 0..1 (a controller's triggers send in-between values; keys send 0 or 1)
      const pedal = (v) => (v === true ? 1 : Number.isFinite(+v) ? Math.min(1, Math.max(0, +v)) : 0);
      p.queue.push({ seq: m.seq, throttle: pedal(m.g), brake: pedal(m.b), handbrake: !!m.h });   // steering is automatic
      if (p.queue.length > MAX_QUEUE) p.queue.splice(0, p.queue.length - MAX_QUEUE);
    } else if (m.t === 'hello') {
      const name = cleanName(m.name);
      if (name) p.name = name;
      if (m.car === 'gt' || m.car === 'proto') p.kind = m.car;
      if (m.token) signIn(p, String(m.token));
    } else if (m.t === 'auth') {
      // signed in or out while connected
      if (m.token) signIn(p, String(m.token)); else p.user = null;
    } else if (m.t === 'name') {
      // renamed in Settings while connected; everyone sees it in the next snapshot
      const name = cleanName(m.name);
      if (name) {
        p.name = name;
        if (p.user) renameProfile(p.user.id, name).catch((e) => console.warn('rename:', e.message));
      }
    } else if (m.t === 'car') {
      if (m.car === 'gt' || m.car === 'proto') p.kind = m.car;
    } else if (m.t === 'speed') {
      // Pace is a room setting: everyone races at the same speed.
      const v = setSpeed(m.v);
      broadcast({ t: 'speed', v, by: p.name });
    } else if (m.t === 'tune') {
      // grip / acceleration are room settings too: everyone drives the same car
      const tune = applyTuning(m.v);
      broadcast({ t: 'tune', v: tune, by: p.name });
    } else if (m.t === 'ping') {
      send(ws, { t: 'pong', c: m.c });
    } else if (m.t === 'mode') {
      startRoomSession(String(m.mode), !!m.fromQuali, p.name);
    } else if (m.t === 'respawn') {
      // free practice: back to the grid. In a session the marshal puts you back on
      // the track where you are instead, so you keep your place in it.
      if (S.mode === 'free') { p.car = playerSlot(p.slot); p.race = newRace(); p.sess = newSess(); }
      else marshalCar(p.car);
    }
  });

  ws.on('close', () => {
    players.delete(id);
    console.log(`- ${p.name} (${players.size} online)`);
  });
});

function step() {
  tick++;
  const evs = sessionClock(S, tick);        // start lights, go, time's up
  if (evs.length) broadcast(sessionPayload({ ev: evs }));
  const held = S.phase === 'countdown';     // on the grid until the lights go out
  let finished = false;
  decideLanes([...players.values()]);       // who pulls out to overtake whom
  for (const p of players.values()) {
    const n = Math.min(p.queue.length, MAX_STEPS_PER_TICK);
    if (n === 0) {
      // Tab hidden or connection stalled: let the car roll to a stop.
      if (++p.idle > IDLE_TICKS) simulateCar(p.car, { throttle: false, brake: false, handbrake: true });
      continue;
    }
    p.idle = 0;
    for (let k = 0; k < n; k++) {
      const inp = p.queue.shift();
      const q = simulateCar(p.car, held ? HOLD : inp);
      p.ack = inp.seq;
      const ev = updateRace(p.race, q.s, tick);
      if (ev) {
        broadcast({ t: 'lap', id: p.id, time: ev.time, best: ev.best, laps: p.race.laps });
        if (sessionLap(S, p, ev, tick)) { finished = true; recordResult(p); }
      }
    }
  }
  collideCars([...players.values()].map((p) => p.car));
  if (S.mode !== 'free' && (finished || tick % SESSION_EVERY === 0)) broadcast(sessionPayload());

  if (tick % SNAPSHOT_EVERY === 0) {
    broadcast({
      t: 's',
      tick,
      cars: [...players.values()].map((p) => ({
        id: p.id, n: p.name, c: p.color, k: p.kind || 'gt',
        x: p.car.x, y: p.car.y, a: p.car.a, vx: p.car.vx, vy: p.car.vy, w: p.car.w, st: p.car.steer,
        gas: p.car.gas, brk: p.car.brk, rev: p.car.rev,
        lane: p.car.lane, la: p.car.laneAbs, pass: p.car.pass, ps: p.car.passSide, cap: p.car.cap, yt: p.car.yieldTo, gr: p.car.gear, sh: p.car.shiftT, sl: p.car.sliding, rh: p.car.revHold, rl: p.car.rel, mi: p.car.miss, py: p.car.passY, sp: p.car.spin, ut: p.car.uturn, sk: p.car.stuckT || 0, mk: p.car.marshal || 0,
        ack: p.ack,
        lap: p.race.laps,
        cur: p.race.lapStart >= 0 ? tick - p.race.lapStart : -1,
        last: p.race.lastLap, best: p.race.bestLap,
      })),
    });
  }
}

// Fixed-timestep loop with an accumulator so the sim rate doesn't drift.
const STEP_MS = 1000 / TICK_RATE;
let last = performance.now(), acc = 0;
setInterval(() => {
  const now = performance.now();
  acc += now - last;
  last = now;
  let n = 0;
  while (acc >= STEP_MS && n < 5) { step(); acc -= STEP_MS; n++; }
  if (n === 5) acc = 0;
}, STEP_MS / 2);

server.listen(PORT, () => console.log(`Mouse Racer on http://localhost:${PORT}${accountsEnabled ? ' (accounts on)' : ' (accounts off: set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY)'}`));
