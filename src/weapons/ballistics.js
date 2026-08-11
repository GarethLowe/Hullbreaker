// -----------------------------------------------------------------------------
// ballistics.js — projectile integration and the layered penetration solver.
//
// Shots are real objects: mass, muzzle velocity, drag, and the velocity of the
// ship that fired them. There is no gravity out here, so a slug flies straight
// and the only reason to lead a target is that light and tungsten take time.
//
// The solver is an energy budget walk. Each layer along the ray costs joules —
// a wall costs `thickness x resistance / cos(theta)`, a module costs the length
// of the chord through it times its material — and whatever a layer absorbs is
// exactly the damage it takes. "The round stopped in the port magazine" and
// "the port magazine absorbed 1.9 MJ" are the same sentence. When the budget
// reaches zero the shot is spent, inside whatever drained it.
//
// Shields sit at the top of that stack as one more layer, with the twist that
// how much they can catch depends on what hit them.
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { MATERIALS } from '../ship/hulls.js';
import { clamp01, rand, randomDirection, coneDirection } from '../core/mathx.js';

const MAX_TRACERS = 900;
/**
 * How close a round has to pass a warhead to kill it, metres, when the warhead
 * does not say otherwise.
 *
 * This is not the body's size — it is body size plus how much of a near miss
 * the thing does not survive, which is a fact about how it is built. A seeker
 * is a thin-skinned 260 kg vehicle carrying an optical head: anything close
 * ends it. A torpedo is four tonnes with structure around the warhead and
 * wants very nearly a direct hit, which is what `WEAPONS.torpedo.interceptR`
 * says.
 *
 * It was nine for everything, and nine was right when a hull carried two
 * directors at 400 rpm — without the padding they essentially never connected
 * and every warhead launched at you arrived. A hull now carries eight to
 * twelve, so the padding stopped compensating for a weak system and started
 * making an overwhelming one: measured against a full ring, twenty-three
 * seekers and six torpedoes were shot down for zero leakage and the target
 * finished on a hundred per cent plate.
 */
const INTERCEPT_RADIUS = 5;
/** Obliquity floor — a perfectly grazing hit would otherwise cost infinity. */
const MIN_COS = 0.16;
/** Below this cosine (~70 deg off normal) a non-penetrating slug deflects. */
const RICOCHET_COS = 0.40;

/**
 * How wide a mark a strike leaves on the plating, in metres.
 *
 * The hole is small — a solid shot bores about half a square metre — but the
 * burn around it is not. Energy that did not go through went into vaporising
 * plating and depositing it straight back on the hull, so the scorch is metres
 * across where the hole is a hand's width. That halo is the part that is
 * actually visible from gunnery range, which is why the decal is sized off the
 * energy delivered rather than off the calibre.
 */
const markRadius = (joules) => Math.min(14, 1.1 + Math.sqrt(Math.max(joules, 0) * 1e-6) * 0.55);

/**
 * How much of a blast an impact of this size should throw, 0.5 to 6.
 *
 * Sized off the square root of the energy actually delivered, because that is
 * what the radius of a vapour cloud goes as. A 23 kJ repeater round barely
 * flickers; a 40 MJ tungsten penetrator coming out the far side of a cruiser
 * throws a piece of that cruiser with it.
 */
const blastScale = (joules) => Math.min(6,
  Math.max(0.5, Math.sqrt(Math.max(joules, 0) * 1e-6) * 0.42));

/**
 * Navigation constant for the seekers' proportional guidance. Three to five is
 * the textbook band; four turns hard enough to catch a manoeuvring capital ship
 * without wasting so much energy on the correction that it arrives slow.
 */
const NAV_GAIN = 4.0;

/**
 * How far off its own velocity a seeker may tip the motor. At 0.94 the thrust
 * is 70 degrees off the flight path — everything the airframe has, with just
 * enough forward component left to hold speed against drag it does not have.
 */
const MAX_TILT = 0.94;

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
/** Scratch for the penetration trace; `_p` is already the live hit point. */
const _xr = new THREE.Vector3();
/** Guidance scratch. `_o`, `_d` and `_p` are all live across a seeker update. */
const _los = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _omega = new THREE.Vector3();
const _lat = new THREE.Vector3();
const _nose = new THREE.Vector3();
const _want = new THREE.Vector3();

export class Ballistics {
  constructor(game) {
    this.game = game;
    this.bolts = [];
    this.missiles = [];
    this.beams = [];
    this._hits = [];

    const geo = new THREE.BufferGeometry();
    this.tracerPos = new Float32Array(MAX_TRACERS * 6);
    this.tracerCol = new Float32Array(MAX_TRACERS * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(this.tracerPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.tracerCol, 3));
    geo.setDrawRange(0, 0);
    this.tracerGeo = geo;
    this.tracers = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    this.tracers.frustumCulled = false;
    game.scene.add(this.tracers);

    this.missileGeo = new THREE.ConeGeometry(1.4, 8.0, 8);
    this.missileGeo.rotateX(Math.PI / 2);
    this.missileMat = new THREE.MeshBasicMaterial({ color: 0xd8dde2 });
  }

  // -- spawning --------------------------------------------------------------

