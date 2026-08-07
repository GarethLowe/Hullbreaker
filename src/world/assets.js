// -----------------------------------------------------------------------------
// assets.js — every texture, material and geometry, generated at runtime.
//
// There are no binary assets in this repository. Hull plating, panel lines,
// glow sprites and the environment probe are all drawn into canvases at boot,
// which keeps the download to code and means a hull's palette can be derived
// from one tint value per ship class.
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { WEAPONS } from '../weapons/defs.js';
import { buildMount, mountStyle, partGeometry, shellGeometry } from './hardware.js';

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

/** Plated metal: panel seams, rivet lines and a little grime. */
function plateTexture(size = 256) {
  const c = canvas(size);
  const g = c.getContext('2d');
  g.fillStyle = '#8d949b';
  g.fillRect(0, 0, size, size);

  // Broad tonal variation so large flat faces are not dead colour.
  for (let i = 0; i < 220; i++) {
    const r = 8 + Math.random() * 44;
    const a = 0.02 + Math.random() * 0.05;
    g.fillStyle = Math.random() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    g.beginPath();
    g.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2);
    g.fill();
  }
  // Panel seams on an irregular grid.
  g.strokeStyle = 'rgba(24,28,32,0.55)';
  g.lineWidth = 2;
  let x = 0;
  while (x < size) {
    x += 26 + Math.random() * 46;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, size);
    g.stroke();
  }
  let y = 0;
  while (y < size) {
    y += 30 + Math.random() * 52;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(size, y);
    g.stroke();
  }
  // Rivets.
  g.fillStyle = 'rgba(38,44,50,0.5)';
  for (let i = 0; i < 300; i++) {
    g.beginPath();
    g.arc(Math.random() * size, Math.random() * size, 1.1, 0, Math.PI * 2);
    g.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** A soft radial falloff, used for every glow sprite and particle. */
function glowTexture(size = 128, hardness = 0.25) {
  const c = canvas(size);
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, size * hardness * 0.2,
    size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(hardness, 'rgba(255,255,255,0.75)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

// A star sprite texture used to live here. It is gone: stars and dust now draw
// their own radial profile in the fragment shader. A 64 px sprite rendered into
// a 2.5 px point never samples its own core — gl_PointCoord derivatives put the
// mip LOD at ~4.7, so the shader was handed the whole-sprite average and every
// star came out a dim smudge at roughly a fifth of its intended brightness.
// A procedural profile is sharp at any size and costs no upload and no bind.

/** Every tiling rate `hullMaterial` can ask for. Built once, shared by all. */
const PLATE_REPEATS = [1.6, 2.5];

export class Assets {
  constructor(renderer) {
    this.renderer = renderer;
    this.boxGeo = new THREE.BoxGeometry(1, 1, 1);
    /** Shared by every ship's shield bubble; it was one per hull. */
    this.shieldGeo = new THREE.SphereGeometry(1, 32, 24);
    this.plate = plateTexture(256);
    this.glow = glowTexture(128, 0.3);
    this.softGlow = glowTexture(128, 0.05);
    this.scorchColor = new THREE.Color(0x14161a);
    this._env = this._buildEnvironment();
    this._hullCache = new Map();

    // Plate textures, one per tiling rate rather than one per compartment.
    //
    // `hullMaterial` used to `plate.clone()` on every call, and it is called
    // once per compartment per ship: a MERIDIAN spawned fourteen copies of the
    // same 256x256 image, each with its own uuid and therefore its own GPU
    // upload, and a four-ship wave arriving mid-fight uploaded fifty of them in
    // one frame. Only the repeat differs, and repeat is a property of the
    // texture, so two shared textures cover the whole roster.
    this._plate = new Map();
    for (const repeat of PLATE_REPEATS) {
      const t = this.plate.clone();
      t.repeat.set(repeat, repeat);
      t.needsUpdate = true;
      this._plate.set(repeat, t);
    }
  }

  /**
   * A tiny procedural environment probe. Metal with nothing to reflect reads as
   * flat grey, and a starfield alone reflects almost nothing — so the probe is
   * a simple sky gradient plus a warm key, which is what makes the hulls read
   * as machined surfaces rather than painted cardboard.
   */
  _buildEnvironment() {
    const scene = new THREE.Scene();
    const geo = new THREE.SphereGeometry(50, 24, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {},
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vDir;
        void main() {
          float up = vDir.y * 0.5 + 0.5;
          vec3 col = mix(vec3(0.015, 0.02, 0.035), vec3(0.09, 0.11, 0.16), up);
          // Warm key from one side so hulls have a lit and a shadowed flank.
          float key = pow(max(0.0, dot(vDir, normalize(vec3(0.6, 0.45, -0.4)))), 6.0);
          col += vec3(1.0, 0.78, 0.52) * key * 1.6;
          float fill = pow(max(0.0, dot(vDir, normalize(vec3(-0.7, -0.2, 0.5)))), 4.0);
          col += vec3(0.25, 0.42, 0.7) * fill * 0.35;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    scene.add(new THREE.Mesh(geo, mat));
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const target = pmrem.fromScene(scene, 0.04);
    pmrem.dispose();
    geo.dispose();
    mat.dispose();
    return target.texture;
  }

  get environment() {
    return this._env;
  }

  /**
   * One material instance per compartment: scorching mutates colour and
   * roughness in place, so sections cannot share.
   */
  hullMaterial(tint, style) {
    const base = new THREE.Color(tint);
    if (style === 'canopy') {
      const m = new THREE.MeshPhysicalMaterial({
        color: base.clone().multiplyScalar(0.25),
        metalness: 0.1,
        roughness: 0.08,
        transmission: 0.55,
        thickness: 0.6,
        envMap: this._env,
        envMapIntensity: 1.4,
      });
      m.userData.owned = true;
      return m;
    }
    const m = new THREE.MeshStandardMaterial({
      color: base.clone().multiplyScalar(style === 'wing' ? 0.72 : 0.85),
      map: this._plate.get(style === 'wing' ? 2.5 : 1.6),
      metalness: 0.82,
      roughness: style === 'engine' ? 0.62 : 0.45,
      envMap: this._env,
      envMapIntensity: 1.1,
    });
    m.userData.owned = true;
    return m;
  }

  /**
   * Force every shader program, render target and texture upload the game will
   * ever need to happen NOW, while the splash is still up.
   *
   * WebGL compiles a shader program the first time something using it is drawn,
   * and three.js allocates the transmission render target the first time a
   * transmissive material renders. Left alone that cost lands on the first
   * frame a new thing appears — the first canopy, the first shield flare, the
   * first wave of a hull class the player has not met — which is exactly when
   * the player is least able to afford a dropped frame.
   *
   * Programs are cached by feature set rather than by material instance, so
   * warming one representative of each combination covers the whole roster.
   * We build them from the real hull tables anyway: it costs a few milliseconds
   * once and it cannot go stale when a hull gains a new compartment style.
   */
  warmUp(scene, camera, hulls) {
    const warm = new THREE.Group();
    const temps = [];
    let n = 0;
    const park = (obj) => {
      // Off to one side and tiny, so the one warming frame shows nothing.
      obj.position.set(n++ * 3, -100000, 0);
      obj.scale.setScalar(0.01);
      warm.add(obj);
    };
    for (const hull of Object.values(hulls)) {
      const styles = new Set(hull.sections.map((s) => s.style));
      for (const style of styles) {
        const m = this.hullMaterial(hull.tint, style);
        temps.push(m);
        park(new THREE.Mesh(shellGeometry(style), m));
        if (style === 'canopy') {
          park(new THREE.Mesh(partGeometry('shell_canopy_glass'), m));
        }
      }
      park(new THREE.Mesh(this.boxGeo, this.greebleMaterial(hull.tint)));

      // Every mount this hull carries, in the rig the runtime will build. A
      // turret arriving mid-fight is exactly when a program compile is least
      // affordable, and the emitter materials are a distinct feature set.
      for (const def of hull.hardpoints) {
        const w = WEAPONS[def.weapon];
        if (!w) {
          continue;
        }
        const rig = buildMount(this, hull.tint, w, mountStyle(w, def.arc), 1);
        rig.root.traverse((o) => {
          if (o.material && o.material.userData.owned) {
            temps.push(o.material);
          }
        });
        park(rig.root);
      }

      const sprite = new THREE.Sprite(this.driveMaterial(hull.tint));
      temps.push(sprite.material);
      park(sprite);
    }
    scene.add(warm);
    // compile() walks only what is visible, so this has to happen before the
    // group comes back out.
    this.renderer.compile(scene, camera);
    // And an actual draw, because compile() does not allocate the transmission
    // buffer that the canopies need — that is created on first real render.
    this.renderer.render(scene, camera);
    scene.remove(warm);
    for (const m of temps) {
      m.dispose();
    }
    return n;
  }

  greebleMaterial(tint) {
    const key = `g${tint}`;
    let m = this._hullCache.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color: new THREE.Color(tint).multiplyScalar(0.42),
        metalness: 0.9,
        roughness: 0.55,
        envMap: this._env,
        envMapIntensity: 0.9,
      });
      this._hullCache.set(key, m);
    }
    return m;
  }

  /**
   * Gun metal: colder and rougher than the plating it stands on, so a turret
   * reads as a separate machine bolted to the ship rather than as a lump of the
   * same casting. Shared per tint — hardware never scorches, so unlike the hull
   * sections it does not need an instance each.
   */
  gunMaterial(tint) {
    const key = `w${tint}`;
    let m = this._hullCache.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color: new THREE.Color(tint).lerp(new THREE.Color(0x6d747c), 0.62)
          .multiplyScalar(0.72),
        metalness: 0.95,
        roughness: 0.38,
        envMap: this._env,
        envMapIntensity: 1.25,
      });
      this._hullCache.set(key, m);
    }
    return m;
  }

  /**
   * The lit part of a weapon — a beam's throat, an ion cage, a plasma bell.
   * One instance per mount rather than one per colour, because `emissiveIntensity`
   * is driven by what that particular gun is doing: charged mounts idle warm and
   * a firing mount goes white.
   */
  emitterMaterial(color) {
    const m = new THREE.MeshStandardMaterial({
      color: 0x05070a,
      emissive: new THREE.Color(color),
      emissiveIntensity: 0.9,
      metalness: 0.2,
      roughness: 0.5,
      envMap: this._env,
      envMapIntensity: 0.4,
    });
    m.userData.owned = true;
    return m;
  }

  /**
   * Material lookup for a kit part. Only mounts come through here, so the
   * only mats it ever sees are the three below — shells are built directly.
   */
  kitMaterial(kind, tint, weapon) {
    if (kind === 'gunDark') {
      return this.greebleMaterial(tint);
    }
    if (kind === 'glow') {
      return this.emitterMaterial(weapon.tracer);
    }
    return this.gunMaterial(tint);
  }

  driveMaterial(tint) {
    const m = new THREE.SpriteMaterial({
      map: this.softGlow,
      color: new THREE.Color(tint).lerp(new THREE.Color(0x9fd4ff), 0.6),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0.8,
    });
    m.userData.owned = true;
    return m;
  }

  particleMaterial(size, texture, opacity = 1) {
    return new THREE.PointsMaterial({
      size,
      map: texture || this.glow,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      sizeAttenuation: true,
    });
  }
}
