// -----------------------------------------------------------------------------
// main.js — bootstrap and the Game facade every subsystem talks to.
//
// Loop shape: a fixed 60 Hz simulation accumulator (stable control gains,
// correct projectile segments, deterministic thermal integration) with the
// camera and HUD decoupled at display rate.
//
// The ECS owns two things: the ordered system schedule for one simulation step,
// and the lifetime of scene-scope entities. Ship interiors stay in plain
// objects — they are dense graphs walked every tick and would gain nothing from
// archetype iteration. Cross-system messaging funnels through the small
// callback surface near the bottom of this file, so no subsystem ever reaches
// into another.
//
// There is no physics library. Ships are rigid bodies integrated in flight.js
// and every ray test is analytic against the hull tables, so the whole
// simulation is code you can read.
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { ECS } from './core/ecs.js';
import { Input } from './core/input.js';
import { Trace } from './core/trace.js';
import { AudioEngine } from './core/audio.js';
import { Assets } from './world/assets.js';
import { Space, CAMERA_NEAR, CAMERA_FAR } from './world/space.js';
import { FX } from './fx/fx.js';
import { HULLS, HULL_IDS, ENGAGEMENT_RANGE } from './ship/hulls.js';
import { Ship } from './ship/ship.js';
import { Pilot } from './ship/ai.js';
import { resolveCollision } from './ship/flight.js';
import { Ballistics } from './weapons/ballistics.js';
import { AMMO, AMMO_IDS } from './weapons/defs.js';
import { PlayerPilot } from './player/pilot.js';
import { HUD } from './ui/hud.js';
import { Targeting } from './ui/targeting.js';
import { Diagnostics } from './ui/diagnostics.js';
import { clamp01, rand, randInt, pick, randomDirection } from './core/mathx.js';

/**
 * Real-time cadence of the simulation. The world is stepped this often per
 * wall-clock second regardless of time scale — dilation shrinks the step, it
 * does not thin the steps out. Scaling the accumulator instead (the obvious
 * approach) means 0.15x runs the world at 9 Hz and everything except the camera
 * turns into a slideshow.
 */
const STEP_INTERVAL = 1 / 60;
const FIXED_DT = 1 / 60;
const MIN_SIM_DT = 1 / 2000;
const MAX_STEPS = 5;
const TIME_SCALES = [1, 0.35, 0.12];

const CALLSIGNS = [
  'VESPER', 'KESTREL', 'ANVIL', 'MERIDIAN', 'CINDER', 'HALCYON', 'OBOL', 'TALLOW',
  'GRIST', 'LANTERN', 'PEREGRINE', 'SABLE', 'QUARRY', 'MARROW', 'BRACKEN',
];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

class Game {
  constructor() {
    this.canvas = document.getElementById('view');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    // Near plane sized for capital ranges. Depth resolution goes as
    // z^2 / (near * 2^24), so the old 0.4 m near gave ~9 m of precision at
    // five kilometres — enough to make a cruiser's compartment boxes z-fight
    // into noise at exactly the distance the fight now happens.
    // The planes live in space.js: the backdrop shells are what constrain them,
    // and split across two files they drifted out of agreement.
    this.camera = new THREE.PerspectiveCamera(
      68, window.innerWidth / window.innerHeight, CAMERA_NEAR, CAMERA_FAR,
    );
    this.ecs = new ECS();
    this.audio = new AudioEngine();
    this.input = new Input(this.canvas);
    this.hulls = HULLS;

    this.ships = [];
    this.pilots = new Map();
    this.player = null;
    this.wave = 0;
    this.waveTimer = 3;
    this.kills = 0;
    this.paused = false;
    this.started = false;
    this.over = false;
    this.accumulator = 0;
    this.timeScale = 1;
    this.timeIndex = 0;
    this.frameTimes = [];
  }

