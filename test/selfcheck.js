// -----------------------------------------------------------------------------
// selfcheck.js — headless assertions over the simulation.
//
// `node test/selfcheck.js`. No framework, no fixtures: it drives the real
// Systems and Crew classes with no renderer attached and asserts the behaviours
// that would be expensive to notice by flying around. If a change breaks the
// network solver, the shield model, decompression or the crew's pathing, this
// says so in under a second.
// -----------------------------------------------------------------------------
import { HULLS, ENGAGEMENT_RANGE, NETS } from '../src/ship/hulls.js';
import { Systems, ATMO_CRITICAL, TRIP_TEMP_C, FUEL_LEAK_RATE } from '../src/ship/systems.js';
import { Crew } from '../src/ship/crew.js';
import { Body, Autopilot, BURN_RATE, resolveCollision } from '../src/ship/flight.js';
import { WEAPONS, AMMO, MOUNTS } from '../src/weapons/defs.js';
import { Ballistics, beamDamageBudget } from '../src/weapons/ballistics.js';
import { Ship, MOUNT_DEPRESSION } from '../src/ship/ship.js';
import { Pilot } from '../src/ship/ai.js';
import { Game } from '../src/main.js';
import { Diagnostics } from '../src/ui/diagnostics.js';
import { FX } from '../src/fx/fx.js';
import { Scheduler } from '../src/core/ecs.js';
import { canFireMount, shotHeatRate } from '../src/ship/gunnery.js';
import { createLiveSection, sectionHeatDelta } from '../src/ship/hull-types.js';
import { seededRandom, seedFromSearch } from '../src/core/rng.js';
import { Euler, Quaternion, Vector3, Color } from 'three';
import { PARTS, MUZZLES, PIVOTS } from '../src/world/kit.js';
import {
  mountFrame, mountStyle, partGeometry, shellGeometry, skinFraction, SHELL_STYLES,
} from '../src/world/hardware.js';
import {
  skyColour, MOODS, Space, CAMERA_NEAR, CAMERA_FAR, STAR_SHELL, SKY_SHELL,
  DUST_NEAR, DUST_FAR, DUST_REACH, DUST_FLOOR_PX,
} from '../src/world/space.js';

let passed = 0;
const failures = [];

// Keep probabilistic checks reproducible. Set SELFCHECK_SEED to replay a
// different run; the effective seed is printed with the result.
const SELF_CHECK_SEED = Number.parseInt(process.env.SELFCHECK_SEED || '1729', 10) >>> 0;
let randomState = SELF_CHECK_SEED || 1;
Math.random = () => {
  randomState = (randomState * 1664525 + 1013904223) >>> 0;
  return randomState / 0x100000000;
};

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

// The scheduler deliberately owns order only. Entity lifetime stays with Game,
// preventing a deferred registry from leaving retired ships active for a tick.
{
  const scheduler = new Scheduler();
  const order = [];
  scheduler.addSystem('late', () => order.push('late'), 20);
  scheduler.addSystem('early', () => order.push('early'), 10);
  scheduler.run({});
  ok('the scheduler runs systems in declared order', order.join(',') === 'early,late');
}

{
  const game = { over: true, input: { requestLock() {} } };
  Game.prototype._resumePlaying.call(game);
  ok('retry keeps the game-over state until pointer lock succeeds', game.over && game.resuming);
}

{
  const ship = { disposed: false, dispose() { this.disposed = true; } };
  const game = {
    ships: [ship], pilots: new Map(), player: { ship },
    targeting: { target: null, setTarget() {} },
    diagnostics: { ship, setShip(next) { this.ship = next; } },
    targetPanel: { ship: null, setShip() {} },
  };
  Game.prototype._disposeShip.call(game, ship);
  ok('disposing the player clears player and diagnostics references',
    game.player === null && game.diagnostics.ship === null);
}

{
  let deployed = 0;
  Game.prototype._deployWave.call({ player: null, _addShip() { deployed++; } }, 1);
  ok('a wave is not deployed without a live player hull', deployed === 0);
}

{
  let cleared = 0;
  const game = {
    ships: [], ballistics: { clear() {} }, fx: { clear() { cleared++; } }, wave: 1,
    startWave() {}, hud: { nudge() {} },
  };
  Game.prototype.skipWave.call(game);
  ok('skipping a wave clears its lingering effects', cleared === 1);
}

{
  let resized = 0;
  const panel = { ship: null, root: { classList: { toggle() {} } }, visible: true, resize() { resized++; } };
  Diagnostics.prototype.setShip.call(panel, {});
  ok('showing a target panel resizes its cutaway canvas', resized === 1);
}

{
  const fx = new FX({ scene: { add() {} }, assets: { glow: null, softGlow: null, environment: null } });
  fx.pSize[0] = fx.kSize[0] = fx.kAlpha[0] = 1;
  fx.pCol[0] = 1;
  fx.clear();
  ok('clearing effects erases stale particle and smoke GPU attributes',
    fx.pSize[0] === 0 && fx.pCol[0] === 0 && fx.kSize[0] === 0 && fx.kAlpha[0] === 0);
}

{
  const sys = fresh('meridian');
  const ship = Object.assign(Object.create(Ship.prototype), {
    disposed: false,
    body: { pos: new Vector3(), quat: new Quaternion() },
    hitRadius: HULLS.meridian.radius,
    shieldR: 0,
    shieldRadii: HULLS.meridian.shield.radii,
    hull: HULLS.meridian,
    sys,
    _secR: new Map(HULLS.meridian.sections.map((s) => [s.id, Math.hypot(...s.half)])),
  });
  sys.shield.up = false;
  const hits = [];
  ship.gatherRayHits(new Vector3(0, 0, -1000), new Vector3(0, 0, 1), 2000, hits);
  hits.sort((a, b) => a.t - b.t);
  const first = hits.find((h) => h.kind === 'wallIn');
  ok('a real hull ray resolves its first hit as the MERIDIAN drive bay',
    first?.section === 'drivebay' && first.t > 800, `${first?.section} at ${first?.t}`);
}

{
  let calls = 0;
  const random = () => { calls++; return 0.5; };
  const ball = new Ballistics({ scene: { add() {} }, random });
  ball.spawnBolt({}, new Vector3(), new Vector3(0, 0, 1), new Vector3(), {
    spread: 0.1, muzzleVel: 1, energy: 1, mass: 1, ap: 1, dwell: 1, tracer: 0,
  }, null);
  const sys = new Systems(HULLS.sabre, { game: { random } });
  ok('simulation subsystems accept and consume an injected RNG stream', calls > 0 && sys.ship.game.random === random);
}
{
  const ball = Object.create(Ballistics.prototype);
  ball.game = { random: () => 0.5 };
  ball.bolts = [];
  const weapon = { spread: 0, muzzleVel: 1, energy: 1, mass: 1, ap: 1, dwell: 1, tracer: 0 };
  for (let i = 0; i < 901; i++) {
    ball.spawnBolt(null, new Vector3(), new Vector3(0, 0, 1), new Vector3(), weapon, null);
  }
  ok('bolt simulation stays bounded by the tracer budget', ball.bolts.length === 900);
}

{
  const ready = { held: true, live: true, bears: true, cooling: false, charged: true };
  ok('a gunnery gate accepts a ready mount', canFireMount(ready));
  for (const key of Object.keys(ready)) {
    const missing = key === 'cooling' ? true : false;
    ok(`a gunnery gate rejects a mount without ${key}`,
      !canFireMount({ ...ready, [key]: missing }));
  }
}

{
  const mount = { mod: { destroyed: false, tripped: false, eff: 1 }, weapon: { ammo: 1, draw: 1 }, def: { feed: 'mag' }, cool: 0 };
  const ship = { sys: { hasData: () => false, get: () => ({ destroyed: false, rounds: 1 }) }, _canDraw: () => true };
  ok('a linkless gun reports boresight rather than dead', Ship.prototype.mountFault.call(ship, mount) === 'BORESIGHT');
}

near('a discrete shot deposits the same heat at any simulation step',
  shotHeatRate(320, 1.5, 1 / 60) * (1 / 60), shotHeatRate(320, 1.5, 1 / 30) * (1 / 30), 1e-9);

{
  const budget = beamDamageBudget(100, true);
  near('a breached beam budget spends no more than its delivered energy',
    budget.section + budget.heat + budget.module, 100, 1e-9);
}

{
  const marks = [];
  const ball = new Ballistics({ scene: { add() {} }, onHit: (owner, ship, internal) => marks.push(internal) });
  const ctx = { owner: {} };
  ball._announce(ctx, {}, false, false);
  ball._announce(ctx, {}, true, true);
  ok('a module strike supersedes its entry-wall hit marker', marks.join(',') === 'false,true');
}

{
  const def = { id: 'test', label: 'TEST', volume: 100, plateHp: 1, frameHp: 1 };
  near('section heat uses authored volume', sectionHeatDelta(def, 1e6), 360, 1e-9);
  // Regression: the extraction once hardcoded 20 while everything else in the
  // ship initializes and relaxes to AMBIENT_C = 18.
  ok('a live section spawns at the ambient it cools toward',
    createLiveSection(def, 18).temp === 18);
}

{
  const a = seededRandom(1729);
  const b = seededRandom(1729);
  ok('a simulation RNG replays its seed', [a(), a(), a()].join(',') === [b(), b(), b()].join(','));
}

ok('a URL seed is accepted for simulation replay', seedFromSearch('?seed=1729') === 1729);

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
ok('bow-gun hulls hold a zero fight aspect',
  Math.abs(HULLS.sabre.fightAspect) < 0.02 && Math.abs(HULLS.halberd.fightAspect) < 0.02
  && Math.abs(HULLS.bastion.fightAspect) < 0.02);
{
  const fixed = {};
  const pilot = new Pilot({ fireGroups: [[fixed], []], onTarget: (m) => m === fixed }, { random: () => 0.5 });
  pilot.target = {};
  ok('fixed-gun fire gating follows a bearing mount, not hull attitude', pilot._fixedGunsBear());
}

