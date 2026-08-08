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

// ---------------------------------------------------------------------------
// Authoring helpers. These set defaults and compose repeated fittings; they do
// not add a layer of indirection over the data.
// ---------------------------------------------------------------------------

/**
 * A compartment. `wall` is the thickness (m) crossed on entry AND on exit, so
 * a shot that traverses two compartments pays four walls — which is exactly
 * what "it went in at the bow and stopped in the magazine" should cost.
 */
const sec = (id, label, pos, half, o = {}) => ({
  id,
  label,
  pos,
  half,
  armor: o.armor || 'armorMedium',
  wall: o.wall !== undefined ? o.wall : 0.20,
  plateHp: o.plateHp || 1.2e7,
  frameHp: o.frameHp || 1.8e7,
  /** Pressurised volume; drives how fast a breach vents. */
  volume: o.volume !== undefined ? o.volume : 8 * half[0] * half[1] * half[2],
  /** Density (kg/m^3) of this compartment for the mass/inertia derivation. */
  density: o.density !== undefined ? o.density : 250,
  /** Compartments a party can walk to directly. Symmetry is enforced. */
  adj: o.adj || [],
  external: o.external !== false,
  /** Visual: how the hull mesh renders this box. */
  style: o.style || 'hull',
});

/**
 * A module. `needs` names one node per network it depends on; a module whose
 * power node is unreachable is as dead as one that has been shot, which is the
 * whole point of wiring the ship rather than listing its parts.
 */
const mod = (id, kind, label, section, pos, o = {}) => ({
  id,
  kind,
  label,
  section,
  pos,
  shape: o.half ? 'box' : 'sphere',
  r: o.r !== undefined ? o.r : 2.0,
  half: o.half,
  hp: o.hp || 6.0e6,
  vuln: o.vuln !== undefined ? o.vuln : 1.0,
  mat: o.mat || 'module',
  sys: o.sys || 'POWER',
  needs: o.needs || null,
  /** Steady-state electrical draw (MW) and shed priority (higher survives). */
  draw: o.draw || 0,
  priority: o.priority !== undefined ? o.priority : 5,
  /** Heat this module dumps into its coolant loop at full duty. */
  heat: o.heat || 0,
  critical: !!o.critical,
  ...o.extra,
});

/**
 * A conduit: one edge of one network. Conduits are modules too — shoot them.
 *
 * `cap` is what the run is RATED to carry, 0..1 of full service. A main trunk
 * is 1. An emergency tie is a thinner cable or a smaller-bore pipe laid down a
 * different part of the ship, and carries a fraction — enough to keep a branch
 * alive and derated when its trunk is cut, not enough to pretend nothing
 * happened. The solver takes the best path available and that path is only as
 * good as its narrowest run, so redundancy costs capability rather than being
 * free. See `_tickNetworks`.
 */
const cond = (id, net, from, to, section, pos, o = {}) => mod(
  id, 'conduit', o.label || `${net.toUpperCase()} RUN`, section, pos,
  {
    r: o.r !== undefined ? o.r : 1.2,
    hp: o.hp || 1.5e6,
    vuln: o.vuln !== undefined ? o.vuln : 2.4,
    mat: 'soft',
    sys: net === 'coolant' ? 'THERMAL' : (net === 'data' ? 'COMPUTE' : 'POWER'),
    critical: o.critical,
    extra: {
      net, from, to, cap: o.cap !== undefined ? o.cap : 1, leak: o.leak || 0,
      /** Deliberately the only feed to its node; exempt from the ring rule. */
      sole: !!o.sole,
    },
  },
);

/** A weapon mount. `arc` is the half-angle (rad) it can traverse off boresight. */
const hp_ = (id, label, section, pos, o = {}) => mod(
  id, 'hardpoint', label, section, pos,
  {
    r: o.r || 2.4,
    hp: o.hp || 1.2e7,
    sys: 'ORDNANCE',
    needs: o.needs,
    draw: o.draw || 3.0,
    priority: 6,
    heat: o.heat || 0,
    extra: {
      mount: o.mount || 'medium',
      weapon: o.weapon,
      arc: o.arc !== undefined ? o.arc : 0.35,
      dir: o.dir || [0, 0, 1],
      feed: o.feed || null,
    },
  },
);

/**
 * An emergency cross-connect: the same edge machinery as `cond`, different
 * intent and different numbers.
 *
 * Nobody builds a capital ship whose lighting, cooling or fire control can be
 * ended by one round in the right place, and the first pass did exactly that —
 * seventy nodes across the four hulls hung off a single run. But redundancy on
 * a warship is not a second main; it is a thinner cable or a smaller-bore pipe
 * routed down a different part of the ship, sized to keep a branch alive rather
 * than to keep it at full output. So a tie is cheaper to lose, and what it
 * carries is a fraction: cut the trunk and the battery still trains, slower.
 *
 * That is the trade the `cap` model exists to express — cross-connecting costs
 * capability instead of being free, and a ship fights on after a hit that used
 * to switch a system off outright.
 */
const tie = (id, net, from, to, section, pos, o = {}) => cond(
  id, net, from, to, section, pos,
  {
    label: 'EMERGENCY TIE',
    cap: 0.5,
    hp: 1.1e6,
    r: 0.9,
    ...o,
  },
);

/**
 * A gun battery as a fitting rather than three loose parts: the mount, the
 * magazine that feeds it, and the hoist that ties it to a power node. Every
 * warship here carries several, and hand-placing the pieces one at a time is
 * exactly how a magazine ends up wired to the wrong bus.
 */
const battery = (id, section, o) => [
  mod(`mag_${id}`, 'magazine', `${o.label} MAGAZINE`, section, o.magPos, {
    half: o.magHalf,
    hp: o.magHp,
    vuln: 1.7,
    sys: 'ORDNANCE',
    extra: { rounds: o.rounds, cookoff: o.cookoff },
  }),
  // `p.gun_` and not `p.${id}`: the forward battery's id is 'fwd', which
  // collided with the ship's own forward bus and made its hoist a run from
  // p.fwd to p.fwd. A self-loop supplies nothing, so on all four hulls the
  // main battery was the one gun whose feed could not be cut, while every
  // broadside died to a single round through its hoist. `sole` marks it as a
  // deliberate single point of failure — a gun is allowed to have exactly one
  // feed, which is what makes shooting the hoist worth doing.
  cond(`c_hoist_${id}`, 'power', o.from, `p.gun_${id}`, section, o.hoistPos, {
    label: `${o.label} HOIST`, hp: o.hoistHp, sole: true,
  }),
  hp_(`hp_${id}`, o.label, section, o.gunPos, {
    weapon: o.weapon,
    mount: o.mount || 'large',
    dir: o.dir,
    arc: o.arc,
    needs: { power: `p.gun_${id}`, data: o.data, ...(o.cool ? { coolant: o.cool } : {}) },
    feed: `mag_${id}`,
    draw: o.draw,
    heat: o.heat,
    hp: o.gunHp,
  }),
];

/** A main drive and the bunker that feeds it. */
const driveUnit = (id, section, o) => [
  mod(`thruster_${id}`, 'thruster', `${o.label} DRIVE`, section, o.pos, {
    half: o.half,
    hp: o.hp,
    sys: 'PROPULSION',
    needs: { power: o.power, coolant: o.cool },
    draw: o.draw,
    priority: 8,
    heat: o.heat,
    extra: { fuel: `fuel_${id}`, share: o.share },
  }),
  mod(`fuel_${id}`, 'fuel', `${o.label} BUNKER`, o.fuelSection || section, o.fuelPos, {
    half: o.fuelHalf,
    hp: o.fuelHp,
    vuln: 1.3,
    sys: 'PROPULSION',
    extra: { store: 100, leak: o.leak || 0.09 },
  }),
];

