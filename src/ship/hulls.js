// -----------------------------------------------------------------------------
// hulls.js — pure data describing every ship class.
//
// These are capital ships: 95 to 380 metres, four thousand to a hundred and
// sixty thousand tonnes, crews in the hundreds. They turn in degrees per second
// rather than radians, they fight at two to eight kilometres, and an engagement
// takes minutes rather than seconds. That pace is the point — it is what makes
// it possible to WATCH damage propagate through a ship's systems instead of
// merely surviving it.
//
// Four layers, outermost first:
//   SHIELD    an ellipsoid bubble split into six facets
//   SECTIONS  pressurised compartments: hull plate + structural frame + volume
//   MODULES   the functional kit living inside each compartment
//   NETWORKS  power / data / coolant graphs wired through conduit modules
//
// Coordinates: a ship faces +Z, +Y is dorsal, and +X is PORT — the frame is
// right-handed, and a right-handed frame whose +Z is forward has its +X on the
// left-hand side. Sections are authored as axis-aligned boxes in that frame;
// they are the visible hull, the ballistic target, the crew's compartments and
// the atmosphere volumes all at once, so what you can see is exactly what you
// can shoot and what the damage-control parties have to walk through.
//
// Everything here is inert data. `compile()` at the bottom derives mass, centre
// of mass, the inertia tensor, the control torque and the engine thrust from
// the section boxes, indexes the graphs, and validates that every conduit
// endpoint and declared dependency exists — a typo in this file is a thrown
// error at load, not a silent dead network at minute nine of a fight.
// -----------------------------------------------------------------------------
// The one thing the tables reach outward for: where a compartment's plating
// actually is, so a module can be seated inside the shell rather than merely
// inside the box. See `seatModules`. The kit is consulted for the same reason
// the shells are: a turret is part of the ship's extent now, and the shield
// has to be derived from what is actually bolted on rather than from the
// compartment boxes alone.
import { skinFraction, mountFrame, mountStyle } from '../world/hardware.js';
import { MUZZLES, PIVOTS } from '../world/kit.js';
import { WEAPONS, MOUNTS } from '../weapons/defs.js';

/**
 * Material response used by the penetration solver (joules absorbed / metre).
 * These are properties of the material, so they do NOT change with ship size —
 * a capital ship is hard to penetrate because its belt is most of a metre
 * thick, not because its steel is different from a picket's.
 */
export const MATERIALS = {
  armorHeavy:  { resist: 9.0e6, name: 'LAMINATE BELT' },
  armorMedium: { resist: 5.2e6, name: 'ABLATIVE PLATE' },
  armorLight:  { resist: 2.4e6, name: 'HULL SKIN' },
  bulkhead:    { resist: 3.0e6, name: 'BULKHEAD' },
  frame:       { resist: 1.6e6, name: 'FRAME' },
  module:      { resist: 6.5e5, name: 'CASING' },
  soft:        { resist: 1.4e5, name: 'CONDUIT' },
  rock:        { resist: 1.2e7, name: 'CHONDRITE' },
};

/** The three utility networks. Order is the order they are solved in. */
export const NETS = ['power', 'data', 'coolant'];

/** Diagnostic groupings, in display order. */
export const SYSTEM_ORDER = [
  'POWER', 'PROPULSION', 'COMPUTE', 'DEFENCE', 'ORDNANCE', 'THERMAL', 'LIFE', 'LOGISTICS',
];

/** Shield facet keys, in the order the schematic draws them. */
export const FACETS = ['fore', 'aft', 'port', 'stbd', 'dorsal', 'ventral'];

/**
 * The band these ships are designed to fight in, metres. Every other range in
 * the project is expressed against this rather than hardcoded, so the whole
 * game can be re-pitched by moving one number: sensor reach, radar scale, AI
 * standoff, projectile flight time, audio falloff and the camera's depth range
 * all follow it. Getting that wrong is how you end up with an AI that holds
 * station politely at 5 km with its guns switched off.
 */
export const ENGAGEMENT_RANGE = 5200;

