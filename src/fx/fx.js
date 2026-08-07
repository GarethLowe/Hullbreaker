// -----------------------------------------------------------------------------
// fx.js — pooled particles, streaks, debris and light flashes.
//
// One Points buffer holds every particle in the game and one LineSegments
// buffer holds every streak. Both are fixed-size ring allocations: nothing is
// created or garbage collected during play, which is what keeps a hundred
// simultaneous impacts from causing a hitch.
//
// Emitters below are named for the event that causes them, not for how they
// look, so the simulation can say "a coolant line just ruptured" without
// knowing anything about rendering.
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { rand, randomDirection, clamp01, coneDirection } from '../core/mathx.js';

// Capital gunnery is a lot of simultaneous impacts, and every one of them now
// throws spall and a plume as well as sparks. The pool is one flat buffer in
// one draw call, so the only real cost of raising it is memory.
const MAX_PARTICLES = 9000;
const MAX_STREAKS = 700;
const MAX_FLASHES = 10;

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _c = new THREE.Color();

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
        r: 1, g: 1, b: 1, fade: 1,
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
    game.scene.add(this.points);

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

  // -- allocation ------------------------------------------------------------

  _spawn(x, y, z, vx, vy, vz, life, size, color, drag = 0.6, fade = 1) {
    const i = this.pHead;
    this.pHead = (this.pHead + 1) % MAX_PARTICLES;
    const p = this.parts[i];
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.life = life; p.max = life; p.size = size; p.drag = drag; p.fade = fade;
    _c.set(color);
    p.r = _c.r; p.g = _c.g; p.b = _c.b;
    const i3 = i * 3;
    this.pPos[i3] = x; this.pPos[i3 + 1] = y; this.pPos[i3 + 2] = z;
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

  // -- emitters --------------------------------------------------------------

  muzzle(pos, dir, color, scale = 1) {
    this.flash(pos, color, 5 * scale, 34 * scale, 0.07);
    for (let i = 0; i < 5; i++) {
      coneDirection(dir, 0.5, _d);
      const s = rand(24, 70) * scale;
      this._spawn(pos.x, pos.y, pos.z, _d.x * s, _d.y * s, _d.z * s,
        rand(0.05, 0.13), rand(0.35, 0.8) * scale, color, 4.5);
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
   * The standing plume off a surface detonation: hot gas and vaporised plating
   * that leaves with the ship rather than being left behind by it.
   */
  blastPlume(pos, normal, shipVel, scale) {
    const n = Math.round(14 + scale * 3);
    for (let i = 0; i < n; i++) {
      coneDirection(normal, 0.85, _d);
      const s = rand(8, 46);
      this._spawn(pos.x, pos.y, pos.z,
        shipVel.x + _d.x * s, shipVel.y + _d.y * s, shipVel.z + _d.z * s,
        rand(0.4, 1.1), rand(0.5, 1.7) * (0.4 + scale * 0.12),
        Math.random() < 0.45 ? 0xffd9a0 : 0xff8438, 1.5);
    }
    for (let i = 0; i < n >> 1; i++) {
      coneDirection(normal, 1.1, _d);
      const s = rand(3, 20);
      this._spawn(pos.x, pos.y, pos.z,
        shipVel.x + _d.x * s, shipVel.y + _d.y * s, shipVel.z + _d.z * s,
        rand(1.2, 2.8), rand(0.8, 2.2) * (0.4 + scale * 0.12), 0x33383f, 0.9, 0.55);
    }
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
    this.flash(pos, color, collapsing ? 7 : 2.6, 46, 0.12);
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
    this.flash(pos, 0xbb7cff, 9, 120, 0.28);
  }

  beamImpact(pos, color) {
    for (let i = 0; i < 3; i++) {
      randomDirection(_d);
      const s = rand(4, 22);
      this._spawn(pos.x, pos.y, pos.z, _d.x * s, _d.y * s, _d.z * s,
        rand(0.1, 0.3), rand(0.2, 0.5), color, 2.4);
    }
    this.flash(pos, color, 2.4, 26, 0.05);
  }

  railTrail(a, b, color) {
    this._streak(a, b, color, 0.16);
  }

  smokePuff(pos, size) {
    randomDirection(_d);
    this._spawn(pos.x, pos.y, pos.z, _d.x * 2, _d.y * 2, _d.z * 2,
      rand(0.5, 1.3), size * rand(0.6, 1.4), 0x3c4450, 1.2, 0.45);
  }

  /** Fire venting out of a breached compartment, dragged by the ship's motion. */
  fireLick(pos, shipVel) {
    randomDirection(_d);
    const s = rand(4, 16);
    this._spawn(pos.x, pos.y, pos.z,
      shipVel.x + _d.x * s, shipVel.y + _d.y * s, shipVel.z + _d.z * s,
      rand(0.35, 0.9), rand(0.5, 1.6), Math.random() < 0.4 ? 0xffdc80 : 0xff6a28, 0.7);
  }

  /** Atmosphere blowing out of a hole: a cold white jet, not an explosion. */
  ventJet(pos, shipVel, strength) {
    randomDirection(_d);
    const s = rand(10, 34) * strength;
    this._spawn(pos.x, pos.y, pos.z,
      shipVel.x + _d.x * s, shipVel.y + _d.y * s, shipVel.z + _d.z * s,
      rand(0.5, 1.4), rand(0.4, 1.2), 0xcfe4f2, 0.35, 0.5);
  }

  explosion(pos, radius, color = 0xffb060) {
    const n = Math.min(150, 22 + Math.round(radius * 4));
    for (let i = 0; i < n; i++) {
      randomDirection(_d);
      const s = rand(0.25, 1) * radius * 5;
      this._spawn(pos.x, pos.y, pos.z, _d.x * s, _d.y * s, _d.z * s,
        rand(0.35, 1.2), rand(0.4, 1.4) * (radius / 8), color, 1.1);
    }
    for (let i = 0; i < n / 3; i++) {
      randomDirection(_d);
      const s = rand(0.2, 0.7) * radius * 3;
      this._spawn(pos.x, pos.y, pos.z, _d.x * s, _d.y * s, _d.z * s,
        rand(0.8, 2.2), rand(0.8, 2.4) * (radius / 8), 0x2a2f36, 0.8, 0.5);
    }
    this.flash(pos, color, 14, radius * 14, 0.35);
  }

  /** Hull fragments thrown clear of a dying ship. */
  debris(pos, vel, count, color) {
    for (let i = 0; i < count; i++) {
      randomDirection(_d);
      const s = rand(6, 40);
      this._spawn(pos.x, pos.y, pos.z,
        vel.x + _d.x * s, vel.y + _d.y * s, vel.z + _d.z * s,
        rand(2.5, 6.5), rand(0.25, 0.9), color, 0.02, 0.8);
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
      size[i] = p.size * (0.4 + 0.6 * t);
      n++;
    }
    this.pGeo.attributes.position.needsUpdate = true;
    this.pGeo.attributes.color.needsUpdate = true;
    this.pGeo.attributes.psize.needsUpdate = true;
    this.pGeo.setDrawRange(0, n > 0 ? MAX_PARTICLES : 0);

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

  clear() {
    for (const p of this.parts) {
      p.life = 0;
    }
    for (const s of this.streaks) {
      s.life = 0;
    }
    for (const f of this.flashes) {
      f.life = 0;
      f.light.intensity = 0;
    }
  }
}