  /**
   * `ammo` is the loaded nature of round for magazine-fed guns, or null for
   * energy weapons. Its modifiers are folded in here rather than in the solver,
   * so the penetration walk stays a single code path that knows nothing about
   * ammunition types — it just reads the numbers the round arrived with.
   */
  spawnBolt(ship, origin, dir, inherit, weapon, ammo) {
    coneDirection(dir, weapon.spread || 0, _d);
    const vel = _d.clone().multiplyScalar(weapon.muzzleVel).add(inherit);
    this.bolts.push({
      pos: origin.clone(),
      prev: origin.clone(),
      vel,
      energy: weapon.energy,
      mass: weapon.mass,
      drag: weapon.drag || 0,
      weapon,
      owner: ship,
      // Effective terminal properties: weapon x round.
      ap: weapon.ap * (ammo ? ammo.ap : 1),
      // Time this round takes to give up its energy — the only thing that
      // decides how much of it a shield facet can catch.
      dwell: weapon.dwell * (ammo && ammo.dwellMult ? ammo.dwellMult : 1),
      dump: Math.max(weapon.dump || 0, ammo ? ammo.dump : 0),
      burst: ammo ? ammo.burst : 'none',
      fuseWalls: ammo && ammo.fuseWalls ? ammo.fuseWalls : 0,
      splash: (ammo && ammo.splash) || weapon.splash || null,
      holeSize: ammo ? ammo.holeSize : 0.35,
      color: new THREE.Color(ammo ? ammo.tracer : weapon.tracer),
      life: weapon.life || 3,
      width: weapon.width || 0.1,
      trail: !!weapon.trail,
    });
  }

  spawnMissile(ship, origin, dir, inherit, weapon, target) {
    const mesh = new THREE.Mesh(this.missileGeo, this.missileMat);
    const active = weapon.guidance === 'active';
    // A 260 kg seeker is not a four-tonne torpedo, and at gunnery range the
    // silhouette is the only thing that says which one is coming at you.
    mesh.scale.setScalar(active ? 0.55 : 1);
    this.game.scene.add(mesh);
    this.missiles.push({
      pos: origin.clone(),
      prev: origin.clone(),
      vel: dir.clone().multiplyScalar(weapon.muzzleVel).add(inherit),
      weapon,
      owner: ship,
      target,
      // A command-guided torpedo aims at the locked SUBSYSTEM when there is
      // one, which is what makes subsystem targeting worth doing with ordnance
      // rather than guns. An active seeker has its own head and no idea what a
      // subsystem is.
      subsystem: !active && ship.isPlayer ? this.game.targeting.subsystem : null,
      /** Which channel of the head is holding this lock; see `_acquire`. */
      band: null,
      /** Countdown to the next sweep of the seeker head. */
      scanT: 0,
      fuse: weapon.fuse,
      mesh,
      armT: 0.35,
    });
  }

  /**
   * The seeker head: score every contact it can see, take the best.
   *
   * Two channels, and which one wins is a real fact about the target rather
   * than a coin toss. Both fall off as the inverse square of range, because
   * both are measuring flux arriving at a lens.
   *
   *   INFRARED  the contact's own heat — drives at full burn, a reactor under
   *             load, fires aboard, a hull venting a hot coolant loop. Blind to
   *             size: a picket accelerating hard is a brighter target than a
   *             dreadnought coasting cold.
   *
   *   OPTICAL   the solid angle the contact subtends, which is size over range
   *             squared. Cannot be dimmed by shutting anything down, and cannot
   *             tell a wreck from a warship.
   *
   * Returns null when the head has nothing, which is a real outcome — a missile
   * launched into empty sky flies on ballistically until its fuse runs out.
   */
  _acquire(m) {
    const s = m.weapon.seeker;
    if (m.vel.lengthSq() < 1e-6) {
      return null;
    }
    _nose.copy(m.vel).normalize();
    const cosFov = Math.cos(s.fov);
    let best = null;
    let bestScore = 0;
    let bestBand = null;
    for (const ship of this.game.ships) {
      if (ship.disposed || ship === m.owner) {
        continue;
      }
      // It is not so stupid as to turn round on the fleet that launched it.
      if (m.owner && ship.faction === m.owner.faction) {
        continue;
      }
      _rel.copy(ship.position).sub(m.pos);
      const r = _rel.length();
      if (r > s.range || r < 1e-3) {
        continue;
      }
      if (_rel.dot(_nose) / r < cosFov) {
        continue;
      }
      const falloff = 1 / (r * r);
      const ir = s.ir * ship.heatSignature() * falloff;
      const optical = s.optical * ship.hitRadius * ship.hitRadius * falloff * 0.55;
      // A wreck still radiates and still fills the frame, so the head does not
      // ignore one — it simply prefers anything that is still fighting.
      const weight = ship.dead ? 0.2 : 1;
      const score = Math.max(ir, optical) * weight;
      if (score > bestScore) {
        bestScore = score;
        best = ship;
        bestBand = ir >= optical ? 'IR' : 'OPT';
      }
    }
    m.band = best ? bestBand : null;
    return best;
  }

