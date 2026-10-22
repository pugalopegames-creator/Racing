// Shared car physics. Runs identically on the server (authority) and the
// client (prediction), so it must be pure: state in, state out, fixed dt.

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

// Overall pace, changeable at runtime with setSpeed(). 1 = original prototype.
// Speeds and forward forces scale with SPEED; tyre grip scales with SPEED²
// so corners keep the same shape (you still understeer if you come in hot).
export const SPEED_MIN = 0.1, SPEED_MAX = 1, SPEED_DEFAULT = 1;
export let SPEED = SPEED_DEFAULT;

// Values at SPEED = 1; setSpeed() derives the live CAR values from these.
export const BASE = {
  engine: 145, maxSpeed: 690, reverseEngine: 260, maxReverse: 200,
  brake: 320,            // full brakes stop from top speed in ~1.8 s, not instantly
  engineBrake: 40,       // lifting off the gas slows you a little
  handbrakeDecel: 150, rolling: 25, grip: 800,
  // chassis response also scales with pace, so a corner taken too fast runs
  // just as wide at 20% as at 100% (pedals stay real-time on purpose)
  steerSpeed: 3.5, yawResponse: 10,
};

// All distances in world pixels, times in seconds.
export const CAR = {
  length: 46,
  width: 24,
  radius: 19,           // collision circle
  wheelBase: 30,

  // Steering: the front wheels turn toward the mouse
  maxSteer: 0.6,        // rad, max front-wheel angle
  steerSpeed: 0,        // rad/s, how fast the steering rack can turn (set by setSpeed)
  steerGain: 2.0,       // steering per rad of heading error
  deadZone: 30,         // mouse on top of the car: hold the wheel where it is

  // Pedals don't jump to full; your foot takes a moment
  gasRise: 1.25,        // 1/s → hold W ~0.8 s for full gas; tap it for a little
  brakeRise: 2.5,       // 1/s → full brake pressure in 0.4 s
  pedalFall: 8,         // releasing is quicker than pressing
  rearLoose: 1.5,       // oversteer: how readily the tail keeps stepping out once sliding
  liftOversteer: 0.6,   // lifting off mid-slide counts this much toward a loose rear
  spinAngle: 1.05,      // rad of slide (~60°) past which the car is spinning and steering can't catch it
  spinEnd: 0.35,        // ...until the slide is back under ~20° (or the car has stopped)
  spinDamp: 1.2,        // how quickly a spin's rotation dies away
  loadSlip: 0.3,        // sideways slip from cornering load (weight pushing the car wide)
  loadSlipFrom: 0.25,   // ...starts at this fraction of the grip limit, grows with the square beyond it
  tractionShare: 0.75,  // friction circle: at full brake/1st-gear gas only half the cornering grip is left
  wheelTorque: 0.95,    // how much of the grip budget full gas in 1st gear uses
  liftBrake: 0.15,      // letting go of the gas: a gentle lift-off slowdown, mostly coasting (S brakes fully)

  // Longitudinal (filled in by setSpeed)
  engine: 0, maxSpeed: 0, reverseEngine: 0, maxReverse: 0,
  brake: 0, engineBrake: 0, handbrakeDecel: 0, rolling: 0,
  drag: 0.06,           // air drag, proportional to speed (low, so the car coasts)

  // Tyres
  grip: 0,              // max lateral accel the tyres can deliver
  handbrakeGrip: 0.3,   // lateral grip multiplier with handbrake on
  yawOverGrip: 1.45,     // at the limit the car may rotate this much faster than grip can turn its path
  slideStart: 0.075,    // rad of slip angle where the tyres let go (~4°)
  slideEnd: 0.035,      // rad where they bite again (~2°)
  slideGrip: 0.64,      // grip while sliding, vs rolling
  powerSlide: 0.3,      // full gas while sliding takes this much more grip away
  handbrakeYaw: 1.8,    // how much harder you can rotate with handbrake
  yawResponse: 0,       // 1/s, how fast yaw rate follows the steering (set by setSpeed)
};

