// -----------------------------------------------------------------------------
// assets.js — every texture, material and geometry, generated at runtime.
//
// There are no binary assets in this repository. Hull plating, panel lines,
// glow sprites and the environment probe are all drawn into canvases at boot,
// which keeps the download to code and means a hull's palette can be derived
// from one tint value per ship class.
// -----------------------------------------------------------------------------
import * as THREE from 'three';

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

/** Star sprite: a tight core with faint diffraction spikes. */
function starTexture(size = 64) {
  const c = canvas(size);
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  g.strokeStyle = 'rgba(255,255,255,0.20)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(size / 2, 4); g.lineTo(size / 2, size - 4);
  g.moveTo(4, size / 2); g.lineTo(size - 4, size / 2);
  g.stroke();
  return new THREE.CanvasTexture(c);
}

export class Assets {
  constructor(renderer) {
    this.renderer = renderer;
    this.boxGeo = new THREE.BoxGeometry(1, 1, 1);
    this.plate = plateTexture(256);
    this.glow = glowTexture(128, 0.3);
    this.softGlow = glowTexture(128, 0.05);
    this.star = starTexture(64);
    this.scorchColor = new THREE.Color(0x14161a);
    this._env = this._buildEnvironment();
    this._hullCache = new Map();
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
    const tex = this.plate.clone();
    tex.needsUpdate = true;
    tex.repeat.set(style === 'wing' ? 2.5 : 1.6, style === 'wing' ? 2.5 : 1.6);
    const m = new THREE.MeshStandardMaterial({
      color: base.clone().multiplyScalar(style === 'wing' ? 0.72 : 0.85),
      map: tex,
      metalness: 0.82,
      roughness: style === 'engine' ? 0.62 : 0.45,
      envMap: this._env,
      envMapIntensity: 1.1,
    });
    m.userData.owned = true;
    return m;
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
