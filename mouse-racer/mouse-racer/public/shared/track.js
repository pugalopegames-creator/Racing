// Track geometry: a closed Catmull-Rom spline through control points,
// sampled into segments. Road = centerline ± ROAD_HALF, grass runoff out to WALL.

export const ROAD_HALF = 90;   // asphalt half-width
export const WALL = 170;       // barrier distance from centerline

// Clockwise loop (screen coords, y down). Keep non-adjacent parts > 2*WALL apart.
const CONTROL = [
  [0, 0], [900, 0], [1500, -100], [1900, 200], [1900, 700],
  [1550, 950], [1150, 800], [800, 1050], [900, 1500], [500, 1750],
  [-200, 1650], [-500, 1200], [-300, 800], [-600, 400], [-400, 0],
];

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const f = (a, b, c, d) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

function buildTrack(ctrl, samples = 20) {
  const n = ctrl.length;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i], p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
    for (let k = 0; k < samples; k++) pts.push(catmull(p0, p1, p2, p3, k / samples));
  }
  const segs = [];
  let s = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    segs.push({ ax: a[0], ay: a[1], dx: dx / len, dy: dy / len, len, s0: s });
    s += len;
    minX = Math.min(minX, a[0]); minY = Math.min(minY, a[1]);
    maxX = Math.max(maxX, a[0]); maxY = Math.max(maxY, a[1]);
  }
  return { pts, segs, length: s, bounds: { minX, minY, maxX, maxY } };
}

export const TRACK = buildTrack(CONTROL);

/**
 * Nearest point on the centerline. Returns distance, arc-length s, and outward normal.
 * hint: the segment index found last time; only nearby segments are searched then,
 * which gives the same answer anywhere near the road at a fraction of the cost.
 */
const NEAR = 16;
export function queryTrack(x, y, hint = -1) {
  if (hint >= 0) {
    const q = scan(x, y, hint - NEAR, hint + NEAR);
    if (q.dist < WALL + 40) return q;
  }
  return scan(x, y, 0, TRACK.segs.length - 1);
}

function scan(x, y, from, to) {
  let best = Infinity, bs = TRACK.segs[0], bt = 0, bi = 0;
  const segs = TRACK.segs, n = segs.length;
  for (let k = from; k <= to; k++) {
    const i = ((k % n) + n) % n;
    const g = segs[i];
    let t = (x - g.ax) * g.dx + (y - g.ay) * g.dy;
    t = t < 0 ? 0 : t > g.len ? g.len : t;
    const px = g.ax + g.dx * t, py = g.ay + g.dy * t;
    const d2 = (x - px) * (x - px) + (y - py) * (y - py);
    if (d2 < best || (d2 === best && i < bi)) { best = d2; bs = g; bt = t; bi = i; }   // same tie-break in any search window
  }
  const px = bs.ax + bs.dx * bt, py = bs.ay + bs.dy * bt;
  const dist = Math.sqrt(best);
  const nx = dist > 1e-6 ? (x - px) / dist : -bs.dy;
  const ny = dist > 1e-6 ? (y - py) / dist : bs.dx;
  return { dist, s: bs.s0 + bt, px, py, nx, ny, i: bi, t: bt / bs.len };
}

/** Point on the centerline at arc length s (wraps). a = heading, (nx,ny) = left-hand normal. */
export function pointAt(s) {
  const L = TRACK.length;
  s = ((s % L) + L) % L;
  const segs = TRACK.segs;
  // binary search on s0
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].s0 <= s) lo = mid; else hi = mid - 1;
  }
  const g = segs[lo];
  const t = s - g.s0;
  return { x: g.ax + g.dx * t, y: g.ay + g.dy * t, a: Math.atan2(g.dy, g.dx), nx: -g.dy, ny: g.dx };
}

// ---------------------------------------------------------------- racing line
// Minimum-curvature line within the road: wide on entry, clips the apex,
// wide on exit. Computed once from the centerline; identical on every machine.
export const LINE_MARGIN = 16;   // keep the line this far inside the road edge (car half-width is 12)
const APEX_MARGIN = 24;          // at the apex: car's inside wheels ~20 px from the kerb (faster than hugging it on these S-bends)
const APEX_MAX_RADIUS = 450;     // bends tighter than this get an apex
const APEX_SPAN = 2;             // samples either side of the apex that stay on the inside
const APEX_BAND = 0.08;          // how far off the kerb the line may float there (fraction)