// ---------------------------------------------------------------------------
// SABRE — picket. The smallest thing here that still rates a crew: one power
// trunk, one loop, eighty-five hands. Fast enough to pick its range and far too
// thin to hold it if the choice goes wrong.
// ---------------------------------------------------------------------------
const SABRE = {
  id: 'sabre',
  name: 'SABRE',
  role: 'PICKET',
  desc: 'One trunk, one loop, eighty-five hands. Nothing aboard is duplicated, '
    + 'so every hit that lands lands somewhere that matters. It survives by '
    + 'choosing the range, and by not being where the return fire is.',
  tint: 0x8fd8ff,
  // `radii` are derived from the compartment boxes in compile(); only the
  // energy budget is authored.
  shield: { capacity: 2.4e7, regen: 5.5e5 },
  flight: {
    maxSpeed: 150, boostSpeed: 230, accelTime: 9, boostAccelTime: 6.5,
    pitchRate: 0.28, yawRate: 0.23, rollRate: 0.44, spool: 1.1,
  },
  sections: [
    sec('prow', 'PROW', [0, 0, 38.75], [6.0, 5.0, 8.75], {
      armor: 'armorMedium', wall: 0.16, plateHp: 5.0e6, frameHp: 7.0e6,
      density: 210, adj: ['bridge', 'fwdhold'], style: 'prow',
    }),
    sec('bridge', 'BRIDGE', [0, 4.5, 22], [5.0, 3.5, 8.0], {
      armor: 'armorMedium', wall: 0.14, plateHp: 4.2e6, frameHp: 6.0e6,
      density: 150, adj: ['prow', 'fwdhold', 'spine'], style: 'canopy',
    }),
    sec('fwdhold', 'FORWARD HOLD', [0, -3.5, 22], [6.0, 4.5, 8.0], {
      armor: 'armorMedium', wall: 0.14, plateHp: 4.5e6, frameHp: 6.5e6,
      density: 230, adj: ['prow', 'bridge', 'spine'],
    }),
    sec('spine', 'SPINE', [0, 0, 4], [6.5, 6.0, 10.0], {
      armor: 'armorHeavy', wall: 0.20, plateHp: 7.5e6, frameHp: 1.1e7,
      density: 250, adj: ['bridge', 'fwdhold', 'podL', 'podR', 'engineering'],
    }),
    sec('podL', 'PORT POD', [12.2, -0.5, -2], [4.5, 3.0, 9.0], {
      armor: 'armorLight', wall: 0.09, plateHp: 2.6e6, frameHp: 3.6e6,
      density: 200, adj: ['spine'], style: 'wing',
    }),
    sec('podR', 'STBD POD', [-12.2, -0.5, -2], [4.5, 3.0, 9.0], {
      armor: 'armorLight', wall: 0.09, plateHp: 2.6e6, frameHp: 3.6e6,
      density: 200, adj: ['spine'], style: 'wing',
    }),
    sec('engineering', 'ENGINEERING', [0, 0, -18], [7.0, 6.0, 12.0], {
      armor: 'armorHeavy', wall: 0.19, plateHp: 7.0e6, frameHp: 1.0e7,
      density: 290, adj: ['spine', 'drivebay'],
    }),
    sec('drivebay', 'DRIVE BAY', [0, 0, -38.75], [6.5, 5.5, 8.75], {
      armor: 'armorMedium', wall: 0.15, plateHp: 4.8e6, frameHp: 7.0e6,
      density: 320, adj: ['engineering'], style: 'engine',
    }),
  ],
  modules: [
    mod('reactor', 'reactor', 'FUSION CORE', 'engineering', [0, 0.5, -2], {
      half: [3.4, 3.2, 4.2], hp: 2.6e7, sys: 'POWER', critical: true,
      needs: { coolant: 'l.core' }, heat: 300, extra: { output: 110 },
    }),
    mod('cap', 'capacitor', 'CAPACITOR BANK', 'spine', [0, -3.6, 2], {
      half: [3.2, 1.4, 3.6], hp: 5.5e6, sys: 'POWER',
      needs: { power: 'p.main' }, extra: { store: 260, rate: 80 },
    }),
    cond('c_react_main', 'power', 'src.reactor', 'p.main', 'engineering', [0, 3.4, 6], {
      label: 'MAIN TRUNK', hp: 2.0e6, critical: true,
    }),
    cond('c_main_fwd', 'power', 'p.main', 'p.fwd', 'spine', [0, 4.2, 5], {
      label: 'FORWARD TRUNK', hp: 1.6e6,
    }),
    cond('c_main_podL', 'power', 'p.main', 'p.podL', 'podL', [2.0, 0, 3], {
      label: 'PORT POD FEED', hp: 1.1e6,
    }),
    cond('c_main_podR', 'power', 'p.main', 'p.podR', 'podR', [-2.0, 0, 3], {
      label: 'STBD POD FEED', hp: 1.1e6,
    }),

    mod('computer', 'computer', 'FLIGHT COMPUTER', 'bridge', [0, -1.4, -3], {
      half: [1.8, 1.1, 1.8], hp: 8.0e6, vuln: 1.4, sys: 'COMPUTE',
      needs: { power: 'p.fwd', coolant: 'l.core' }, draw: 9, priority: 9,
      heat: 70, critical: true,
    }),
    mod('sensor', 'sensor', 'SENSOR ARRAY', 'prow', [0, 1.4, 2.6], {
      half: [2.4, 1.5, 4.2], hp: 4.5e6, vuln: 1.8, sys: 'COMPUTE',
      needs: { power: 'p.fwd', data: 'd.main' , coolant: 'l.core' }, draw: 7, priority: 7, heat: 24,
    }),
    cond('c_data_main', 'data', 'src.computer', 'd.main', 'bridge', [2.4, -1.6, 2], {
      label: 'AVIONICS BUS', hp: 1.0e6, vuln: 2.6, sole: true,
    }),
    cond('c_data_helm', 'data', 'src.computer', 'd.helm', 'bridge', [-2.4, -1.6, 2], {
      label: 'HELM BUS', hp: 1.0e6, vuln: 2.6, sole: true, critical: true,
    }),
    cond('c_data_fire', 'data', 'd.main', 'd.fire', 'spine', [0, 4.2, -4], {
      label: 'FIRE CONTROL BUS', hp: 1.0e6, vuln: 2.6,
    }),
    cond('c_data_eng', 'data', 'd.main', 'd.eng', 'engineering', [-4.0, 3.6, 4], {
      label: 'DAMAGE CONTROL BUS', hp: 1.0e6, vuln: 2.6,
    }),

    // Casualty routing. A picket carries one of everything, so the ties are
    // what stop one of everything being one round.
    tie('c_tie_keel', 'power', 'src.reactor', 'p.main', 'engineering', [0, -3.4, 6], {
      label: 'KEEL TRUNK', cap: 0.6,
    }),
    tie('c_tie_fwd', 'power', 'p.main', 'p.fwd', 'fwdhold', [0, -2.6, -4], {
      label: 'KEEL RUN', cap: 0.55,
    }),
    tie('c_tie_pod', 'power', 'p.podR', 'p.podL', 'spine', [3.0, -4.0, -3], {
      label: 'POD CROSS-TIE', cap: 0.5,
    }),
    tie('c_tie_fire', 'data', 'd.eng', 'd.fire', 'engineering', [4.0, 3.6, 4], {
      label: 'DIRECTOR CROSS-TIE', cap: 0.5,
    }),
    tie('l_tie_aft', 'coolant', 'src.pump', 'l.aft', 'engineering', [4.0, -3.2, 5], {
      label: 'AUXILIARY DISCHARGE', cap: 0.6, leak: 0.1,
    }),
    tie('l_tie_pod', 'coolant', 'l.aft', 'l.pod', 'podL', [-2.0, 0, -3], {
      label: 'POD CROSS-CONNECT', cap: 0.5, leak: 0.1,
    }),

    mod('shieldgen', 'shieldGen', 'SHIELD PROJECTOR', 'spine', [0, 2.6, -4], {
      half: [3.0, 2.2, 3.0], hp: 9.0e6, sys: 'DEFENCE',
      needs: { power: 'p.main', coolant: 'l.core' }, draw: 34, priority: 4, heat: 190,
    }),

    ...driveUnit('m', 'drivebay', {
      label: 'MAIN', pos: [0, -0.5, -3], half: [3.8, 3.0, 3.6], hp: 1.6e7,
      power: 'p.main', cool: 'l.aft', draw: 18, heat: 340, share: 1.0,
      fuelSection: 'spine', fuelPos: [0, 0.5, -5], fuelHalf: [3.6, 2.6, 3.4],
      fuelHp: 6.5e6, leak: 0.12,
    }),
    mod('rcs_fwd', 'rcs', 'BOW RCS BLOCK', 'prow', [0, -1.8, -4], {
      r: 1.7, hp: 4.5e6, sys: 'PROPULSION',
      needs: { power: 'p.fwd' }, draw: 5, priority: 8,
      extra: { axes: [1, 1, 0.15], lat: [1, 1, 0] },
    }),
    mod('rcs_aft', 'rcs', 'AFT RCS BLOCK', 'engineering', [0, 3.5, -6], {
      r: 1.9, hp: 4.5e6, sys: 'PROPULSION',
      needs: { power: 'p.main' }, draw: 5, priority: 8,
      extra: { axes: [1, 1, 1], lat: [1, 1, 1] },
    }),

    mod('pump', 'pump', 'COOLANT PUMP', 'engineering', [4.2, -3.2, 5], {
      r: 1.8, hp: 5.0e6, sys: 'THERMAL',
      needs: { power: 'p.main' }, draw: 4, priority: 7,
    }),
    mod('rad_L', 'radiator', 'PORT RADIATOR', 'podL', [-0.8, 0.9, -1.0], {
      half: [2.6, 0.35, 5.0], hp: 3.0e6, vuln: 1.6, sys: 'THERMAL',
      extra: { reject: 0.5 },
    }),
    mod('rad_R', 'radiator', 'STBD RADIATOR', 'podR', [0.8, 0.9, -1.0], {
      half: [2.6, 0.35, 5.0], hp: 3.0e6, vuln: 1.6, sys: 'THERMAL',
      extra: { reject: 0.5 },
    }),
    cond('l_core', 'coolant', 'src.pump', 'l.core', 'engineering', [-4.2, -3.2, 5], {
      label: 'CORE LOOP', hp: 1.3e6, leak: 0.18,
    }),
    cond('l_aft', 'coolant', 'l.core', 'l.aft', 'drivebay', [0, -3.6, 4], {
      label: 'DRIVE LOOP', hp: 1.2e6, leak: 0.16,
    }),
    cond('l_pod', 'coolant', 'l.core', 'l.pod', 'spine', [0, -4.2, -3], {
      label: 'POD LOOP', hp: 1.2e6, leak: 0.14,
    }),

    mod('lifesupport', 'lifeSupport', 'LIFE SUPPORT', 'fwdhold', [3.6, 2.2, -3], {
      half: [1.8, 1.6, 2.0], hp: 4.5e6, sys: 'LIFE',
      needs: { power: 'p.fwd' }, draw: 6, priority: 9, extra: { rate: 0.09 },
    }),
    mod('quarters', 'quarters', 'CREW QUARTERS', 'fwdhold', [-2.4, 0, 2], {
      half: [2.6, 2.4, 3.6], hp: 6.0e6, sys: 'LIFE',
      needs: { power: 'p.fwd' }, draw: 2, priority: 5,
    }),
    mod('cargo', 'cargo', 'SPARES BAY', 'fwdhold', [2.0, -1.6, 3], {
      half: [2.6, 2.0, 3.2], hp: 4.5e6, sys: 'LOGISTICS',
      extra: { spares: 260 },
    }),

    ...battery('fwd', 'prow', {
      label: 'PROW DRIVER', weapon: 'railgun', mount: 'medium',
      magPos: [0, -1.2, -1.0], magHalf: [2.4, 1.4, 3.0], magHp: 5.0e6,
      rounds: 320, cookoff: 4.5e7,
      hoistPos: [2.6, -0.4, -2], hoistHp: 1.1e6,
      gunPos: [0, 2.4, 7], gunHp: 8.0e6,
      from: 'p.fwd', data: 'd.fire', cool: 'l.core', dir: [0, 0, 1], arc: 0.16,
      draw: 9, heat: 120,
    }),
    hp_('hp_podL', 'PORT LASER', 'podL', [-1.6, 0, 7.5], {
      weapon: 'beam', mount: 'medium', dir: [0, 0, 1], arc: 0.14,
      needs: { power: 'p.podL', data: 'd.fire', coolant: 'l.pod' },
      draw: 12, heat: 210, hp: 7.0e6,
    }),
    hp_('hp_podR', 'STBD LASER', 'podR', [1.6, 0, 7.5], {
      weapon: 'beam', mount: 'medium', dir: [0, 0, 1], arc: 0.14,
      needs: { power: 'p.podR', data: 'd.fire', coolant: 'l.pod' },
      draw: 12, heat: 210, hp: 7.0e6,
    }),
    hp_('hp_pd', 'POINT DEFENCE', 'spine', [0, 5.6, 2], {
      weapon: 'repeater', mount: 'small', dir: [0, 0.3, 1], arc: 0.9,
      needs: { power: 'p.main', data: 'd.fire' , coolant: 'l.core' }, feed: 'mag_fwd',
      draw: 2, heat: 40, hp: 4.0e6,
    }),
  ],
  crew: [
    { id: 'div_bridge', name: 'BRIDGE WATCH', post: 'bridge', role: 'pilot', size: 14 },
    { id: 'div_gun', name: 'GUNNERY', post: 'prow', role: 'gunner', size: 18 },
    { id: 'div_eng', name: 'ENGINEERING', post: 'engineering', role: 'engineer', size: 24 },
    { id: 'div_dc', name: 'DAMAGE CONTROL', post: 'spine', role: 'damage', size: 29 },
  ],
};