import { HULL_SPECS, HOIST_FILL_SECONDS } from './hull-data.js';
export { HOIST_FILL_SECONDS };

// ---------------------------------------------------------------------------
// compile — derive everything that can be derived, then validate.
// ---------------------------------------------------------------------------

/**
 * Mass and the (diagonal) inertia tensor come from the section boxes and their
 * declared densities via the parallel axis theorem, so a long hull genuinely is
 * harder to yaw than to roll and nobody has to hand-author a plausible number.
 */
function deriveMassProperties(spec) {
  let mass = 0;
  const com = [0, 0, 0];
  for (const s of spec.sections) {
    const m = 8 * s.half[0] * s.half[1] * s.half[2] * s.density;
    s.mass = m;
    mass += m;
    for (let i = 0; i < 3; i++) {
      com[i] += s.pos[i] * m;
    }
  }
  for (let i = 0; i < 3; i++) {
    com[i] /= mass;
  }

  const I = [0, 0, 0];
  for (const s of spec.sections) {
    const [a, b, c] = s.half;
    const dx = s.pos[0] - com[0];
    const dy = s.pos[1] - com[1];
    const dz = s.pos[2] - com[2];
    // Solid box about its own centre: Ix = m/3 * (b^2 + c^2).
    I[0] += s.mass * ((b * b + c * c) / 3 + dy * dy + dz * dz);
    I[1] += s.mass * ((a * a + c * c) / 3 + dx * dx + dz * dz);
    I[2] += s.mass * ((a * a + b * b) / 3 + dx * dx + dy * dy);
  }
  return { mass, com, inertia: I };
}

/** Bounding radius for broadphase and for the radar blip scale. */
/**
 * Semi-axes of the shield ellipsoid, DERIVED from the compartment boxes the way
 * the control torque is derived from the inertia tensor.
 *
 * Authoring these by hand is how the first pass went wrong, and it went wrong
 * silently: every hull's bow, stern and drive bay stood proud of its own bubble
 * — ten of the MERIDIAN's fourteen compartments were outside it, including the
 * drive bay at 1.47x and the reactor room at 1.16x. A shot along the axis
 * therefore met plate before it ever met the field, which made the shield a
 * waist-band rather than a bubble, made head-on and stern attacks bypass it
 * entirely, and left the drives — the most exposed structure on every hull —
 * permanently unprotected. Since losing the drives is most of what ends a ship,
 * that one geometry error decided nearly every engagement in the game.
 *
 * `fit` is the uniform scale that pulls the furthest CORNER onto the surface.
 * Matching the per-axis extents alone is not enough: an ellipsoid whose
 * semi-axes equal a box's half-extents does not contain that box's corners.
 *
 * The compartment boxes are no longer the whole ship. Every hardpoint now
 * carries modelled hardware that stands ON the plating and swings a barrel
 * around above it, and on the HALBERD the dorsal driver's muzzle came out two
 * per cent OUTSIDE the bubble derived from the boxes alone — a turret sitting
 * beyond its own ship's field, which the ray test would happily let a round
 * reach without ever touching the shield. So the guns are enclosed too.
 */
const SHIELD_MARGIN = 1.04;

/**
 * How big a hull's guns are relative to the kit's `medium` fitting. Derived
 * here rather than in the renderer because the shield extent depends on it:
 * a dreadnought's main battery is a genuinely bigger machine than a picket's.
 * Clamped at both ends — unclamped, the SABRE wears jewellery and the BASTION
 * wears buildings. This is the knob to turn if the guns read wrong in flight.
 */
function gunScaleFor(radius) {
  return Math.min(3.0, Math.max(0.85, radius / 60));
}

/**
 * Every hardpoint as the volume its hardware actually sweeps.
 *
 * The trunnion is seated on the plating by the same `mountFrame` the renderer
 * uses, and the muzzle sits `reach` metres from it somewhere in the cone the
 * mount can traverse. Bounding that cone rather than the whole sphere around
 * the trunnion is what keeps this honest: the MERIDIAN's mass driver is a
 * twenty-seven metre machine on a hull twenty-eight metres tall, so treating
 * it as free to point anywhere trebles the ship's dorsal shield radius to
 * enclose a barrel that can only ever be within seventeen degrees of the bow.
 */
