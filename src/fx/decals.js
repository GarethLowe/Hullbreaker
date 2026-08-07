// -----------------------------------------------------------------------------
// decals.js — where a ship has been hit, drawn on the ship.
//
// One sheet per hull: a single non-indexed buffer of quads that lives INSIDE
// the ship's group, so a mark is placed once in hull-local coordinates and then
// rides the hull for free — no per-frame transform, no re-projection, no
// parenting games. Positions are written when the mark is made and never
// touched again. The only thing that changes per frame is `aHeat`, and only
// while something is still glowing.
//
// A mark carries two independent quantities, because they decay on completely
// different clocks:
//
//   soot   permanent. Vaporised plating and burnt residue. It never goes away,
//          which is what makes a ship that has been in a long fight look like
//          it has been in a long fight.
//
//   heat   torn metal cools in seconds. But a hole into a pressurised
//          compartment keeps a dull ember for as long as the hole is open,
//          because the compartment behind it is lit and venting. Weld the
//          breach and it goes dark. That ember is read straight off the
//          simulation's breach state, so the glow on the outside of a hull is
//          an honest report of what is open on the inside.
// -----------------------------------------------------------------------------
import * as THREE from 'three';

/** Marks per hull. The ring recycles oldest-first once it is full. */
const MAX_DECALS = 96;
const VERTS = 6;                        // two triangles, corners duplicated

/** Lifted off the plating so it cannot z-fight with the compartment box. */
const LIFT = 0.09;

/** Seconds for torn metal to stop glowing. */
const COOL_TIME = 7.0;
/** The ember an open hole keeps regardless of how long ago it was made. */
const BREACH_EMBER = 0.34;

const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _c = new THREE.Vector3();

