// -----------------------------------------------------------------------------
// selfcheck.js — headless assertions over the simulation.
//
// `node test/selfcheck.js`. No framework, no fixtures: it drives the real
// Systems and Crew classes with no renderer attached and asserts the behaviours
// that would be expensive to notice by flying around. If a change breaks the
// network solver, the shield model, decompression or the crew's pathing, this
// says so in under a second.
// -----------------------------------------------------------------------------
import { HULLS, ENGAGEMENT_RANGE } from '../src/ship/hulls.js';
import { Systems, ATMO_CRITICAL } from '../src/ship/systems.js';
import { Crew } from '../src/ship/crew.js';
import { Body, Autopilot } from '../src/ship/flight.js';
import { WEAPONS, AMMO, MOUNTS } from '../src/weapons/defs.js';
import { Ballistics } from '../src/weapons/ballistics.js';
import { Ship, MOUNT_DEPRESSION } from '../src/ship/ship.js';
import { Pilot } from '../src/ship/ai.js';
import { Euler, Quaternion, Vector3, Color } from 'three';
import { PARTS, MUZZLES, PIVOTS } from '../src/world/kit.js';
import {
  mountFrame, mountStyle, partGeometry, shellGeometry, skinFraction, SHELL_STYLES,
} from '../src/world/hardware.js';
import {
  skyColour, MOODS, Space, CAMERA_NEAR, CAMERA_FAR, STAR_SHELL, SKY_SHELL,
} from '../src/world/space.js';

let passed = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(name, actual, expected, tol) {
  ok(name, Math.abs(actual - expected) <= tol, `got ${actual}, wanted ${expected}±${tol}`);
}

/** Advance a Systems instance by `seconds` at the real step size. */
function run(sys, seconds, crew = null) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    sys.tick(dt);
    if (crew) {
      crew.tick(dt);
    }
  }
}

const fresh = (id = 'meridian') => new Systems(HULLS[id]);

// --- hull tables ------------------------------------------------------------
for (const [id, h] of Object.entries(HULLS)) {
  ok(`${id}: is a capital ship`, h.mass > 3e6 && h.length > 80);
  ok(`${id}: inertia is positive on every axis`, h.inertia.every((v) => v > 0));
  ok(`${id}: roll is the easiest axis`, h.inertia[2] < h.inertia[0]);
  ok(`${id}: every crew post exists`, h.crew.every((c) => h.sectionById[c.post]));
  ok(`${id}: crew numbers in the dozens or hundreds`, h.crewTotal >= 80);
  // The field has to enclose the ship. When it did not, every hull's bow,
  // stern and drive bay stood outside its own bubble, so axial fire bypassed
  // the shield entirely and the drives — which are most of what decides a kill
  // — were never protected at all.
  {
    const r = h.shield.radii;
    let worst = 0;
    let worstId = '';
    for (const s of h.sections) {
      let q = 0;
      for (let k = 0; k < 3; k++) {
        const e = (Math.abs(s.pos[k] - h.com[k]) + s.half[k]) / r[k];
        q += e * e;
      }
      if (Math.sqrt(q) > worst) {
        worst = Math.sqrt(q);
        worstId = s.id;
      }
    }
    ok(`${id}: every compartment sits inside the shield ellipsoid`, worst <= 1,
      `"${worstId}" is at ${worst.toFixed(2)}x the field radius`);
  }
  ok(`${id}: control authority is derived, not authored`,
    h.flight.torque.every((t) => t > 0) && h.flight.mainThrust > 0);
  // The whole point of the rescale: a target crossing at engagement range
  // must sweep slower than a turret can traverse, or it cannot be hit.
  const sweep = HULLS.sabre.flight.maxSpeed / ENGAGEMENT_RANGE;
  // Either the hull out-turns that sweep, or it carries mounts that traverse
  // independently. A dreadnought does not aim by turning the ship.
  const turrets = h.hardpoints.some((w) => w.arc > 0.3);
  ok(`${id}: can hold a picket crossing at engagement range`,
    h.flight.yawRate > sweep * 1.5 || turrets,
    `hull ${(h.flight.yawRate * 57.3).toFixed(1)} deg/s vs sweep `
    + `${(sweep * 57.3).toFixed(1)} deg/s, turrets=${turrets}`);
}

// --- networks ---------------------------------------------------------------
{
  const sys = fresh();
  run(sys, 0.5);
  ok('power reaches the forward bus', sys.online.power.has('p.fwd'));
  ok('coolant reaches the core loop', sys.online.coolant.has('l.core'));
  ok('data reaches fire control', sys.online.data.has('d.fireF'));

  // HALYARD has two independent routes forward. One cut should cost nothing.
  sys.damageModule('c_dorsal', 1e12);
  run(sys, 0.2);
  ok('one of two parallel runs cut: forward bus still live', sys.online.power.has('p.fwd'));
  sys.damageModule('c_keel', 1e12);
  run(sys, 0.2);
  // Both mains gone, and the bus does NOT go dark: it falls back through the
  // bridge alternate and everything on it runs derated. Losing both trunks
  // used to switch the bow of the ship off — sensors, forward battery, bridge
  // feed — which is not how anything this size is wired. The cost of the
  // fallback is capability, not capability-or-nothing.
  const level = sys.online.power.get('p.fwd') || 0;
  ok('both mains cut: the forward bus falls back on the tie', level > 0 && level < 1,
    `level ${level}`);
  ok('...and the sensor on it is degraded, not dead',
    sys.get('sensor').eff > 0.1 && sys.get('sensor').eff < 0.9,
    `eff ${sys.get('sensor').eff.toFixed(2)}`);
  ok('...but the aft bus is at full service', sys.online.power.get('p.main') === 1);
  // Cut the tie as well and the bow really is dark. Three runs in three
  // compartments is a fair price for that.
  sys.damageModule('c_tie_bridge', 1e12);
  run(sys, 0.2);
  ok('...and cutting the tie too finally kills it', !sys.online.power.has('p.fwd'));
}
{
  // The BASILISK's ring should survive any single cut and fail on the right pair.
  const sys = fresh('bastion');
  run(sys, 0.5);
  ok('ring: port bus live at rest', sys.online.power.has('p.port'));
  sys.damageModule('c_ring_portA', 1e12);
  run(sys, 0.2);
  ok('ring: one leg cut, port bus still fed the long way', sys.online.power.has('p.port'));
  sys.damageModule('c_ring_portB', 1e12);
  run(sys, 0.2);
  ok('ring: both legs cut, port bus dead', !sys.online.power.has('p.port'));
  ok('ring: starboard bus untouched', sys.online.power.has('p.stbd'));
}
{
  // A pump with no power moves no coolant, even with perfect pipes.
  const sys = fresh();
  run(sys, 0.5);
  const before = sys.online.coolant.has('l.core');
  // Both plants feed the main bus, so both ties have to go.
  sys.damageModule('c_react_main', 1e12);
  sys.damageModule('c_aux_main', 1e12);
  run(sys, 0.5);
  ok('coolant loop needs a POWERED pump, not just intact pipe',
    before && !sys.online.coolant.has('l.core'));
}

// --- power budget -----------------------------------------------------------
{
  const sys = fresh();
  run(sys, 1);
  ok('supply covers demand when healthy', sys.supply >= sys.demand,
    `${sys.supply.toFixed(1)} vs ${sys.demand.toFixed(1)}`);
  // Cripple the reactor and drain the buffer; the shields (priority 3-4) should
  // shed before the computer and the drives (priority 8-9).
  const reactor = sys.get('reactor');
  reactor.hp = reactor.maxHp * 0.18;
  sys.capStore = 0;
  run(sys, 3);
  ok('brownout sheds the shield projector', sys.get('shieldgen').shed);
  ok('brownout does NOT shed the computer', !sys.get('computer').shed);
  // The invariant that actually matters is ordering: nothing may be shed while
  // something less important is still drawing. Which specific items survive is
  // a function of how deep the hole is, not something to pin down.
  let lowestKept = Infinity;
  let highestShed = -Infinity;
  for (const m of sys.modules.values()) {
    if (m.def.draw <= 0 || m.destroyed) {
      continue;
    }
    if (m.shed) {
      highestShed = Math.max(highestShed, m.def.priority);
    } else {
      lowestKept = Math.min(lowestKept, m.def.priority);
    }
  }
  ok('load shedding is strictly by priority', highestShed <= lowestKept,
    `shed up to ${highestShed}, kept from ${lowestKept}`);
}

