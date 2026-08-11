// -----------------------------------------------------------------------------
// space.js — the volume the fight happens in.
//
// Empty space is a terrible place to fly, because with nothing nearby the eye
// gets no parallax and the ship feels stationary no matter how fast it is
// going. Four layers fix that without cluttering the sky:
//
//   SKY     a vertex-painted backdrop, Homeworld's technique rather than a
//           texture. See `skyColour`.
//   STARS   fixed to the camera's translation, so they only ever rotate. They
//           give attitude reference and nothing else — and they are razor-sharp
//           pinpricks on purpose, because that contrast against the soft
//           painted sky is most of why the two layers read as separate things.
//   DUST    two nested cubes of motes that WRAP around the camera modulo their
//           size. This is the entire reason the ship feels like it is moving,
//           and the velocity gradient between the near and far shell is what
//           the eye reads as depth.
//   LIGHT   a key and a fill, aimed to agree with where the sky is brightest.
//
// The Homeworld part is worth stating plainly, because it is a technique and
// not a look: Relic's backgrounds were never skybox textures. They were
// camera-centred, vertex-coloured, adaptively-tessellated spheres drawn with
// depth test and lighting off, with an additive star layer on top. Hardware
// Gouraud interpolation gives perfectly smooth wide gradients with no texture
// bandwidth and — the real reason — none of the block-compression contouring
// that destroys a slow gradient the moment you put it in a DXT cubemap.
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { rand, clamp, smoothstep } from '../core/mathx.js';
import { ENGAGEMENT_RANGE } from '../ship/hulls.js';

/**
 * How far a mote of unit `size` stays at full size: `gl_PointSize` is
 * `aSize * dpr * DUST_REACH / dist`, clamped into DUST_FLOOR_PX..3.5. Exported
 * because the size ladder below is only correct in relation to it, and the
 * selfcheck holds the two together — see `size` there.
 */
export const DUST_REACH = 700;
/** Size floor, in device px. Below it a radial profile scintillates. */
export const DUST_FLOOR_PX = 2.0;

/**
 * Half-extents of the two dust cubes. Motes wrap when they leave them.
 *
 * `bright` overdrives past 1.0 on purpose. A mote is two or three pixels of
 * additive blend against a sky that already sits at luminance 38, and at the
 * old 1.0/0.45 the whole layer moved the 99.9th percentile of the frame by ten
 * levels out of 255 between a standstill and full boost — the sense of speed
 * was there, but you had to know to look for it. The headroom goes into the
 * bright tail rather than the floor, so the field gains contrast instead of
 * turning into grey haze.
 *
 * `size` and `count` are the two that were wrong, and raising `bright` could
 * never have fixed either. Measured by rendering the frame twice, motes in and
 * motes out, and differencing: at 0.5/24000 the layer lit 0.31% of the frame at
 * cruise and moved the median lit pixel by FOUR levels out of 255 over a sky at
 * 37. That is not a dim dust field, it is no dust field.
 *
 * Both terms failed for the same reason, which is `size` rather than `count`:
 * at 0.5 a mote hit full size only within about 100 m, and the near shell runs
 * to 1300, so effectively the entire field sat pinned at the DUST_FLOOR_PX
 * floor paying the `fine` shrink penalty on top. Nearly every mote was the
 * dimmest, smallest thing the shader can draw. 2.8 puts a median mote at full
 * size all the way out to where its own radial fade starts, which is what the
 * clamp ceiling is there to make safe — nothing gets blobbier, the field just
 * stops being uniformly starved.
 *
 * Shrinking the spans instead does NOT work, and it is worth writing down: the
 * motes inside the frustum go as count x (span^3 / span^3), so a tighter cube
 * buys density and loses exactly as much visible volume. Measured, span 1300 ->
 * 520 moved coverage 0.31% -> 0.37%. Only `count` moves coverage.
 *
 * Together: 2.11% of the frame lit at cruise against 0.31%, median lit pixel 7
 * against 4, 90th percentile 71 against 32. Cost is nil — these are 2-3.5 px
 * points with an early discard, and the layer measured under 0.1 ms of a frame
 * at 124k motes. At a standstill the speed gate still holds the median lit
 * pixel at 2 levels, so a parked ship sees stars and nothing else.
 */
