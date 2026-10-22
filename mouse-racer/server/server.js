// Authoritative game server: serves the client and simulates every car at 60 Hz.
// Clients send mouse targets; the server owns positions and lap times.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { TICK_RATE, SPEED, setSpeed } from '../public/shared/physics.js';
import { simulateCar, collideCars, gridSlot, playerSlot, newRace, updateRace, decideLanes, applyTuning, MAX_PLAYERS } from '../public/shared/world.js';
import { TUNE } from '../public/shared/physics.js';

const PORT = Number(process.env.PORT) || 3000;
const SNAPSHOT_EVERY = 3;        // 60/3 = 20 snapshots per second
const MAX_STEPS_PER_TICK = 3;    // lets a lagging client catch up, but not speed-hack
const MAX_QUEUE = 30;
const IDLE_TICKS = 30;           // no input for 0.5s → park the car

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
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

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const broadcast = (msg) => { const s = JSON.stringify(msg); for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(s); };

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
    race: newRace(),
    queue: [], lastQueued: 0, ack: 0, idle: 0,
  };
  players.set(id, p);
  send(ws, { t: 'welcome', id, tickRate: TICK_RATE, speed: SPEED, tune: { ...TUNE } });
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
      const name = String(m.name || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16);
      if (name) p.name = name;
      if (m.car === 'gt' || m.car === 'proto') p.kind = m.car;
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
    } else if (m.t === 'respawn') {
      p.car = playerSlot(p.slot);
      p.race = newRace();
    }
  });

  ws.on('close', () => {
    players.delete(id);
    console.log(`- ${p.name} (${players.size} online)`);
  });
});

function step() {
  tick++;
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
      const q = simulateCar(p.car, inp);
      p.ack = inp.seq;
      const ev = updateRace(p.race, q.s, tick);
      if (ev) broadcast({ t: 'lap', id: p.id, time: ev.time, best: ev.best });
    }
  }
  collideCars([...players.values()].map((p) => p.car));

  if (tick % SNAPSHOT_EVERY === 0) {
    broadcast({
      t: 's',
      tick,
      cars: [...players.values()].map((p) => ({
        id: p.id, n: p.name, c: p.color, k: p.kind || 'gt',
        x: p.car.x, y: p.car.y, a: p.car.a, vx: p.car.vx, vy: p.car.vy, w: p.car.w, st: p.car.steer,
        gas: p.car.gas, brk: p.car.brk, rev: p.car.rev,
        lane: p.car.lane, la: p.car.laneAbs, pass: p.car.pass, ps: p.car.passSide, cap: p.car.cap, yt: p.car.yieldTo, gr: p.car.gear, sh: p.car.shiftT, sl: p.car.sliding, rh: p.car.revHold, rl: p.car.rel, mi: p.car.miss, py: p.car.passY, sp: p.car.spin, ut: p.car.uturn,
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

server.listen(PORT, () => console.log(`Mouse Racer on http://localhost:${PORT}`));