function hardwareVolumes(spec, gunScale) {
  const out = [];
  for (const m of spec.modules) {
    const w = m.kind === 'hardpoint' ? WEAPONS[m.weapon] : null;
    if (!w) {
      continue;
    }
    const s = byIdOf(spec, m.section);
    const frame = mountFrame(m.pos, s.half, m.dir, s.style);
    const scale = (MOUNTS[m.mount] || 1) * gunScale;
    // By ART, not by weapon id: a gun borrowing another fitting's model has
    // that model's barrels, and looking up the wrong key silently falls back to
    // a two-metre stub — which would leave real barrels sticking out of the
    // ship's own shield.
    const barrel = Math.max(...(MUZZLES[w.art || m.weapon] || [[0, 0, 2]])
      .map((q) => Math.hypot(q[0], q[1], q[2])));
    const reach = (PIVOTS[mountStyle(w, m.arc)] + barrel) * scale;
    const len = Math.hypot(m.dir[0], m.dir[1], m.dir[2]) || 1;
    const pos = [0, 0, 0];
    const half = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const rest = m.dir[k] / len;
      // Closest the muzzle can come to each axis: rotate the rest bearing
      // toward it by the whole traverse, and no further.
      const hi = Math.cos(Math.max(0, Math.acos(Math.min(1, Math.max(-1, rest))) - m.arc));
      const lo = -Math.cos(Math.max(0, Math.acos(Math.min(1, Math.max(-1, -rest))) - m.arc));
      const seat = s.pos[k] + m.pos[k] + frame.up.getComponent(k) * frame.lift;
      pos[k] = seat + reach * (hi + lo) * 0.5;
      half[k] = reach * (hi - lo) * 0.5;
    }
    out.push({ pos, half });
  }
  return out;
}

function shieldRadii(spec, com, gunScale) {
  const vols = [...spec.sections, ...hardwareVolumes(spec, gunScale)];
  const ext = [0, 0, 0];
  for (const s of vols) {
    for (let k = 0; k < 3; k++) {
      ext[k] = Math.max(ext[k], Math.abs(s.pos[k] - com[k]) + s.half[k]);
    }
  }
  let fit = 1;
  for (const s of vols) {
    let q = 0;
    for (let k = 0; k < 3; k++) {
      const e = (Math.abs(s.pos[k] - com[k]) + s.half[k]) / ext[k];
      q += e * e;
    }
    fit = Math.max(fit, Math.sqrt(q));
  }
  return ext.map((v) => Math.round(v * fit * SHIELD_MARGIN));
}

/**
 * The bearing this hull actually fights on, in radians off the bow.
 *
 * Derived from where its guns can point, by sweeping the yaw plane and finding
 * the aspect that brings the most sustained output to bear. Zero for a
 * nose-fighter; about 70 degrees for a hull whose main battery lives on its
 * wings.
 *
 * This exists because the pilot needs it. Re-aiming the broadsides outboard
 * made two hulls that fight beam-on, and the AI still flew every ship straight
 * at whatever it was shooting — so a dreadnought carrying 76 MJ/s of broadside
 * presented its bow and brought 31, and lost to a cruiser it outguns because
 * neither of them was using the guns they had. Doctrine has to be a property of
 * the hull the pilot can read, not an assumption baked into the pilot.
 */
