// -----------------------------------------------------------------------------
// defs.js — the armory.
//
// Muzzle energy is derived, not authored: E = 1/2 m v^2 with real slug masses
// and velocities. The penetration solver then spends that energy against
// material resistance in joules per metre, so terminal behaviour falls out of
// the numbers instead of from hand-tuned damage values. A railgun cores a hull
// because 10 MJ genuinely buys a lot of metres of plate, not because it has
// "damage: 90" written next to it.
//
// How a weapon fares against shields is derived too, and from one physical
// quantity: `dwell`, the time over which the round delivers its energy. Divide
// energy by dwell and you have the instantaneous power the target's emitters
// have to channel, which is what decides how much of the hit the field catches
// (see `damageShield` in systems.js). For a projectile, dwell is simply the
// time it takes to cross the field — FIELD_DEPTH / muzzle velocity — so a
// hypervelocity slug arrives as a spike no emitter can follow and a beam
// arrives as a trickle any emitter can absorb. There is no "shield damage
// multiplier" anywhere in this file; the roster's whole rock-paper-scissors
// falls out of mass and velocity.
// -----------------------------------------------------------------------------

/**
 * Depth of a capital shield field in metres. Only used to turn a projectile's
 * velocity into the time it spends inside the field, and thence the
 * instantaneous power the emitters have to channel.
 */
export const FIELD_DEPTH = 6.0;

function ke(massKg, velMs) {
  return 0.5 * massKg * velMs * velMs;
}