export const DUST_NEAR = { span: 1300, count: 96000, size: 2.8, bright: 2.1 };
export const DUST_FAR = { span: 5200, count: 28000, size: 6.0, bright: 1.05 };

const STAR_COUNT = 2200;

// -----------------------------------------------------------------------------
// The backdrop ladder. These five numbers only work as a set, and until now they
// were independent literals in two files with nothing stating the relationship —
// so raising ENGAGEMENT_RANGE would have quietly started punching ships through
// the starfield with no error anywhere. Derive them, and let the selfcheck hold
// the ordering.
//
//   near  <  ENGAGEMENT_RANGE  <  STAR_SHELL  <  SKY_SHELL  <  far
//
// Both shells are re-centred on the camera every frame, so they are unreachable
// by construction: fly at the sky forever and it moves with you. What the
// numbers buy is the two things being camera-locked does NOT give you —
//
//   STAR_SHELL > anything solid, because stars are depth-TESTED (see the star
//     material). A ship further out than the shell would punch through the sky.
//     12x engagement range is roughly 4x the furthest spawn.
//   SKY_SHELL  < far, because depth testing being off does not exempt a vertex
//     from being clipped against the far plane. A sky outside the frustum is
//     not an unreachable sky, it is no sky at all.
// -----------------------------------------------------------------------------
export const STAR_SHELL = ENGAGEMENT_RANGE * 12;
export const SKY_SHELL = STAR_SHELL * 1.4;
/** Camera planes, owned here because the backdrop is what constrains them. */
export const CAMERA_NEAR = 2.0;
export const CAMERA_FAR = SKY_SHELL * 2.0;
/** 20*(detail+1)^2 triangles: 14 gives 4500, an edge of about 4.2 degrees. */
const SKY_DETAIL = 14;

/**
 * Where the light comes from. One constant feeds the key light, the sky's
 * brightest nebula lobe and the environment probe, because a painted sky whose
 * bright side disagrees with the lighting reads as wrong without ever looking
 * obviously broken.
 */
export const SUN = new THREE.Vector3(0.6, 0.45, -0.4).normalize();
const FILL = new THREE.Vector3(-0.7, -0.2, 0.5).normalize();
/** The sky's own "up". Deliberately not world Y, so the gradient reads as a
 *  composition rather than as a horizon. */
export const SKY_AXIS = new THREE.Vector3(0.25, 1.0, -0.35).normalize();

/**
 * Palettes, authored as FINAL SCREEN sRGB.
 *
 * Relic's own rule, and the most-missed part of the look: the sky is dark.
 * Their pipeline pulled the painted image's output levels from 255 down to 128
 * before conversion because the engine brightened the result, so the brightest
 * region of a Homeworld sky sits around mid-grey and most of the sphere is
 * near-black. A bright sky does not read as Homeworld, and — for this game —
 * a bright sky is also one you cannot see a grey warship silhouetted against.
 */
export const MOODS = {
  hiigaran: {
    void: 0x04060b, deep: 0x081522, mid: 0x0e2f45,
    lobe: 0x1a6270, hot: 0x37a89e, band: 0x123c56, star: 0xdcecff,
  },
  gehenna: {
    void: 0x080503, deep: 0x190c05, mid: 0x3a1c0b,
    lobe: 0x78380f, hot: 0xc47c2a, band: 0x28130a, star: 0xffe8cc,
  },
  balcora: {
    void: 0x06050d, deep: 0x130c1f, mid: 0x2b1340,
    lobe: 0x562060, hot: 0x9a3e7c, band: 0x1c0f2e, star: 0xf2e2ff,
  },
  karos: {
    void: 0x050706, deep: 0x0d1410, mid: 0x1c2a1d,
    lobe: 0x3b4a25, hot: 0x7d7c3c, band: 0x16211a, star: 0xe8f0d8,
  },
};

const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];

/**
 * The sky, as a function of direction. Three ingredients, in the order they
 * matter: a dominant directional gradient that gives the whole sphere a top and
 * a bottom, one soft band across it for a galactic plane, and a few very broad
 * lobes for the nebula masses. Structure first; the exact hexes are the least
 * important part.
 *
 * Mixed in 0-255 sRGB and converted ONCE at the end. Ramping with Color.lerp
 * instead mixes in linear space, which drags every mid-ramp colour darker and
 * flatter than the palette implies and is the usual reason a hand-picked set of
 * colours comes out muddy.
 */
