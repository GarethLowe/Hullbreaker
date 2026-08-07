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
import { Decals } from '../fx/decals.js';
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

/**
 * Facet lookup by dominant local axis, in +X/-X/+Y/-Y/+Z/-Z order.
 * +X is PORT in this right-handed, +Z-forward frame — see the sign note in
 * flight.js. Getting this pair the wrong way round makes the HUD tell you the
 * wrong side of your ship is exposed, which is worse than not telling you.
 */
const FACET_BY_AXIS = [['port', 'stbd'], ['dorsal', 'ventral'], ['fore', 'aft']];

let SHIP_SERIAL = 0;

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
    this.lastDamageT = -1e9;
    /** Delta-v taken from impacts since the camera last looked; see consumeJolt. */
    this.jolt = 0;
    /** Magazine-fed mounts all draw the same nature of round; see AMMO. */
    this.ammo = 'ap';

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
    this.group = new THREE.Group();
    this.sectionMeshes = new Map();

    for (const s of this.hull.sections) {
      const mat = assets.hullMaterial(tint, s.style);
      const geo = assets.boxGeo;
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

      // A little surface relief so a hull is not six flat quads. Purely
      // cosmetic and never tested against.
      if (s.style === 'hull' || s.style === 'engine') {
        for (let i = 0; i < 3; i++) {
          const g = new THREE.Mesh(assets.boxGeo, assets.greebleMaterial(tint));
          const ax = Math.random() < 0.5 ? 0 : 1;
          g.scale.set(
            s.half[0] * rand(0.25, 0.7) * 2,
            s.half[1] * rand(0.08, 0.2) * 2,
            s.half[2] * rand(0.2, 0.55) * 2,
          );
          g.position.set(
            mesh.position.x + (ax ? s.half[0] * rand(-0.6, 0.6) : 0),
            mesh.position.y + s.half[1] * (Math.random() < 0.5 ? 1 : -1) * 0.99,
            mesh.position.z + s.half[2] * rand(-0.5, 0.5),
          );
          this.group.add(g);
        }
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

    // Navigation strobes, so contacts read at range even against the dust.
    this.beacon = new THREE.PointLight(tint, 0, this.hull.radius * 9, 2);
    this.beacon.position.set(0, 0, 0);
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
    const geo = new THREE.SphereGeometry(1, 32, 24);
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
        cool: 0,
        firing: false,
        beamT: 0,
        scale: MOUNTS[def.mount] || 1,
        /** Turrets traverse; a fixed mount is a mount with an arc of nearly 0. */
        turret: def.arc > 0.25,
      };
      this.mounts.push(mount);
    }
    // The AI thinks in terms of "guns I have to point the ship at" versus
    // "guns that point themselves".
    this.fireGroups = [
      this.mounts.filter((m) => !m.turret && m.weapon.kind !== 'missile'),
      this.mounts.filter((m) => m.turret || m.weapon.kind === 'missile'),
    ];
    // The player thinks in terms of weapons. Mounts carrying the same weapon
    // fire together as one selectable group, in hull-table order.
    const byWeapon = new Map();
    for (const m of this.mounts) {
      if (!byWeapon.has(m.def.weapon)) {
        byWeapon.set(m.def.weapon, []);
      }
      byWeapon.get(m.def.weapon).push(m);
    }
    this.weaponGroups = [...byWeapon.entries()].map(([id, mounts]) => ({
      id, name: WEAPONS[id].name, weapon: WEAPONS[id], mounts,
    }));
  }

  // -- transforms ------------------------------------------------------------

  localToWorld(local, out = new THREE.Vector3()) {
    return out.copy(local).applyQuaternion(this.body.quat).add(this.body.pos);
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
   */
  faceFor(worldDir) {
    _v.copy(worldDir).applyQuaternion(_qi.copy(this.body.quat).invert());
    const r = this.shieldRadii;
    const x = Math.abs(_v.x / r[0]);
    const y = Math.abs(_v.y / r[1]);
    const z = Math.abs(_v.z / r[2]);
    if (y > x && y > z) {
      return _v.y >= 0 ? 'dorsal' : 'ventral';
    }
    if (z > x) {
      return _v.z >= 0 ? 'fore' : 'aft';
    }
    return _v.x >= 0 ? 'stbd' : 'port';
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
    this.lastDamageT = performance.now();
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
    this.decals.add(_mp, _mn, opts);
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
   * Where a mount is pointing this tick. Turrets with a live fire-control link
   * lead the target; without one they fall back to their rest bearing, which is
   * what "the gun still works but nothing is telling it where to shoot" looks
   * like from the outside.
   */
  _aimMount(mount, target, dt) {
    const rest = _v.copy(mount.rest).applyQuaternion(this.body.quat);
    if (!target || !mount.turret || !this.sys.hasData(mount.mod)) {
      mount.aim.lerp(rest, 1 - Math.exp(-6 * dt)).normalize();
      return;
    }
    this.localToWorld(mount.origin, _o);
    _v2.copy(target.position).sub(_o);
    const w = mount.weapon;
    if (w.muzzleVel) {
      _d.copy(target.velocity).sub(this.velocity);
      const t = interceptTime(_v2, _d, w.muzzleVel);
      if (t !== null && t < 6) {
        _v2.addScaledVector(_d, t);
      }
    }
    _v2.normalize();
    // Clamp the demand into the mount's traverse arc about its rest bearing.
    const dot = clamp(_v2.dot(rest), -1, 1);
    const arc = mount.def.arc;
    if (Math.acos(dot) > arc) {
      // Rotate `rest` toward the demand by exactly `arc`.
      _d.copy(_v2).addScaledVector(rest, -dot).normalize();
      _v2.copy(rest).multiplyScalar(Math.cos(arc)).addScaledVector(_d, Math.sin(arc));
    }
    // Traverse is not instant, and a damaged mount slews slower.
    const rate = 2.6 * (0.35 + 0.65 * mount.mod.eff);
    mount.aim.lerp(_v2, 1 - Math.exp(-rate * dt)).normalize();
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
  updateWeapons(dt, target, shouldFire) {
    const ball = this.game.ballistics;
    {
      for (const mount of this.mounts) {
        const held = shouldFire(mount);
        this._aimMount(mount, target, dt);
        const w = mount.weapon;
        const mod = mount.mod;
        const live = mod.eff > 0.12 && !mod.destroyed;
        mount.cool = Math.max(0, mount.cool - dt);

        // Duty drives both the thermal model and the electrical draw: a gun
        // that is not cycling is hotel load, not a 2.6 MW appliance.
        mod.duty = Math.max(0, (mod.duty || 0) - dt * 2.5);

        if (w.kind === 'beam') {
          const want = held && live && this._canDraw(w.draw * dt);
          mount.firing = want;
          if (want) {
            mod.duty = 1;
            this.localToWorld(mount.origin, _o);
            ball.fireBeam(this, mount, _o, mount.aim, dt);
            this.sys.capStore = Math.max(0, this.sys.capStore - w.draw * dt);
            mod.heatAcc += w.heat * mount.scale;
          }
          continue;
        }

        mount.firing = false;
        if (!held || !live || mount.cool > 0) {
          continue;
        }
        if (!this._takeAmmo(mount)) {
          continue;
        }
        if (!this._canDraw(w.draw)) {
          continue;
        }
        this.sys.capStore = Math.max(0, this.sys.capStore - w.draw);
        // A derated mount cycles slower — the loader is on the same bus.
        mount.cool = w.interval / clamp(mod.eff, 0.25, 1);
        mod.heatAcc += w.heat * mount.scale;
        mod.duty = 1;
        mount.firing = true;
        this._launch(mount, target);
      }
    }
  }

  _canDraw(mj) {
    return this.sys.capStore >= mj || this.sys.supply > 0.5;
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
    this.localToWorld(mount.origin, _o);
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
    this.sys.tick(dt);
    this.crew.tick(dt);
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
          fx.explosion(at, 9 + Math.min(18, e.energy / 6e5), 0xffb060);
          this.crew.killIn(e.section, 2);
          this.game.audio.boom(at, 1);
          // Through Ship, not Body: a magazine going off inside your own hull
          // is precisely the event the camera should register, and routing it
          // past the wrapper is how it would silently fail to.
          this.applyImpulseAt(at, this.forward(_v2), e.energy * 1e-4);
          break;
        }
        case 'detonate': {
          this.game.audio.boom(this.body.pos, 1.4);
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
            this.game.hud.warn('COMPUTER THERMAL SHUTDOWN');
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

  _syncVisual(dt) {
    this.group.position.copy(this.body.pos);
    this.group.quaternion.copy(this.body.quat);

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
    this.beacon.intensity = this.sys.supply > 0.2
      ? 1.6 + Math.sin(performance.now() * 0.004 + this.id) * 1.2
      : 0;

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

    // Venting compartments and open fires are the ship telling you what is
    // wrong from the outside, before you ever open the schematic.
    for (const s of this.sys.sections.values()) {
      if (s.fire > 0 && Math.random() < 6 * dt) {
        this.sectionWorld(s.id, _v);
        _v.x += rand(-2, 2);
        _v.y += rand(-2, 2);
        _v.z += rand(-2, 2);
        this.game.fx.fireLick(_v, this.body.vel);
      } else if ((s.breached || s.venting) && s.atmo > 0.05 && Math.random() < 4 * dt) {
        this.sectionWorld(s.id, _v);
        this.game.fx.ventJet(_v, this.body.vel, s.venting ? 1.6 : 0.8);
      }
    }
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