// --- physics and thermal invariants ----------------------------------------
{
  const sys = fresh();
  const section = sys.section('spine');
  const before = section.temp;
  sys.injectHeat('spine', 1e6);
  ok('beam heat keeps compartment temperature finite',
    Number.isFinite(section.temp) && section.temp > before, `temp ${section.temp}`);
  const loop = sys.loops.get('l.core');
  const loopBefore = loop.temp;
  sys.injectHeat('spine', 1e6);
  near('beam heat enters a shared coolant loop once per compartment', loop.temp - loopBefore,
    (1e6 * 1e-5) / loop.capacity, 1e-9);
}
{
  for (const [id, hull] of Object.entries(HULLS)) {
    let expected = 0;
    for (const section of hull.sections) {
      expected = Math.max(expected, Math.hypot(
        Math.abs(section.pos[0] - hull.com[0]) + section.half[0],
        Math.abs(section.pos[1] - hull.com[1]) + section.half[1],
        Math.abs(section.pos[2] - hull.com[2]) + section.half[2],
      ));
    }
    near(`${id}: collision radius is measured from its centre of mass`,
      hull.radius, expected, 1e-9);
  }
}
{
  const body = new Body(HULLS.meridian);
  body.applyImpulseAt(body.pos, new Vector3(1, 0, 0), 1000);
  ok('an impulse at the centre of mass creates no spin', body.omega.lengthSq() < 1e-20,
    `omega ${body.omega.toArray()}`);
}
{
  const body = new Body(HULLS.sabre);
  body.omega.set(1.2, -0.7, 0.4);
  const before = body.omega.clone();
  const Iw = before.clone().multiply(body.inertia);
  const expected = Iw.cross(before).multiply(body.invInertia);
  const dt = 1e-5;
  body.integrate(dt);
  near('Euler free-precession x has the documented sign', body.omega.x,
    before.x + expected.x * dt, 1e-10);
  near('Euler free-precession y has the documented sign', body.omega.y,
    before.y + expected.y * dt, 1e-10);
  near('Euler free-precession z has the documented sign', body.omega.z,
    before.z + expected.z * dt, 1e-10);
}
{
  const body = new Body(HULLS.sabre);
  body.omega.set(1.5, 0.2, 0.3);
  const momentum = body.omega.clone().multiply(body.inertia).length();
  for (let t = 0; t < 360; t += 1 / 60) {
    body.integrate(1 / 60);
  }
  near('torque-free rotation preserves angular momentum magnitude',
    body.omega.clone().multiply(body.inertia).length(), momentum, 1e-3);
}
{
  const a = new Body(HULLS.sabre);
  const b = new Body(HULLS.sabre);
  b.pos.set(a.contactRadii.x + b.contactRadii.x - 1, 0, 0);
  a.vel.set(10, 0, 0);
  b.vel.set(-10, 0, 0);
  const initialMomentum = a.mass * a.vel.x + b.mass * b.vel.x;
  const hit = resolveCollision(a, b, 0.25);
  const relative = b.vel.x - a.vel.x;
  near('collision applies configured restitution once', relative, 5, 1e-9);
  near('collision conserves linear momentum', a.mass * a.vel.x + b.mass * b.vel.x,
    initialMomentum, 1e-4);
  ok('collision damage energy is bounded by initial relative kinetic energy',
    hit.energy >= 0 && hit.energy < 0.5 * (a.mass / 2) * 20 * 20,
    `energy ${hit.energy}`);
}
{
  const light = new Body(HULLS.sabre);
  const heavy = new Body(HULLS.bastion);
  const heavyStart = heavy.pos.x = light.contactRadii.x + heavy.contactRadii.x - 10;
  resolveCollision(light, heavy);
  ok('collision de-penetration moves the lighter hull farther',
    Math.abs(light.pos.x) > Math.abs(heavy.pos.x - heavyStart) * 20);
}
{
  const a = new Body(HULLS.sabre);
  const b = new Body(HULLS.sabre);
  b.pos.x = a.radius + b.radius - 1;
  ok('collision uses the shield ellipsoid rather than the hull bounding sphere',
    resolveCollision(a, b) === null);
}
{
  const a = new Body(HULLS.sabre);
  const b = new Body(HULLS.sabre);
  resolveCollision(a, b);
  ok('coincident hulls receive a deterministic separating nudge', a.pos.distanceTo(b.pos) > 0);
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

// --- a drained coolant loop has to come back ----------------------------------
// `level` used to be a one-way ratchet: the drain in _tickThermal was the only
// thing that ever wrote it, so one holed pipe cost the loop its coolant for the
// whole run. Damage control would weld the run, the network read COOLANT 8/8,
// and the drives on that loop kept cooking to 900 C and latching offline
// against an empty loop sitting at ambient — a fully repaired cruiser that
// still could not move, with nothing on any readout naming why. Walk the whole
// cycle: sound, holed, dry and tripped, mended, recovered.
{
  const sys = fresh('meridian');
  const drive = sys.get('thruster_A');
  const loop = sys.loops.get('l.aft');
  const hold = (seconds) => {
    for (let t = 0; t < seconds; t += 1 / 60) {
      // Hold the drives at full duty; flight.js does this in the real game.
      for (const m of sys.modules.values()) {
        if (m.kind === 'thruster') {
          m.duty = 1;
        }
      }
      sys.tick(1 / 60);
    }
  };
  hold(60);
  ok('a healthy drive loop stays full', loop.level > 0.99);
  ok('a healthy drive runs below its trip', drive.temp < TRIP_TEMP_C,
    `${drive.temp.toFixed(0)} C`);

  const pipe = [...sys.modules.values()].find(
    (m) => m.kind === 'conduit' && m.def.net === 'coolant' && m.def.to === 'l.aft',
  );
  sys.damageModule(pipe.id, pipe.maxHp * 0.95);
  hold(90);
  ok('a holed run empties its loop', loop.level <= 0, `${loop.level.toFixed(2)}`);
  ok('a dry loop cooks the drive off it', drive.tripped,
    `${drive.temp.toFixed(0)} C`);
  // The bug, stated directly: welding the pipe is not enough on its own, and
  // the loop must not refill while the hole is still there.
  hold(120);
  ok('a still-holed loop does NOT refill itself', loop.level <= 0,
    `${loop.level.toFixed(2)}`);

  sys.repairModule(pipe.id, pipe.maxHp);
  hold(60);
  ok('a mended loop starts taking charge again', loop.level > 0.2,
    `${loop.level.toFixed(2)} after 60 s`);
  hold(150);
  ok('a mended loop comes back to full', loop.level > 0.99,
    `${loop.level.toFixed(2)} after 210 s`);
  ok('and the drive it cools comes back with it', !drive.tripped && drive.eff > 0.9,
    `${drive.temp.toFixed(0)} C, eff ${drive.eff.toFixed(2)}`);
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
  ok('shed loads no longer inflate displayed demand', sys.demand <= sys.supply + 1e-6,
    `${sys.demand.toFixed(1)} MW vs ${sys.supply.toFixed(1)} MW`);
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
  ok('shedding restores capacitor recharge and bus voltage', sys.capStore > 0 && sys.busQuality > 0.99,
    `cap=${sys.capStore.toFixed(2)} bus=${sys.busQuality.toFixed(3)}`);
}

{
  const sys = fresh();
  const drive = sys.get('thruster_A');
  const before = drive.temp;
  sys._tickThermal(1);
  ok('an untouched duty module does not make full-throttle heat', drive.duty === 0 && drive.temp <= before,
    `duty=${drive.duty} temp=${drive.temp.toFixed(2)}`);
}
{
  const sys = fresh();
  const drive = sys.get('thruster_A');
  drive.destroyed = true;
  drive.hp = 0;
  drive.heatAcc = 1e9;
  sys._tickThermal(1);
  sys.repairModule(drive.id, 1);
  const before = drive.temp;
  sys._tickThermal(1);
  ok('repairing a wreck does not release stale accumulated heat', drive.temp <= before);
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

// --- and no single COMPARTMENT may end a branch either -----------------------
// The single-run rule above is not the test that matters, because damage does
// not arrive as one severed cable. It arrives as a compartment being opened and
// everything inside it wrecked — so a tie laid alongside the run it backs up is
// not redundancy, it is a second thing to lose to the same round.
//
// Every tie was originally authored next to its primary. Both of the picket's
// power trunks sat in engineering, and both of the frigate's, so either ship
// went completely dark the moment that compartment was hit — with the tie
// intact in the wreckage beside the trunk it was supposed to replace.
//
// Nodes gated by a `sole` run are exempt, and so is anything downstream of one:
// a gun hoist is meant to be its turret's only feed, and a picket carrying one
// computer in its bridge is meant to lose fire control with the bridge.
{
  const reach = (hull, net, cut) => {
    const lvl = new Map();
    const cond = hull.modules.filter((m) => m.kind === 'conduit' && m.net === net);
    for (const c of cond) {
      if (c.from.startsWith('src.')) {
        lvl.set(c.from, 1);
      }
    }
    let go = true;
    while (go) {
      go = false;
      for (const c of cond) {
        if (cut.has(c.id)) {
          continue;
        }
        const a = lvl.get(c.from) || 0;
        const b = lvl.get(c.to) || 0;
        if (Math.min(a, c.cap) > b + 1e-9) {
          lvl.set(c.to, Math.min(a, c.cap));
          go = true;
        }
        if (Math.min(b, c.cap) > a + 1e-9) {
          lvl.set(c.from, Math.min(b, c.cap));
          go = true;
        }
      }
    }
    return lvl;
  };

  for (const [id, hull] of Object.entries(HULLS)) {
    const needed = new Set();
    for (const m of hull.modules) {
      if (m.needs) {
        for (const [net, node] of Object.entries(m.needs)) {
          needed.add(`${net}:${node}`);
        }
      }
    }
    needed.add('data:d.helm');
    needed.add('data:d.eng');

    const base = {};
    const fragile = new Set();
    const soleCut = new Set(hull.modules
      .filter((m) => m.kind === 'conduit' && m.sole).map((m) => m.id));
    for (const net of NETS) {
      base[net] = reach(hull, net, new Set());
      // Anything that depends on a deliberate single feed, directly or not.
      const withoutSole = reach(hull, net, soleCut);
      for (const node of base[net].keys()) {
        if (!(withoutSole.get(node) > 0)) {
          fragile.add(`${net}:${node}`);
        }
      }
    }

    const orphaned = [];
    for (const sec of hull.sections) {
      const cut = new Set(hull.modules
        .filter((m) => m.kind === 'conduit' && m.section === sec.id).map((m) => m.id));
      if (cut.size === 0) {
        continue;
      }
      for (const net of NETS) {
        const after = reach(hull, net, cut);
        for (const node of base[net].keys()) {
          const key = `${net}:${node}`;
          if (needed.has(key) && !fragile.has(key) && !(after.get(node) > 0)) {
            orphaned.push(`${sec.id} -> ${key}`);
          }
        }
      }
    }
    ok(`${id}: survives losing any one whole compartment`, orphaned.length === 0,
      orphaned.slice(0, 4).join('; '));
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
  ok('an exhausted capacitor sheds load without derating the surviving bus', sys.busQuality > 0.999,
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

// --- the dust actually reaches the shell it is seeded into --------------------
// The other half of the layer that lives in GLSL, and the one that was silently
// broken. gl_PointSize is aSize * dpr * DUST_REACH / dist clamped to a floor, so
// a mote only renders at full size within DUST_REACH * aSize metres. `size` was
// authored as if that distance did not exist: at 0.5 the near shell reached
// about 100 m and then ran on to 1300, so effectively every mote in it was
// pinned to the floor AND paying the `fine` shrink on top, and the field lit a
// third of one per cent of the frame.
//
// Measure it as the share of each shell that is NOT floor-pinned. A median mote
// holds full size out to aSize * DUST_REACH / DUST_FLOOR_PX metres, the shell is
// visible out to its span, and the frustum is a cone — so the fraction of motes
// drawn at full size goes as the CUBE of that ratio. The old numbers scored
// 0.3% for the near shell and 0.05% for the far one, which is the whole bug in
// one figure. Nothing headless can render a point, but this is the arithmetic
// the shader does, so keep the two in step.
{
  const fullSizeShare = (spec) => {
    // _makeDust draws aSize as spec.size * rand(0.6, 1.5); the median is 1.05x.
    const reach = spec.size * 1.05 * DUST_REACH / DUST_FLOOR_PX;
    return Math.min(1, (reach / spec.span) ** 3);
  };
  // The near shell IS the motion cue, so most of it has to be drawn properly.
  ok('most of the near dust shell renders at full size',
    fullSizeShare(DUST_NEAR) > 0.35,
    `${(fullSizeShare(DUST_NEAR) * 100).toFixed(1)}% of the shell`);
  // The far shell is the subordinate half of the depth gradient — deliberately
  // dimmer and sparser, so it is held to a far lower bar. Not to none, though:
  // a gradient needs two layers you can actually see.
  ok('the far dust shell is still visible at range',
    fullSizeShare(DUST_FAR) > 0.04,
    `${(fullSizeShare(DUST_FAR) * 100).toFixed(1)}% of the shell`);
  // ...and it must stay the dimmer of the two, or there is no gradient at all.
  ok('the far shell stays subordinate to the near one',
    DUST_FAR.bright < DUST_NEAR.bright);
  // Density is the other half and only `count` moves it: motes inside the
  // frustum go as count x (span^3 / span^3), so shrinking a shell buys nothing.
  // These are the counts measured at 2.1% frame coverage under way; well below
  // them the layer stops reading as a field however bright each mote is.
  ok('the near shell is dense enough to read as a field', DUST_NEAR.count >= 72000,
    `${DUST_NEAR.count} motes`);
  ok('the far shell still carries the depth gradient', DUST_FAR.count >= 20000,
    `${DUST_FAR.count} motes`);
  // The near shell must stay inside the far one, or the "gradient" is one layer.
  ok('the near shell sits inside the far shell', DUST_NEAR.span < DUST_FAR.span);
}

// --- propellant endurance ------------------------------------------------------
// The throttle is a HELD demand — release W under assist and the ship brakes
// itself to a stop (pilot.js) — so a player is at full duty for essentially the
// whole fight, and endurance at duty 1 is the real number rather than a worst
// case. At the old 0.30 that was 667 s for a MERIDIAN, waves are 45 s apart plus
// the fighting, and the cruiser ran dry around wave five and coasted the rest of
// the run. These are fusion drives; a fight should cost a slice of a bunker, not
// the bunker.
{
  // Endurance is set by the FIRST tank to empty, not by the total tankage:
  // driveAuthority drops a drive's whole share the moment its own tank crosses
  // store > 0.5, so a hull is only as good as its shortest-lived bunker.
  for (const [id, hull] of Object.entries(HULLS)) {
    const drives = hull.modules.filter((m) => m.kind === 'thruster');
    const endurance = (duty) => Math.min(...drives.map((d) => {
      const tank = hull.moduleById[d.fuel];
      return tank.store / (duty * d.share * BURN_RATE);
    }));
    // A fifteen-wave run is about 1530 s of held throttle. Nothing should run
    // dry inside that from flying alone, boost included. The SABRE is the
    // binding case and clears it by only a few per cent, deliberately: one
    // drive drawing on one bunker is half the tankage of every other hull, so
    // it is the picket that decides how low the burn rate is allowed to go.
    ok(`${id}: outlasts a long run on held throttle`, endurance(1) > 2400,
      `${endurance(1).toFixed(0)} s`);
    ok(`${id}: outlasts a fight with the boost lit`, endurance(1.8) > 1300,
      `${endurance(1.8).toFixed(0)} s`);
    // ...but a bunker is still worth shooting. A breach has to dwarf the burn,
    // or battle damage stops mattering and the tank is just scenery.
    for (const d of drives) {
      const tank = hull.moduleById[d.fuel];
      const leak = tank.leak * FUEL_LEAK_RATE;
      ok(`${id}: ${tank.id} empties far faster breached than burning`,
        leak > 5 * d.share * BURN_RATE,
        `leak ${leak.toFixed(2)}/s vs burn ${(d.share * BURN_RATE).toFixed(3)}/s`);
      // And the other side of it: a breach must be a job the damage-control
      // parties can actually win. At the old rate a bunker emptied in eight
      // seconds — less time than it takes a party to cross a compartment — so
      // the repair path that clears `leakRate` above 60% health could never
      // once be reached in time. Two minutes is a fight for it; ten is a
      // formality.
      const seconds = tank.store / leak;
      ok(`${id}: ${tank.id} gives the parties a chance to patch it`,
        seconds > 120 && seconds < 600, `${seconds.toFixed(0)} s to empty`);
    }
  }
}

// --- ready lockers and the main magazine ---------------------------------------
// A gun's whole ammunition outfit used to sit in a box at the mount, and mounts
// are outboard by construction — `magPos` puts them in the battery compartments,
// the thinnest-armoured parts of every hull. One detonation on the outside of a
// HALBERD took 55% of its rounds with it, and 19% of a MERIDIAN's. The lockers
// now hold READY_SECONDS of fire and the rest is deep in the hull.
{
  for (const [id, hull] of Object.entries(HULLS)) {
    const mags = hull.modules.filter((m) => m.kind === 'magazine');
    const total = mags.reduce((a, m) => a + m.rounds, 0);
    for (const m of mags) {
      if (!m.deep) {
        continue;   // torpedo stowage, the PD locker, and the whole SABRE
      }
      // A locker is defined by being small. Three per cent is the bar: above it
      // the thing at the mount is a magazine again whatever it is labelled.
      ok(`${id}: ${m.id} is a locker, not a magazine`,
        (100 * m.rounds / total) < 3,
        `${(100 * m.rounds / total).toFixed(1)}% of ${total} rounds`);
      // Sized off the weapon, so it means the same on every gun.
      const gun = hull.modules.find((h) => h.kind === 'hardpoint' && h.feed === m.id);
      const w = WEAPONS[gun.weapon];
      const seconds = m.rounds / ((w.ammo || 1) / w.interval);
      ok(`${id}: ${m.id} holds a sane burst`, seconds > 20 && seconds <= 50,
        `${seconds.toFixed(0)} s of fire`);
      // And letting go at the mount must not be the same event as letting go
      // in the magazine deck.
      const deep = hull.moduleById[m.deep];
      ok(`${id}: ${m.id} cooks off far smaller than ${m.deep}`,
        m.cookoff * 5 < deep.cookoff,
        `${m.cookoff.toExponential(1)} vs ${deep.cookoff.toExponential(1)}`);
    }
  }
  // The SABRE is deliberately left whole: a 95 m picket has no compartment that
  // is not an outside compartment, so there is nowhere deeper to put anything.
  ok('the picket keeps its single magazine',
    HULLS.sabre.modules.filter((m) => m.kind === 'magazine')
      .every((m) => !m.deep && m.rounds > 100));
}
{
  // The hoist is the gun's power run, so cutting it takes the mount's training
  // and its ammunition supply together: it fires out its locker and then stops,
  // and the rounds it never got stay safe in the magazine.
  const sys = fresh('meridian');
  const locker = sys.get('mag_bLA');
  const main = sys.get('mag_main');
  const rate = WEAPONS[HULLS.meridian.moduleById.hp_bLA.weapon].ammo
    / WEAPONS[HULLS.meridian.moduleById.hp_bLA.weapon].interval;
  const fire = (seconds) => {
    for (let t = 0; t < seconds; t += 1 / 60) {
      sys.tick(1 / 60);
      locker.rounds = Math.max(0, locker.rounds - rate / 60);
    }
  };
  run(sys, 1);
  ok('a locker starts full', locker.rounds === locker.def.rounds);

  fire(200);
  ok('sustained fire outruns the hoist', locker.rounds < locker.def.rounds * 0.05,
    `${locker.rounds.toFixed(0)} left`);
  ok('...but the magazine kept it shooting', main.rounds < main.def.rounds,
    `${main.rounds.toFixed(0)} of ${main.def.rounds}`);
  run(sys, 90);
  ok('a quiet gun refills from the magazine', locker.rounds > locker.def.rounds * 0.99,
    `${locker.rounds.toFixed(0)}`);

  sys.damageModule('c_hoist_bLA', 1e12);
  run(sys, 1);
  const held = main.rounds;
  fire(60);
  ok('a cut hoist starves the gun', locker.rounds <= 0, `${locker.rounds.toFixed(0)}`);
  run(sys, 90);
  ok('...and no ceasefire brings it back', locker.rounds <= 0,
    `${locker.rounds.toFixed(0)}`);
  ok('...while the rounds it never got stay in the magazine',
    Math.abs(main.rounds - held) < 1e-6);
}

// --- a loop with TWO feeds, one of them merely dented ---------------------------
// Reported from a real game: `l.batA 0% leak=0 flow=1` — nothing leaking, coolant
// circulating, and the loop stuck empty for the rest of the run. l.batA is fed by
// both l_batA and the l_tie_bat cross-connect, and the first version of the refill
// refused to charge a loop while ANY run into it sat under the repair threshold.
// The network disagreed: it happily flows through a dented pipe. So a tie nobody
// had got round to welding held the whole loop dry while every readout said the
// cooling was fine.
{
  const sys = fresh('meridian');
  const loop = sys.loops.get('l.batA');
  run(sys, 1);

  // The cross-connect takes a knock and is left damaged but still carrying.
  // Set directly rather than via damageModule: conduits carry a 2.4x
  // vulnerability multiplier, so "half its health in joules" destroys one, and
  // the state being reproduced here is specifically a run that SURVIVED.
  sys.get('l_tie_bat').hp = sys.get('l_tie_bat').maxHp * 0.8;
  // The main run is holed and bleeds the loop dry.
  sys.damageModule('l_batA', sys.get('l_batA').maxHp * 0.95);
  run(sys, 120);
  ok('a holed run still empties the loop', loop.level <= 0, `${loop.level.toFixed(2)}`);

  // The parties weld the run they were sent to. The tie is still dented.
  sys.repairModule('l_batA', sys.get('l_batA').maxHp);
  run(sys, 2);
  const tie = sys.get('l_tie_bat');
  ok('the reported state is reproduced: no leak, flow, dented tie',
    loop.leak <= 0 && (sys.online.coolant.get('l.batA') || 0) > 0
    && tie.hp < tie.maxHp && !tie.destroyed,
    `leak=${loop.leak} flow=${sys.online.coolant.get('l.batA')} tie=${(tie.hp / tie.maxHp).toFixed(2)}`);
  run(sys, 200);
  ok('a dented tie does not hold the loop dry', loop.level > 0.99,
    `${loop.level.toFixed(2)} after 200 s`);
}

{
  const sys = fresh('meridian');
  const loop = sys.loops.get('l.batA');
  const main = sys.get('l_batA');
  const tie = sys.get('l_tie_bat');
  sys.damageModule(main.def.id, main.maxHp * 2);
  sys.damageModule(tie.def.id, tie.maxHp * 2);
  run(sys, 1);
  sys.repairModule(main.def.id, main.maxHp);
  run(sys, 1);
  ok('repairing one coolant feed leaves another severed feed leaking', loop.leak > 0 && tie.hp <= 0,
    `leak=${loop.leak} tie=${tie.hp}`);
}

// --- one holed bunker must not cost half the thrust forever ---------------------
// Each drive was hard-wired to `def.fuel`, so a round through one tank left that
// drive dead while its sister tank sat full. Warships run a transfer main.
{
  const sys = fresh('meridian');
  run(sys, 1);
  ok('a healthy ship has full drive authority', sys.driveAuthority() > 0.99);
  sys.get('fuel_A').store = 0;
  run(sys, 1);
  ok('a dry bunker still leaves both drives fed', sys.driveAuthority() > 0.99,
    `authority ${sys.driveAuthority().toFixed(2)} with fuel_A empty`);
  ok('...drawing from the tank that still has some',
    sys.fuelFor(sys.get('thruster_A'), 0.5) === sys.get('fuel_B'));
  // Both dry is still both dry: the transfer main is not a fuel source.
  sys.get('fuel_B').store = 0;
  run(sys, 1);
  ok('an empty ship still does not move', sys.driveAuthority() < 0.05);
}

// --- the tender between waves --------------------------------------------------
// Repair gives back health. Propellant, hands and rounds are SPENT rather than
// broken, and nothing put any of them back, so a run only ever decayed — a ship
// that lost both bunkers was adrift for the rest of the game with a full crew,
// full stores and nothing wrong with it.
{
  const hull = HULLS.meridian;
  const sys = new Systems(hull);
  const crew = new Crew(hull, sys);
  const ship = Object.create(Ship.prototype);
  ship.sys = sys;
  ship.crew = crew;

  const rounds = () => [...sys.modules.values()]
    .filter((m) => m.kind === 'magazine').reduce((a, m) => a + m.rounds, 0);
  const capacity = [...sys.modules.values()]
    .filter((m) => m.kind === 'magazine').reduce((a, m) => a + m.def.rounds, 0);

  sys.get('fuel_A').store = 0;
  sys.get('fuel_B').store = 12;
  for (const m of sys.modules.values()) {
    if (m.kind === 'magazine') {
      m.rounds = 0;
    }
  }
  crew.parties.forEach((q) => { q.size = 0; });
  crew._recount();
  ok('the wreck is properly spent', sys.fuelFraction() < 0.1 && crew.headcount === 0);

  const hands = ship.resupply();
  ok('a tender fills the bunkers', sys.fuelFraction() > 0.99,
    `${Math.round(sys.fuelFraction() * 100)}%`);
  ok('...and it can move again', sys.driveAuthority() > 0.99);
  ok('ammunition comes back a tenth at a time',
    Math.abs(rounds() - capacity * 0.10) < 1, `${Math.round(rounds())} of ${capacity}`);
  ok('hands come back a quarter at a time',
    Math.abs(hands - crew.complementMax * 0.25) < 2, `${hands} of ${crew.complementMax}`);
  ok('...spread across the billets, not dumped in one',
    crew.parties.every((q) => q.size > 0 && q.size <= q.max));
  ok('...and a wiped-out party comes back at its own station',
    crew.parties.every((q) => q.at === q.station && !q.task));

  // Nine more lulls must not overfill anything.
  for (let i = 0; i < 9; i++) {
    ship.resupply();
  }
  ok('repeated resupply never overfills a magazine',
    [...sys.modules.values()].filter((m) => m.kind === 'magazine')
      .every((m) => m.rounds <= m.def.rounds + 1e-9));
  ok('repeated resupply never overfills a billet',
    crew.parties.every((q) => q.size <= q.max + 1e-9));
  ok('...and the ship does come back to full complement',
    crew.headcount === crew.complementMax, `${crew.headcount}/${crew.complementMax}`);
  // A destroyed bunker has nothing to fill until the crew rebuild it.
  sys.damageModule('fuel_A', 1e12);
  sys.get('fuel_A').store = 0;
  ship.resupply();
  ok('a destroyed bunker is not refuelled by a tender',
    sys.get('fuel_A').store === 0);
}

// --- gunnery spreads its damage ------------------------------------------------
// Every ship used to lay on the target's centre of mass, so a whole wave put its
// output through one compartment — on the cruisers and up, the engineering deck.
// Choosing by the SHOOTER's role only moved the pile: waves contain duplicate
// hull classes, so every heavy in one wants the same system and the plant became
// the new centroid. The property that matters is not "which part" but "not the
// same part", and it is only testable as a distribution.
{
  const shooter = Object.create(Pilot.prototype);
  const target = Object.create(Ship.prototype);
  target.hull = HULLS.meridian;
  target.body = { quat: new Quaternion(), pos: new Vector3() };
  target.sys = new Systems(HULLS.meridian);
  run(target.sys, 0.5);

  // From dead ahead, well outside the hull.
  shooter.ship = { position: new Vector3(0, 0, 4000), hull: HULLS.sabre };
  const picks = new Map();
  for (let i = 0; i < 4000; i++) {
    const id = shooter._pickAim(target);
    picks.set(id, (picks.get(id) || 0) + 1);
  }
  ok('a shooter spreads its aim over many modules', picks.size > 12,
    `${picks.size} distinct aim points`);
  const worst = Math.max(...picks.values()) / 4000;
  ok('...and does not favour any one of them', worst < 0.20,
    `heaviest took ${(worst * 100).toFixed(0)}% of the picks`);
  ok('...and never aims at wiring',
    [...picks.keys()].every((id) => target.sys.get(id).kind !== 'conduit'));

  // "What is possible to it": the near hemisphere. A gun cannot reach the far
  // side of a 250 m hull, so two ships on opposite beams work opposite flanks.
  const zOf = (id) => HULLS.meridian.sectionById[HULLS.meridian.moduleById[id].section].pos[2]
    + HULLS.meridian.moduleById[id].pos[2] - HULLS.meridian.com[2];
  ok('...and only at the side of the hull it is on',
    [...picks.keys()].every((id) => zOf(id) > 0),
    'picked something on the far side');

  shooter.ship = { position: new Vector3(0, 0, -4000), hull: HULLS.sabre };
  const aft = new Set();
  for (let i = 0; i < 800; i++) {
    aft.add(shooter._pickAim(target));
  }
  ok('...so a ship on the other beam works the other end',
    [...aft].every((id) => zOf(id) < 0), 'picked something on the far side');

  // A destroyed module is not a thing to shoot at twice.
  for (const m of target.sys.modules.values()) {
    m.destroyed = true;
  }
  ok('a shooter with nothing left to aim at falls back to the hull',
    shooter._pickAim(target) === null);
}

// --- a module's world position -------------------------------------------------
// modulePoint is what both the player's targeting computer and the enemy's fire
// control aim through, and it undoes two nested frames plus the centre-of-mass
// shift. worldToHull is the documented inverse, so make them agree — a sign slip
// in either aims every gun in the game at a mirror image of the right place.
{
  const ship = Object.create(Ship.prototype);
  ship.hull = HULLS.meridian;
  ship.body = { quat: new Quaternion().setFromEuler(new Euler(0.3, -1.1, 0.7)), pos: new Vector3(120, -40, 900) };
  const back = new Vector3();
  for (const id of ['reactor', 'thruster_A', 'mag_fwd', 'bridge_comp', 'sensor']) {
    if (!ship.hull.moduleById[id]) {
      continue;
    }
    const def = ship.hull.moduleById[id];
    const sec = ship.hull.sectionById[def.section];
    ship.worldToHull(ship.modulePoint(id), back);
    const wantX = sec.pos[0] + def.pos[0];
    const wantY = sec.pos[1] + def.pos[1];
    const wantZ = sec.pos[2] + def.pos[2];
    const err = Math.hypot(back.x - wantX, back.y - wantY, back.z - wantZ);
    ok(`modulePoint round-trips for ${id}`, err < 1e-6, `${err.toExponential(2)} m`);
  }
  // An id that is not on this hull must give the hull centre, never undefined —
  // a caller holding a stale module would otherwise aim at NaN.
  ok('modulePoint survives an unknown module',
    ship.modulePoint('no_such_module').distanceTo(ship.position) < 1e-9);
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

  // A field STOPS things; what it costs is dissipation.
  //
  // The model used to decide how much of a hit leaked through from the round's
  // instantaneous power, and it made a charged facet very nearly transparent to
  // the weapon most likely to be pointed at it — 28% of an AP driver round
  // stopped, 29 MJ passed into a bow wall that costs 2.5 MJ to cross. The old
  // assertion here read "a shield never fully stops a slug", which is exactly
  // the behaviour that was wrong.
  //
  // Delivery time still decides everything, just on the other side of the
  // ledger: the same joules arriving as a spike LOAD the emitters far harder
  // than a beam pouring them in slowly. A slug is not hard to stop, it is hard
  // to shed.
  const E = WEAPONS.railgun.energy;
  facet.charge = full;
  facet.load = 0;
  const slugThrough = sys.damageShield('fore', E, WEAPONS.railgun.dwell);
  const slugLoad = facet.load;
  facet.charge = full;
  facet.load = 0;
  // The same total energy, delivered the way a lance actually delivers it —
  // a frame's worth at a time — rather than pretending a beam arrives as a
  // single 40 MJ impact.
  const tickE = WEAPONS.beam.dps / 60;
  for (let e = 0; e < E; e += tickE) {
    facet.charge = full;
    sys.damageShield('fore', tickE, WEAPONS.beam.dwell);
  }
  const beamLoad = facet.load;
  facet.charge = full;
  facet.load = 0;
  const beamThrough = sys.damageShield('fore', tickE, WEAPONS.beam.dwell);

  ok('a charged facet stops a driver round outright', slugThrough === 0,
    `${(slugThrough / 1e6).toFixed(1)} MJ got through`);
  ok('...and a lance tick, too', beamThrough === 0);
  ok('but the slug loads the emitters far harder', slugLoad > beamLoad * 2,
    `slug ${(slugLoad / 1e6).toFixed(0)} MJ vs the same energy as beam `
    + `${(beamLoad / 1e6).toFixed(0)} MJ`);

  // Charge is the barrier, so a spent facet is no barrier at all.
  facet.charge = full * 0.02;
  facet.load = 0;
  const spentThrough = sys.damageShield('fore', E, WEAPONS.railgun.dwell);
  ok('a nearly spent facet lets most of it through', spentThrough > E * 0.5,
    `${(spentThrough / 1e6).toFixed(1)} of ${(E / 1e6).toFixed(1)} MJ`);

  // And it has to be a finite number of rounds, not a wall.
  facet.charge = full;
  facet.load = 0;
  facet.down = false;
  let rounds = 0;
  while (!facet.down && rounds < 100) {
    sys.damageShield('fore', E, WEAPONS.railgun.dwell);
    rounds++;
  }
  ok('a facet gives out after a few driver rounds', rounds >= 3 && rounds <= 12,
    `${rounds} rounds (${facet.cause})`);

  facet.charge = full;
  facet.load = 0;
  facet.down = false;
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
  // consequence and it is wanted.
  //
  // This assertion was flaky at about one run in seven for a real reason, and
  // the sim was at fault rather than the test: arcing could pick a MAGAZINE as
  // its victim and cook it off, costing up to 13% of the hull with nothing
  // fired at the ship. `_tickArcing` promises it "degrades a ship without ever
  // finishing one"; ordnance is excluded from it now, and the bound below is
  // tight because the outcome is no longer a lottery.
  const sys = fresh();
  run(sys, 1);
  const hullBefore = sys.hullFraction();
  sys.ionPulse(WEAPONS.ion.energy * 4);
  near('ion pulse does no structural damage of its own', sys.hullFraction(), hullBefore, 1e-6);
  run(sys, 0.3);
  ok('ion pulse drops the shields', sys.shieldFraction() < 0.35);
  ok('arcing after an ion hit costs wiring, not the ship',
    sys.hullFraction() > hullBefore - 0.01,
    `hull ${sys.hullFraction().toFixed(4)} from ${hullBefore.toFixed(4)}`);
}

// --- an arc may not set off the magazines -----------------------------------
// The invariant `_tickArcing` claims for itself, asserted directly rather than
// inferred from a hull percentage. Severed power runs sit in compartments that
// hold ordnance all over these ships; if a cable can detonate a magazine on its
// own then a lucky cut decides the engagement, which is the opposite of what
// the `critical` exclusion is there for.
{
  const sys = fresh();
  run(sys, 1);
  // Cut every power run on the ship and leave it arcing for a long while.
  for (const m of [...sys.modules.values()]) {
    if (m.kind === 'conduit' && m.def.net === 'power' && !m.def.critical) {
      sys.damageModule(m.id, 1e12);
    }
  }
  const mags = [...sys.modules.values()].filter((m) => m.kind === 'magazine');
  ok('the hull actually carries magazines to endanger', mags.length > 0);
  let cooked = 0;
  const push = sys.events.push.bind(sys.events);
  sys.events.push = (e) => {
    if (e.type === 'cookoff') { cooked++; }
    return push(e);
  };
  run(sys, 180);
  ok('sustained arcing never cooks off ordnance', cooked === 0, `${cooked} cook-offs`);
  ok('...but it does chew through other kit',
    [...sys.modules.values()].some((m) => m.kind !== 'conduit' && m.hp < m.maxHp));
}

{
  // Regression: a facet that goes down has to be able to come back. Coming back
  // needs charge, and charge only arrives via the recharge pool — so if downed
  // facets are excluded from that pool the shield deadlocks off forever.
  const sys = fresh();
  run(sys, 1);
  const f = sys.shield.facets.fore;
  let guard = 0;
  while (!f.down && guard++ < 6000) {
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
{
  let hit = null;
  Ballistics.prototype.castShrapnel.call({
    game: { random: () => 0.5 },
    resolvePath(origin, direction, distance, ctx) { hit = ctx; },
  }, new Vector3(), 1, 1e6, null);
  ok('blast fragments explicitly make small holes', hit.holeSize === 0.075);
}
{
  let checked = false;
  const owner = { disposed: false, gatherRayHits() { checked = true; } };
  const ball = Object.create(Ballistics.prototype);
  ball.game = { ships: [owner] };
  ball._hits = [];
  ball._interceptedMissile = () => null;
  ball.resolvePath(new Vector3(), new Vector3(0, 0, 1), 10,
    { energy: 1, ap: 1, dwell: 1, owner, excludeOwner: null, caliber: 'shrapnel' });
  ok('warhead fragments can hit the ship that intercepted them', checked);
}
{
  const sys = new Systems(HULLS.meridian, { game: { random: () => 0 } });
  const mag = sys.get('mag_fwd');
  sys.damageModule(mag.id, 4e5, null, null);
  const events = sys.events.filter((e) => e.module === mag);
  ok('a hit-triggered cook-off emits one magazine kill event',
    events.length === 1 && events[0].type === 'cookoff', events.map((e) => e.type).join(','));
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
  const helmStrength = () => Crew.strength(helm);
  const helmMax = helm.max;
  ok('the bridge watch is not in suits', !helm.suited);
  sys.section('bridge').atmo = 0;
  sys.section('bridge').breached = true;
  sys.section('bridge').breachSize = 1;
  run(sys, 14, crew);
  ok('vacuum thins or drives off an unsuited bridge watch',
    helmStrength() < helmMax || helm.parties.some((q) => q.at !== 'bridge'),
    `size=${helmStrength().toFixed(0)}/${helmMax}`);
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

  for (const m of sys.modules.values()) {
    if (m.kind === 'shieldGen') {
      sys.damageModule(m.id, 1e12);
    }
  }
  run(sys, 1);
  ok('a shield with no live projectors reports empty',
    sys.shieldFraction() === 0 && sys.shieldRated() === 0);
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
{
  const sys = fresh();
  const ambient = sys.loops.get('l.core').temp;
  for (const loop of sys.loops.values()) {
    loop.temp = 100;
    loop.heatIn = 0;
  }
  for (const m of sys.modules.values()) {
    m.temp = 100;
    m.duty = 0;
    m.heatAcc = 0;
  }
  sys._tickNetworks();
  const loop = sys.loops.get('l.core');
  const up = sys.online.coolant.get(loop.id) || 0;
  const reject = [...sys.modules.values()].filter((m) => m.kind === 'radiator')
    .reduce((total, m) => total + m.def.reject, 0);
  const oldOut = (100 - ambient) * (0.35 + reject * 1.5)
    * (0.15 + 0.85 * up);
  const oldTemp = 100 - (oldOut / loop.capacity) * 1.4;
  sys._tickThermal(1);
  ok('ship-wide radiator capacity is not applied to every coolant loop', loop.temp > oldTemp + 1e-6,
    `${loop.temp.toFixed(3)} vs old ${oldTemp.toFixed(3)}`);
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
  // Only the guns that can actually bear on ONE aspect. Since the MERIDIAN
  // became a broadside hull, "every hardpoint at full duty" describes something
  // the ship cannot do — half its battery is masked by its own hull at any
  // bearing, and billing the power system for both beams at once is a load that
  // will never exist.
  const bearing = (() => {
    let best = [];
    for (let deg = 0; deg <= 180; deg += 5) {
      const th = (deg * Math.PI) / 180;
      const aim = new Vector3(Math.sin(th), 0, Math.cos(th));
      const borne = hull.hardpoints.filter((m) => {
        const rest = new Vector3(...m.dir).normalize();
        return Math.acos(Math.max(-1, Math.min(1, rest.dot(aim)))) <= m.arc + 1e-9;
      }).map((m) => m.id);
      if (borne.length > best.length) { best = borne; }
    }
    return new Set(best);
  })();
  const load = (sc) => {
    const sys = new Systems(hull);
    for (let i = 0; i < 300 * 60; i++) {
      for (const m of sys.modules.values()) {
        if (m.kind === 'thruster' || m.kind === 'rcs') { m.duty = sc.drive; }
        if (m.kind === 'hardpoint') { m.duty = bearing.has(m.id) ? sc.guns : 0; }
      }
      if (sc.incoming) {
        // Sustained pressure the field can actually hold. Harder than this and
        // the facets collapse, and a collapsed shield stops drawing power —
        // which measures a dead shield rather than one working for its living.
        for (const f of ['fore', 'port', 'dorsal']) {
          sys.damageShield(f, (WEAPONS.beam.dps / 60) * 0.32, 1 / 60);
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
  //
  // Measured against ONE broadside, which is all a beam-on hull can ever fire:
  // that runs the plant to about 99% of what it is making, so the ship has no
  // margin left for a boost, a facet re-striking or a battery coming back
  // online. Both beams at once — which no hull can actually do — is 988 MW
  // against 729 and shuts things off.
  const all = load({ drive: 1, guns: 1, incoming: 1 });
  ok('drives, guns and a shield under fire together run the plant to its limit',
    all.demand > all.supply * 0.95,
    `${all.demand.toFixed(0)} of ${all.supply.toFixed(0)} MW `
    + `(${((all.demand / all.supply) * 100).toFixed(0)}%)`);
  ok('...with no headroom left for anything else',
    all.demand > rest.demand * 1.8,
    `${all.demand.toFixed(0)} vs ${rest.demand.toFixed(0)} MW at rest`);
}

// --- a wrecked store still has something in it ------------------------------
// Spares are inert boxes on shelves, not machinery. Treating a destroyed bay as
// holding literally nothing meant a SABRE — which carries its whole 260 units
// in one hold — lost the entire damage-control capability to a single round:
// the parties kept taking jobs, finding nothing to work with, and going back to
// station forever, which reads from the panel as a crew standing idle.
{
  const hull = HULLS.sabre;
  const sys = new Systems(hull);
  const crew = new Crew(hull, sys);
  run(sys, 2, crew);
  const full = sys.totalSpares();
  ok('the picket carries its stock in one hold',
    hull.modules.filter((m) => m.kind === 'cargo').length === 1);
  ok('and it starts stocked', full > 100, `${full}`);

  sys.damageModule('cargo', 1e12, null, null);
  const left = sys.totalSpares();
  ok('wrecking the hold costs most of the stock but not all of it',
    left > full * 0.2 && left < full * 0.6, `${full} -> ${left}`);
  ok('...and what is left can actually be drawn on', sys.takeSpares(10) > 0);

  // The capability survives: give it damage and it works on it.
  for (const id of ['l_core', 'sensor', 'thruster_A', 'rcs_fwd']) {
    if (sys.get(id)) {
      sys.damageModule(id, 1e12, null, null);
    }
  }
  const broken = [...sys.modules.values()].filter((m) => m.destroyed).length;
  run(sys, 240, crew);
  const after = [...sys.modules.values()].filter((m) => m.destroyed).length;
  ok('a ship whose only hold was wrecked can still repair itself', after < broken,
    `${broken} destroyed -> ${after}`);
}

// --- the roster says what each party is on ----------------------------------
// A division shows one state, and "STATION" covered both "nothing to do" and
// "eleven parties spread over the ship" equally badly.
{
  const hull = HULLS.meridian;
  const sys = new Systems(hull);
  const crew = new Crew(hull, sys);
  run(sys, 2, crew);
  for (const id of ['c_dorsal', 'rad_LF', 'sensor', 'pump_aux', 'l_fwd', 'cargo_A',
    'computer_aux', 'rcs_wingL']) {
    if (sys.get(id)) {
      sys.damageModule(id, 4e6, null, null);
    }
  }
  run(sys, 8, crew);
  const roster = crew.roster();
  const working = roster.filter((c) => c.jobs.length > 0);
  ok('the roster reports what the parties are on', working.length > 0);
  ok('...naming the actual fitting, not an id',
    working.every((c) => c.jobs.every((j) => j.what && !j.what.includes('_'))),
    working.flatMap((c) => c.jobs.map((j) => j.what)).join(', '));
  ok('...with the hands on each', working.every((c) => c.jobs.every((j) => j.hands > 0)));
  // Several distinct jobs across the ship, which is the point of parties.
  const distinct = new Set(roster.flatMap((c) => c.jobs.map((j) => j.what)));
  ok('...and several different jobs at once', distinct.size >= 3,
    [...distinct].join(', '));
}

// --- damage control works in parties, not as a mob --------------------------
// A division is an establishment, not a body of people who all walk to the same
// hatch. Treating it as one unit that takes ONE job meant a seventy-hand
// division put at most HANDS_PER_JOB onto a single repair and the rest stood at
// their station: measured on a cruiser with seventeen outstanding jobs, three
// of eight divisions tasked and forty-two hands working out of four hundred and
// twenty aboard.
{
  const hull = HULLS.meridian;
  const sys = new Systems(hull);
  const crew = new Crew(hull, sys);
  run(sys, 2, crew);
  ok('a division is made of several parties',
    crew.divisions.every((d) => d.parties.length > 1),
    crew.divisions.map((d) => `${d.name}:${d.parties.length}`).join(' '));
  ok('and the parties add up to the establishment',
    crew.divisions.every((d) => Math.abs(Crew.strength(d) - d.max) < 1e-6));

  // Damage spread across the ship, so there is plenty to be getting on with.
  for (const id of ['c_dorsal', 'c_keel', 'rad_LF', 'rad_RA', 'sensor', 'pump_aux',
    'l_fwd', 'c_data_fireF', 'thruster_A', 'lifesupport', 'computer_aux',
    'rcs_wingL', 'cargo_A', 'shieldcap_f', 'pump_aft', 'c_main_batLF']) {
    if (sys.get(id)) {
      sys.damageModule(id, 4e6, null, null);
    }
  }
  run(sys, 8, crew);

  const busy = crew.parties.filter((q) => q.size > 0 && (q.task || q.heading));
  const hands = busy.reduce((a, q) => a + q.size, 0);
  const places = new Set(busy.map((q) => q.heading || q.at));
  ok('many parties turn out, not one per division', busy.length > crew.divisions.length,
    `${busy.length} parties working`);
  ok('...spread over several compartments', places.size >= 4,
    `${places.size} compartments`);
  ok('...putting real numbers to work', hands > crew.headcount * 0.15,
    `${hands.toFixed(0)} of ${crew.headcount} aboard`);
  // And they must not all pile onto the same job.
  const perJob = new Map();
  for (const q of busy) {
    const k = `${q.task ? q.task.kind : 'move'}:${q.task ? q.task.target : q.heading}`;
    perJob.set(k, (perJob.get(k) || 0) + q.size);
  }
  ok('and no single job soaks up the whole watch',
    Math.max(...perJob.values()) < hands * 0.75,
    [...perJob.entries()].map(([k, v]) => `${k}=${v.toFixed(0)}`).join(' '));
}

// --- a wreck turns its whole crew to recovery -------------------------------
// Holding a post is right while the ship can still use it: a gunnery deck that
// leaves its mounts stops shooting. On a hull shot to a standstill it is the
// wrong answer — a disabled ship sat with its engineering watch at a station
// that no longer did anything while it span and two damage-control divisions
// tried to recover it alone. Stations keep a skeleton and the rest turn to.
{
  const hull = HULLS.halberd;
  const sys = new Systems(hull);
  const crew = new Crew(hull, sys);
  run(sys, 2, crew);
  const outNow = () => crew.parties.filter((q) => q.size > 0 && (q.task || q.heading));
  const stationRoles = crew.divisions.filter((d) => d.role !== 'damage');

  for (const id of ['thruster_A', 'thruster_B', 'rcs_fwd', 'rcs_aft', 'computer',
    'c_react_main', 'l_fwd', 'pump_aux', 'rad_LF', 'sensor', 'shieldgen', 'lifesupport']) {
    if (sys.get(id)) {
      sys.damageModule(id, 1e12, null, null);
    }
  }
  run(sys, 10, crew);
  ok('the ship really is disabled', sys.driveAuthority() < 0.15,
    `${(sys.driveAuthority() * 100).toFixed(0)}% drive authority`);

  const out = outNow();
  const hands = out.reduce((a, q) => a + q.size, 0);
  ok('a wreck turns nearly everybody to recovery',
    hands > crew.headcount * 0.6, `${hands.toFixed(0)} of ${crew.headcount}`);
  ok('...including the station watches, not just damage control',
    stationRoles.some((d) => d.parties.some((q) => q.size > 0 && (q.task || q.heading))));
  // A station that is on fire or open to space is abandoned outright, and
  // should be — the skeleton only applies where there is still a post to stand
  // at. On this wreck the bridge itself is uninhabitable.
  const habitable = stationRoles.filter((d) => crew._tenable(d.station)
    && d.parties.some((q) => q.size > 0));
  // Manning the post means BEING there, not being idle: the skeleton party is
  // free to work a repair inside its own compartment, which is exactly what a
  // watch left behind would do.
  ok('...but a habitable station keeps somebody standing on it',
    habitable.length > 0
      && habitable.every((d) => d.parties.some((q) => q.size > 0 && q.at === d.station
        && !q.heading)),
    habitable.filter((d) => !d.parties.some((q) => q.size > 0 && q.at === d.station
      && !q.heading)).map((d) => d.name).join(', ') || 'none');
}

// --- the ship cross-decks to stay in the fight ------------------------------
// A warship does not write off a battery because the people standing in it were
// killed. Without this a single hit that emptied a gunnery deck cost those guns
// permanently however many hundreds of hands were still aboard, and repairing
// the mounts changed nothing because nobody was left to lay them.
//
// Order matters: seal the compartment, THEN post people into it. And it has to
// run out — a donor keeps its own floor, so once nothing is above that floor
// the ship simply fights understrength everywhere.
{
  const hull = HULLS.meridian;
  const sys = new Systems(hull);
  const crew = new Crew(hull, sys);
  run(sys, 2, crew);
  const gunners = crew.divisions.filter((d) => d.role === 'gunner');
  const victim = gunners.find((d) => d.station === 'batteryRF') || gunners[0];
  sys.punchHole(victim.station, 6);
  crew.killIn(victim.station, 60);
  const vs = () => Crew.strength(victim);
  ok('the hit really did empty that station', vs() < 1, `${vs()}`);

  // While it is still open to space, nobody is posted in.
  run(sys, 40, crew);
  if (sys.section(victim.station).atmo <= ATMO_CRITICAL) {
    ok('nobody is posted into a compartment still open to space', vs() < 1,
      `${vs().toFixed(0)} hands in vacuum`);
  }

  run(sys, 600, crew);
  ok('once it is sealed, hands cross-deck into it', vs() > victim.max * 0.4,
    `${vs().toFixed(0)}/${victim.max}`);
  ok('...so the guns can be laid again', crew.station('gunner') > 0.5,
    `${(crew.station('gunner') * 100).toFixed(0)}%`);
  // Nobody is stripped bare to do it.
  const floor = Math.min(...crew.divisions
    .map((d) => Crew.strength(d) / d.max).filter((f) => f > 0));
  ok('and no station is stripped bare to man another', floor > 0.5, `${floor.toFixed(2)}`);
  // It cannot conjure people.
  ok('cross-decking moves hands, it does not make them',
    crew.headcount <= crew.complementMax);
}

// --- holes are welded in parallel, at a rate set by the plate ---------------
// Reported as jobs queuing: three breaches showing, one shrinking. They were
// all being worked; the second and third were simply slower, because welding
// cost `plateMax / 12` joules per square metre — the compartment's total HULL
// POINTS, which has nothing to do with closing a hole. A big room was slower to
// patch than a small one made of identical plate, and a dreadnought's
// compartments were glacial purely for being large: 51 seconds a square metre
// against a picket's one. Thickness is what a welder actually fights.
{
  const hull = HULLS.meridian;
  const sys = new Systems(hull);
  const crew = new Crew(hull, sys);
  run(sys, 2, crew);
  const secs = ['forehold', 'engineering', 'spine'];
  for (const id of secs) {
    sys.punchHole(id, 4);
  }
  // Dispatch is what must be parallel. Arrival is not: crossing a breached,
  // airless compartment costs about fifteen seconds a hop, so the far hole is
  // legitimately untouched while its parties are still walking to it.
  run(sys, 1, crew);
  const assigned = secs.map((id) => crew.parties.filter((q) => q.size > 0 && q.task
    && q.task.kind === 'patch' && q.task.target === id).length);
  ok('parties are dispatched to every open compartment at once',
    assigned.every((n) => n > 0),
    secs.map((id, i) => `${id}:${assigned[i]}`).join(' '));

  const before = secs.map((id) => sys.section(id).breachSize);
  run(sys, 45, crew);
  const after = secs.map((id) => sys.section(id).breachSize);
  ok('and every one of them is worked down',
    after.every((a, i) => a < before[i]),
    secs.map((id, i) => `${id} ${before[i].toFixed(1)}->${after[i].toFixed(1)}`).join(' '));

  run(sys, 240, crew);
  ok('and the hull gets closed in a sane time', sys.breachArea() === 0,
    `${sys.breachArea().toFixed(1)} m² still open`);
}

// --- welding depends on the plate, not the size of the room -----------------
{
  const hull = HULLS.meridian;
  const sys = new Systems(hull);
  run(sys, 1);
  // Two compartments with very different plate POOLS but similar thickness
  // should weld at similar rates; the thick-belted one should be slower.
  const thin = hull.sections.find((x) => x.id === 'batteryLF');
  const thick = hull.sections.find((x) => x.id === 'spine');
  ok('the test picks compartments with genuinely different plate', thick.wall > thin.wall);
  const close = (id, joules) => {
    sys.punchHole(id, 6);
    const b0 = sys.section(id).breachSize;
    sys.patchSection(id, joules);
    return b0 - sys.section(id).breachSize;
  };
  const thinClosed = close(thin.id, 1e6);
  const thickClosed = close(thick.id, 1e6);
  ok('thicker plate welds slower', thickClosed < thinClosed,
    `${thin.id} ${thinClosed.toFixed(3)} m² vs ${thick.id} ${thickClosed.toFixed(3)} m²`);
  // ...and in proportion to thickness, not to the HP pool.
  const ratio = thinClosed / thickClosed;
  const wallRatio = thick.wall / thin.wall;
  ok('...in proportion to thickness', Math.abs(ratio - wallRatio) < 0.05,
    `rate ratio ${ratio.toFixed(2)} vs wall ratio ${wallRatio.toFixed(2)}`);
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
  sys.damageSection('batteryLF', 1e8, null, null);

  const spares0 = sys.totalSpares();
  ok('the mauling actually took', [...sys.modules.values()].filter((m) => m.destroyed).length >= 8);
  ok('...and opened the hull', [...sys.sections.values()].filter((s) => s.breached).length >= 2);
  const buckled = [...sys.sections.values()].filter((s) => s.frameBroken).length;
  ok('the mauling buckles a frame', buckled > 0, `${buckled} broken frames`);

  run(sys, 60, crew);

  run(sys, 900, crew);
  ok('every wrecked module is rebuilt from spares',
    [...sys.modules.values()].filter((m) => m.destroyed).length === 0,
    [...sys.modules.values()].filter((m) => m.destroyed).map((m) => m.id).join(', '));
  ok('every breach is welded shut, vented or not',
    [...sys.sections.values()].filter((s) => s.breached).length === 0,
    [...sys.sections.values()].filter((s) => s.breached).map((s) => s.id).join(', '));
  ok('and a buckled frame is shored back up',
    [...sys.sections.values()].filter((s) => s.frameBroken).length === 0);
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
  sys.get('reactor_aux').detonated = true;
  ok('an auxiliary reactor detonation also strikes the ship', sys.isStricken());
  sys.get('reactor_aux').detonated = false;
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
        for (const q of d.parties) {
          q.size = 0;
        }
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
    // A weapon may wear another fitting's model — the kit is generated from
    // Blender, so a new gun borrows until someone rebuilds it one of its own.
    // What must hold is that whatever it wears exists, and that the geometry
    // and the muzzle points come from the SAME fitting: taking barrels from one
    // model and firing points from another puts the shot beside the barrel.
    const art = w.art || w.id;
    ok(`${w.id} has a modelled gun`, !!PARTS[`gun_${art}`], `wants gun_${art}`);
    ok(`${w.id} has muzzle points`, Array.isArray(MUZZLES[art]) && MUZZLES[art].length > 0,
      `wants MUZZLES.${art}`);
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

  // A gun that cannot bear holds its fire.
  //
  // Every mount fired whenever the trigger was held, bearing or not — so on a
  // broadside hull pointed at something, the whole off-side battery emptied
  // itself into empty space. Eight repeating drivers at 240 rpm is about three
  // hundred rounds per ten seconds of held trigger, bought and paid for by the
  // player and guaranteed to miss.
  //
  // The test is aim against the SOLUTION, never against the target's position:
  // a gun correctly leading a crossing target is deliberately not pointing at
  // it, and comparing the two would hold fire exactly when the shot is good.
  {
    const ship = Object.create(Ship.prototype);
    ship.body = { quat: new Quaternion() };
    ship.localToWorld = (local, out) => out.copy(local);
    const at = (x, y, z) => new Vector3(x, y, z).normalize();
    const mount = (aim, want) => ({ aim: at(...aim), want: at(...want), origin: new Vector3() });

    ok('a mount laid on the solution bears',
      ship._bears(mount([0, 0, 1], [0, 0, 1]), null));
    ok('a mount hard against its stop does not',
      !ship._bears(mount([0, 0, 1], [0.6, 0, 0.8]), null));
    ok('nor does one still slewing onto it',
      !ship._bears(mount([0, 0, 1], [0.12, 0, 0.99]), null));

    // Angular size buys slack: the same error is a hit on something big and
    // close, and a miss on something small and far.
    const off = mount([0, 0, 1], [0.05, 0, 0.999]);
    const near = { position: new Vector3(0, 0, 900), hitRadius: 126 };
    const far = { position: new Vector3(0, 0, 9000), hitRadius: 48 };
    ok('...and a wide target close in is still worth shooting at',
      ship._bears(off, near));
    ok('...while the same lay misses a small one far off',
      !ship._bears(off, far));
  }

  {
    const ship = Object.create(Ship.prototype);
    ship.body = { quat: new Quaternion(), vel: new Vector3() };
    ship.game = { simTime: 0 };
    ship.sys = { hasData: () => true };
    ship.localToWorld = (local, out) => out.copy(local);
    const mount = {
      weapon: { muzzleVel: 120, topSpeed: 620 }, origin: new Vector3(),
      rest: new Vector3(0, 0, 1), up: new Vector3(0, 1, 0),
      aim: new Vector3(0, 0, 1), want: new Vector3(), mod: { eff: 1 }, traverses: true, def: { arc: Math.PI },
    };
    ship._aimMount(mount, { position: new Vector3(0, 0, 1000), velocity: new Vector3(300, 0, 0) }, 10, null);
    ok('missile mounts lead at sustained speed rather than tube speed', mount.want.x > 0.3,
      `lead ${mount.want.x.toFixed(3)}`);
  }

  // Every gun has to be able to join a fight the ship can actually have.
  //
  // The original form of this asserted every mount could traverse onto the
  // BORESIGHT, which caught the real bug — two dorsal repeaters aimed up and
  // aft, 135 degrees off the bow with a 75 degree arc, sixty degrees short of
  // ever bearing on anything the reticle was on. But it also hard-coded a
  // nose-fighting roster, and a broadside ship's main battery is supposed to be
  // unable to point forward. The invariant that survives the doctrine is: there
  // has to BE an aspect where the ship brings its weight to bear, and no gun may
  // be aimed somewhere it can never join in.
  //
  // Point defence is exempt: it lays itself at ordnance and is deliberately
  // fitted to cover arcs the gunnery cannot.
  {
    const dpsOf = (w) => (w.kind === 'beam' ? w.dps : (w.energy * (w.rpm || 0)) / 60);
    for (const [id, hull] of Object.entries(HULLS)) {
      const guns = hull.hardpoints.filter((m) => !WEAPONS[m.weapon].pointDefence);
      const total = guns.reduce((a, m) => a + dpsOf(WEAPONS[m.weapon]), 0);
      // Sweep bearings in the yaw plane, the plane ships actually manoeuvre in.
      let best = 0;
      let bestAt = 0;
      for (let deg = 0; deg <= 180; deg += 1) {
        const th = (deg * Math.PI) / 180;
        const aim = new Vector3(Math.sin(th), 0, Math.cos(th));
        let borne = 0;
        for (const m of guns) {
          const rest = new Vector3(...m.dir).normalize();
          if (Math.acos(Math.max(-1, Math.min(1, rest.dot(aim)))) <= m.arc + 1e-9) {
            borne += dpsOf(WEAPONS[m.weapon]);
          }
        }
        if (borne > best) {
          best = borne;
          bestAt = deg;
        }
      }
      // A third, not a half. A broadside hull masks one entire beam with its
      // own body at every bearing, and its bow guns cannot join that beam
      // either, so the most a ship like the MERIDIAN can ever concentrate is
      // around 40% of what it carries. Below a third and the fit is genuinely
      // scattered — guns that never get to fire at the same thing.
      ok(`${id}: has a fighting aspect worth turning to`, best >= total * 0.33,
        `best ${(best / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MJ/s at ${bestAt}deg`);

      // And nothing is aimed where it can never contribute.
      let worst = null;
      for (const m of guns) {
        const off = Math.acos(new Vector3(...m.dir).normalize().z);
        if (off - m.arc > (120 * Math.PI) / 180) {
          worst = m.id;
        }
      }
      ok(`${id}: no gun is aimed where it can never join in`, worst === null, worst || '');
    }
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
          + Math.max(...MUZZLES[WEAPONS[def.weapon].art || def.weapon]
            .map((m) => Math.hypot(m[0], m[1], m[2])))) * scale;
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
    fx: { motorPlume() {}, explosion() {} },
    audio: { boom() {} },
    explode(pos, opts) { blasts.push({ pos: pos.clone(), owner: opts.owner }); },
  };
  const ball = new Ballistics(game);
  const gunner = { name: 'GUNNER', faction: 'friendly' };
  const launcher = { name: 'LAUNCHER', faction: 'hostile' };
  const ally = { name: 'ALLY', faction: 'friendly' };
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
  ball.missiles[0].owner = ally;
  fire(new Vector3(0, 0, 0), new Vector3(0, 0, 1), 2000);
  ok('and you cannot shoot down allied ordnance', ball.missiles.length === 1);

  // Fragments do not: sympathetic detonation would splice the missile array
  // from inside the loop that is already walking it.
  ball.missiles[0].owner = launcher;
  ball.resolvePath(new Vector3(0, 0, 0), new Vector3(0, 0, 1), 2000,
    { energy: 1e6, ap: 1, dwell: 1e-3, owner: gunner, caliber: 'shrapnel', impulse: 10 });
  ok('a blast fan leaves other warheads alone', ball.missiles.length === 1);
}

// --- point defence covers the ship, not just the roof ------------------------
{
  const ship = Object.create(Ship.prototype);
  ship.faction = 'friendly';
  ship.body = { quat: new Quaternion() };
  ship.localToWorld = (local, out) => out.copy(local);
  ship._pdTarget = { pos: null, vel: null, cone: 0 };
  ship._pdLoad = new Map();
  ship.game = { ballistics: { missiles: [{ armT: 0, owner: { faction: 'hostile' }, pos: new Vector3(0, -20, 20), vel: new Vector3() }] }, ships: [] };
  const mount = { weapon: { pdRange: 100, pdShipRange: 0 }, origin: new Vector3(), rest: new Vector3(0, 0, 1), up: new Vector3(0, 1, 0), def: { arc: Math.PI } };
  ok('point defence ignores threats below its depression stop', ship._pdThreat(mount) === null);
}
// A mount cannot depress below the deck it is bolted to, so a hull carrying
// nothing but dorsal repeaters is wide open from underneath — and every hull
// here was. A torpedo run from below arrived unopposed against all four.
{
  const DEPRESS = Math.sin(MOUNT_DEPRESSION);
  for (const [id, hull] of Object.entries(HULLS)) {
    const pd = hull.hardpoints.filter((m) => WEAPONS[m.weapon].pointDefence);
    // Fibonacci sphere: even coverage of every bearing, cheaply.
    const N = 900;
    let covered = 0;
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const rr = Math.sqrt(Math.max(0, 1 - y * y));
      const th = Math.PI * (1 + Math.sqrt(5)) * i;
      const v = new Vector3(Math.cos(th) * rr, y, Math.sin(th) * rr);
      for (const m of pd) {
        const rest = new Vector3(...m.dir).normalize();
        if (Math.acos(Math.max(-1, Math.min(1, rest.dot(v)))) > m.arc) {
          continue;
        }
        const sec = hull.sectionById[m.section];
        // And it must not be asked to fire through its own plating.
        if (v.dot(mountFrame(m.pos, sec.half, m.dir, sec.style).up) < -DEPRESS) {
          continue;
        }
        covered++;
        break;
      }
    }
    const pct = (100 * covered) / N;
    if (id === 'sabre') {
      // The picket is the deliberate exception: no deck space for a ring and no
      // plant to run one, so it has real blind arcs. That is the class.
      ok(`${id}: a picket has genuine blind arcs`, pct > 30 && pct < 85,
        `covers ${pct.toFixed(0)}% of the sky with ${pd.length} mounts`);
    } else {
      ok(`${id}: point defence covers every bearing`, pct > 99,
        `covers ${pct.toFixed(0)}% of the sky with ${pd.length} mounts`);
    }
    ok(`${id}: point defence feeds from its own locker`,
      pd.every((m) => m.feed === 'mag_pd'));
  }
}

// --- seekers actually intercept ---------------------------------------------
// Proportional navigation steers to null the ROTATION of the sight line, which
// is a different thing from pointing at a predicted position, and it is easy to
// implement in a way that looks right and misses every time. The first pass
// rate-limited the NOSE — lerping the heading toward the commanded one by
// `turnRate * dt` — which clips every command to a fraction of a degree,
// because the commanded heading is only a couple of degrees off the current one
// by construction. Guidance appeared to work perfectly and the missile sailed
// past a stationary picket at 250 metres, every single time. Nothing but a
// measured miss distance catches that.
{
  const scene = { add() {}, remove() {} };
  const game = {
    scene,
    ships: [],
    fx: { motorPlume() {}, explosion() {} },
    audio: { boom() {} },
    explode() {},
  };
  const ball = new Ballistics(game);

  /** Fly one warhead at a target and report how close it got, in metres. */
  const intercept = (weapon, from, aimAt, target, seconds) => {
    ball.missiles.length = 0;
    game.ships = [target];
    ball.spawnMissile({ name: 'LAUNCHER', faction: 'a' }, from,
      aimAt.clone().sub(from).normalize(), new Vector3(), weapon, target);
    ball.missiles[0].armT = 1e9;      // never fuse; we want the miss distance
    let best = Infinity;
    const dt = 1 / 60;
    for (let t = 0; t < seconds; t += dt) {
      target.position.addScaledVector(target.velocity, dt);
      ball._stepMissiles(dt);
      if (ball.missiles.length === 0) {
        break;
      }
      best = Math.min(best, ball.missiles[0].pos.distanceTo(target.position));
    }
    return best;
  };
  const dummy = (pos, vel) => ({
    position: pos, velocity: vel, disposed: false, dead: false,
    hitRadius: 40, faction: 'b',
    sys: { get: () => null },
    heatSignature: () => 4000,
  });

  {
    const t = dummy(new Vector3(600, 0, 4000), new Vector3());
    const miss = intercept(WEAPONS.seeker, new Vector3(), new Vector3(0, 0, 1), t, 12);
    ok('a seeker hits a stationary target it was launched past',
      miss < 40, `missed by ${miss.toFixed(0)} m`);
  }
  {
    // Crossing at 300 m/s: the case pure pursuit cannot solve at all.
    const t = dummy(new Vector3(0, 0, 4500), new Vector3(300, 0, 0));
    const miss = intercept(WEAPONS.seeker, new Vector3(), new Vector3(0, 0, 1), t, 12);
    ok('...and one crossing at three hundred metres a second',
      miss < 60, `missed by ${miss.toFixed(0)} m`);
  }
  {
    const t = dummy(new Vector3(400, 0, 4000), new Vector3(-120, 60, 0));
    const miss = intercept(WEAPONS.torpedo, new Vector3(), new Vector3(0, 0, 1), t, 30);
    ok('and a torpedo, which turns a third as hard, still connects',
      miss < 60, `missed by ${miss.toFixed(0)} m`);
  }

  // The seeker head: two channels, and which one wins is a fact about the
  // target rather than a coin toss.
  {
    const cold = dummy(new Vector3(0, 0, 2000), new Vector3());
    cold.hitRadius = 200;                 // a big hull, coasting
    cold.heatSignature = () => 50;
    const hot = dummy(new Vector3(300, 0, 2000), new Vector3());
    hot.hitRadius = 30;                   // a picket at full burn
    hot.heatSignature = () => 4e5;
    game.ships = [cold, hot];
    const m = {
      pos: new Vector3(), vel: new Vector3(0, 0, 400),
      weapon: WEAPONS.seeker, owner: { faction: 'a' },
    };
    ok('an infrared head takes the hot picket over the cold dreadnought', ball._acquire(m) === hot);
    hot.heatSignature = () => 5;          // engines cut
    ok('...and once it goes cold, the optical channel takes the big one', ball._acquire(m) === cold);
    // And never the fleet it was launched by.
    cold.faction = 'a';
    hot.faction = 'a';
    ok('a seeker will not turn on its own side', ball._acquire(m) === null);
    game.ships = [];
  }
}

// --- directors spread across a salvo ----------------------------------------
// Every mount picking the nearest warhead meant a ring of eight stacked on the
// leader of a salvo and the rest arrived untouched. And folding the doubling-up
// penalty into the RANGE budget — the first attempt — was worse: the fourth
// director to look at a lone torpedo scored it 2700 m past where it was,
// decided it was out of reach and went off to shoot at the ship instead.
{
  const ship = Object.create(Ship.prototype);
  ship.faction = 'friendly';
  ship.body = { quat: new Quaternion() };
  ship.localToWorld = (local, out) => out.copy(local);
  ship._pdTarget = { pos: null, vel: null, cone: 0 };
  ship._pdLoad = new Map();
  const warheads = [
    { pos: new Vector3(0, 0, 400), vel: new Vector3(), armT: 0, owner: { faction: 'x' } },
    { pos: new Vector3(0, 0, 500), vel: new Vector3(), armT: 0, owner: { faction: 'x' } },
    { pos: new Vector3(0, 0, 600), vel: new Vector3(), armT: 0, owner: { faction: 'x' } },
  ];
  ship.game = { ballistics: { missiles: warheads }, ships: [] };
  const mount = {
    def: { arc: Math.PI }, weapon: WEAPONS.repeater, rest: new Vector3(0, 0, 1),
    origin: new Vector3(),
  };

  const taken = [];
  for (let i = 0; i < 6; i++) {
    const t = ship._pdThreat(mount);
    taken.push(warheads.findIndex((m) => m.pos === t.pos));
  }
  ok('a ring of directors spreads itself across a salvo',
    new Set(taken).size === 3, `took ${taken.join(',')}`);
  ok('...nearest first', taken[0] === 0 && taken[1] === 1 && taken[2] === 2);

  // A lone warhead gets the whole battery — the penalty ranks candidates, it
  // does not disqualify them.
  ship._pdLoad.clear();
  warheads.length = 1;
  let all = true;
  for (let i = 0; i < 8; i++) {
    all = all && ship._pdThreat(mount) !== null;
  }
  ok('but a lone torpedo gets every mount that can bear', all);

  // Ordnance always wins the argument against a hull.
  ship._pdLoad.clear();
  const hull = {
    position: new Vector3(0, 0, 900), velocity: new Vector3(), hitRadius: 80,
    disposed: false, dead: false, faction: 'x',
  };
  ship.game.ships = [ship, hull];
  ok('a director drops a ship the moment a warhead is in its arc',
    ship._pdThreat(mount).pos === warheads[0].pos);
  warheads.length = 0;
  ship._pdLoad.clear();
  ok('...and holds the ship when nothing is inbound',
    ship._pdThreat(mount).pos === hull.position);
  hull.position.set(0, 0, WEAPONS.repeater.pdShipRange + 10);
  ship._pdLoad.clear();
  ok('...but not past the band it was given', ship._pdThreat(mount) === null);
}

// --- fire is an internal problem --------------------------------------------
// It lives on the compartment's atmosphere. Open the plate and it goes out —
// but not instantly, and the difference is the whole mechanic: a big
// compartment with a small hole holds pressure for a while, which is the window
// where flame is visible from outside, roaring out of the wound. Then it
// gutters as the room empties.
{
  const sys = fresh();
  run(sys, 0.5);
  const sec = sys.section('spine');
  sec.spill = 0.5;
  // Sixty seconds of fuel, so nothing below can be the clock running out.
  ok('a spill fire lights in a sealed compartment', sys.ignite('spine', 60));
  sys.punchHole('spine', 0.55);
  run(sys, 3);
  ok('...and goes on burning while there is still pressure behind the hole',
    sec.fire > 0 && sec.atmo > 0.2,
    `fire ${sec.fire.toFixed(1)} s, atmo ${sec.atmo.toFixed(2)}`);
  run(sys, 90);
  ok('...and is out once the compartment has emptied', sec.fire === 0,
    `atmo ${sec.atmo.toFixed(3)}`);
  // And it cannot be restarted in a compartment that is open, however much is
  // still on the deck.
  sec.spill = 1;
  ok('a compartment open to space will not catch at all', !sys.ignite('spine', 60));
}
{
  const sys = fresh();
  run(sys, 0.5);
  sys.section('spine').spill = 0.8;
  sys.ignite('spine', 30);
  sys.ventSection('spine');
  run(sys, 6);
  ok('an emergency vent still smothers a fire outright',
    sys.section('spine').fire === 0);
}
{
  // Gunfire has to be able to START one, or none of the above ever happens —
  // and it must not start one every time, or fire stops being an event and
  // becomes the ship's paint. Both ends are pinned, because the failure is
  // one-sided in each direction and only the pair says where it should sit.
  //
  // Ignition used to reach certainty: any hit taking about a quarter of a
  // compartment's plate lit it with probability one. That was survivable while
  // every attacker aimed at the centre of mass, and stopped being so the moment
  // hulls started picking compartments — nine of a cruiser's fourteen were
  // alight inside ten seconds of three ships engaging it properly.
  const sys = fresh();
  run(sys, 0.5);
  const sec = sys.section('fwdbattery');
  const salvo = (hits, joulesFrac) => {
    let lit = 0;
    for (let trial = 0; trial < 60; trial++) {
      sec.spill = 0;
      sec.fire = 0;
      sec.atmo = 1;
      sec.plateHp = sec.plateMax;
      sec.breached = false;
      sec.breachSize = 0;
      for (let i = 0; i < hits; i++) {
        sys.damageSection('fwdbattery', sec.plateMax * joulesFrac, null, null);
      }
      if (sec.fire > 0) {
        lit++;
      }
    }
    return lit;
  };
  // Plate still holding: the compartment is a sealed room being hammered, and
  // that is where fires start.
  const sustained = salvo(12, 0.05);
  ok('sustained shellfire on a compartment that is still closed starts fires',
    sustained > 15, `${sustained} of 60 sustained salvos lit one`);
  const glancing = salvo(2, 0.02);
  ok('...and a couple of light hits usually does not', glancing < 18,
    `${glancing} of 60 light pairs lit one`);
  // And the plate failing is its own answer to the fire — but on the
  // compartment's own draining clock, not instantly. Straight after the salvo
  // the bay is holed AND alight, because there is still air in it; that overlap
  // is the window the flame is visible from outside. Once it has emptied, the
  // fire is out and cannot be restarted.
  salvo(30, 0.05);
  ok('a compartment shot open can still be alight the moment it opens',
    sec.breached, 'never breached');
  run(sys, 120);
  ok('...and the fire is out once it has emptied',
    sec.fire === 0 && sec.atmo < 0.14,
    `fire ${sec.fire.toFixed(1)}, atmo ${sec.atmo.toFixed(3)}`);
  sec.spill = 1;
  ok('...and will not catch again once it has emptied',
    !sys.ignite('fwdbattery', 60));
}
{
  // The other side of that: a bay holed a heartbeat ago still has its air, and
  // has to be able to catch. The round that spills something flammable is
  // usually the same round that opens the compartment, so refusing to ignite on
  // `breached` alone removes fire from the game almost entirely — measured, a
  // cruiser under three hulls for forty-five seconds never had more than two
  // compartments alight and none at any ten-second sample.
  const sys = fresh();
  run(sys, 0.5);
  const sec = sys.section('spine');
  sec.spill = 0.5;
  sys.punchHole('spine', 0.55);
  ok('a compartment holed a moment ago still catches',
    sec.breached && sec.atmo > 0.9 && sys.ignite('spine', 30));
}

// --- losing the helm is survivable -------------------------------------------
// The computer used to latch off PERMANENTLY and ship-wide when it cooked, and
// that was two faults wearing one coat. There was no recovery of any kind: the
// module sat at full health and ambient temperature with the flag still set, so
// "repair the computer" was advice that could not be followed and later waves
// were unflyable. And a ship-wide flag meant cooking the bridge machine also
// disabled a healthy auxiliary, which is the opposite of why one is fitted.
{
  const computers = (sys) => [...sys.modules.values()].filter((m) => m.kind === 'computer');

  // Cooked, on a hull with only one.
  {
    const sys = new Systems(HULLS.sabre);
    const crew = new Crew(HULLS.sabre, sys);
    run(sys, 1, crew);
    ok('the helm starts up', sys.flightComputer);
    const c = computers(sys)[0];
    c.temp = 400;
    run(sys, 2, crew);
    ok('cooking the computer takes the helm', !sys.flightComputer);
    ok('...and leaves real damage for the crew to find', c.hp < c.maxHp * 0.2,
      `hp ${(100 * c.hp / c.maxHp).toFixed(0)}%`);
    run(sys, 60, crew);
    ok('...which damage control can actually put right', sys.flightComputer,
      `hp ${(100 * c.hp / c.maxHp).toFixed(0)}%, temp ${c.temp.toFixed(0)}, `
      + `latched ${c.latched}`);
  }

  // Shot to pieces rather than cooked — the same must hold.
  {
    const sys = new Systems(HULLS.sabre);
    const crew = new Crew(HULLS.sabre, sys);
    run(sys, 1, crew);
    const c = computers(sys)[0];
    sys.damageModule(c.id, c.maxHp * 3, null, null);
    ok('a destroyed computer takes the helm', c.destroyed && !sys.flightComputer);
    run(sys, 90, crew);
    ok('...and the crew rebuild it', !c.destroyed && sys.flightComputer);
  }

  // And the whole point of a second one.
  {
    const sys = new Systems(HULLS.meridian);
    const crew = new Crew(HULLS.meridian, sys);
    run(sys, 1, crew);
    const cs = computers(sys);
    ok('a cruiser carries an auxiliary computer', cs.length > 1);
    cs[0].temp = 400;
    run(sys, 2, crew);
    ok('cooking one leaves the helm on the other', sys.flightComputer,
      'a ship-wide latch would have taken both');
    for (const c of cs) {
      c.temp = 400;
    }
    run(sys, 2, crew);
    ok('...and cooking every one of them does take the helm', !sys.flightComputer);
    run(sys, 90, crew);
    ok('...still recoverable', sys.flightComputer);
  }
}

// --- a wave can be retried ---------------------------------------------------
// Losing at wave six used to cost the five waves it took to get there and a page
// reload. Retry restores the ship as it was when the wave began, which is only
// worth anything if the restore is EXACT — a snapshot that silently drops a
// field is a retry that quietly heals you, and the more fields it drops the
// easier the game gets in a way nobody would think to look for.
//
// So this compares a full structural dump rather than a list of fields anybody
// has to remember to update. Add a field to a compartment, a module, a loop, a
// facet or a party and it is covered the moment it exists.
{
  // References that are shared authored tables rather than state. Everything
  // else on a state object has to survive a round trip.
  const SHARED = new Set(['def', 'div']);
  const values = (o) => {
    const out = {};
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (SHARED.has(k)) {
        continue;
      }
      if (v === null || typeof v !== 'object') {
        out[k] = v;
      } else {
        out[k] = JSON.stringify(v);   // arrays, and the one `task` object
      }
    }
    return out;
  };
  const stateObjects = (sys, crew) => [
    ...sys.sections.values(), ...sys.modules.values(), ...sys.loops.values(),
    ...Object.values(sys.shield.facets), ...crew.parties,
  ];
  const dump = (sys, crew) => JSON.stringify({
    objects: stateObjects(sys, crew).map(values),
    shield: { base: sys.shield.base, up: sys.shield.up },
    power: { capStore: sys.capStore, capMax: sys.capMax, brownout: sys.brownout,
      busQuality: sys.busQuality, integrity: sys.integrity },
  });

  const sys = fresh();
  const crew = new Crew(HULLS.meridian, sys);
  run(sys, 2, crew);

  // Rough it up: plate off, compartments open, a fire, a spill, spent rounds,
  // drained fuel, a wrecked module, casualties, a flat capacitor.
  sys.damageSection('fwdbattery', sys.section('fwdbattery').plateMax * 0.8, null, null);
  sys.punchHole('bowarray', 3.2);
  sys.section('spine').spill = 0.6;
  sys.ignite('spine', 20);
  sys.damageModule('rad_L', 9e6, null, null);
  sys.get('mag_main').rounds *= 0.4;
  for (const m of sys.modules.values()) {
    if (m.kind === 'fuel') {
      m.store = 37;
    }
  }
  sys.capStore *= 0.3;
  sys.damageShield('fore', 4e7, 1e-3);
  crew.killIn('engineering', 2);
  run(sys, 5, crew);

  const before = dump(sys, crew);
  const snap = { sys: sys.snapshot(), crew: crew.snapshot() };

  // Carry on being shot, so a restore that does nothing cannot pass.
  sys.damageSection('drivebay', sys.section('drivebay').plateMax * 0.9, null, null);
  sys.punchHole('coredeck', 6);
  crew.killIn('spine', 3);
  run(sys, 20, crew);
  ok('the ship really did change after the snapshot', dump(sys, crew) !== before);

  sys.restore(snap.sys);
  crew.restore(snap.crew);
  ok('a restored ship is exactly the ship that was snapshotted',
    dump(sys, crew) === before,
    'state differs — a field is missing from captureState or the state objects nested');

  // Restoring twice must give the same answer: nothing may share mutable
  // structure with the snapshot.
  run(sys, 10, crew);
  sys.restore(snap.sys);
  crew.restore(snap.crew);
  ok('...and can be restored more than once', dump(sys, crew) === before);

  // And it has to be a live ship afterwards, not a frozen dump — the networks
  // and the census are derived, so they must come back on their own.
  run(sys, 3, crew);
  ok('a restored ship keeps running', sys.online.power.size > 0 && crew.headcount > 0,
    `nodes ${sys.online.power.size}, hands ${crew.headcount}`);

  // The documented limitation of the generic capture, made into a tripwire.
  // `captureState` takes primitives and primitive arrays and leaves object
  // references alone, because object references are the shared authored tables.
  // A NEW nested object on a state object would therefore be dropped silently.
  // There is exactly one today — a party's `task` — and Crew handles it by
  // hand. A second one has to be a decision somebody makes on purpose.
  const nested = [];
  for (const o of stateObjects(sys, crew)) {
    for (const k of Object.keys(o)) {
      if (SHARED.has(k) || k === 'task') {
        continue;
      }
      const v = o[k];
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        nested.push(`${o.id || o.role}.${k}`);
      }
    }
  }
  ok('no state object has grown a nested object the capture cannot see',
    nested.length === 0,
    `${nested.join(', ')} — handle it in snapshot/restore like Crew does 'task'`);
}
{
  // The wave-start snapshot is the ship you brought to the wave, so a retry
  // must not hand back a pristine one.
  const sys = fresh();
  run(sys, 1);
  sys.damageSection('spine', sys.section('spine').plateMax * 0.7, null, null);
  const snap = sys.snapshot();
  const hurt = sys.section('spine').plateHp;
  run(sys, 1);
  sys.restore(snap);
  ok('a retry gives back a damaged ship, not a new one',
    sys.section('spine').plateHp === hurt && hurt < sys.section('spine').plateMax);
}

// --- report -----------------------------------------------------------------
if (failures.length === 0) {
  console.log(`selfcheck: ${passed} assertions passed (seed ${SELF_CHECK_SEED})`);
} else {
  console.error(`selfcheck: ${passed} passed, ${failures.length} FAILED (seed ${SELF_CHECK_SEED})\n`);
  for (const f of failures) {
    console.error(`  x ${f}`);
  }
  process.exitCode = 1;
}
