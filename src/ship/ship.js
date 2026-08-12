// -----------------------------------------------------------------------------
// ship.js — one hostile or friendly vessel: body, interior, crew and guns.
//
// The important routine here is `gatherRayHits`. A ship is a single rigid body,
// so a ray is transformed into ship-local space exactly once and then tested
// analytically against, in order:
//
//     the shield ellipsoid  ->  every compartment box  ->  every module inside
//
// producing a flat list of layer crossings with a distance, a material and a
// path length through it. The ballistics solver walks that list spending an
// energy budget. Nothing about damage is rolled: a round stops where it runs
// out of joules, and whatever drained it is what took the damage.
//
// Everything visible is a compartment box, so what you can see is exactly what
// you can shoot, and the cutaway is a true drawing of the thing you are aiming
// at rather than an illustration of it.
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { MATERIALS, FACETS } from './hulls.js';
import { Systems } from './systems.js';
import { Crew } from './crew.js';
import { Body, Autopilot, FORWARD } from './flight.js';
import { canFireMount, shotHeatRate } from './gunnery.js';
import { Decals } from '../fx/decals.js';
import {
  buildMount, mountFrame, mountStyle, partGeometry, shellGeometry, skinFraction,
} from '../world/hardware.js';
import { WEAPONS, MOUNTS, AMMO } from '../weapons/defs.js';
import {
  rayBox, raySphere, rayEllipsoid, AXIS_KEY, clamp, clamp01, rand, interceptTime,
} from '../core/mathx.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _qi = new THREE.Quaternion();
// Dedicated temporaries for `mark`. It is called from inside ballistics'
// resolvePath, which is already using the shared ones above.
const _mp = new THREE.Vector3();
const _mn = new THREE.Vector3();
const _mq = new THREE.Quaternion();
/** Scratch for the gunnery lay error; `_d` is live across that stretch. */
const _lay = new THREE.Vector3();
/** Muzzle solve. `_launch` is holding `_o` and `_v2` when this runs. */
const _mz = new THREE.Vector3();
const _mzUp = new THREE.Vector3();
const _mzR = new THREE.Vector3();
const _mzU = new THREE.Vector3();

/**
 * How far a gun rides back on its slide when it fires, as a fraction of the
 * mount's scale, and how fast it returns. Recoil is the cheapest thing that
 * makes a battery look mechanical rather than animated — the eye reads the
 * hesitation between the flash and the gun coming back up.
 */
const RECOIL_TRAVEL = 0.55;
const RECOIL_RETURN = 5.5;

/**
 * Radians a mount may point below the face it is bolted to. About five degrees,
 * which is roughly what a real barbette allows before the breech fouls its own
 * ring — the gun is a machine standing on a deck, not a vector with permission.
 *
 * Until this existed `arc` was a symmetric cone about the rest bearing and
 * nothing knew the deck was there, so every mount aboard could swing its barrel
 * down through its own plating: the broadsides to 26 degrees below their ring
 * and the point defence to 42. The barrel visibly passed through the hull, and
 * the shot came with it.
 *
 * This is applied AFTER the traverse arc rather than before it, and that order
 * is deliberate: the arc is an authored limit and this is a physical one, so
 * when the two disagree the metal wins.
 */
export const MOUNT_DEPRESSION = 0.09;

/**
 * How far off its firing solution a mount may be and still be worth shooting.
 *
 * Every gun fired whenever the trigger was held, whether it could bear or not —
 * so a broadside hull with its port battery hard against the stop emptied those
 * magazines into empty space on every burst, and the player paid for it in
 * ammunition without ever putting a round near the target. About a degree and a
 * half, widened by the target's angular size.
 */
const BEAR_TOL = 0.026;
const BEAR_COS = Math.cos(BEAR_TOL);

/**
 * What a tender puts back between waves. See `Ship.resupply`.
 *
 * Fuel is not here because it fills: the deliberate asymmetry is that the thing
 * which is cheap to replace is the thing the ship cannot fight without, while
 * hands and rounds trickle back and stay a reason to husband them.
 */
const RESUPPLY_CREW = 0.25;
const RESUPPLY_AMMO = 0.10;
/** Scratch for that clamp; `_aimMount` is holding most of the others. */
const _mnt = new THREE.Vector3();
const _mntT = new THREE.Vector3();

/**
 * Radians a gun is mis-laid by when its station is completely unmanned. About
 * 1.7 degrees, which is a clean miss on a cruiser past two kilometres and a
 * degraded but real threat inside that — a gutted ship should shoot badly, not
 * be disarmed outright.
 */
const MAX_LAY_ERROR = 0.024;

/**
 * Facet lookup by dominant local axis, in +X/-X/+Y/-Y/+Z/-Z order.
 * +X is PORT in this right-handed, +Z-forward frame — see the sign note in
 * flight.js. Getting this pair the wrong way round makes the HUD tell you the
 * wrong side of your ship is exposed, which is worse than not telling you.
 */
const FACET_BY_AXIS = [['port', 'stbd'], ['dorsal', 'ventral'], ['fore', 'aft']];

let SHIP_SERIAL = 0;

/**
 * How many penetration traces a hull remembers, and how long one stays on the
 * cutaway. `XRAY_DRAW` is the travel time of the replay — the round is drawn
 * walking through the ship rather than appearing whole, because seeing WHERE
 * it went is the entire point and a static line does not show direction.
 */
const XRAY_MAX = 16;
export const XRAY_DRAW = 0.22;
export const XRAY_HOLD = 2.6;
export const XRAY_FADE = 6.5;

/** Live wounds a hull remembers the position of, for venting and fire. */
const MAX_HOLES = 32;

/**
 * How much further away a second director will look before it agrees to double
 * up on a warhead another one is already tracking. See `_pdThreat`.
 */
const PD_DOUBLE_UP = 900;

export class Ship {
  constructor(game, hullId, opts = {}) {
    this.game = game;
    this.hull = game.hulls[hullId];
    this.id = ++SHIP_SERIAL;
    this.faction = opts.faction || 'hostile';
    this.name = opts.name || `${this.hull.name}-${this.id}`;
    this.isPlayer = !!opts.isPlayer;
    this.disposed = false;
    this.dead = false;
    this.deadT = 0;
    /**
     * Recent penetration traces, for the cutaway. Each is one round's walk
     * through this hull in HULL-TABLE coordinates, so the cutaway can draw it
     * over the same boxes the solver tested against without transforming
     * anything. Only recorded for ships a diagnostic panel is actually
     * showing — see `Ballistics._tracing`.
     */
    this.xray = [];
    /** Mission-killed: adrift, still intact, still possibly shooting. */
    this.derelict = false;
    this.derelictT = 0;
    /** Kill already credited, so a hulk cannot be scored twice. */
    this.scored = false;
    /** Delta-v taken from impacts since the camera last looked; see consumeJolt. */
    this.jolt = 0;
    /** Magazine-fed mounts all draw the same nature of round; see AMMO. */
    this.ammo = 'ap';
    /**
     * Where this hull has actually been holed, in body coordinates, with the
     * outward normal of the plating it went through. Recorded by `mark` and
     * read by the effects: a compartment vents from its wounds, not from a
     * point floating in the middle of the room.
     */
    this.holes = [];
    /** Scratch descriptor handed to the point-defence laying code. */
    this._pdTarget = { pos: null, vel: null, cone: 0.035 };
    /** How many directors are already on each warhead this tick. */
    this._pdLoad = new Map();
    /** Infrared brightness, recomputed once a tick. See `heatSignature`. */
    this._ir = 0;

    this.sys = new Systems(this.hull, this);
    this.crew = new Crew(this.hull, this.sys);
    this.body = new Body(this.hull);
    this.autopilot = new Autopilot(this.hull, this.sys, this.crew);

    if (opts.position) {
      this.body.pos.copy(opts.position);
    }
    if (opts.quaternion) {
      this.body.quat.copy(opts.quaternion);
    }
    if (opts.velocity) {
      this.body.vel.copy(opts.velocity);
    }

    this._buildMesh(opts.tint);
    this._buildHardpoints();

    /** Per-section broadphase radius, precomputed. */
    this._secR = new Map();
    for (const s of this.hull.sections) {
      this._secR.set(s.id, Math.hypot(s.half[0], s.half[1], s.half[2]));
    }
    this.hitRadius = this.hull.radius;
    this.shieldRadii = this.hull.shield.radii;
    this.shieldR = Math.max(...this.shieldRadii);
  }

  // -- construction ----------------------------------------------------------