  /**
   * Proportional navigation. Writes the heading the motor should be pushing
   * along into `_want`.
   *
   * The old law was lead pursuit: work out where the target will be, point at
   * that, repeat. It is stable against a stationary target and hopeless against
   * a manoeuvring one, because the aim point moves every frame and the seeker
   * spends its entire turn budget chasing an error it re-creates.
   *
   * PN steers to null the ROTATION of the line of sight instead. If the bearing
   * to the target is not changing, the two are on a collision course whatever
   * either of them is doing — so a seeker on a good intercept flies almost
   * straight, and has its whole turn rate left over for the moment the target
   * breaks. It is what every real missile since the 1950s uses, and it is four
   * lines of vector algebra.
   */
  _guide(m, aimPoint, targetVel) {
    const w = m.weapon;
    _o.copy(aimPoint).sub(m.pos);
    const r = _o.length();
    const speed = m.vel.length();
    if (r < 1e-3 || speed < 1e-3) {
      _want.copy(m.vel).normalize();
      return;
    }
    _los.copy(_o).multiplyScalar(1 / r);
    _rel.copy(targetVel).sub(m.vel);
    // Rotation rate of the sight line, as a vector along the axis it turns
    // about: omega = (r x v) / |r|^2.
    _omega.crossVectors(_o, _rel).multiplyScalar(1 / (r * r));
    const closing = Math.max(-_rel.dot(_los), 1);
    _nose.copy(m.vel).multiplyScalar(1 / speed);
    const ahead = _nose.dot(_los);

    let saturate = false;
    if (ahead < 0.5) {
      // PN has nothing to work with when the target is off to one side or
      // behind: there is no intercept geometry yet to hold. Put the nose as far
      // toward it as the machine can be tipped and keep it there until there
      // is one.
      _lat.copy(_los).addScaledVector(_nose, -ahead);
      saturate = true;
    } else {
      // The lateral acceleration that kills the sight line's rotation.
      _lat.crossVectors(_omega, _los).multiplyScalar(NAV_GAIN * closing);
      // Thrust is along the nose and cannot both turn the missile and drive it
      // forward, so only the part of the command across the heading counts.
      _lat.addScaledVector(_nose, -_lat.dot(_nose));
    }
    const mag = _lat.length();
    if (mag < 1e-9) {
      _want.copy(_nose);
      return;
    }
    _lat.multiplyScalar(1 / mag);

    /**
     * What the airframe can actually pull.
     *
     * Two limits, and taking the smaller is the whole flight model. Tipping the
     * motor over by `asin(k)` buys `accel * k` of lateral acceleration and
     * costs the forward component, so the airframe's ceiling is the whole
     * motor turned nearly sideways. On top of that a seeker may only rotate its
     * velocity vector so fast, and rotating at `turnRate` while doing `speed`
     * needs `turnRate * speed` of centripetal acceleration.
     *
     * Getting this wrong is subtle and total. The first pass rate-limited the
     * NOSE instead — lerping the heading toward the commanded one by
     * `turnRate * dt` each frame — which sounds equivalent and is not: the
     * commanded heading is only a couple of degrees off the current one by
     * construction, so the lerp clipped every command to `turnRate * dt`
     * radians of tilt, i.e. to about a sixteenth of the demand. Measured, the
     * seeker sailed past a stationary picket at 250 metres, every time, with
     * the guidance apparently working perfectly.
     */
    const maxLat = Math.min(w.accel * MAX_TILT, w.turnRate * speed);
    const k = Math.min(saturate ? maxLat : mag, maxLat) / Math.max(w.accel, 1);
    if (k < 1e-4) {
      _want.copy(_nose);
      return;
    }
    _want.copy(_nose).multiplyScalar(Math.sqrt(1 - k * k))
      .addScaledVector(_lat, k).normalize();
  }

  // -- integration -----------------------------------------------------------

  update(dt) {
    this._stepBolts(dt);
    this._stepMissiles(dt);
    this._writeTracers();
    // Beams are drawn for exactly the tick they were fired on.
    this.beams.length = 0;
  }