export function skyColour(dir, mood, out) {
  const P = mood._rgb;
  const t = smoothstep(0, 1, dir.dot(SKY_AXIS) * 0.5 + 0.5);

  // 1. Dominant gradient, void -> deep -> mid across the whole sphere.
  let a;
  let b;
  let f;
  if (t < 0.55) {
    a = P.void; b = P.deep; f = t / 0.55;
  } else {
    a = P.deep; b = P.mid; f = (t - 0.55) / 0.45;
  }
  let r = a[0] + (b[0] - a[0]) * f;
  let g = a[1] + (b[1] - a[1]) * f;
  let bl = a[2] + (b[2] - a[2]) * f;

  // 2. A soft band around the sky's equator. Gaussian on the axis dot, NOT
  //    (1-|dot|)^k — the absolute value puts a derivative kink exactly at the
  //    equator, which Gouraud interpolation renders as a hard crease right
  //    through the middle of the sky and which was most of the measured
  //    contouring. A Gaussian is smooth everywhere; the width is the knob.
  //    The centre line is WARPED rather than being a true great circle, and
  //    that one term is most of what separates a painted sky from an obviously
  //    procedural one — an unwarped band is a perfect ring the eye reads as a
  //    equator immediately. Low frequency on purpose: the mesh has ~5 degree
  //    edges, so anything tighter aliases into faceting instead of meandering.
  //    Width and warp trade off directly: the Gaussian's steepest slope goes as
  //    1/sigma, and the warp adds its own slope on top, so a tight band cannot
  //    also be a wandering one without contouring. 0.30 rad is the widest the
  //    band can be and still read as a lane rather than as the gradient.
  const bd = dir.dot(SKY_AXIS)
    + 0.14 * Math.sin(dir.x * 2.4 + dir.z * 1.7)
    + 0.06 * Math.sin(dir.y * 3.3 - dir.x * 2.1);
  const band = Math.exp(-(bd * bd) / (2 * 0.30 * 0.30)) * 0.55;
  r += P.band[0] * band;
  g += P.band[1] * band;
  bl += P.band[2] * band;

  // 3. Nebula masses. Very broad and very few: three lobes is a composition,
  //    a dozen is noise. The first sits on SUN so the sky is brightest where
  //    the key light comes from; the third answers it with the fill's hue so
  //    the sphere has a counterweight instead of one lit side and nothing.
  //    Amplitudes are deliberately low. At the old 0.95 the hot lobe alone put
  //    ~160 on top of a ~45 base, so green clamped at 255 and the sky's bright
  //    side came out near-white — a warship has nothing to silhouette against,
  //    and the clamped plateau kills the gradient the technique exists for.
  const l1 = Math.max(0, dir.dot(SUN)) ** 3.0 * 0.34;
  const l2 = Math.max(0, dir.dot(SKY_AXIS)) ** 6.0 * 0.34;
  const l3 = Math.max(0, dir.dot(FILL)) ** 4.0 * 0.28;
  r += P.hot[0] * l1 + P.lobe[0] * l2 + P.lobe[0] * l3 * 0.7;
  g += P.hot[1] * l1 + P.lobe[1] * l2 + P.lobe[1] * l3 * 0.7;
  bl += P.hot[2] * l1 + P.lobe[2] * l2 + P.lobe[2] * l3 * 0.7;

  // 4. A little large-scale wobble, so the lobes do not read as three perfect
  //    cosine blobs. Low frequency only — anything fine would need vertices
  //    this mesh does not have and would alias into faceting.
  const w = Math.sin(dir.x * 2.7 + dir.y * 1.9)
    * Math.sin(dir.z * 2.3 - dir.y * 1.4) * 7.0;
  r += w; g += w * 0.9; bl += w * 1.1;

  return out.setRGB(
    clamp(r, 0, 255) / 255,
    clamp(g, 0, 255) / 255,
    clamp(bl, 0, 255) / 255,
    THREE.SRGBColorSpace,
  );
}

for (const m of Object.values(MOODS)) {
  m._rgb = {
    void: rgb(m.void), deep: rgb(m.deep), mid: rgb(m.mid),
    lobe: rgb(m.lobe), hot: rgb(m.hot), band: rgb(m.band),
  };
}