  _buildMesh(tintOverride) {
    const assets = this.game.assets;
    const tint = tintOverride !== undefined ? tintOverride : this.hull.tint;
    this.tint = tint;
    // Derived in `compile()`, not here: the shield extent has to enclose the
    // hardware, so how big the guns are is a fact about the hull rather than
    // about the renderer. See `gunScaleFor` in hulls.js.
    this.gunScale = this.hull.gunScale;
    this.group = new THREE.Group();
    this.sectionMeshes = new Map();

    for (const s of this.hull.sections) {
      // The armour is armour even on the bridge: the transmissive material is
      // for the window band, which is its own part inside the shell.
      const mat = assets.hullMaterial(tint, s.style === 'canopy' ? 'hull' : s.style);
      const geo = shellGeometry(s.style);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.set(s.half[0] * 2, s.half[1] * 2, s.half[2] * 2);
      // Positions are relative to the derived centre of mass, so the model and
      // the physics agree about where the ship actually pivots.
      mesh.position.set(
        s.pos[0] - this.hull.com[0],
        s.pos[1] - this.hull.com[1],
        s.pos[2] - this.hull.com[2],
      );
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData.section = s.id;
      this.group.add(mesh);
      this.sectionMeshes.set(s.id, mesh);

      // Three randomly-placed boxes per compartment used to stand in for
      // surface relief. The shells carry their own ribs, strakes and radiator
      // banks now, modelled to the compartment rather than scattered over it,
      // so the greebles are gone: they were noise on top of detail.
      if (s.style === 'canopy') {
        const glass = new THREE.Mesh(
          partGeometry('shell_canopy_glass'), assets.hullMaterial(tint, 'canopy'));
        // A child, so it inherits the compartment's non-uniform scale and stays
        // welded into the window aperture whatever shape the bridge is.
        mesh.add(glass);
      }
    }

    // Drive glow: one sprite per main drive, brightness follows throttle.
    this.driveGlows = [];
    for (const def of this.hull.modules) {
      if (def.kind !== 'thruster') {
        continue;
      }
      const s = this.hull.sectionById[def.section];
      const sprite = new THREE.Sprite(assets.driveMaterial(tint));
      sprite.position.set(
        s.pos[0] + def.pos[0] - this.hull.com[0],
        s.pos[1] + def.pos[1] - this.hull.com[1],
        s.pos[2] - s.half[2] - 0.4 - this.hull.com[2],
      );
      sprite.scale.setScalar(this.hull.radius * 0.30);
      this.group.add(sprite);
      this.driveGlows.push({ sprite, id: def.id, base: this.hull.radius * 0.30 });
    }

    // Navigation strobe, so contacts read at range even against the dust.
    //
    // A billboard rather than a PointLight, and not as a shortcut: three.js
    // bakes the number of visible lights into every shader program's cache key,
    // so one light per ship meant every arriving hull changed the light count
    // and silently recompiled every material in the scene. A four-ship wave did
    // it four times, mid-fight. It was also the wrong tool — a real light at the
    // centre of a sealed hull mostly illuminates that hull's own plating, while
    // what this is actually for is being SEEN from four kilometres away, which
    // is a job for something that emits rather than something that lights.
    this.beacon = new THREE.Sprite(this.game.assets.driveMaterial(tint));
    this.beacon.material.color.set(tint);
    this.beacon.position.set(0, 0, 0);
    this.beacon.scale.setScalar(this.hull.radius * 0.5);
    this.group.add(this.beacon);

    this.decals = new Decals(this.group);

    this.game.scene.add(this.group);
    this._buildShieldBubble();
  }

  /**
   * The visible field. Invisible until something touches it, then it lights up
   * exactly where it was struck and fades — the field is only doing work where
   * work is being done to it.
   *
   * Impacts are held as unit directions in ship-local space, so the flare stays
   * welded to the point of impact while the hull rotates underneath it. Eight
   * live impacts is plenty; the ring buffer overwrites the oldest.
   */
  _buildShieldBubble() {
    const r = this.hull.shield.radii;
    const geo = this.game.assets.shieldGeo;
    this._shieldHits = [];
    for (let i = 0; i < 8; i++) {
      this._shieldHits.push(new THREE.Vector4(0, 0, 1, 0));
    }
    this._shieldHead = 0;
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uHits: { value: this._shieldHits },
        uCharge: { value: 1 },
        uLoad: { value: 0 },
        uColor: { value: new THREE.Color(0x6fc8ff) },
        uHot: { value: new THREE.Color(0xffb060) },
      },
      vertexShader: `
        varying vec3 vLocal;
        varying vec3 vView;
        varying vec3 vNormalW;
        void main() {
          vLocal = normalize(position);
          vec4 world = modelMatrix * vec4(position, 1.0);
          vView = normalize(cameraPosition - world.xyz);
          vNormalW = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `
        uniform vec4 uHits[8];
        uniform float uCharge;
        uniform float uLoad;
        uniform vec3 uColor;
        uniform vec3 uHot;
        varying vec3 vLocal;
        varying vec3 vView;
        varying vec3 vNormalW;

