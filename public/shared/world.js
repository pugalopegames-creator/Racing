// World rules shared by server and client: surfaces, walls, laps, car-vs-car, bots.
import { CAR, BASE, SURFACES, SPEED, TUNE, setTuning, createCar, stepCar, wrapAngle } from './physics.js';
import { TRACK, ROAD_HALF, WALL, LINE, queryTrack, pointAt } from './track.js';

export const CHECKPOINTS = 10;
export const MAX_PLAYERS = 8;

// ---------------------------------------------------------------- autopilot
// Every car steers itself along the racing line. Players only work the pedals;
// the tyres decide whether the car can actually follow the line at that speed.

/** Point on the racing line `look` px ahead of track position q. */
export function linePointAhead(q, look) {
  const n = LINE.n;
  let i = q.i, frac = q.t, rem = look;
  // start from the car's spot on the line, then walk forward
  rem += frac * LINE.ds[i];
  while (rem > LINE.ds[i]) { rem -= LINE.ds[i]; i = (i + 1) % n; }
  const j = (i + 1) % n, k = rem / LINE.ds[i];
  return { x: LINE.x[i] + (LINE.x[j] - LINE.x[i]) * k, y: LINE.y[i] + (LINE.y[j] - LINE.y[i]) * k, i };
}

/**
 * Where the auto-driver aims: a short look-ahead keeps it on the line through apexes.
 * While overtaking (car.lane > 0) it blends toward a passing line at car.laneAbs.
 */
export function autoTarget(car, q) {
  const speed = Math.hypot(car.vx, car.vy) / SPEED;      // pace-independent
  // Look further ahead the further we are from the line, so the car merges back in
  // at a shallow angle instead of cutting across and overshooting the other way.
  const offLine = Math.hypot(car.x - LINE.x[q.i], car.y - LINE.y[q.i]);
  const look = Math.min(280, Math.max(85 + speed * 0.05, offLine * 2.2));
  let p = linePointAhead(q, look);
  if (car.miss) {
    // a missed apex: aim off the racing line by car.miss px (signed, + = left)
    const i = p.i, pts = TRACK.pts;
    const lat = Math.max(-(ROAD_HALF - 6), Math.min(ROAD_HALF - 6, LINE.off[i] + car.miss));   // aims at most onto the kerb; a slide may take it further
    p = { x: pts[i][0] + LINE.nx[i] * lat, y: pts[i][1] + LINE.ny[i] * lat, i };
  }
  if (car.lane <= 0) return p;
  const i = p.i, j = (i + 1) % LINE.n, pts = TRACK.pts;
  const k = Math.hypot(p.x - LINE.x[i], p.y - LINE.y[i]) / LINE.ds[i];
  const cx = pts[i][0] + (pts[j][0] - pts[i][0]) * k, cy = pts[i][1] + (pts[j][1] - pts[i][1]) * k;
  // a passing line is a small offset from the racing line, but never off the asphalt
  // (a car being passed stays a little further in: with the weight pushing it wide
  // and less grip, the kerb is too close to the grass)
  const lim = !car.rel ? OBSTACLE_EDGE : car.yieldTo >= 0 ? ROAD_HALF - CAR.width / 2 - 4 : ROAD_HALF - CAR.width / 2 - 1;
  const lat = Math.max(-lim, Math.min(lim, car.rel ? LINE.off[i] + car.laneAbs : car.laneAbs));
  const lx = cx + LINE.nx[i] * lat, ly = cy + LINE.ny[i] * lat;
  return { x: p.x + (lx - p.x) * car.lane, y: p.y + (ly - p.y) * car.lane, i };
}

// ---------------------------------------------------------------- overtaking
const PASS_RETRY = 150;                   // ticks to wait after an abandoned pass before trying again
const PASS_MAX_SHIFT = 34;               // the passing car moves this far off the racing line (~1.4 car widths)
const YIELD_SHIFT = 20;                  // the car being passed eases this far the other way
const PASS_SLOPE = 0.09;                 // drift across the road at most ~5° (lateral px per px travelled)
const PASS_SIDE_BY_SIDE = 220;            // stretch of road checked for room on both sides
const OBSTACLE_SLOPE = 0.4;              // steering round a stopped car: up to ~22°
const PASS_SEP = 46;                     // side by side, centre to centre: ~22 px of air between the bodies
const PASS_MAX = 42;                     // the passer moves at most this far off the racing line
const YIELD_MAX = 32;                    // the car being passed eases at most this far the other way
const YIELD_EDGE = ROAD_HALF - 10;       // room counted for it on its side (it squeezes a little rather than leave the asphalt)
const PASS_GAP = PASS_MAX_SHIFT + YIELD_SHIFT;   // centre-to-centre side by side: 54 px, ~16 px clear of touching                      // centre-to-centre side gap: leaves 32 px of air between the cars
const PASS_LENGTH = 340;                  // road a pass needs, checked before pulling out
const PASS_EDGE = ROAD_HALF - 20;         // passing line stays this far inside the road edge (car fully on asphalt)
const PASS_MIN_SAFE = 450;               // (at SPEED = 1) bends slower than this are "tight": no starting a pass into them (~75% of the lap is passable)