// --- no single run may end a branch -----------------------------------------
// Cut every conduit in turn and check nothing that needs service loses it.
// Seventy nodes across the four hulls used to hang off one run each: a cruiser
// lost its whole port battery, its fire control or its core cooling loop to one
// round in the right compartment. Runs marked `sole` are the deliberate
// exceptions — a gun hoist is meant to be the one feed to its own turret, and a
// picket's single computer is meant to be its weakness.
{
  for (const [id, hull] of Object.entries(HULLS)) {
    const needed = new Set();
    for (const m of hull.modules) {
      if (m.needs) {
        for (const [net, node] of Object.entries(m.needs)) {
          needed.add(`${net}:${node}`);
        }
      }
    }
    // Read straight out of the code rather than declared by any module.
    needed.add('data:d.helm');
    needed.add('data:d.eng');

    // Settle first, then cut, then re-solve the networks ALONE. Running the
    // clock after the cut makes this a lottery rather than a measurement: a
    // severed power run arcs into its own compartment, and on the MERIDIAN the
    // port feed shares a compartment with the hoist it feeds, so about one run
    // in five the arc took the hoist too and the assertion failed on a
    // secondary effect instead of on the topology it exists to check.
    const served = (cutId) => {
      const sys = new Systems(hull);
      run(sys, 0.6);
      if (cutId) {
        sys.damageModule(cutId, 1e12);
      }
      sys._tickNetworks();
      return sys.online;
    };
    const base = served(null);
    const orphaned = [];
    for (const c of hull.modules.filter((m) => m.kind === 'conduit' && !m.sole)) {
      const after = served(c.id);
      for (const node of base[c.net].keys()) {
        const key = `${c.net}:${node}`;
        if (needed.has(key) && !(after[c.net].get(node) > 0)) {
          orphaned.push(`${c.id} -> ${key}`);
        }
      }
    }
    ok(`${id}: no single run isolates anything`, orphaned.length === 0,
      orphaned.slice(0, 3).join('; '));
  }
}

// --- transients are what the capacitor is FOR -------------------------------
// Bus quality used to sag the moment demand passed the reactor's steady output,
// regardless of whether anything actually went unsupplied. Since `busQuality`
// multiplies every powered module's efficiency, that meant lighting the drives
// quietly derated the entire ship — the visible symptom being the sensor array
// losing reach whenever the engines were used, on a cruiser with a full
// capacitor bank. A charged buffer covering a burn IS the bus holding voltage.
{
  const sys = fresh();
  run(sys, 2);
  const rested = sys.sensorQuality();
  ok('sensors are at full quality at rest', rested > 0.99, `${rested.toFixed(3)}`);
  // Everything that draws on demand, at full duty: both drives, every jet and
  // every gun cycling at once — the heaviest transient the ship can produce.
  for (let t = 0; t < 3; t += 1 / 60) {
    for (const m of sys.modules.values()) {
      if (m.kind === 'thruster' || m.kind === 'rcs' || m.kind === 'hardpoint') {
        m.duty = 1;
      }
    }
    sys.tick(1 / 60);
  }
  ok('a full burn really does outrun the reactor', sys.demand > sys.supply,
    `${sys.demand.toFixed(1)} MW vs ${sys.supply.toFixed(1)} MW`);
  ok('but the capacitor is carrying it', sys.capStore > 0);
  ok('so the sensors keep their reach under thrust',
    sys.sensorQuality() >= rested - 1e-6, `${sys.sensorQuality().toFixed(3)}`);
  // Flatten the buffer and the bus is genuinely short: now it should sag.
  sys.capStore = 0;
  for (let t = 0; t < 1; t += 1 / 60) {
    for (const m of sys.modules.values()) {
      if (m.kind === 'thruster' || m.kind === 'rcs' || m.kind === 'hardpoint') {
        m.duty = 1;
      }
    }
    sys.tick(1 / 60);
  }
  ok('an exhausted capacitor does drop the bus', sys.busQuality < 0.999,
    `${sys.busQuality.toFixed(3)}`);
}

