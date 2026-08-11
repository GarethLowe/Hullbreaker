// -----------------------------------------------------------------------------
// fx.js — pooled particles, streaks, debris, blast fronts and light flashes.
//
// One Points buffer holds every particle in the game, one LineSegments buffer
// holds every streak, one InstancedMesh holds every solid fragment, and a small
// pool of spheres holds every expanding blast front. All four are fixed-size
// ring allocations: nothing is created or garbage collected during play, which
// is what keeps a hundred simultaneous impacts from causing a hitch.
//
// Emitters below are named for the event that causes them, not for how they
// look, so the simulation can say "a coolant line just ruptured" without
// knowing anything about rendering.
//
// The four layers do different jobs and an explosion needs all of them, which
// is why the old one read as a puff of orange dots:
//
//   flash    the light the event throws on everything around it
//   wave     the fireball itself — a real volume that expands and thins
//   particle the incandescent gas, the smoke and the sparks
//   chunk    lit, tumbling, solid pieces of the thing that came apart
//
// Chunks outlive their explosion deliberately: a wreck should still be a debris
// field when you come back to it. See CHUNK_CULL_DIST / CHUNK_BLIND_TIME.
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { rand, randomDirection, clamp01, clamp, coneDirection } from '../core/mathx.js';

// Capital gunnery is a lot of simultaneous impacts, and every one of them now
// throws spall, chunks and a plume as well as sparks. The pool is one flat
// buffer in one draw call, so the only real cost of raising it is memory.
const MAX_PARTICLES = 14000;
/**
 * Smoke is a separate pool for one reason: it is the only thing here that has
 * to make the scene DARKER.
 *
 * Everything else an explosion emits is light being added to the frame, which
 * is what additive blending is for. Smoke is the opposite — it is soot in the
 * way — and an additively-blended dark grey is not dark at all, it is a grey
 * glow. With small short-lived puffs nobody noticed; with a reactor throwing
 * hundred-metre clouds the whole blast came out as a field of soft white
 * bokeh with a fire in the middle of it. Same shader, same pool machinery,
 * normal blending, and now the smoke occludes the fire behind it.
 */
const MAX_SMOKE = 2600;
const MAX_STREAKS = 900;
const MAX_FLASHES = 14;
const MAX_CHUNKS = 1400;
const MAX_WAVES = 12;

/**
 * How long debris survives.
 *
 * Not a lifetime — a visibility rule, because "the wreck evaporated while I was
 * looking at it" is the specific thing that makes a kill feel cheap. A fragment
 * is kept forever while the player can see it and is near enough to matter, and
 * is only reclaimed once it is genuinely of no further interest: too far to
 * resolve, or out of view long enough that nobody is coming back for it.
 *
 * The pool is still finite, so a fresh fragment recycles the oldest slot when
 * every slot is live. That is the backstop, not the mechanism.
 */
const CHUNK_CULL_DIST = 5000;
const CHUNK_BLIND_TIME = 30;

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _d2 = new THREE.Vector3();
const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _scl = new THREE.Vector3();
// Emitters call each other — shipBreakup calls explosion calls chunkBurst — and
// each of them is handed a position that is very often one of these. Every
// routine that can be called from inside another one gets its own scratch, or
// the callee quietly overwrites the caller's argument.
const _cv = new THREE.Vector3();
const _cd = new THREE.Vector3();
const _ev = new THREE.Vector3();
const _sw = new THREE.Vector3();

/**
 * An irregular lump, built once and instanced for every fragment in the game.
 *
 * A box reads as a box from any distance and a sphere reads as a pebble; a
 * jittered icosahedron reads as torn plate, which is what these are. Flat
 * shaded, twenty triangles, one geometry for the whole debris field.
 */
function chunkGeometry() {
  const g = new THREE.IcosahedronGeometry(0.5, 0).toNonIndexed();
  const p = g.getAttribute('position');
  // Jitter per-vertex in a way that is stable across the duplicated corners of
  // adjacent faces would need a welded mesh; it does not need to be. The seams
  // it opens are exactly the ragged edges torn metal has.
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i,
      p.getX(i) * rand(0.55, 1.5),
      p.getY(i) * rand(0.55, 1.5),
      p.getZ(i) * rand(0.55, 1.5));
  }
  g.computeVertexNormals();
  return g;
}

export class FX {
  constructor(game) {
    this.game = game;

    // --- particles ----------------------------------------------------------
    this.pPos = new Float32Array(MAX_PARTICLES * 3);
    this.pCol = new Float32Array(MAX_PARTICLES * 3);
    this.pSize = new Float32Array(MAX_PARTICLES);
    this.parts = new Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.parts[i] = {
        vx: 0, vy: 0, vz: 0, life: 0, max: 1, size: 1, drag: 0,
        r: 1, g: 1, b: 1, fade: 1, grow: 0,
      };
    }
    this.pHead = 0;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    pg.setAttribute('psize', new THREE.BufferAttribute(this.pSize, 1));
    pg.setDrawRange(0, 0);
    this.pGeo = pg;