/** Signed distance from the centreline (left of travel = positive). */
export function lateral(car, q) {
  const g = TRACK.segs[q.i];
  return (car.x - q.px) * -g.dy + (car.y - q.py) * g.dx;
}

/** Stopped or crawling: a car to drive around, not one to race past. */
const stalled = (o) => o.v < Math.max(12 * SPEED, 0.25 * safeSpeed(o.q.i));
const OBSTACLE_EDGE = ROAD_HALF - 12;     // going round a stopped car may use the road right to the kerb
/** Where a car's lane is across the road at track position q (passing lines are kept relative to the racing line). */
const laneLat = (car, q) => (car.rel ? LINE.off[q.i] + car.laneAbs : car.laneAbs);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const wrapS = (d) => { const L = TRACK.length; d %= L; if (d > L / 2) d -= L; if (d < -L / 2) d += L; return d; };

/**
 * Decide for every car whether to pull out and pass the car in front.
 * entries: [{ id, car }]. Runs where the authority lives (server / offline),
 * and the result travels in the car state, so prediction stays consistent.
 */
export function decideLanes(entries) {
  const info = entries.map((e) => {
    const q = queryTrack(e.car.x, e.car.y, e.car.qi ?? -1);
    return { e, q, s: q.s, lat: lateral(e.car, q), v: Math.hypot(e.car.vx, e.car.vy) };
  });
  for (const me of info) {
    const c = me.e.car;
    if (c.passCool > 0) c.passCool--;
    if (c.pass >= 0) {
      const other = info.find((o) => o.e.id === c.pass);
      const gap = other ? wrapS(other.s - me.s) : -1e9;
      // done: clear ahead of them, or they've dropped away
      if (!other || gap < -80 || gap > 260) { c.pass = -1; continue; }
      const myLane = laneLat(c, me.q);
      // someone else has moved into our path ahead: pass them instead if there's room, else settle in behind
      const blocker = info.find((o) => {
        if (o === me || o === other) return false;
        const g = wrapS(o.s - me.s);
        if (g < 30 || g > 120) return false;                 // alongside or behind isn't "in our path"
        // only cars in the strip of road we're driving into: between us and our passing lane
        const near = CAR.radius * 2 + 4;
        const lo = Math.min(me.lat, myLane) - near, hi = Math.max(me.lat, myLane) + near;
        return o.lat > lo && o.lat < hi && Math.abs(o.lat - me.lat) < CAR.radius * 2 + 12
          || (o.lat > lo && o.lat < hi && Math.abs(o.lat - myLane) < near);
      });
      if (blocker) {
        const sides = [1, -1].filter((sd) => roomForPass(me, blocker, sd, info));
        if (sides.length) startPass(c, blocker, sides[0]);
        else { c.pass = -1; c.passCool = PASS_RETRY; }
        continue;
      }
      if (stalled(other)) {
        // going round an obstacle: stay a fixed gap beside it, anywhere on the road
        const want = other.lat + c.passSide * PASS_GAP;
        if (Math.abs(want) > OBSTACLE_EDGE && gap > 20) { c.pass = -1; c.passCool = PASS_RETRY; continue; }
        c.rel = 0; c.laneAbs = Math.max(-OBSTACLE_EDGE, Math.min(OBSTACLE_EDGE, want));
        continue;
      }
      // racing pass: a small offset from the racing line. Tuck back in if the road runs out.
      if (gap > 20 && Math.abs(LINE.off[me.q.i] + c.laneAbs) > ROAD_HALF - CAR.width / 2 + 2) { c.pass = -1; c.passCool = PASS_RETRY; continue; }
      c.rel = 1;
      continue;
    }
    if (c.rev || c.passCool > 0) continue;
    // nearest car just ahead, roughly on our line
    let best = null, bestGap = 1e9;
    for (const o of info) {
      if (o === me) continue;
      const gap = wrapS(o.s - me.s);
      const reach = stalled(o) ? 260 : 150;            // see a stopped car earlier
      if (gap > 0 && gap < reach && Math.abs(o.lat - me.lat) < CAR.radius * 2 + 6 && gap < bestGap) { best = o; bestGap = gap; }
    }
    if (!best) continue;
    if (stalled(best)) {
      // A stopped car isn't a race: just go round it on whichever side has room.
      const sides = [1, -1].filter((sd) => roomForPass(me, best, sd, info));
      if (!sides.length) continue;
      sides.sort((a, b) => Math.abs(best.lat + a * PASS_GAP - me.lat) - Math.abs(best.lat + b * PASS_GAP - me.lat));
      startPass(c, best, sides[0]);
      continue;
    }
    // Only go if the pass can be finished before the next tight corner:
    // road needed = our speed × time to gain (gap + a car length + margin) on them.
    let closing = me.v - best.v;
    // Right on their bumper and keeping pace: we're held up, not slower. Out of their
    // way we could do what the road ahead allows, so plan the pass on that speed.
    if (bestGap < 140 && (me.v > 0.85 * best.v || c.cap >= 0)) {
      let free = Infinity;
      for (let d = 0; d <= 300; d += 60) free = Math.min(free, safeSpeed(linePointAhead(me.q, d).i));
      // no boost on the way past: only what the road ahead allows
      closing = Math.max(closing, free * 0.98 - best.v);
    }
    if (closing <= 0.01 * me.v) continue;                             // not catching them
    // A mistake ahead is an opening: they've run wide off the line, or they're
    // clearly slow (braked too early, dawdling out of a corner). Go for it now,
    // even near a corner, as long as there's room.
    const rawClosing = me.v - best.v;
    const opening = Math.abs(best.e.car.miss || 0) > 20 || rawClosing > 0.15 * Math.max(me.v, 1);
    // try both sides; a side counts only if there's room for the WHOLE pass
    let sides = [1, -1].filter((sd) => roomForPass(me, best, sd, info));
    if (!opening) {
      // We only need to get alongside before the corner; from there the pass is committed.
      // Not enough road before it? Then only a dive down the inside of that corner.
      const needed = (me.v * (bestGap + 30)) / closing;
      if (needed > distToTight(c, 1600)) {
        const { a } = nextApex(me.q.i);
        sides = a >= 0 ? sides.filter((sd) => sd === Math.sign(LINE.off[a])) : [];
      }
    }
    if (!sides.length) continue;                                     // no room: follow
    // prefer the side that's the smaller move from where we are
    const lineHere = LINE.off[me.q.i];
    sides.sort((a, b) => Math.abs(lineHere + a * PASS_MAX_SHIFT - me.lat) - Math.abs(lineHere + b * PASS_MAX_SHIFT - me.lat));
    startPass(c, best, sides[0]);
  }
  // Being passed: while someone is alongside, hold our line and leave them their
  // gap, instead of following the racing line across into them.
  for (const me of info) {
    const c = me.e.car;
    c.yieldTo = -1;
    if (c.pass >= 0) continue;
    for (const o of info) {
      const oc = o.e.car;
      if (oc.pass !== me.e.id) continue;
      const gap = wrapS(o.s - me.s);
      if (gap < -240 || gap > 60) continue;             // they're not close yet / already past
      if (!oc.rel) continue;                            // they're going round us as an obstacle: stay put
      // ease over a little, early, so the two small moves add up to room side by side
      c.yieldTo = o.e.id;
      c.rel = 1;
      c.laneAbs = -oc.passSide * (oc.passY || YIELD_SHIFT);   // the share of the room the passer needs from us
    }
  }

  // Follow limiter: held up behind someone we're not passing (yet)? Match their speed,
  // and drop back if we're too close, instead of running into them.
  for (const me of info) {
    const c = me.e.car;
    let cap = -1;
    for (const o of info) {
      if (o === me || o.e.id === c.pass) continue;
      const gap = wrapS(o.s - me.s);
      if (gap <= 0 || gap > 140) continue;
      // the strip of road we're using: our passing line, or from where we are to
      // where we're heading back to (the racing line) if we're rejoining it
      const near = CAR.radius * 2 + 8;
      let lo = me.lat, hi = me.lat;
      if (c.pass >= 0) lo = hi = laneLat(c, me.q);
      else if (c.lane > 0.05) { lo = Math.min(me.lat, LINE.off[me.q.i]); hi = Math.max(me.lat, LINE.off[me.q.i]); }
      if (o.lat < lo - near || o.lat > hi + near) continue;
      const want = o.v * clamp01((gap - 40) / 80) * 0.15 + o.v * 0.88;   // 0.88× when close, ~1.03× with room
      cap = cap < 0 ? want : Math.min(cap, want);
    }
    c.cap = cap;
  }
}