// ---------------------------------------------------------------------------
// HALBERD — line frigate. Split buses, two loops, a hundred and eighty hands.
// The smallest hull here that can absorb a mistake.
// ---------------------------------------------------------------------------
const HALBERD = {
  id: 'halberd',
  name: 'HALBERD',
  role: 'LINE FRIGATE',
  desc: 'Split power buses, two coolant loops, a hundred and eighty hands. '
    + 'Built so one good hit degrades it rather than ending it — the failure '
    + 'modes are partial, which is what makes the schematic worth reading.',
  tint: 0xc8d4dc,
  shield: { capacity: 7.5e7, regen: 1.3e6 },
  flight: {
    maxSpeed: 115, boostSpeed: 175, accelTime: 13, boostAccelTime: 9,
    pitchRate: 0.200, yawRate: 0.165, rollRate: 0.32, spool: 1.5,
  },
  sections: [
    sec('prow', 'PROW', [0, 0, 69.25], [9.0, 7.5, 13.25], {
      armor: 'armorHeavy', wall: 0.30, plateHp: 1.4e7, frameHp: 2.0e7,
      density: 240, adj: ['fwdbattery'], style: 'prow',
    }),
    sec('fwdbattery', 'FORWARD BATTERY', [0, 0, 45], [9.5, 8.0, 11.0], {
      armor: 'armorHeavy', wall: 0.28, plateHp: 1.3e7, frameHp: 1.9e7,
      density: 260, adj: ['prow', 'bridge', 'fwdhold'],
    }),
    sec('bridge', 'BRIDGE', [0, 6.0, 23], [7.5, 5.0, 11.0], {
      armor: 'armorMedium', wall: 0.22, plateHp: 9.5e6, frameHp: 1.4e7,
      density: 160, adj: ['fwdbattery', 'fwdhold', 'spine'], style: 'canopy',
    }),
    sec('fwdhold', 'FORWARD HOLD', [0, -5.0, 23], [9.5, 6.0, 11.0], {
      armor: 'armorMedium', wall: 0.22, plateHp: 1.0e7, frameHp: 1.5e7,
      density: 250, adj: ['fwdbattery', 'bridge', 'spine'],
    }),
    sec('spine', 'MAIN SPINE', [0, 0, -1], [10.0, 9.0, 13.0], {
      armor: 'armorHeavy', wall: 0.34, plateHp: 1.8e7, frameHp: 2.6e7,
      density: 260,
      adj: ['bridge', 'fwdhold', 'sponsonL', 'sponsonR', 'coredeck', 'dorsalmount'],
    }),
    sec('sponsonL', 'PORT SPONSON', [16.3, -2.0, -4], [6.0, 4.0, 14.0], {
      armor: 'armorMedium', wall: 0.18, plateHp: 8.0e6, frameHp: 1.1e7,
      density: 230, adj: ['spine', 'coredeck'], style: 'wing',
    }),
    sec('sponsonR', 'STBD SPONSON', [-16.3, -2.0, -4], [6.0, 4.0, 14.0], {
      armor: 'armorMedium', wall: 0.18, plateHp: 8.0e6, frameHp: 1.1e7,
      density: 230, adj: ['spine', 'coredeck'], style: 'wing',
    }),
    sec('dorsalmount', 'DORSAL MOUNT', [0, 12.0, -27], [6.0, 3.0, 10.0], {
      armor: 'armorMedium', wall: 0.18, plateHp: 7.0e6, frameHp: 9.0e6,
      density: 240, adj: ['spine', 'coredeck'],
    }),
    sec('coredeck', 'CORE DECK', [0, 0, -27], [10.0, 9.0, 13.0], {
      armor: 'armorHeavy', wall: 0.32, plateHp: 1.7e7, frameHp: 2.5e7,
      density: 265, adj: ['spine', 'sponsonL', 'sponsonR', 'dorsalmount', 'engineering'],
    }),
    sec('engineering', 'ENGINEERING', [0, 0, -52], [10.0, 8.5, 12.0], {
      armor: 'armorHeavy', wall: 0.30, plateHp: 1.6e7, frameHp: 2.3e7,
      density: 300, adj: ['coredeck', 'drivebay'],
    }),
    sec('drivebay', 'DRIVE BAY', [0, 0, -73.25], [9.0, 7.5, 9.25], {
      armor: 'armorMedium', wall: 0.22, plateHp: 1.0e7, frameHp: 1.5e7,
      density: 340, adj: ['engineering'], style: 'engine',
    }),
  ],
  modules: [
    mod('reactor', 'reactor', 'FUSION REACTOR', 'engineering', [0, 0.5, -1], {
      half: [5.0, 4.6, 5.6], hp: 6.0e7, sys: 'POWER', critical: true,
      needs: { coolant: 'l.core' }, heat: 520, extra: { output: 250 },
    }),
    mod('cap', 'capacitor', 'CAPACITOR BANK', 'coredeck', [0, -6.0, 0], {
      half: [5.0, 2.0, 5.5], hp: 1.1e7, vuln: 1.2, sys: 'POWER',
      needs: { power: 'p.main' }, extra: { store: 620, rate: 170 },
    }),
    cond('c_react_main', 'power', 'src.reactor', 'p.main', 'engineering', [0, 5.5, 8], {
      label: 'MAIN TRUNK', hp: 3.2e6, critical: true,
    }),
    // Two independent routes forward: cutting one costs nothing, which is the
    // entire point of drawing both.
    cond('c_dorsal', 'power', 'p.main', 'p.fwd', 'spine', [0, 7.0, 3], {
      label: 'DORSAL RUN', hp: 2.4e6,
    }),
    cond('c_keel', 'power', 'p.main', 'p.fwd', 'coredeck', [0, -7.0, 3], {
      label: 'KEEL RUN', hp: 2.4e6,
    }),
    cond('c_fwd_bridge', 'power', 'p.fwd', 'p.bridge', 'bridge', [0, -3.4, -6], {
      label: 'BRIDGE FEED', hp: 1.8e6,
    }),
    cond('c_main_sponL', 'power', 'p.main', 'p.sponL', 'sponsonL', [3.4, 0, 4], {
      label: 'PORT SPONSON FEED', hp: 1.6e6,
    }),
    cond('c_main_sponR', 'power', 'p.main', 'p.sponR', 'sponsonR', [-3.4, 0, 4], {
      label: 'STBD SPONSON FEED', hp: 1.6e6,
    }),

    mod('computer', 'computer', 'COMBAT COMPUTER', 'bridge', [0, -2.2, -4], {
      half: [2.6, 1.6, 2.6], hp: 1.4e7, vuln: 1.4, sys: 'COMPUTE',
      needs: { power: 'p.bridge', coolant: 'l.core' }, draw: 16, priority: 9,
      heat: 100, critical: true,
    }),
    mod('sensor', 'sensor', 'SENSOR SUITE', 'prow', [0, 2.6, 3.5], {
      half: [3.6, 2.2, 6.0], hp: 8.0e6, vuln: 1.8, sys: 'COMPUTE',
      needs: { power: 'p.fwd', data: 'd.main' , coolant: 'l.fwd' }, draw: 12, priority: 7, heat: 32,
    }),
    cond('c_data_main', 'data', 'src.computer', 'd.main', 'bridge', [3.4, -2.4, 1], {
      label: 'AVIONICS BUS', hp: 1.3e6, vuln: 2.6, sole: true,
    }),
    cond('c_data_helm', 'data', 'src.computer', 'd.helm', 'bridge', [-3.4, -2.4, 1], {
      label: 'HELM BUS', hp: 1.3e6, vuln: 2.6, sole: true, critical: true,
    }),
    cond('c_data_fire', 'data', 'd.main', 'd.fire', 'spine', [0, 7.0, -8], {
      label: 'FIRE CONTROL BUS', hp: 1.3e6, vuln: 2.6,
    }),
    cond('c_data_eng', 'data', 'd.main', 'd.eng', 'coredeck', [-5.5, 6.0, 5], {
      label: 'DAMAGE CONTROL BUS', hp: 1.3e6, vuln: 2.6,
    }),

    // Casualty routing.
    tie('c_tie_keel', 'power', 'src.reactor', 'p.main', 'engineering', [0, -5.5, 8], {
      label: 'KEEL TRUNK', cap: 0.6,
    }),
    tie('c_tie_bridge', 'power', 'p.main', 'p.bridge', 'bridge', [3.4, -3.4, -6], {
      label: 'BRIDGE ALTERNATE', cap: 0.45,
    }),
    tie('c_tie_spon', 'power', 'p.sponR', 'p.sponL', 'spine', [0, -6.0, 3], {
      label: 'SPONSON CROSS-TIE', cap: 0.5,
    }),
    tie('c_tie_fire', 'data', 'd.eng', 'd.fire', 'coredeck', [5.5, 6.0, 5], {
      label: 'DIRECTOR CROSS-TIE', cap: 0.5,
    }),
    tie('l_tie_aft', 'coolant', 'src.pump', 'l.aft', 'engineering', [-6.0, -4.0, 5], {
      label: 'AUXILIARY DISCHARGE', cap: 0.6, leak: 0.1,
    }),
    tie('l_tie_fwd', 'coolant', 'l.core', 'l.fwd', 'fwdhold', [-6.0, -3.0, -6], {
      label: 'FORWARD CROSS-CONNECT', cap: 0.5, leak: 0.1,
    }),
    tie('l_tie_spon', 'coolant', 'l.fwd', 'l.spon', 'coredeck', [6.0, -7.0, -6], {
      label: 'SPONSON CROSS-CONNECT', cap: 0.5, leak: 0.1,
    }),

    mod('shieldgen', 'shieldGen', 'SHIELD PROJECTOR', 'spine', [0, 3.5, 5], {
      half: [4.4, 3.4, 4.4], hp: 2.0e7, sys: 'DEFENCE',
      needs: { power: 'p.main', coolant: 'l.core' }, draw: 78, priority: 4, heat: 380,
    }),
    mod('shieldcap', 'shieldGen', 'FACET AMPLIFIER', 'fwdhold', [0, 2.6, 6], {
      half: [3.0, 2.0, 2.6], hp: 9.0e6, sys: 'DEFENCE',
      needs: { power: 'p.fwd', coolant: 'l.fwd' }, draw: 30, priority: 3, heat: 150,
    }),

    ...driveUnit('A', 'drivebay', {
      label: 'PORT', pos: [4.2, 0, -3], half: [3.6, 3.4, 4.2], hp: 3.0e7,
      power: 'p.main', cool: 'l.aft', draw: 34, heat: 620, share: 0.5,
      fuelSection: 'spine', fuelPos: [5.5, -1.0, -6], fuelHalf: [3.4, 3.6, 5.5],
      fuelHp: 1.2e7, leak: 0.10,
    }),
    ...driveUnit('B', 'drivebay', {
      label: 'STBD', pos: [-4.2, 0, -3], half: [3.6, 3.4, 4.2], hp: 3.0e7,
      power: 'p.main', cool: 'l.aft', draw: 34, heat: 620, share: 0.5,
      fuelSection: 'spine', fuelPos: [-5.5, -1.0, -6], fuelHalf: [3.4, 3.6, 5.5],
      fuelHp: 1.2e7, leak: 0.10,
    }),
    mod('rcs_fwd', 'rcs', 'BOW RCS BLOCK', 'prow', [0, -3.0, -7], {
      r: 2.4, hp: 8.0e6, sys: 'PROPULSION',
      needs: { power: 'p.fwd' }, draw: 9, priority: 8,
      extra: { axes: [1, 1, 0.15], lat: [1, 1, 0] },
    }),
    mod('rcs_aft', 'rcs', 'AFT RCS BLOCK', 'engineering', [0, 5.2, -7], {
      r: 2.6, hp: 8.0e6, sys: 'PROPULSION',
      needs: { power: 'p.main' }, draw: 9, priority: 8,
      extra: { axes: [1, 1, 0.15], lat: [1, 1, 1] },
    }),
    mod('rcs_sponL', 'rcs', 'PORT ROLL JETS', 'sponsonL', [0, 0, -9], {
      r: 2.2, hp: 5.0e6, sys: 'PROPULSION',
      needs: { power: 'p.sponL' }, draw: 5, priority: 8,
      extra: { axes: [0.1, 0.1, 1], lat: [1, 1, 0] },
    }),
    mod('rcs_sponR', 'rcs', 'STBD ROLL JETS', 'sponsonR', [0, 0, -9], {
      r: 2.2, hp: 5.0e6, sys: 'PROPULSION',
      needs: { power: 'p.sponR' }, draw: 5, priority: 8,
      extra: { axes: [0.1, 0.1, 1], lat: [1, 1, 0] },
    }),

    mod('pump', 'pump', 'PRIMARY PUMP', 'engineering', [-6.0, -4.0, 5], {
      r: 2.6, hp: 8.0e6, sys: 'THERMAL',
      needs: { power: 'p.main' }, draw: 7, priority: 7,
    }),
    mod('pump_aux', 'pump', 'AUXILIARY PUMP', 'fwdhold', [-6.0, -3.0, -6], {
      r: 2.0, hp: 6.0e6, sys: 'THERMAL',
      needs: { power: 'p.fwd' }, draw: 5, priority: 6,
    }),
    mod('rad_L', 'radiator', 'PORT RADIATOR', 'sponsonL', [-1.2, 1.4, -1.5], {
      half: [3.3, 0.45, 7.5], hp: 6.0e6, vuln: 1.6, sys: 'THERMAL',
      extra: { reject: 0.5 },
    }),
    mod('rad_R', 'radiator', 'STBD RADIATOR', 'sponsonR', [1.2, 1.4, -1.5], {
      half: [3.3, 0.45, 7.5], hp: 6.0e6, vuln: 1.6, sys: 'THERMAL',
      extra: { reject: 0.5 },
    }),
    cond('l_core', 'coolant', 'src.pump', 'l.core', 'engineering', [6.0, -4.0, 5], {
      label: 'CORE LOOP', hp: 2.0e6, leak: 0.16,
    }),
    cond('l_aft', 'coolant', 'l.core', 'l.aft', 'drivebay', [0, -5.0, 4], {
      label: 'DRIVE LOOP', hp: 1.9e6, leak: 0.15,
    }),
    cond('l_fwd', 'coolant', 'src.pump_aux', 'l.fwd', 'fwdhold', [6.0, -3.0, -6], {
      label: 'FORWARD LOOP', hp: 1.8e6, leak: 0.14,
    }),
    cond('l_spon', 'coolant', 'l.core', 'l.spon', 'coredeck', [0, -7.0, -6], {
      label: 'SPONSON LOOP', hp: 1.8e6, leak: 0.13,
    }),

    mod('lifesupport', 'lifeSupport', 'LIFE SUPPORT', 'coredeck', [6.5, 5.0, -6], {
      half: [2.6, 2.2, 3.0], hp: 8.0e6, sys: 'LIFE',
      needs: { power: 'p.fwd' }, draw: 11, priority: 9, extra: { rate: 0.075 },
    }),
    mod('quarters', 'quarters', 'CREW QUARTERS', 'fwdhold', [0, 0, 2], {
      half: [6.0, 3.4, 5.0], hp: 1.1e7, sys: 'LIFE',
      needs: { power: 'p.fwd' }, draw: 4, priority: 5,
    }),
    mod('cargo_A', 'cargo', 'SPARES BAY', 'fwdhold', [-5.7, -2.6, 6], {
      half: [2.8, 2.4, 3.8], hp: 7.0e6, sys: 'LOGISTICS',
      extra: { spares: 520 },
    }),
    mod('cargo_B', 'cargo', 'AFT STORES', 'coredeck', [6.5, -5.5, 6], {
      half: [2.6, 2.2, 3.6], hp: 6.0e6, sys: 'LOGISTICS',
      extra: { spares: 380 },
    }),

    ...battery('fwd', 'fwdbattery', {
      label: 'FORWARD DRIVER', weapon: 'railgun',
      magPos: [0, -4.0, 0], magHalf: [4.4, 2.6, 5.0], magHp: 1.1e7,
      rounds: 900, cookoff: 2.2e8,
      hoistPos: [4.4, -0.5, -4], hoistHp: 1.8e6,
      gunPos: [0, 5.5, 6], gunHp: 1.6e7,
      from: 'p.fwd', data: 'd.fire', cool: 'l.fwd', dir: [0, 0, 1], arc: 0.16,
      draw: 16, heat: 200,
    }),
    ...battery('dor', 'dorsalmount', {
      label: 'DORSAL TURRET', weapon: 'railgun',
      magPos: [0, -1.2, 0], magHalf: [3.0, 1.4, 4.0], magHp: 8.0e6,
      rounds: 700, cookoff: 1.7e8,
      hoistPos: [3.0, 0, -5], hoistHp: 1.6e6,
      gunPos: [0, 2.4, 2], gunHp: 1.3e7,
      from: 'p.main', data: 'd.fire', cool: 'l.core', dir: [0, 0.2, 1], arc: 0.55,
      draw: 15, heat: 180,
    }),
    hp_('hp_sponL', 'PORT LASER', 'sponsonL', [-2.0, 0, 11], {
      weapon: 'beam', mount: 'large', dir: [0, 0, 1], arc: 0.15,
      needs: { power: 'p.sponL', data: 'd.fire', coolant: 'l.spon' },
      draw: 26, heat: 380, hp: 1.1e7,
    }),
    hp_('hp_sponR', 'STBD LASER', 'sponsonR', [2.0, 0, 11], {
      weapon: 'beam', mount: 'large', dir: [0, 0, 1], arc: 0.15,
      needs: { power: 'p.sponR', data: 'd.fire', coolant: 'l.spon' },
      draw: 26, heat: 380, hp: 1.1e7,
    }),
    hp_('hp_pdA', 'POINT DEFENCE A', 'spine', [5.0, 7.5, 6], {
      weapon: 'repeater', mount: 'small', dir: [0.3, 0.4, 1], arc: 1.1,
      needs: { power: 'p.main', data: 'd.fire' , coolant: 'l.core' }, feed: 'mag_dor',
      draw: 3, heat: 50, hp: 5.0e6,
    }),
    hp_('hp_pdB', 'POINT DEFENCE B', 'spine', [-5.0, 7.5, 6], {
      weapon: 'repeater', mount: 'small', dir: [-0.3, 0.4, 1], arc: 1.1,
      needs: { power: 'p.main', data: 'd.fire' , coolant: 'l.core' }, feed: 'mag_dor',
      draw: 3, heat: 50, hp: 5.0e6,
    }),
    mod('mag_tor', 'magazine', 'TORPEDO STOWAGE', 'fwdhold', [0, -3.4, -6], {
      half: [3.4, 1.8, 3.0], hp: 7.0e6, vuln: 1.8, sys: 'ORDNANCE',
      extra: { rounds: 24, cookoff: 1.8e8 },
    }),
    hp_('hp_tor', 'TORPEDO TUBES', 'fwdhold', [0, -5.4, 8], {
      weapon: 'torpedo', mount: 'large', dir: [0, -0.05, 1], arc: 0.20,
      needs: { power: 'p.fwd', data: 'd.fire' , coolant: 'l.fwd' }, feed: 'mag_tor',
      draw: 4, heat: 30, hp: 9.0e6,
    }),
  ],
  crew: [
    { id: 'div_bridge', name: 'BRIDGE WATCH', post: 'bridge', role: 'pilot', size: 22 },
    { id: 'div_gunF', name: 'GUNNERY FORWARD', post: 'fwdbattery', role: 'gunner', size: 30 },
    { id: 'div_gunD', name: 'GUNNERY DORSAL', post: 'dorsalmount', role: 'gunner', size: 20 },
    { id: 'div_eng', name: 'ENGINEERING', post: 'engineering', role: 'engineer', size: 38 },
    { id: 'div_dcA', name: 'DAMAGE CONTROL A', post: 'spine', role: 'damage', size: 35 },
    { id: 'div_dcB', name: 'DAMAGE CONTROL B', post: 'coredeck', role: 'damage', size: 35 },
  ],
};