// Automatic 5-speed gearbox. top = where the gear hits the rev limiter, as a
// fraction of maxSpeed; pull = how hard it drives. Low gears pull hard but run out
// of revs quickly; each upshift pauses the drive briefly, so speed builds in steps.
export const GEARS = [
  { top: 0.27, pull: 1.55 },
  { top: 0.43, pull: 1.22 },
  { top: 0.59, pull: 0.98 },
  { top: 0.75, pull: 0.8 },
  { top: 0.9, pull: 0.66 },
];
const REVERSE_HOLD = 0.35;      // s of S at a standstill before reverse engages
const SHIFT_TIME = 0.22;        // s with no drive while the gearbox changes up
const UPSHIFT_RPM = 0.97;       // change up near the limiter
const DOWNSHIFT_RPM = 0.7;      // change down once the lower gear would be below this

/** Engine speed 0..1 (1 = rev limiter) in the current gear. */
export const rpmOf = (c) => Math.max(0, (c.vx * Math.cos(c.a) + c.vy * Math.sin(c.a)) / (CAR.maxSpeed * GEARS[c.gear || 0].top));

export const SURFACES = {
  road:  { grip: 1,    engine: 1,   drag: 1, top: 1 },
  grass: { grip: 0.55, engine: 0.55, drag: 8, top: 1 },   // top speed on grass ~27% of the road's
};

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export const lerp = (a, b, t) => a + (b - a) * t;
export const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;

export function createCar(x, y, a) {
  // gas / brk are pedal positions 0..1; rev = in reverse gear
  // lane: 0 = on the racing line, 1 = on the overtaking line at laneAbs (offset from centre)
  return { x, y, a, vx: 0, vy: 0, w: 0, steer: 0, slip: 0, gas: 0, brk: 0, rev: false, lane: 0, laneAbs: 0, pass: -1, passSide: 1, cap: -1, yieldTo: -1, gear: 0, shiftT: 0, sliding: false, spin: false, spun: false, uturn: 0, revHold: 0, miss: 0, rel: 0, passY: 0 };
  // yieldTo: id of a car passing alongside us; we hold our line and leave them room
  // cap: speed limit while held up behind a car we can't pass yet (-1 = none)
}

const approach = (v, target, rise, fall, dt) =>
  target > v ? Math.min(target, v + rise * dt) : Math.max(target, v - fall * dt);

/**
 * Advance one car by dt.
 * inp: { tx, ty, throttle, brake, handbrake }
 *   tx/ty     world point under the mouse: where the front wheels point
 *   throttle  W held (true) or a pedal level 0..1 to hold the gas there
 *   brake     S held: full brakes while moving forward, reverse gear once stopped
 *   Letting go of the gas (throttle false / 0) brakes at liftBrake.
 */