/**
 * Is there room to pass `other` on side sd (+1 left, -1 right) for the full length
 * of the pass? Checks where the other car will drift as it follows the racing line,
 * keeps the passing line on the asphalt, and keeps the lane clear of third cars.
 */
function roomForPass(me, other, sd, info) {
  const still = stalled(other);
  let lane;
  if (still) {
    // going round a stopped car: any line on the road, a gap beside it
    lane = other.lat + sd * PASS_GAP;
    if (Math.abs(lane) > OBSTACLE_EDGE) return false;
  } else {
    // racing pass: only a slight adjustment of the line, shared between the two cars.
    // Work out how far each can move over the stretch where they'll be side by side.
    const split = passSplit(me.q, sd);
    if (!split) return false;
    lane = LINE.off[me.q.i] + sd * split.p;
    // they must not already be sitting in our lane (e.g. running wide on that side)
    if (Math.abs(other.lat - lane) < CAR.radius * 2 + 4) return false;
  }
  const clear = CAR.radius * 2 + 10;
  const lo = Math.min(me.lat, lane) - clear, hi = Math.max(me.lat, lane) + clear;
  for (const o of info) {
    if (o === me || o === other) continue;
    const gap = wrapS(o.s - me.s);
    // the road we'd cross to get to the passing lane must be clear right now: cars
    // ahead or alongside, on the side we're moving toward (not ones we're moving away from, or behind us)
    const toward = (o.lat - me.lat) * Math.sign(lane - me.lat) >= -CAR.radius;
    if (gap > -25 && gap < 140 && toward && o.lat > lo && o.lat < hi) return false;
    // cars behind us in the lane only matter in a race; going round a stopped car we just move off ahead of them
    if (gap < (still ? -25 : -120) || gap > PASS_LENGTH) continue;
    if (Math.abs(o.lat - lane) < clear) return false;                                        // someone already there
    if (o.e.car.pass >= 0 && Math.abs(laneLat(o.e.car, o.q) - lane) < clear) return false;   // lane claimed by another pass
  }
  return true;
}

