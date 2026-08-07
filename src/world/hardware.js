// -----------------------------------------------------------------------------
// hardware.js — turning the modelled kit into things bolted to a ship.
//
// Two jobs. It decodes `kit.js` into shared BufferGeometry (once per part, for
// the whole game — a hundred turrets are a hundred draw calls over twenty-one
// geometries), and it works out how a weapon actually SITS on a hull:
//
//   * which face of its compartment the mount is bolted to,
//   * which way is up for the barbette ring,
//   * how far out to stand it so it rests on the plating rather than inside it,
//   * and the yaw/pitch pair that makes the barrel point where the gunnery
//     model says it is pointing.
//
// Nothing here decides where a shot goes. The simulation owns `mount.aim`; this
// file's contract is that the visible barrel agrees with it, which is why the
// muzzle is derived from the same vector rather than animated independently.
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { PARTS, MUZZLES, PIVOTS, SKIN } from './kit.js';

/** Compartment style -> shell part. Anything unrecognised gets the plain hull. */
const SHELL = {
  hull: 'shell_hull',
  prow: 'shell_prow',
  engine: 'shell_engine',
  wing: 'shell_wing',
  canopy: 'shell_canopy',
};

/**
 * Where the shell's plating is on one face, as a fraction of the compartment's
 * half-extent, at a given distance `z` down the compartment.
 *
 * Anything that needs to touch the visible hull — a mount standing on it, a
 * scorch mark landing on it, a module fitting inside it, the cutaway drawing
 * it — goes through this, because the only thing the simulation ever computes
 * is a hit on the box, and the shell is inscribed in that box and tapers.
 *
 * `SKIN` is measured off the built shells by the exporter, so it cannot drift
 * from the models the way a hand-kept copy of the tapers did.
 */
export function skinFraction(style, axis, sign, z, halfZ) {
  if (axis === 2 || !(halfZ > 0)) {
    return 1;
  }
  const band = (SKIN[style] || SKIN.hull)[axis === 0 ? 'x' : 'y'][sign < 0 ? 0 : 1];
  const t = Math.min(1, Math.max(0, z / (2 * halfZ) + 0.5));
  return band[0] + (band[1] - band[0]) * t;
}

/**
 * How far a mount at `pos` has to move along `axis` to rest on the plating.
 * Negative pulls it inward, which is the correct answer when the hull table
 * put the gun outside the shell's tapered profile in the first place.
 */
function skinOffset(style, axis, pos, half) {
  if (axis === 2) {
    return Math.max(0, half[axis] - Math.abs(pos[axis]));
  }
  const sign = pos[axis] < 0 ? -1 : 1;
  return half[axis] * skinFraction(style, axis, sign, pos[2], half[2])
    - Math.abs(pos[axis]);
}

const _geo = new Map();

function bytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    u8[i] = bin.charCodeAt(i);
  }
  return u8;
}

/**
 * One shared geometry per named part. Never disposed — a ship being destroyed
 * must not take the turret geometry every other ship is drawing with it.
 */
export function partGeometry(name) {
  let g = _geo.get(name);
  if (g !== undefined) {
    return g;
  }
  const p = PARTS[name];
  if (!p) {
    _geo.set(name, null);
    return null;
  }
  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array(bytes(p.pos).buffer, 0, p.v * 3), 3));
  // Normals ship as signed bytes and are normalised by the vertex fetch. A
  // 1/127 quantum is far finer than a shaded pixel resolves and it is a quarter
  // of the bytes.
  g.setAttribute('normal', new THREE.BufferAttribute(
    new Int8Array(bytes(p.nrm).buffer, 0, p.v * 3), 3, true));
  g.setIndex(new THREE.BufferAttribute(
    new Uint16Array(bytes(p.idx).buffer, 0, p.t * 3), 1));
  g.computeBoundingSphere();
  _geo.set(name, g);
  return g;
}

export function shellGeometry(style) {
  return partGeometry(SHELL[style] || SHELL.hull);
}

export const SHELL_STYLES = Object.keys(SHELL);

/**
 * How a weapon is carried. Derived rather than authored, because the hull
 * tables already say it: a mount with a real traverse is a turret, one with a
 * few degrees of play is a ball in a socket, and ordnance comes out of tubes
 * that do not move at all.
 */