    // A tiny shader so each particle can carry its own world-space size; the
    // stock PointsMaterial only has one size for the whole system.
    this.points = new THREE.Points(pg, new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { map: { value: game.assets.glow } },
      vertexShader: `
        attribute float psize;
        varying vec3 vCol;
        void main() {
          vCol = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = psize * 320.0 / max(-mv.z, 1.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D map;
        varying vec3 vCol;
        void main() {
          vec4 t = texture2D(map, gl_PointCoord);
          gl_FragColor = vec4(vCol, 1.0) * t;
        }`,
      vertexColors: true,
    }));
    this.points.frustumCulled = false;
    // After the smoke, so fire glows through it rather than under it.
    this.points.renderOrder = 3;
    game.scene.add(this.points);

    this._buildSmoke();

    // --- streaks ------------------------------------------------------------
    this.sPos = new Float32Array(MAX_STREAKS * 6);
    this.sCol = new Float32Array(MAX_STREAKS * 6);
    this.streaks = new Array(MAX_STREAKS);
    for (let i = 0; i < MAX_STREAKS; i++) {
      this.streaks[i] = { life: 0, max: 1, r: 1, g: 1, b: 1 };
    }
    this.sHead = 0;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.sPos, 3));
    sg.setAttribute('color', new THREE.BufferAttribute(this.sCol, 3));
    sg.setDrawRange(0, 0);
    this.sGeo = sg;
    this.lines = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.lines.frustumCulled = false;
    game.scene.add(this.lines);

    this._buildChunks();
    this._buildWaves();

    // --- flashes ------------------------------------------------------------
    // These lights are created ONCE and stay visible for the life of the
    // program, dark when idle.
    //
    // Toggling `visible` looks like the obvious way to pool a light and is a
    // trap: three.js keys every shader program on the number of visible lights
    // of each type, so switching one on changes `numPointLights` and forces a
    // recompile of EVERY material in the scene. With ten flashes that is ten
    // distinct light counts, each one re-linking the whole roster of programs
    // the first time it is seen — a hitch on the first explosion, the first big
    // explosion, the first time two go off at once, and so on. A point light of
    // zero intensity contributes nothing to the image; a constant light count
    // costs one shader compile for the entire session.
    this.flashes = [];
    for (let i = 0; i < MAX_FLASHES; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 160, 2);
      game.scene.add(l);
      this.flashes.push({ light: l, life: 0, max: 1, peak: 0 });
    }
    this.fHead = 0;
  }

  /** Soot: the same pool machinery, blended the other way. See MAX_SMOKE. */
  _buildSmoke() {
    this.kPos = new Float32Array(MAX_SMOKE * 3);
    this.kCol = new Float32Array(MAX_SMOKE * 3);
    this.kSize = new Float32Array(MAX_SMOKE);
    this.kAlpha = new Float32Array(MAX_SMOKE);
    this.smokes = new Array(MAX_SMOKE);
    for (let i = 0; i < MAX_SMOKE; i++) {
      this.smokes[i] = {
        vx: 0, vy: 0, vz: 0, life: 0, max: 1, size: 1, drag: 0,
        r: 1, g: 1, b: 1, alpha: 1, grow: 0,
      };
    }
    this.kHead = 0;
    const kg = new THREE.BufferGeometry();
    kg.setAttribute('position', new THREE.BufferAttribute(this.kPos, 3));
    kg.setAttribute('color', new THREE.BufferAttribute(this.kCol, 3));
    kg.setAttribute('psize', new THREE.BufferAttribute(this.kSize, 1));
    kg.setAttribute('aAlpha', new THREE.BufferAttribute(this.kAlpha, 1));
    kg.setDrawRange(0, 0);
    this.kGeo = kg;
    this.smokePoints = new THREE.Points(kg, new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: { map: { value: this.game.assets.softGlow } },
      vertexShader: `
        attribute float psize;
        attribute float aAlpha;
        varying vec3 vCol;
        varying float vA;
        void main() {
          vCol = color;
          vA = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = psize * 320.0 / max(-mv.z, 1.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D map;
        varying vec3 vCol;
        varying float vA;
        void main() {
          float a = texture2D(map, gl_PointCoord).a * vA;
          if (a < 0.004) { discard; }
          gl_FragColor = vec4(vCol, a);
        }`,
      vertexColors: true,
    }));
    this.smokePoints.frustumCulled = false;
    this.smokePoints.renderOrder = 1;
    this.game.scene.add(this.smokePoints);
  }

  /**
   * The debris field: one instanced draw call for every solid fragment in the
   * world, tumbling under its own angular velocity.
   */
  _buildChunks() {
    const geo = chunkGeometry();
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0.88,
      roughness: 0.58,
      envMap: this.game.assets.environment,
      envMapIntensity: 1.0,
    });
    this.chunkMesh = new THREE.InstancedMesh(geo, mat, MAX_CHUNKS);
    this.chunkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chunkMesh.frustumCulled = false;
    // Force the per-instance colour buffer into existence now rather than on
    // the first fragment, so the material's program is compiled with the
    // instanceColor branch already in it during warm-up.
    for (let i = 0; i < MAX_CHUNKS; i++) {
      this.chunkMesh.setColorAt(i, _c.set(0xffffff));
    }
    this.chunks = new Array(MAX_CHUNKS);
    for (let i = 0; i < MAX_CHUNKS; i++) {
      this.chunks[i] = {
        live: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        spin: new THREE.Vector3(),
        scale: new THREE.Vector3(1, 1, 1),
        /** Seconds this fragment has been unseeable. See CHUNK_BLIND_TIME. */
        blind: 0,
        /** Torn hot: trails embers and cools over the first few seconds. */
        burn: 0,
        age: 0,
      };
      _m.makeScale(0, 0, 0);
      this.chunkMesh.setMatrixAt(i, _m);
    }
    this.cHead = 0;
    this.game.scene.add(this.chunkMesh);
  }

  /**
   * Blast fronts: an expanding shell that starts as an opaque fireball and ends
   * as a thin luminous ring of nothing. One geometry, one program, twelve sets
   * of uniforms — the whole reason an explosion now has a body rather than
   * being a spray of dots.
   */
  _buildWaves() {
    this.waves = [];
    for (let i = 0; i < MAX_WAVES; i++) {
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uCore: { value: 0 },
          uRim: { value: 0 },
          uSeed: { value: 0 },
          uHot: { value: new THREE.Color(0xffd7a0) },
          uCool: { value: new THREE.Color(0xff5a18) },
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
          uniform float uCore;
          uniform float uRim;
          uniform float uSeed;
          uniform vec3 uHot;
          uniform vec3 uCool;
          varying vec3 vLocal;
          varying vec3 vView;
          varying vec3 vNormalW;

          void main() {
            // Three crossed sines standing in for turbulence. It costs nine
            // instructions and it is the difference between a fireball and a
            // soap bubble: the surface has to be lumpy or the eye reads the
            // sphere instead of the event.
            vec3 p = vLocal * 5.0 + uSeed;
            float boil = sin(p.x + p.y * 1.7) * sin(p.y - p.z * 1.3)
                       * sin(p.z + p.x * 2.1);
            boil = 0.62 + 0.38 * boil;

            // Edge-on the shell is thick, face-on it is thin — the same
            // geometry that makes a real expanding shell read as hollow once
            // the fire in it has gone out.
            float fres = pow(1.0 - abs(dot(normalize(vNormalW), vView)), 2.2);

            float core = uCore * boil;
            float rim = uRim * fres * boil;
            float a = clamp(core + rim, 0.0, 1.0);
            if (a < 0.004) { discard; }
            vec3 col = mix(uCool, uHot, clamp(core * 1.6, 0.0, 1.0));
            gl_FragColor = vec4(col * (0.55 + core * 2.2 + rim), a);
          }`,
      });
      const mesh = new THREE.Mesh(this.game.assets.shieldGeo, mat);
      mesh.frustumCulled = false;
      // Visible, at nothing, with both alphas at zero — so `Assets.warmUp`
      // walks it and compiles this program before the first frame instead of
      // during the first explosion. `clear()` turns them off afterwards.
      mesh.visible = true;
      mesh.scale.setScalar(1e-4);
      mesh.renderOrder = 4;
      this.game.scene.add(mesh);
      this.waves.push({
        mesh, mat, life: 0, max: 1, r0: 1, r1: 2, vel: new THREE.Vector3(),
      });
    }
    this.wHead = 0;
  }

  // -- allocation ------------------------------------------------------------

  _spawn(x, y, z, vx, vy, vz, life, size, color, drag = 0.6, fade = 1, grow = 0) {
    const i = this.pHead;
    this.pHead = (this.pHead + 1) % MAX_PARTICLES;
    const p = this.parts[i];
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.life = life; p.max = life; p.size = size; p.drag = drag; p.fade = fade;
    p.grow = grow;
    _c.set(color);
    p.r = _c.r; p.g = _c.g; p.b = _c.b;
    const i3 = i * 3;
    this.pPos[i3] = x; this.pPos[i3 + 1] = y; this.pPos[i3 + 2] = z;
    return p;
  }

  /** One puff of soot. `opacity` is how much of what is behind it it hides. */
  _smoke(x, y, z, vx, vy, vz, life, size, color, drag = 0.9, opacity = 0.5, grow = 0) {
    const i = this.kHead;
    this.kHead = (this.kHead + 1) % MAX_SMOKE;
    const p = this.smokes[i];
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.life = life; p.max = life; p.size = size; p.drag = drag; p.grow = grow;
    p.alpha = opacity;
    _c.set(color);
    p.r = _c.r; p.g = _c.g; p.b = _c.b;
    const i3 = i * 3;
    this.kPos[i3] = x; this.kPos[i3 + 1] = y; this.kPos[i3 + 2] = z;
    return p;
  }

  _streak(a, b, color, life = 0.12) {
    const i = this.sHead;
    this.sHead = (this.sHead + 1) % MAX_STREAKS;
    const s = this.streaks[i];
    s.life = life;
    s.max = life;
    _c.set(color);
    s.r = _c.r; s.g = _c.g; s.b = _c.b;
    const i6 = i * 6;
    this.sPos[i6] = a.x; this.sPos[i6 + 1] = a.y; this.sPos[i6 + 2] = a.z;
    this.sPos[i6 + 3] = b.x; this.sPos[i6 + 4] = b.y; this.sPos[i6 + 5] = b.z;
  }

  flash(pos, color, intensity, radius, life = 0.14) {
    const f = this.flashes[this.fHead];
    this.fHead = (this.fHead + 1) % MAX_FLASHES;
    f.light.position.copy(pos);
    f.light.color.set(color);
    f.light.distance = radius;
    f.peak = intensity;
    f.life = life;
    f.max = life;
  }

  /**
   * One solid fragment. `size` is its longest dimension in metres; fragments
   * are deliberately not spherical, so the scale is jittered per axis and the
   * tumble is about a random axis at a rate that suits how big it is — a plate
   * the size of a lorry does not spin like a bolt.
   */
  chunk(pos, vel, size, color, burn = 0) {
    const i = this.cHead;
    this.cHead = (this.cHead + 1) % MAX_CHUNKS;
    const k = this.chunks[i];
    k.live = true;
    k.age = 0;
    k.blind = 0;
    k.burn = burn;
    k.pos.copy(pos);
    k.vel.copy(vel);
    k.scale.set(size * rand(0.5, 1), size * rand(0.5, 1), size * rand(0.5, 1));
    randomDirection(_d);
    k.quat.setFromAxisAngle(_d, rand(0, Math.PI * 2));
    randomDirection(_d);
    k.spin.copy(_d).multiplyScalar(rand(0.6, 5.0) / Math.max(size * 0.25, 0.35));
    _c.set(color);
    // Hot metal is not the colour of cold metal. The instance tint carries the
    // difference for as long as the fragment glows; `update` walks it back.
    this.chunkMesh.setColorAt(i, burn > 0 ? _c.lerp(_HOT, 0.65 * clamp01(burn)) : _c);
    this.chunkMesh.instanceColor.needsUpdate = true;
    return k;
  }

  /** A cone of fragments thrown from a point. `spread` is the half-angle. */
  chunkBurst(pos, dir, inherit, count, speed, size, color, spread = Math.PI, burn = 0) {
    for (let i = 0; i < count; i++) {
      if (spread >= Math.PI) {
        randomDirection(_cd);
      } else {
        coneDirection(dir, spread, _cd);
      }
      const s = rand(0.35, 1) * speed;
      _cv.set(
        inherit.x + _cd.x * s,
        inherit.y + _cd.y * s,
        inherit.z + _cd.z * s,
      );
      this.chunk(pos, _cv, size * rand(0.45, 1.6), color, burn * rand(0.5, 1));
    }
  }

  /**
   * An expanding blast front. `r0` is the fireball at ignition, `r1` where it
   * has thinned to nothing.
   */
  wave(pos, r0, r1, life, hot = 0xffd7a0, cool = 0xff5a18, vel = null) {
    const w = this.waves[this.wHead];
    this.wHead = (this.wHead + 1) % MAX_WAVES;
    w.life = life;
    w.max = life;
    w.r0 = r0;
    w.r1 = r1;
    w.mesh.position.copy(pos);
    w.mesh.scale.setScalar(r0);
    w.mesh.visible = true;
    w.mat.uniforms.uSeed.value = rand(0, 20);
    w.mat.uniforms.uHot.value.set(hot);
    w.mat.uniforms.uCool.value.set(cool);
    if (vel) {
      w.vel.copy(vel);
    } else {
      w.vel.set(0, 0, 0);
    }
    return w;
  }

  // -- emitters --------------------------------------------------------------

  muzzle(pos, dir, color, scale = 1) {
    // Point defence fires fifteen rounds a second per mount and there are eight
    // mounts. Letting every one of those take a pooled light would mean the PD
    // chatter permanently owned all fourteen flashes and no explosion ever got
    // one. Only real gunnery lights the hull.
    if (scale >= 0.9) {
      this.flash(pos, color, 7 * scale, 46 * scale, 0.075);
    }
    // The flash proper: a short, wide, very bright cone of burning propellant,
    // then a longer thin jet down the bore line.
    for (let i = 0; i < 7; i++) {
      coneDirection(dir, 0.55, _d);
      const s = rand(30, 95) * scale;
      this._spawn(pos.x, pos.y, pos.z, _d.x * s, _d.y * s, _d.z * s,
        rand(0.05, 0.15), rand(0.5, 1.2) * scale, color, 4.5, 1, 0.9 * scale);
    }
    for (let i = 0; i < 3; i++) {
      coneDirection(dir, 0.12, _d);
      const s = rand(90, 200) * scale;
      this._spawn(pos.x, pos.y, pos.z, _d.x * s, _d.y * s, _d.z * s,
        rand(0.06, 0.14), rand(0.3, 0.7) * scale, 0xfff4d6, 3.0);
    }
    // Smoke off the muzzle brake, drifting with the ship.
    for (let i = 0; i < 2; i++) {
      coneDirection(dir, 0.9, _d);
      const s = rand(4, 18) * scale;
      this._smoke(pos.x, pos.y, pos.z, _d.x * s, _d.y * s, _d.z * s,
        rand(0.5, 1.2), rand(0.8, 2.0) * scale, 0x2a2f36, 1.4, 0.30, 3.0 * scale);
    }
  }

  sparkBurst(pos, normal, count, color) {
    for (let i = 0; i < count; i++) {
      coneDirection(normal, 1.15, _d);
      const s = rand(12, 62);
      this._spawn(pos.x, pos.y, pos.z, _d.x * s, _d.y * s, _d.z * s,
        rand(0.18, 0.6), rand(0.10, 0.28), color, 1.4);
    }
    this.flash(pos, color, 2.2, 24, 0.08);
  }

  /**
   * Spall — a round went through a plate and threw the back face off it. The
   * fragments travel with the round, in a tight forward cone, and they are the
   * reason a penetration hurts things that were never on the round's own path.
   */
  spall(pos, dir, count, color) {
    for (let i = 0; i < count; i++) {
      coneDirection(dir, 0.42, _d);
      const s = rand(30, 140);
      this._spawn(pos.x, pos.y, pos.z, _d.x * s, _d.y * s, _d.z * s,
        rand(0.25, 0.85), rand(0.10, 0.34), color, 0.9);
    }
    // A few slow, dark fragments tumbling clear: it reads as debris rather than
    // as a spark shower when the fast ones have gone.
    for (let i = 0; i < Math.max(2, count >> 2); i++) {
      coneDirection(dir, 0.9, _d);
      const s = rand(6, 34);
      this._spawn(pos.x, pos.y, pos.z, _d.x * s, _d.y * s, _d.z * s,
        rand(1.1, 2.6), rand(0.18, 0.5), 0x8a7d70, 0.15, 0.7);
    }
    this.flash(pos, color, 3.0, 40, 0.09);
  }

  /**
   * The exit wound. A round that crossed the whole ship leaves through a hole
   * it made, and what comes out of that hole is the inside of the compartment
   * it just crossed: torn plate, whatever was bolted down in there, and a jet
   * of burning atmosphere behind it.
   *
   * This is the visible half of the argument for solid shot, and until now the
   * only thing that marked an over-penetration was a decal on the far side.
   */
  exitBlast(pos, dir, shipVel, scale) {
    const s = clamp(scale, 0.4, 6);
    // The plume of gas and vaporised metal following the round out.
    this.wave(pos, 0.8 * s, 4.5 * s, 0.24 + 0.03 * s, 0xffd0a0, 0xff5220, shipVel);
    this.flash(pos, 0xffb060, 5 * s, 70 * s, 0.13);
    for (let i = 0; i < Math.round(10 + s * 8); i++) {
      coneDirection(dir, 0.75, _d);
      const v = rand(25, 130) * (0.6 + s * 0.2);
      this._spawn(pos.x, pos.y, pos.z,
        shipVel.x + _d.x * v, shipVel.y + _d.y * v, shipVel.z + _d.z * v,
        rand(0.25, 0.9), rand(0.4, 1.5) * s,
        Math.random() < 0.5 ? 0xffe0a8 : 0xff7a2e, 1.5, 1, 0.45 * s);
    }
    // Solid pieces of the ship, blown out through the hole with the round.
    // Only a real penetrator throws them: the pool is shared with the wrecks,
    // and shell splinters must not be allowed to evict a debris field.
    this.chunkBurst(pos, dir, shipVel, Math.round(s * 3) - 1, 40 * (0.5 + s * 0.2),
      0.45 * s, 0x6e757d, 0.7, 0.7);
    this.spall(pos, dir, Math.round(12 + s * 6), 0xffc98a);
  }

  /**
   * A charge that functioned against the outside of a hull. Everything it had
   * goes back the way it came, in a hemisphere standing off the plating — the
   * shape is the whole tell that a shell burst on the armour instead of getting
   * through it.
   */
  surfaceBlast(pos, normal, shipVel, scale) {
    const s = clamp(scale, 0.4, 8);
    this.wave(pos, 1.0 * s, 6 * s, 0.28 + 0.035 * s, 0xfff0c0, 0xff4a10, shipVel);
    this.flash(pos, 0xffc070, 9 * s, 110 * s, 0.2);
    // The fireball, standing off the surface rather than centred in it.
    for (let i = 0; i < Math.round(16 + s * 10); i++) {
      coneDirection(normal, 1.0, _d);
      const v = rand(15, 85) * (0.6 + s * 0.15);
      this._spawn(pos.x, pos.y, pos.z,
        shipVel.x + _d.x * v, shipVel.y + _d.y * v, shipVel.z + _d.z * v,
        rand(0.35, 1.1), rand(0.6, 2.0) * s,
        Math.random() < 0.45 ? 0xffe6b0 : 0xff8438, 1.6, 1, 0.55 * s);
    }
    // Smoke rolling back off the plating, dragged along by the ship.
    for (let i = 0; i < Math.round(6 + s * 4); i++) {
      coneDirection(normal, 1.3, _d);
      const v = rand(4, 26);
      this._smoke(pos.x, pos.y, pos.z,
        shipVel.x + _d.x * v, shipVel.y + _d.y * v, shipVel.z + _d.z * v,
        rand(1.2, 2.8), rand(1.0, 2.6) * s, 0x25292f, 0.9, 0.45, 2.4 * s);
    }
    // Plate stripped off the skin and thrown clear.
    this.chunkBurst(pos, normal, shipVel, Math.round(s * 2.5) - 1, 34 * (0.5 + s * 0.2),
      0.5 * s, 0x767d85, 1.0, 0.5);
    this.sparkBurst(pos, normal, Math.round(18 + s * 6), 0xffc070);
  }

  /** Something under the plating just took a hit; colour tells you what. */
  internalHit(pos, dir, kind) {
    const color = kind === 'conduit' ? 0x9fd0ff
      : (kind === 'fuel' ? 0xffb066
        : (kind === 'magazine' ? 0xff7a4a : 0xffe0a0));
    for (let i = 0; i < 7; i++) {
      randomDirection(_d);
      const s = rand(6, 26);
      this._spawn(pos.x, pos.y, pos.z, _d.x * s, _d.y * s, _d.z * s,
        rand(0.25, 0.7), rand(0.12, 0.3), color, 1.1);
    }
  }

  shieldHit(pos, normal, collapsing) {
    const color = collapsing ? 0xfff0a0 : 0x8fd4ff;
    for (let i = 0; i < (collapsing ? 26 : 10); i++) {
      coneDirection(normal, collapsing ? 1.5 : 0.8, _d);
      const s = rand(8, collapsing ? 70 : 30);
      this._spawn(pos.x, pos.y, pos.z, _d.x * s, _d.y * s, _d.z * s,
        rand(0.2, 0.55), rand(0.25, 0.7), color, 2.0);
    }
    if (collapsing) {
      this.wave(pos, 3, 26, 0.4, 0xdff0ff, 0x4aa8ff);
    }
    this.flash(pos, color, collapsing ? 9 : 2.6, 60, 0.12);
  }

  /** Ion detonation: a bright ring rather than a spray of fragments. */
  ionBurst(pos, radii) {
    const r = Math.max(radii[0], radii[1]) * 0.6;
    for (let i = 0; i < 44; i++) {
      randomDirection(_d);
      const s = rand(0.6, 1.1) * r * 2.4;
      this._spawn(pos.x, pos.y, pos.z, _d.x * s, _d.y * s, _d.z * s,
        rand(0.3, 0.75), rand(0.3, 0.9), 0xbb7cff, 2.6);
    }
    this.wave(pos, r * 0.4, r * 2.6, 0.42, 0xe6d0ff, 0x8a3cff);
    this.flash(pos, 0xbb7cff, 12, 160, 0.28);
  }

  beamImpact(pos, color) {
    for (let i = 0; i < 3; i++) {
      randomDirection(_d);
      const s = rand(4, 22);
      this._spawn(pos.x, pos.y, pos.z, _d.x * s, _d.y * s, _d.z * s,
        rand(0.1, 0.3), rand(0.2, 0.5), color, 2.4);
    }
    // Molten spatter running off the spot. A lance is cutting metal, and metal
    // that is being cut throws liquid.
    if (Math.random() < 0.4) {
      randomDirection(_d);
      const s = rand(10, 40);
      this._spawn(pos.x, pos.y, pos.z, _d.x * s, _d.y * s, _d.z * s,
        rand(0.4, 1.2), rand(0.15, 0.4), 0xffb060, 0.5, 0.8);
    }
    this.flash(pos, color, 2.4, 26, 0.05);
  }

  railTrail(a, b, color) {
    this._streak(a, b, color, 0.16);
  }

  /**
   * A running motor. Ordnance under power is the brightest thing in the sky
   * bar the guns, and a torpedo you cannot see coming is not a threat the
   * player gets to answer.
   */
  motorPlume(pos, dir, count, color) {
    for (let i = 0; i < count; i++) {
      coneDirection(dir, 0.35, _d);
      const s = rand(30, 110);
      this._spawn(pos.x, pos.y, pos.z, -_d.x * s, -_d.y * s, -_d.z * s,
        rand(0.12, 0.4), rand(0.5, 1.3), color, 2.0, 1, 0.7);
    }
    randomDirection(_d);
    this._smoke(pos.x, pos.y, pos.z, _d.x * 3, _d.y * 3, _d.z * 3,
      rand(0.8, 1.8), rand(0.9, 2.2), 0x2c313a, 0.9, 0.35, 3.5);
  }

  /**
   * Fire venting out of a breached compartment.
   *
   * A fire aboard is not a candle: it is a compartment full of burning stores
   * with a hole in the side, so what you see from outside is a jet — driven out
   * of the hole, dragged flat by the ship's own motion, roaring where the hole
   * is and guttering where the oxygen has gone. `dir` is the hole's outward
   * normal; `power` is how hard the compartment is burning, 0..1.
   */
  fireLick(pos, dir, shipVel, power = 1) {
    const p = clamp01(power);
    const n = 1 + Math.round(p * 3);
    for (let i = 0; i < n; i++) {
      coneDirection(dir, 0.55 + 0.5 * (1 - p), _d);
      const s = rand(12, 46) * (0.4 + p);
      this._spawn(pos.x, pos.y, pos.z,
        shipVel.x + _d.x * s, shipVel.y + _d.y * s, shipVel.z + _d.z * s,
        rand(0.5, 1.3), rand(4, 11) * (0.5 + p * 0.8),
        Math.random() < 0.35 ? 0xfff0b0 : (Math.random() < 0.6 ? 0xffa030 : 0xff5810),
        1.1, 1, 7);
    }
    // Sooty smoke off the top of it, which is what makes a burning ship read as
    // burning from a kilometre away rather than as a ship with orange dots.
    coneDirection(dir, 1.0, _d);
    const s = rand(4, 20);
    this._smoke(pos.x, pos.y, pos.z,
      shipVel.x + _d.x * s, shipVel.y + _d.y * s, shipVel.z + _d.z * s,
      rand(1.8, 4.0), rand(6, 15) * (0.6 + p), 0x1a1d22, 0.7, 0.5, 26);
    // Flicker. A fire is a light source, and the reason a burning hull looks
    // alive is that the plating around the hole is being lit unevenly.
    if (Math.random() < 0.25) {
      this.flash(pos, 0xff8a30, 2.5 + 4 * p, 60 + 60 * p, 0.16);
    }
  }

  /**
   * Atmosphere blowing out of a hole: a cold white jet, not an explosion.
   *
   * `dir` is the hole's outward normal, so the plume actually comes out of the
   * damage rather than out of the middle of the compartment. It keeps going for
   * as long as the hole is open — thinning as the air goes, then running on as
   * sublimating coolant and outgassing stores — which is what makes an unwelded
   * breach something you can see from outside.
   */
  ventJet(pos, dir, shipVel, strength) {
    coneDirection(dir, 0.30, _d);
    const s = rand(30, 90) * strength;
    // Sized in tens of metres, not in metres.
    //
    // A point's screen size here is `psize * 320 / distance`, so a one-metre
    // puff on a hull two hundred metres away is two pixels and on one two
    // kilometres away is a third of a pixel. Every damage effect in this file
    // was authored at hull-detail scale and was therefore invisible at the
    // range the game is actually fought at — which is most of why a ship with
    // seven compartments open to space looked completely undamaged. A real
    // decompression plume is tens of metres long anyway.
    //
    // On the SMOKE layer, not the fire one. Vapour is not a light source: an
    // additive white plume reads as a string of soft white discs pasted over
    // the hull, which is bokeh rather than atmosphere. Normal-blended, it hides
    // what is behind it, which is what a cloud does.
    this._smoke(pos.x, pos.y, pos.z,
      shipVel.x + _d.x * s, shipVel.y + _d.y * s, shipVel.z + _d.z * s,
      rand(1.0, 2.6), rand(3, 9) * (0.5 + strength), 0xc9dae8, 0.5,
      0.16 + 0.22 * strength, 14);
    // Ice. Air at 300 K meeting vacuum freezes, and this glitter IS a light
    // source — sunlight off a few million tumbling crystals — which is the part
    // that carries at gunnery range.
    if (Math.random() < 0.6) {
      coneDirection(dir, 0.7, _d);
      const v = rand(12, 50) * strength;
      this._spawn(pos.x, pos.y, pos.z,
        shipVel.x + _d.x * v, shipVel.y + _d.y * v, shipVel.z + _d.z * v,
        rand(2.0, 4.5), rand(0.5, 1.6), 0xeaf4ff, 0.06, 0.8);
    }
  }

  /**
   * A detonation. `radius` is the physical scale of the event in metres and
   * everything else is derived from it, so a cook-off, a warhead and a reactor
   * are the same code at three sizes rather than three effects.
   */
  explosion(pos, radius, color = 0xffb060, opts = {}) {
    const r = Math.max(radius, 1);
    const vel = opts.vel || _ZERO;
    const heavy = opts.heavy ? 1 : 0;

    // The front. A small dense fireball that dies fast, and — only when the
    // event is big enough to be worth one — the thin luminous shell that runs
    // on out through it.
    //
    // The second shell is gated on size because of what a dying ship does: it
    // throws a secondary every few frames for six seconds, and at two shells
    // apiece those stack. Twelve overlapping additive spheres do not read as
    // six explosions, they read as one pile of soap bubbles.
    this.wave(pos, r * 0.3, r * 1.5, 0.30 + r * 0.006, 0xfff2d0, color, vel);
    if (r > 14) {
      this.wave(pos, r * 0.6, r * (2.6 + heavy * 2.0), 0.5 + r * 0.014,
        color, 0x8c2a08, vel);
    }
    this.flash(pos, 0xffd7a0, 20 + r * 1.2, r * 22, 0.10);
    this.flash(pos, color, 12 + r * 0.6, r * 16, 0.45 + r * 0.01);

    // Incandescent gas.
    const n = Math.min(260, 40 + Math.round(r * 7));
    for (let i = 0; i < n; i++) {
      randomDirection(_d);
      const s = rand(0.2, 1) * r * 6;
      this._spawn(pos.x, pos.y, pos.z,
        vel.x + _d.x * s, vel.y + _d.y * s, vel.z + _d.z * s,
        rand(0.3, 1.3), rand(0.5, 1.8) * (r / 7), color, 1.2, 1, r * 0.05);
    }
    // A white core that burns out fast — the part that reads as heat.
    for (let i = 0; i < n >> 2; i++) {
      randomDirection(_d);
      const s = rand(0.1, 0.6) * r * 4;
      this._spawn(pos.x, pos.y, pos.z,
        vel.x + _d.x * s, vel.y + _d.y * s, vel.z + _d.z * s,
        rand(0.12, 0.4), rand(1.0, 2.6) * (r / 7), 0xfff6dc, 2.0, 1, r * 0.07);
    }
    // Smoke, slow and long-lived, so the site of an explosion stays marked.
    for (let i = 0; i < n / 2.5; i++) {
      randomDirection(_d);
      const s = rand(0.15, 0.7) * r * 3;
      this._smoke(pos.x, pos.y, pos.z,
        vel.x + _d.x * s, vel.y + _d.y * s, vel.z + _d.z * s,
        rand(1.4, 4.0), rand(1.0, 2.8) * (r / 7), 0x1c1f24, 0.75, 0.42, r * 0.6);
    }
    // Embers: small, fast, and they outlive the fireball, which is what sells
    // the scale of the thing that just came apart.
    for (let i = 0; i < n / 2; i++) {
      randomDirection(_d);
      const s = rand(0.5, 1.6) * r * 9;
      this._spawn(pos.x, pos.y, pos.z,
        vel.x + _d.x * s, vel.y + _d.y * s, vel.z + _d.z * s,
        rand(0.8, 2.6), rand(0.10, 0.30), 0xffb264, 0.35, 0.6);
    }
    // Jets. Real blasts are not spherical — they blow out where the casing was
    // weak, and a few radial spikes is what says so. Kept SHORT and warm: at
    // four times the fireball radius in white they stopped reading as jets of
    // burning material and started reading as a cartoon starburst.
    for (let i = 0; i < 3 + heavy * 3; i++) {
      randomDirection(_d);
      _ev.copy(pos).addScaledVector(_d, r * rand(0.7, 1.5));
      this._streak(pos, _ev, 0xffb060, 0.13);
    }

    // Solid pieces.
    const chunks = opts.chunks !== undefined
      ? opts.chunks : Math.min(50, Math.round(3 + r * 0.9));
    if (chunks > 0) {
      this.chunkBurst(pos, _UP, vel, chunks, r * 3.2, r * 0.09,
        Math.PI, 0.8);
    }
  }

  /**
   * A reactor going up. This is the largest event in the game and it is
   * supposed to be unmistakable from anywhere in the engagement: a white core,
   * a front that crosses the whole hull, and the ship itself coming apart into
   * pieces that stay in the sky afterwards.
   */
  reactorBlast(pos, vel, radius) {
    const r = Math.max(radius, 12);
    // Three nested fronts. The innermost is white and gone in a third of a
    // second; the outermost is still expanding a second and a half later.
    this.wave(pos, r * 0.2, r * 1.4, 0.28, 0xffffff, 0xfff0c0, vel);
    this.wave(pos, r * 0.5, r * 3.4, 0.75, 0xfff0c0, 0xff6a18, vel);
    this.wave(pos, r * 1.0, r * 7.0, 1.6, 0xff9a40, 0x501004, vel);
    this.flash(pos, 0xffffff, 90, r * 40, 0.16);
    this.flash(pos, 0xffd090, 55, r * 34, 0.9);
    this.flash(pos, 0xff7a30, 26, r * 26, 2.2);

    for (let i = 0; i < 420; i++) {
      randomDirection(_d);
      const s = rand(0.15, 1) * r * 11;
      this._spawn(pos.x, pos.y, pos.z,
        vel.x + _d.x * s, vel.y + _d.y * s, vel.z + _d.z * s,
        rand(0.4, 2.2), rand(1.0, 3.4) * (r / 20),
        Math.random() < 0.3 ? 0xfff8e4 : 0xffa440, 1.0, 1, r * 0.08);
    }
    for (let i = 0; i < 200; i++) {
      randomDirection(_d);
      const s = rand(0.1, 0.7) * r * 5;
      this._smoke(pos.x, pos.y, pos.z,
        vel.x + _d.x * s, vel.y + _d.y * s, vel.z + _d.z * s,
        rand(2.5, 7.0), rand(2.0, 5.5) * (r / 20), 0x15171b, 0.6, 0.5, r * 1.2);
    }
    for (let i = 0; i < 260; i++) {
      randomDirection(_d);
      const s = rand(0.6, 1.8) * r * 16;
      this._spawn(pos.x, pos.y, pos.z,
        vel.x + _d.x * s, vel.y + _d.y * s, vel.z + _d.z * s,
        rand(1.5, 5.0), rand(0.14, 0.40), 0xffc070, 0.2, 0.55);
    }
    for (let i = 0; i < 9; i++) {
      randomDirection(_d);
      _ev.copy(pos).addScaledVector(_d, r * rand(1.0, 2.4));
      this._streak(pos, _ev, 0xffc070, 0.22);
    }
    this.chunkBurst(pos, _UP, vel, 90, r * 6, r * 0.10, Math.PI, 1);
  }

  /**
   * A hull coming apart. Every compartment throws its own fragments outward
   * from the ship's centre, so the debris field has the shape of the thing that
   * made it rather than being a uniform ball.
   */
  shipBreakup(ship) {
    const hull = ship.hull;
    const vel = ship.body.vel;
    const r = hull.radius;
    this.reactorBlast(ship.position, vel, r * 0.8);
    for (const s of hull.sections) {
      ship.sectionWorld(s.id, _sw);
      _d2.copy(_sw).sub(ship.position);
      if (_d2.lengthSq() < 1e-4) {
        randomDirection(_d2);
      }
      _d2.normalize();
      // Pieces leave along the line from the ship's middle out through their
      // own compartment, at a speed that scales with how far out they started.
      const reach = Math.max(6, Math.hypot(s.half[0], s.half[1], s.half[2]));
      const count = Math.round(clamp(reach * 0.9, 5, 26));
      this.chunkBurst(_sw, _d2, vel, count, 24 + reach * 2.2,
        reach * 0.16, 1.1, 0.9);
      this.explosion(_sw, reach * 0.7, 0xff9a50, { vel, chunks: 0 });
    }
  }

  // -- update ----------------------------------------------------------------

  update(dt) {
    let n = 0;
    const pos = this.pPos;
    const col = this.pCol;
    const size = this.pSize;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.parts[i];
      if (p.life <= 0) {
        continue;
      }
      p.life -= dt;
      const i3 = i * 3;
      if (p.life <= 0) {
        // Park dead particles at the origin with zero size; the draw range is
        // a single contiguous span, so they have to be harmless rather than
        // removed.
        size[i] = 0;
        col[i3] = 0; col[i3 + 1] = 0; col[i3 + 2] = 0;
        continue;
      }
      const k = p.drag > 0 ? Math.exp(-p.drag * dt) : 1;
      p.vx *= k; p.vy *= k; p.vz *= k;
      pos[i3] += p.vx * dt;
      pos[i3 + 1] += p.vy * dt;
      pos[i3 + 2] += p.vz * dt;
      const t = clamp01(p.life / p.max);
      const a = Math.pow(t, p.fade);
      col[i3] = p.r * a;
      col[i3 + 1] = p.g * a;
      col[i3 + 2] = p.b * a;
      // Gas expands as it cools. `grow` is metres of extra radius over the
      // particle's whole life, and it is the single cheapest thing that makes
      // smoke read as smoke instead of as a receding dot.
      size[i] = p.size * (0.4 + 0.6 * t) + p.grow * (1 - t);
      n++;
    }
    this.pGeo.attributes.position.needsUpdate = true;
    this.pGeo.attributes.color.needsUpdate = true;
    this.pGeo.attributes.psize.needsUpdate = true;
    this.pGeo.setDrawRange(0, n > 0 ? MAX_PARTICLES : 0);

    let kn = 0;
    for (let i = 0; i < MAX_SMOKE; i++) {
      const p = this.smokes[i];
      if (p.life <= 0) {
        continue;
      }
      p.life -= dt;
      const i3 = i * 3;
      if (p.life <= 0) {
        this.kSize[i] = 0;
        this.kAlpha[i] = 0;
        continue;
      }
      const k = p.drag > 0 ? Math.exp(-p.drag * dt) : 1;
      p.vx *= k; p.vy *= k; p.vz *= k;
      this.kPos[i3] += p.vx * dt;
      this.kPos[i3 + 1] += p.vy * dt;
      this.kPos[i3 + 2] += p.vz * dt;
      const t = clamp01(p.life / p.max);
      this.kCol[i3] = p.r;
      this.kCol[i3 + 1] = p.g;
      this.kCol[i3 + 2] = p.b;
      // Soot thins out as it expands rather than going out like a light: it
      // fades in over the first tenth of its life and away over the rest.
      this.kAlpha[i] = p.alpha * Math.min(1, (1 - t) * 9) * t;
      this.kSize[i] = p.size * (0.5 + 0.5 * t) + p.grow * (1 - t);
      kn++;
    }
    this.kGeo.attributes.position.needsUpdate = true;
    this.kGeo.attributes.color.needsUpdate = true;
    this.kGeo.attributes.psize.needsUpdate = true;
    this.kGeo.attributes.aAlpha.needsUpdate = true;
    this.kGeo.setDrawRange(0, kn > 0 ? MAX_SMOKE : 0);

    let sn = 0;
    for (let i = 0; i < MAX_STREAKS; i++) {
      const s = this.streaks[i];
      const i6 = i * 6;
      if (s.life <= 0) {
        for (let k = 0; k < 6; k++) {
          this.sCol[i6 + k] = 0;
        }
        continue;
      }
      s.life -= dt;
      const a = Math.max(0, s.life / s.max);
      this.sCol[i6] = s.r * a * 0.2;
      this.sCol[i6 + 1] = s.g * a * 0.2;
      this.sCol[i6 + 2] = s.b * a * 0.2;
      this.sCol[i6 + 3] = s.r * a;
      this.sCol[i6 + 4] = s.g * a;
      this.sCol[i6 + 5] = s.b * a;
      sn++;
    }
    this.sGeo.attributes.color.needsUpdate = true;
    this.sGeo.attributes.position.needsUpdate = true;
    this.sGeo.setDrawRange(0, sn > 0 ? MAX_STREAKS * 2 : 0);

    this._updateChunks(dt);
    this._updateWaves(dt);

    for (const f of this.flashes) {
      if (f.life <= 0) {
        continue;
      }
      f.life -= dt;
      if (f.life <= 0) {
        f.light.intensity = 0;
        continue;
      }
      f.light.intensity = f.peak * (f.life / f.max);
    }
  }

  _updateChunks(dt) {
    const cam = this.game.camera;
    _v.copy(cam.position);
    _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    // A cone comfortably wider than the frustum. The rule is "the player cannot
    // see it", so erring toward keeping a fragment alive is the right error.
    const cosLimit = Math.cos(Math.min(Math.PI, (cam.fov * Math.PI) / 180 * 0.9));
    let dirty = false;
    for (let i = 0; i < MAX_CHUNKS; i++) {
      const k = this.chunks[i];
      if (!k.live) {
        continue;
      }
      k.age += dt;
      k.pos.addScaledVector(k.vel, dt);
      // Tumble. The angular velocity is constant — there is nothing out here to
      // damp it — so this is one quaternion product per fragment per frame.
      const w = k.spin.length();
      if (w > 1e-5) {
        _d.copy(k.spin).multiplyScalar(1 / w);
        _q.setFromAxisAngle(_d, w * dt);
        k.quat.premultiply(_q).normalize();
      }
      if (k.burn > 0) {
        k.burn = Math.max(0, k.burn - dt * 0.28);
        if (Math.random() < 5 * dt * k.burn) {
          randomDirection(_d);
          const s = rand(1, 6);
          this._spawn(k.pos.x, k.pos.y, k.pos.z,
            k.vel.x + _d.x * s, k.vel.y + _d.y * s, k.vel.z + _d.z * s,
            rand(0.3, 0.9), rand(0.15, 0.45), 0xff9a40, 0.6, 0.7);
        }
        if (k.burn <= 0) {
          this.chunkMesh.setColorAt(i, _c.set(0x6b7178));
          this.chunkMesh.instanceColor.needsUpdate = true;
        }
      }

      // Visibility. Distance is a hard cut; being out of view is a timer, so a
      // wreck you fly past and come back to is still there.
      _d.copy(k.pos).sub(_v);
      const dist = _d.length();
      let gone = dist > CHUNK_CULL_DIST;
      if (!gone) {
        const seen = dist < 1e-3 || _d.dot(_fwd) / dist > cosLimit;
        k.blind = seen ? 0 : k.blind + dt;
        gone = k.blind > CHUNK_BLIND_TIME;
      }
      if (gone) {
        k.live = false;
        _m.makeScale(0, 0, 0);
        this.chunkMesh.setMatrixAt(i, _m);
        dirty = true;
        continue;
      }
      _m.compose(k.pos, k.quat, _scl.copy(k.scale));
      this.chunkMesh.setMatrixAt(i, _m);
      dirty = true;
    }
    if (dirty) {
      this.chunkMesh.instanceMatrix.needsUpdate = true;
    }
  }

  _updateWaves(dt) {
    for (const w of this.waves) {
      if (w.life <= 0) {
        continue;
      }
      w.life -= dt;
      if (w.life <= 0) {
        w.mesh.visible = false;
        continue;
      }
      const t = 1 - w.life / w.max;
      // Expansion decelerates hard: a blast front does most of its travel in
      // the first fifth of its life, and a linear ramp reads as a balloon.
      const e = 1 - Math.pow(1 - t, 2.6);
      w.mesh.scale.setScalar(w.r0 + (w.r1 - w.r0) * e);
      w.mesh.position.addScaledVector(w.vel, dt);
      // The fireball is opaque while it burns and then there is nothing left
      // but the luminous shell, which fades out from the inside.
      // Kept well under one so several fronts can overlap without the additive
      // sum saturating to white.
      w.mat.uniforms.uCore.value = Math.pow(1 - t, 3.2) * 0.85;
      w.mat.uniforms.uRim.value = Math.sin(Math.PI * Math.pow(t, 0.6)) * 0.45;
    }
  }

  clear() {
    for (const p of this.parts) {
      p.life = 0;
    }
    for (const p of this.smokes) {
      p.life = 0;
    }
    for (const s of this.streaks) {
      s.life = 0;
    }
    for (const f of this.flashes) {
      f.life = 0;
      f.light.intensity = 0;
    }
    for (const w of this.waves) {
      w.life = 0;
      w.mesh.visible = false;
    }
    for (let i = 0; i < MAX_CHUNKS; i++) {
      this.chunks[i].live = false;
      _m.makeScale(0, 0, 0);
      this.chunkMesh.setMatrixAt(i, _m);
    }
    this.chunkMesh.instanceMatrix.needsUpdate = true;
  }
}

const _ZERO = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);
const _HOT = new THREE.Color(0xffc070);