/**
 * How a pass on side sd splits the room: the passer moves p off the racing line,
 * the car being passed eases y the other way, p + y = PASS_SEP. Prefer the passer
 * doing most of it. Null if there isn't room for both on this stretch.
 */
function passSplit(q, sd) {
  const onRoad = ROAD_HALF - CAR.width / 2 - 1;
  let pCap = PASS_MAX, yCap = YIELD_MAX;
  for (let d = 0; d <= PASS_SIDE_BY_SIDE; d += 34) {
    const off = LINE.off[linePointAhead(q, d).i];
    pCap = Math.min(pCap, onRoad - sd * off);         // room on our side of the line
    yCap = Math.min(yCap, YIELD_EDGE + sd * off);     // room on their side
  }
  if (pCap < 8 || pCap + Math.max(0, yCap) < PASS_SEP) return null;
  const p = Math.min(pCap, PASS_SEP - 6);
  return { p, y: PASS_SEP - p };
}

function startPass(c, other, sd) {
  c.pass = other.e.id;
  c.passSide = sd;
  if (stalled(other)) { c.rel = 0; c.laneAbs = other.lat + sd * PASS_GAP; }
  else { const sp = passSplit(queryTrack(c.x, c.y, c.qi ?? -1), sd) || { p: PASS_MAX_SHIFT, y: YIELD_SHIFT }; c.rel = 1; c.laneAbs = sd * sp.p; c.passY = sp.y; }
}

/** Distance to the next corner too tight to pass in (capped at max). */
function distToTight(car, max) {
  const q = queryTrack(car.x, car.y, car.qi ?? -1);
  for (let d = 0; d <= max; d += 40) if (SPEED_PROFILE[linePointAhead(q, d).i] < PASS_MIN_SAFE) return d;
  return max;
}

/** Blend the aim between racing line and passing line; part of the car's own step. */
function updateLane(car, q, dt) {
  const target = car.pass >= 0 || car.yieldTo >= 0 ? 1 : 0;
  // move across the road at a shallow angle: the further the passing line is from
  // the racing line, the more distance the change takes (same feel at any pace)
  const span = Math.max(8, Math.abs(car.rel ? car.laneAbs : car.laneAbs - LINE.off[q.i]));
  // (going round a stopped car is the exception: that needs a proper swerve)
  const slope = car.rel ? PASS_SLOPE : OBSTACLE_SLOPE;
  let rate = (Math.max(Math.hypot(car.vx, car.vy), 20 * SPEED) * dt * slope) / span;
  if (!car.rel) rate = Math.max(rate, 1.5 * dt);   // round an obstacle: pick the gap now, even from a standstill
  car.lane += Math.max(-rate, Math.min(rate, target - car.lane));
}

// Fastest speed (at SPEED = 1) the line can be driven at each point: limited by
// tyre grip in corners, then braking zones worked backwards from each corner.
function buildSpeedProfile(v = new Float64Array(LINE.n)) {
  const n = LINE.n;
  const top = BASE.maxSpeed * 0.9, grip = BASE.grip * TUNE.grip * 0.92, brake = BASE.brake * 0.7;
  for (let i = 0; i < n; i++) v[i] = Math.min(top, Math.sqrt(grip * LINE.radius[i]));
  for (let pass = 0; pass < 2; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const j = (i + 1) % n;
      v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * brake * LINE.ds[i]));
    }
  }
  return v;
}
export const SPEED_PROFILE = buildSpeedProfile();

// Which side of the road the inside of the bend is on at each point (+1 left, -1 right).
const BEND_SIDE = (() => {
  const n = LINE.n, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 2 + n) % n, c = (i + 2) % n;
    const cross = (LINE.x[i] - LINE.x[a]) * (LINE.y[c] - LINE.y[i]) - (LINE.y[i] - LINE.y[a]) * (LINE.x[c] - LINE.x[i]);
    // compare with the left normal (nx, ny) = (-dy, dx): positive cross = turning toward it
    out[i] = Math.sign(cross) || 1;
  }
  return out;
})();