// ---------------------------------------------------------------------------
// MERIDIAN — heavy cruiser, and what the player takes to sea. Fourteen
// compartments, four hundred and twenty hands, nothing vital that exists only
// once. Big enough that a fight is a campaign of small failures.
// ---------------------------------------------------------------------------
const MERIDIAN = {
  id: 'meridian',
  name: 'MERIDIAN',
  role: 'HEAVY CRUISER',
  desc: 'Fourteen compartments, four hundred and twenty hands, and nothing '
    + 'vital that exists only once. A fight in this is a campaign of small '
    + 'failures — which conduit went, which party is cut off, whether the '
    + 'forward loop is still holding — rather than a single event.',
  tint: 0xb9c6d2,
  shield: { capacity: 2.6e8, regen: 3.4e6 },
  flight: {
    maxSpeed: 92, boostSpeed: 140, accelTime: 18, boostAccelTime: 12,
    pitchRate: 0.150, yawRate: 0.125, rollRate: 0.25, spool: 1.9,
  },
  sections: [
    sec('bowarray', 'BOW ARRAY', [0, 0, 111.5], [11, 9, 13.5], {
      armor: 'armorMedium', wall: 0.26, plateHp: 1.6e7, frameHp: 2.2e7,
      density: 210, adj: ['fwdbattery'], style: 'prow',
    }),
    sec('fwdbattery', 'FORWARD BATTERY', [0, 0, 85], [13, 11, 13], {
      armor: 'armorHeavy', wall: 0.50, plateHp: 3.4e7, frameHp: 4.6e7,
      density: 280, adj: ['bowarray', 'bridge', 'forehold'],
    }),
    sec('bridge', 'BRIDGE', [0, 8, 58], [10, 6, 14], {
      armor: 'armorHeavy', wall: 0.42, plateHp: 2.6e7, frameHp: 3.4e7,
      density: 170, adj: ['fwdbattery', 'forehold', 'spine'], style: 'canopy',
    }),
    sec('forehold', 'FORWARD HOLD', [0, -6, 58], [13, 8, 14], {
      armor: 'armorMedium', wall: 0.30, plateHp: 2.2e7, frameHp: 3.0e7,
      density: 260, adj: ['fwdbattery', 'bridge', 'spine'],
    }),
    sec('batteryLF', 'PORT BATTERY FWD', [22.2, -2, 30], [7, 5, 16], {
      armor: 'armorMedium', wall: 0.26, plateHp: 1.8e7, frameHp: 2.4e7,
      density: 250, adj: ['spine'], style: 'wing',
    }),
    sec('batteryRF', 'STBD BATTERY FWD', [-22.2, -2, 30], [7, 5, 16], {
      armor: 'armorMedium', wall: 0.26, plateHp: 1.8e7, frameHp: 2.4e7,
      density: 250, adj: ['spine'], style: 'wing',
    }),
    sec('spine', 'MAIN SPINE', [0, 0, 27], [13.5, 12, 17], {
      armor: 'armorHeavy', wall: 0.55, plateHp: 4.0e7, frameHp: 5.5e7,
      density: 265,
      adj: ['bridge', 'forehold', 'batteryLF', 'batteryRF', 'coredeck', 'magdeck'],
    }),
    sec('coredeck', 'CORE DECK', [0, 5, -4], [13.5, 7, 14], {
      armor: 'armorHeavy', wall: 0.52, plateHp: 3.6e7, frameHp: 5.0e7,
      density: 260, adj: ['spine', 'magdeck', 'batteryLA', 'batteryRA', 'engineering'],
    }),
    sec('magdeck', 'MAGAZINE DECK', [0, -7, -4], [13.5, 5, 14], {
      armor: 'armorHeavy', wall: 0.52, plateHp: 3.6e7, frameHp: 5.0e7,
      density: 300, adj: ['spine', 'coredeck', 'engineering'],
    }),
    sec('batteryLA', 'PORT BATTERY AFT', [22.2, -2, -30], [7, 5, 16], {
      armor: 'armorMedium', wall: 0.26, plateHp: 1.8e7, frameHp: 2.4e7,
      density: 250, adj: ['coredeck'], style: 'wing',
    }),
    sec('batteryRA', 'STBD BATTERY AFT', [-22.2, -2, -30], [7, 5, 16], {
      armor: 'armorMedium', wall: 0.26, plateHp: 1.8e7, frameHp: 2.4e7,
      density: 250, adj: ['coredeck'], style: 'wing',
    }),
    sec('engineering', 'ENGINEERING', [0, 0, -38], [14, 12, 20], {
      armor: 'armorHeavy', wall: 0.50, plateHp: 3.8e7, frameHp: 5.2e7,
      density: 290, adj: ['coredeck', 'magdeck', 'reactorroom'],
    }),
    sec('reactorroom', 'REACTOR ROOM', [0, 0, -75], [13, 11, 17], {
      armor: 'armorHeavy', wall: 0.55, plateHp: 4.0e7, frameHp: 5.5e7,
      density: 310, adj: ['engineering', 'drivebay'],
    }),
    sec('drivebay', 'DRIVE BAY', [0, 0, -108.5], [12.5, 10, 16.5], {
      armor: 'armorMedium', wall: 0.30, plateHp: 2.2e7, frameHp: 3.2e7,
      density: 350, adj: ['reactorroom'], style: 'engine',
    }),
  ],
  modules: [
    // ---- POWER ------------------------------------------------------------
    mod('reactor', 'reactor', 'PRIMARY REACTOR', 'reactorroom', [0, 0, 0], {
      half: [7.0, 6.4, 8.0], hp: 1.4e8, sys: 'POWER', critical: true,
      needs: { coolant: 'l.core' }, heat: 900, extra: { output: 620 },
    }),
    mod('reactor_aux', 'reactor', 'AUXILIARY PLANT', 'engineering', [0, -7.0, 8], {
      half: [4.0, 3.2, 4.6], hp: 4.0e7, sys: 'POWER',
      needs: { coolant: 'l.aft' }, heat: 280, extra: { output: 150 },
    }),
    mod('cap', 'capacitor', 'CAPACITOR BANK', 'coredeck', [0, -3.0, 0], {
      half: [8.0, 2.4, 8.0], hp: 2.4e7, vuln: 1.2, sys: 'POWER',
      needs: { power: 'p.main' }, extra: { store: 2100, rate: 460 },
    }),
    cond('c_react_main', 'power', 'src.reactor', 'p.main', 'reactorroom', [0, 7.5, 11], {
      label: 'MAIN TRUNK', hp: 5.0e6, critical: true,
    }),
    cond('c_aux_main', 'power', 'src.reactor_aux', 'p.main', 'engineering', [6.0, -7.0, 14], {
      label: 'AUXILIARY TIE', hp: 3.4e6,
    }),
    cond('c_dorsal', 'power', 'p.main', 'p.fwd', 'spine', [0, 9.5, 4], {
      label: 'DORSAL RUN', hp: 3.6e6,
    }),
    cond('c_keel', 'power', 'p.main', 'p.fwd', 'magdeck', [0, -3.0, 4], {
      label: 'KEEL RUN', hp: 3.6e6,
    }),
    cond('c_fwd_bridge', 'power', 'p.fwd', 'p.bridge', 'bridge', [0, -4.0, -8], {
      label: 'BRIDGE FEED', hp: 2.6e6,
    }),
    cond('c_main_batLF', 'power', 'p.fwd', 'p.batLF', 'batteryLF', [4.0, 0, 6], {
      label: 'PORT FWD FEED', hp: 2.4e6,
    }),
    cond('c_main_batRF', 'power', 'p.fwd', 'p.batRF', 'batteryRF', [-4.0, 0, 6], {
      label: 'STBD FWD FEED', hp: 2.4e6,
    }),
    cond('c_main_batLA', 'power', 'p.main', 'p.batLA', 'batteryLA', [4.0, 0, 6], {
      label: 'PORT AFT FEED', hp: 2.4e6,
    }),
    cond('c_main_batRA', 'power', 'p.main', 'p.batRA', 'batteryRA', [-4.0, 0, 6], {
      label: 'STBD AFT FEED', hp: 2.4e6,
    }),

    // ---- COMPUTE ----------------------------------------------------------
    mod('computer', 'computer', 'COMBAT COMPUTER', 'bridge', [0, -2.6, -5], {
      half: [3.6, 2.2, 3.4], hp: 2.6e7, vuln: 1.4, sys: 'COMPUTE',
      needs: { power: 'p.bridge', coolant: 'l.fwd' }, draw: 34, priority: 9,
      heat: 150, critical: true,
    }),
    mod('computer_aux', 'computer', 'AUXILIARY CONTROL', 'coredeck', [0, 3.0, -8], {
      half: [3.0, 1.8, 2.8], hp: 1.6e7, vuln: 1.4, sys: 'COMPUTE',
      needs: { power: 'p.main', coolant: 'l.core' }, draw: 20, priority: 8, heat: 90,
    }),
    mod('sensor', 'sensor', 'SENSOR SUITE', 'bowarray', [0, 2.6, 2.5], {
      half: [4.4, 3.0, 7.0], hp: 1.4e7, vuln: 1.8, sys: 'COMPUTE',
      needs: { power: 'p.fwd', data: 'd.main' , coolant: 'l.fwd' }, draw: 24, priority: 7, heat: 44,
    }),
    cond('c_data_main', 'data', 'src.computer', 'd.main', 'bridge', [5.0, -3.0, 2], {
      label: 'AVIONICS BUS', hp: 2.2e6, vuln: 2.6,
    }),
    cond('c_data_helm', 'data', 'src.computer', 'd.helm', 'bridge', [-5.0, -3.0, 2], {
      label: 'HELM BUS', hp: 2.2e6, vuln: 2.6, critical: true,
    }),
    cond('c_data_aux', 'data', 'src.computer_aux', 'd.main', 'coredeck', [6.0, 3.0, -8], {
      label: 'AUXILIARY LINK', hp: 2.2e6, vuln: 2.6,
    }),
    // Second helm run, off the AUXILIARY CONTROL room and routed down the far
    // side of the ship. A cruiser has no business losing steerage to one lucky
    // round through the bridge: either computer can drive the helm and either
    // run can carry it, so it takes two hits in two different compartments to
    // put the ship out of control. The network solver needs no help with this
    // — it floods from every intact source over every intact conduit, so a
    // second source and a second path IS the redundancy.
    cond('c_data_helm2', 'data', 'src.computer_aux', 'd.helm', 'coredeck', [-6.0, 3.0, -8], {
      label: 'AUX HELM RUN', hp: 2.2e6, vuln: 2.6,
    }),
    cond('c_data_fireF', 'data', 'd.main', 'd.fireF', 'spine', [7.0, 9.5, -10], {
      label: 'FWD DIRECTOR LINK', hp: 2.0e6, vuln: 2.8,
    }),
    cond('c_data_fireA', 'data', 'd.main', 'd.fireA', 'coredeck', [-7.0, 4.0, 8], {
      label: 'AFT DIRECTOR LINK', hp: 2.0e6, vuln: 2.8,
    }),
    cond('c_data_eng', 'data', 'd.main', 'd.eng', 'engineering', [-8.0, 8.0, -12], {
      label: 'DAMAGE CONTROL BUS', hp: 2.0e6, vuln: 2.6,
    }),

    // Casualty routing. A cruiser's whole argument is that nothing vital exists
    // only once; before these, seventeen of its nodes did.
    tie('c_tie_bridge', 'power', 'p.main', 'p.bridge', 'bridge', [4.0, -4.0, -8], {
      label: 'BRIDGE ALTERNATE', cap: 0.45,
    }),
    tie('c_tie_batF', 'power', 'p.batRF', 'p.batLF', 'spine', [0, 6.0, -2], {
      label: 'FWD BATTERY CROSS-TIE', cap: 0.5,
    }),
    tie('c_tie_batA', 'power', 'p.batRA', 'p.batLA', 'coredeck', [0, 0, 2], {
      label: 'AFT BATTERY CROSS-TIE', cap: 0.5,
    }),
    tie('c_tie_fire', 'data', 'd.fireA', 'd.fireF', 'spine', [-7.0, 9.5, -10], {
      label: 'DIRECTOR CROSS-TIE', cap: 0.6,
    }),
    tie('c_tie_eng', 'data', 'd.fireA', 'd.eng', 'engineering', [8.0, 8.0, -12], {
      label: 'DC ALTERNATE', cap: 0.5,
    }),
    tie('l_tie_core', 'coolant', 'l.core', 'l.aft', 'engineering', [4.0, -8.0, -12], {
      label: 'MAIN CROSS-CONNECT', cap: 0.55, leak: 0.1,
    }),
    tie('l_tie_fwd', 'coolant', 'l.fwd', 'l.aft', 'spine', [0, -9.0, -10], {
      label: 'FORWARD CROSS-CONNECT', cap: 0.5, leak: 0.1,
    }),
    tie('l_tie_bat', 'coolant', 'l.batF', 'l.batA', 'coredeck', [6.0, -5.0, 8], {
      label: 'BATTERY CROSS-CONNECT', cap: 0.5, leak: 0.1,
    }),

    // ---- DEFENCE ----------------------------------------------------------
    mod('shieldgen', 'shieldGen', 'PRIMARY PROJECTOR', 'spine', [0, 5.0, 6], {
      half: [6.0, 4.6, 6.0], hp: 4.4e7, sys: 'DEFENCE',
      needs: { power: 'p.main', coolant: 'l.core' }, draw: 210, priority: 4, heat: 720,
    }),
    mod('shieldcap_f', 'shieldGen', 'FORWARD AMPLIFIER', 'forehold', [0, 3.0, 7], {
      half: [4.0, 2.6, 3.4], hp: 2.0e7, sys: 'DEFENCE',
      needs: { power: 'p.fwd', coolant: 'l.fwd' }, draw: 90, priority: 3, heat: 320,
    }),
    mod('shieldcap_a', 'shieldGen', 'AFT AMPLIFIER', 'engineering', [0, 8.0, -12], {
      half: [4.0, 2.6, 3.4], hp: 2.0e7, sys: 'DEFENCE',
      needs: { power: 'p.main', coolant: 'l.aft' }, draw: 90, priority: 3, heat: 320,
    }),

    // ---- PROPULSION -------------------------------------------------------
    ...driveUnit('A', 'drivebay', {
      label: 'PORT MAIN', pos: [6.0, 0, -4], half: [4.8, 4.4, 5.6], hp: 6.0e7,
      power: 'p.main', cool: 'l.aft', draw: 90, heat: 1100, share: 0.5,
      fuelSection: 'engineering', fuelPos: [8.0, 2.0, 6], fuelHalf: [4.4, 5.0, 8.0],
      fuelHp: 2.6e7, leak: 0.08,
    }),
    ...driveUnit('B', 'drivebay', {
      label: 'STBD MAIN', pos: [-6.0, 0, -4], half: [4.8, 4.4, 5.6], hp: 6.0e7,
      power: 'p.main', cool: 'l.aft', draw: 90, heat: 1100, share: 0.5,
      fuelSection: 'engineering', fuelPos: [-8.0, 2.0, 6], fuelHalf: [4.4, 5.0, 8.0],
      fuelHp: 2.6e7, leak: 0.08,
    }),
    mod('rcs_fwd', 'rcs', 'BOW RCS BLOCK', 'bowarray', [0, -3.4, -7], {
      r: 3.0, hp: 1.4e7, sys: 'PROPULSION',
      needs: { power: 'p.fwd' }, draw: 22, priority: 8,
      extra: { axes: [1, 1, 0.15], lat: [1, 1, 0] },
    }),
    mod('rcs_aft', 'rcs', 'AFT RCS BLOCK', 'reactorroom', [0, 6.6, -10], {
      r: 3.4, hp: 1.4e7, sys: 'PROPULSION',
      needs: { power: 'p.main' }, draw: 22, priority: 8,
      extra: { axes: [1, 1, 0.15], lat: [1, 1, 1] },
    }),
    mod('rcs_wingL', 'rcs', 'PORT ROLL JETS', 'batteryLF', [0, 0, -11], {
      r: 3.0, hp: 9.0e6, sys: 'PROPULSION',
      needs: { power: 'p.batLF' }, draw: 12, priority: 8,
      extra: { axes: [0.1, 0.1, 1], lat: [1, 1, 0] },
    }),
    mod('rcs_wingR', 'rcs', 'STBD ROLL JETS', 'batteryRF', [0, 0, -11], {
      r: 3.0, hp: 9.0e6, sys: 'PROPULSION',
      needs: { power: 'p.batRF' }, draw: 12, priority: 8,
      extra: { axes: [0.1, 0.1, 1], lat: [1, 1, 0] },
    }),

    // ---- THERMAL ----------------------------------------------------------
    mod('pump', 'pump', 'PRIMARY PUMP', 'reactorroom', [-8.0, -6.0, 8], {
      r: 3.4, hp: 1.4e7, sys: 'THERMAL',
      needs: { power: 'p.main' }, draw: 16, priority: 7,
    }),
    mod('pump_aux', 'pump', 'FORWARD PUMP', 'forehold', [-8.0, -4.0, -8], {
      r: 2.8, hp: 1.0e7, sys: 'THERMAL',
      needs: { power: 'p.fwd' }, draw: 12, priority: 6,
    }),
    mod('pump_aft', 'pump', 'AFT PUMP', 'engineering', [8.0, -8.0, -12], {
      r: 2.8, hp: 1.0e7, sys: 'THERMAL',
      needs: { power: 'p.main' }, draw: 12, priority: 6,
    }),
    mod('rad_LF', 'radiator', 'PORT RADIATOR FWD', 'batteryLF', [-1.6, 2.0, -2.0], {
      half: [3.7, 0.55, 9.0], hp: 1.0e7, vuln: 1.6, sys: 'THERMAL',
      extra: { reject: 0.25 },
    }),
    mod('rad_RF', 'radiator', 'STBD RADIATOR FWD', 'batteryRF', [1.6, 2.0, -2.0], {
      half: [3.7, 0.55, 9.0], hp: 1.0e7, vuln: 1.6, sys: 'THERMAL',
      extra: { reject: 0.25 },
    }),
    mod('rad_LA', 'radiator', 'PORT RADIATOR AFT', 'batteryLA', [-1.6, 2.0, -2.0], {
      half: [3.7, 0.55, 9.0], hp: 1.0e7, vuln: 1.6, sys: 'THERMAL',
      extra: { reject: 0.25 },
    }),
    mod('rad_RA', 'radiator', 'STBD RADIATOR AFT', 'batteryRA', [1.6, 2.0, -2.0], {
      half: [3.7, 0.55, 9.0], hp: 1.0e7, vuln: 1.6, sys: 'THERMAL',
      extra: { reject: 0.25 },
    }),
    // Spine and keel panels. Four wing radiators could not reject what this hull
    // makes at rest: the loops settled at 94 C and the plants ran at 78% of
    // rating with nothing wrong and nothing happening. Deliberately NOT on the
    // wings — heat rejection that all lives on four surfaces goes away together
    // the first time somebody rakes the broadsides.
    mod('rad_D', 'radiator', 'DORSAL RADIATOR', 'spine', [0, 9.5, -6], {
      half: [5.5, 0.55, 9.0], hp: 9.0e6, vuln: 1.6, sys: 'THERMAL',
      extra: { reject: 0.15 },
    }),
    mod('rad_V', 'radiator', 'KEEL RADIATOR', 'engineering', [0, -9.0, -6], {
      half: [6.0, 0.55, 10.0], hp: 9.0e6, vuln: 1.6, sys: 'THERMAL',
      extra: { reject: 0.15 },
    }),
    cond('l_core', 'coolant', 'src.pump', 'l.core', 'reactorroom', [8.0, -6.0, 8], {
      label: 'CORE LOOP', hp: 3.0e6, leak: 0.15,
    }),
    cond('l_aft', 'coolant', 'src.pump_aft', 'l.aft', 'engineering', [-8.0, -8.0, -12], {
      label: 'DRIVE LOOP', hp: 2.8e6, leak: 0.14,
    }),
    cond('l_fwd', 'coolant', 'src.pump_aux', 'l.fwd', 'forehold', [8.0, -4.0, -8], {
      label: 'FORWARD LOOP', hp: 2.8e6, leak: 0.13,
    }),
    cond('l_batF', 'coolant', 'l.fwd', 'l.batF', 'spine', [0, -9.0, 10], {
      label: 'FWD BATTERY LOOP', hp: 2.6e6, leak: 0.12,
    }),
    cond('l_batA', 'coolant', 'l.core', 'l.batA', 'coredeck', [0, -5.0, 8], {
      label: 'AFT BATTERY LOOP', hp: 2.6e6, leak: 0.12,
    }),

    // ---- LIFE / LOGISTICS -------------------------------------------------
    mod('lifesupport', 'lifeSupport', 'LIFE SUPPORT', 'coredeck', [9.0, 3.5, 8], {
      half: [3.0, 2.4, 3.4], hp: 1.4e7, sys: 'LIFE',
      needs: { power: 'p.fwd' }, draw: 26, priority: 9, extra: { rate: 0.055 },
    }),
    mod('lifesupport_b', 'lifeSupport', 'AUX SCRUBBERS', 'forehold', [9.0, 3.5, -8], {
      half: [3.0, 2.4, 3.4], hp: 1.2e7, sys: 'LIFE',
      needs: { power: 'p.main' }, draw: 22, priority: 8, extra: { rate: 0.045 },
    }),
    mod('quarters', 'quarters', 'CREW QUARTERS', 'forehold', [0, 0, 2], {
      half: [8.0, 4.4, 7.0], hp: 2.2e7, sys: 'LIFE',
      needs: { power: 'p.fwd' }, draw: 8, priority: 5,
    }),
    mod('cargo_A', 'cargo', 'FORWARD STORES', 'forehold', [-8.0, -3.0, 8], {
      half: [3.6, 3.0, 4.4], hp: 1.2e7, sys: 'LOGISTICS',
      extra: { spares: 1400 },
    }),
    mod('cargo_B', 'cargo', 'AFT STORES', 'engineering', [-9.0, -6.0, -12], {
      half: [3.4, 3.0, 4.2], hp: 1.2e7, sys: 'LOGISTICS',
      extra: { spares: 1100 },
    }),

    // ---- ORDNANCE ---------------------------------------------------------
    ...battery('fwd', 'fwdbattery', {
      label: 'FORWARD TURRET', weapon: 'railgun',
      magPos: [0, -5.0, 0], magHalf: [6.0, 3.4, 6.0], magHp: 2.0e7,
      rounds: 1800, cookoff: 7.0e8,
      hoistPos: [6.0, -0.5, -5], hoistHp: 2.6e6,
      gunPos: [0, 8.0, 6], gunHp: 3.0e7,
      from: 'p.fwd', data: 'd.fireF', cool: 'l.fwd', dir: [0, 0, 1], arc: 0.30,
      draw: 30, heat: 280,
    }),
    ...battery('bLF', 'batteryLF', {
      label: 'PORT BROADSIDE FWD', weapon: 'railgun',
      magPos: [0, -1.5, -5], magHalf: [3.2, 1.4, 5.0], magHp: 1.4e7,
      rounds: 1100, cookoff: 4.2e8,
      hoistPos: [3.4, 0, 0], hoistHp: 2.2e6,
      gunPos: [-2.0, 2.4, 8], gunHp: 2.0e7,
      from: 'p.batLF', data: 'd.fireF', cool: 'l.batF', dir: [0.22, 0, 1], arc: 0.45,
      draw: 24, heat: 230,
    }),
    ...battery('bRF', 'batteryRF', {
      label: 'STBD BROADSIDE FWD', weapon: 'railgun',
      magPos: [0, -1.5, -5], magHalf: [3.2, 1.4, 5.0], magHp: 1.4e7,
      rounds: 1100, cookoff: 4.2e8,
      hoistPos: [-3.4, 0, 0], hoistHp: 2.2e6,
      gunPos: [2.0, 2.4, 8], gunHp: 2.0e7,
      from: 'p.batRF', data: 'd.fireF', cool: 'l.batF', dir: [-0.22, 0, 1], arc: 0.45,
      draw: 24, heat: 230,
    }),
    ...battery('bLA', 'batteryLA', {
      label: 'PORT BROADSIDE AFT', weapon: 'plasma',
      magPos: [0, -1.5, -5], magHalf: [3.2, 1.4, 5.0], magHp: 1.4e7,
      rounds: 600, cookoff: 3.0e8,
      hoistPos: [3.4, 0, 0], hoistHp: 2.2e6,
      gunPos: [-2.0, 2.4, 8], gunHp: 2.0e7,
      from: 'p.batLA', data: 'd.fireA', cool: 'l.batA', dir: [0.22, 0, 1], arc: 0.45,
      draw: 34, heat: 300,
    }),
    ...battery('bRA', 'batteryRA', {
      label: 'STBD BROADSIDE AFT', weapon: 'plasma',
      magPos: [0, -1.5, -5], magHalf: [3.2, 1.4, 5.0], magHp: 1.4e7,
      rounds: 600, cookoff: 3.0e8,
      hoistPos: [-3.4, 0, 0], hoistHp: 2.2e6,
      gunPos: [2.0, 2.4, 8], gunHp: 2.0e7,
      from: 'p.batRA', data: 'd.fireA', cool: 'l.batA', dir: [-0.22, 0, 1], arc: 0.45,
      draw: 34, heat: 300,
    }),
    mod('mag_tor', 'magazine', 'TORPEDO STOWAGE', 'magdeck', [0, 0, 0], {
      half: [8.0, 3.0, 7.0], hp: 2.2e7, vuln: 1.8, sys: 'ORDNANCE',
      extra: { rounds: 60, cookoff: 9.0e8 },
    }),
    hp_('hp_tor', 'TORPEDO TUBES', 'magdeck', [0, -4.2, 12], {
      weapon: 'torpedo', mount: 'large', dir: [0, -0.04, 1], arc: 0.22,
      needs: { power: 'p.fwd', data: 'd.fireF', coolant: 'l.core' }, feed: 'mag_tor',
      draw: 8, heat: 40, hp: 1.8e7,
    }),
    hp_('hp_ion', 'ION PROJECTOR', 'forehold', [0, -6.0, 11], {
      weapon: 'ion', mount: 'large', dir: [0, -0.04, 1], arc: 0.18,
      needs: { power: 'p.fwd', data: 'd.fireF', coolant: 'l.fwd' },
      draw: 70, heat: 340, hp: 1.6e7,
    }),
    hp_('hp_beamL', 'PORT LANCE', 'spine', [9.0, 8.0, 12], {
      weapon: 'beam', mount: 'large', dir: [0.1, 0, 1], arc: 0.20,
      needs: { power: 'p.main', data: 'd.fireF', coolant: 'l.core' },
      draw: 60, heat: 640, hp: 2.0e7,
    }),
    hp_('hp_beamR', 'STBD LANCE', 'spine', [-9.0, 8.0, 12], {
      weapon: 'beam', mount: 'large', dir: [-0.1, 0, 1], arc: 0.20,
      needs: { power: 'p.main', data: 'd.fireF', coolant: 'l.core' },
      draw: 60, heat: 640, hp: 2.0e7,
    }),
    hp_('hp_pdA', 'POINT DEFENCE A', 'spine', [8.0, 11.0, -10], {
      weapon: 'repeater', mount: 'small', dir: [0.35, 0.4, 0.6], arc: 1.2,
      needs: { power: 'p.main', data: 'd.fireA' , coolant: 'l.core' }, feed: 'mag_fwd',
      draw: 5, heat: 60, hp: 8.0e6,
    }),
    hp_('hp_pdB', 'POINT DEFENCE B', 'spine', [-8.0, 11.0, -10], {
      weapon: 'repeater', mount: 'small', dir: [-0.35, 0.4, 0.6], arc: 1.2,
      needs: { power: 'p.main', data: 'd.fireA' , coolant: 'l.core' }, feed: 'mag_fwd',
      draw: 5, heat: 60, hp: 8.0e6,
    }),
    // Dorsal, and it has to be able to bear. Aimed up and AFT it sat 135
    // degrees off the bow with a 75 degree arc, so sixty degrees of sky
    // separated it from the boresight and it could not reach anything the ship
    // was pointing at — a gun that fired into empty space every time the
    // repeater group was triggered. Up and FORWARD it covers the boresight
    // with thirty degrees to spare and still sweeps back past the beam.
    hp_('hp_pdC', 'POINT DEFENCE C', 'engineering', [0, 11.0, 14], {
      weapon: 'repeater', mount: 'small', dir: [0, 0.6, 0.6], arc: 1.3,
      needs: { power: 'p.main', data: 'd.fireA' , coolant: 'l.aft' }, feed: 'mag_bLA',
      draw: 5, heat: 60, hp: 8.0e6,
    }),
  ],
  crew: [
    { id: 'div_bridge', name: 'BRIDGE WATCH', post: 'bridge', role: 'pilot', size: 30 },
    { id: 'div_gunF', name: 'GUNNERY FORWARD', post: 'fwdbattery', role: 'gunner', size: 55 },
    { id: 'div_gunL', name: 'GUNNERY PORT', post: 'batteryLF', role: 'gunner', size: 45 },
    { id: 'div_gunR', name: 'GUNNERY STBD', post: 'batteryRF', role: 'gunner', size: 45 },
    { id: 'div_eng', name: 'ENGINEERING', post: 'engineering', role: 'engineer', size: 70 },
    { id: 'div_react', name: 'REACTOR WATCH', post: 'reactorroom', role: 'engineer', size: 40 },
    { id: 'div_dcA', name: 'DAMAGE CONTROL A', post: 'spine', role: 'damage', size: 65 },
    { id: 'div_dcB', name: 'DAMAGE CONTROL B', post: 'coredeck', role: 'damage', size: 70 },
  ],
};