export class Decals {
  constructor(group) {
    this.pos = new Float32Array(MAX_DECALS * VERTS * 3);
    this.uv = new Float32Array(MAX_DECALS * VERTS * 2);
    this.heat = new Float32Array(MAX_DECALS * VERTS);
    this.soot = new Float32Array(MAX_DECALS * VERTS);
    this.seed = new Float32Array(MAX_DECALS * VERTS);

    // Corner UVs are fixed for every quad, so they are written once here and
    // never again.
    const corners = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
    for (let d = 0; d < MAX_DECALS; d++) {
      for (let v = 0; v < VERTS; v++) {
        const o = (d * VERTS + v) * 2;
        this.uv[o] = corners[v][0];
        this.uv[o + 1] = corners[v][1];
      }
    }

    /** Per-mark bookkeeping; index matches the vertex block. */
    this.marks = new Array(MAX_DECALS);
    for (let i = 0; i < MAX_DECALS; i++) {
      this.marks[i] = { live: false, age: 0, heat0: 0, section: null, hole: false };
    }
    this.head = 0;
    this.count = 0;

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2));
    g.setAttribute('aHeat', new THREE.BufferAttribute(this.heat, 1));
    g.setAttribute('aSoot', new THREE.BufferAttribute(this.soot, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));
    g.setDrawRange(0, 0);
    this.geo = g;

    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // Normal blending, not additive: a mark has to be able to DARKEN plating
      // as well as light it. Soot writes a dark colour at high alpha, glow
      // writes a bright one — same pass, opposite effect.
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      vertexShader: `
        attribute float aHeat;
        attribute float aSoot;
        attribute float aSeed;
        varying vec2 vUv;
        varying float vHeat;
        varying float vSoot;
        varying float vSeed;
        void main() {
          vUv = uv;
          vHeat = aHeat;
          vSoot = aSoot;
          vSeed = aSeed;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec2 vUv;
        varying float vHeat;
        varying float vSoot;
        varying float vSeed;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          if (r > 1.0) { discard; }
          // Nothing in a hull is a clean circle. Two sine lobes keyed off the
          // mark's seed give every hit its own torn outline for free.
          float ang = atan(p.y, p.x);
          float edge = 1.0
            - 0.20 * sin(ang * 5.0 + vSeed * 6.283)
            - 0.11 * sin(ang * 9.0 - vSeed * 11.0);
          if (r > edge) { discard; }

          float core = 1.0 - smoothstep(0.0, edge, r);
          float soot = vSoot * pow(core, 0.65);
          // The glow lives on the lip of the hole, not spread over the whole
          // burn: it is the cut edge that is hot.
          float lip = exp(-pow((r - edge * 0.55) / (edge * 0.30), 2.0));
          float glow = vHeat * (lip * 0.9 + core * 0.45);

          vec3 hot = mix(vec3(1.0, 0.24, 0.03), vec3(1.0, 0.93, 0.74),
                         clamp(vHeat, 0.0, 1.0));
          vec3 col = mix(vec3(0.021, 0.019, 0.024), hot, clamp(glow, 0.0, 1.0));
          float a = clamp(soot * 0.94 + glow, 0.0, 1.0);
          if (a < 0.004) { discard; }
          gl_FragColor = vec4(col, a);
        }`,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    group.add(this.mesh);
  }

  /**
   * Place a mark. `point` and `normal` are in HULL-LOCAL space — the caller
   * converts, because it is the only one that knows the hull's transform.
   *
   * `radius` is the scorch extent, not the hole: a slug bores half a square
   * metre but deposits vaporised plating and burns paint for metres around,
   * and that halo is the part you can actually see from two kilometres away.
   */
  add(point, normal, { radius = 2, soot = 0.8, heat = 0.6, hole = false, section = null }) {
    const i = this.head;
    this.head = (this.head + 1) % MAX_DECALS;
    this.count = Math.min(this.count + 1, MAX_DECALS);

    // Any two vectors perpendicular to the normal will do; the mark is radially
    // symmetric, and the seed supplies the variety a fixed tangent would not.
    _c.copy(normal).normalize();
    _t1.set(_c.z, _c.x, _c.y).cross(_c);
    if (_t1.lengthSq() < 1e-6) {
      _t1.set(1, 0, 0).cross(_c);
    }
    _t1.normalize();
    _t2.copy(_c).cross(_t1).normalize();

    const base = _c.multiplyScalar(LIFT).add(point);
    const seed = Math.random();
    const signs = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    for (let v = 0; v < VERTS; v++) {
      const o = (i * VERTS + v) * 3;
      const s = signs[v];
      this.pos[o] = base.x + (_t1.x * s[0] + _t2.x * s[1]) * radius;
      this.pos[o + 1] = base.y + (_t1.y * s[0] + _t2.y * s[1]) * radius;
      this.pos[o + 2] = base.z + (_t1.z * s[0] + _t2.z * s[1]) * radius;
      const k = i * VERTS + v;
      this.soot[k] = soot;
      this.heat[k] = heat;
      this.seed[k] = seed;
    }

    const m = this.marks[i];
    m.live = true;
    m.age = 0;
    m.heat0 = heat;
    m.section = section;
    m.hole = hole;

    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aSoot.needsUpdate = true;
    this.geo.attributes.aSeed.needsUpdate = true;
    this.geo.setDrawRange(0, this.count * VERTS);
    this._heatDirty = true;
  }

  /**
   * Cool everything down. `sys` is the ship's Systems, consulted so a hole that
   * is still open keeps glowing and one the crew has welded stops.
   */
  update(dt, sys) {
    let dirty = false;
    for (let i = 0; i < MAX_DECALS; i++) {
      const m = this.marks[i];
      if (!m.live) {
        continue;
      }
      m.age += dt;
      let h = m.heat0 * Math.max(0, 1 - m.age / COOL_TIME);
      if (m.hole && m.section && sys) {
        const s = sys.section(m.section);
        if (s && (s.breachSize > 0 || s.venting)) {
          h = Math.max(h, BREACH_EMBER);
        }
      }
      const k = i * VERTS;
      if (Math.abs(this.heat[k] - h) < 1e-4) {
        // Cold and staying cold: stop paying for it every frame.
        if (h <= 0) {
          m.live = false;
        }
        continue;
      }
      for (let v = 0; v < VERTS; v++) {
        this.heat[k + v] = h;
      }
      dirty = true;
    }
    if (dirty || this._heatDirty) {
      this.geo.attributes.aHeat.needsUpdate = true;
      this._heatDirty = false;
    }
  }

  dispose() {
    this.geo.dispose();
    this.mesh.material.dispose();
    if (this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }
  }
}