function buildRacingLine(iterations = 2500) {
  const pts = TRACK.pts, n = pts.length;
  const nx = new Float64Array(n), ny = new Float64Array(n), off = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
    nx[i] = -dy / l; ny[i] = dx / l;
  }
  const lim = ROAD_HALF - LINE_MARGIN;
  const X = (i) => pts[(i + n) % n][0] + nx[(i + n) % n] * off[(i + n) % n];
  const Y = (i) => pts[(i + n) % n][1] + ny[(i + n) % n] * off[(i + n) % n];
  const relax = (i, tx, ty, w) => {
    const o = (tx - pts[i][0]) * nx[i] + (ty - pts[i][1]) * ny[i];
    off[i] = Math.max(-lim, Math.min(lim, off[i] + (o - off[i]) * w));
  };
  // Minimise curvature coarse-to-fine: solve on every 12th point, then 6th,
  // 3rd and finally all of them. Each level starts from the previous answer,
  // so it converges in a fraction of a second instead of minutes.
  for (const k of [12, 6, 3, 1]) {
    if (n % k) continue;
    for (let it = 0; it < iterations; it++) {
      for (let i = 0; i < n; i += k) {
        relax(i,
          (4 * (X(i - k) + X(i + k)) - (X(i - 2 * k) + X(i + 2 * k))) / 6,
          (4 * (Y(i - k) + Y(i + k)) - (Y(i - 2 * k) + Y(i + 2 * k))) / 6, 0.6);
      }
    }
    // fill in the points between solved ones for the next, finer level
    for (let i = 0; i < n; i += k) {
      const j = (i + k) % n;
      for (let m = 1; m < k; m++) off[(i + m) % n] = off[i] + (off[j] - off[i]) * (m / k);
    }
  }
  // Then clip every apex: find the corners on the centreline (tightest point of each
  // bend), pin the line to the inside kerb there, and re-smooth everything else
  // around those pins. That gives the classic outside → apex → outside shape
  // instead of a compromise down the middle through the S-bends.
  const cr = new Float64Array(n), turn = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 3 + n) % n], b = pts[i], c = pts[(i + 3) % n];
    const abx = b[0] - a[0], aby = b[1] - a[1], bcx = c[0] - b[0], bcy = c[1] - b[1];
    const cross = abx * bcy - aby * bcx;
    const la = Math.hypot(abx, aby), lb = Math.hypot(bcx, bcy), lc = Math.hypot(c[0] - a[0], c[1] - a[1]);
    cr[i] = Math.abs(cross) < 1e-9 ? 1e9 : (la * lb * lc) / (2 * Math.abs(cross));
    turn[i] = Math.sign(cross);          // +1: bends toward +normal (left), -1: right
  }
  const apexLim = ROAD_HALF - APEX_MARGIN;
  const pinned = new Map();
  for (let i = 0; i < n; i++) {
    if (cr[i] > APEX_MAX_RADIUS) continue;
    let isMin = true;
    for (let d = -6; d <= 6 && isMin; d++) if (d && cr[(i + d + n) % n] < cr[i]) isMin = false;
    if (isMin) pinned.set(i, turn[i] * apexLim);
  }
  // Around each apex the line must stay in a band against the inside kerb, but it may
  // float within the band, so the corner stays a smooth arc rather than a kink.
  const band = new Map();      // index -> [min, max] offset allowed
  for (const [i, o] of pinned) {
    const sd = Math.sign(o);
    for (let d = -APEX_SPAN; d <= APEX_SPAN; d++) {
      const j = (i + d + n) % n;
      const depth = apexLim * (1 - APEX_BAND * (1 + Math.abs(d) / APEX_SPAN));   // tightest right at the apex
      band.set(j, sd > 0 ? [depth, apexLim] : [-apexLim, -depth]);
    }
  }
  for (const [j, [lo, hi]] of band) off[j] = Math.max(lo, Math.min(hi, off[j]));
  for (let it = 0; it < iterations * 2; it++) {
    for (let i = 0; i < n; i++) {
      relax(i,
        (4 * (X(i - 1) + X(i + 1)) - (X(i - 2) + X(i + 2))) / 6,
        (4 * (Y(i - 1) + Y(i + 1)) - (Y(i - 2) + Y(i + 2))) / 6, 0.6);
      const b = band.get(i);
      if (b) off[i] = Math.max(b[0], Math.min(b[1], off[i]));
    }
  }

  const x = new Float64Array(n), y = new Float64Array(n), ds = new Float64Array(n), radius = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = X(i); y[i] = Y(i); }
  for (let i = 0; i < n; i++) ds[i] = Math.hypot(x[(i + 1) % n] - x[i], y[(i + 1) % n] - y[i]);
  for (let i = 0; i < n; i++) {
    // radius through points two samples either side (Menger curvature)
    const a = (i - 2 + n) % n, c = (i + 2) % n;
    const abx = x[i] - x[a], aby = y[i] - y[a], acx = x[c] - x[a], acy = y[c] - y[a];
    const cross = Math.abs(abx * acy - aby * acx);
    const la = Math.hypot(abx, aby), lb = Math.hypot(x[c] - x[i], y[c] - y[i]), lc = Math.hypot(acx, acy);
    radius[i] = cross < 1e-9 ? 1e9 : (la * lb * lc) / (2 * cross);
  }
  return { n, x, y, off, ds, radius, nx, ny, apexes: [...pinned.keys()] };
}

export const LINE = buildRacingLine();