/** Change the car's grip / engine multipliers; the safe-speed profile follows the grip. */
export function applyTuning(t) {
  const r = setTuning(t);
  buildSpeedProfile(SPEED_PROFILE);
  return r;
}

// Bot difficulty (practice mode): speed and how often they make mistakes. 1 = normal.
export const BOTS = { skill: 1, mistakes: 1 };
export const BOT_LIMITS = { skill: [0.85, 1.1], mistakes: [0, 2] };
export function setBotTuning(t) {
  for (const k in BOT_LIMITS) {
    if (t && Number.isFinite(+t[k])) BOTS[k] = Math.max(BOT_LIMITS[k][0], Math.min(BOT_LIMITS[k][1], +t[k]));
  }
  return { ...BOTS };
}

/** Target speed at line index i for the current pace. */
export const safeSpeed = (i) => SPEED_PROFILE[i] * SPEED;

/** One fixed step for one car, including autopilot, surface and barrier. Returns track query. */
export function simulateCar(car, inp) {
  const q0 = queryTrack(car.x, car.y, car.qi ?? -1);
  updateLane(car, q0, 1 / 60);
  const aim = autoTarget(car, q0);
  // Facing the wrong way after a spin? Turn round on the road, toward the side with
  // room, then pick the racing line up again.
  const seg = TRACK.segs[q0.i];
  const facing = wrapAngle(car.a - Math.atan2(seg.dy, seg.dx));
  if (car.spin) car.uturn = 0;                       // decide once the spin has finished
  else if (!car.uturn && Math.abs(facing) > UTURN_FROM && !car.rev) car.uturn = uturnSide(car, q0, facing, seg);
  else if (car.uturn && (Math.abs(facing) < UTURN_DONE || car.rev)) car.uturn = 0;
  let throttle = inp.throttle, brake = inp.brake;
  // (bots only: a player's pedals are never overridden, they choose when to lift)
  if (car.cap >= 0 && !car.rev && !car.human) {
    const v = Math.hypot(car.vx, car.vy);
    if (v > car.cap) {                         // too close behind someone: ease off, brake if needed
      throttle = 0;
      const over = (v - car.cap) / (0.12 * car.cap + 1);
      // (never brake a car that's already stopped: brake at a standstill means 'reverse')
      // (gently: hard braking would use up the grip needed to steer)
      if (over > 0.3 && v > 6 * SPEED) brake = Math.max(+brake || 0, Math.min(0.5, over));
    }
  }
  const surface = q0.dist > ROAD_HALF ? SURFACES.grass : SURFACES.road;
  stepCar(car, { tx: aim.x, ty: aim.y, throttle, brake, handbrake: inp.handbrake, steerLock: car.uturn }, surface);

  const q = queryTrack(car.x, car.y, q0.i);
  car.qi = q.i;
  const limit = WALL - CAR.radius;
  if (q.dist > limit) {
    const over = q.dist - limit;
    car.x -= q.nx * over;
    car.y -= q.ny * over;
    const vn = car.vx * q.nx + car.vy * q.ny;
    if (vn > 0) {
      const v = Math.hypot(car.vx, car.vy);
      const hard = Math.min(1, vn / (0.3 * v + 1e-6));     // 0 = grazing along it, 1 = straight in
      car.vx -= q.nx * vn * (1 + 0.35 * hard);   // bounce (restitution up to 0.35)
      car.vy -= q.ny * vn * (1 + 0.35 * hard);
      // scrape: a real hit costs real time (up to half your speed); grazing along
      // the barrier, e.g. creeping away from it after a spin, barely does
      const keep = 1 - 0.5 * hard * hard;
      car.vx *= keep; car.vy *= keep; car.w *= keep;
    }
    // The barrier turns the car to slide along it, so you can't get pinned nose-in.
    // Turning round after a spin, it swings the car toward the way the track runs.
    if (car.uturn) {
      car.a = wrapAngle(car.a + car.uturn * 0.04);      // help the turn round, the same way it's turning
    } else {
      const tx = -q.ny, ty = q.nx;                       // wall tangent
      const dir = Math.cos(car.a) * tx + Math.sin(car.a) * ty >= 0 ? 1 : -1;
      const along = Math.atan2(ty * dir, tx * dir);
      car.a = wrapAngle(car.a + Math.max(-0.05, Math.min(0.05, wrapAngle(along - car.a))));
    }
  }
  // The marshal (players only): there's no reverse, so a car that's stuck with the gas
  // held (nose in a barrier, tangled with another car, beached after a spin) is put back
  // on the racing line after 2 s, facing the right way, like a slot car put back in its slot.
  if (car.human) {
    const v = Math.hypot(car.vx, car.vy);
    car.stuckT = (+inp.throttle > 0.3 && v < 15 * SPEED) ? (car.stuckT || 0) + 1 / 60 : 0;
    if (car.stuckT > 2) marshalCar(car, q.i);
  }
  return q;
}