function fightAspect(spec) {
  const dpsOf = (w) => (w.kind === 'beam' ? w.dps : (w.energy * (w.rpm || 0)) / 60);
  const guns = spec.modules.filter((m) => m.kind === 'hardpoint'
    && WEAPONS[m.weapon] && !WEAPONS[m.weapon].pointDefence);
  const borneAt = (th) => {
    const ax = Math.sin(th);
    const az = Math.cos(th);
    let borne = 0;
    for (const m of guns) {
      const n = Math.hypot(m.dir[0], m.dir[1], m.dir[2]) || 1;
      const dot = (m.dir[0] / n) * ax + (m.dir[2] / n) * az;
      if (Math.acos(Math.min(1, Math.max(-1, dot))) <= m.arc + 1e-9) {
        borne += dpsOf(w2(m));
      }
    }
    return borne;
  };
  const w2 = (m) => WEAPONS[m.weapon];
  const STEP = (1 * Math.PI) / 180;
  const samples = [];
  for (let th = -Math.PI; th <= Math.PI + 1e-9; th += STEP) {
    samples.push({ th, v: borneAt(th) });
  }
  const best = samples.reduce((a, x) => Math.max(a, x.v), 0);
  if (best <= 0) {
    return 0;
  }
  // The MIDDLE of the widest band that carries the full weight, not the first
  // bearing that reaches it.
  //
  // Taking the first cost the cruiser its whole broadside. Its wings cover 23
  // to 117 degrees, so the sweep's earliest maximum is 24 — one degree inside
  // the arc limit — and a pilot told to hold 24 sits on the stop with the
  // guns falling out of train every time it overshoots. Measured mid-fight:
  // one of seven drivers bearing, 115 rounds fired, the enemy on 99% hull.
  // The centre of the band leaves forty degrees of margin either side.
  let bestRun = { from: 0, to: 0 };
  let runFrom = -1;
  for (let i = 0; i < samples.length; i++) {
    const full = samples[i].v >= best * 0.98;
    if (full && runFrom < 0) {
      runFrom = i;
    }
    if ((!full || i === samples.length - 1) && runFrom >= 0) {
      const to = full ? i : i - 1;
      if (to - runFrom > bestRun.to - bestRun.from) {
        bestRun = { from: runFrom, to };
      }
      runFrom = -1;
    }
  }
  return samples[Math.round((bestRun.from + bestRun.to) / 2)].th;
}

function boundingRadius(spec, com) {
  let r = 0;
  for (const s of spec.sections) {
    const d = Math.hypot(
      Math.abs(s.pos[0] - com[0]) + s.half[0],
      Math.abs(s.pos[1] - com[1]) + s.half[1],
      Math.abs(s.pos[2] - com[2]) + s.half[2],
    );
    r = Math.max(r, d);
  }
  return r;
}

function byIdOf(spec, id) {
  return spec.sections.find((s) => s.id === id);
}

/**
 * Fails loudly on a broken table. Every conduit endpoint must either be a
 * declared source (`src.<moduleId>`) or be produced by some other conduit, and
 * every `needs` entry must name a node the network can actually contain. A
 * dangling reference here would otherwise show up as a permanently dead
 * subsystem an hour into play, with no error anywhere.
 */