export const WEAPONS = {
  // --- energy --------------------------------------------------------------
  beam: {
    id: 'beam',
    name: 'BEAM LANCE',
    cls: 'ENERGY / CONTINUOUS',
    kind: 'beam',
    range: 7600,
    dps: 1.2e7,              // joules per second delivered on target
    ap: 0.6,
    // Continuous: one tick's worth of energy arrives over one tick. Nothing
    // couples into a shield more comfortably than that.
    dwell: 1 / 60,
    heat: 620,               // per second, and it will cook its own mount
    draw: 30,                // MW while firing
    ammo: 0,
    tracer: 0xff5a8c,
    width: 0.6,
    role: 'SHIELD BREAKER',
    desc: 'Melts a facet faster than anything else and pours heat into whatever '
      + 'compartment it opens. Cooks its own mount if you hold the trigger.',
  },
  pulse: {
    id: 'pulse',
    name: 'PULSE BATTERY',
    cls: 'ENERGY / REPEATER',
    kind: 'projectile',
    rpm: 110,
    mass: 0,                 // massless bolt; energy is authored directly
    energy: 6.0e6,
    muzzleVel: 2200,
    drag: 0,
    ap: 0.75,
    // A coherent pulse has real length; the field has all of it to work with.
    dwell: 0.020,
    dump: 0,
    heat: 55,
    draw: 1.6,               // MJ per shot from the capacitor
    ammo: 0,
    spread: 0.0016,
    tracer: 0x76e0ff,
    width: 0.4,
    life: 4.5,
    role: 'SUSTAINED / ANTI-SHIELD',
    desc: 'Cheap, fast, and nearly useless against a belt. Burns a facet down '
      + 'so something heavier can get through the hole.',
  },
  ion: {
    id: 'ion',
    name: 'ION PROJECTOR',
    cls: 'ELECTROMAGNETIC / PULSE',
    kind: 'projectile',
    rpm: 12,
    mass: 0,
    energy: 6.0e7,
    muzzleVel: 1400,
    drag: 0,
    ap: 0,                   // does not penetrate anything: it induces
    dump: 0,
    heat: 380,
    draw: 42,
    ammo: 0,
    spread: 0.003,
    tracer: 0xbb7cff,
    width: 1.1,
    life: 7.0,
    special: 'ion',
    role: 'SHIELD / POWER KILL',
    desc: 'Collapses facets outright and chews every power run it can induce '
      + 'into. Cannot scratch structure — it disables by starving.',
  },

  // --- kinetic -------------------------------------------------------------
  repeater: {
    id: 'repeater',
    name: 'REPEATER',
    cls: 'KINETIC / POINT DEFENCE',
    kind: 'projectile',
    rpm: 400,
    mass: 1.2,
    muzzleVel: 1600,
    drag: 1.4e-5,
    ap: 1.0,
    dump: 0,
    heat: 22,
    draw: 0.3,
    ammo: 1,
    spread: 0.006,
    tracer: 0xffcf7a,
    width: 0.3,
    life: 6.0,
    role: 'EXTERNALS / ORDNANCE',
    desc: 'Will not reach anything vital through a belt. Shreds radiators, '
      + 'sensor masts, turret housings and incoming torpedoes.',
  },
  railgun: {
    id: 'railgun',
    name: 'MASS DRIVER',
    cls: 'KINETIC / RAILGUN',
    kind: 'projectile',
    rpm: 20,
    mass: 12,
    muzzleVel: 2600,
    drag: 2.0e-6,
    ap: 0.55,                // dense, streamlined, very cheap through plate
    dump: 0,
    heat: 320,
    draw: 18,
    ammo: 3,
    spread: 0.0007,
    tracer: 0xd8f0ff,
    width: 0.7,
    life: 6.0,
    trail: true,
    role: 'PENETRATOR',
    desc: 'Forty megajoules of tungsten. Goes in at the bow and comes out of '
      + 'engineering, taking a line of compartments with it and leaving every '
      + 'one of them open to space.',
  },
  plasma: {
    id: 'plasma',
    name: 'PLASMA ACCELERATOR',
    cls: 'THERMAL / SLUG',
    kind: 'projectile',
    rpm: 26,
    mass: 40,
    muzzleVel: 1000,
    drag: 4.0e-5,
    ap: 1.35,                // a blob of plasma is a poor penetrator
    // A diffuse bolt washes over the field rather than punching through it.
    dwell: 0.006,
    // Comes apart in the first thing it reaches and dumps most of its budget
    // there rather than carrying on: one compartment, gutted.
    dump: 0.60,
    splash: { radius: 60, energy: 9.0e6 },
    heat: 460,
    draw: 26,
    ammo: 0,
    spread: 0.005,
    tracer: 0x7dffc4,
    width: 1.4,
    life: 8.5,
    special: 'plasma',
    role: 'COMPARTMENT KILL',
    desc: 'Slow enough to lead badly and slow enough to see coming. Whatever '
      + 'it does reach it guts, and it sets the compartment on fire.',
  },

  // --- ordnance ------------------------------------------------------------
  torpedo: {
    id: 'torpedo',
    name: 'TORPEDO TUBES',
    cls: 'ORDNANCE / HOMING',
    kind: 'missile',
    rpm: 12,
    mass: 4000,
    muzzleVel: 120,
    accel: 210,
    // Motor burn-out. A seeker is only as good as the turn it can still make at
    // speed, so this is the number that decides whether the tubes are a threat
    // or a firework — not `accel`.
    topSpeed: 620,
    turnRate: 0.55,
    fuse: 42.0,
    ap: 1.1,
    blast: { radius: 180, energy: 4.5e8, shrapnel: 24, shrapnelEnergy: 8.0e6 },
    heat: 60,
    draw: 1.0,
    ammo: 1,
    tracer: 0xffa04a,
    width: 0.9,
    role: 'AREA / SUBSYSTEM',
    desc: 'Tracks the locked subsystem rather than the ship. Slow, obvious, '
      + 'and it opens three compartments at once when it connects.',
  },
};

// Derive kinetic energy for everything that has a mass, so the tables above can
// stay in units a person can sanity-check.
for (const w of Object.values(WEAPONS)) {
  if (w.mass > 0 && w.muzzleVel) {
    w.energy = ke(w.mass, w.muzzleVel);
  }
  w.interval = w.rpm ? 60 / w.rpm : 0;
  if (w.dwell === undefined) {
    // A solid projectile deposits its energy over the time it takes to cross
    // the field. Everything else declares its own coupling time below.
    w.dwell = w.muzzleVel ? FIELD_DEPTH / w.muzzleVel : 1e-3;
  }
}