        void main() {
          // Localised impact flares. Each is a cosine-falloff cap centred on
          // the direction the round came in on, tightening as it fades.
          float g = 0.0;
          for (int i = 0; i < 8; i++) {
            float a = uHits[i].w;
            if (a <= 0.001) { continue; }
            float c = max(0.0, dot(vLocal, uHits[i].xyz));
            float tight = mix(220.0, 40.0, a);
            g += pow(c, tight) * a;
            // A thin expanding ring chases the flare outward from the point.
            float ring = 1.0 - abs(c - (1.0 - (1.0 - a) * 0.45));
            g += pow(max(0.0, ring), 260.0) * a * 0.9;
          }

          // A faceted lattice, so the field reads as a structure rather than a
          // soap bubble. Only visible where the field is doing something.
          vec3 p = vLocal * 7.0;
          float lat = 0.0;
          lat += smoothstep(0.86, 1.0, abs(sin(p.x + p.y)));
          lat += smoothstep(0.86, 1.0, abs(sin(p.y + p.z)));
          lat += smoothstep(0.86, 1.0, abs(sin(p.z - p.x)));

          // Edge-on the field is opaque, face-on it is nearly clear — standard
          // Fresnel, and the reason you can see through your own shield.
          float fres = pow(1.0 - abs(dot(normalize(vNormalW), vView)), 3.0);

          // Saturated emitters glow hot; a healthy field is cold blue.
          vec3 col = mix(uColor, uHot, clamp(uLoad, 0.0, 1.0));
          float alpha = (g * 0.85 + fres * 0.14 * uCharge + lat * 0.02 * g)
                        * clamp(uCharge * 0.35 + g, 0.0, 1.4);
          if (alpha < 0.002) { discard; }
          gl_FragColor = vec4(col * (0.6 + g * 1.8), alpha);
        }`,
    });
    mat.userData.owned = true;
    this.shieldMesh = new THREE.Mesh(geo, mat);
    this.shieldMesh.scale.set(r[0], r[1], r[2]);
    this.shieldMesh.frustumCulled = false;
    this.shieldMesh.renderOrder = 5;
    this.group.add(this.shieldMesh);
  }

  /** Records a strike on the field at a world point. `power` is 0..1. */
  shieldImpact(worldPoint, power = 1) {
    if (!this.shieldMesh) {
      return;
    }
    _v.copy(worldPoint).sub(this.body.pos)
      .applyQuaternion(_qi.copy(this.body.quat).invert());
    const r = this.hull.shield.radii;
    // Normalise into the sphere's frame so the flare sits on the surface of the
    // ellipsoid rather than on the sphere it was built from.
    _v.set(_v.x / r[0], _v.y / r[1], _v.z / r[2]);
    if (_v.lengthSq() < 1e-8) {
      return;
    }
    _v.normalize();
    const h = this._shieldHits[this._shieldHead];
    this._shieldHead = (this._shieldHead + 1) % this._shieldHits.length;
    h.set(_v.x, _v.y, _v.z, Math.max(0.35, Math.min(1, power)));
  }

  _buildHardpoints() {
    this.mounts = [];
    for (const def of this.hull.hardpoints) {
      const w = WEAPONS[def.weapon];
      if (!w) {
        continue;
      }
      const s = this.hull.sectionById[def.section];
      const mount = {
        def,
        weapon: w,
        mod: this.sys.get(def.id),
        /** Mount origin in body coordinates (already COM-relative). */
        origin: new THREE.Vector3(
          s.pos[0] + def.pos[0] - this.hull.com[0],
          s.pos[1] + def.pos[1] - this.hull.com[1],
          s.pos[2] + def.pos[2] - this.hull.com[2],
        ),
        rest: new THREE.Vector3(...def.dir).normalize(),
        aim: new THREE.Vector3(...def.dir).normalize(),
        /** Where fire control wants this mount, unclamped. See `_bears`. */
        want: new THREE.Vector3(...def.dir).normalize(),
        cool: 0,
        firing: false,
        beamT: 0,
        scale: MOUNTS[def.mount] || 1,
        /**
         * Two different questions, and conflating them cost the player half
         * the arsenal.
         *
         * `turret` is the AI's question — "does this gun point itself, or do I
         * have to point the ship at something?" — and it decides which trigger
         * group the mount lands in.
         *
         * `traverses` is the gunnery question: can this mount slew at all? Any
         * mount with a real arc can, and `_aimMount` already contains correct
         * code to clamp a demand into that arc. Gating that code on `turret`
         * meant a mount with a 6.9-degree traverse was flown as though it were
         * welded down — so the MERIDIAN's lances, ion projector and torpedo
         * tubes fired along their authored bearing, 2 to 6 degrees off the
         * reticle, and missed everything at every range.
         */
        turret: def.arc > 0.25,
        traverses: def.arc > 0.02,
        /** Decorrelates lay error across a broadside. */
        phase: this.mounts.length * 2.39,
        /** Recoil state, 1 at the instant of firing. */
        kick: 0,
        /** Which barrel fires next, for multi-barrel mounts. */
        barrel: 0,
      };

      // The physical fitting. `origin` is where the hull tables put the gun,
      // which is a point inside the compartment; the hardware has to stand on
      // the plating, so it is pushed out to the skin of the face it is bolted
      // to and the muzzle is measured from there.
      const style = mountStyle(w, def.arc);
      const frame = mountFrame(def.pos, s.half, def.dir, s.style);
      const rig = buildMount(
        this.game.assets, this.tint, w, style, mount.scale * this.gunScale);
      mount.up = frame.up;
      mount.invQuat = frame.quat.clone().invert();
      mount.surface = mount.origin.clone().addScaledVector(frame.up, frame.lift);
      rig.root.position.copy(mount.surface);
      rig.root.quaternion.copy(frame.quat);
      mount.rig = rig;
      this.group.add(rig.root);

      this.mounts.push(mount);
    }
    // Point defence is not a weapon anybody chooses to fire. It comes out of
    // both the player's selectable groups and the AI's triggers entirely and
    // runs itself against inbound ordnance — see `_pointDefence`.
    const gunnery = this.mounts.filter((m) => !m.weapon.pointDefence);

    // The AI thinks in terms of "guns I have to point the ship at" versus
    // "guns that point themselves".
    this.fireGroups = [
      gunnery.filter((m) => !m.turret && m.weapon.kind !== 'missile'),
      gunnery.filter((m) => m.turret || m.weapon.kind === 'missile'),
    ];
    // The player thinks in terms of weapons. Mounts carrying the same weapon
    // fire together as one selectable group, in hull-table order.
    const byWeapon = new Map();
    for (const m of gunnery) {
      if (!byWeapon.has(m.def.weapon)) {
        byWeapon.set(m.def.weapon, []);
      }
      byWeapon.get(m.def.weapon).push(m);
    }
    this.weaponGroups = [...byWeapon.entries()].map(([id, mounts]) => ({
      id, name: WEAPONS[id].name, weapon: WEAPONS[id], mounts,
    }));
  }

  /**
   * What this mount should be shooting at.
   *
   * Ordnance first and always: a warhead is the only thing in the sky that can
   * open three compartments at once, and a director that is holding a hull when
   * one arrives has failed at the job it was fitted for. Only once nothing is
   * inbound does it look for a ship, and only inside the much shorter
   * `pdShipRange` — a repeater is a rounding error against a belt at four
   * kilometres and a real nuisance at one.
   *
   * Returns a shared descriptor rather than the thing itself, because the two
   * kinds of target answer the same three questions in different ways and the
   * laying code should not have to care which it got. It is scratch: valid
   * until the next call, which is exactly as long as anything needs it.
   */
  _pdThreat(mount) {
    const w = mount.weapon;
    const t = this._pdTarget;
    this.localToWorld(mount.origin, _o);
    _mnt.copy(mount.rest).applyQuaternion(this.body.quat);

    const inArc = (pos) => {
      _v2.copy(pos).sub(_o);
      const d = _v2.length();
      if (d < 1e-3) {
        return -1;
      }
      _v2.multiplyScalar(1 / d);
      // It has to be inside the traverse, or the gun would train to the stop
      // and fire into its own plating.
      return Math.acos(clamp(_v2.dot(_mnt), -1, 1)) > mount.def.arc ? -1 : d;
    };

    let best = null;
    // Range decides what is a candidate; the score only ranks the candidates.
    // Folding the doubling-up penalty into the range budget instead — which is
    // what this did first — meant the fourth director to look at a lone
    // torpedo scored it at 2700 m past where it actually was, decided it was
    // out of reach, and went off to shoot at the ship. A ring of eight engaged
    // with three and everything got through.
    let bestScore = Infinity;
    for (const m of this.game.ballistics.missiles) {
      if (m.armT > 0 || (m.owner && m.owner.faction === this.faction)) {
        continue;
      }
      const d = inArc(m.pos);
      if (d < 0 || d >= w.pdRange) {
        continue;
      }
      // A director tracks ONE thing. Every mount picking the nearest warhead
      // meant eight of them stacked on the leading torpedo of a salvo and the
      // rest of it arrived untouched — or, once the ring was fitted to every
      // hull, the leader died eight times over and a salvo of four died one at
      // a time with rounds to spare. Either way the number of mounts a ship
      // carried barely changed what got through, which is the one thing point
      // defence is supposed to decide.
      //
      // Doubling up costs `PD_DOUBLE_UP` metres of apparent range, so a second
      // director joins the same warhead only when the next one out is further
      // away than that. Salvos split the battery; a lone torpedo gets all of it.
      const score = d + (this._pdLoad.get(m) || 0) * PD_DOUBLE_UP;
      if (score >= bestScore) {
        continue;
      }
      best = m;
      bestScore = score;
    }
    if (best) {
      this._pdLoad.set(best, (this._pdLoad.get(best) || 0) + 1);
      t.pos = best.pos;
      t.vel = best.vel;
      // A torpedo is three metres across. The gun does not fire until it is
      // genuinely pointing at it.
      t.cone = 0.035;
      return t;
    }

    if (!w.pdShipRange) {
      return null;
    }
    let bestD = w.pdShipRange;
    for (const s of this.game.ships) {
      if (s === this || s.disposed || s.dead || s.faction === this.faction) {
        continue;
      }
      const d = inArc(s.position);
      if (d < 0 || d >= bestD) {
        continue;
      }
      best = s;
      bestD = d;
    }
    if (!best) {
      return null;
    }
    t.pos = best.position;
    t.vel = best.velocity;
    // A hull subtends real sky at these ranges, so the mount may open up as
    // soon as any part of it is under the gun rather than the exact centre.
    t.cone = 0.035 + best.hitRadius / Math.max(bestD, 1);
    return t;
  }

  /**
   * One point-defence mount, laying and firing itself. Runs instead of
   * `_aimMount` and instead of any trigger: with nothing inbound it tracks back
   * to its rest bearing and holds fire, which is also what stops it emptying a
   * magazine into empty space between engagements.
   */
  _pointDefence(mount, dt) {
    const w = mount.weapon;
    const mod = mount.mod;
    const live = mod.eff > 0.12 && !mod.destroyed && this.sys.hasData(mod);
    mount.cool = Math.max(0, mount.cool - dt);
    mod.duty = Math.max(0, (mod.duty || 0) - dt * 2.5);
    mount.firing = false;

    const threat = live ? this._pdThreat(mount) : null;
    if (!threat) {
      mount.aim.lerp(_v.copy(mount.rest).applyQuaternion(this.body.quat),
        1 - Math.exp(-6 * dt)).normalize();
      this._clampToMount(mount);
      return;
    }

    // Lead it. A torpedo runs at 620 m/s and the slug at 1900, so the lead is
    // large and getting it wrong means every round passes behind the warhead.
    this.localToWorld(mount.origin, _o);
    _v2.copy(threat.pos).sub(_o);
    _d.copy(threat.vel).sub(this.velocity);
    const t = interceptTime(_v2, _d, w.muzzleVel);
    if (t !== null && t < 4) {
      _v2.addScaledVector(_d, t);
    }
    _v2.normalize();
    const rest = _v.copy(mount.rest).applyQuaternion(this.body.quat);
    const dot = clamp(_v2.dot(rest), -1, 1);
    if (Math.acos(dot) > mount.def.arc) {
      _d.copy(_v2).addScaledVector(rest, -dot).normalize();
      _v2.copy(rest).multiplyScalar(Math.cos(mount.def.arc))
        .addScaledVector(_d, Math.sin(mount.def.arc));
    }
    // A director tracks faster than a crew lays a gun; that is what it is for.
    mount.aim.lerp(_v2, 1 - Math.exp(-7 * dt)).normalize();
    this._clampToMount(mount);

    if (mount.cool > 0 || !this._canDraw(w.draw)) {
      return;
    }
    // Only when it is genuinely pointing at the thing. The cone comes from the
    // threat — tight for a warhead, as wide as the hull for a ship — and the
    // ammunition check comes AFTER it, because `_takeAmmo` spends the round it
    // is asked about and a mount still slewing must not be billed for shots it
    // never took.
    _v2.copy(threat.pos).sub(_o).normalize();
    if (mount.aim.dot(_v2) < Math.cos(threat.cone) || !this._takeAmmo(mount)) {
      return;
    }
    this.sys.capStore = Math.max(0, this.sys.capStore - w.draw);
    mount.cool = w.interval / clamp(mod.eff, 0.25, 1);
    mod.heatAcc += shotHeatRate(w.heat, mount.scale, dt);
    mod.duty = 1;
    mount.firing = true;
    this._launch(mount, null);
  }

  // -- transforms ------------------------------------------------------------

  localToWorld(local, out = new THREE.Vector3()) {
    return out.copy(local).applyQuaternion(this.body.quat).add(this.body.pos);
  }

  /**
   * What the lull between waves is worth: a tender comes alongside.
   *
   * The wave gap already existed so the damage-control parties could achieve
   * something, but repair only ever gave back HEALTH. Three things are consumed
   * rather than damaged, and nothing anywhere put any of them back — so a run
   * decayed in one direction only, and a ship that lost both bunkers to a lucky
   * pair of hits was adrift for the rest of the game with a full crew, full
   * stores and nothing wrong with it.
   *
   * Propellant fills: a bunker is small (see FUEL_LEAK_RATE) and topping one up
   * alongside is an hour's work, not a refit. Hands and ammunition come back at
   * a fraction, because replacements are people a tender actually has to have
   * brought with it and a magazine is thousands of rounds struck down by hand.
   * A destroyed bunker or magazine gets nothing: there is no vessel there to
   * fill until the crew have rebuilt it.
   */
  resupply() {
    for (const m of this.sys.modules.values()) {
      if (m.destroyed) {
        continue;
      }
      if (m.kind === 'fuel') {
        m.store = m.def.store;
      } else if (m.kind === 'magazine') {
        m.rounds = Math.min(m.def.rounds, m.rounds + m.def.rounds * RESUPPLY_AMMO);
      }
    }
    const hands = this.crew ? this.crew.draft(RESUPPLY_CREW) : 0;
    return Math.round(hands);
  }

  /**
   * Where a named module actually is, in the world. The inverse of
   * `worldToHull`: module positions are authored relative to their compartment
   * and compartments relative to the raw hull frame, so both hops and the
   * centre-of-mass shift have to be undone before the body rotation goes on.
   *
   * This is the point anything aiming at a SUBSYSTEM needs — the targeting
   * computer and the enemy's fire control both — so it lives on the ship rather
   * than in either of them. Falls back to the hull centre for an id that is not
   * on this hull, so a caller holding a stale module can never aim at nothing.
   */
  modulePoint(moduleId, out = new THREE.Vector3()) {
    const def = this.hull.moduleById[moduleId];
    if (!def) {
      return out.copy(this.position);
    }
    const s = this.hull.sectionById[def.section];
    return out.set(
      s.pos[0] + def.pos[0] - this.hull.com[0],
      s.pos[1] + def.pos[1] - this.hull.com[1],
      s.pos[2] + def.pos[2] - this.hull.com[2],
    ).applyQuaternion(this.body.quat).add(this.position);
  }

  /**
   * World point into RAW hull-table coordinates — the frame the tables are
   * authored in and the frame the cutaway draws in, which is the body frame
   * shifted back by the centre of mass. Meshes are placed COM-relative so the
   * model pivots where the physics does, so this is the inverse of that plus
   * the shift back.
   */
  worldToHull(world, out = new THREE.Vector3()) {
    out.copy(world).sub(this.body.pos).applyQuaternion(_qi.copy(this.body.quat).invert());
    out.x += this.hull.com[0];
    out.y += this.hull.com[1];
    out.z += this.hull.com[2];
    return out;
  }

  /**
   * Opens a penetration trace and hands it back for the solver to append to as
   * the round walks through. Registered immediately rather than committed at
   * the end, because the walk has a dozen early returns — a round that stops in
   * the first bulkhead should still leave the mark that says so.
   */
  beginXray() {
    const path = { age: 0, nodes: [] };
    this.xray.push(path);
    if (this.xray.length > XRAY_MAX) {
      this.xray.shift();
    }
    return path;
  }

  /** Velocity of a point on the hull, including the spin. Guns inherit it. */
  pointVelocity(localOffset, out = new THREE.Vector3()) {
    _v.copy(this.body.omega).applyQuaternion(this.body.quat);
    out.copy(localOffset).applyQuaternion(this.body.quat).cross(_v).negate();
    return out.add(this.body.vel);
  }

  get position() {
    return this.body.pos;
  }

  get velocity() {
    return this.body.vel;
  }

  forward(out = new THREE.Vector3()) {
    return out.copy(FORWARD).applyQuaternion(this.body.quat);
  }

  // -- the analytic hit stack ------------------------------------------------

  /**
   * Appends every layer this ray crosses to `out`. Entries:
   *   { t, kind:'shield', facet }
   *   { t, kind:'wallIn'|'wallOut', section, cos, nx,ny,nz }
   *   { t, kind:'module', module, path }
   * `t` is distance along `dir` from `origin` in world units. The caller sorts.
   */
  gatherRayHits(origin, dir, maxT, out) {
    if (this.disposed) {
      return;
    }
    // Whole-ship broadphase against the shield bubble, which is always the
    // largest thing present.
    const reach = Math.max(this.hitRadius, this.shieldR);
    _v.copy(this.body.pos).sub(origin);
    const proj = _v.dot(dir);
    if (proj < -reach || proj > maxT + reach) {
      return;
    }
    if (_v.lengthSq() - proj * proj > reach * reach) {
      return;
    }

    // One transform into body space for the entire ship.
    _qi.copy(this.body.quat).invert();
    _o.copy(origin).sub(this.body.pos).applyQuaternion(_qi);
    _d.copy(dir).applyQuaternion(_qi);

    // --- shield ---------------------------------------------------------
    const sh = this.sys.shield;
    if (sh.up) {
      const r = this.shieldRadii;
      const hit = rayEllipsoid(_o.x, _o.y, _o.z, _d.x, _d.y, _d.z, r[0], r[1], r[2]);
      // Only a ray that crosses the boundary from OUTSIDE meets the bubble. A
      // muzzle already inside it is inside it, which is a real close-range
      // tactic rather than an oversight.
      if (hit && hit.t0 >= 0 && hit.t0 < maxT) {
        const t = hit.t0;
        // Which facet: the dominant axis of the impact point, normalised by the
        // bubble's own radii so an elongated shield still splits into sixths
        // that mean "the front", "the left" and so on.
        const px = (_o.x + _d.x * t) / r[0];
        const py = (_o.y + _d.y * t) / r[1];
        const pz = (_o.z + _d.z * t) / r[2];
        const ax = Math.abs(px);
        const ay = Math.abs(py);
        const az = Math.abs(pz);
        let axis = 0;
        let val = px;
        if (ay > ax && ay > az) {
          axis = 1;
          val = py;
        } else if (az > ax && az > ay) {
          axis = 2;
          val = pz;
        }
        const facet = FACET_BY_AXIS[axis][val >= 0 ? 0 : 1];
        if (!this.sys.shield.facets[facet].down) {
          out.push({ t, kind: 'shield', facet, ship: this });
        }
      }
    }

    // --- compartments and their contents --------------------------------
    for (const s of this.hull.sections) {
      const bx = _o.x - s.pos[0];
      const by = _o.y - s.pos[1];
      const bz = _o.z - s.pos[2];
      // Per-section broadphase before the slab test.
      const rr = this._secR.get(s.id);
      const pp = -(bx * _d.x + by * _d.y + bz * _d.z);
      if (pp < -rr || pp > maxT + rr) {
        continue;
      }
      if ((bx * bx + by * by + bz * bz) - pp * pp > rr * rr) {
        continue;
      }

      const shell = rayBox(bx, by, bz, _d.x, _d.y, _d.z, s.half[0], s.half[1], s.half[2]);
      if (!shell || shell.t1 <= 0 || shell.t0 >= maxT) {
        continue;
      }
      const inT = Math.max(shell.t0, 0);
      const outT = Math.min(shell.t1, maxT);

      // Face obliquity: the entry face normal is a body axis, so its cosine is
      // just that component of the local direction. Free, and it is what turns
      // "which side you attacked from" into a ballistic variable.
      const kIn = AXIS_KEY[shell.axis0];
      _n.set(0, 0, 0);
      _n[kIn] = _d[kIn] > 0 ? -1 : 1;
      _n.applyQuaternion(this.body.quat);
      if (shell.t0 >= 0) {
        out.push({
          t: inT, kind: 'wallIn', section: s.id, ship: this,
          cos: Math.abs(_d[kIn]), nx: _n.x, ny: _n.y, nz: _n.z,
        });
      }

      for (const def of this.hull.modulesBySection[s.id]) {
        const m = this.sys.get(def.id);
        if (!m || m.destroyed) {
          continue;
        }
        let hit;
        if (def.shape === 'sphere') {
          hit = raySphere(bx, by, bz, _d.x, _d.y, _d.z,
            def.pos[0], def.pos[1], def.pos[2], def.r);
        } else {
          hit = rayBox(
            bx - def.pos[0], by - def.pos[1], bz - def.pos[2],
            _d.x, _d.y, _d.z, def.half[0], def.half[1], def.half[2],
          );
        }
        if (!hit) {
          continue;
        }
        // Clip the module's span to the compartment's: a module can only be
        // struck through the walls that contain it.
        const a = Math.max(hit.t0, inT);
        const b = Math.min(hit.t1, outT);
        if (b <= a) {
          continue;
        }
        out.push({ t: a, kind: 'module', module: m, ship: this, path: b - a, section: s.id });
      }

      if (shell.t1 < maxT) {
        // The exit face carries a normal too. It costs one axis lookup and it
        // is what lets a through-and-through punch a visible hole where the
        // round CAME OUT, which is the whole point of a kinetic penetrator.
        const kOut = AXIS_KEY[shell.axis1];
        _n.set(0, 0, 0);
        _n[kOut] = _d[kOut] > 0 ? 1 : -1;
        _n.applyQuaternion(this.body.quat);
        out.push({
          t: outT, kind: 'wallOut', section: s.id, ship: this,
          cos: Math.abs(_d[kOut]), nx: _n.x, ny: _n.y, nz: _n.z,
        });
      }
    }
  }

  /**
   * Which shield facet faces `worldDir` (a direction pointing AT the ship from
   * the threat). Used by blasts, which arrive from a bearing rather than along
   * a ray that can be tested against the bubble.
   *
   * Reads FACET_BY_AXIS, the same table the ray path uses. It used to open-code
   * a second copy of the sign convention and got the X pair backwards — +X is
   * PORT, and this returned 'stbd' for it. The two paths then disagreed about
   * the same bearing: a warhead off the port beam drained the STARBOARD facet
   * and left the one that actually took it at full charge, while a ray strike
   * from that identical bearing charged port correctly. One table, one answer,
   * and the disagreement is now structurally impossible rather than merely
   * fixed.
   */
  faceFor(worldDir) {
    _v.copy(worldDir).applyQuaternion(_qi.copy(this.body.quat).invert());
    const r = this.shieldRadii;
    const x = Math.abs(_v.x / r[0]);
    const y = Math.abs(_v.y / r[1]);
    const z = Math.abs(_v.z / r[2]);
    let axis = 0;
    let val = _v.x;
    if (y > x && y > z) {
      axis = 1;
      val = _v.y;
    } else if (z > x) {
      axis = 2;
      val = _v.z;
    }
    return FACET_BY_AXIS[axis][val >= 0 ? 0 : 1];
  }

  /**
   * Cost in joules of crossing one compartment wall at this obliquity. A wall
   * that has already been shot through is cheaper — the hole is there — so
   * sustained fire genuinely opens a compartment rather than paying full price
   * for every round.
   */
  wallCost(sectionId, cos, ap) {
    const def = this.hull.sectionById[sectionId];
    const s = this.sys.section(sectionId);
    const mat = MATERIALS[def.armor];
    const intact = s ? clamp01(s.plateHp / s.plateMax) : 1;
    const slope = 1 / Math.max(cos, 0.16);
    return def.wall * mat.resist * slope * ap * (0.22 + 0.78 * intact);
  }

  // -- damage ----------------------------------------------------------------

  applyImpulseAt(worldPoint, dirUnit, magnitude) {
    this.body.applyImpulseAt(worldPoint, dirUnit, magnitude);
    // What the hull actually FELT, in m/s of delta-v, accumulated for the
    // camera to read. This is the honest quantity: a 40 MJ slug carries about
    // 31 kNs, which on a 45,000 t cruiser is 0.0007 m/s — imperceptible, and it
    // should be imperceptible. The same round into a picket is ten times that,
    // and a magazine letting go inside your own hull is in another league
    // entirely. Nothing here is tuned per ship; the mass does the work.
    this.jolt += magnitude * this.body.invMass;
  }

  /** Delta-v taken since the last read, in m/s. Reading it clears it. */
  consumeJolt() {
    const j = this.jolt;
    this.jolt = 0;
    return j;
  }

  /**
   * Put a mark on the plating at a world point. The caller works in world
   * space; the decal sheet lives in the hull's frame, so the conversion belongs
   * here — this is the only place that knows the transform.
   */
  mark(worldPoint, worldNormal, opts) {
    if (!this.decals || this.disposed) {
      return;
    }
    _mq.copy(this.body.quat).invert();
    _mp.copy(worldPoint).sub(this.body.pos).applyQuaternion(_mq);
    _mn.copy(worldNormal).applyQuaternion(_mq);
    this._seatOnSkin(_mp, _mn);
    this.decals.add(_mp, _mn, opts);
    if (opts.hole && opts.section) {
      // Remember it. A hole is a permanent fact about the hull until the crew
      // weld it, and it is where the compartment behind it vents from and
      // where a fire in there shows itself. The ring is small on purpose: a
      // ship with thirty-two live wounds is already venting from everywhere.
      this.holes.push({ p: _mp.clone(), n: _mn.clone(), section: opts.section });
      if (this.holes.length > MAX_HOLES) {
        this.holes.shift();
      }
    }
  }

  // -- save and restore --------------------------------------------------------

  /**
   * The whole ship as plain data: where it is, what is broken, what is left in
   * the lockers and who is still alive.
   *
   * Composed rather than centralised — the body, the systems and the crew each
   * capture themselves, because each of them is the only thing that knows what
   * its own state is. A snapshot taken here has no idea a coolant loop has a
   * temperature, and it should not have to.
   *
   * Nothing about the RENDERING is in it. Decals, scorched plating and the
   * penetration traces are a record of damage rather than the damage itself,
   * and a restored ship is built fresh, so it wears clean paint over an
   * honestly wrecked interior. That is a deliberate trade: the alternative is
   * serialising a decal ring to make the outside of the hull agree with a
   * history that no longer happened.
   */
  snapshot() {
    return {
      hullId: this.hull.id,
      body: this.body.snapshot(),
      sys: this.sys.snapshot(),
      crew: this.crew.snapshot(),
      ammo: this.ammo,
      dead: this.dead,
      derelict: this.derelict,
      derelictT: this.derelictT,
      adriftT: this.adriftT || 0,
      scored: this.scored,
    };
  }

  restore(snap) {
    if (!snap) {
      return;
    }
    this.body.restore(snap.body);
    this.sys.restore(snap.sys);
    this.crew.restore(snap.crew);
    this.ammo = snap.ammo;
    this.dead = snap.dead;
    this.deadT = 0;
    this.derelict = snap.derelict;
    this.derelictT = snap.derelictT;
    this.adriftT = snap.adriftT;
    this.scored = snap.scored;
    this.jolt = 0;
    this.holes.length = 0;
    this.xray.length = 0;
    this._updateSignature();
    this._syncVisual(0);
  }

  /**
   * How bright this hull is in the infrared, in units that only have to be
   * comparable between ships. Read by seeker heads; see `Ballistics._acquire`.
   *
   * Everything in it is a real fact about the ship's state, which is what makes
   * the weapon interesting: cutting the throttle genuinely dims you, running
   * the drives hard genuinely lights you up, and a hull already on fire cannot
   * hide at all. Recomputed once a tick, not once per missile per frame.
   */
  heatSignature() {
    return this._ir;
  }

  _updateSignature() {
    const area = this.hitRadius * this.hitRadius;
    // A crewed hull is never cold: it is radiating its own hotel load.
    let s = 0.12;
    s += clamp01(Math.abs(this.autopilot.cmd.throttle)) * 1.6;
    if (this.autopilot.boostT > 0) {
      s += 1.4;
    }
    for (const m of this.sys.modules.values()) {
      if (m.kind === 'reactor' && !m.destroyed) {
        s += 0.55 * clamp01(m.duty || 0);
      }
    }
    for (const sec of this.sys.sections.values()) {
      if (sec.fire > 0) {
        s += 0.6;
      } else if (sec.breached) {
        s += 0.05;
      }
    }
    this._ir = area * s;
  }

  /**
   * Slide a hit from the compartment box onto the plating you can actually see.
   *
   * The ray was tested against the box, because the box is what the damage
   * model is made of. The shell is inscribed in that box and tapers, so the two
   * disagree by the better part of a metre down the flanks and by several at a
   * bow — and a scorch mark left at the box face hovers off the hull, which is
   * exactly the sort of thing that reads as broken from the cockpit.
   *
   * Only the lateral faces need it; the fore and aft faces are not tapered.
   */
  _seatOnSkin(p, n) {
    let axis = 0;
    let mag = Math.abs(n.x);
    if (Math.abs(n.y) > mag) {
      axis = 1;
      mag = Math.abs(n.y);
    }
    if (Math.abs(n.z) > mag) {
      return;
    }
    const com = this.hull.com;
    let best = null;
    let bestGap = Infinity;
    for (const s of this.hull.sections) {
      // Chebyshev distance to the box: 0 or less means inside it.
      const gap = Math.max(
        Math.abs(p.x - (s.pos[0] - com[0])) - s.half[0],
        Math.abs(p.y - (s.pos[1] - com[1])) - s.half[1],
        Math.abs(p.z - (s.pos[2] - com[2])) - s.half[2],
      );
      if (gap < bestGap) {
        bestGap = gap;
        best = s;
      }
    }
    if (!best || bestGap > 1.5) {
      return;
    }
    const centre = best.pos[axis] - com[axis];
    const off = p.getComponent(axis) - centre;
    const sign = Math.sign(off || 1);
    const f = skinFraction(
      best.style, axis, sign, p.z - (best.pos[2] - com[2]), best.half[2]);
    p.setComponent(axis, centre + sign * best.half[axis] * f);
  }

  /** Darkens a compartment's plating where it has been hit. */
  scorch(sectionId, amount) {
    const mesh = this.sectionMeshes.get(sectionId);
    if (!mesh) {
      return;
    }
    const mat = mesh.material;
    const a = clamp01(amount);
    mat.color.lerp(this.game.assets.scorchColor, a * 0.4);
    mat.roughness = clamp(mat.roughness + a * 0.15, 0.35, 1);
  }

  // -- weapons ---------------------------------------------------------------

  /**
   * Where a mount is pointing this tick.
   *
   * Three cases, and the middle one was missing. A mount with a fire-control
   * link and a target leads it. A mount with a link and NO target lays on the
   * boresight — the reticle — because that is where the ship is asking it to
   * shoot. Only a mount that has lost its link (or cannot slew at all) falls
   * back to the bearing the tables bolted it down at, which is what "the gun
   * still works but nothing is telling it where to shoot" should look like.
   *
   * Reverting to the rest bearing whenever nothing was locked is what made
   * half the arsenal feel broken: the MERIDIAN's lances sit five degrees out
   * to port and starboard, the broadsides twelve, the point defence forty, so
   * with no lock the reticle described exactly one gun on the ship and every
   * other mount threw its rounds off into open space at an angle. The mounts
   * could always traverse; nothing was ever asking them to.
   */
  _aimMount(mount, target, dt, aimAt) {
    const rest = _v.copy(mount.rest).applyQuaternion(this.body.quat);
    const laid = mount.traverses && this.sys.hasData(mount.mod);
    if (!laid) {
      mount.want.copy(rest);
      mount.aim.lerp(rest, 1 - Math.exp(-6 * dt)).normalize();
      this._clampToMount(mount);
      return;
    }
    const w = mount.weapon;
    if (!target) {
      // No lock: converge on where the nose is pointing. The mounts are metres
      // apart on a hull kilometres from anything, so parallel bearings and a
      // convergence point are the same answer.
      this.forward(_v2);
    } else {
      this.localToWorld(mount.origin, _o);
      // The aim point, not the target's origin. Every gun in the game used to
      // lay on `target.position` — the centre of mass — so a whole wave
      // converged on one compartment and the player spent every lull welding
      // the same engineering deck, while the targeting computer's subsystem
      // selection moved the HUD pip and nothing else. `aimAt` is where fire
      // control has actually been told to put the rounds; the hull centre is
      // only the default.
      _v2.copy(aimAt || target.position).sub(_o);
      if (w.muzzleVel) {
        _d.copy(target.velocity).sub(this.velocity);
        const t = interceptTime(_v2, _d, w.muzzleVel);
        if (t !== null && t < 6) {
          _v2.addScaledVector(_d, t);
        }
      }
      _v2.normalize();
    }

    // Lay error. The gun is only as good as the people laying it, and until now
    // it was not: the hull tables, the README and the crew model all say an
    // empty gunnery station costs turret quality, but the aiming code read
    // nothing but module health, so a ship whose gunners were all dead shot
    // exactly as well as one with a full complement.
    //
    // This is the loop that was missing from the fight. Enemy fire is relentless
    // because nothing the player does to a hull makes it shoot worse — killing
    // its crew, venting its gunnery decks and cutting its fire-control all left
    // the incoming stream untouched. Now they degrade it, which is both the
    // documented behaviour and the thing that makes a long engagement wind down
    // instead of grinding on at full intensity to the last second.
    const hands = this.crew ? this.crew.station('gunner') : 1;
    if (hands < 0.995) {
      // A slow wander rather than jitter: a mis-laid gun is consistently off,
      // and drifts as the crew re-lay it. Phase is per-mount so a broadside
      // does not err in unison.
      // Superlinear: a battery that has taken a few casualties shoots very
      // nearly as well, and one that has been gutted shoots badly. A straight
      // proportion made losing half a gun crew almost disarm a ship, which
      // turned every fight into a race to kill gunners.
      const slop = MAX_LAY_ERROR * (1 - hands) ** 1.6;
      const ph = this.game.simTime * 0.4 + mount.phase;
      _lay.set(Math.sin(ph), Math.cos(ph * 1.31), 0).applyQuaternion(this.body.quat);
      _v2.addScaledVector(_lay, Math.sin(ph * 0.67) * slop).normalize();
    }

    // What fire control asked for, before the traverse limit has its say. The
    // gap between this and where the gun ends up pointing is the whole question
    // of whether it is worth pulling the trigger — see `_bears`.
    mount.want.copy(_v2);
    // Clamp the demand into the mount's traverse arc about its rest bearing.
    const dot = clamp(_v2.dot(rest), -1, 1);
    const arc = mount.def.arc;
    if (Math.acos(dot) > arc) {
      // Rotate `rest` toward the demand by exactly `arc`.
      _d.copy(_v2).addScaledVector(rest, -dot).normalize();
      _v2.copy(rest).multiplyScalar(Math.cos(arc)).addScaledVector(_d, Math.sin(arc));
    }
    // Traverse is not instant. A damaged mount slews slower, and so does one
    // being cranked round by half a gun crew.
    const rate = 2.6 * (0.35 + 0.65 * mount.mod.eff) * (0.4 + 0.6 * hands);
    mount.aim.lerp(_v2, 1 - Math.exp(-rate * dt)).normalize();
    this._clampToMount(mount);
  }

  /**
   * Hold a mount above the plating it is bolted to. See `MOUNT_DEPRESSION`.
   *
   * Applied to `aim` after the slew rather than to the demand before it, so the
   * invariant holds every frame and not merely at the ends of the motion —
   * normalising the interpolation between two legal bearings can dip a couple of
   * degrees below both of them, which is exactly long enough to see.
   */
  _clampToMount(mount) {
    if (!mount.up) {
      return;
    }
    _mnt.copy(mount.up).applyQuaternion(this.body.quat);
    const floor = -Math.sin(MOUNT_DEPRESSION);
    const elev = mount.aim.dot(_mnt);
    if (elev >= floor) {
      return;
    }
    // Lift the bearing onto the lowest cone the mount can make, keeping its
    // train: the gun stops at the deck rather than being swung off the target.
    // Cannot degenerate: the deepest mount in the roster bottoms out at -30
    // degrees (rest elevation minus arc), nowhere near straight down the axis.
    _mntT.copy(mount.aim).addScaledVector(_mnt, -elev).normalize();
    mount.aim.copy(_mnt).multiplyScalar(floor)
      .addScaledVector(_mntT, Math.sqrt(1 - floor * floor)).normalize();
  }

  /**
   * Where the round actually leaves the ship: the tip of the barrel that is
   * about to fire, not the middle of the compartment behind it.
   *
   * Solved from `mount.aim` rather than read off the rig's world matrix, and
   * that is deliberate. The rig is posed in `_syncVisual`, which runs after
   * gunnery, so reading its matrix would fire from where the gun was pointing
   * last frame and would put the very first shot of a ship's life at the world
   * origin. The barrel is welded to `aim` by construction, so composing the
   * same vector gives the same answer a frame earlier and cannot desync.
   */
  _muzzleWorld(mount, out) {
    const rig = mount.rig;
    if (!rig) {
      return this.localToWorld(mount.origin, out);
    }
    const s = mount.scale * this.gunScale;
    const m = rig.muzzles[mount.barrel % rig.muzzles.length];
    // The trunnion, in world: out to the plating, then up to the pivot.
    this.localToWorld(_mz.copy(mount.surface).addScaledVector(mount.up, rig.pivot * s), out);
    // A frame about the bore, to place a barrel that is not on the axis.
    _mzUp.copy(mount.up).applyQuaternion(this.body.quat);
    _mzR.copy(_mzUp).cross(mount.aim);
    if (_mzR.lengthSq() < 1e-8) {
      _mzR.set(1, 0, 0).cross(mount.aim);
    }
    _mzR.normalize();
    _mzU.copy(mount.aim).cross(_mzR);
    return out
      .addScaledVector(mount.aim, m[2] * s)
      .addScaledVector(_mzR, m[0] * s)
      .addScaledVector(_mzU, m[1] * s);
  }

  /**
   * Why a mount is not going to shoot, or null if it is ready.
   *
   * One place that answers the question, because the reasons a gun is silent
   * are spread across four different systems — the module is wrecked, its bus
   * is dead, its coolant loop tripped it, its magazine is empty, its
   * fire-control run has been cut, or it simply has not finished cycling. From
   * the cockpit those are indistinguishable without being told, and "why is
   * nothing happening when I hold the trigger" is not a puzzle worth setting.
   */
  mountFault(mount) {
    const mod = mount.mod;
    if (mod.destroyed) {
      return 'WRECKED';
    }
    if (mod.tripped) {
      return 'OVERHEAT';
    }
    if (mod.eff <= 0.12) {
      return 'NO POWER';
    }
    if (!this.sys.hasData(mod)) {
      return 'NO LINK';
    }
    const need = mount.weapon.ammo;
    if (need) {
      const mag = this.sys.get(mount.def.feed);
      if (!mag || mag.destroyed || mag.rounds < need) {
        return 'NO AMMO';
      }
    }
    if (!this._canDraw(mount.weapon.draw)) {
      return 'NO CHARGE';
    }
    if (mount.cool > 0) {
      return 'CYCLING';
    }
    return null;
  }

  /**
   * Is this mount actually laid on the firing solution?
   *
   * Compares where the gun IS to where fire control asked it to be, which is
   * the only comparison that works in every case: a mount clamped at its
   * traverse stop can never reach the demand, and one still slewing has not got
   * there yet. Both were firing anyway.
   *
   * Comparing against the target's position instead would be wrong — a gun
   * correctly leading a crossing target is deliberately not pointing at it.
   *
   * The cone widens with how much sky the target subtends, so a dreadnought at
   * knife range does not demand the same precision as a picket at eight
   * kilometres.
   */
  _bears(mount, target) {
    if (mount.aim.dot(mount.want) > BEAR_COS) {
      return true;
    }
    if (!target) {
      return false;
    }
    // Close in, a hull is wide enough that a partly-trained gun still hits it.
    this.localToWorld(mount.origin, _o);
    const dist = Math.max(target.position.distanceTo(_o), 1);
    return mount.aim.dot(mount.want) > Math.cos(BEAR_TOL + target.hitRadius / dist);
  }

  /** True if this mount is pointing close enough to be worth firing. */
  onTarget(mount, target, tolerance = 0.045) {
    if (!target) {
      return true;
    }
    this.localToWorld(mount.origin, _o);
    _v2.copy(target.position).sub(_o);
    const dist = _v2.length();
    if (dist < 1e-3) {
      return true;
    }
    _v2.multiplyScalar(1 / dist);
    // Allow a wider cone at close range, where the ship subtends more sky.
    const slack = tolerance + target.hitRadius / Math.max(dist, 1);
    return mount.aim.dot(_v2) > Math.cos(slack);
  }

  /**
   * Advances every mount, and fires the ones `shouldFire` selects. Taking a
   * predicate rather than a pair of triggers is what lets the player bind two
   * arbitrary weapons to the two mouse buttons while the AI keeps thinking in
   * fixed-versus-turret terms — both drive identical gunnery code.
   */
  updateWeapons(dt, target, shouldFire, aimAt = null) {
    const ball = this.game.ballistics;
    // Fresh every tick: which warheads the directors have already taken.
    this._pdLoad.clear();
    {
      for (const mount of this.mounts) {
        // Point defence answers to nothing but the ordnance in the sky.
        if (mount.weapon.pointDefence) {
          this._pointDefence(mount, dt);
          continue;
        }
        const held = shouldFire(mount);
        this._aimMount(mount, target, dt, aimAt);
        const w = mount.weapon;
        const mod = mount.mod;
        const live = mod.eff > 0.12 && !mod.destroyed;
        mount.cool = Math.max(0, mount.cool - dt);

        // Duty drives both the thermal model and the electrical draw: a gun
        // that is not cycling is hotel load, not a 2.6 MW appliance.
        mod.duty = Math.max(0, (mod.duty || 0) - dt * 2.5);

        // A gun that cannot bear holds fire. This is the difference between
        // squeezing the trigger and wasting the magazine.
        mount.bears = this._bears(mount, target);
        if (w.kind === 'beam') {
          const want = held && live && mount.bears && this._canDraw(w.draw * dt);
          mount.firing = want;
          if (want) {
            mod.duty = 1;
            this._muzzleWorld(mount, _o);
            ball.fireBeam(this, mount, _o, mount.aim, dt);
            this.sys.capStore = Math.max(0, this.sys.capStore - w.draw * dt);
            mod.heatAcc += w.heat * mount.scale;
            // A lance is a continuous event, so it needs a continuous sound —
            // re-struck often enough to overlap into one. A weapon that pours
            // twelve megawatts into a hull and makes no noise at all reads as
            // broken, and until now this one did.
            mount.sndT = (mount.sndT || 0) - dt;
            if (mount.sndT <= 0) {
              mount.sndT = 0.11;
              this.game.audio.fire('beam', _o, mount.scale);
            }
          }
          continue;
        }

        mount.firing = false;
        if (!canFireMount({
          held,
          live,
          bears: mount.bears,
          cooling: mount.cool > 0,
          charged: this._canDraw(w.draw),
        })) {
          continue;
        }
        if (!this._takeAmmo(mount)) {
          continue;
        }
        this.sys.capStore = Math.max(0, this.sys.capStore - w.draw);
        // A derated mount cycles slower — the loader is on the same bus.
        mount.cool = w.interval / clamp(mod.eff, 0.25, 1);
        mod.heatAcc += shotHeatRate(w.heat, mount.scale, dt);
        mod.duty = 1;
        mount.firing = true;
        this._launch(mount, target);
      }
    }
  }

  _canDraw(energyMJ) {
    return this.sys.capStore >= energyMJ || this.sys.supply > 0.5;
  }

  _takeAmmo(mount) {
    const need = mount.weapon.ammo;
    if (!need) {
      return true;
    }
    const mag = this.sys.get(mount.def.feed);
    if (!mag || mag.destroyed || mag.rounds < need) {
      return false;
    }
    mag.rounds -= need;
    return true;
  }

  _launch(mount, target) {
    const w = mount.weapon;
    this._muzzleWorld(mount, _o);
    // Multi-barrel mounts alternate, so a repeater's two tubes and a torpedo
    // battery's four tubes each fire in turn instead of all from one hole.
    mount.barrel++;
    mount.kick = 1;
    // Guns inherit the ship's motion, including the part contributed by spin.
    this.pointVelocity(mount.origin, _v2);
    // Only magazine-fed guns have a choice of round; a laser fires light.
    const ammo = w.ammo && mount.def.feed ? AMMO[this.ammo] : null;
    if (w.kind === 'missile') {
      this.game.ballistics.spawnMissile(this, _o, mount.aim, _v2, w, target);
    } else {
      this.game.ballistics.spawnBolt(this, _o, mount.aim, _v2, w, ammo);
    }
    this.game.fx.muzzle(_o, mount.aim, ammo ? ammo.tracer : w.tracer, mount.scale);
    this.game.audio.fire(w.id, _o, mount.scale);
  }

  /** True if anything aboard actually feeds from a magazine. */
  get usesAmmo() {
    return this.mounts.some((m) => m.weapon.ammo && m.def.feed);
  }

  // -- per-tick --------------------------------------------------------------

  update(dt) {
    for (let i = this.xray.length - 1; i >= 0; i--) {
      this.xray[i].age += dt;
      if (this.xray[i].age > XRAY_FADE) {
        this.xray.splice(i, 1);
      }
    }
    this.sys.tick(dt);
    this.crew.tick(dt);
    this._updateSignature();
    this._drainSystemEvents();
    this.autopilot.update(this.body, dt);
    this.body.integrate(dt);
    this._syncVisual(dt);
    if (this.decals) {
      this.decals.update(dt, this.sys);
    }
  }

  /**
   * Systems raises events; this is where they become sound, particles and
   * casualties. Keeping the translation in one place means the sim never has to
   * know that a renderer exists.
   */
  _drainSystemEvents() {
    const fx = this.game.fx;
    for (const e of this.sys.drainEvents()) {
      switch (e.type) {
        case 'cookoff': {
          const at = this.sectionWorld(e.section, _v);
          // A magazine going up blows the compartment open from inside, so the
          // pieces of it leave the ship rather than staying in the room.
          fx.explosion(at, 9 + Math.min(18, e.energy / 6e5), 0xffb060,
            { vel: this.body.vel, heavy: true });
          this.crew.killIn(e.section, 2);
          this.game.audio.boom(at, 1);
          // Through Ship, not Body: a magazine going off inside your own hull
          // is precisely the event the camera should register, and routing it
          // past the wrapper is how it would silently fail to.
          this.applyImpulseAt(at, this.forward(_v2), e.energy * 1e-4);
          break;
        }
        case 'detonate': {
          // The containment failed. This is the largest single event either
          // side of a fight can cause, and it should look and sound like the
          // end of the ship rather than like one more secondary.
          fx.reactorBlast(this.body.pos, this.body.vel, this.hull.radius * 0.55);
          this.game.audio.reactor(this.body.pos, 1.6);
          this.game.onShipDestroyed(this, 'reactor');
          break;
        }
        case 'quartersKill':
          this.crew.killIn(e.section, 2);
          break;
        case 'vent':
          this.crew.killIn(e.section, 0.55);
          break;
        case 'breach':
          this.game.audio.impact('breach', e.at || this.body.pos, 1);
          break;
        case 'facetDown':
          if (this.isPlayer) {
            this.game.hud.warn(`${e.facet.toUpperCase()} SHIELD DOWN`);
          }
          break;
        case 'computerThermal':
          if (this.isPlayer) {
            this.game.hud.warn(`${e.module.label} COOKED — DAMAGE CONTROL`);
          }
          break;
        case 'computerReset':
          if (this.isPlayer) {
            this.game.hud.warn(`${e.module.label} REBOOTED`);
          }
          break;
        case 'trip':
          if (this.isPlayer) {
            this.game.hud.warn(`${e.module.label} THERMAL TRIP`);
          }
          break;
        case 'ignite':
          if (this.isPlayer) {
            this.game.hud.warn(`FIRE — ${this.hull.sectionById[e.section].label}`);
          }
          break;
        default:
          break;
      }
    }
    for (const e of this.crew.drainEvents()) {
      if (e.type === 'crewLost' && this.isPlayer) {
        this.game.hud.warn(`${e.member.name} LOST (${e.cause.toUpperCase()})`);
      }
    }
  }

  /** World position of a compartment's centre — used by FX and the crew view. */
  sectionWorld(sectionId, out = new THREE.Vector3()) {
    const s = this.hull.sectionById[sectionId];
    if (!s) {
      return out.copy(this.body.pos);
    }
    return out.set(
      s.pos[0] - this.hull.com[0],
      s.pos[1] - this.hull.com[1],
      s.pos[2] - this.hull.com[2],
    ).applyQuaternion(this.body.quat).add(this.body.pos);
  }

  /**
   * Pose every mount. The gunnery model has already decided where each gun
   * points; this only decomposes that one world vector into the two angles the
   * machine can actually make — train about the hull normal, elevate about the
   * trunnions — so the barrel you can see is the barrel the solver is using.
   */
  _syncMounts(dt) {
    _qi.copy(this.body.quat).invert();
    for (const mount of this.mounts) {
      const rig = mount.rig;
      if (!rig) {
        continue;
      }
      const mod = mount.mod;
      const dead = !mod || mod.destroyed;
      if (rig.slews) {
        if (dead) {
          // A wrecked mount stops training and the barrel drops. It is the
          // clearest read there is that a battery is off the board, and it is
          // visible from further out than any damage decal.
          rig.pitch.rotation.x += (0.42 - rig.pitch.rotation.x) * (1 - Math.exp(-2 * dt));
        } else {
          // Into the mount's own frame: out of world, into the body, into the
          // base plate. What is left is train and elevation.
          _v.copy(mount.aim).applyQuaternion(_qi).applyQuaternion(mount.invQuat);
          rig.yaw.rotation.y = Math.atan2(_v.x, _v.z);
          rig.pitch.rotation.x = Math.atan2(-_v.y, Math.hypot(_v.x, _v.z));
        }
      }
      mount.kick = Math.max(0, mount.kick - dt * RECOIL_RETURN);
      rig.gun.position.z = -mount.kick * RECOIL_TRAVEL;
      if (rig.glow) {
        const live = dead ? 0 : mod.eff;
        // Idles warm when the mount has power, goes white on the shot.
        rig.glow.material.emissiveIntensity =
          live * (0.35 + 4.0 * (mount.firing ? 1 : mount.kick));
      }
    }
  }

  _syncVisual(dt) {
    this.group.position.copy(this.body.pos);
    this.group.quaternion.copy(this.body.quat);
    this._syncMounts(dt);

    const duty = clamp01(Math.abs(this.autopilot.cmd.throttle))
      * (this.autopilot.boostT > 0 ? 1.7 : 1);
    for (const g of this.driveGlows) {
      const m = this.sys.get(g.id);
      const live = m && !m.destroyed ? m.eff : 0;
      const s = g.base * (0.35 + 1.5 * duty) * live;
      g.sprite.scale.setScalar(Math.max(0.001, s));
      g.sprite.material.opacity = 0.25 + 0.75 * clamp01(duty) * live;
      g.sprite.visible = live > 0.02;
    }
    // Strobe: pulses while the ship has power, dark when the lights go out.
    const lit = this.sys.supply > 0.2
      ? clamp01(0.45 + Math.sin(performance.now() * 0.004 + this.id) * 0.4)
      : 0;
    this.beacon.material.opacity = lit * 0.7;
    this.beacon.visible = lit > 0.02;

    // Shield bubble: impact flares decay, and the whole field brightens with
    // how much charge is up and reddens with how saturated the emitters are.
    if (this.shieldMesh) {
      let anyHit = false;
      for (const h of this._shieldHits) {
        if (h.w > 0) {
          h.w = Math.max(0, h.w - dt * 1.7);
          anyHit = anyHit || h.w > 0;
        }
      }
      let charge = 0;
      let load = 0;
      let n = 0;
      for (const f of Object.values(this.sys.shield.facets)) {
        charge += f.max > 0 ? f.charge / f.max : 0;
        load += f.loadMax > 0 ? f.load / f.loadMax : 0;
        n++;
      }
      const u = this.shieldMesh.material.uniforms;
      u.uCharge.value = n > 0 ? charge / n : 0;
      u.uLoad.value = n > 0 ? load / n : 0;
      // Nothing to draw when the field is down and nothing is striking it.
      this.shieldMesh.visible = this.sys.shield.up && (u.uCharge.value > 0.02 || anyHit);
    }

    this._damageFx(dt);
  }

  /**
   * What the ship looks like from outside when it is hurt.
   *
   * Both effects come out of the actual wounds. A compartment does not vent
   * from a point hovering in the middle of the room and a fire aboard is not a
   * candle — it is a bay full of burning stores with a hole in the side of it,
   * so what is visible from a kilometre away is a jet coming out of that hole,
   * dragged flat by the ship's own motion.
   *
   * Venting is driven off the HOLE being open rather than off the air being
   * left, and runs until the crew weld it shut. The plume thins as the
   * atmosphere goes and then runs on: what is coming out of a hull breach after
   * the first minute is sublimating coolant, fuel vapour and stores outgassing
   * into vacuum, and it does not stop because the compartment reached zero.
   * "The hole stopped smoking so it must be fixed" would be a lie the ship
   * tells the player about its own condition.
   */
  _damageFx(dt) {
    const fx = this.game.fx;
    for (const s of this.sys.sections.values()) {
      const burning = s.fire > 0;
      const open = s.breachSize > 0 || s.venting;
      if (!burning && !open) {
        continue;
      }
      if (burning) {
        // Rate follows how hard it is burning, so a bay that has nearly run out
        // of fuel guts rather than roars.
        const power = clamp01(s.fire / 4) * (0.35 + 0.65 * clamp01(s.atmo / 0.4));
        if (Math.random() < (6 + 14 * power) * dt) {
          this._woundPoint(s.id, _v, _n);
          fx.fireLick(_v, _n, this.body.vel, power);
        }
      }
      if (open && Math.random() < 6 * dt) {
        // Full-throated while there is air behind it, a thin persistent wisp
        // once there is not.
        const strength = s.venting ? 1.7 : (0.30 + 1.1 * clamp01(s.atmo));
        this._woundPoint(s.id, _v, _n);
        fx.ventJet(_v, _n, this.body.vel, strength);
      }
    }
  }

  /**
   * A point on this compartment's skin for damage effects to come out of, in
   * world space, with the outward normal. Prefers a hole the ship actually has;
   * falls back to a random point on the compartment's own surface, because a
   * compartment can be open to space through its frame without any one round
   * having left a decal anybody kept.
   */
  _woundPoint(sectionId, outP, outN) {
    if (this.holes.length > 0) {
      // Linear scan. The ring is 32 long and this runs a few times a second per
      // burning compartment, so an index would cost more to maintain than it
      // saves.
      let n = 0;
      let pick = null;
      for (const h of this.holes) {
        if (h.section === sectionId && Math.random() < 1 / ++n) {
          pick = h;
        }
      }
      if (pick) {
        this.localToWorld(pick.p, outP);
        outN.copy(pick.n).applyQuaternion(this.body.quat);
        return;
      }
    }
    const def = this.hull.sectionById[sectionId];
    this.sectionWorld(sectionId, outP);
    if (!def) {
      outN.set(0, 1, 0);
      return;
    }
    // A face of the box, chosen at random and offset out to it.
    const axis = Math.floor(rand(0, 3)) % 3;
    const sign = Math.random() < 0.5 ? -1 : 1;
    _v2.set(rand(-1, 1) * def.half[0], rand(-1, 1) * def.half[1],
      rand(-1, 1) * def.half[2]);
    _v2.setComponent(axis, sign * def.half[axis]);
    outN.set(0, 0, 0).setComponent(axis, sign);
    _v2.applyQuaternion(this.body.quat);
    outN.applyQuaternion(this.body.quat);
    outP.add(_v2);
  }

  dispose() {
    this.disposed = true;
    if (this.decals) {
      this.decals.dispose();
      this.decals = null;
    }
    this.game.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.isMesh || o.isSprite) {
        if (o.material && o.material.dispose && o.material.userData.owned) {
          o.material.dispose();
        }
      }
    });
  }
}

export { FACETS };
