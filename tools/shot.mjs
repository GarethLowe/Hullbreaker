// -----------------------------------------------------------------------------
// shot.mjs — photograph the running game.
//
//     npm run dev
//     node tools/shot.mjs out.png [--view bow|quarter|beam] [--fire] [--enemies]
//
// A WebGL scene cannot be reviewed from a diff or a unit test, and the hull
// shells and weapon rigs are the sort of thing that is either obviously right or
// obviously wrong the moment you look at it. This drives a headless Chromium at
// the dev server, moves the chase camera somewhere useful, optionally holds the
// triggers so the guns are caught recoiling, and saves a frame.
//
// SwiftShader, not the GPU: the point is a picture that always renders, not one
// that renders fast.
// -----------------------------------------------------------------------------
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const out = args[0];
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
if (!out) {
  console.error('usage: node tools/shot.mjs out.png [--view bow|quarter|beam] '
    + '[--hull ID] [--fire] [--enemy] [--mount N] [--chrome]');
  process.exit(2);
}

/**
 * Where to stand, in the ship's own frame: a direction from the hull to the
 * camera, and a distance in hull radii. The game's chase camera always looks
 * along the ship's nose rather than at the ship, so these cannot be fed to it —
 * the camera is overridden at render time instead.
 */
const VIEWS = {
  quarter: { dir: [0.85, 0.38, 0.95], dist: 1.9 },
  bow: { dir: [0.25, 0.22, 1.0], dist: 2.0 },
  beam: { dir: [1.0, 0.16, 0.0], dist: 2.0 },
  high: { dir: [0.15, 1.0, 0.25], dist: 1.9 },
  aft: { dir: [0.55, 0.30, -1.0], dist: 1.8 },
  belly: { dir: [0.45, -0.95, 0.55], dist: 1.9 },
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') {
    errors.push(m.text());
  }
});
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));

await page.goto(opt('url', 'http://127.0.0.1:5174/'), { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3500);
await page.locator('#splashStart').click().catch(() => {});
await page.waitForTimeout(1200);

const info = await page.evaluate(({ view, views, mount, chrome, enemy, hull }) => {
  const g = window.game;
  if (!g) {
    return { found: false };
  }
  // Any hull, not just the one you fly: spawn it if it is not already out there.
  const ship = !hull ? g.player.ship
    : (g.ships.find((s) => s.hull.id === hull)
      || g._addShip(hull, { faction: 'hostile', position: g.player.ship.body.pos.clone() }));
  window.__shotShip = ship;
  const v = views[view] || views.quarter;
  const Vec = g.camera.position.constructor;

  if (enemy) {
    // Something to train the turrets onto. Off the bow and to port, inside
    // engagement range, so the mounts are visibly slewed rather than at rest.
    g._addShip('halberd', {
      faction: 'hostile',
      position: new Vec(1700, 260, 2600).applyQuaternion(ship.body.quat)
        .add(ship.body.pos),
    });
  }

  if (!chrome) {
    for (const el of document.body.children) {
      if (el.tagName !== 'CANVAS') {
        el.style.display = 'none';
      }
    }
  }

  // Hook the render call rather than the camera controller: whatever the game
  // decided this frame, this runs after it and immediately before the draw, so
  // there is no lag, no lerp and nothing to fight.
  const renderer = g.renderer;
  if (!renderer.__shotHook) {
    renderer.__shotHook = true;
    const inner = renderer.render.bind(renderer);
    renderer.render = (scene, cam) => {
      const s = window.__shot;
      if (s && cam === g.camera) {
        const sh = window.__shotShip || g.player.ship;
        const target = sh.body.pos.clone();
        let radius = sh.hull.radius;
        if (s.mount !== null && sh.mounts[s.mount]) {
          const m = sh.mounts[s.mount];
          target.copy(sh.localToWorld(m.surface.clone()));
          // The mount's own size, not the ship's — a turret is about 5 kit
          // units across, so this frames the machine and not the vessel.
          radius = 4.5 * m.rigScale;
        }
        const off = new cam.position.constructor(...s.dir)
          .normalize().multiplyScalar(radius * s.dist)
          .applyQuaternion(sh.body.quat);
        cam.position.copy(target).add(off);
        cam.lookAt(target);
        cam.updateMatrixWorld();
      }
      inner(scene, cam);
    };
  }
  window.__shot = { dir: v.dir, dist: v.dist, mount };

  return {
    found: true,
    hull: ship.hull.id,
    ships: g.ships.length,
    mounts: ship.mounts.length,
    rigged: ship.mounts.filter((m) => m.rig).length,
    gunScale: +ship.gunScale.toFixed(3),
    styles: [...new Set(ship.hull.sections.map((s) => s.style))],
    weapons: ship.mounts.map((m) => m.def.weapon),
  };
}, {
  view: opt('view', 'quarter'),
  views: VIEWS,
  mount: opt('mount', null) === null ? null : Number(opt('mount', 0)),
  chrome: flag('chrome'),
  enemy: flag('enemy'),
  hull: opt('hull', null),
});

if (flag('fire')) {
  // Hold both triggers so the frame catches guns mid-recoil with their
  // emitters lit, which is the state that never shows up in a static preview.
  await page.mouse.move(800, 450);
  await page.mouse.down({ button: 'left' });
  await page.mouse.down({ button: 'right' });
}
await page.waitForTimeout(flag('fire') ? 2600 : 2200);
await page.screenshot({ path: out });
if (flag('fire')) {
  await page.mouse.up({ button: 'left' }).catch(() => {});
  await page.mouse.up({ button: 'right' }).catch(() => {});
}
console.log(JSON.stringify({ info, errors: errors.slice(0, 10) }, null, 1));
await browser.close();
if (!info.found || errors.length > 0) {
  process.exitCode = 1;
}