function validate(spec) {
  const ids = new Set();
  for (const m of spec.modules) {
    if (ids.has(m.id)) {
      throw new Error(`${spec.id}: duplicate module id "${m.id}"`);
    }
    ids.add(m.id);
  }
  const sections = new Set(spec.sections.map((s) => s.id));
  for (const s of spec.sections) {
    if (!Number.isFinite(s.volume) || s.volume <= 0) {
      throw new Error(spec.id + ': section "' + s.id + '" has invalid volume ' + s.volume);
    }
  }
  for (const m of spec.modules) {
    if (!sections.has(m.section)) {
      throw new Error(`${spec.id}: module "${m.id}" is in unknown section "${m.section}"`);
    }
  }
  for (const s of spec.sections) {
    for (const n of s.adj) {
      if (!sections.has(n)) {
        throw new Error(`${spec.id}: section "${s.id}" is adjacent to unknown "${n}"`);
      }
    }
  }

  // Node sets, per network.
  const nodes = {};
  for (const net of NETS) {
    nodes[net] = new Set();
  }
  for (const m of spec.modules) {
    if (m.kind !== 'conduit') {
      continue;
    }
    if (!NETS.includes(m.net)) {
      throw new Error(`${spec.id}: conduit "${m.id}" names unknown network "${m.net}"`);
    }
    if (m.from.startsWith('src.')) {
      const srcId = m.from.slice(4);
      if (!ids.has(srcId)) {
        throw new Error(`${spec.id}: conduit "${m.id}" sources from missing module "${srcId}"`);
      }
    }
    nodes[m.net].add(m.from);
    nodes[m.net].add(m.to);
  }
  for (const m of spec.modules) {
    if (m.needs) {
      for (const [net, node] of Object.entries(m.needs)) {
        if (!NETS.includes(net)) {
          throw new Error(`${spec.id}: module "${m.id}" needs unknown network "${net}"`);
        }
        if (!nodes[net].has(node)) {
          throw new Error(
            `${spec.id}: module "${m.id}" needs ${net} node "${node}", which no conduit produces`,
          );
        }
      }
    }
    if (m.feed && !ids.has(m.feed)) {
      throw new Error(`${spec.id}: hardpoint "${m.id}" feeds from missing magazine "${m.feed}"`);
    }
    if (m.fuel && !ids.has(m.fuel)) {
      throw new Error(`${spec.id}: thruster "${m.id}" draws from missing tank "${m.fuel}"`);
    }
    // `battery()` points every locker at 'mag_main' unless told otherwise, so a
    // hull that grows a battery without growing a main magazine would quietly
    // ship guns that fire forty-five seconds and never refill. Catch it here,
    // where a typo is a thrown error at load rather than a dry gun at minute
    // nine of a fight.
    if (m.deep && !ids.has(m.deep)) {
      throw new Error(`${spec.id}: locker "${m.id}" draws from missing magazine "${m.deep}"`);
    }
  }
  for (const c of spec.crew) {
    if (!sections.has(c.post)) {
      throw new Error(`${spec.id}: division "${c.id}" is posted to unknown section "${c.post}"`);
    }
    if (!(c.size > 0)) {
      throw new Error(`${spec.id}: division "${c.id}" has no hands`);
    }
  }

  // Compartments must not overlap. The penetration walk charges a wall on every
  // section boundary it crosses, so two boxes sharing a volume would silently
  // double-charge armour there. Touching faces are fine.
  for (let i = 0; i < spec.sections.length; i++) {
    for (let j = i + 1; j < spec.sections.length; j++) {
      const a = spec.sections[i];
      const b = spec.sections[j];
      let gap = false;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(a.pos[k] - b.pos[k]) >= a.half[k] + b.half[k] - 1e-3) {
          gap = true;
          break;
        }
      }
      if (!gap) {
        throw new Error(`${spec.id}: sections "${a.id}" and "${b.id}" overlap`);
      }
    }
  }

  // Internal modules must sit inside the compartment that owns them — and
  // inside the SHELL that compartment is drawn with, which is a tighter box
  // than the raycast volume because shells taper.
  //
  // This used to test the raycast volume with a metre and a half of slack, and
  // that was true enough when a hull was a row of boxes. It is not any more:
  // fifty-eight modules across the four hulls passed that test while sitting
  // outside the visible plating, radiators and magazines hanging out of the
  // sides of tapered sponsons and bow sensors floating clear of the wedge.
  //
  // They are authored to fit now, so this is strict. Failing at load is the
  // point: the alternative is quietly moving a magazine somewhere the author
  // did not put it, which changes what a shot into that sponson hits.
  //
  // Hardpoints are exempt from the extent test — a turret is meant to stand
  // proud of the hull, and `mountFrame` seats it on the plating deliberately —
  // but their mounting point still has to be on the ship.
  for (const m of spec.modules) {
    const s = byIdOf(spec, m.section);
    const gun = m.kind === 'hardpoint';
    const ext = gun ? [0, 0, 0] : (m.half || [m.r, m.r, m.r]);
    for (let k = 0; k < 3; k++) {
      // Fore and aft faces are not tapered; the lateral ones are, and the
      // shell is narrowest at one end of the module's own span.
      const skin = (k === 2 || gun) ? 1 : Math.min(
        skinFraction(s.style, k, m.pos[k] < 0 ? -1 : 1, m.pos[2] - ext[2], s.half[2]),
        skinFraction(s.style, k, m.pos[k] < 0 ? -1 : 1, m.pos[2] + ext[2], s.half[2]),
      );
      const limit = s.half[k] * skin;
      const over = Math.abs(m.pos[k]) + ext[k] - limit;
      if (over > 1e-6) {
        throw new Error(
          `${spec.id}: module "${m.id}" sticks ${over.toFixed(2)} m out of the `
          + `${s.style} shell of section "${s.id}" on axis ${k} `
          + `(reaches ${(Math.abs(m.pos[k]) + ext[k]).toFixed(2)}, `
          + `plating at ${limit.toFixed(2)})`,
        );
      }
    }
  }
  return nodes;
}