  init() {
    this.assets = new Assets(this.renderer);
    this.fx = new FX(this);
    this.space = new Space(this);
    /** Flight recorder. Off until `game.trace.start()`; see core/trace.js. */
    this.trace = new Trace(this);
    this.ballistics = new Ballistics(this);
    this.hud = new HUD(this);
    this.targeting = new Targeting(this);
    // Two identical panels: your ship on the left, the locked target on the
    // right. Same renderer, same detail, same truth.
    this.diagnostics = new Diagnostics(this, 'diag');
    this.targetPanel = new Diagnostics(this, 'tdiag');

    this._spawnPlayer('meridian');
    this._registerSystems();

    this.ecs.onDestroy((id, comps) => {
      const c = comps.get('ship');
      if (c && c.ship) {
        const i = this.ships.indexOf(c.ship);
        if (i >= 0) {
          this.ships.splice(i, 1);
        }
        this.pilots.delete(c.ship);
        if (this.targeting.target === c.ship) {
          this.targeting.setTarget(null);
        }
        if (this.diagnostics.ship === c.ship) {
          this.diagnostics.setShip(this.player ? this.player.ship : null);
        }
        if (this.targetPanel.ship === c.ship) {
          this.targetPanel.setShip(null);
        }
        c.ship.dispose();
      }
    });

    window.addEventListener('resize', () => this._onResize());
    // Listen on the window, not the canvas. The splash and pause cards are
    // full-screen overlays stacked above the canvas, so a canvas-level handler
    // never sees the click that is supposed to dismiss them — which made the
    // game literally unstartable. Pointer lock is still requested on the canvas;
    // only the listener moves.
    window.addEventListener('click', () => {
      if (this.over) {
        return;
      }
      this.audio.resume();
      this.input.requestLock();
      if (!this.started) {
        this.started = true;
        document.getElementById('splash').classList.add('hidden');
      }
    });
    this.input.onLockChange = (locked) => {
      if (!locked && this.started && !this.over) {
        this.paused = true;
        document.getElementById('pause').classList.remove('hidden');
      } else if (locked) {
        this.paused = false;
        document.getElementById('pause').classList.add('hidden');
      }
    };

    this._onResize();
    // Everything the game will ever draw, compiled and uploaded before the
    // first real frame rather than the first time each thing is needed.
    this.assets.warmUp(this.scene, this.camera, this.hulls);
    this.last = performance.now();
    requestAnimationFrame(() => this._frame());
  }

  // -- setup -----------------------------------------------------------------

  _spawnPlayer(hullId) {
    const ship = this._addShip(hullId, {
      faction: 'player',
      isPlayer: true,
      name: 'MERIDIAN ACTUAL',
      position: new THREE.Vector3(0, 0, 0),
      tint: 0xc8d4dc,
    });
    this.player = new PlayerPilot(this, ship);
    this.diagnostics.setShip(ship);
    return ship;
  }

  _addShip(hullId, opts) {
    const ship = new Ship(this, hullId, opts);
    this.ships.push(ship);
    const id = this.ecs.create('ship');
    this.ecs.add(id, 'ship', { ship });
    ship.entity = id;
    if (!opts.isPlayer) {
      this.pilots.set(ship, new Pilot(ship, this));
    }
    return ship;
  }