/** Put a car back on the racing line at track index i (nearest if omitted), stopped, facing the right way. */
export function marshalCar(car, i = queryTrack(car.x, car.y, car.qi ?? -1).i) {
  const seg = TRACK.segs[i];
  car.x = LINE.x[i]; car.y = LINE.y[i];
  car.a = Math.atan2(seg.dy, seg.dx);
  car.vx = car.vy = car.w = 0; car.steer = 0;
  car.spin = car.spun = car.sliding = false; car.uturn = 0; car.rev = false; car.gear = 0;
  car.lane = 0; car.laneAbs = 0; car.pass = -1; car.miss = 0;
  car.stuckT = 0;
  car.marshal = (car.marshal || 0) + 1;                // (the client shows "Back on track")
}

/** Equal-mass circle collisions between cars. */
/**
 * Which way to turn round (+1 = steer left, -1 = right): the shorter way, unless
 * that arc would swing the car into the barrier it's next to.
 */
function uturnSide(car, q, facing, seg) {
  const shortest = facing > 0 ? -1 : 1;
  const lat = lateral(car, q);
  // the arc's centre is on the side we turn toward: (+1) the car's left (-sin a, cos a)
  const nX = -seg.dy, nY = seg.dx;                       // the track's left
  const centreSide = shortest * (-Math.sin(car.a) * nX + Math.cos(car.a) * nY);
  const towardWall = Math.sign(centreSide) !== Math.sign(lat);   // arc bulges out toward the near edge
  return towardWall && Math.abs(lat) > ROAD_HALF - 60 ? -shortest : shortest;
}
const UTURN_FROM = 1.95;     // rad (~110°) off the direction of the track: time to turn round
const UTURN_DONE = 0.8;      // ...until we're within ~45° of it again
const BUMP_TAP = 0.012;       // speed lost per contact tick, however gentle (pushing someone costs)
const BUMP_HITTER = 2.5;      // extra loss for the car doing the hitting, per unit of impact
const BUMP_MIN = 0.012;       // closing speed (fraction of top speed) below which contact is just a scrape
const BUMP_HIT = 0.8;         // ...and for the car that gets hit
export function collideCars(cars) {
  const R2 = CAR.radius * 2;
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i], b = cars[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d >= R2 || d < 1e-6) continue;
      const nx = dx / d, ny = dy / d;
      const push = (R2 - d) / 2;
      a.x -= nx * push; a.y -= ny * push;
      b.x += nx * push; b.y += ny * push;
      const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (rv < 0) {
        // mostly inelastic: a bump doesn't fire the car in front down the road
        const j2 = (-(1 + 0.15) * rv) / 2;
        a.vx -= nx * j2; a.vy -= ny * j2;
        b.vx += nx * j2; b.vy += ny * j2;
        // ...and it costs speed: bent noses and scrubbed tyres. The car doing the
        // hitting (moving into the other) loses most; even a tap costs a little.
        const impact = -rv / Math.max(1, CAR.maxSpeed);           // pace-independent
        const aHits = (a.vx * nx + a.vy * ny) > (b.vx * nx + b.vy * ny);
        const hitter = aHits ? a : b, hit = aHits ? b : a;
        // (a slow scrape, or low-speed jostling past a stopped car, isn't a racing hit)
        const vh = Math.hypot(hitter.vx, hitter.vy), vt = Math.hypot(hit.vx, hit.vy), top = Math.max(1, CAR.maxSpeed);
        if (Math.min(vh, vt) < 0.12 * top && Math.max(vh, vt) < 0.35 * top) continue;
        const tap = impact > BUMP_MIN ? BUMP_TAP : 0;
        const lossHitter = Math.min(0.45, tap + BUMP_HITTER * impact);
        const lossHit = Math.min(0.25, tap * 0.3 + BUMP_HIT * impact);
        hitter.vx *= 1 - lossHitter; hitter.vy *= 1 - lossHitter;
        hit.vx *= 1 - lossHit; hit.vy *= 1 - lossHit;
        // a solid hit unsettles the car that's hit
        const side = Math.sign((hit.x - hitter.x) * -Math.sin(hit.a) + (hit.y - hitter.y) * Math.cos(hit.a)) || 1;
        hit.w += side * Math.min(1.2, impact * 6);
      }
    }
  }
}

/** Starting grid, two columns behind the start line. */
/** A player's car: the autopilot steers it, but never touches its pedals. */
export function playerSlot(i) { const c = gridSlot(i); c.human = true; return c; }

export function gridSlot(i) {
  const row = Math.floor(i / 2), side = i % 2 ? 1 : -1;
  const p = pointAt(TRACK.length - 70 - row * 75);
  return createCar(p.x + p.nx * side * 38, p.y + p.ny * side * 38, p.a);
}

export function newRace() {
  return { nextCp: 0, laps: 0, lapStart: -1, lastLap: 0, bestLap: 0 };
}