// ---------------------------------------------------------------------------
// BASTION — dreadnought. A thousand hands and a belt you will not get through
// from the front. Slow enough to be picked apart deliberately, and armed well
// enough that taking your time about it is expensive.
// ---------------------------------------------------------------------------
const BASTION = {
  id: 'bastion',
  name: 'BASTION',
  role: 'DREADNOUGHT',
  desc: 'A thousand hands and a belt you will not get through from the front. '
    + 'Slow enough to be picked apart deliberately, and armed well enough that '
    + 'taking your time about it is expensive.',
  tint: 0xd9a86a,
  shield: { capacity: 6.5e8, regen: 5.4e6 },
  flight: {
    maxSpeed: 62, boostSpeed: 95, accelTime: 26, boostAccelTime: 18,
    pitchRate: 0.098, yawRate: 0.082, rollRate: 0.165, spool: 2.8,
  },
  sections: [
    sec('prow', 'ARMOURED PROW', [0, 0, 170], [16, 13, 20], {
      armor: 'armorHeavy', wall: 0.90, plateHp: 8.0e7, frameHp: 1.0e8,
      density: 360, adj: ['fwdbattery'], style: 'prow',
    }),
    sec('fwdbattery', 'FORWARD BATTERY', [0, 0, 130], [19, 16, 20], {
      armor: 'armorHeavy', wall: 0.78, plateHp: 7.0e7, frameHp: 9.0e7,
      density: 300, adj: ['prow', 'citadel', 'fwdhold'],
    }),
    sec('citadel', 'CITADEL', [0, 12, 89], [15, 9, 21], {
      armor: 'armorHeavy', wall: 0.72, plateHp: 5.6e7, frameHp: 7.2e7,
      density: 200, adj: ['fwdbattery', 'fwdhold', 'spine'], style: 'canopy',
    }),
    sec('fwdhold', 'FORWARD HOLD', [0, -9, 89], [19, 12, 21], {
      armor: 'armorHeavy', wall: 0.60, plateHp: 5.0e7, frameHp: 6.6e7,
      density: 270, adj: ['fwdbattery', 'citadel', 'spine'],
    }),
    sec('batteryLF', 'PORT BATTERY FWD', [32.4, -3, 45], [10, 7, 24], {
      armor: 'armorHeavy', wall: 0.52, plateHp: 4.0e7, frameHp: 5.2e7,
      density: 270, adj: ['spine'], style: 'wing',
    }),
    sec('batteryRF', 'STBD BATTERY FWD', [-32.4, -3, 45], [10, 7, 24], {
      armor: 'armorHeavy', wall: 0.52, plateHp: 4.0e7, frameHp: 5.2e7,
      density: 270, adj: ['spine'], style: 'wing',
    }),
    sec('spine', 'MAIN SPINE', [0, 0, 41], [20, 18, 27], {
      armor: 'armorHeavy', wall: 0.95, plateHp: 9.0e7, frameHp: 1.2e8,
      density: 280,
      adj: ['citadel', 'fwdhold', 'batteryLF', 'batteryRF', 'coredeck', 'magdeck'],
    }),
    sec('coredeck', 'CORE DECK', [0, 8, -8], [20, 10, 22], {
      armor: 'armorHeavy', wall: 0.90, plateHp: 8.4e7, frameHp: 1.1e8,
      density: 275, adj: ['spine', 'magdeck', 'batteryLA', 'batteryRA', 'engineering'],
    }),
    sec('magdeck', 'MAGAZINE DECK', [0, -10, -8], [20, 8, 22], {
      armor: 'armorHeavy', wall: 0.90, plateHp: 8.4e7, frameHp: 1.1e8,
      density: 320, adj: ['spine', 'coredeck', 'engineering'],
    }),
    sec('batteryLA', 'PORT BATTERY AFT', [32.4, -3, -45], [10, 7, 24], {
      armor: 'armorHeavy', wall: 0.52, plateHp: 4.0e7, frameHp: 5.2e7,
      density: 270, adj: ['coredeck'], style: 'wing',
    }),
    sec('batteryRA', 'STBD BATTERY AFT', [-32.4, -3, -45], [10, 7, 24], {
      armor: 'armorHeavy', wall: 0.52, plateHp: 4.0e7, frameHp: 5.2e7,
      density: 270, adj: ['coredeck'], style: 'wing',
    }),
    sec('engineering', 'ENGINEERING', [0, 0, -60], [21, 18, 30], {
      armor: 'armorHeavy', wall: 0.80, plateHp: 7.6e7, frameHp: 1.0e8,
      density: 300, adj: ['coredeck', 'magdeck', 'reactorroom'],
    }),
    sec('reactorroom', 'REACTOR ROOM', [0, 0, -115], [20, 17, 25], {
      armor: 'armorHeavy', wall: 0.95, plateHp: 9.0e7, frameHp: 1.2e8,
      density: 320, adj: ['engineering', 'drivebay'],
    }),
    sec('drivebay', 'DRIVE CLUSTER', [0, 0, -165], [19, 15, 25], {
      armor: 'armorHeavy', wall: 0.55, plateHp: 4.6e7, frameHp: 6.4e7,
      density: 360, adj: ['reactorroom'], style: 'engine',
    }),
  ],
  modules: [
    mod('reactor', 'reactor', 'PRIMARY REACTOR', 'reactorroom', [0, 0, 0], {
      half: [11, 10, 12], hp: 3.4e8, sys: 'POWER', critical: true,
      needs: { coolant: 'l.core' }, heat: 1600, extra: { output: 1450 },
    }),
    mod('reactor_aux', 'reactor', 'AUXILIARY PLANT', 'engineering', [0, -11, 12], {
      half: [6.0, 5.0, 7.0], hp: 9.0e7, sys: 'POWER',
      needs: { coolant: 'l.aft' }, heat: 520, extra: { output: 380 },
    }),
    mod('cap', 'capacitor', 'CAPACITOR BANK', 'coredeck', [0, -4, 0], {
      half: [12, 3.4, 12], hp: 5.0e7, vuln: 1.2, sys: 'POWER',
      needs: { power: 'p.ring' }, extra: { store: 5200, rate: 1050 },
    }),
    // A ring rather than a trunk: reachable from either side, so one cut is
    // survivable and two on the same side are not.
    cond('c_react_ring', 'power', 'src.reactor', 'p.ring', 'reactorroom', [0, 11, 16], {
      label: 'REACTOR TIE', hp: 8.0e6, critical: true,
    }),
    cond('c_aux_ring', 'power', 'src.reactor_aux', 'p.ring', 'engineering', [9, -11, 20], {
      label: 'AUXILIARY TIE', hp: 6.0e6,
    }),
    cond('c_ring_portA', 'power', 'p.ring', 'p.port', 'coredeck', [12, 5, 0], {
      label: 'PORT RING A', hp: 5.0e6,
    }),
    cond('c_ring_portB', 'power', 'p.fwd', 'p.port', 'batteryLF', [6, 0, -14], {
      label: 'PORT RING B', hp: 5.0e6,
    }),
    cond('c_ring_stbdA', 'power', 'p.ring', 'p.stbd', 'coredeck', [-12, 5, 0], {
      label: 'STBD RING A', hp: 5.0e6,
    }),
    cond('c_ring_stbdB', 'power', 'p.fwd', 'p.stbd', 'batteryRF', [-6, 0, -14], {
      label: 'STBD RING B', hp: 5.0e6,
    }),
    cond('c_ring_fwd', 'power', 'p.ring', 'p.fwd', 'spine', [0, 14, -16], {
      label: 'SPINAL RUN', hp: 6.0e6,
    }),
    cond('c_fwd_citadel', 'power', 'p.fwd', 'p.citadel', 'citadel', [0, -6, -12], {
      label: 'CITADEL FEED', hp: 4.4e6,
    }),

    mod('computer', 'computer', 'FIRE DIRECTOR', 'citadel', [0, -4, 6], {
      half: [5.0, 3.0, 4.6], hp: 5.0e7, vuln: 1.4, sys: 'COMPUTE',
      needs: { power: 'p.citadel', coolant: 'l.fwd' }, draw: 70, priority: 9,
      heat: 240, critical: true,
    }),
    mod('computer_aux', 'computer', 'AUXILIARY CONTROL', 'coredeck', [0, 4, -12], {
      half: [4.2, 2.6, 4.0], hp: 3.0e7, vuln: 1.4, sys: 'COMPUTE',
      needs: { power: 'p.ring', coolant: 'l.core' }, draw: 42, priority: 8, heat: 140,
    }),
    mod('sensor', 'sensor', 'TARGETING MAST', 'prow', [0, 4.4, 3.5], {
      half: [5.6, 3.8, 9.5], hp: 2.6e7, vuln: 1.8, sys: 'COMPUTE',
      needs: { power: 'p.fwd', data: 'd.main' , coolant: 'l.fwd' }, draw: 44, priority: 7, heat: 60,
    }),
    cond('c_data_main', 'data', 'src.computer', 'd.main', 'citadel', [7, -4, -4], {
      label: 'AVIONICS BUS', hp: 3.4e6, vuln: 2.6,
    }),
    cond('c_data_helm', 'data', 'src.computer', 'd.helm', 'citadel', [-7, -4, -4], {
      label: 'HELM BUS', hp: 3.4e6, vuln: 2.6, critical: true,
    }),
    cond('c_data_aux', 'data', 'src.computer_aux', 'd.main', 'coredeck', [9, 4, -12], {
      label: 'AUXILIARY LINK', hp: 3.4e6, vuln: 2.6,
    }),
    // See the cruiser: a second helm run from AUXILIARY CONTROL, on the
    // opposite side of the keel from the citadel run.
    cond('c_data_helm2', 'data', 'src.computer_aux', 'd.helm', 'coredeck', [-9, 4, -12], {
      label: 'AUX HELM RUN', hp: 3.4e6, vuln: 2.6,
    }),
    cond('c_data_fireL', 'data', 'd.main', 'd.fireL', 'batteryLF', [6, 2.6, 6], {
      label: 'PORT DIRECTOR LINK', hp: 3.0e6, vuln: 2.8,
    }),
    cond('c_data_fireR', 'data', 'd.main', 'd.fireR', 'batteryRF', [-6, 2.6, 6], {
      label: 'STBD DIRECTOR LINK', hp: 3.0e6, vuln: 2.8,
    }),
    cond('c_data_eng', 'data', 'd.main', 'd.eng', 'engineering', [-12, 12, -18], {
      label: 'DAMAGE CONTROL BUS', hp: 3.0e6, vuln: 2.6,
    }),

    // Casualty routing. The power ring was already right; the other two
    // networks were trees hanging off it.
    tie('c_tie_citadel', 'power', 'p.ring', 'p.citadel', 'citadel', [6, -6, -12], {
      label: 'CITADEL ALTERNATE', cap: 0.5,
    }),
    tie('c_tie_fire', 'data', 'd.fireR', 'd.fireL', 'spine', [0, 14, 10], {
      label: 'DIRECTOR CROSS-TIE', cap: 0.6,
    }),
    tie('c_tie_eng', 'data', 'd.fireR', 'd.eng', 'engineering', [12, 12, -18], {
      label: 'DC ALTERNATE', cap: 0.5,
    }),
    tie('l_tie_core', 'coolant', 'l.core', 'l.aft', 'engineering', [0, -14, -18], {
      label: 'MAIN CROSS-CONNECT', cap: 0.55, leak: 0.1,
    }),
    tie('l_tie_fwd', 'coolant', 'l.aft', 'l.fwd', 'magdeck', [0, -6, 0], {
      label: 'FORWARD CROSS-CONNECT', cap: 0.5, leak: 0.1,
    }),
    tie('l_tie_bat', 'coolant', 'l.batF', 'l.batA', 'coredeck', [8, -6, 12], {
      label: 'BATTERY CROSS-CONNECT', cap: 0.5, leak: 0.1,
    }),

    mod('shieldgen', 'shieldGen', 'PRIMARY PROJECTOR', 'spine', [0, 8, 8], {
      half: [9, 7, 9], hp: 1.1e8, sys: 'DEFENCE',
      needs: { power: 'p.ring', coolant: 'l.core' }, draw: 480, priority: 4, heat: 1400,
    }),
    mod('shieldcap_f', 'shieldGen', 'PROW AMPLIFIER', 'fwdhold', [0, 4, 12], {
      half: [6, 4, 5], hp: 5.0e7, sys: 'DEFENCE',
      needs: { power: 'p.fwd', coolant: 'l.fwd' }, draw: 200, priority: 3, heat: 620,
    }),
    mod('shieldcap_a', 'shieldGen', 'AFT AMPLIFIER', 'engineering', [0, 12, -18], {
      half: [6, 4, 5], hp: 5.0e7, sys: 'DEFENCE',
      needs: { power: 'p.ring', coolant: 'l.aft' }, draw: 200, priority: 3, heat: 620,
    }),

    ...driveUnit('A', 'drivebay', {
      label: 'PORT MAIN', pos: [9, 0, -6], half: [7, 6.4, 8], hp: 1.4e8,
      power: 'p.ring', cool: 'l.aft', draw: 210, heat: 2100, share: 0.5,
      fuelSection: 'engineering', fuelPos: [12, 3, 10], fuelHalf: [6, 7, 12],
      fuelHp: 6.0e7, leak: 0.07,
    }),
    ...driveUnit('B', 'drivebay', {
      label: 'STBD MAIN', pos: [-9, 0, -6], half: [7, 6.4, 8], hp: 1.4e8,
      power: 'p.ring', cool: 'l.aft', draw: 210, heat: 2100, share: 0.5,
      fuelSection: 'engineering', fuelPos: [-12, 3, 10], fuelHalf: [6, 7, 12],
      fuelHp: 6.0e7, leak: 0.07,
    }),
    mod('rcs_fwd', 'rcs', 'PROW RCS', 'prow', [0, -5.2, -11], {
      r: 4.2, hp: 3.0e7, sys: 'PROPULSION',
      needs: { power: 'p.fwd' }, draw: 52, priority: 8,
      extra: { axes: [1, 1, 0.15], lat: [1, 1, 0] },
    }),
    mod('rcs_aft', 'rcs', 'AFT RCS', 'reactorroom', [0, 10.0, -14], {
      r: 5.2, hp: 3.0e7, sys: 'PROPULSION',
      needs: { power: 'p.ring' }, draw: 52, priority: 8,
      extra: { axes: [1, 1, 0.15], lat: [1, 1, 1] },
    }),
    mod('rcs_wingL', 'rcs', 'PORT ROLL JETS', 'batteryLF', [0, 0, -17], {
      r: 4.4, hp: 2.0e7, sys: 'PROPULSION',
      needs: { power: 'p.port' }, draw: 28, priority: 8,
      extra: { axes: [0.1, 0.1, 1], lat: [1, 1, 0] },
    }),
    mod('rcs_wingR', 'rcs', 'STBD ROLL JETS', 'batteryRF', [0, 0, -17], {
      r: 4.4, hp: 2.0e7, sys: 'PROPULSION',
      needs: { power: 'p.stbd' }, draw: 28, priority: 8,
      extra: { axes: [0.1, 0.1, 1], lat: [1, 1, 0] },
    }),

    mod('pump', 'pump', 'PRIMARY PUMP', 'reactorroom', [-12, -9, 12], {
      r: 5, hp: 3.0e7, sys: 'THERMAL',
      needs: { power: 'p.ring' }, draw: 36, priority: 7,
    }),
    mod('pump_aux', 'pump', 'FORWARD PUMP', 'fwdhold', [-12, -6, -12], {
      r: 4, hp: 2.2e7, sys: 'THERMAL',
      needs: { power: 'p.fwd' }, draw: 26, priority: 6,
    }),
    mod('pump_aft', 'pump', 'AFT PUMP', 'engineering', [12, -12, -18], {
      r: 4, hp: 2.2e7, sys: 'THERMAL',
      needs: { power: 'p.ring' }, draw: 26, priority: 6,
    }),
    mod('rad_LF', 'radiator', 'PORT RADIATOR FWD', 'batteryLF', [-2.4, 2.9, -3.0], {
      half: [5.2, 0.7, 14.0], hp: 2.2e7, vuln: 1.6, sys: 'THERMAL',
      extra: { reject: 0.25 },
    }),
    mod('rad_RF', 'radiator', 'STBD RADIATOR FWD', 'batteryRF', [2.4, 2.9, -3.0], {
      half: [5.2, 0.7, 14.0], hp: 2.2e7, vuln: 1.6, sys: 'THERMAL',
      extra: { reject: 0.25 },
    }),
    mod('rad_LA', 'radiator', 'PORT RADIATOR AFT', 'batteryLA', [-2.4, 2.9, -3.0], {
      half: [5.2, 0.7, 14.0], hp: 2.2e7, vuln: 1.6, sys: 'THERMAL',
      extra: { reject: 0.25 },
    }),
    mod('rad_RA', 'radiator', 'STBD RADIATOR AFT', 'batteryRA', [2.4, 2.9, -3.0], {
      half: [5.2, 0.7, 14.0], hp: 2.2e7, vuln: 1.6, sys: 'THERMAL',
      extra: { reject: 0.25 },
    }),
    // A dreadnought makes nearly twice the heat its four wing panels can reject
    // — it settled at 110 C and 80% of rating parked and undamaged. Spread fore
    // and aft, dorsal and keel, so no single attack angle takes the whole heat
    // rejection system with it.
    mod('rad_D1', 'radiator', 'DORSAL RADIATOR FWD', 'spine', [0, 15, -8], {
      half: [8.0, 0.7, 12.0], hp: 2.0e7, vuln: 1.6, sys: 'THERMAL',
      extra: { reject: 0.22 },
    }),
    mod('rad_D2', 'radiator', 'DORSAL RADIATOR AFT', 'engineering', [0, 15, -10], {
      half: [8.0, 0.7, 14.0], hp: 2.0e7, vuln: 1.6, sys: 'THERMAL',
      extra: { reject: 0.22 },
    }),
    mod('rad_V1', 'radiator', 'KEEL RADIATOR FWD', 'magdeck', [0, -6, -6], {
      half: [8.0, 0.7, 14.0], hp: 2.0e7, vuln: 1.6, sys: 'THERMAL',
      extra: { reject: 0.22 },
    }),
    mod('rad_V2', 'radiator', 'KEEL RADIATOR AFT', 'reactorroom', [0, -14, 0], {
      half: [8.0, 0.7, 14.0], hp: 2.0e7, vuln: 1.6, sys: 'THERMAL',
      extra: { reject: 0.22 },
    }),
    cond('l_core', 'coolant', 'src.pump', 'l.core', 'reactorroom', [12, -9, 12], {
      label: 'CORE LOOP', hp: 5.0e6, leak: 0.14,
    }),
    cond('l_aft', 'coolant', 'src.pump_aft', 'l.aft', 'engineering', [-12, -12, -18], {
      label: 'DRIVE LOOP', hp: 4.6e6, leak: 0.13,
    }),
    cond('l_fwd', 'coolant', 'src.pump_aux', 'l.fwd', 'fwdhold', [12, -6, -12], {
      label: 'FORWARD LOOP', hp: 4.6e6, leak: 0.12,
    }),
    cond('l_batF', 'coolant', 'l.fwd', 'l.batF', 'spine', [0, -14, 16], {
      label: 'FWD BATTERY LOOP', hp: 4.2e6, leak: 0.11,
    }),
    cond('l_batA', 'coolant', 'l.core', 'l.batA', 'coredeck', [0, -6, 12], {
      label: 'AFT BATTERY LOOP', hp: 4.2e6, leak: 0.11,
    }),

    mod('lifesupport', 'lifeSupport', 'LIFE SUPPORT', 'coredeck', [13.7, 5, 12], {
      half: [4.4, 3.4, 5.0], hp: 3.0e7, sys: 'LIFE',
      needs: { power: 'p.fwd' }, draw: 60, priority: 9, extra: { rate: 0.045 },
    }),
    mod('lifesupport_b', 'lifeSupport', 'AUX SCRUBBERS', 'fwdhold', [13.2, 5, -12], {
      half: [4.4, 3.4, 5.0], hp: 2.6e7, sys: 'LIFE',
      needs: { power: 'p.ring' }, draw: 50, priority: 8, extra: { rate: 0.038 },
    }),
    mod('quarters', 'quarters', 'CREW DECKS', 'fwdhold', [0, 0, 2], {
      half: [12, 7, 11], hp: 5.0e7, sys: 'LIFE',
      needs: { power: 'p.fwd' }, draw: 18, priority: 5,
    }),
    mod('cargo_A', 'cargo', 'FORWARD STORES', 'fwdhold', [-12, -5, 12], {
      half: [5, 4.4, 6], hp: 2.6e7, sys: 'LOGISTICS',
      extra: { spares: 3200 },
    }),
    mod('cargo_B', 'cargo', 'AFT STORES', 'engineering', [-14, -9, -18], {
      half: [5, 4.4, 6], hp: 2.6e7, sys: 'LOGISTICS',
      extra: { spares: 2600 },
    }),

    ...battery('fwd', 'fwdbattery', {
      label: 'FORWARD TURRET', weapon: 'railgun',
      magPos: [0, -8, 0], magHalf: [9, 5, 9], magHp: 4.4e7,
      rounds: 3200, cookoff: 1.8e9,
      hoistPos: [9, -1, -8], hoistHp: 4.4e6,
      gunPos: [0, 12, 9], gunHp: 6.0e7,
      from: 'p.fwd', data: 'd.main', cool: 'l.fwd', dir: [0, 0, 1], arc: 0.32,
      draw: 66, heat: 520,
    }),
    ...battery('bLF', 'batteryLF', {
      label: 'PORT BROADSIDE FWD', weapon: 'railgun',
      magPos: [0, -2.2, -8], magHalf: [4.6, 1.9, 8], magHp: 3.0e7,
      rounds: 2000, cookoff: 1.1e9,
      hoistPos: [5, 0, 0], hoistHp: 4.0e6,
      gunPos: [-3, 3.4, 12], gunHp: 4.4e7,
      from: 'p.port', data: 'd.fireL', cool: 'l.batF', dir: [0.24, 0, 1], arc: 0.48,
      draw: 52, heat: 440,
    }),
    ...battery('bRF', 'batteryRF', {
      label: 'STBD BROADSIDE FWD', weapon: 'railgun',
      magPos: [0, -2.2, -8], magHalf: [4.6, 1.9, 8], magHp: 3.0e7,
      rounds: 2000, cookoff: 1.1e9,
      hoistPos: [-5, 0, 0], hoistHp: 4.0e6,
      gunPos: [3, 3.4, 12], gunHp: 4.4e7,
      from: 'p.stbd', data: 'd.fireR', cool: 'l.batF', dir: [-0.24, 0, 1], arc: 0.48,
      draw: 52, heat: 440,
    }),
    ...battery('bLA', 'batteryLA', {
      label: 'PORT BROADSIDE AFT', weapon: 'plasma',
      magPos: [0, -2.2, -8], magHalf: [4.6, 1.9, 8], magHp: 3.0e7,
      rounds: 1200, cookoff: 8.0e8,
      hoistPos: [5, 0, 0], hoistHp: 4.0e6,
      gunPos: [-3, 3.4, 12], gunHp: 4.4e7,
      from: 'p.port', data: 'd.fireL', cool: 'l.batA', dir: [0.24, 0, 1], arc: 0.48,
      draw: 70, heat: 560,
    }),
    ...battery('bRA', 'batteryRA', {
      label: 'STBD BROADSIDE AFT', weapon: 'plasma',
      magPos: [0, -2.2, -8], magHalf: [4.6, 1.9, 8], magHp: 3.0e7,
      rounds: 1200, cookoff: 8.0e8,
      hoistPos: [-5, 0, 0], hoistHp: 4.0e6,
      gunPos: [3, 3.4, 12], gunHp: 4.4e7,
      from: 'p.stbd', data: 'd.fireR', cool: 'l.batA', dir: [-0.24, 0, 1], arc: 0.48,
      draw: 70, heat: 560,
    }),
    mod('mag_tor', 'magazine', 'TORPEDO STOWAGE', 'magdeck', [0, 0, 0], {
      half: [12, 5, 11], hp: 5.0e7, vuln: 1.8, sys: 'ORDNANCE',
      extra: { rounds: 120, cookoff: 2.4e9 },
    }),
    hp_('hp_tor', 'TORPEDO TUBES', 'magdeck', [0, -6, 18], {
      weapon: 'torpedo', mount: 'large', dir: [0, -0.03, 1], arc: 0.22,
      needs: { power: 'p.fwd', data: 'd.main' , coolant: 'l.core' }, feed: 'mag_tor',
      draw: 16, heat: 60, hp: 4.0e7,
    }),
    hp_('hp_ion', 'ION PROJECTOR', 'prow', [0, -9, 14], {
      weapon: 'ion', mount: 'large', dir: [0, -0.03, 1], arc: 0.16,
      needs: { power: 'p.fwd', data: 'd.main', coolant: 'l.fwd' },
      draw: 150, heat: 600, hp: 3.4e7,
    }),
    hp_('hp_pdA', 'POINT DEFENCE A', 'spine', [12, 16, -16], {
      weapon: 'repeater', mount: 'small', dir: [0.35, 0.4, 0.6], arc: 1.2,
      needs: { power: 'p.ring', data: 'd.main', coolant: 'l.core' }, feed: 'mag_fwd',
      draw: 8, heat: 80, hp: 1.6e7,
    }),
    hp_('hp_pdB', 'POINT DEFENCE B', 'spine', [-12, 16, -16], {
      weapon: 'repeater', mount: 'small', dir: [-0.35, 0.4, 0.6], arc: 1.2,
      needs: { power: 'p.ring', data: 'd.main', coolant: 'l.core' }, feed: 'mag_fwd',
      draw: 8, heat: 80, hp: 1.6e7,
    }),
    // Up and forward, for the reason given on the MERIDIAN's.
    hp_('hp_pdC', 'POINT DEFENCE C', 'engineering', [0, 16, 22], {
      weapon: 'repeater', mount: 'small', dir: [0, 0.6, 0.6], arc: 1.3,
      needs: { power: 'p.ring', data: 'd.main', coolant: 'l.aft' }, feed: 'mag_bLA',
      draw: 8, heat: 80, hp: 1.6e7,
    }),
  ],
  crew: [
    { id: 'div_bridge', name: 'BRIDGE WATCH', post: 'citadel', role: 'pilot', size: 60 },
    { id: 'div_gunF', name: 'GUNNERY FORWARD', post: 'fwdbattery', role: 'gunner', size: 120 },
    { id: 'div_gunL', name: 'GUNNERY PORT', post: 'batteryLF', role: 'gunner', size: 95 },
    { id: 'div_gunR', name: 'GUNNERY STBD', post: 'batteryRF', role: 'gunner', size: 95 },
    { id: 'div_eng', name: 'ENGINEERING', post: 'engineering', role: 'engineer', size: 170 },
    { id: 'div_react', name: 'REACTOR WATCH', post: 'reactorroom', role: 'engineer', size: 110 },
    { id: 'div_dcA', name: 'DAMAGE CONTROL A', post: 'spine', role: 'damage', size: 140 },
    { id: 'div_dcB', name: 'DAMAGE CONTROL B', post: 'coredeck', role: 'damage', size: 150 },
    { id: 'div_dcC', name: 'DAMAGE CONTROL C', post: 'fwdhold', role: 'damage', size: 110 },
  ],
};

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
    const barrel = Math.max(...(MUZZLES[m.weapon] || [[0, 0, 2]])
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

function boundingRadius(spec) {
  let r = 0;
  for (const s of spec.sections) {
    const d = Math.hypot(
      Math.abs(s.pos[0]) + s.half[0],
      Math.abs(s.pos[1]) + s.half[1],
      Math.abs(s.pos[2]) + s.half[2],
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
  const radius = boundingRadius(spec);
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
    /** Longest dimension, used for the radar blip and range read-outs. */
    length: 2 * Math.max(...spec.sections.map((s) => Math.abs(s.pos[2]) + s.half[2])),
  };
}

export const HULLS = {
  sabre: compile(SABRE),
  halberd: compile(HALBERD),
  meridian: compile(MERIDIAN),
  bastion: compile(BASTION),
};

export const HULL_IDS = Object.keys(HULLS);