function compile(spec) {
  // Adjacency is authored one way and made symmetric here, so a table can never
  // describe a corridor that only opens from one end.
  const byId = {};
  for (const s of spec.sections) {
    byId[s.id] = s;
  }
  for (const s of spec.sections) {
    for (const n of s.adj) {
      const other = byId[n];
      if (other && !other.adj.includes(s.id)) {
        other.adj.push(s.id);
      }
    }
  }

  const nodes = validate(spec);
  // Author against the box, then sit inside the shell. Order matters: `validate`
  // holds the tables to the compartment they claim to be in, and only then does
  // anything get moved to match what is drawn.
  const { mass, com, inertia } = deriveMassProperties(spec);

  // The field has to actually enclose the ship — hardware included. Derived,
  // not authored — see `shieldRadii`.
  const radius = boundingRadius(spec, com);
  spec.gunScale = gunScaleFor(radius);
  spec.shield.radii = shieldRadii(spec, com, spec.gunScale);

  // Control authority is DERIVED, never authored. A table says how fast the
  // ship should turn (`pitchRate` etc.) and how long the thrusters should take
  // to get it there (`spool`); the torque required follows from the inertia
  // tensor, which itself came from the compartment boxes. Linear thrust follows
  // the same way from the mass and a target acceleration time.
  //
  // Authoring these by hand is how it went wrong the first time: the numbers
  // were plausible in isolation and implied a two-second spool, which reads to
  // a pilot as a ship that will not turn. Now resizing a compartment cannot
  // silently wreck the handling, because the authority moves with the mass.
  const f = spec.flight;
  const spool = f.spool || 3;
  f.torque = [
    (inertia[0] * f.pitchRate) / spool,
    (inertia[1] * f.yawRate) / spool,
    (inertia[2] * f.rollRate) / spool,
  ];
  f.mainThrust = (mass * f.maxSpeed) / f.accelTime;
  f.boostThrust = (mass * f.boostSpeed) / f.boostAccelTime;
  f.rcsThrust = f.mainThrust * 0.30;

  const modulesBySection = {};
  for (const s of spec.sections) {
    modulesBySection[s.id] = [];
  }
  for (const m of spec.modules) {
    modulesBySection[m.section].push(m);
  }

  return {
    ...spec,
    sectionById: byId,
    sectionIds: spec.sections.map((s) => s.id),
    modulesBySection,
    moduleById: Object.fromEntries(spec.modules.map((m) => [m.id, m])),
    hardpoints: spec.modules.filter((m) => m.kind === 'hardpoint'),
    conduits: spec.modules.filter((m) => m.kind === 'conduit'),
    nodes,
    mass,
    com,
    inertia,
    radius,
    crewTotal: spec.crew.reduce((a, c) => a + c.size, 0),
    /** Bearing this hull brings its weight to bear on. See `fightAspect`. */
    fightAspect: fightAspect(spec),
    /** Longest dimension, used for the radar blip and range read-outs. */
    length: 2 * Math.max(...spec.sections.map((s) => Math.abs(s.pos[2]) + s.half[2])),
  };
}

export const HULLS = {
  sabre: compile(HULL_SPECS.sabre),
  halberd: compile(HULL_SPECS.halberd),
  meridian: compile(HULL_SPECS.meridian),
  bastion: compile(HULL_SPECS.bastion),
};

export const HULL_IDS = Object.keys(HULLS);