  _stepBolts(dt) {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.prev.copy(b.pos);

      if (b.drag > 0) {
        const sp = b.vel.length();
        if (sp > 1e-3) {
          b.vel.addScaledVector(b.vel, -(b.drag * sp) * dt);
        }
      }
      _t.copy(b.vel).multiplyScalar(dt);
      const len = _t.length();
      b.pos.add(_t);
      b.life -= dt;

      // Energy tracks actual speed, so a slug that has bled velocity across a
      // long shot arrives with less to spend.
      if (b.mass > 0) {
        b.energy = Math.min(b.energy, 0.5 * b.mass * b.vel.lengthSq());
      }

      if (len > 1e-5) {
        _d.copy(_t).multiplyScalar(1 / len);
        if (b.trail) {
          this.game.fx.railTrail(b.prev, b.pos, b.color);
        }
        const res = this.resolvePath(b.prev, _d, len, {
          energy: b.energy,
          ap: b.ap,
          dwell: b.dwell,
          dump: b.dump,
          burst: b.burst,
          fuseWalls: b.fuseWalls,
          holeSize: b.holeSize,
          special: b.weapon.special || null,
          weapon: b.weapon,
          owner: b.owner,
          caliber: 'bolt',
          impulse: b.mass > 0 ? b.mass * b.vel.length() : b.energy * 2e-4,
        });
        if (res.stopped) {
          // Anything carrying a charge lets go wherever it came to rest —
          // which for a delay-fused round is two bulkheads inside the hull.
          if (b.splash && res.point) {
            this.game.explode(res.point, {
              radius: b.splash.radius,
              energy: b.splash.energy,
              owner: b.owner,
              incendiary: true,
              internal: res.inside || false,
            });
          }
          this.bolts.splice(i, 1);
          continue;
        }
        if (res.ricochet) {
          b.pos.copy(res.ricochet.point);
          b.prev.copy(res.ricochet.point);
          b.vel.reflect(res.ricochet.normal);
          coneDirection(_t.copy(b.vel).normalize(), 0.25, _d);
          b.energy = res.energy;
          b.vel.copy(_d).multiplyScalar(
            b.mass > 0 ? Math.sqrt((2 * b.energy) / b.mass) : b.vel.length() * 0.7,
          );
          b.life = Math.min(b.life, 1.1);
          continue;
        }
        b.energy = res.energy;
        if (b.energy < 4e3) {
          this.bolts.splice(i, 1);
          continue;
        }
        if (b.mass > 0 && b.vel.lengthSq() > 1e-6) {
          b.vel.setLength(Math.sqrt((2 * b.energy) / b.mass));
        }
      }

      if (b.life <= 0) {
        this.bolts.splice(i, 1);
      }
    }
  }

  _stepMissiles(dt) {
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.prev.copy(m.pos);
      m.fuse -= dt;
      m.armT -= dt;
      const w = m.weapon;

      // An active head does its own targeting, and keeps doing it: it looks
      // again whenever it has nothing, whenever what it had has died, and
      // whenever what it had has left the cone it can see through. That last
      // case is what makes it fire-and-forget rather than fire-and-hope — a
      // seeker that overshoots re-acquires instead of flying on forever.
      if (w.guidance === 'active') {
        m.scanT -= dt;
        const lost = !m.target || m.target.disposed
          || m.target.position.distanceTo(m.pos) > w.seeker.range;
        if (m.scanT <= 0 && (lost || m.target.dead)) {
          m.scanT = w.seeker.reacquire;
          const found = this._acquire(m);
          if (found || lost) {
            m.target = found;
          }
        }
      }

      const tgt = m.target && !m.target.disposed ? m.target : null;
      if (tgt) {
        // A command-guided torpedo flies at the locked subsystem; a seeker head
        // cannot resolve one and flies at the hull.
        if (m.subsystem && tgt.sys.get(m.subsystem) && !tgt.sys.get(m.subsystem).destroyed) {
          this._modulePoint(tgt, m.subsystem, _p);
        } else {
          _p.copy(tgt.position);
        }
        // `_guide` returns the bearing to point the motor along, and it has
        // already accounted for both the turn rate and how far the airframe can
        // be tipped — so this is the whole of the steering.
        this._guide(m, _p, tgt.velocity);
        m.vel.addScaledVector(_want, w.accel * dt);
      } else {
        _d.copy(m.vel).normalize();
        m.vel.addScaledVector(_d, w.accel * 0.5 * dt);
      }
      // Burn-out. Without a ceiling the motor integrates for the whole 42
      // second fuse — a weapon described as slow and obvious was passing
      // 3.9 km/s at twenty seconds and could no longer turn inside anything.
      // A seeker that outruns its own turn rate cannot hit; capping speed is
      // what makes `turnRate` mean something.
      if (w.topSpeed) {
        const sp = m.vel.length();
        if (sp > w.topSpeed) {
          m.vel.multiplyScalar(w.topSpeed / sp);
        }
      }

      _t.copy(m.vel).multiplyScalar(dt);
      const len = _t.length();
      m.pos.add(_t);
      m.mesh.position.copy(m.pos);
      if (len > 1e-4) {
        _d.copy(_t).multiplyScalar(1 / len);
        m.mesh.quaternion.setFromUnitVectors(FORWARD_Z, _d);
      }
      // The motor. Ordnance under power is one of the brightest things in the
      // sky, and a warhead you cannot see coming is not a threat the player
      // gets a chance to answer.
      if (len > 1e-4) {
        this.game.fx.motorPlume(m.pos, _d, w.guidance === 'active' ? 2 : 3, w.tracer);
      }

      // Contact fuse: anything solid within the swept segment sets it off.
      let hitAt = null;
      if (m.armT <= 0 && len > 1e-5) {
        const hits = this._hits;
        hits.length = 0;
        for (const s of this.game.ships) {
          if (s === m.owner || s.disposed) {
            continue;
          }
          s.gatherRayHits(m.prev, _d, len, hits);
        }
        // Fuse on PLATING, not on the field. A shield bubble stands well off
        // the hull — on a cruiser, 170 metres off the bow — so fusing on the
        // boundary detonated every warhead at standoff range, where the inverse
        // square law threw away four fifths of it before the facet even got a
        // say. The torpedo flies through the bubble and functions against the
        // ship; `explode` still hands the blast to the facet that faces it, so
        // an intact shield is a real defence rather than a premature trigger.
        let best = null;
        for (const h of hits) {
          if (h.kind === 'wallIn' && (!best || h.t < best.t)) {
            best = h;
          }
        }
        if (best) {
          hitAt = _p.copy(m.prev).addScaledVector(_d, best.t).clone();
        }
      }
      if (hitAt || m.fuse <= 0) {
        this.detonate(m, m.owner, hitAt);
      }
    }
  }

  /**
   * The nearest live torpedo whose body the segment passes within
   * `INTERCEPT_RADIUS` of, or null. Standard point-to-segment distance; the
   * missile count is single digits, so this is a handful of dot products.
   */
  _interceptedMissile(origin, dir, maxDist, owner) {
    let best = null;
    let bestT = maxDist;
    for (const m of this.missiles) {
      if (m.owner === owner || m.armT > 0) {
        continue;
      }
      _t.copy(m.pos).sub(origin);
      const along = _t.dot(dir);
      if (along < 0 || along > bestT) {
        continue;
      }
      const kill = m.weapon.interceptR || INTERCEPT_RADIUS;
      if (_t.lengthSq() - along * along > kill * kill) {
        continue;
      }
      best = m;
      bestT = along;
    }
    return best;
  }

  /** Sets a warhead off — where it is, or at a given contact point. */
  detonate(m, owner, at) {
    const i = this.missiles.indexOf(m);
    if (i < 0) {
      return;
    }
    // Out of the world FIRST. `explode` casts a fragment fan back through the
    // solver, and a warhead that is still in the list while its own blast is
    // being resolved is a warhead that can be asked to go off twice.
    this.game.scene.remove(m.mesh);
    this.missiles.splice(i, 1);
    const w = m.weapon;
    this.game.explode(at || m.pos.clone(), {
      radius: w.blast.radius,
      energy: w.blast.energy,
      shrapnel: w.blast.shrapnel,
      shrapnelEnergy: w.blast.shrapnelEnergy,
      // Credit the kill to whoever shot it down, not to whoever launched it.
      owner: owner || m.owner,
      incendiary: true,
    });
  }

  _modulePoint(ship, moduleId, out) {
    const def = ship.hull.moduleById[moduleId];
    if (!def) {
      return out.copy(ship.position);
    }
    const s = ship.hull.sectionById[def.section];
    return out.set(
      s.pos[0] + def.pos[0] - ship.hull.com[0],
      s.pos[1] + def.pos[1] - ship.hull.com[1],
      s.pos[2] + def.pos[2] - ship.hull.com[2],
    ).applyQuaternion(ship.body.quat).add(ship.position);
  }

  // -- the penetration walk --------------------------------------------------

  /**
   * Resolves one straight segment against every ship.
   * @returns {{stopped:boolean, energy:number, point:THREE.Vector3|null}}
   */
  /**
   * True if this wall is the last of `ship` the round will meet — i.e. it is
   * leaving the hull rather than crossing an interior bulkhead. The hit list is
   * already sorted by distance, so this is a short scan forward.
   */
  _isExitWound(hits, i, ship) {
    for (let k = i + 1; k < hits.length; k++) {
      if (hits[k].ship === ship) {
        return false;
      }
    }
    return true;
  }

  resolvePath(origin, dir, maxDist, ctx) {
    const game = this.game;
    const hits = this._hits;
    hits.length = 0;
    for (const s of game.ships) {
      if (s.disposed || s === ctx.owner) {
        continue;
      }
      s.gatherRayHits(origin, dir, maxDist, hits);
    }
    if (hits.length > 1) {
      hits.sort((a, b) => a.t - b.t);
    }

    // Ordnance in flight is a target. The repeater's whole stated job is
    // shredding incoming torpedoes and it could not: nothing tested a round
    // against anything but ships, so a warhead once launched always arrived and
    // point defence was three turrets that did nothing a broadside could not.
    // Checked before the hull walk so a round kills the torpedo in front of the
    // ship rather than the plating behind it.
    //
    // Aimed fire only. Letting a blast's fragment fan clear ordnance too would
    // mean one torpedo sympathetically detonating the rest — and it would do it
    // from inside `_stepMissiles`'s own loop over the array it is splicing.
    const kill = ctx.caliber === 'shrapnel' ? null : this._interceptedMissile(origin, dir,
      hits.length > 0 ? Math.min(maxDist, hits[0].t) : maxDist, ctx.owner);
    if (kill) {
      this.detonate(kill, ctx.owner);
      return { stopped: true, energy: 0, point: kill.pos.clone() };
    }
    if (hits.length === 0) {
      return { stopped: false, energy: ctx.energy, point: null };
    }

    let E = ctx.energy;
    let dumped = false;
    let announced = false;
    let wallsCrossed = 0;

    // --- penetration trace ---------------------------------------------------
    // Recorded only for a hull a diagnostic panel is actually showing, which is
    // at most two of them, so the common case — a repeater putting six rounds a
    // second into something nobody is looking at — allocates nothing.
    //
    // One traced hull per walk. A single round crossing BOTH your ship and your
    // target in one 16 ms step is possible in principle and has never happened
    // in practice; it would simply not be drawn on the second hull.
    let trace = null;
    let traceShip = null;
    const mark = (ship, kind, at, label, joules) => {
      if (!traceShip) {
        if (!this._tracing(ship)) {
          return;
        }
        traceShip = ship;
        trace = ship.beginXray();
      } else if (ship !== traceShip) {
        return;
      }
      const p = ship.worldToHull(at, _xr);
      trace.nodes.push({
        x: p.x, y: p.y, z: p.z, kind, label, e: joules || 0,
      });
    };

    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (E <= 0) {
        break;
      }
      const ship = h.ship;
      _p.copy(origin).addScaledVector(dir, h.t);

      if (h.kind === 'shield') {
        // A contact-fused shell cannot tell a shield from a hull, and wastes
        // itself on the bubble. That is the price of carrying a charge.
        if (ctx.burst === 'surface') {
          ship.sys.damageShield(h.facet, E * 0.3, ctx.dwell);
          ship.shieldImpact(_p, 0.7);
          mark(ship, 'shieldStop', _p, `${h.facet.toUpperCase()} FACET`, E);
          this._announce(ctx, ship, false, announced);
          return { stopped: true, energy: 0, point: _p.clone(), inside: false };
        }
        // An ion pulse does not penetrate a shield, it collapses one.
        if (ctx.special === 'ion') {
          ship.sys.ionPulse(E);
          game.fx.ionBurst(_p, ship.hull.shield.radii);
          game.audio.impact('ion', _p, 1);
          this._announce(ctx, ship, false, announced);
          return { stopped: true, energy: 0, point: _p.clone() };
        }
        const through = ship.sys.damageShield(h.facet, E, ctx.dwell);
        _n.copy(_p).sub(ship.position).normalize();
        const collapsed = ship.sys.shield.facets[h.facet].down;
        game.fx.shieldHit(_p, _n, collapsed);
        ship.shieldImpact(_p, clamp01(1 - through / Math.max(E, 1)));
        game.audio.impact('shield', _p, clamp01(E / 1e6));
        mark(ship, through <= 0 ? 'shieldStop' : 'shield',
          _p, `${h.facet.toUpperCase()} FACET`, E - through);
        this._announce(ctx, ship, false, announced);
        announced = true;
        if (through <= 0) {
          return { stopped: true, energy: 0, point: _p.clone() };
        }
        E = through;
        continue;
      }

      if (h.kind === 'wallIn' || h.kind === 'wallOut') {
        // Contact discharge resolves before any penetration maths: an ion round
        // does not care about plate thickness or strike angle, it only has to
        // touch the hull.
        if (h.kind === 'wallIn' && ctx.special === 'ion') {
          ship.sys.ionPulse(E);
          game.fx.ionBurst(_p, ship.hull.shield.radii);
          game.audio.impact('ion', _p, 1);
          this._announce(ctx, ship, false, announced);
          return { stopped: true, energy: 0, point: _p.clone() };
        }
        const cos = Math.max(h.cos !== undefined ? h.cos : 1, MIN_COS);
        const ap = h.kind === 'wallIn' ? ctx.ap : ctx.ap * 1.1;
        const cost = ship.wallCost(h.section, cos, ap);

        // Contact fuse: the shell functions on the plate it touches. It never
        // gets inside, so it can only ever strip armour and kill externals.
        if (h.kind === 'wallIn' && ctx.burst === 'surface') {
          ship.sys.damageSection(h.section, ctx.energy * 0.25, _p, dir);
          ship.applyImpulseAt(_p, dir, ctx.impulse);
          ship.scorch(h.section, 0.30);
          // All of it went off against the skin, so all of it shows: a wide
          // burn, no hole, and a spray thrown back the way it came.
          _n.set(h.nx, h.ny, h.nz);
          ship.mark(_p, _n, {
            radius: markRadius(ctx.energy) * 1.7,
            soot: 0.95, heat: 0.95, section: h.section,
          });
          // Everything it had went off against the skin, so everything it had
          // comes back off the skin: a hemisphere of fire standing off the
          // plating, with pieces of that plating inside it.
          game.fx.surfaceBlast(_p, _n, ship.velocity, blastScale(ctx.energy));
          mark(ship, 'surface', _p,
            ship.hull.sectionById[h.section].label, ctx.energy * 0.25);
          this._announce(ctx, ship, false, announced);
          return { stopped: true, energy: 0, point: _p.clone(), inside: false };
        }

        // A shallow strike that cannot make it through deflects rather than
        // burying itself: it keeps most of its energy and goes somewhere else.
        if (h.kind === 'wallIn' && E < cost && cos < RICOCHET_COS
            && ctx.caliber !== 'shrapnel' && ctx.ap > 0) {
          ship.sys.damageSection(h.section, E * 0.22, _p, dir);
          ship.scorch(h.section, 0.05);
          _n.set(h.nx, h.ny, h.nz);
          // A graze gouges rather than bores: a long smear of bare hot metal
          // and most of the round's energy still travelling.
          ship.mark(_p, _n, {
            radius: markRadius(E * 0.22) * 1.3,
            soot: 0.55, heat: 0.8, section: h.section,
          });
          game.fx.sparkBurst(_p, _n, 26, 0xfff0c0);
          game.audio.impact('ricochet', _p, 1);
          mark(ship, 'ricochet', _p, ship.hull.sectionById[h.section].label, E * 0.22);
          this._announce(ctx, ship, false, announced);
          return {
            stopped: false,
            energy: E * 0.5,
            point: _p.clone(),
            ricochet: { point: _p.clone(), normal: _n.clone() },
          };
        }

        const consumed = Math.min(E, cost);
        E -= consumed;
        // A wall the round got all the way through is a wall with a hole in it,
        // regardless of how much plate health is left. That hole vents the
        // compartment until the crew weld it shut, which is what makes a
        // through-and-through a systems attack rather than a damage roll.
        const perforated = E > 0;
        if (perforated) {
          ship.sys.punchHole(h.section, ctx.holeSize || 0.5);
        }

        if (h.kind === 'wallIn') {
          wallsCrossed++;
          const ratio = clamp01(consumed / Math.max(cost, 1));
          ship.sys.damageSection(h.section, consumed * 0.5 + ctx.energy * 0.05, _p, dir);
          ship.applyImpulseAt(_p, dir, ctx.impulse * (0.35 + 0.65 * ratio));
          ship.scorch(h.section, 0.10);
          _n.set(h.nx, h.ny, h.nz);
          // Entry wound. If it went through, the mark is a hole and keeps a
          // glow for as long as the compartment behind it is open; if the plate
          // stopped it, it is a crater that simply cools.
          ship.mark(_p, _n, {
            radius: markRadius(consumed + ctx.energy * 0.05),
            soot: 0.9,
            heat: perforated ? 1 : 0.7,
            hole: perforated,
            section: h.section,
          });
          game.fx.sparkBurst(_p, _n, perforated ? 14 : 30, 0xffd18a);
          if (perforated) {
            // Spall: the round punched through and threw a cone of hot plate
            // off the inner face ahead of itself.
            game.fx.spall(_p, dir, 16, 0xffb060);
            // And a little of the hole comes back OUT of the hole. A hit that
            // goes through throws ejecta both ways, and the backwash is what
            // makes an entry wound read as a wound rather than as a spark.
            //
            // Real penetrators only. A repeater perforating a radiator a
            // hundred times a second would otherwise own the entire debris
            // pool inside four seconds, and the pieces that matter — the ones
            // a wreck is made of — would be evicted by shell splinters.
            const bs = blastScale(consumed);
            if (bs > 1.2) {
              game.fx.chunkBurst(_p, _n, ship.velocity, Math.round(bs), 26,
                0.3 * bs, 0x6e757d, 0.8, 0.6);
            }
          }
          game.audio.impact('metal', _p, 0.9);
          mark(ship, perforated ? 'wall' : 'wallStop', _p,
            ship.hull.sectionById[h.section].label, consumed);
          this._announce(ctx, ship, false, announced);
          announced = true;

          // Delay fuse: through the outer plating and one bulkhead, then it
          // functions — inside the ship, next to whatever lives there.
          if (ctx.burst === 'delay' && perforated && wallsCrossed >= ctx.fuseWalls) {
            return { stopped: true, energy: 0, point: _p.clone(), inside: true };
          }
        } else if (perforated && h.nx !== undefined && this._isExitWound(hits, i, ship)) {
          // Exit wound. Compartments tile the hull, so the last wall a round
          // leaves on its way out is the outer skin — and a through-and-through
          // that shows a hole on BOTH sides is the whole argument for carrying
          // solid shot. Interior bulkhead crossings are skipped: they are real,
          // but they are behind the plating where nobody can see them, and they
          // would churn the decal pool for nothing.
          _n.set(h.nx, h.ny, h.nz);
          ship.mark(_p, _n, {
            radius: markRadius(consumed) * 1.25,
            soot: 0.85, heat: 1, hole: true, section: h.section,
          });
          // The far side of a through-and-through. What leaves the exit hole is
          // the inside of everything the round crossed to get there, and it
          // leaves at speed, along the round's own line.
          game.fx.exitBlast(_p, dir, ship.velocity, blastScale(ctx.energy));
          game.audio.impact('exit', _p, 0.9);
          mark(ship, 'exit', _p, ship.hull.sectionById[h.section].label, consumed);
        }
        if (E <= 0) {
          mark(ship, 'stop', _p, ship.hull.sectionById[h.section].label, consumed);
          return { stopped: true, energy: 0, point: _p.clone(), inside: h.kind === 'wallOut' };
        }
        continue;
      }

      // --- module ---------------------------------------------------------
      const m = h.module;
      if (!m || m.destroyed) {
        continue;
      }
      const mat = MATERIALS[m.def.mat];
      let cost = h.path * mat.resist;
      if (ctx.dump && !dumped) {
        // Comes apart in the first thing it reaches and deposits the bulk of
        // its remaining budget there instead of carrying it onward.
        cost = Math.max(cost, E * ctx.dump);
        dumped = true;
      }
      const consumed = Math.min(E, cost);
      E -= consumed;

      const before = m.destroyed;
      ship.sys.damageModule(m.id, consumed, _p.clone(), dir);
      if (!before && m.destroyed) {
        game.onModuleKill(ship, m, ctx.owner);
      }
      game.fx.internalHit(_p, dir, m.kind);
      // The node that matters: what the round actually found in there, and
      // whether it finished it. This is the whole reason for the trace.
      mark(ship, E <= 0 ? 'moduleStop' : 'module', _p, m.label, consumed);
      if (trace && traceShip === ship) {
        const last = trace.nodes[trace.nodes.length - 1];
        last.id = m.id;
        last.killed = !before && m.destroyed;
      }
      this._announce(ctx, ship, true, announced);
      announced = true;
      if (E <= 0) {
        return { stopped: true, energy: 0, point: _p.clone(), inside: true, host: ship };
      }
    }

    return { stopped: false, energy: E, point: null };
  }

  /** Is anything on screen currently showing this hull's interior? */
  _tracing(ship) {
    const g = this.game;
    return !!((g.diagnostics && g.diagnostics.ship === ship)
      || (g.targetPanel && g.targetPanel.ship === ship));
  }

  _announce(ctx, ship, internal, already) {
    if (already || !ctx.owner) {
      return;
    }
    this.game.onHit(ctx.owner, ship, internal);
  }

  /**
   * Beam tick. Finds the first surface along the aim line and pours energy into
   * it for this frame: shields first, then plate, then heat into the
   * compartment behind it and damage to whatever is under the spot.
   */
  fireBeam(ship, mount, origin, dir, dt) {
    const game = this.game;
    const w = mount.weapon;
    const hits = this._hits;
    hits.length = 0;
    for (const s of game.ships) {
      if (s.disposed || s === ship) {
        continue;
      }
      s.gatherRayHits(origin, dir, w.range, hits);
    }
    if (hits.length > 1) {
      hits.sort((a, b) => a.t - b.t);
    }

    const joules = w.dps * dt;
    let end = null;
    const first = hits.find((h) => h.kind === 'shield' || h.kind === 'wallIn');
    if (first) {
      _p.copy(origin).addScaledVector(dir, first.t);
      end = _p.clone();
      const target = first.ship;
      if (first.kind === 'shield') {
        // A beam's dwell is literally the frame it was fired on.
        target.sys.damageShield(first.facet, joules, Math.max(dt, 1e-4));
        target.shieldImpact(_p, 0.5);
        game.fx.shieldHit(_p, _n.copy(_p).sub(target.position).normalize(), false);
      } else {
        // Obliquity matters here too: a glancing beam smears its energy out.
        const bite = Math.max(first.cos !== undefined ? first.cos : 1, 0.25);
        // Split the delivered energy between breaking things and heating them,
        // rather than spending it twice. Injecting the full budget as heat ON
        // TOP of 55% as structural damage made a lance worth 155% of its own
        // output, and the surplus went somewhere invisible: into the shared
        // coolant loop, which cooked a cruiser's reactor to detonation in
        // twenty-two seconds from a bow hit. The cascade is the right mechanism
        // — it just should not be free.
        target.sys.damageSection(first.section, joules * bite * 0.55, _p, dir);
        target.sys.injectHeat(first.section, joules * bite * 0.45);
        target.scorch(first.section, 0.5 * dt);
        // A beam is continuous, so it cannot lay a mark per frame without
        // flushing the whole sheet in a second. It leaves one every 0.2 s
        // instead, which is what draws the walking scar a tracking lance cuts
        // across a hull rather than a single dot.
        mount.markT = (mount.markT || 0) - dt;
        if (mount.markT <= 0 && first.nx !== undefined) {
          mount.markT = 0.2;
          const sec0 = target.sys.section(first.section);
          target.mark(_p, _n.set(first.nx, first.ny, first.nz), {
            radius: markRadius(w.dps * 0.2) * 0.7,
            soot: 0.8,
            heat: 1,
            hole: !!(sec0 && sec0.breached),
            section: first.section,
          });
        }
        // Once the plate is open the spot starts cooking what is under it.
        const sec = target.sys.section(first.section);
        if (sec && sec.breached) {
          const inner = hits.find((h) => h.kind === 'module' && h.ship === target);
          if (inner) {
            target.sys.damageModule(inner.module.id, joules * bite * 1.3, _p, dir);
          }
        }
      }
      game.fx.beamImpact(_p, w.tracer);
      game.onHit(ship, target, false);
    } else {
      end = _o.copy(origin).addScaledVector(dir, w.range).clone();
    }
    this.beams.push({ from: origin.clone(), to: end, color: w.tracer, width: w.width });
    return end;
  }

  /** Shrapnel fan used by explosions. Cheap rays with a small budget each. */
  castShrapnel(center, count, energyEach, owner) {
    for (let i = 0; i < count; i++) {
      randomDirection(_d);
      _o.copy(center).addScaledVector(_d, 0.4);
      this.resolvePath(_o, _d, 90, {
        energy: energyEach * rand(0.6, 1.4),
        ap: 1.2,
        // Fragments are small, fast and arrive as a swarm of tiny spikes.
        dwell: 8e-4,
        dump: 0,
        special: null,
        owner,
        caliber: 'shrapnel',
        impulse: 40,
      });
    }
  }

  // -- rendering -------------------------------------------------------------

  _writeTracers() {
    let n = 0;
    const pos = this.tracerPos;
    const col = this.tracerCol;

    const push = (a, b, c, headScale) => {
      if (n >= MAX_TRACERS) {
        return;
      }
      const i6 = n * 6;
      pos[i6] = a.x; pos[i6 + 1] = a.y; pos[i6 + 2] = a.z;
      pos[i6 + 3] = b.x; pos[i6 + 4] = b.y; pos[i6 + 5] = b.z;
      col[i6] = c.r * 0.12; col[i6 + 1] = c.g * 0.12; col[i6 + 2] = c.b * 0.12;
      col[i6 + 3] = c.r * headScale; col[i6 + 4] = c.g * headScale; col[i6 + 5] = c.b * headScale;
      n++;
    };

    for (const b of this.bolts) {
      _t.copy(b.pos).sub(b.prev);
      const l = _t.length();
      if (l < 1e-4) {
        continue;
      }
      _t.multiplyScalar(1 / l);
      _o.copy(b.pos).addScaledVector(_t, -Math.min(l * 1.4, 26));
      push(_o, b.pos, b.color, 1.8);
    }
    for (const beam of this.beams) {
      push(beam.from, beam.to, _beamColor.set(beam.color), 2.4);
    }

    this.tracerGeo.attributes.position.needsUpdate = true;
    this.tracerGeo.attributes.color.needsUpdate = true;
    this.tracerGeo.setDrawRange(0, n * 2);
  }

  clear() {
    this.bolts.length = 0;
    for (const m of this.missiles) {
      this.game.scene.remove(m.mesh);
    }
    this.missiles.length = 0;
    this.beams.length = 0;
  }
}

const _beamColor = new THREE.Color();
const FORWARD_Z = new THREE.Vector3(0, 0, 1);
