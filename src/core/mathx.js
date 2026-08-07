// -----------------------------------------------------------------------------
// mathx.js — small math toolbox shared by every subsystem.
// Deliberately dependency-light: only pulls THREE for quaternion/vector types.
// -----------------------------------------------------------------------------
import * as THREE from 'three';

export const DEG = Math.PI / 180;
export const EPS = 1e-9;

export function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

export function clamp01(v) {
  return clamp(v, 0, 1);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function invLerp(a, b, v) {
  return b - a < EPS ? 0 : clamp01((v - a) / (b - a));
}

export function smoothstep(a, b, v) {
  const t = invLerp(a, b, v);
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach. `rate` is per-second. */
export function damp(current, target, rate, dt) {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

/** Move `current` toward `target` at no more than `rate` units per second. */
export function approach(current, target, rate, dt) {
  const d = target - current;
  const step = rate * dt;
  if (Math.abs(d) <= step) {
    return target;
  }
  return current + Math.sign(d) * step;
}

export function rand(lo = 0, hi = 1) {
  return lo + Math.random() * (hi - lo);
}

export function randInt(lo, hi) {
  return Math.floor(rand(lo, hi + 1));
}

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Box-Muller normal sample. */
export function gaussian(mean = 0, sd = 1) {
  let u = 0;
  let v = 0;
  while (u === 0) {
    u = Math.random();
  }
  while (v === 0) {
    v = Math.random();
  }
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Uniform point on the unit sphere. */
export function randomDirection(out = new THREE.Vector3()) {
  const z = rand(-1, 1);
  const a = rand(0, Math.PI * 2);
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return out.set(r * Math.cos(a), r * Math.sin(a), z);
}

/** Random unit vector inside a cone of half-angle `spread` around `dir`. */
export function coneDirection(dir, spread, out = new THREE.Vector3()) {
  if (spread <= 0) {
    return out.copy(dir);
  }
  const t = _cone1;
  randomDirection(t);
  // Reject the degenerate parallel case, then build a perpendicular basis.
  if (Math.abs(t.dot(dir)) > 0.99) {
    t.set(dir.z, dir.x, dir.y);
  }
  const side = _cone2.crossVectors(dir, t).normalize();
  const up = _cone3.crossVectors(side, dir).normalize();
  const ang = spread * Math.sqrt(Math.random());
  const phi = rand(0, Math.PI * 2);
  return out
    .copy(dir)
    .multiplyScalar(Math.cos(ang))
    .addScaledVector(side, Math.sin(ang) * Math.cos(phi))
    .addScaledVector(up, Math.sin(ang) * Math.sin(phi))
    .normalize();
}

const _cone1 = new THREE.Vector3();
const _cone2 = new THREE.Vector3();
const _cone3 = new THREE.Vector3();

export function shortestAngle(a) {
  let x = (a + Math.PI) % (Math.PI * 2);
  if (x < 0) {
    x += Math.PI * 2;
  }
  return x - Math.PI;
}

/**
 * Convert a quaternion into a rotation vector (axis * angle) taking the
 * shortest arc. This is the error term for the attitude controller: an AI that
 * wants to point at a target builds the delta quaternion and feeds the rotation
 * vector straight into its rate command.
 */
export function quatToRotVec(q, out = new THREE.Vector3()) {
  let { x, y, z, w } = q;
  if (w < 0) {
    x = -x; y = -y; z = -z; w = -w;
  }
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s < 1e-7) {
    // Small-angle limit: angle ~= 2*sin(angle/2).
    return out.set(2 * x, 2 * y, 2 * z);
  }
  const angle = 2 * Math.atan2(s, w);
  const k = angle / s;
  return out.set(x * k, y * k, z * k);
}

// ---------------------------------------------------------------------------
// Ray primitives. All operate in the *local* frame of the shape (centred at the
// origin) so the caller transforms the ray once per ship and reuses it for the
// shield ellipsoid, every hull section and every internal module.
// ---------------------------------------------------------------------------

/** Axis index -> component name, for reading a direction component by axis. */
export const AXIS_KEY = ['x', 'y', 'z'];

/**
 * Slab test against an origin-centred box with half-extents `h`.
 * Returns null, or {t0, t1, axis0, axis1} where axisN is the index (0/1/2) of
 * the slab that produced that boundary — i.e. the face the ray entered and
 * exited through. The caller turns that into a surface normal, which is what
 * makes angle-of-attack penetration possible.
 */
export function rayBox(ox, oy, oz, dx, dy, dz, hx, hy, hz) {
  let t0 = -Infinity;
  let t1 = Infinity;
  let axis0 = 0;
  let axis1 = 0;

  let inv = 1 / (Math.abs(dx) < EPS ? (dx < 0 ? -EPS : EPS) : dx);
  let ta = (-hx - ox) * inv;
  let tb = (hx - ox) * inv;
  if (ta > tb) { const s = ta; ta = tb; tb = s; }
  if (ta > t0) { t0 = ta; axis0 = 0; }
  if (tb < t1) { t1 = tb; axis1 = 0; }
  if (t0 > t1) { return null; }

  inv = 1 / (Math.abs(dy) < EPS ? (dy < 0 ? -EPS : EPS) : dy);
  ta = (-hy - oy) * inv;
  tb = (hy - oy) * inv;
  if (ta > tb) { const s = ta; ta = tb; tb = s; }
  if (ta > t0) { t0 = ta; axis0 = 1; }
  if (tb < t1) { t1 = tb; axis1 = 1; }
  if (t0 > t1) { return null; }

  inv = 1 / (Math.abs(dz) < EPS ? (dz < 0 ? -EPS : EPS) : dz);
  ta = (-hz - oz) * inv;
  tb = (hz - oz) * inv;
  if (ta > tb) { const s = ta; ta = tb; tb = s; }
  if (ta > t0) { t0 = ta; axis0 = 2; }
  if (tb < t1) { t1 = tb; axis1 = 2; }
  if (t0 > t1) { return null; }

  return { t0, t1, axis0, axis1 };
}

/** Ray vs sphere centred at `c` with radius `r`. `d` must be unit length. */
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const mx = ox - cx;
  const my = oy - cy;
  const mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  const disc = b * b - c;
  if (disc < 0) {
    return null;
  }
  const s = Math.sqrt(disc);
  return { t0: -b - s, t1: -b + s };
}

/**
 * Ray vs an origin-centred axis-aligned ellipsoid with radii `r`. Solved by
 * squashing the ray into the sphere's frame, so it is the sphere test plus two
 * divisions — which is what lets the shield bubble hug an elongated hull
 * instead of hovering as a fat sphere around it.
 *
 * Note the direction is NOT unit length after squashing, so the quadratic is
 * solved in full rather than reusing the normalised form above.
 */
export function rayEllipsoid(ox, oy, oz, dx, dy, dz, rx, ry, rz) {
  const px = ox / rx;
  const py = oy / ry;
  const pz = oz / rz;
  const qx = dx / rx;
  const qy = dy / ry;
  const qz = dz / rz;
  const a = qx * qx + qy * qy + qz * qz;
  if (a < EPS) {
    return null;
  }
  const b = 2 * (px * qx + py * qy + pz * qz);
  const c = px * px + py * py + pz * pz - 1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) {
    return null;
  }
  const s = Math.sqrt(disc);
  return { t0: (-b - s) / (2 * a), t1: (-b + s) / (2 * a) };
}

/** Squared distance from point p to segment ab. */
export function pointSegmentDistSq(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const denom = abx * abx + aby * aby + abz * abz;
  let t = denom < EPS ? 0 : (apx * abx + apy * aby + apz * abz) / denom;
  t = clamp01(t);
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  const dz = apz - abz * t;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Time until a projectile of speed `speed` fired from the origin now can meet a
 * target currently at `relPos` moving at `relVel`. Returns the positive root of
 * |relPos + relVel*t| = speed*t, or null when the target simply outruns the
 * shot. This is the lead computer: the HUD pip and every AI trigger pull use it,
 * so both are wrong in exactly the same way when the target changes its mind.
 */
export function interceptTime(relPos, relVel, speed) {
  const a = relVel.lengthSq() - speed * speed;
  const b = 2 * relPos.dot(relVel);
  const c = relPos.lengthSq();
  if (Math.abs(a) < 1e-4) {
    // Closing speed matches muzzle speed: the quadratic degenerates to linear.
    return Math.abs(b) < EPS ? null : (-c / b > 0 ? -c / b : null);
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) {
    return null;
  }
  const s = Math.sqrt(disc);
  const t0 = (-b - s) / (2 * a);
  const t1 = (-b + s) / (2 * a);
  // Smallest strictly positive root — the first time the shot can arrive.
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  if (lo > 1e-4) {
    return lo;
  }
  if (hi > 1e-4) {
    return hi;
  }
  return null;
}

/** Clamp a vector's length in place. */
export function clampLength(v, maxLen) {
  const l = v.length();
  if (l > maxLen && l > EPS) {
    v.multiplyScalar(maxLen / l);
  }
  return v;
}

export function formatNumber(v, digits = 0) {
  return v.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Distances read as m up to a kilometre and km beyond it, like a real MFD. */
export function formatRange(m) {
  if (m < 1000) {
    return `${Math.round(m)} m`;
  }
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}