export function stepCar(c, inp, surface = SURFACES.road, dt = DT) {
  const P = CAR;
  const fx = Math.cos(c.a), fy = Math.sin(c.a);
  const rx = -fy, ry = fx;
  let vF = c.vx * fx + c.vy * fy;   // forward speed
  let vR = c.vx * rx + c.vy * ry;   // sideways (slide) speed

  // ---- 1. Gear: S at a standstill selects reverse, W at a standstill selects drive ----
  const stopped = Math.abs(vF) < 4 * SPEED;
  // reverse needs S held at a standstill for a moment, so a brief brake never selects it
  c.revHold = stopped && inp.brake && !inp.throttle ? (c.revHold || 0) + dt : 0;
  if (c.revHold > REVERSE_HOLD) c.rev = true;
  if (stopped && inp.throttle && !inp.brake) c.rev = false;
  // In reverse the roles swap: S is the gas, W is the brake.
  const gasKey = c.rev ? inp.brake : inp.throttle;
  const brakeKey = c.rev ? inp.throttle : inp.brake;
  c.gas = approach(c.gas, +gasKey || 0, P.gasRise, P.pedalFall, dt);
  const lifted = !(+gasKey > 0) && !stopped;     // foot off the gas while rolling
  // brake: true = full pedal, or a level 0..1 to hold the pedal there (used for previews)
  c.brk = approach(c.brk, brakeKey ? +brakeKey : lifted ? P.liftBrake : 0, P.brakeRise, P.pedalFall, dt);

  // ---- 2. Steering toward the mouse ----
  const dx = inp.tx - c.x, dy = inp.ty - c.y;
  const err = wrapAngle(Math.atan2(dy, dx) - c.a);
  let steerTarget;
  if (inp.steerLock) {
    steerTarget = inp.steerLock * P.maxSteer;                // turning round after a spin: full lock
  } else if (Math.hypot(dx, dy) < P.deadZone) {
    steerTarget = c.steer;                                   // hold the wheel
  } else if (vF < -2 * SPEED && Math.abs(err) > Math.PI / 2) {
    // Backing up toward a point behind you: swing the rear at it, like looking over your shoulder.
    steerTarget = -clamp(wrapAngle(err + Math.PI) * P.steerGain, -1, 1) * P.maxSteer;
  } else {
    steerTarget = clamp(err * P.steerGain, -1, 1) * P.maxSteer;
  }
  c.steer += clamp(steerTarget - c.steer, -P.steerSpeed * dt, P.steerSpeed * dt);

  // ---- 3. Longitudinal forces ----
  if (c.rev) {
    c.gear = 0;
    if (vF > -P.maxReverse) vF -= c.gas * P.reverseEngine * surface.engine * dt;
  } else {
    // gearbox: change up at the limiter (with a short pause), down when slowing
    const g = GEARS[c.gear];
    let rpm = vF / (P.maxSpeed * g.top);
    if (c.shiftT > 0) c.shiftT -= dt;
    else if (rpm > UPSHIFT_RPM && c.gas > 0.05 && c.gear < GEARS.length - 1) { c.gear++; c.shiftT = SHIFT_TIME; }
    if (c.gear > 0 && vF < P.maxSpeed * GEARS[c.gear - 1].top * DOWNSHIFT_RPM) { c.gear--; c.shiftT = 0; }
    rpm = vF / (P.maxSpeed * GEARS[c.gear].top);
    // torque: strongest mid-range, cut at the limiter
    const torque = rpm >= 1 ? 0 : 0.75 + 0.35 * Math.sin(Math.PI * Math.max(0, rpm));
    if (c.shiftT <= 0) vF += c.gas * P.engine * GEARS[c.gear].pull * torque * surface.engine * dt;
  }
  // Brakes and resistances only ever slow the car toward zero, never push it backwards.
  let decel = c.brk * P.brake + P.rolling + (1 - c.gas) * P.engineBrake;
  if (inp.handbrake) decel += P.handbrakeDecel;
  vF -= Math.sign(vF) * Math.min(Math.abs(vF), decel * dt);
  vF -= vF * P.drag * surface.drag * dt;

  // ---- 4. Grip budget and slide state ----
  const hb = !!inp.handbrake;
  // Friction circle: a tyre has one budget of grip. Braking hard, or full gas in a
  // low gear (lots of torque at the wheels), uses most of it, so less is left for
  // turning. Floor it out of a slow corner and the car runs wide; feed the gas in.
  const gasUse = c.rev ? 0 : c.gas * (GEARS[c.gear || 0].pull / GEARS[0].pull) * Math.sqrt(TUNE.engine) * P.wheelTorque;
  const use = Math.min(1, Math.max(c.brk, gasUse));
  const gripBase = P.grip * surface.grip * Math.sqrt(Math.max(0.2, 1 - P.tractionShare * use * use));
  // Load slip: the harder the corner leans on the tyres, the more they let the car
  // slide sideways while still gripping, so the weight carries it wide. Grows with
  // speed², long before the tyres let go completely.
  const load = Math.abs(vF * c.w) / Math.max(gripBase, 1e-6);     // 1 = at the grip limit
  const loadSlip = -Math.sign(c.w) * Math.abs(vF) * P.loadSlip * Math.max(0, load - P.loadSlipFrom) ** 2;
  // the slide only "breaks away" past what load slip already explains
  const slipAngle = Math.atan2(Math.abs(vR - loadSlip), Math.max(Math.abs(vF), 1));
  if (!c.sliding && slipAngle > P.slideStart) c.sliding = true;
  else if (c.sliding && slipAngle < P.slideEnd) c.sliding = false;
  // sliding tyres grip less, and power on spins them up and lets the slide run on
  const kinetic = c.sliding ? P.slideGrip * (1 - P.powerSlide * c.gas) : 1;
  const grip = gripBase * kinetic * (hb ? P.handbrakeGrip : 1);

  // ---- 5. Yaw: kinematic turn rate, limited by the tyres. At the limit the car can
  // rotate a little faster than its grip can turn the direction of travel, so a
  // slide builds up instead of the car simply turning less. ----
  let wTarget = (vF * Math.tan(c.steer)) / P.wheelBase;
  const wMax = (gripBase * P.yawOverGrip * (hb ? P.handbrakeYaw : 1)) / Math.max(Math.abs(vF), 1);
  wTarget = clamp(wTarget, -wMax, wMax);
  // Breakaway slip angle (signed): + = the car is sliding toward its own left.
  const beta = Math.atan2(vR - loadSlip, Math.max(Math.abs(vF), 1));
  const speed = Math.hypot(vF, vR);
  // Spinning: the slide has gone past what steering can catch.
  if (!c.spin && Math.abs(beta) > P.spinAngle && speed > 15 * SPEED) c.spin = true;
  else if (c.spin && (Math.abs(beta) < P.spinEnd || speed < 6 * SPEED)) c.spin = false;
  // Once the tyres let go the steering has less say over where the nose points.
  const authority = c.spin ? 0.06 : c.sliding ? 0.45 : 1;
  c.w += (wTarget - c.w) * Math.min(1, P.yawResponse * authority * dt);
  if (c.sliding) {
    // Oversteer: the tail keeps stepping out the way it's already going. Braking,
    // lifting off or flooring it mid-slide takes weight off the rear and makes it worse.
    const lifted = c.gas < 0.1 && !stopped ? P.liftOversteer : 0;
    const loose = P.rearLoose * (0.35 + 0.65 * Math.max(c.brk, gasUse, lifted));
    // (× SPEED: rotation builds on the same time scale as the rest of the chassis at any pace)
    c.w += -Math.sin(beta) * loose * SPEED * (speed / P.wheelBase) * dt;
  }
  if (c.spin) c.w *= 1 - P.spinDamp * SPEED * dt;            // a spinning car slowly stops rotating
  c.spun = c.spin || (speed > 10 * SPEED && Math.abs(beta) > Math.PI / 2);

  // ---- 6. Lateral: tyres pull the direction of travel round, up to their grip.
  // Whatever they can't cancel carries on as a drift outward. ----
  // (they pull it back toward the load slip, not all the way to zero)
  c.slip = Math.abs(vR);
  vR -= clamp(vR - loadSlip, -grip * dt, grip * dt);

  // ---- 7. Integrate ----
  c.vx = fx * vF + rx * vR;
  c.vy = fy * vF + ry * vR;
  c.x += c.vx * dt;
  c.y += c.vy * dt;
  c.a = wrapAngle(c.a + c.w * dt);
}

/** Change the pace for everyone using this module (server: whole room). */
export function setSpeed(v) {
  SPEED = clamp(Number(v) || SPEED_DEFAULT, SPEED_MIN, SPEED_MAX);
  for (const k in BASE) CAR[k] = BASE[k] * SPEED;
  CAR.grip = BASE.grip * TUNE.grip * SPEED * SPEED;
  CAR.engine = BASE.engine * TUNE.engine * SPEED;
  return SPEED;
}

// Difficulty knobs that change the car itself (room-wide in multiplayer, like pace).
// 1 = the normal tuning. Use applyTuning() in world.js so the speed profile follows.
export const TUNE = { grip: 1, engine: 1 };
export const TUNE_LIMITS = { grip: [0.7, 1.3], engine: [0.5, 2] };
export function setTuning(t) {
  for (const k in TUNE_LIMITS) {
    if (t && Number.isFinite(+t[k])) TUNE[k] = clamp(+t[k], TUNE_LIMITS[k][0], TUNE_LIMITS[k][1]);
  }
  setSpeed(SPEED);
  return { ...TUNE };
}
setSpeed(SPEED_DEFAULT);