// Stars and dust share a profile: a procedural radial falloff rather than a
// sprite. A 64 px sprite drawn into a 2.5 px quad never samples its own core —
// the mip chain hands the shader the whole-sprite average, which is why the old
// starfield was a field of dim smudges at about a fifth of its intended
// brightness. Generated in the shader, a point is sharp at any size.
const POINT_FRAG = `
  uniform float uTight;
  varying vec3 vCol;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = exp2(-uTight * d * d);
    if (a < 0.004) { discard; }
    gl_FragColor = vec4(vCol, a * vAlpha);
    #include <colorspace_fragment>
  }`;

export class Space {
  constructor(game, moodId = 'hiigaran') {
    this.game = game;
    const scene = game.scene;
    const mood = MOODS[moodId] || MOODS.hiigaran;
    this.mood = mood;
    const dpr = game.renderer.getPixelRatio();

    scene.environment = game.assets.environment;

    // -- painted sky -----------------------------------------------------------
    // An icosphere, not a UV sphere: uniform triangle size in every direction,
    // no pole pinch and no seam, so the interpolation error is the same
    // whichever way you are pointing. The geometry is non-indexed, which is
    // harmless here — the colour is a pure function of the direction, so the
    // duplicated corners all get byte-identical values and the surface stays
    // continuous.
    const skyGeo = new THREE.IcosahedronGeometry(SKY_SHELL, SKY_DETAIL);
    skyGeo.deleteAttribute('uv');
    skyGeo.deleteAttribute('normal');
    const sp = skyGeo.attributes.position;
    const skyCol = new Float32Array(sp.count * 3);
    const dir = new THREE.Vector3();
    const col = new THREE.Color();
    for (let i = 0; i < sp.count; i++) {
      dir.fromBufferAttribute(sp, i).normalize();
      skyColour(dir, mood, col);
      skyCol[i * 3] = col.r;
      skyCol[i * 3 + 1] = col.g;
      skyCol[i * 3 + 2] = col.b;
    }
    skyGeo.setAttribute('color', new THREE.BufferAttribute(skyCol, 3));

    this.sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({
      vertexColors: true,
      // Inside the shell, looking out.
      side: THREE.BackSide,
      // depthTest OFF because the shell is centred on the camera, so with
      // testing on it sorts ahead of anything further away than its radius and
      // paints over it — every contact beyond ~11 km would vanish while the
      // radar still reported it. depthWrite OFF so it leaves the buffer clear.
      depthWrite: false,
      depthTest: false,
      // Material.fog defaults TRUE and would tint the backdrop.
      fog: false,
      // Mandatory. main.js sets ACESFilmicToneMapping at exposure 1.15, and
      // ACES applied to a hand-picked dark palette lifts the blacks and
      // desaturates the mid-tones — you pick a colour and get a different one,
      // and correcting by eye means fighting the curve forever. A painted
      // backdrop is a flat matte, not a physically lit surface.
      toneMapped: false,
      // The defining failure of wide gradients on an 8-bit output is banding:
      // a ramp crossing 30 levels over 900 px shows 30 contours. three's built
      // in dither is applied after the colour-space encode, which is the only
      // correct place for it.
      dithering: true,
      // NOT `transparent`. It writes alpha 1.0, and three renders the
      // transparent list AFTER the opaque one while renderOrder only sorts
      // within a list — flagged transparent with depth testing off, this shell
      // drew last, over everything, and every frame was pure nebula.
    }));
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    scene.add(this.sky);