  /**
   * A wave of hostiles, dropped in a loose shell around the player.
   *
   * The ramp is deliberately slower than it was. Measured against the old
   * table, an AI-flown MERIDIAN lost wave two — a picket and a frigate —
   * four times out of four, and wave one killed it once in four. Some of that
   * was the player's guns not working, but the shape was wrong regardless:
   * two hulls by wave 2 and a dreadnought by wave 5 gives nobody time to learn
   * what a coolant loop is for. Heavies now arrive as a single named problem
   * before they arrive as a group.
   */
  _spawnWave() {
    this.wave++;
    const w = this.wave;
    const n = Math.min(4, 1 + Math.floor((w - 1) / 3));
    const pool = w <= 2 ? ['sabre']
      : (w <= 4 ? ['sabre', 'sabre', 'halberd']
        : (w <= 6 ? ['sabre', 'halberd', 'halberd']
          : (w <= 8 ? ['halberd', 'halberd', 'meridian']
            : (w <= 10 ? ['halberd', 'meridian', 'meridian']
              : ['halberd', 'meridian', 'meridian', 'bastion']))));
    for (let i = 0; i < n; i++) {
      const hullId = pick(pool);
      randomDirection(_v);
      _v.multiplyScalar(rand(ENGAGEMENT_RANGE * 1.5, ENGAGEMENT_RANGE * 2.8));
      _v.add(this.player.ship.position);
      _q.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        _v2.copy(this.player.ship.position).sub(_v).normalize(),
      );
      this._addShip(hullId, {
        faction: 'hostile',
        name: `${pick(CALLSIGNS)}-${randInt(10, 99)}`,
        position: _v.clone(),
        quaternion: _q.clone(),
        velocity: _v2.clone().multiplyScalar(rand(20, 50)),
      });
    }
    this.hud.warn(`WAVE ${this.wave} — ${n} CONTACT${n > 1 ? 'S' : ''}`);
  }

  // -- system schedule -------------------------------------------------------

  _registerSystems() {
    const ecs = this.ecs;

    ecs.addSystem('intent', ({ dt }) => {
      if (this.player && !this.player.ship.disposed) {
        this.player.update(dt);
      }
    }, 10);

    ecs.addSystem('brains', ({ dt }) => {
      for (const [ship, pilot] of this.pilots) {
        if (!ship.disposed && !ship.dead) {
          pilot.update(dt);
        }
      }
      if (this.player && !this.player.ship.disposed) {
        const p = this.player.ship;
        // Lay on the selected subsystem if there is one. The targeting computer
        // has been able to pick a module since it was written, but the point
        // only ever reached the HUD pip — the guns went on shooting centre mass,
        // so choosing a target's reactor drew a marker and changed nothing.
        p.updateWeapons(dt, this.targeting.target, this.player._fire,
          this.targeting.subsystemPoint(_v));
      }
    }, 20);

    ecs.addSystem('ships', ({ dt }) => {
      for (const s of this.ships) {
        s.update(dt);
      }
    }, 30);

    ecs.addSystem('collide', () => {
      // Ships are few; the pair loop is honest and never the bottleneck.
      for (let i = 0; i < this.ships.length; i++) {
        for (let j = i + 1; j < this.ships.length; j++) {
          const a = this.ships[i];
          const b = this.ships[j];
          const hit = resolveCollision(a.body, b.body);
          if (!hit) {
            continue;
          }
          // A collision is a hit on whichever compartment met the other ship.
          const joules = hit.energy * 0.5;
          this._collisionDamage(a, b.position, joules);
          this._collisionDamage(b, a.position, joules);
          // resolveCollision works on the bodies directly, so the jolt the
          // camera reads has to be recorded here. Two hulls meeting is the
          // largest impulse either will ever take and the one event that has
          // every right to throw the view around.
          a.jolt += hit.impulse * a.body.invMass;
          b.jolt += hit.impulse * b.body.invMass;
          _v.copy(a.position).lerp(b.position, 0.5);
          this.fx.sparkBurst(_v, hit.normal, 30, 0xffd9a0);
          this.audio.impact('metal', _v, 1);
        }
      }
    }, 40);

    ecs.addSystem('ballistics', ({ dt }) => {
      this.ballistics.update(dt);
    }, 50);

    ecs.addSystem('fx', ({ dt }) => {
      this.fx.update(dt);
    }, 60);

    ecs.addSystem('targeting', ({ dt }) => {
      this.targeting.update(dt);
      this.hud.update(dt);
    }, 70);

    ecs.addSystem('director', ({ dt }) => {
      this._director(dt);
    }, 80);

    // Last in the step, so a sample is the settled state of the tick rather
    // than a half-updated one. Costs nothing until `game.trace.start()`.
    ecs.addSystem('trace', ({ dt }) => {
      this.trace.tick(dt);
    }, 90);
  }

  /** Which compartment of `ship` is closest to a world point. */
  _nearestSection(ship, worldPos) {
    let best = null;
    let bestD = Infinity;
    for (const s of ship.hull.sections) {
      ship.sectionWorld(s.id, _v2);
      const d = _v2.distanceToSquared(worldPos);
      if (d < bestD) {
        bestD = d;
        best = s.id;
      }
    }
    return best;
  }

  _collisionDamage(ship, otherPos, joules) {
    const best = this._nearestSection(ship, otherPos);
    if (best) {
      ship.sys.damageSection(best, joules, null, null);
    }
  }

  /**
   * Mission-kill bookkeeping. Latched rather than polled, because a damage
   * control party can get a drive back and un-derelict a hull — that recovery
   * should read as the enemy coming back, not as the kill being taken away.
   */
  _updateDerelict(ship, dt) {
    // Debounced. Load shedding drops the drives to zero authority for a second
    // at a time during a brownout — measured on a healthy BASTION twenty
    // seconds into a fight — so an instantaneous test would condemn ships for a
    // transient the crew fixes by itself. Being adrift has to stick.
    ship.adriftT = ship.sys.isDerelict() ? (ship.adriftT || 0) + dt : 0;
    const adrift = ship.adriftT > 3;
    if (adrift && !ship.derelict) {
      ship.derelict = true;
      ship.derelictT = 0;
      if (ship.faction === 'hostile' && !ship.scored) {
        ship.scored = true;
        this.kills++;
        this.hud.warn(`${ship.name} MISSION KILLED — ADRIFT`);
      } else if (ship.isPlayer) {
        this.hud.warn('DRIVES AND FLIGHT COMPUTER LOST — ADRIFT');
      }
    } else if (!adrift && ship.derelict) {
      ship.derelict = false;
      if (ship.isPlayer) {
        this.hud.warn('HELM RESTORED');
      }
    }
    if (!ship.derelict) {
      return;
    }
    ship.derelictT += dt;
    // The player is never scuttled out from under themselves — they get to
    // fight the hulk back to life, or die in it properly.
    if (!ship.isPlayer && ship.derelictT > 45) {
      this.onShipDestroyed(ship, 'abandoned');
    }
  }

  _director(dt) {
    // Retire wrecks, then decide whether it is time for more company.
    let hostiles = 0;
    for (const s of this.ships) {
      if (s.disposed) {
        continue;
      }
      if (!s.dead && s.sys.isStricken()) {
        this.onShipDestroyed(s, 'systems');
      }
      // A ship that has lost its drives and its computer is mission-killed, not
      // destroyed: it is a hulk, adrift, with whatever guns still bear. It
      // scores immediately so the wave can move on and the player is not made
      // to chase a drifting corpse, but it stays in the world to be finished —
      // or to keep shooting at them if they leave it. The abandon timer is the
      // crew giving up on a ship they cannot fly.
      if (!s.dead) {
        this._updateDerelict(s, dt);
      }
      if (s.dead) {
        s.deadT += dt;
        // A dying hull tumbles, burns and comes apart — it does not blink out.
        if (Math.random() < 7 * dt) {
          s.sectionWorld(pick(s.hull.sectionIds), _v);
          this.fx.explosion(_v, rand(12, 34), 0xff9a50);
        }
        if (s.deadT > 6.5) {
          this.fx.explosion(s.position, s.hull.radius * 1.4, 0xffd090);
          this.fx.debris(s.position, s.body.vel, 140, s.hull.tint);
          this.audio.boom(s.position, 1.5);
          this.ecs.destroy(s.entity);
        }
      } else if (s.faction === 'hostile' && !s.derelict) {
        hostiles++;
      }
    }

    if (this.player && this.player.ship.dead && !this.over) {
      this.over = true;
      document.getElementById('gameoverStats').textContent =
        `WAVE ${this.wave}  ·  ${this.kills} KILLS`;
      document.getElementById('gameover').classList.remove('hidden');
      this.input.exitLock();
    }

    if (hostiles === 0 && !this.over) {
      this.waveTimer -= dt;
      if (this.waveTimer <= 0) {
        // Long enough for the damage-control parties to actually achieve
        // something. Repair is the most interesting system in the ship and at
        // twenty-two seconds the player never got to watch it work — they went
        // into every wave carrying all the damage from the last one, which is
        // most of why the difficulty curve felt like a cliff.
        this.waveTimer = 45;
        // A tender came alongside during the lull. Repair gives back health;
        // this gives back the things that are spent rather than broken, without
        // which a run only ever decays — see `Ship.resupply`.
        if (this.player && !this.player.ship.disposed) {
          const hands = this.player.ship.resupply();
          this.hud.warn(hands > 0 ? `RESUPPLIED — ${hands} HANDS ABOARD` : 'RESUPPLIED');
        }
        this._spawnWave();
      }
    }
  }

  // -- cross-system callbacks ------------------------------------------------

  /**
   * A detonation in vacuum. There is no atmosphere, so there is no blast wave
   * and no overpressure — a warhead couples to a hull by exactly two things:
   * radiated energy, which falls off as the inverse square of distance, and
   * fragments, which are just very cheap projectiles and go through the normal
   * penetration solver.
   *
   * The energy a ship intercepts is the fraction of the sphere it subtends. For
   * a disc of radius `r` at distance `d` that is exactly
   * `0.5 * (1 - d/sqrt(d^2 + r^2))`, which decays to the familiar `r^2/(4d^2)`
   * in the far field and rises to one half at contact — where the hull fills a
   * hemisphere. The old form used the far-field approximation everywhere with
   * an arbitrary `d >= r/2` floor, which capped a contact hit at a quarter of
   * the warhead and then measured `d` to the ship's CENTRE OF MASS, so a
   * torpedo bursting on a cruiser's bow was scored as a detonation 134 metres
   * away and delivered a fifth of its charge. Measuring to the compartment
   * actually struck is what makes contact ordnance behave like contact
   * ordnance; the far field is unchanged to three decimal places.
   *
   * `radius` is only a culling distance and an effect size; it does no work.
   */
  explode(pos, opts) {
    const radius = opts.radius;
    const energy = opts.energy;
    this.fx.explosion(pos, radius, opts.incendiary ? 0xffa050 : 0xffc070);
    this.audio.boom(pos, clamp01(radius / 24));
    for (const s of this.ships) {
      if (s.disposed) {
        continue;
      }
      const centreD = s.position.distanceTo(pos);
      if (centreD > radius * 3 + s.hitRadius) {
        continue;
      }
      // Range to the COMPARTMENT the flash is nearest, not to the ship's
      // middle. On a 250 m hull those differ by more than a hundred metres,
      // which is the whole difference between a contact hit and a near miss.
      const host = this._nearestSection(s, pos);
      const d = host ? s.sectionWorld(host, _v).distanceTo(pos) : centreD;
      const r = s.hitRadius;
      const joules = energy * 0.5 * (1 - d / Math.hypot(d, r));
      if (joules < 1e3) {
        continue;
      }
      // A charge that functioned INSIDE this hull is inside its shield too, so
      // the bubble gets no say. That is the entire argument for delay fuses.
      const inside = opts.internal && centreD < s.hitRadius;
      let through = joules;
      if (!inside) {
        // Otherwise the field catches it on whichever facet is turned toward
        // the flash. A radiated pulse arrives over roughly the light-and-plasma
        // expansion time, which is long compared to a slug transit — so shields
        // are markedly better against warheads than against solid shot.
        _v.copy(pos).sub(s.position).normalize();
        const facet = s.faceFor(_v);
        through = s.sys.damageShield(facet, joules, 1.5e-3);
        s.shieldImpact(pos, clamp01(joules / 4e5));
      }
      if (through > 1e3) {
        if (inside) {
          // An internal detonation wrecks the compartment it went off in and
          // everything bolted inside it, rather than scuffing the outer plate.
          if (host) {
            s.sys.damageSection(host, through * 0.7, pos, null);
            s.sys.punchHole(host, 7.0);
            for (const m of s.sys.modules.values()) {
              if (m.section === host && !m.destroyed) {
                s.sys.damageModule(m.id, through * 0.32, pos, null);
              }
            }
            s.crew.killIn(host, 1.4);
            s.sys.section(host).spill = clamp01(s.sys.section(host).spill + 0.6);
            s.sys.ignite(host, 8);
          }
        } else {
          this._collisionDamage(s, pos, through * 0.6);
        }
        _v2.copy(s.position).sub(pos).normalize();
        s.applyImpulseAt(s.position, _v2, joules * 2e-4);
        if (opts.incendiary) {
          // A blast that opens a compartment can light what spills out of it.
          for (const sec of s.sys.sections.values()) {
            if (sec.breached && sec.spill > 0.1) {
              s.sys.ignite(sec.id, 7);
            }
          }
        }
      }
    }
    if (opts.shrapnel) {
      this.ballistics.castShrapnel(pos, opts.shrapnel, opts.shrapnelEnergy, opts.owner);
    }
  }

  onHit(attacker, victim, internal) {
    if (attacker === (this.player && this.player.ship)) {
      this.hud.hitMark = internal ? 2 : 1;
    }
    // Taking a hit deliberately does NOT shake the camera from here. It used to
    // add a flat 0.15, or 0.35 for a penetration, per hit — mass-independent,
    // so a dreadnought and a picket lurched identically and a few rounds a
    // second pinned the camera at maximum. Shake is the impulse the hull
    // actually took and nothing else; see SHAKE_PER_DV in pilot.js.
  }

  onModuleKill(ship, module, attacker) {
    if (attacker === (this.player && this.player.ship)) {
      this.hud.warn(`${ship.name}: ${module.label} DESTROYED`);
    }
  }

  onShipDestroyed(ship, cause) {
    if (ship.dead) {
      return;
    }
    ship.dead = true;
    ship.deadT = 0;
    // The lights go out and the hull goes ballistic. Whatever it was doing when
    // it died, it keeps doing forever.
    ship.autopilot.cmd.throttle = 0;
    ship.autopilot.cmd.assist = false;
    ship.body.omega.multiplyScalar(1);
    randomDirection(_v);
    ship.body.omega.addScaledVector(_v, rand(0.15, 0.6));
    if (ship.faction === 'hostile') {
      // A hulk already scored when it went adrift; finishing it must not pay
      // twice.
      if (!ship.scored) {
        ship.scored = true;
        this.kills++;
      }
      this.hud.warn(`${ship.name} DESTROYED (${cause.toUpperCase()})`);
    }
    if (this.pilots.has(ship)) {
      this.pilots.delete(ship);
    }
  }

  // -- loop ------------------------------------------------------------------

  _hotkeys() {
    const input = this.input;
    // Ammunition select. Every magazine-fed mount aboard loads the same nature
    // of round, so this is one decision rather than a per-gun chore.
    for (let i = 0; i < AMMO_IDS.length; i++) {
      if (input.pressed(`Digit${i + 1}`)) {
        const ship = this.player.ship;
        if (!ship.usesAmmo) {
          this.hud.nudge('NO MAGAZINE-FED MOUNTS', 1.2);
          break;
        }
        ship.ammo = AMMO_IDS[i];
        this.hud.nudge(`LOADED ${AMMO[ship.ammo].name} — ${AMMO[ship.ammo].role}`, 2.2);
        this.audio.ui();
        break;
      }
    }
    if (input.pressed('KeyT')) {
      this.targeting.lockAhead();
    }
    if (input.pressed('KeyY')) {
      this.targeting.cycle();
    }
    if (input.pressed('BracketLeft')) {
      this.targeting.cycleSubsystem(-1);
    }
    if (input.pressed('BracketRight')) {
      this.targeting.cycleSubsystem(1);
    }
    if (input.pressed('KeyU')) {
      this.targeting.targetWeakest();
    }
    if (input.pressed('KeyH')) {
      const on = this.diagnostics.toggle();
      this.targetPanel.visible = on;
    }
    // The module tree is taller than the panel on any normal display — 45 rows
    // against room for about 15 — and nothing else can scroll it: #ui is
    // pointer-events:none and pointer lock swallows the wheel. So it needs keys.
    if (input.pressed('Comma') || input.pressed('Period')) {
      this.diagnostics.scrollTree(input.pressed('Period') ? 1 : -1);
    }
    if (input.pressed('Semicolon') || input.pressed('Quote')) {
      this.targetPanel.scrollTree(input.pressed('Quote') ? 1 : -1);
    }
    if (input.pressed('KeyJ')) {
      // Swap the two panels over, for when the interesting ship is the enemy.
      const a = this.diagnostics.ship;
      this.diagnostics.setShip(this.targetPanel.ship || this.player.ship);
      this.targetPanel.setShip(a === this.player.ship ? this.targeting.target : a);
      this.audio.ui();
    }
    if (input.pressed('KeyV')) {
      this.player.toggleView();
    }
    if (input.pressed('KeyB')) {
      // Emergency vent: smothers the worst fire aboard, and kills anyone who
      // has not got out of that compartment.
      const sys = this.player.ship.sys;
      let worst = null;
      for (const s of sys.sections.values()) {
        if (s.fire > 0 && (!worst || s.fire > worst.fire)) {
          worst = s;
        }
      }
      if (worst) {
        sys.ventSection(worst.id);
        this.hud.warn(`VENTING ${this.player.ship.hull.sectionById[worst.id].label}`);
      } else {
        this.hud.nudge('NO FIRE TO VENT', 1.2);
      }
    }
    if (input.pressed('KeyN')) {
      this.timeIndex = (this.timeIndex + 1) % TIME_SCALES.length;
      this.timeScale = TIME_SCALES[this.timeIndex];
      this.hud.nudge(`TIME ${this.timeScale}x`, 1.4);
    }
    if (input.pressed('KeyM')) {
      this.hud.nudge(this.audio.toggleMute() ? 'AUDIO MUTED' : 'AUDIO ON', 1.2);
    }
    if (input.pressed('KeyG')) {
      randomDirection(_v);
      _v.multiplyScalar(ENGAGEMENT_RANGE).add(this.player.ship.position);
      this._addShip(pick(HULL_IDS), {
        faction: 'hostile',
        name: `${pick(CALLSIGNS)}-${randInt(10, 99)}`,
        position: _v.clone(),
      });
      this.hud.nudge('TEST CONTACT DEPLOYED', 1.4);
    }
    if (input.pressed('Escape')) {
      this.input.exitLock();
    }
  }

  _frame() {
    requestAnimationFrame(() => this._frame());
    const now = performance.now();
    let wall = (now - this.last) / 1000;
    this.last = now;
    if (wall > 0.25) {
      wall = 0.25;
    }

    if (this.started && !this.paused && !this.over) {
      // Everything the browser delivers per frame — mouse deltas, the wheel,
      // key edges — is consumed here, ONCE, before the accumulator. The sim
      // steps a variable number of times per frame, so per-step code must only
      // ever read continuous state.
      this._hotkeys();
      if (this.player && !this.player.ship.disposed) {
        this.player.readInput();
      }
      this.accumulator += wall;
      let steps = 0;
      const dt = Math.max(FIXED_DT * this.timeScale, MIN_SIM_DT);
      while (this.accumulator >= STEP_INTERVAL && steps < MAX_STEPS) {
        this.accumulator -= STEP_INTERVAL;
        steps++;
        this.ecs.run({ dt, game: this });
      }
      if (steps === MAX_STEPS) {
        this.accumulator = 0;
      }
    }
    // Frame-scoped input is cleared every frame, INCLUDING frames where the
    // simulation did not run. Left inside the guard above, key edges and wheel
    // notches accumulated unbounded on the splash and while paused, then all
    // fired at once on the first playing frame — so an Escape pressed at the
    // pause card re-paused the game the instant you clicked to resume.
    this.input.endFrame();

    if (this.player) {
      this.player.updateCamera(wall);
      _v.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
      this.audio.setListener(this.camera.position, _v);
    }
    this.space.update(this.camera.position);
    this.hud.render();
    this.targeting.render();
    this.diagnostics.render();
    // The right-hand panel always follows the lock, so a new target opens its
    // interior without the player having to ask.
    if (this.targetPanel.ship !== this.targeting.target
        && this.diagnostics.ship !== this.targeting.target) {
      this.targetPanel.setShip(this.targeting.target);
    }
    this.targetPanel.render();
    this.renderer.render(this.scene, this.camera);
    // Target view, second pass, scissored into its frame on the same canvas.
    // After the main render so it paints over it rather than under it.
    this.hud.renderTargetView(this.renderer, this.scene);
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.hud.resize();
  }
}

const game = new Game();
game.init();
window.game = game;
