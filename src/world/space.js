// -----------------------------------------------------------------------------
// space.js — the volume the fight happens in.
//
// Empty space is a terrible place to fly, because with nothing nearby the eye
// gets no parallax and the ship feels stationary no matter how fast it is
// going. Three layers fix that without cluttering the sky:
//
//   STARS   fixed to the camera's translation, so they only ever rotate. They
//           give attitude reference and nothing else.
//   DUST    a cube of motes that WRAPS around the camera modulo the cube size.
//           A few thousand points, close enough to streak past — this is the
//           entire reason the ship feels like it is moving. Subtle on purpose:
//           you should notice the speed, not the confetti.
//   HAZE    a distant nebula gradient, purely so the black has structure.
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { rand } from '../core/mathx.js';

/** Half-extent of the dust cube. Motes wrap when they leave it. */
const DUST_SPAN = 1400;
const DUST_COUNT = 3400;
const STAR_COUNT = 2200;
const STAR_SHELL = 90000;

export class Space {
  constructor(game) {
    this.game = game;
    const scene = game.scene;

    scene.environment = game.assets.environment;

    // -- stars ---------------------------------------------------------------
    const starPos = new Float32Array(STAR_COUNT * 3);
    const starCol = new Float32Array(STAR_COUNT * 3);
    const c = new THREE.Color();
    for (let i = 0; i < STAR_COUNT; i++) {
      // Uniform on the sphere, so the sky is not clumped at the poles.
      const z = rand(-1, 1);
      const a = rand(0, Math.PI * 2);
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      starPos[i * 3] = r * Math.cos(a) * STAR_SHELL;
      starPos[i * 3 + 1] = z * STAR_SHELL;
      starPos[i * 3 + 2] = r * Math.sin(a) * STAR_SHELL;
      // A believable spread of stellar colours, weighted to the dim and white.
      const t = Math.random();
      c.setHSL(t < 0.7 ? rand(0.55, 0.62) : rand(0.05, 0.12), rand(0.1, 0.55),
        rand(0.35, 0.95));
      const b = Math.pow(Math.random(), 2.2) * 0.9 + 0.1;
      starCol[i * 3] = c.r * b;
      starCol[i * 3 + 1] = c.g * b;
      starCol[i * 3 + 2] = c.b * b;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(starCol, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      size: 210,
      map: game.assets.star,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      sizeAttenuation: true,
    }));
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -999;
    scene.add(this.stars);

    // -- nebula haze ---------------------------------------------------------
    this.haze = new THREE.Mesh(
      new THREE.SphereGeometry(STAR_SHELL * 1.4, 32, 20),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        // A backdrop: it must draw behind everything and occlude nothing.
        //
        // depthTest OFF because the shell is centred on the camera, so with
        // testing on it sorts ahead of anything further away than its radius
        // and paints over it — every contact beyond ~11 km would vanish while
        // the radar still reported it. depthWrite OFF so it leaves the buffer
        // clear for the real scene.
        //
        // And NOT `transparent`. It writes alpha 1.0, so the flag was wrong on
        // its face, but the cost was worse than untidy: three.js renders the
        // transparent list AFTER the opaque one, and renderOrder only sorts
        // within a list. Flagged transparent, this shell drew last, with depth
        // testing off, over the entire scene — every frame was pure nebula.
        depthWrite: false,
        depthTest: false,
        uniforms: {},
        vertexShader: `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          varying vec3 vDir;
          // Cheap value noise: three rotated sine layers. Nobody is going to
          // look closely at a backdrop, and a real fBm here would cost more
          // than the whole dust field.
          float band(vec3 d, vec3 axis, float f) {
            return sin(dot(d, normalize(axis)) * f);
          }
          void main() {
            float n = band(vDir, vec3(1.0, 0.3, 0.2), 3.1)
                    + band(vDir, vec3(-0.4, 1.0, 0.6), 5.3) * 0.6
                    + band(vDir, vec3(0.2, -0.5, 1.0), 8.7) * 0.3;
            n = n * 0.35 + 0.5;
            vec3 cool = vec3(0.05, 0.09, 0.20);
            vec3 warm = vec3(0.20, 0.08, 0.16);
            vec3 col = mix(cool, warm, smoothstep(0.35, 0.85, n)) * pow(n, 2.0);
            gl_FragColor = vec4(col, 1.0);
          }`,
      }),
    );
    this.haze.frustumCulled = false;
    this.haze.renderOrder = -1000;
    scene.add(this.haze);

    // -- dust ----------------------------------------------------------------
    this.dustPos = new Float32Array(DUST_COUNT * 3);
    const dustCol = new Float32Array(DUST_COUNT * 3);
    for (let i = 0; i < DUST_COUNT; i++) {
      this.dustPos[i * 3] = rand(-DUST_SPAN, DUST_SPAN);
      this.dustPos[i * 3 + 1] = rand(-DUST_SPAN, DUST_SPAN);
      this.dustPos[i * 3 + 2] = rand(-DUST_SPAN, DUST_SPAN);
      const b = rand(0.10, 0.42);
      dustCol[i * 3] = b * 0.82;
      dustCol[i * 3 + 1] = b * 0.90;
      dustCol[i * 3 + 2] = b;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(this.dustPos, 3));
    dustGeo.setAttribute('color', new THREE.BufferAttribute(dustCol, 3));
    this.dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
      size: 1.9,
      map: game.assets.glow,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      sizeAttenuation: true,
    }));
    this.dust.frustumCulled = false;
    scene.add(this.dust);
    this._dustOrigin = new THREE.Vector3();

    // -- light ---------------------------------------------------------------
    // One distant key from the same direction the environment probe puts its
    // warm lobe, plus a cool fill, so lit and shadowed flanks agree with the
    // reflections.
    this.key = new THREE.DirectionalLight(0xffe4c4, 2.4);
    this.key.position.set(0.6, 0.45, -0.4).normalize().multiplyScalar(1000);
    scene.add(this.key);
    this.fill = new THREE.DirectionalLight(0x6fa8ff, 0.55);
    this.fill.position.set(-0.7, -0.2, 0.5).normalize().multiplyScalar(1000);
    scene.add(this.fill);
    scene.add(new THREE.AmbientLight(0x38414d, 0.7));
  }

  /**
   * Keeps the backdrop centred on the camera and wraps the dust cube around it.
   * The modulo is the whole trick: a mote that falls off the back of the cube
   * reappears at the front, so a finite buffer looks like an infinite field and
   * the parallax never runs out however far you fly.
   */
  update(cameraPos) {
    this.stars.position.copy(cameraPos);
    this.haze.position.copy(cameraPos);

    const span = DUST_SPAN;
    const two = span * 2;
    const p = this.dustPos;
    const ox = cameraPos.x;
    const oy = cameraPos.y;
    const oz = cameraPos.z;
    let moved = false;
    for (let i = 0; i < DUST_COUNT; i++) {
      const i3 = i * 3;
      let dx = p[i3] - ox;
      let dy = p[i3 + 1] - oy;
      let dz = p[i3 + 2] - oz;
      if (dx > span || dx < -span) {
        p[i3] = ox + ((((dx + span) % two) + two) % two) - span;
        moved = true;
      }
      if (dy > span || dy < -span) {
        p[i3 + 1] = oy + ((((dy + span) % two) + two) % two) - span;
        moved = true;
      }
      if (dz > span || dz < -span) {
        p[i3 + 2] = oz + ((((dz + span) % two) + two) % two) - span;
        moved = true;
      }
    }
    if (moved) {
      this.dust.geometry.attributes.position.needsUpdate = true;
    }
  }
}

export { DUST_SPAN };