export function mountStyle(weapon, arc) {
  if (weapon.kind === 'missile') {
    return 'fixed';
  }
  return arc >= 0.25 ? 'turret' : 'gimbal';
}

/**
 * The frame a mount stands in, in compartment-local coordinates.
 *
 * Picking the face is the whole problem. Proximity alone gets it wrong: the
 * broadside batteries sit near the forward end of their compartments, so the
 * nearest face is the bow face, and a turret bolted there would have its
 * training axis pointing straight down its own barrels — the yaw angle becomes
 * undefined and the guns stand vertically out of the ring.
 *
 * So a face is scored on proximity AND on being square to the gun's rest
 * bearing, and a face within 15 degrees of the bearing is not a candidate at
 * all. That puts the batteries on the deck they are obviously meant to be on,
 * leaves the ventral tubes ventral, and still lets a pod-nose gimbal sit on the
 * side of its pod, which is the one case where proximity should win.
 *
 * Returns the outward normal, the rest bearing flattened into the surface, and
 * how far the mount has to be pushed out to rest ON the plating.
 */
export function mountFrame(pos, half, dirArr, style) {
  const dir = new THREE.Vector3(dirArr[0], dirArr[1], dirArr[2]);
  if (dir.lengthSq() < 1e-9) {
    dir.set(0, 0, 1);
  }
  dir.normalize();

  let bestAxis = -1;
  let bestScore = -1;
  for (let i = 0; i < 3; i++) {
    const square = 1 - Math.abs(dir.getComponent(i));
    if (square < 0.25) {
      continue;
    }
    const near = half[i] > 0 ? Math.min(1, Math.abs(pos[i]) / half[i]) : 0;
    const score = (0.2 + near) * square;
    if (score > bestScore) {
      bestScore = score;
      bestAxis = i;
    }
  }
  const sign = pos[bestAxis] < 0 ? -1 : 1;
  const up = new THREE.Vector3();
  up.setComponent(bestAxis, sign);
  // The 0.25 filter above bounds |dir.up| at 0.75, so this can never degenerate.
  const fwd = dir.clone().addScaledVector(up, -dir.dot(up)).normalize();
  const right = up.clone().cross(fwd).normalize();
  const quat = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(right, up, fwd));
  return {
    up,
    fwd,
    quat,
    /** Signed distance from the authored position out to the shell's skin. */
    lift: skinOffset(style, bestAxis, pos, half),
  };
}

/**
 * Assemble one weapon. The hierarchy is the machine:
 *
 *     root   bolted to the hull, oriented by `mountFrame`
 *      +- base      the barbette ring or socket, never moves
 *      +- yaw       trains about the hull normal
 *          +- yoke      the rotating house or the ball
 *          +- pitch     elevates about the trunnions
 *              +- gun       the weapon, recoiling in Z
 */
export function buildMount(assets, tint, weapon, style, scale) {
  const root = new THREE.Group();
  const attach = (parent, part) => {
    const geo = partGeometry(part);
    if (!geo) {
      return null;
    }
    const mesh = new THREE.Mesh(geo, assets.kitMaterial(PARTS[part].mat, tint, weapon));
    mesh.userData.part = part;
    parent.add(mesh);
    return mesh;
  };

  attach(root, `base_${style}`);
  const yaw = new THREE.Group();
  root.add(yaw);
  if (style !== 'fixed') {
    attach(yaw, `yoke_${style}`);
  }
  const pitch = new THREE.Group();
  pitch.position.y = PIVOTS[style];
  yaw.add(pitch);
  const gun = new THREE.Group();
  pitch.add(gun);
  attach(gun, `gun_${weapon.id}`);
  const glow = attach(gun, `gun_${weapon.id}_glow`);
  root.scale.setScalar(scale);

  return {
    root,
    yaw,
    pitch,
    gun,
    glow,
    /** Fixed installations have no moving parts; do not waste the trig. */
    slews: style !== 'fixed',
    pivot: PIVOTS[style],
    muzzles: MUZZLES[weapon.id] || [[0, 0, 2]],
  };
}
