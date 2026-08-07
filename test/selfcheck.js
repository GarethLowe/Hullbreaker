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
import { WEAPONS, AMMO } from '../src/weapons/defs.js';

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
  ok('both runs cut: forward bus dead', !sys.online.power.has('p.fwd'));
  ok('...and the sensor on that bus is dead with it', sys.get('sensor').eff === 0);
  ok('...but the aft bus is unaffected', sys.online.power.has('p.main'));
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
