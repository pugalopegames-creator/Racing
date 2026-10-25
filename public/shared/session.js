// Race sessions: practice, qualifying and race. Shared by the browser (practice with
// bots) and the server (online with friends), so both follow exactly the same rules.
//
//   free      endless driving, best laps on the board
//   practice  3 minutes; when time's up, finish your lap. Ranked by best lap
//   quali     an out lap, then 2 timed laps. Ranked by best timed lap; the order can
//             be used as the grid for the next race
//   race      6 laps from a standing start: five red lights come on one per 0.6 s, then
//             go out after a random 0.4-1.2 s. Ranked by finishing order, then distance
//
// A "driver" here is anything with { id, name, color, car, race, sess, grid }.
// Times are in ticks (60 per second).
import { TRACK, queryTrack } from './track.js';

export const MODES = {
  free: { label: 'Free practice' },
  practice: { label: 'Practice', minutes: 3 },
  quali: { label: 'Qualifying', laps: 2 },
  race: { label: 'Race', laps: 6 },
};

// Held on the grid while the lights are on: handbrake only (the brake pedal at a
// standstill would select reverse).
export const HOLD = { throttle: 0, brake: 0, handbrake: true };

export const newSess = () => ({ laps: [], finishTick: -1 });

export function createSession() {
  return { mode: 'free', phase: 'running', t0: 0, goTick: 0, endTick: -1, lightsOutAt: 0, lights: 0, expired: false, fromQuali: false, qualiOrder: null };
}

/**
 * Start a session. ids: everyone taking part, in the default grid order (front first).
 * Returns the grid order to line the cars up in (the qualifying order for a race
 * "from this grid").
 */
export function beginSession(S, mode, tick, ids, fromQuali = false, rnd = Math.random) {
  S.mode = MODES[mode] ? mode : 'free';
  S.fromQuali = !!(fromQuali && S.qualiOrder && S.mode === 'race');
  S.phase = S.mode === 'race' ? 'countdown' : 'running';
  S.t0 = tick; S.goTick = S.mode === 'race' ? -1 : tick; S.lights = 0; S.expired = false;
  S.endTick = S.mode === 'practice' ? tick + MODES.practice.minutes * 3600 : -1;
  S.lightsOutAt = tick + Math.round((3.0 + 0.4 + rnd() * 0.8) * 60);
  if (!S.fromQuali) return ids.slice();
  const order = S.qualiOrder.filter((id) => ids.includes(id));
  for (const id of ids) if (!order.includes(id)) order.push(id);
  return order;
}

/** Advance the session clock. Returns what happened: 'light', 'go', 'timeup'. */
export function sessionClock(S, tick) {
  const ev = [];
  if (S.phase === 'countdown') {
    const lit = Math.min(5, Math.floor((tick - S.t0) / 36 + 1e-6));
    if (lit > S.lights) { S.lights = lit; ev.push('light'); }
    if (tick >= S.lightsOutAt) { S.phase = 'running'; S.goTick = tick; S.lights = 0; ev.push('go'); }
  }
  if (S.mode === 'practice' && !S.expired && tick >= S.endTick) { S.expired = true; ev.push('timeup'); }
  return ev;
}

/** A driver completed a lap (ev from updateRace). Returns true if that ends their session. */
export function sessionLap(S, d, ev, tick) {
  d.sess.laps.push(ev.time);
  if (d.sess.finishTick >= 0 || S.mode === 'free') return false;
  const done = (S.mode === 'race' && d.race.laps >= MODES.race.laps)
    || (S.mode === 'quali' && d.race.laps >= MODES.quali.laps + 1)
    || (S.mode === 'practice' && S.expired);
  if (!done) return false;
  d.sess.finishTick = tick;
  return true;
}

/** Best lap that counts: in qualifying the out lap doesn't. 0 = no time yet. */
export function timedBest(S, d) {
  const laps = S.mode === 'quali' ? d.sess.laps.slice(1) : d.sess.laps;
  return laps.length ? Math.min(...laps) : 0;
}

/** How far round the race a car is (laps + distance), for positions. */
export function progressOf(d) {
  const s = queryTrack(d.car.x, d.car.y, d.car.qi ?? -1).s;
  return d.race.laps * TRACK.length + (d.race.lapStart >= 0 ? s : s - TRACK.length);
}

/** Running order. Before the start, the grid order. */
export function sessionOrder(S, ds) {
  if (S.mode === 'race' && S.phase === 'countdown') return ds.slice().sort((a, b) => (a.grid ?? 99) - (b.grid ?? 99));
  if (S.mode === 'race') {
    return ds.map((d) => ({ d, fin: d.sess.finishTick, prog: progressOf(d) }))
      .sort((a, b) => (a.fin >= 0 && b.fin >= 0 ? a.fin - b.fin : a.fin >= 0 ? -1 : b.fin >= 0 ? 1 : b.prog - a.prog))
      .map((x) => x.d);
  }
  if (S.mode === 'free') return ds.slice().sort((a, b) => (bestOf(a) || 1e9) - (bestOf(b) || 1e9));
  return ds.slice().sort((a, b) => (timedBest(S, a) || 1e9) - (timedBest(S, b) || 1e9));
}
const bestOf = (d) => (d.race && d.race.bestLap) || 0;

/**
 * The board / results table, as plain data (the server sends exactly this):
 * [{ id, name, color, pos, laps, best, tbest, fin, time }]
 *   best: best lap, tbest: best lap that counts, fin: true once finished,
 *   time: race time to the finish (ticks, -1 if not finished)
 * In qualifying it also records the order for the next race's grid.
 */
export function sessionTable(S, ds) {
  const order = sessionOrder(S, ds);
  if (S.mode === 'quali') S.qualiOrder = order.map((d) => d.id);
  return order.map((d, i) => ({
    id: d.id, name: d.name, color: d.color, pos: i + 1,
    laps: d.race.laps,
    best: d.sess.laps.length ? Math.min(...d.sess.laps) : 0,
    tbest: timedBest(S, d),
    fin: d.sess.finishTick >= 0,
    time: d.sess.finishTick >= 0 && S.goTick >= 0 ? d.sess.finishTick - S.goTick : -1,
  }));
}