/**
 * Checkpoints must be hit in order, so cutting the track never counts.
 * Times are in ticks. Returns { time, best } when a lap completes.
 */
export function updateRace(r, s, tick) {
  const idx = Math.floor((s / TRACK.length) * CHECKPOINTS) % CHECKPOINTS;
  if (idx !== r.nextCp) return null;
  r.nextCp = (idx + 1) % CHECKPOINTS;
  if (idx !== 0) return null;
  let ev = null;
  if (r.lapStart >= 0) {
    const t = tick - r.lapStart;
    r.laps++;
    r.lastLap = t;
    const best = !r.bestLap || t < r.bestLap;
    if (best) r.bestLap = t;
    ev = { time: t, best };
  }
  r.lapStart = tick;
  return ev;
}

/**
 * Bots get the same autopilot as players and only decide gas or brake,
 * by comparing their speed with the safe speed a little way ahead.
 * Lower skill = more cautious.
 */
export function makeBot(i) {
  return {
    skill: 0.86 + ((i * 7) % 5) * 0.025,
    // how error-prone this bot is: chance of a mistake at each corner
    sloppy: 0.28 + ((i * 3) % 4) * 0.05,
    seed: (i * 2654435761) >>> 0,
    apex: -1,          // the corner we last rolled the dice for
    mistake: null,     // { kind, factor, until (line index), exitT }
  };
}

