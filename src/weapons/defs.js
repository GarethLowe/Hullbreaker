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
    rpm: 520,
    mass: 1.4,
    muzzleVel: 1900,
    drag: 1.4e-5,
    ap: 1.0,
    dump: 0,
    heat: 16,
    draw: 0.3,
    ammo: 1,
    spread: 0.005,
    tracer: 0xffcf7a,
    width: 0.3,
    life: 6.0,
    /**
     * Lays itself.
     *
     * A point-defence mount is not a gun a crew trains on a ship — it is a
     * director and a fast tracker whose entire job is killing things that are
     * already on their way, and it has to react quicker than any trigger a
     * person is holding. So these mounts leave the player's and the AI's fire
     * groups altogether and engage on their own.
     *
     * Two ranges, because a director does two different jobs:
     *
     *   `pdRange`      inbound ordnance. Always the priority and always first,
     *                  and deliberately SHORTER than the ships band. The gun
     *                  throws a 5 mrad cone: at three kilometres that is
     *                  fifteen metres of scatter, which is a hit on a hull and
     *                  a waste of a magazine against a three-metre warhead. A
     *                  director holds its fire until the solution is worth the
     *                  ammunition.
     *
     *   `pdShipRange`  hulls. Inside three kilometres a director can hold a
     *                  ship perfectly well, and a battery that sits idle while
     *                  a picket knife-fights the hull it is bolted to is a
     *                  battery nobody would fit. It will not reach anything
     *                  vital through a belt — that is not what it is for. It
     *                  strips radiators, sensor masts, gun houses and any
     *                  compartment already open, and it does it continuously
     *                  and without being asked.
     *
     * Ordnance always wins the argument: a mount tracking a hull drops it the
     * instant a warhead comes inside its arc.
     *
     * What this fit is worth, measured: a HALBERD with all eight directors
     * intact shot down seventy seekers and nine torpedoes for nothing through —
     * a complete ring beats ordnance, full stop, and the answer to one is to
     * break it. With its directors wrecked the same frigate took every torpedo
     * fired at it, lost half its plate and had eight compartments open. A
     * BASTION leaks about half the seekers thrown at it even with all twelve
     * mounts up, because a three-hundred-metre hull cannot bring three rings to
     * bear on one bearing. Shoot the directors first; that is the doctrine, and
     * the cutaway will show you where they are.
     */
    pointDefence: true,
    pdRange: 2200,
    pdShipRange: 3000,
    role: 'AUTONOMOUS / CLOSE DEFENCE',
    desc: 'Lays itself. Shreds inbound ordnance out to three and a half '
      + 'kilometres, and holds any hull that comes inside three, without ever '
      + 'being asked and without touching a trigger group.',
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
  autocannon: {
    id: 'autocannon',
    name: 'REPEATING DRIVER',
    cls: 'KINETIC / RAPID FIRE',
    kind: 'projectile',
    /**
     * Borrows the three-barrel pulse model. Nothing else in the kit reads as a
     * rapid-fire mount, and a bespoke one needs a Blender rebuild through
     * tools/kit_build.py rather than a hand edit of the generated kit.
     */
    art: 'pulse',
    rpm: 240,
    mass: 2.6,
    muzzleVel: 2100,
    drag: 8.0e-6,
    /**
     * A poor penetrator on purpose. At 1.7 a round costs more to cross an
     * intact heavy belt than it carries, so this gun cannot reach anything
     * vital through armour — it strips the plate first and only gets inside
     * once the plate is spent, because `wallCost` falls with the plating's
     * condition. That is the whole shape of the weapon: it does not defeat
     * armour, it wears it away.
     */
    ap: 1.7,
    dump: 0,
    heat: 30,
    draw: 1.5,
    ammo: 1,
    spread: 0.005,
    tracer: 0xffb347,
    width: 0.32,
    life: 5.0,
    role: 'SHIELD BREAKER / VOLUME',
    desc: 'Twenty-three megajoules a second of small, fast slugs. It will not '
      + 'get through a belt and it does not need to: nothing in the fleet '
      + 'saturates a shield emitter faster, and it strips plate, radiators and '
      + 'sensor masts off whatever is left standing behind one.',
  },

  // --- ordnance ------------------------------------------------------------
  torpedo: {
    id: 'torpedo',
    name: 'TORPEDO TUBES',
    cls: 'ORDNANCE / GUIDED',
    kind: 'missile',
    /**
     * Four tubes, rippled. A single warhead against a ship with a full
     * point-defence ring is not an attack, it is a donation: measured against a
     * HALBERD's eight directors, five torpedoes launched one every five seconds
     * were shot down five times out of five and the target finished on a
     * hundred per cent plate. Ordnance beats point defence by arriving faster
     * than a director can re-lay, or it does not beat it at all — so the tubes
     * empty at two-second intervals and the answer to a ring is a salvo.
     */
    rpm: 30,
    mass: 4000,
    muzzleVel: 120,
    accel: 210,
    // Motor burn-out. A seeker is only as good as the turn it can still make at
    // speed, so this is the number that decides whether the tubes are a threat
    // or a firework — not `accel`.
    topSpeed: 620,
    // Raised with the move to proportional navigation. Lead pursuit spends its
    // turn correcting an error it re-creates every frame, so a slack turn rate
    // was survivable; PN commits the turn early and then flies almost straight,
    // which means the rate it does have is spent on the target's manoeuvre
    // rather than on its own geometry.
    turnRate: 0.85,
    fuse: 42.0,
    ap: 1.1,
    /**
     * Four tonnes with structure round the warhead. A point-defence slug that
     * passes near one scars it; killing it takes very nearly a direct hit,
     * which is the torpedo's one answer to a director that can otherwise put a
     * hundred rounds a second across its path.
     */
    interceptR: 3.0,
    blast: { radius: 180, energy: 4.5e8, shrapnel: 24, shrapnelEnergy: 8.0e6 },
    heat: 60,
    draw: 1.0,
    ammo: 1,
    tracer: 0xffa04a,
    width: 0.9,
    /**
     * Command guidance: it flies at what the launching ship told it to fly at,
     * and at the locked SUBSYSTEM when there is one. It cannot find a target
     * for itself and it will not pick a new one — kill the ship that fired it
     * and the warheads in the air keep running at whatever they were sent for.
     */
    guidance: 'command',
    role: 'AREA / SUBSYSTEM',
    desc: 'Tracks the locked subsystem rather than the ship. Slow, obvious, '
      + 'and it opens three compartments at once when it connects.',
  },
  seeker: {
    id: 'seeker',
    name: 'SEEKER RACK',
    cls: 'ORDNANCE / IR-OPTICAL',
    kind: 'missile',
    /** Wears the torpedo tube rack; the kit has no rack of its own yet. */
    art: 'torpedo',
    /**
     * A ripple, not a shot. Four rounds a second out of four tubes, so a rack
     * puts a dozen warheads in the air inside the time one of them takes to
     * cross three kilometres — which is more than a ring of directors can lay
     * on at once, and is the entire reason the weapon exists.
     */
    rpm: 240,
    mass: 260,
    muzzleVel: 240,
    /**
     * Thrust is what actually turns it. The motor pushes along the nose, so the
     * rate the velocity vector can be rotated is `accel / topSpeed` — about a
     * radian a second here, against a third of one for a torpedo. `turnRate`
     * only ever binds when it is the smaller of the two, and it is not.
     */
    accel: 1500,
    topSpeed: 1400,
    turnRate: 2.6,
    // Short-legged on purpose. It is a fast, self-directing weapon inside the
    // knife-fight band, not a stand-off one — thirty seconds at 1.4 km/s is
    // more than enough to reach anything it can actually see.
    fuse: 30.0,
    ap: 1.6,
    /** Thin-skinned, and the head is a lens. Anything close finishes it. */
    interceptR: 6.0,
    blast: { radius: 70, energy: 6.5e7, shrapnel: 14, shrapnelEnergy: 2.4e6 },
    heat: 24,
    draw: 0.6,
    ammo: 1,
    tracer: 0xffd06a,
    width: 0.5,
    /**
     * An active seeker: the warhead does its own targeting.
     *
     * The head runs two channels and the difference between them is the whole
     * character of the weapon.
     *
     *   INFRARED  scores a contact by how hot it is — drives at full burn, a
     *             reactor under load, open fires, a hull venting its coolant.
     *             It sees through nothing and cares nothing for size, so it
     *             will happily leave a cold dreadnought coasting on momentum
     *             and chase a picket that just lit its engines.
     *
     *   OPTICAL   scores by angular size, so it takes the biggest thing in
     *             frame and holds it. Slower to settle and completely fooled
     *             by a hulk, but it cannot be shaken by cutting the throttle.
     *
     * Whichever channel gives the stronger return wins, re-evaluated while the
     * head is still searching. Once locked it stays locked until the contact
     * leaves the seeker cone or dies, and then it looks again — which is what
     * makes this genuinely fire-and-forget where the tubes are not.
     */
    guidance: 'active',
    seeker: { fov: 0.95, range: 6500, ir: 1.0, optical: 1.0, reacquire: 0.4 },
    role: 'FIRE AND FORGET',
    desc: 'Finds its own target and keeps finding one. Small warhead, but it '
      + 'arrives at 1.4 km/s, turns four times harder than a torpedo, and does '
      + 'not care whether the ship that launched it is still alive.',
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