    // -- stars -----------------------------------------------------------------
    const starPos = new Float32Array(STAR_COUNT * 3);
    const starCol = new Float32Array(STAR_COUNT * 3);
    const starSize = new Float32Array(STAR_COUNT);
    const tint = new THREE.Color(mood.star);
    const c = new THREE.Color();
    for (let i = 0; i < STAR_COUNT; i++) {
      // Uniform on the sphere, so the sky is not clumped at the poles.
      const z = rand(-1, 1);
      const ang = rand(0, Math.PI * 2);
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      starPos[i * 3] = r * Math.cos(ang) * STAR_SHELL;
      starPos[i * 3 + 1] = z * STAR_SHELL;
      starPos[i * 3 + 2] = r * Math.sin(ang) * STAR_SHELL;

      // ONE heavy-tailed draw drives both size and brightness, because big
      // stars are bright stars and drawing them independently gives you fat
      // dim ones that read as dirt on the screen.
      const u = Math.random();
      starSize[i] = 1.1 + u ** 3.2 * 4.4;
      const lum = 0.10 + u ** 2.4 * 0.90;
      // A believable spread of stellar colour, pulled toward the mood's tint so
      // the field belongs to the sky it sits on.
      c.setHSL(Math.random() < 0.72 ? rand(0.55, 0.64) : rand(0.04, 0.12),
        rand(0.05, 0.5), 0.5 + rand(0, 0.35));
      c.lerp(tint, 0.35).multiplyScalar(lum);
      starCol[i * 3] = c.r;
      starCol[i * 3 + 1] = c.g;
      starCol[i * 3 + 2] = c.b;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(starCol, 3));
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(starSize, 1));

    this.stars = new THREE.Points(starGeo, new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // depthTest ON, unlike the sky. `transparent` puts this layer in the
      // TRANSPARENT list, which three draws AFTER the whole opaque list —
      // renderOrder only sorts within a list, so a renderOrder of -999 does not
      // get it in front of the ships. With testing off it therefore blended
      // additively over every hull on screen, and a cruiser at knife range had
      // a couple of hundred stars crawling across its armour. The shell sits at
      // 90 km, well inside the 260 km far plane, and the sky leaves the depth
      // buffer clear, so with testing on stars still fill the empty sky and are
      // simply occluded by anything solid.
      depthTest: true,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      uniforms: {
        uPixelRatio: { value: dpr },
        // 20 puts the visible edge at about 0.47 of the quad: a ~1.6 px dot
        // inside a 7 px quad. Fineness comes from the falloff, not from
        // shrinking the quad — below about 4 device px a radial profile
        // scintillates badly as it slides across the pixel grid.
        uTight: { value: 20.0 },
      },
      vertexShader: `
        attribute float aSize;
        uniform float uPixelRatio;
        varying vec3 vCol;
        varying float vAlpha;
        void main() {
          vCol = color;
          // No size attenuation: a star is a point source at infinity with no
          // angular size, so its magnitude belongs entirely in brightness.
          // Attenuation also divides by view-space z rather than by distance,
          // which made stars 1.7x fatter in the screen corners than at the
          // centre — a sky that got visibly blobbier toward the edges.
          float px = max(aSize * uPixelRatio, 4.0);
          gl_PointSize = px;
          vAlpha = min(1.0, aSize * uPixelRatio / 4.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: POINT_FRAG,
    }));
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -999;
    scene.add(this.stars);

    // -- dust ------------------------------------------------------------------
    this.shells = [DUST_NEAR, DUST_FAR].map((spec) => this._makeDust(spec, dpr, scene));

    // -- light -----------------------------------------------------------------
    // Aimed to agree with the sky: the key comes from SUN, which is also where
    // the brightest nebula lobe was painted.
    this.key = new THREE.DirectionalLight(0xffe4c4, 2.4);
    this.key.position.copy(SUN).multiplyScalar(1000);
    scene.add(this.key);
    this.fill = new THREE.DirectionalLight(0x6fa8ff, 0.55);
    this.fill.position.copy(FILL).multiplyScalar(1000);
    scene.add(this.fill);
    scene.add(new THREE.AmbientLight(0x38414d, 0.7));
  }

  _makeDust(spec, dpr, scene) {
    const pos = new Float32Array(spec.count * 3);
    const colour = new Float32Array(spec.count * 3);
    const size = new Float32Array(spec.count);
    for (let i = 0; i < spec.count; i++) {
      pos[i * 3] = rand(-spec.span, spec.span);
      pos[i * 3 + 1] = rand(-spec.span, spec.span);
      pos[i * 3 + 2] = rand(-spec.span, spec.span);
      // Wider spread than the old 0.35..1.0. Contrast is the point: a field
      // where every mote is the same middling grey reads as film grain however
      // bright it is, and a field with a dim majority and a sparse bright few
      // reads as depth.
      const b = rand(0.18, 1.0) * spec.bright;
      colour[i * 3] = b * 0.80;
      colour[i * 3 + 1] = b * 0.88;
      colour[i * 3 + 2] = b;
      size[i] = spec.size * rand(0.6, 1.5);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colour, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      uniforms: {
        uPixelRatio: { value: dpr },
        // 14, near the stars' 20: dust should be grain, not cotton wool. At the
        // old 5.0 the profile was still at 42% alpha out at the quad edge, so
        // every mote was a soft ball the full width of its quad.
        uTight: { value: 14.0 },
        uSpeed: { value: 0 },
        uSpan: { value: spec.span },
      },
      vertexShader: `
        attribute float aSize;
        uniform float uPixelRatio;
        uniform float uSpeed;
        uniform float uSpan;
        varying vec3 vCol;
        varying float vAlpha;
        void main() {
          vCol = color;
          // The wrap. The object is parked ON the camera, so modelMatrix's
          // translation IS the camera, and rel is the mote's offset from it,
          // folded back into the cube. A mote that falls off the back reappears
          // at the front, so a finite buffer looks like an infinite field and
          // the parallax never runs out however far you fly.
          //
          // Read from modelMatrix rather than the built-in cameraPosition on
          // purpose: the HUD renders this same scene a second time through the
          // target-view camera, and cameraPosition would wrap that pass around
          // a different point than the one the object is parked at.
          vec3 cam = modelMatrix[3].xyz;
          vec3 rel = mod(position - cam + uSpan, 2.0 * uSpan) - uSpan;
          vec4 mv = modelViewMatrix * vec4(rel, 1.0);
          // RADIAL distance, not -mv.z. View-space z is the depth of the plane
          // the mote sits on, so at the edge of a 68-degree frustum it reads
          // about 77% of the true range and the mote comes out ~30% fat. The
          // star shader's comment already calls this out as what made stars
          // blobbier toward the screen corners; the dust had the same flaw.
          float dist = max(length(mv.xyz), 1.0);
          // Attenuated, because dust is near-field and has to have depth — but
          // CLAMPED into a narrow band, because an unclamped mote a few metres
          // off the canopy became a forty-pixel soft blob, which is most of
          // what "blobby" meant. 3.5 px is the ceiling now: past that a mote
          // stops reading as a speck of grit and starts reading as an object.
          float raw = aSize * uPixelRatio * ${DUST_REACH.toFixed(1)} / dist;
          gl_PointSize = clamp(raw, ${DUST_FLOOR_PX.toFixed(1)}, 3.5);
          // Below the floor a radial profile scintillates violently as it
          // crawls across the pixel grid, so hold the size there and spend the
          // remaining shrink on alpha instead. sqrt keeps the deep field
          // populated rather than collapsing to a handful of near motes.
          float fine = sqrt(min(1.0, raw / ${DUST_FLOOR_PX.toFixed(1)}));
          // Fade in from the near plane so motes do not pop into existence
          // bright, and out at the shell edge so the cube has no visible wall.
          float near = smoothstep(0.0, 90.0, dist);
          // 0.72, not 0.55. The cube is a cube but the fade is radial, so the
          // old figure began dimming motes barely past half the shell and threw
          // away most of the field before it ever reached the frustum: only
          // four hundredths of one per cent of the frame was ever lit by dust.
          float far = 1.0 - smoothstep(uSpan * 0.72, uSpan, dist);
          // Nearly invisible at rest, blazing past under way. Speed is what the
          // layer is FOR; at a constant brightness it is just confetti. The
          // floor drops as the ceiling rises, so overdriving the per-mote
          // brightness buys contrast under way without lighting a parked ship.
          vAlpha = fine * near * far * (0.07 + 0.93 * uSpeed);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: POINT_FRAG,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    scene.add(points);
    return { points, mat };
  }

  /** Wrap a mote offset into the cube, the JS mirror of the vertex shader's
   *  `mod`. Only the selfcheck calls it — it exists so the one piece of load
   *  bearing logic that lives in GLSL still has an assertion behind it. */
  static wrap(d, span) {
    return d - 2 * span * Math.floor((d + span) / (2 * span));
  }

  /** Keeps all three backdrop layers centred on the camera. */
  update(cameraPos) {
    this.stars.position.copy(cameraPos);
    this.sky.position.copy(cameraPos);

    // Dust brightness tracks how fast the ship is actually going, against the
    // fastest thing in the roster so the cue means the same in every hull.
    const ship = this.game.player ? this.game.player.ship : null;
    const speed = ship ? ship.body.vel.length() : 0;
    const ref = ship ? Math.max(ship.hull.flight.boostSpeed, 1) : 1;
    const s = Math.min(1, speed / ref);

    for (const shell of this.shells) {
      shell.mat.uniforms.uSpeed.value = s;
      shell.points.position.copy(cameraPos);
    }
  }
}