// --- the painted sky ----------------------------------------------------------
// The bake is a loop of ramps and lobes whose two real failure modes are both
// invisible in code review: "too bright", which stops ships silhouetting, and
// "steps hard enough to contour", which is the defining artefact of the whole
// technique. Both are pure maths, so they check headless.
{
  const dirs = [];
  for (let i = 0; i < 4000; i++) {
    const z = (i / 3999) * 2 - 1;
    const a = i * 2.39996;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    dirs.push(new Vector3(r * Math.cos(a), z, r * Math.sin(a)));
  }
  const c0 = new Color();
  for (const [id, mood] of Object.entries(MOODS)) {
    let peak = 0;
    for (const d of dirs) {
      skyColour(d, mood, c0);
      peak = Math.max(peak, 0.2126 * c0.r + 0.7152 * c0.g + 0.0722 * c0.b);
    }
    // Relic's ceiling: the brightest sky sits near mid-grey. 0.28 linear is
    // about #8f8f8f on screen.
    ok(`sky "${id}" stays darker than a warship`, peak < 0.28,
      `peak luminance ${peak.toFixed(3)} linear`);
  }

  // Walk great circles and measure the 8-bit sRGB step per degree. More than a
  // level or three per degree and the gradient contours visibly.
  //
  // MANY circles, and every mood. This walked exactly one circle through one
  // mood, which is a coin flip rather than a test: the steepest thing on the
  // sphere is wherever the band's warped centre line happens to run, and a
  // single fixed circle can miss it entirely. It did — the check passed at 3
  // while a 40-circle sweep found 4 on the same palette.
  const c1 = new Color();
  const to8 = (v) => Math.round(255 * (v <= 0.0031308
    ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
  const ax = new Vector3();
  const up = new Vector3();
  const probe = new Vector3();
  const at = (deg) => {
    const t = (deg * Math.PI) / 180;
    return probe.copy(ax).multiplyScalar(Math.cos(t))
      .addScaledVector(up, Math.sin(t)).normalize();
  };
  for (const [id, mood] of Object.entries(MOODS)) {
    let maxStep = 0;
    for (let k = 0; k < 40; k++) {
      // Golden-angle spun basis, so the 40 circles are spread over the sphere
      // rather than sharing an axis.
      const az = k * 2.39996;
      ax.set(Math.cos(az), Math.sin(az) * 0.6, Math.sin(az) * 0.8).normalize();
      up.set(-Math.sin(az), Math.cos(az) * 0.3, Math.sin(az * 1.7))
        .cross(ax).normalize();
      for (let a = 0; a < 360; a++) {
        skyColour(at(a), mood, c0);
        skyColour(at(a + 1), mood, c1);
        maxStep = Math.max(maxStep,
          Math.abs(to8(c0.r) - to8(c1.r)),
          Math.abs(to8(c0.g) - to8(c1.g)),
          Math.abs(to8(c0.b) - to8(c1.b)));
      }
    }
    ok(`sky "${id}" gradient does not contour`, maxStep <= 3,
      `${maxStep} sRGB levels per degree`);
  }
}

// --- the backdrop ladder ------------------------------------------------------
// near < engagement < stars < sky < far. Every one of these failing is a silent
// visual break with no error attached: stars punching through a distant ship,
// or the whole sky clipped away by the far plane and the game rendering on
// black. Nothing else in the codebase states the relationship, so it lives here.
{
  ok('near plane is in front of everything', CAMERA_NEAR > 0
    && CAMERA_NEAR < ENGAGEMENT_RANGE);
  // Ships spawn out to ENGAGEMENT_RANGE * 2.8 (main.js). Stars are depth-tested,
  // so anything solid beyond the shell would punch a hole through the sky.
  ok('star shell clears the furthest spawn', STAR_SHELL > ENGAGEMENT_RANGE * 2.8 * 2,
    `stars ${STAR_SHELL}, furthest spawn ${ENGAGEMENT_RANGE * 2.8}`);
  ok('sky sits outside the stars', SKY_SHELL > STAR_SHELL);
  // Depth testing being off does not exempt a vertex from far-plane clipping.
  ok('far plane clears the sky', CAMERA_FAR > SKY_SHELL,
    `far ${CAMERA_FAR}, sky ${SKY_SHELL}`);
}

// --- the dust wrap ------------------------------------------------------------
// The wrap now runs in the vertex shader, where nothing headless can reach it.
// Space.wrap is the same expression in JS. If this drifts, dust either piles up
// in a slab on one side of the ship or vanishes entirely — both of which look
// like "the dust is broken" and neither of which points at a modulo.
{
  const span = 1300;
  const w = (d) => Space.wrap(d, span);
  ok('wrap leaves an in-range offset alone', w(500) === 500);
  ok('wrap leaves a negative in-range offset alone', w(-500) === -500);
  ok('wrap folds a mote off the front to the back', w(span + 200) === -span + 200);
  ok('wrap folds a mote off the back to the front', w(-span - 200) === span - 200);
  // The camera can be many cube-widths from where the motes were seeded, so the
  // fold has to survive arbitrary multiples, not just one.
  ok('wrap survives many cube widths', w(500 + span * 20) === 500);
  ok('wrap survives many negative cube widths', w(500 - span * 20) === 500);
  for (let i = -50; i <= 50; i += 0.37) {
    const d = i * span;
    ok(`wrap stays inside the cube at ${d.toFixed(0)}`, w(d) >= -span && w(d) < span);
  }
}

// --- shield facet attribution ------------------------------------------------
// Two code paths decide which facet a threat is on: the ray walk in
// gatherRayHits and the bearing lookup in faceFor, used by blasts. They once
// disagreed about the X axis — +X is PORT, and faceFor called it starboard — so
// a warhead off the port beam drained the wrong facet and the HUD named the
// wrong side of the ship. Pin both to the same answer.
{
  const ship = Object.create(Ship.prototype);
  ship.body = { quat: new Quaternion() };
  ship.shieldRadii = HULLS.meridian.shield.radii;
  const face = (x, y, z) => ship.faceFor(new Vector3(x, y, z));
  ok('faceFor: +X is the PORT facet', face(1, 0, 0) === 'port', face(1, 0, 0));
  ok('faceFor: -X is the STARBOARD facet', face(-1, 0, 0) === 'stbd', face(-1, 0, 0));
  ok('faceFor: +Y is DORSAL', face(0, 1, 0) === 'dorsal', face(0, 1, 0));
  ok('faceFor: -Y is VENTRAL', face(0, -1, 0) === 'ventral', face(0, -1, 0));
  ok('faceFor: +Z is FORE', face(0, 0, 1) === 'fore', face(0, 0, 1));
  ok('faceFor: -Z is AFT', face(0, 0, -1) === 'aft', face(0, 0, -1));
}

// --- shields ----------------------------------------------------------------
{
  const sys = fresh();
  run(sys, 1);
  const facet = sys.shield.facets.fore;
  const full = facet.charge;

  // Same energy, different delivery time: the field catches far more of the
  // slow one. This is the whole shield model in one assertion.
  const E = WEAPONS.railgun.energy;
  const beamThrough = sys.damageShield('fore', E, WEAPONS.beam.dwell);
  facet.charge = full;
  facet.load = 0;
  const slugThrough = sys.damageShield('fore', E, WEAPONS.railgun.dwell);
  ok('a shield catches a beam better than a slug', beamThrough < slugThrough,
    `beam let ${(beamThrough / 1e3).toFixed(0)} kJ through, slug ${(slugThrough / 1e3).toFixed(0)} kJ`);
  ok('a shield never fully stops a slug', slugThrough > E * 0.5);
  // At a beam's real per-tick energy the field should be absorbing nearly all
  // of it — that is what makes lasers the anti-shield weapon.
  facet.charge = full;
  facet.load = 0;
  const tick = WEAPONS.beam.dps / 60;
  const realBeam = sys.damageShield('fore', tick, WEAPONS.beam.dwell);
  ok('a shield absorbs most of a sustained beam', realBeam < tick * 0.25,
    `${((realBeam / tick) * 100).toFixed(0)}% got through`);
}
{
  // Failure mode one: dissipation overwhelmed. Pour energy in faster than the
  // radiators can shed it and the emitters saturate.
  const sys = fresh();
  run(sys, 1);
  const perTick = WEAPONS.beam.dps / 60;
  for (let i = 0; i < 60 * 200 && !sys.shield.facets.fore.down; i++) {
    sys.damageShield('fore', perTick * 4, WEAPONS.beam.dwell);
    sys.tick(1 / 60);
  }
  const f = sys.shield.facets.fore;
  ok('sustained fire takes a facet down', f.down);
  ok('...and names a physical cause', f.cause === 'SATURATED' || f.cause === 'COLLAPSED',
    String(f.cause));
}
{
  // Failure mode two: shooting the radiators. Same punishment, worse outcome,
  // because the emitters have nowhere to put what they catch.
  // Sustained fire at a beam's real output, measured in seconds survived.
  const secondsUnderBeam = (sys) => {
    const dt = 1 / 60;
    const perTick = WEAPONS.beam.dps * dt;
    let t = 0;
    while (!sys.shield.facets.fore.down && t < 90) {
      sys.damageShield('fore', perTick, WEAPONS.beam.dwell);
      sys.tick(dt);
      t += dt;
    }
    return t;
  };
  const healthy = fresh();
  run(healthy, 1);
  const withRads = secondsUnderBeam(healthy);

  const stripped = fresh();
  for (const r of ['rad_LF', 'rad_RF', 'rad_LA', 'rad_RA']) {
    stripped.damageModule(r, 1e12);
  }
  run(stripped, 1);
  const noRads = secondsUnderBeam(stripped);
  ok('killing the radiators makes shields fail much sooner', noRads < withRads * 0.6,
    `${noRads.toFixed(1)}s without radiators vs ${withRads.toFixed(1)}s with`);
  ok('a ship with radiators survives a beam for a useful while', withRads > 3,
    `${withRads.toFixed(1)}s`);
}
{
  // Ion: collapses the field without touching structure.
  //
  // "Without touching structure" means the pulse itself is not a structural
  // weapon — so the hull is read back with no tick in between. What follows in
  // the next few tenths of a second is not the weapon: a bus that has just been
  // hit that hard arcs, and arcing eats conduits. That is the modelled
  // consequence and it is wanted. This assertion used to run the clock 0.3 s
  // first and demand the hull be untouched to one part in a million, so it
  // failed on about a quarter of runs — the sim was right and the test was
  // asking the wrong question. It still bounds the arcing: a secondary effect
  // may cost wiring, it may not gut the ship.
  const sys = fresh();
  run(sys, 1);
  const hullBefore = sys.hullFraction();
  sys.ionPulse(WEAPONS.ion.energy * 4);
  near('ion pulse does no structural damage of its own', sys.hullFraction(), hullBefore, 1e-6);
  run(sys, 0.3);
  ok('ion pulse drops the shields', sys.shieldFraction() < 0.35);
  ok('arcing after an ion hit costs wiring, not the ship',
    sys.hullFraction() > hullBefore - 0.08,
    `hull ${sys.hullFraction().toFixed(4)} from ${hullBefore.toFixed(4)}`);
}

{
  // Regression: a facet that goes down has to be able to come back. Coming back
  // needs charge, and charge only arrives via the recharge pool — so if downed
  // facets are excluded from that pool the shield deadlocks off forever.
  const sys = fresh();
  run(sys, 1);
  const f = sys.shield.facets.fore;
  let guard = 0;
  while (!f.down && guard++ < 600) {
    sys.damageShield('fore', 4e5, WEAPONS.beam.dwell);
    sys.tick(1 / 60);
  }
  ok('the facet went down under fire', f.down);
  run(sys, 45);            // stop shooting and give it time
  ok('a downed facet recovers once the shooting stops', !f.down,
    `charge ${(f.charge / f.max).toFixed(2)} load ${(f.load / f.loadMax).toFixed(2)}`);
  ok('...and holds a useful charge again', f.charge > f.max * 0.5,
    `${(f.charge / f.max).toFixed(2)}`);
}

// --- perforation and decompression -----------------------------------------
{
  const sys = fresh();
  run(sys, 0.5);
  const sec = sys.section('bowarray');
  ok('compartment starts sealed', !sec.breached && sec.atmo > 0.99);
  ok('plate starts intact', sec.plateHp === sec.plateMax);
  // A round that passes clean through leaves a hole even at full plate health.
  sys.punchHole('bowarray', AMMO.ap.holeSize);
  ok('a through-and-through breaches a compartment at full plate health',
    sec.breached && sec.plateHp === sec.plateMax);
  run(sys, 140);
  ok('a perforated compartment vents', sec.atmo < ATMO_CRITICAL,
    `atmo ${sec.atmo.toFixed(2)}`);
  // ...and can be welded shut again.
  for (let i = 0; i < 40; i++) {
    sys.patchSection('bowarray', sys.section('bowarray').plateMax * 0.05);
  }
  ok('a breach can be patched', !sec.breached);
}

// --- fire -------------------------------------------------------------------
{
  const sys = fresh();
  run(sys, 0.5);
  ok('fire will not start without something to burn', !sys.ignite('spine', 8));
  sys.section('spine').spill = 0.8;
  ok('fire starts where fuel has spilled', sys.ignite('spine', 8));
  ok('fire is burning', sys.section('spine').fire > 0);
  // Venting the compartment smothers it: no oxygen, no fire.
  sys.ventSection('spine');
  run(sys, 6);
  ok('venting a compartment puts the fire out', sys.section('spine').fire === 0);
  ok('...by removing the atmosphere', sys.section('spine').atmo < ATMO_CRITICAL);
}
{
  // Fire eats conduits, which is how it costs you a network rather than health.
  const sys = fresh();
  run(sys, 0.5);
  sys.section('engineering').spill = 1;
  sys.ignite('engineering', 90);
  const before = sys.get('l_aft').hp;
  run(sys, 60);
  ok('fire burns through soft goods', sys.get('l_aft').hp < before * 0.5,
    `${(sys.get('l_aft').hp / before).toFixed(2)} of original`);
  ok('fire cannot touch a critical run', sys.get('c_react_main').hp
    === sys.get('c_react_main').maxHp);
}

// --- ordnance ---------------------------------------------------------------
{
  const sys = fresh();
  run(sys, 0.5);
  const mag = sys.get('mag_fwd');
  const spine = sys.section('fwdbattery');
  const plateBefore = spine.plateHp;
  sys._cookOff(mag, null);
  ok('cook-off empties the magazine', mag.rounds === 0 && mag.destroyed);
  ok('cook-off wrecks the compartment from inside', spine.plateHp < plateBefore);
  ok('cook-off starts a fire', spine.fire > 0);
}

// --- crew -------------------------------------------------------------------
{
  const sys = fresh();
  const crew = new Crew(HULLS.meridian, sys);
  run(sys, 0.5, crew);
  near('everyone starts aboard', crew.complement, 1, 1e-9);
  ok('the complement is a capital ship crew', crew.headcount >= 80,
    String(crew.headcount));
  ok('the bridge is manned', crew.station('pilot') > 0.9);

  const mod = sys.get('sensor');
  mod.hp = mod.maxHp * 0.25;
  const sparesBefore = sys.totalSpares();
  run(sys, 40, crew);
  ok('crew repair damage', mod.hp > mod.maxHp * 0.3, `hp ${(mod.hp / mod.maxHp).toFixed(2)}`);
  ok('repairs consume spares', sys.totalSpares() < sparesBefore);
  // Regression: spares were once drawn a whole unit per tick, which emptied
  // every locker aboard in well under a minute and made repair pointless.
  ok('spares are drawn in proportion to work done, not per tick',
    sys.totalSpares() > sparesBefore * 0.5,
    `${sparesBefore} -> ${sys.totalSpares()} after 40s of repair`);
}
{
  // Vacuum kills unsuited crew, and the survivors are the ones in suits.
  const sys = fresh();
  const crew = new Crew(HULLS.meridian, sys);
  run(sys, 0.5, crew);
  const helm = crew.divisions.find((d) => d.role === 'pilot');
  ok('the bridge watch is not in suits', !helm.suited);
  sys.section('bridge').atmo = 0;
  sys.section('bridge').breached = true;
  sys.section('bridge').breachSize = 1;
  run(sys, 14, crew);
  ok('vacuum thins or drives off an unsuited bridge watch',
    helm.size < helm.max || helm.at !== 'bridge',
    `size=${helm.size.toFixed(0)}/${helm.max} at=${helm.at}`);
  ok('losing the bridge costs the ship its helm station', crew.station('pilot') < 0.9);
}
{
  // A burning, airless compartment is a wall for the crew, not a corridor.
  const sys = fresh();
  const crew = new Crew(HULLS.meridian, sys);
  run(sys, 0.5, crew);
  const dc = crew.divisions.find((d) => d.role === 'damage');
  const openCost = crew._cost('spine', dc.suited);
  sys.section('spine').fire = 10;
  const burningCost = crew._cost('spine', dc.suited);
  ok('fire makes a compartment expensive to cross', burningCost > openCost * 3);
  sys.section('spine').atmo = 0;
  ok('unsuited crew will not cross vacuum at all',
    !Number.isFinite(crew._cost('spine', false)));
  ok('suited crew will, slowly', Number.isFinite(crew._cost('spine', true)));
}

// --- the shield read-out has to be able to report its own damage ------------
// `shieldFraction` is charge / current max, and killing a projector lowers that
// max — so charge and ceiling fall together and the ratio stays pinned near 1.
// A cruiser that had lost the amplifiers setting a third of its shield still
// read as a completely healthy shield, which made the gauge a player trusts
// most the one gauge that could not report the damage.
{
  const sys = fresh();
  run(sys, 2);
  ok('an undamaged shield reads full on both metrics',
    sys.shieldFraction() > 0.98 && sys.shieldRated() > 0.98);

  sys.damageModule('shieldcap_f', 1e12);
  sys.damageModule('shieldcap_a', 1e12);
  run(sys, 25);   // long enough for the facets to top up to the NEW ceiling
  ok('losing both amplifiers really does cost ceiling',
    Object.values(sys.shield.facets)[0].max * 6 < HULLS.meridian.shield.capacity * 0.85);
  ok('the old ratio cannot see it', sys.shieldFraction() > 0.95,
    `${(sys.shieldFraction() * 100).toFixed(0)}%`);
  ok('the rated read-out can', sys.shieldRated() < 0.85,
    `${(sys.shieldRated() * 100).toFixed(0)}%`);
}

// --- cooling is not a shield buff -------------------------------------------
// Shield dissipation scales with heat rejection, and heat rejection used to be
// an absolute figure that every hull happened to author to exactly 1.0 — so it
// doubled as "fraction of my panels still working" and nobody could tell the
// two apart. Fitting the MERIDIAN and BASTION the panels they need to hold
// thermal equilibrium took the dreadnought to 1.88 and, through that one
// number, took its fore facet from saturating in 7.5 s to surviving 400.
{
  for (const [id, hull] of Object.entries(HULLS)) {
    const sys = new Systems(hull);
    run(sys, 1);
    ok(`${id}: a full radiator complement is full, whatever it is made of`,
      Math.abs(sys.rejectFraction - 1) < 1e-9, `${sys.rejectFraction.toFixed(3)}`);
    const rads = [...sys.modules.values()].filter((m) => m.kind === 'radiator');
    sys.damageModule(rads[0].id, 1e12);
    run(sys, 0.2);
    ok(`${id}: and losing a panel still costs dissipation`,
      sys.rejectFraction < 1 && sys.rejectFraction > 0,
      `${sys.rejectFraction.toFixed(3)}`);
  }
}

// --- holding a shield is cheap; working one is not --------------------------
// Maintaining status should be a hotel service. The strain is meant to arrive
// when weapons, drives and a shield under fire compete for the same plant.
//
// It used to be the opposite: draw scaled with how much charge you were HOLDING
// and the full recharge bill was levied whether or not anything was recharging,
// so a full, quiet, undamaged field was the most expensive thing on the ship —
// 407 MW of a cruiser's 770 MW rating. Projector heat ignored duty entirely.
// Together those meant a parked, undamaged cruiser derated its own reactors to
// two thirds of rating and shed the amplifiers that set its shield ceiling.
{
  const hull = HULLS.meridian;
  const rated = hull.modules.filter((m) => m.kind === 'reactor')
    .reduce((a, m) => a + m.output, 0);
  const load = (sc) => {
    const sys = new Systems(hull);
    for (let i = 0; i < 300 * 60; i++) {
      for (const m of sys.modules.values()) {
        if (m.kind === 'thruster' || m.kind === 'rcs') { m.duty = sc.drive; }
        if (m.kind === 'hardpoint') { m.duty = sc.guns; }
      }
      if (sc.incoming) {
        for (const f of ['fore', 'port', 'dorsal']) {
          sys.damageShield(f, (WEAPONS.beam.dps / 60) * 0.9, 1 / 60);
        }
      }
      sys.tick(1 / 60);
    }
    return sys;
  };

  const rest = load({ drive: 0, guns: 0, incoming: 0 });
  ok('holding a full shield is a hotel load, not most of the plant',
    rest.demand < rated * 0.55, `${rest.demand.toFixed(0)} of ${rated} MW`);
  ok('...so a parked ship sheds nothing',
    [...rest.modules.values()].filter((m) => m.shed).length === 0);
  ok('...and keeps the shield ceiling it paid for',
    Object.values(rest.shield.facets)[0].max * 6 >= hull.shield.capacity * 0.98);

  // Any ONE of the three is comfortable.
  for (const [name, sc] of [
    ['drives', { drive: 1, guns: 0, incoming: 0 }],
    ['guns', { drive: 0, guns: 1, incoming: 0 }],
    ['a shield under fire', { drive: 0, guns: 0, incoming: 1 }],
  ]) {
    const sys = load(sc);
    ok(`${name} alone does not brown the ship out`, sys.demand < sys.supply,
      `${sys.demand.toFixed(0)} vs ${sys.supply.toFixed(0)} MW`);
  }

  // The recharge bill is split between the projectors DOING the recharging and
  // paid by exactly those. Dividing by the projector count while charging every
  // shieldGen aboard bills more than the pool ever spent — measured at 1.5x on
  // a cruiser with one crippled amplifier and two sound ones, and it lands in
  // precisely the degraded states the graded-service model exists to model.
  {
    const sys = new Systems(hull);
    run(sys, 2);
    const dud = sys.get('shieldcap_f');
    dud.hp = dud.maxHp * 0.005;
    for (const f of Object.values(sys.shield.facets)) { f.charge = f.max * 0.2; }
    run(sys, 0.5);
    const gens = [...sys.modules.values()].filter((m) => m.kind === 'shieldGen');
    const idle = gens.filter((m) => m.eff <= 0.02);
    const working = gens.filter((m) => m.eff > 0.02);
    ok('the crippled projector is out of the pool and the others are in it',
      idle.length === 1 && working.length >= 1);
    ok('a projector too far gone to hold field pays no recharge bill',
      idle.every((m) => Math.abs(m.drawNow - m.def.draw * m.duty) < 1e-9),
      idle.map((m) => (m.drawNow - m.def.draw * m.duty).toFixed(2)).join(','));
    ok('...and the working ones are still billed for it',
      working.every((m) => m.drawNow - m.def.draw * m.duty > 0));
  }

  // All three together is meant to hurt.
  const all = load({ drive: 1, guns: 1, incoming: 1 });
  ok('drives, guns and a shield under fire together DO strain the plant',
    all.demand > all.supply, `${all.demand.toFixed(0)} vs ${all.supply.toFixed(0)} MW`);
  ok('...enough to flatten the capacitor and start shedding',
    all.capStore < all.capMax * 0.05
      && [...all.modules.values()].filter((m) => m.shed).length > 0);
}

// --- a vented compartment is still a job ------------------------------------
// The narrow case, isolated from any cascade: one hole, nothing else wrong, and
// enough time for the compartment to finish venting before anyone reaches it.
// The old job filter was `s.breached && s.atmo > 0.03`, so the party stopped
// coming the moment the air ran out and the hole stayed open forever.
{
  const hull = HULLS.meridian;
  const sys = new Systems(hull);
  const crew = new Crew(hull, sys);
  run(sys, 2, crew);
  sys.punchHole('bowarray', 3);
  // Let it empty completely before anyone can get there.
  run(sys, 45, crew);
  ok('the compartment really did finish venting',
    sys.section('bowarray').atmo <= ATMO_CRITICAL,
    `atmo ${sys.section('bowarray').atmo.toFixed(3)}`);
  run(sys, 240, crew);
  ok('a fully vented breach still gets welded shut',
    !sys.section('bowarray').breached,
    `${sys.section('bowarray').breachSize.toFixed(2)} m2 still open`);
  run(sys, 120, crew);
  ok('...and re-pressurises once it is shut', sys.section('bowarray').atmo > 0.5,
    `atmo ${sys.section('bowarray').atmo.toFixed(2)}`);
}

// --- damage control does not give up ----------------------------------------
// A mauled ship with a full crew and full lockers has to be recoverable, or the
// spares, the parties and the whole repair model are decoration. Two things
// made it permanent: the patch job was filtered on `atmo > 0.03`, so a
// compartment that finished venting was never worked on again, and nothing
// anywhere restored `frameHp`, so a buckled frame was forever.
{
  const hull = HULLS.meridian;
  const sys = new Systems(hull);
  const crew = new Crew(hull, sys);
  run(sys, 2, crew);
  const wreck = ['c_main_batLF', 'c_dorsal', 'rad_LF', 'hp_bLF', 'sensor',
    'pump_aux', 'l_fwd', 'c_data_fireF', 'thruster_A', 'lifesupport'];
  for (const id of wreck) {
    sys.damageModule(id, 1e12, null, null);
  }
  sys.punchHole('batteryLF', 6);
  sys.punchHole('bowarray', 4);
  sys.damageSection('batteryLF', 6e7, null, null);

  const spares0 = sys.totalSpares();
  ok('the mauling actually took', [...sys.modules.values()].filter((m) => m.destroyed).length >= 8);
  ok('...and opened the hull', [...sys.sections.values()].filter((s) => s.breached).length >= 2);
  const buckled = [...sys.sections.values()].filter((s) => s.frameBroken).length;

  run(sys, 60, crew);

  run(sys, 900, crew);
  ok('every wrecked module is rebuilt from spares',
    [...sys.modules.values()].filter((m) => m.destroyed).length === 0,
    [...sys.modules.values()].filter((m) => m.destroyed).map((m) => m.id).join(', '));
  ok('every breach is welded shut, vented or not',
    [...sys.sections.values()].filter((s) => s.breached).length === 0,
    [...sys.sections.values()].filter((s) => s.breached).map((s) => s.id).join(', '));
  ok('and a buckled frame is shored back up',
    buckled === 0 || [...sys.sections.values()].filter((s) => s.frameBroken).length === 0);
  ok('recovery costs real stock', sys.totalSpares() < spares0 && sys.totalSpares() > 0,
    `${spares0} -> ${sys.totalSpares()}`);
  ok('a recovered ship reads as sound again', sys.integrity > 0.95,
    `${(sys.integrity * 100).toFixed(0)}%`);
}

// --- capability read-outs ---------------------------------------------------
{
  const sys = fresh();
  run(sys, 1);
  ok('a healthy ship can steer', sys.rcsAuthority()[0] > 0.9);
  sys.damageModule('rcs_fwd', 1e12);
  sys.damageModule('rcs_aft', 1e12);
  run(sys, 0.3);
  const auth = sys.rcsAuthority();
  ok('losing the pitch blocks costs pitch authority', auth[0] < 0.2, `pitch ${auth[0].toFixed(2)}`);
  ok('...but the sponson roll jets still work', auth[2] > 0.4, `roll ${auth[2].toFixed(2)}`);
}
{
  const sys = fresh();
  run(sys, 1);
  ok('a healthy ship has drive authority', sys.driveAuthority() > 0.9);
  sys.get('fuel_A').store = 0;
  sys.get('fuel_B').store = 0;
  run(sys, 0.3);
  ok('an empty ship does not move', sys.driveAuthority() < 0.05);
}
{
  const sys = fresh();
  run(sys, 1);
  ok('a healthy ship is not stricken', !sys.isStricken());
  sys.damageModule('reactor', 1e12);
  // Scram it rather than letting it roll for containment — this assertion is
  // about power redundancy, not about the detonation lottery.
  sys.get('reactor').breached = false;
  run(sys, 6);
  ok('losing the primary plant alone does NOT finish a cruiser', !sys.isStricken(),
    `the auxiliary is still making ${sys.supply.toFixed(0)} MW`);
  sys.damageModule('reactor_aux', 1e12);
  sys.get('reactor_aux').breached = false;
  run(sys, 6);
  ok('a ship with no power at all is stricken', sys.isStricken());
}

// --- weapon roster sanity ---------------------------------------------------
{
  ok('a mass driver slug carries far more energy than a repeater round',
    WEAPONS.railgun.energy > WEAPONS.repeater.energy * 10);
  ok('every weapon has a coupling time',
    Object.values(WEAPONS).every((w) => w.dwell > 0));
  ok('solid shot is the sharpest event a field sees',
    AMMO.ap.dwellMult < AMMO.sap.dwellMult && AMMO.sap.dwellMult < AMMO.he.dwellMult);
  ok('HE is a poor penetrator and AP is a good one', AMMO.he.ap > 2 && AMMO.ap.ap < 1);
}

// --- flight control law -----------------------------------------------------
// The rate loop is the one place where "derive, never author" can be silently
// undone: the hull tables promise a rate and a spool time, and the controller
// is the thing that has to deliver them. It once used a gain in absolute rad/s
// of error, which is fine at fighter rates and collapses at capital ones — full
// stick on the cruiser asked for 20% of available torque, and the first second
// of held yaw moved the nose 0.15 degrees. It read as a dead control, and no
// assertion here noticed. This one would have.
{
  for (const [id, h] of Object.entries(HULLS)) {
    const sys = fresh(id);
    const crew = new Crew(h, sys);
    run(sys, 1, crew);                       // let the reactors come up
    const body = new Body(h);
    const ap = new Autopilot(h, sys, crew);
    ap.cmd.assist = true;
    ap.cmd.yaw = 1;
    const dt = 1 / 60;
    for (let t = 0; t < h.flight.spool; t += dt) {
      sys.tick(dt);
      crew.tick(dt);
      ap.update(body, dt);
      body.integrate(dt);
    }
    // Sign is the controller's business (+yaw is a turn to starboard, which is
    // -omega.y in a +Z-forward right-handed frame); the magnitude is the
    // contract.
    const reached = Math.abs(body.omega.y) / h.flight.yawRate;
    ok(`${id}: full stick reaches its commanded rate within one spool`,
      reached > 0.85,
      `got ${(reached * 100).toFixed(0)}% of ${(h.flight.yawRate * 57.3).toFixed(2)} deg/s `
      + `after ${h.flight.spool}s`);
  }
}

// --- control redundancy ------------------------------------------------------
// A capital ship has no business losing steerage to one round through the
// bridge. The two big hulls carry a second computer AND a second helm run in a
// different compartment, so it takes two hits in two places. The frigate and
// the picket do not — that difference is meant to be felt.
{
  for (const id of ['meridian', 'bastion']) {
    const kill = (victims) => {
      const sys = fresh(id);
      run(sys, 1);
      for (const v of victims) {
        sys.damageModule(v, 1e12);
      }
      run(sys, 0.5);
      return sys.flightComputer;
    };
    ok(`${id}: survives losing the primary computer`, kill(['computer']));
    ok(`${id}: survives losing the primary helm run`, kill(['c_data_helm']));
    ok(`${id}: survives losing the whole bridge run and the aux computer's link`,
      kill(['computer', 'c_data_helm']));
    ok(`${id}: but loses control when BOTH computers are gone`,
      !kill(['computer', 'computer_aux']));
    ok(`${id}: and loses control when both helm runs are cut`,
      !kill(['c_data_helm', 'c_data_helm2']));
  }
  for (const id of ['sabre', 'halberd']) {
    const sys = fresh(id);
    run(sys, 1);
    sys.damageModule('c_data_helm', 1e12);
    run(sys, 0.5);
    ok(`${id}: a light hull has one helm run and loses it`, !sys.flightComputer);
  }
}

// --- manual helm -------------------------------------------------------------
// With no computer the ship cannot vector-null, but a crew can still point the
// nose retrograde and burn. Three things have to hold: it works, it only works
// when the drive is actually facing the drift, and it needs hands at the helm.
{
  const drill = ({ facing, killCrew }) => {
    const sys = fresh('meridian');
    const crew = new Crew(HULLS.meridian, sys);
    run(sys, 1, crew);
    if (killCrew) {
      for (const d of crew.members) {
        d.size = 0;
      }
    }
    const body = new Body(HULLS.meridian);
    const ap = new Autopilot(HULLS.meridian, sys, crew);
    ap.cmd.assist = true;
    ap.cmd.manual = true;
    ap.cmd.throttle = 0;
    // Bow at +Z. Retrograde-facing means travelling toward -Z; prograde-facing
    // means travelling toward +Z, where the main drive points the wrong way.
    body.vel.set(0, 0, facing === 'retrograde' ? -50 : 50);
    const dt = 1 / 60;
    for (let t = 0; t < 12; t += dt) {
      // Hold the computers dead: damage control would otherwise repair them
      // mid-drill and hand the ship back its flight assist, which is correct
      // behaviour in the game and ruins the measurement here.
      sys.damageModule('computer', 1e12);
      sys.damageModule('computer_aux', 1e12);
      sys.tick(dt);
      crew.tick(dt);
      ap.update(body, dt);
      body.integrate(dt);
    }
    return body.vel.length();
  };

  const braked = drill({ facing: 'retrograde' });
  const wrongWay = drill({ facing: 'prograde' });
  const noCrew = drill({ facing: 'retrograde', killCrew: true });
  ok('manual helm arrests drift with no flight computer', braked < 5,
    `${braked.toFixed(1)} m/s left of 50`);
  ok('manual helm cannot brake with the drive pointing the wrong way',
    wrongWay > braked * 3, `${wrongWay.toFixed(1)} m/s vs ${braked.toFixed(1)}`);
  ok('manual helm needs hands at the helm', noCrew > 45,
    `${noCrew.toFixed(1)} m/s left of 50 with the watch dead`);
}

// --- what the hull actually feels -------------------------------------------
// Camera shake reads delta-v, not damage. The point of that is scale: the same
// round has to be imperceptible on a dreadnought and noticeable on a picket
// without anything being tuned per ship. If this ever stops holding, shake has
// drifted back to being a damage number wearing a physics costume.
{
  const slug = WEAPONS.railgun.mass * WEAPONS.railgun.muzzleVel;   // N.s
  const dv = (id) => slug / HULLS[id].mass;
  ok('a capital hull barely notices a slug',
    dv('bastion') < 1e-3 && dv('meridian') < 1e-3,
    `bastion ${dv('bastion').toExponential(2)}, meridian ${dv('meridian').toExponential(2)} m/s`);
  ok('a picket feels the same slug far more than a dreadnought does',
    dv('sabre') / dv('bastion') > 20,
    `${(dv('sabre') / dv('bastion')).toFixed(0)}x`);
  // And the other end: something letting go inside the hull has to outrank
  // shellfire by orders of magnitude, or nothing would ever shake at all.
  const cookoff = 4.0e10 * 1e-4;                                   // a big magazine
  ok('an internal detonation outranks shellfire by orders of magnitude',
    (cookoff / HULLS.meridian.mass) / dv('meridian') > 100,
    `${((cookoff / HULLS.meridian.mass) / dv('meridian')).toFixed(0)}x`);
}

// --- hardware ---------------------------------------------------------------
// The kit is generated by tools/kit_build.py and checked in as base64. Nothing
// at runtime validates it, so a truncated or mis-declared buffer would show up
// as silently missing geometry in the middle of a fight. It is cheap to catch
// here instead.
{
  for (const [name, p] of Object.entries(PARTS)) {
    const g = partGeometry(name);
    ok(`kit part ${name} decodes`, !!g);
    if (!g) {
      continue;
    }
    ok(`kit part ${name} has the declared vertex count`,
      g.getAttribute('position').count === p.v,
      `${g.getAttribute('position').count} vs ${p.v}`);
    ok(`kit part ${name} has the declared triangle count`,
      g.getIndex().count === p.t * 3, `${g.getIndex().count / 3} vs ${p.t}`);
    ok(`kit part ${name} indexes only vertices it has`,
      Math.max(...g.getIndex().array) < p.v);
    // Normals arrive as signed bytes and are useless if any came out zero.
    const n = g.getAttribute('normal').array;
    let degenerate = 0;
    for (let i = 0; i < n.length; i += 3) {
      if (n[i] === 0 && n[i + 1] === 0 && n[i + 2] === 0) {
        degenerate++;
      }
    }
    ok(`kit part ${name} has no zero normals`, degenerate === 0, `${degenerate}`);
  }

  // Every compartment style and every weapon in the armoury has to have
  // hardware, or a hull will silently render a box or a mount will be invisible.
  for (const style of SHELL_STYLES) {
    ok(`shell exists for style "${style}"`, !!shellGeometry(style));
  }
  const styles = new Set();
  for (const hull of Object.values(HULLS)) {
    for (const s of hull.sections) {
      styles.add(s.style);
    }
  }
  for (const s of styles) {
    ok(`hulls only use styles the kit models ("${s}")`, SHELL_STYLES.includes(s));
  }
  for (const w of Object.values(WEAPONS)) {
    ok(`${w.id} has a modelled gun`, !!PARTS[`gun_${w.id}`]);
    ok(`${w.id} has muzzle points`, Array.isArray(MUZZLES[w.id]) && MUZZLES[w.id].length > 0);
  }
  for (const style of ['turret', 'gimbal', 'fixed']) {
    ok(`mount style "${style}" has a base`, !!PARTS[`base_${style}`]);
    ok(`mount style "${style}" has a pivot height`, typeof PIVOTS[style] === 'number');
  }

  // Face selection. This is the part that is easy to get wrong and impossible
  // to notice from the numbers: a broadside battery sits near the bow end of
  // its compartment, so the NEAREST face is the bow face — and a turret bolted
  // there trains about its own barrel and stands the guns straight up.
  {
    const f = mountFrame([-2.0, 2.4, 8], [9.5, 8.0, 11.0], [0.22, 0, 1], 'hull');
    ok('a broadside battery is bolted to the deck, not to the bow face',
      f.up.y === 1, `up ${f.up.toArray()}`);
    ok('and it is stood out onto the plating',
      f.lift > 4 && f.lift < 8 - 2.4, `${f.lift}`);
    ok('with its rest bearing flattened into that deck',
      Math.abs(f.fwd.y) < 1e-9 && f.fwd.z > 0.9, `fwd ${f.fwd.toArray()}`);
  }
  {
    // A gimbal in the nose of a pod: here proximity SHOULD win, because the
    // bearing is square to the outboard face and parallel to the bow face.
    const f = mountFrame([-1.6, 0, 7.5], [4.5, 3.0, 9.0], [0, 0, 1], 'wing');
    ok('a pod gimbal sits on the outboard face', f.up.x === -1, `up ${f.up.toArray()}`);
  }
  {
    // Ventral ordnance stays ventral.
    const f = mountFrame([0, -4.2, 12], [11, 9, 16], [0, -0.04, 1], 'hull');
    ok('ventral tubes are bolted under the hull', f.up.y === -1, `up ${f.up.toArray()}`);
  }
  {
    // The taper case. A mount near the nose of a prow is authored OUTSIDE the
    // shell — the compartment box says the skin is at 13 m but the shell has
    // narrowed to 6 m by then — so the lift has to be negative and pull the
    // gun in. Getting this wrong leaves ordnance hanging in space off the bow.
    const f = mountFrame([0, -9, 14], [16, 13, 20], [0, -0.04, 1], 'prow');
    ok('a mount on a tapered bow is pulled in to the skin, not pushed out',
      f.lift < 0, `lift ${f.lift}`);
    const y = -9 + f.up.y * f.lift;
    ok('and it lands on the prow profile rather than on the bounding box',
      y > -7 && y < -5, `y ${y.toFixed(2)}`);
  }
  {
    // Flat-sided compartments must not be dragged around by the new profile.
    const f = mountFrame([0, 11, -10], [14, 11, 22], [0, 0.5, -0.5], 'hull');
    ok('a mount already on the skin of a flat compartment barely moves',
      Math.abs(f.lift) < 1.2, `lift ${f.lift}`);
  }

  // The frame's quaternion has to agree with the vectors it was built from, or
  // the rig will be posed in one basis and the muzzle solved in another.
  {
    const f = mountFrame([0, 8, 6], [9.5, 8.0, 11.0], [0, 0, 1]);
    const up = new Vector3(0, 1, 0).applyQuaternion(f.quat);
    const fwd = new Vector3(0, 0, 1).applyQuaternion(f.quat);
    ok('the mount quaternion carries +Y onto the hull normal',
      up.distanceTo(f.up) < 1e-6, `${up.toArray()}`);
    ok('and +Z onto the rest bearing', fwd.distanceTo(f.fwd) < 1e-6, `${fwd.toArray()}`);
    // Right-handed, or the turret trains the wrong way round.
    const right = new Vector3(1, 0, 0).applyQuaternion(f.quat);
    ok('and the basis is right-handed',
      right.distanceTo(f.up.clone().cross(f.fwd)) < 1e-6);
  }

  // The same invariant from the other side. A compartment box is what a round
  // is tested against, so a shell that reaches well past it is hull you can see
  // and cannot shoot — and the repeater's whole stated job is shooting off
  // radiators and sensor masts. Ribs and fins standing a little proud is the
  // point of them; drive bells hanging 42% of a compartment aft of it was not.
  {
    let worst = 0;
    let worstPart = '';
    for (const name of Object.keys(PARTS)) {
      if (!name.startsWith('shell_') || name.endsWith('_glass')) {
        continue;
      }
      const pos = partGeometry(name).getAttribute('position').array;
      for (let i = 0; i < pos.length; i++) {
        // Shells are modelled in the unit cube, so anything past 0.5 is spill.
        const over = Math.abs(pos[i]) - 0.5;
        if (over > worst) {
          worst = over;
          worstPart = name;
        }
      }
    }
    ok('no shell reaches far outside the compartment it is drawn for',
      worst <= 0.15, `${worstPart} spills ${(worst * 200).toFixed(0)}% of a half-extent`);
  }

  // Modules fitting inside their compartment's SHELL — not merely inside the
  // raycast box — is enforced by `validate` in hulls.js, which throws at import.
  // There is deliberately no assertion for it here: if it were ever violated
  // this file could not load far enough to report it, so the check has to live
  // where the tables are compiled rather than where they are tested.

  // A gun is a machine standing on a deck. It may not point through the deck,
  // and the ship's own pilot has to know that.
  {
    const floor = -Math.sin(MOUNT_DEPRESSION);

    // Authoring invariant: a rest bearing below the floor would leave a mount
    // permanently clamped, quietly off its authored bearing forever.
    let worstRest = 0;
    let worstId = '';
    for (const hull of Object.values(HULLS)) {
      for (const def of hull.hardpoints) {
        const s = hull.sectionById[def.section];
        const f = mountFrame(def.pos, s.half, def.dir, s.style);
        const elev = new Vector3(...def.dir).normalize().dot(f.up);
        if (elev < worstRest) {
          worstRest = elev;
          worstId = `${hull.id}/${def.id}`;
        }
      }
    }
    ok('no mount rests below the face it is bolted to',
      worstRest >= floor, `${worstId} rests at ${(Math.asin(worstRest) * 57.3).toFixed(1)}deg`);

    // The clamp itself. A demand well under the deck must come back sitting
    // exactly on the depression limit, and must keep its train — a gun denied
    // elevation stops at the plating, it does not swing off the bearing.
    const ship = Object.create(Ship.prototype);
    ship.body = { quat: new Quaternion() };
    const up = new Vector3(0, 1, 0);
    for (const demand of [
      new Vector3(0.2, -1, 0.3), new Vector3(0, -1, 0.05),
      new Vector3(-0.8, -0.6, 0.1), new Vector3(0.1, -0.02, 1),
    ]) {
      const mount = {
        up: up.clone(),
        rest: new Vector3(0, 0, 1),
        aim: demand.clone().normalize(),
      };
      const before = mount.aim.clone();
      ship._clampToMount(mount);
      const elev = mount.aim.dot(up);
      ok(`a mount denied elevation stops at the deck (${before.toArray().map((v) => v.toFixed(1))})`,
        elev >= floor - 1e-9, `${(Math.asin(elev) * 57.3).toFixed(2)}deg`);
      // Train preserved: the horizontal component points the same way.
      const az0 = new Vector3(before.x, 0, before.z);
      const az1 = new Vector3(mount.aim.x, 0, mount.aim.z);
      if (az0.lengthSq() > 1e-6) {
        ok('...without being swung off its bearing',
          az0.normalize().dot(az1.normalize()) > 0.9999);
      }
      ok('...and stays a unit vector', Math.abs(mount.aim.length() - 1) < 1e-9);
    }
    // A bearing that was already legal must not be touched at all.
    {
      const mount = {
        up: up.clone(), rest: new Vector3(0, 0, 1), aim: new Vector3(0.3, 0.5, 1).normalize(),
      };
      const before = mount.aim.clone();
      ship._clampToMount(mount);
      ok('a mount that can already bear is left alone', mount.aim.distanceTo(before) === 0);
    }

    // And the pilot: a contact abeam has to be rolled ONTO the deck, not under
    // the keel. Rolling the wrong way masks the broadside the AI is turning to
    // bring to bear, which is the bug this sign fixes.
    {
      const pilot = Object.create(Pilot.prototype);
      pilot.ship = { body: { quat: new Quaternion() } };
      pilot.reflex = 1;
      const cmd = { yaw: 0, pitch: 0, roll: 0 };
      // +X is PORT in this frame, so a target to port must roll the deck to port.
      pilot._steer(cmd, new Vector3(1, 0, 0.2).normalize(), 1 / 60);
      ok('a contact to port is rolled onto the deck, not under the keel',
        cmd.roll < -0.2, `roll ${cmd.roll.toFixed(2)}`);
      pilot._steer(cmd, new Vector3(-1, 0, 0.2).normalize(), 1 / 60);
      ok('and the same to starboard, the other way', cmd.roll > 0.2, `roll ${cmd.roll.toFixed(2)}`);
      // Already overhead: nothing to do.
      pilot._steer(cmd, new Vector3(0, 1, 0.2).normalize(), 1 / 60);
      ok('a contact already overhead is not rolled about',
        Math.abs(cmd.roll) < 0.05, `roll ${cmd.roll.toFixed(2)}`);
    }
  }

  // Decals are placed from a ray tested against the compartment BOX, but the
  // shell is inscribed in that box and tapers. Left alone, every scorch mark
  // hovers off the plating — by ~1 m down a flank and by several at a bow.
  {
    const hull = HULLS.meridian;
    const ship = Object.create(Ship.prototype);
    ship.hull = hull;
    const com = hull.com;
    const seat = (sec, axis, sign, z) => {
      const p = new Vector3(
        sec.pos[0] - com[0], sec.pos[1] - com[1], sec.pos[2] - com[2] + z);
      p.setComponent(axis, p.getComponent(axis) + sign * sec.half[axis]);
      const n = new Vector3();
      n.setComponent(axis, sign);
      const before = p.clone();
      ship._seatOnSkin(p, n);
      return { moved: before.distanceTo(p), p, before };
    };

    const flank = hull.sections.find((s) => s.style === 'hull');
    const r = seat(flank, 1, 1, 0);
    ok('a decal on a flat compartment is pulled onto the shell',
      r.moved > 0.1 && r.moved < 2.0, `moved ${r.moved.toFixed(2)} m`);

    const bow = hull.sections.find((s) => s.style === 'prow');
    const rb = seat(bow, 1, -1, bow.half[2] * 0.7);
    ok('and a decal near a tapered bow moves a lot further',
      rb.moved > r.moved * 2, `moved ${rb.moved.toFixed(2)} m`);
    ok('but never past the compartment centreline',
      Math.abs(rb.p.y - (bow.pos[1] - com[1])) < bow.half[1], `${rb.p.y.toFixed(2)}`);

    // Fore and aft faces are not tapered, so a hit on one must not be shifted.
    const rz = seat(flank, 2, 1, 0);
    ok('a decal on a fore or aft face is left where it landed',
      rz.moved === 0, `moved ${rz.moved}`);

    // And a stray point nowhere near the hull must be left alone rather than
    // snapped onto whichever compartment happened to be nearest.
    const far = new Vector3(0, 900, 0);
    const fb = far.clone();
    ship._seatOnSkin(far, new Vector3(0, 1, 0));
    ok('a point nowhere near the hull is not snapped to it', far.equals(fb));
  }

  // Train and elevation are recovered from the aim vector by _syncMounts using
  // atan2(x, z) and atan2(-y, hypot(x, z)). Assert the pair actually inverts:
  // compose the two rotations and check the barrel lands back on the demand.
  {
    const demands = [
      new Vector3(0, 0, 1), new Vector3(1, 0, 1), new Vector3(-0.3, 0.5, 1),
      new Vector3(0.6, -0.4, -0.7), new Vector3(0, 0.9, 0.1),
    ];
    let worst = 0;
    for (const d of demands) {
      d.normalize();
      const yaw = Math.atan2(d.x, d.z);
      const pitch = Math.atan2(-d.y, Math.hypot(d.x, d.z));
      const bore = new Vector3(0, 0, 1)
        .applyQuaternion(new Quaternion().setFromEuler(new Euler(pitch, 0, 0)))
        .applyQuaternion(new Quaternion().setFromEuler(new Euler(0, yaw, 0)));
      worst = Math.max(worst, bore.distanceTo(d));
    }
    ok('train and elevation put the bore back on the demanded bearing',
      worst < 1e-9, `worst error ${worst.toExponential(2)}`);
  }

  // Every mount has to be able to point at what the ship is pointing at.
  //
  // The MERIDIAN and BASTION each carried a dorsal repeater aimed up and AFT:
  // 135 degrees off the bow with a 75 degree traverse, so sixty degrees of sky
  // stood between it and the boresight and it could not engage anything the
  // reticle was on. Triggering the point-defence group fired one third of it
  // into empty space, every time.
  {
    let worst = -1e9;
    let worstId = '';
    for (const hull of Object.values(HULLS)) {
      for (const def of hull.hardpoints) {
        const off = Math.acos(new Vector3(...def.dir).normalize().z);
        if (off - def.arc > worst) {
          worst = off - def.arc;
          worstId = `${hull.id}/${def.id}`;
        }
      }
    }
    ok('every mount can traverse onto the boresight',
      worst <= 0, `${worstId} falls ${(worst * 57.3).toFixed(1)}deg short`);
  }

  // The field has to enclose the HARDWARE, not just the compartments. A gun is
  // a twenty-seven metre machine on a hull twenty-eight metres tall and it
  // swings; before the shield was derived from the mounts, the HALBERD's dorsal
  // driver stood two per cent outside its own ship's bubble, where a round
  // could reach it without the field ever getting a say.
  {
    let worst = 0;
    let worstId = '';
    for (const hull of Object.values(HULLS)) {
      const r = hull.shield.radii;
      for (const def of hull.hardpoints) {
        const s = hull.sectionById[def.section];
        const f = mountFrame(def.pos, s.half, def.dir, s.style);
        const scale = (MOUNTS[def.mount] || 1) * hull.gunScale;
        const reach = (PIVOTS[mountStyle(WEAPONS[def.weapon], def.arc)]
          + Math.max(...MUZZLES[def.weapon].map((m) => Math.hypot(m[0], m[1], m[2])))) * scale;
        const seat = new Vector3(
          s.pos[0] + def.pos[0], s.pos[1] + def.pos[1], s.pos[2] + def.pos[2],
        ).addScaledVector(f.up, f.lift).sub(new Vector3(...hull.com));
        // Sample the traverse: the rest bearing and the rim of the cone.
        const rest = new Vector3(...def.dir).normalize();
        const side = new Vector3().crossVectors(rest, f.up).normalize();
        const other = new Vector3().crossVectors(side, rest);
        for (let i = 0; i < 16; i++) {
          const th = (i / 16) * Math.PI * 2;
          const tip = seat.clone().addScaledVector(
            rest.clone().multiplyScalar(Math.cos(def.arc))
              .addScaledVector(side, Math.sin(def.arc) * Math.cos(th))
              .addScaledVector(other, Math.sin(def.arc) * Math.sin(th)),
            reach,
          );
          const q = Math.hypot(tip.x / r[0], tip.y / r[1], tip.z / r[2]);
          if (q > worst) {
            worst = q;
            worstId = `${hull.id}/${def.id}`;
          }
        }
      }
    }
    ok('every muzzle stays inside its own shield through the whole traverse',
      worst <= 1, `${worstId} reaches ${worst.toFixed(3)}x the field radius`);
  }
}

// --- point defence actually defends -----------------------------------------
// The repeater's whole stated job is shredding incoming torpedoes, and it could
// not: nothing tested a round against anything but ships, so a warhead once
// launched always arrived and the PD mounts were three turrets that did nothing
// a broadside could not do better.
{
  const blasts = [];
  const scene = { add() {}, remove() {} };
  const game = {
    scene,
    ships: [],
    fx: { smokePuff() {}, explosion() {} },
    audio: { boom() {} },
    explode(pos, opts) { blasts.push({ pos: pos.clone(), owner: opts.owner }); },
  };
  const ball = new Ballistics(game);
  const gunner = { name: 'GUNNER' };
  const launcher = { name: 'LAUNCHER' };
  const fire = (from, dir, dist) => ball.resolvePath(
    from, dir, dist,
    { energy: 1e6, ap: 1, dwell: 1e-3, dump: 0, owner: gunner, caliber: 'bolt', impulse: 10 },
  );
  const launch = () => {
    ball.missiles.length = 0;
    ball.spawnMissile(launcher, new Vector3(0, 0, 1000), new Vector3(0, 0, -1),
      new Vector3(), WEAPONS.torpedo, null);
    ball.missiles[0].armT = 0;   // out of the tube and live
  };

  launch();
  const res = fire(new Vector3(0, 0, 0), new Vector3(0, 0, 1), 2000);
  ok('a round through a torpedo sets it off', ball.missiles.length === 0);
  ok('...and is spent doing it', res.stopped === true);
  ok('...and the kill is credited to whoever shot it down',
    blasts.length === 1 && blasts[0].owner === gunner);

  // Near misses miss. A repeater must not sweep ordnance out of the sky from
  // fifty metres away, or point defence stops being a matter of laying the gun.
  launch();
  fire(new Vector3(50, 0, 0), new Vector3(0, 0, 1), 2000);
  ok('a round fifty metres wide of it does not', ball.missiles.length === 1);

  // A launcher cannot detonate its own salvo by firing through it.
  ball.missiles[0].owner = gunner;
  fire(new Vector3(0, 0, 0), new Vector3(0, 0, 1), 2000);
  ok('and you cannot shoot down your own ordnance', ball.missiles.length === 1);

  // Fragments do not: sympathetic detonation would splice the missile array
  // from inside the loop that is already walking it.
  ball.missiles[0].owner = launcher;
  ball.resolvePath(new Vector3(0, 0, 0), new Vector3(0, 0, 1), 2000,
    { energy: 1e6, ap: 1, dwell: 1e-3, owner: gunner, caliber: 'shrapnel', impulse: 10 });
  ok('a blast fan leaves other warheads alone', ball.missiles.length === 1);
}

// --- report -----------------------------------------------------------------
if (failures.length === 0) {
  console.log(`selfcheck: ${passed} assertions passed`);
} else {
  console.error(`selfcheck: ${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) {
    console.error(`  x ${f}`);
  }
  process.exitCode = 1;
}