// ---------------------------------------------------------------------------
// Ammunition
// ---------------------------------------------------------------------------
// Every magazine-fed mount aboard a ship draws the same nature of round, and
// the choice matters more than the gun does. All three modify the SAME
// projectile — the solver does not special-case them, it just reads different
// numbers and a fuse rule:
//
//   `ap`     multiplies the cost of every layer. Below 1 is a better
//            penetrator; above 1 is a worse one.
//   `burst`  'none'   the round is spent by material and stops where it stops.
//            'surface' it detonates on the first thing it touches.
//            'delay'  it detonates after crossing `fuseWalls` compartment
//                     walls, i.e. once it is properly inside.
//   `dump`   fraction of the remaining budget deposited in the first module
//            reached, for rounds that come apart rather than pass through.
//   `dwellMult` scales how long the round takes to give up its energy, which is
//            what decides how much of it a shield can catch. A solid penetrator
//            is the shortest event a field ever has to deal with; a shell that
//            functions on contact spreads the same joules over far longer and
//            is correspondingly easier to absorb.
//
// The consequence that makes the choice interesting is perforation: a round
// that fully crosses a wall punches a hole in it whatever the plate's remaining
// health, and that compartment is then open to vacuum until somebody welds it
// shut. So solid shot does not merely do less immediate damage than HE — it
// leaves a line of decompressed compartments and severed runs across the ship,
// and the crew have to walk through that to fix anything.
// ---------------------------------------------------------------------------
export const AMMO = {
  ap: {
    id: 'ap',
    name: 'SOLID SHOT',
    short: 'AP',
    ap: 0.55,
    dwellMult: 1.0,         // the sharpest event a shield can be asked to catch
    burst: 'none',
    dump: 0,
    // Square metres of hull opened per perforation. A dense unfused
    // penetrator bores a clean half-metre hole and makes many of them.
    holeSize: 0.55,
    heat: 1.0,
    tracer: 0xd8f0ff,
    role: 'PERFORATES',
    desc: 'Goes in one side and, often enough, out the other. Cuts a line '
      + 'through every compartment, conduit and pipe on its path and leaves '
      + 'each one open to space. Does the least damage where it lands and the '
      + 'most damage to the ship as a system.',
  },
  he: {
    id: 'he',
    name: 'HIGH EXPLOSIVE',
    short: 'HE',
    ap: 2.8,                // a thin-walled shell is a very poor penetrator
    dwellMult: 9.0,         // a chemical burn is slow next to a hypervelocity impact
    burst: 'surface',
    dump: 0,
    holeSize: 0.20,
    splash: { radius: 16, energy: 1.5e6 },
    heat: 1.3,
    tracer: 0xffb060,
    role: 'STRIPS PLATE',
    desc: 'Detonates on contact. Will not reach anything vital through armour, '
      + 'but tears plate off, wrecks radiators, sensor masts and turrets, and '
      + 'is the fastest way to open a compartment from outside.',
  },
  sap: {
    id: 'sap',
    name: 'DELAY FUSED',
    short: 'SAP',
    ap: 1.0,
    dwellMult: 3.0,
    burst: 'delay',
    fuseWalls: 2,           // through the outer wall and one bulkhead
    dump: 0.35,
    holeSize: 0.40,
    splash: { radius: 11, energy: 1.1e6 },
    heat: 1.15,
    tracer: 0xff8ab0,
    role: 'DETONATES INSIDE',
    desc: 'Bores through the outer plating and lets go one compartment in. '
      + 'Worse than solid shot at reaching the far side and far better at '
      + 'gutting whatever is on the near side of the ship.',
  },
};

export const AMMO_IDS = Object.keys(AMMO);

/** Mount sizes gate what can be bolted where, and scale the mount's own heat. */
export const MOUNTS = { small: 0.7, medium: 1.0, large: 1.45 };

export { ke };
