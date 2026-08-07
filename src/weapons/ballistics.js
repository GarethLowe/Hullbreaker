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

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();

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
    this.game.scene.add(mesh);
    this.missiles.push({
      pos: origin.clone(),
      prev: origin.clone(),
      vel: dir.clone().multiplyScalar(weapon.muzzleVel).add(inherit),
      weapon,
      owner: ship,
      target,
      // A seeker aims at the locked SUBSYSTEM when there is one, which is what
      // makes subsystem targeting worth doing with ordnance rather than guns.
      subsystem: ship.isPlayer ? this.game.targeting.subsystem : null,
      fuse: weapon.fuse,
      mesh,
      armT: 0.35,
    });
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

      const tgt = m.target && !m.target.disposed ? m.target : null;
      if (tgt) {
        // Proportional guidance onto an intercept point rather than onto the
        // target's current position, so it does not tail-chase.
        if (m.subsystem && tgt.sys.get(m.subsystem) && !tgt.sys.get(m.subsystem).destroyed) {
          this._modulePoint(tgt, m.subsystem, _p);
        } else {
          _p.copy(tgt.position);
        }
        _o.copy(_p).sub(m.pos);
        _d.copy(tgt.velocity).sub(m.vel);
        const speed = Math.max(m.vel.length(), 40);
        const lead = Math.min(_o.length() / speed, 4);
        _o.addScaledVector(_d, lead).normalize();
        _d.copy(m.vel).normalize();
        // Turn rate limits how fast the nose can come round.
        const maxTurn = w.turnRate * dt;
        const dot = Math.max(-1, Math.min(1, _d.dot(_o)));
        const ang = Math.acos(dot);
        if (ang > 1e-4) {
          _d.lerp(_o, Math.min(1, maxTurn / ang)).normalize();
        }
        m.vel.addScaledVector(_d, w.accel * dt);
      } else {
        _d.copy(m.vel).normalize();
        m.vel.addScaledVector(_d, w.accel * 0.5 * dt);
      }

      _t.copy(m.vel).multiplyScalar(dt);
      const len = _t.length();
      m.pos.add(_t);
      m.mesh.position.copy(m.pos);
      if (len > 1e-4) {
        _d.copy(_t).multiplyScalar(1 / len);
        m.mesh.quaternion.setFromUnitVectors(FORWARD_Z, _d);
      }
      if (Math.random() < 30 * dt) {
        this.game.fx.smokePuff(m.pos, 0.9);
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
        let best = null;
        for (const h of hits) {
          if ((h.kind === 'wallIn' || h.kind === 'shield') && (!best || h.t < best.t)) {
            best = h;
          }
        }
        if (best) {
          hitAt = _p.copy(m.prev).addScaledVector(_d, best.t).clone();
        }
      }
      if (hitAt || m.fuse <= 0) {
        this.game.explode(hitAt || m.pos.clone(), {
          radius: w.blast.radius,
          energy: w.blast.energy,
          shrapnel: w.blast.shrapnel,
          shrapnelEnergy: w.blast.shrapnelEnergy,
          owner: m.owner,
          incendiary: true,
        });
        this.game.scene.remove(m.mesh);
        this.missiles.splice(i, 1);
      }
    }
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
    if (hits.length === 0) {
      return { stopped: false, energy: ctx.energy, point: null };
    }
    if (hits.length > 1) {
      hits.sort((a, b) => a.t - b.t);
    }

    let E = ctx.energy;
    let dumped = false;
    let announced = false;
    let wallsCrossed = 0;

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
          game.fx.sparkBurst(_p, _n, 30, 0xffc070);
          game.fx.blastPlume(_p, _n, ship.velocity, markRadius(ctx.energy) * 0.9);
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
          }
          game.audio.impact('metal', _p, 0.9);
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
          game.fx.spall(_p, dir, 24, 0xffc98a);
          game.audio.impact('metal', _p, 0.6);
        }
        if (E <= 0) {
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
      this._announce(ctx, ship, true, announced);
      announced = true;
      if (E <= 0) {
        return { stopped: true, energy: 0, point: _p.clone(), inside: true, host: ship };
      }
    }

    return { stopped: false, energy: E, point: null };
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
        target.sys.damageSection(first.section, joules * bite * 0.55, _p, dir);
        target.sys.injectHeat(first.section, joules * bite);
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