// small seeded RNG so each bot's mistakes are repeatable (same on every run)
function rand(ai) {
  ai.seed = (ai.seed + 0x6d2b79f5) >>> 0;
  let t = ai.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Next corner apex ahead of line index i, and how many samples away it is. */
function nextApex(i) {
  const n = LINE.n;
  let best = -1, bestD = n;
  for (const a of LINE.apexes) { const d = (a - i + n) % n; if (d > 0 && d < bestD) { best = a; bestD = d; } }
  return { a: best, d: bestD };
}

/**
 * Human-style mistakes. Approaching each corner the bot may:
 *  - brake too late: carries too much speed in, slides wide, maybe onto the grass;
 *  - brake too early / too much: loses time through the corner;
 *  - get back on the gas late on the way out.
 * Returns a speed multiplier for this tick (1 = no mistake).
 */
function mistakeFactor(ai, car, q, speed) {
  const n = LINE.n;
  const { a, d } = nextApex(q.i);
  if (a >= 0 && a !== ai.apex && d < 48) {          // ~48 samples (~1200 px) before the corner, ahead of the braking zone: decide
    ai.apex = a;
    const r = rand(ai);
    const sloppy = Math.min(0.95, ai.sloppy * BOTS.mistakes);
    if (ai.mistake && ai.mistake.kind === 'wide' && car.miss) return 1;   // still catching the last one
    ai.mistake = null;
    // missed apex: turns in badly and sweeps wide through the corner, door open on the inside
    if (r < sloppy * 0.45) ai.mistake = { kind: 'wide', factor: 1.04 + 0.06 * rand(ai), until: (a + 10) % n,
      from: (a - 10 + n) % n, push: -Math.sign(LINE.off[a]) * (45 + 45 * rand(ai)) };
    else if (r < sloppy * 0.75) ai.mistake = { kind: 'early', factor: 0.7 + 0.1 * rand(ai), until: (a + 4) % n };
    else if (r < sloppy) ai.mistake = { kind: 'exit', factor: 1, until: (a + 2) % n, exitT: 0.5 + 0.8 * rand(ai) };
  }
  const m = ai.mistake;
  if (!m) { if (car.miss) car.miss *= 0.97; return 1; }
  // still before the end of the mistake zone?
  const left = (m.until - q.i + n) % n;
  if (m.kind === 'wide') {
    // ease the steering error in from turn-in, worst around the apex, then catch it.
    // The aim may only drift across the road at a gentle angle, so it never swerves.
    const into = (q.i - m.from + n) % n;
    const span = (m.until - m.from + n) % n;
    // builds over the turn-in, holds through the apex, released on the exit
    const want = left > 0 && left < 60 && into <= span ? m.push * Math.min(1, into / 5, (span - into) / 7) : 0;
    const rate = Math.max(1, speed) * 0.32 / 60;          // ≤ ~18° of drift across the road
    car.miss += Math.max(-rate, Math.min(rate, want - car.miss));
    const active = into <= span;                                   // in the corner
    const approaching = !active && (m.from - q.i + n) % n < 60;    // still on the way to it
    if (!active && !approaching && Math.abs(car.miss) < 0.5) { car.miss = 0; ai.mistake = null; }
    return want === 0 ? 1 : m.factor;
  }
  if (left > 0 && left < 60) return m.kind === 'exit' ? 1 : m.factor;
  if (m.kind === 'exit' && m.exitT > 0) { m.exitT -= 1 / 60; return 0.55; }   // dawdles on the way out
  ai.mistake = null;
  return 1;
}

export function botInput(ai, car, others = []) {
  // Stuck nose-in against another car? Back up for a moment, then pull out again.
  if (ai.backT > 0) { ai.backT -= 1 / 60; return { throttle: 0, brake: 1, handbrake: false }; }
  if (car.rev) return { throttle: 1, brake: false, handbrake: false };   // otherwise bots never mean to reverse: back into drive
  const fx = Math.cos(car.a), fy = Math.sin(car.a);
  // crawling (not just stopped) with a car right in front of our nose counts as stuck
  const crawl = Math.max(4 * SPEED, 0.2 * safeSpeed(queryTrack(car.x, car.y, car.qi ?? -1).i));
  const blocked = Math.hypot(car.vx, car.vy) < crawl && others.some((o) => {
    if (o === car) return false;
    const dx = o.x - car.x, dy = o.y - car.y, d = Math.hypot(dx, dy);
    return d < CAR.radius * 2 + 10 && (dx * fx + dy * fy) > 0.5 * d;       // right in front of our nose
  });
  ai.stuckT = blocked ? (ai.stuckT || 0) + 1 / 60 : 0;
  if (ai.stuckT > 1) { ai.stuckT = 0; ai.backT = 1.1; }
  // Last resort: no progress at all for 3 s, whatever the reason (two cars tangled
  // nose to nose in a big field, say): back up and try again.
  ai.stallT = Math.hypot(car.vx, car.vy) < crawl && !car.spin ? (ai.stallT || 0) + 1 / 60 : 0;
  if (ai.stallT > 3) { ai.stallT = 0; ai.backT = 1.1; }
  const q = queryTrack(car.x, car.y, car.qi ?? -1);
  const speed = Math.hypot(car.vx, car.vy);
  // look ahead by the distance covered in ~0.4 s, to cover pedal lag
  const ahead = linePointAhead(q, speed * 0.4).i;
  let target = Math.min(safeSpeed(q.i), safeSpeed(ahead)) * ai.skill * (ai.sloppy ? BOTS.skill : 1);
  if (car.spin) return { throttle: 0, brake: 0.4, handbrake: false };          // ride the spin out
  if (car.uturn) target = Math.min(target, 0.25 * safeSpeed(q.i));            // turn round gently
  target *= ai.sloppy ? mistakeFactor(ai, car, q, speed) : 1;
  // off the racing line with a corner coming: ease off a touch (the line there isn't the fast one)
  if (car.lane > 0.05) {
    // Off the racing line, the bend is tighter on the inside (and a bit wider on the
    // outside): take the speed from the radius we'll actually drive, v ∝ √radius.
    let f = 1;
    for (let d = 0; d <= 300; d += 30) {
      const i = linePointAhead(q, d).i, R = LINE.radius[i];
      if (R > 900) continue;
      const shift = (car.rel ? car.laneAbs : car.laneAbs - LINE.off[i]) * car.lane;
      // moving toward the inside of the bend makes it tighter, toward the outside wider
      const inward = shift * BEND_SIDE[i];
      f = Math.min(f, Math.sqrt(Math.max(0.25, (R - inward) / R)));
    }
    target *= f * (1 - 0.04 * car.lane);       // and a small margin while side by side
  }
  // stuck behind someone with no way past: don't drive into them
  let heldByStopped = false;
  if (car.pass < 0) {
    const lat = lateral(car, q);
    for (const o of others) {
      if (o === car) continue;
      // (o.qi: where that car was last step, so this searches nearby, not the whole track;
      // with 20 cars, full searches here were ~100,000 checks per step)
      const oq = queryTrack(o.x, o.y, o.qi ?? -1), gap = wrapS(oq.s - q.s);
      if (gap > 0 && gap < 80 && Math.abs(lateral(o, oq) - lat) < CAR.radius * 2 + 4) {
        // Following a moving car: match its speed. Behind a stopped one, wait (the
        // overtaking logic usually finds a way round), but not for ever: after 2 s creep
        // forward, so the nose-in check above backs us out and round it. Without that,
        // cars tangled in the run-off in big fields could wait for each other for good.
        const ov = Math.hypot(o.vx, o.vy);
        if (ov < crawl) heldByStopped = true;
        target = Math.min(target, ov < crawl && ai.heldT > 2 ? 12 * SPEED : ov * 0.95);
      }
    }
  }
  ai.heldT = heldByStopped && speed < crawl ? (ai.heldT || 0) + 1 / 60 : 0;
  return {
    // full gas below target; a trickle of gas just above it so lifting doesn't brake.
    // Sliding: feather the gas so the tyres can bite again.
    // Feed the gas in: full only well below the target, easing off as we reach it
    // (flooring it in a low gear out of a corner would break traction).
    throttle: car.sliding ? Math.min(0.3, speed < target ? 1 : 0.25)
      : speed < target ? Math.max(0.3, Math.min(1, (target - speed) / (0.12 * target + 1e-6))) : speed < target * 1.05 ? 0.25 : 0,
    brake: speed > target + 6 * SPEED,
    handbrake: false,
  };
}
