// -----------------------------------------------------------------------------
// hud.js — the flight instruments.
//
// Split by update rate and by what each medium is good at: world-anchored
// marks (reticle, lead pip, target bracket, facet ring, off-screen arrows) are
// drawn to a canvas every frame, and panels of text and bars are DOM updated
// only when their contents actually change. Rewriting a dozen innerHTML strings
// at 120 Hz is the classic way to make a browser game stutter for no reason.
//
// The shield rose around the reticle is Elite's, and it earns its place here
// more than it does there: with six facets, a hull that can be shot through
// from any angle and an interior whose damage depends on WHICH side opened,
// knowing which facet is down is a targeting decision, not a status light.
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { FACETS } from '../ship/hulls.js';
import { AMMO } from '../weapons/defs.js';
import { clamp01, formatRange } from '../core/mathx.js';

const _v = new THREE.Vector3();
const _proj = { x: 0, y: 0, visible: false, behind: false };
const _proj2 = { x: 0, y: 0, visible: false, behind: false };

/** Short names for the facet read-out. Six characters is all there is room for. */
const FACET_SHORT = {
  fore: 'FORE', aft: 'AFT', port: 'PORT', stbd: 'STBD', dorsal: 'DORS', ventral: 'VENT',
};

/** Where each facet sits on the rose drawn around the reticle. */
const ROSE = {
  fore: [0, -1], aft: [0, 1], port: [-1, 0], stbd: [1, 0],
  dorsal: [-0.72, -0.72], ventral: [0.72, 0.72],
};

export class HUD {
  constructor(game) {
    this.game = game;
    this.canvas = document.getElementById('hudCanvas');
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.messages = [];
    this.nudges = new Map();
    /** Hit confirmation: 1 for plate, 2 for something under it. */
    this.hitMark = 0;
    this._hitT = 0;
    this._cache = new Map();
    this.el = {
      speed: document.getElementById('hudSpeed'),
      throttle: document.getElementById('hudThrottleFill'),
      throttleTxt: document.getElementById('hudThrottleTxt'),
      assist: document.getElementById('hudAssist'),
      shield: document.getElementById('hudShieldFill'),
      facets: document.getElementById('hudFacets'),
      hull: document.getElementById('hudHullFill'),
      drive: document.getElementById('hudDriveFill'),
      helm: document.getElementById('hudHelmTxt'),
      power: document.getElementById('hudPowerFill'),
      cap: document.getElementById('hudCapFill'),
      fuel: document.getElementById('hudFuelFill'),
      heat: document.getElementById('hudHeatFill'),
      stats: document.getElementById('hudStats'),
      ammo: document.getElementById('hudAmmo'),
      weapons: document.getElementById('hudWeapons'),
      target: document.getElementById('hudTarget'),
      targetName: document.getElementById('hudTargetName'),
      targetSub: document.getElementById('hudTargetSub'),
      targetBars: document.getElementById('hudTargetBars'),
      msg: document.getElementById('hudMessages'),
      pip: document.getElementById('hudPip'),
      pipFrame: document.getElementById('hudPipFrame'),
      pipAspect: document.getElementById('hudPipAspect'),
      pipState: document.getElementById('hudPipState'),
    };
    /**
     * Camera for the target view. Sits on your own line of sight to the target
     * but at a fixed multiple of the target's radius, so the aspect you are
     * actually attacking is preserved while apparent size is not: a picket at
     * six kilometres and a dreadnought at eight hundred metres both fill the
     * frame, and the only thing that changes between them is what you can see
     * wrong with them.
     */
    this.pipCam = new THREE.PerspectiveCamera(38, 1.6, 1, 260000);
    this.resize();
  }

  resize() {
    if (!this.canvas) {
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(window.innerWidth * dpr);
    this.canvas.height = Math.floor(window.innerHeight * dpr);
    this.canvas.style.width = `${window.innerWidth}px`;
    this.canvas.style.height = `${window.innerHeight}px`;
    this.dpr = dpr;
    this.pipRect = this.el.pipFrame ? this.el.pipFrame.getBoundingClientRect() : null;
  }

  /** A one-off line in the message log. */
  warn(text) {
    this.messages.push({ text, t: 3.2 });
    if (this.messages.length > 6) {
      this.messages.shift();
    }
    this.game.audio.alarm('warn');
  }

  /** A persistent condition; repeats collapse instead of spamming the log. */
  nudge(text, seconds = 0.4) {
    this.nudges.set(text, seconds);
  }

  _set(el, prop, value) {
    if (!el) {
      return;
    }
    const key = el.id + prop;
    if (this._cache.get(key) === value) {
      return;
    }
    this._cache.set(key, value);
    if (prop === 'text') {
      el.textContent = value;
    } else if (prop === 'html') {
      el.innerHTML = value;
    } else if (prop === 'class') {
      el.className = value;
    } else {
      el.style[prop] = value;
    }
  }

  update(dt) {
    if (this.hitMark > 0) {
      // Latch the strongest hit this frame, then decay it.
      this._hitT = this.hitMark > 1 ? 0.30 : 0.18;
      this._hitKind = this.hitMark;
      this.hitMark = 0;
    } else if (this._hitT > 0) {
      this._hitT = Math.max(0, this._hitT - dt);
    }
    for (const m of this.messages) {
      m.t -= dt;
    }
    while (this.messages.length && this.messages[0].t <= 0) {
      this.messages.shift();
    }
    for (const [k, v] of this.nudges) {
      const left = v - dt;
      if (left <= 0) {
        this.nudges.delete(k);
      } else {
        this.nudges.set(k, left);
      }
    }
  }

  render() {
    const game = this.game;
    const player = game.player;
    if (!player) {
      return;
    }
    const ship = player.ship;
    const sys = ship.sys;
    const tgt = game.targeting;

    // -- panels --------------------------------------------------------------
    const speed = ship.body.vel.length();
    this._set(this.el.speed, 'text', `${Math.round(speed)}`);
    this._set(this.el.throttle, 'height', `${Math.round(clamp01(player.throttle) * 100)}%`);
    this._set(this.el.throttleTxt, 'text', `${Math.round(player.throttle * 100)}%`);
    const assistOn = ship.autopilot.readout.assist;
    this._set(this.el.assist, 'text', assistOn ? 'FA ON' : 'FA OFF');
    this._set(this.el.assist, 'color', assistOn ? '#7fd8ff' : '#ffb04a');

    this._set(this.el.shield, 'width', `${Math.round(sys.shieldRated() * 100)}%`);

    // Which side is open, and how much of the shield you PAID for is still
    // there. Two separate facts, and the display used to conflate them into a
    // lie.
    //
    // Every bar was charge ÷ current max — but killing a projector lowers the
    // ceiling, so max falls with charge and the ratio stays pinned at 100%. A
    // cruiser that had lost both amplifiers, and with them a third of its
    // shield, read as a completely healthy shield. The one reading a player
    // trusts most was the one that could not report the damage.
    //
    // So the bar is measured against the hull's RATED per-facet capacity. The
    // lit part is charge; the dim part behind it is ceiling you no longer have
    // and cannot recharge into until the projectors are repaired.
    const rated = ship.hull.shield.capacity / FACETS.length;
    this._set(this.el.facets, 'html', FACETS.map((k) => {
      const f = sys.shield.facets[k];
      const charge = clamp01(f.charge / rated);
      const ceiling = clamp01(f.max / rated);
      const load = f.loadMax > 0 ? clamp01(f.load / f.loadMax) : 0;
      const cls = f.down ? 'down' : (load > 0.5 ? 'hot' : '');
      // A collapsed facet says WHY: an emitter that has run out of power comes
      // straight back, one that has saturated will not until it has cooled.
      const read = f.down ? (f.cause || 'DOWN') : `${Math.round(charge * 100)}`;
      return `<span class="facet ${cls}">`
        + `<u style="width:${Math.round(ceiling * 100)}%"></u>`
        + `<i style="width:${Math.round(charge * 100)}%"></i>`
        + `<em>${FACET_SHORT[k]}</em><b>${read}</b></span>`;
    }).join(''));
    this._set(this.el.hull, 'width', `${Math.round(sys.hullFraction() * 100)}%`);
    // Drive authority and the flight computer, together, are the mission-kill
    // condition. Shown as one gauge because they fail as a pair: either alone
    // is survivable, both is adrift.
    const drive = sys.driveAuthority();
    this._set(this.el.drive, 'width', `${Math.round(drive * 100)}%`);
    this._set(this.el.drive, 'background', drive < 0.15 ? '#ff6a3a' : '');
    const helm = sys.flightComputer;
    this._set(this.el.helm, 'text', ship.derelict ? 'ADRIFT' : (helm ? 'HELM' : 'NO HELM'));
    this._set(this.el.helm, 'color',
      ship.derelict ? '#ff6a5a' : (helm ? 'rgba(150,190,215,0.55)' : '#ffb04a'));
    const powerFrac = sys.demand > 0 ? clamp01(sys.supply / sys.demand) : 1;
    this._set(this.el.power, 'width', `${Math.round(powerFrac * 100)}%`);
    this._set(this.el.cap, 'width',
      `${Math.round((sys.capMax > 0 ? sys.capStore / sys.capMax : 0) * 100)}%`);
    this._set(this.el.fuel, 'width', `${Math.round(sys.fuelFraction() * 100)}%`);
    const hot = sys.hottestLoop();
    const heatFrac = hot ? clamp01((hot.temp - 18) / 180) : 0;
    this._set(this.el.heat, 'width', `${Math.round(heatFrac * 100)}%`);
    this._set(this.el.heat, 'background', heatFrac > 0.75 ? '#ff6a3a' : '#ffb04a');

    const fires = sys.fireCount();
    const breaches = sys.breachCount();
    this._set(this.el.stats, 'html',
      `<b>${Math.round(sys.supply * 10) / 10}</b>/${Math.round(sys.demand * 10) / 10} MW`
      + `  ·  CREW <b>${ship.crew.headcount}</b>/${ship.crew.complementMax}`
      + `  ·  SPARES <b>${sys.totalSpares()}</b>`
      + (fires ? `  ·  <span class="bad">FIRE x${fires}</span>` : '')
      + (breaches ? `  ·  <span class="bad">BREACH x${breaches}</span>` : ''));

    // -- the armoury ---------------------------------------------------------
    // Every weapon the ship carries, not just the two bound to the buttons,
    // and for each of them the two things a gunner actually needs: how many of
    // its mounts are alive, and — if it is not shooting — why not.
    //
    // The panel used to be two names and an opacity change. That is enough to
    // say "something is wrong somewhere" and nothing more, on a ship where a
    // gun can be silent because its magazine is empty, its hoist was cut, its
    // loop boiled it, its bus is shed or it simply cannot bear. Those have
    // completely different answers and the display owed you which one it was.
    // It also hid the ordnance entirely: the torpedo tubes are the third of six
    // groups on a wheel with no list, so the ship's one homing weapon was
    // effectively undiscoverable.
    this._set(this.el.weapons, 'html', ship.weaponGroups.map((g, i) => {
      let live = 0;
      let fault = null;
      let pips = '';
      for (const m of g.mounts) {
        // Cycling is a gun working, not a gun broken; showing it would strobe
        // the panel six times a second on a repeater.
        const f = ship.mountFault(m);
        const bad = f && f !== 'CYCLING';
        if (bad) {
          fault = fault || f;
        } else {
          live++;
        }
        pips += `<i class="${bad ? 'bad' : 'ok'}"></i>`;
      }
      // Reasons it will not shoot, most fundamental first.
      let state = 'READY';
      let cls = '';
      if (live === 0) {
        state = fault || 'OFFLINE';
        cls = 'dead';
      } else if (g.weapon.guidance === 'command' && !tgt.target) {
        // A command-guided torpedo with nothing to fly at wastes itself. An
        // active seeker does not need the lock and must not be told it does —
        // its whole point is that you can put one into empty sky in the
        // general direction of a fight and it will find the fight.
        state = 'NO LOCK';
        cls = 'warn';
      } else if (g.weapon.guidance === 'active') {
        state = fault || 'FREE';
        cls = fault ? 'warn' : '';
      } else if (tgt.target && !g.mounts.some((m) => ship.onTarget(m, tgt.target, 0.09))) {
        state = 'NO BEARING';
        cls = 'warn';
      } else if (fault) {
        state = fault;
        cls = 'warn';
      }
      const key = (i === player.primary ? 'L' : '') + (i === player.secondary ? 'R' : '');
      return `<div class="wrow ${cls}${key ? ' bound' : ''}">`
        + `<span class="btn">${key || '·'}</span>`
        + `<span class="wname">${g.name}</span>`
        + `<span class="pips">${pips}</span>`
        + `<span class="wstate">${state}</span></div>`;
    }).join(''));

    // Loaded round, with what is left in the magazines behind it.
    if (ship.usesAmmo) {
      const a = AMMO[ship.ammo];
      let rounds = 0;
      for (const m of sys.modules.values()) {
        if (m.kind === 'magazine' && !m.destroyed) {
          rounds += m.rounds;
        }
      }
      this._set(this.el.ammo, 'html',
        `<b style="color:${a.tracer ? `#${a.tracer.toString(16).padStart(6, '0')}` : '#fff'}">`
        // Floored, not raw: the hoist lifts rounds continuously, so a locker
        // part-way through a lift holds a fraction of one and the ammunition
        // counter is not the place to show it.
        + `${a.short}</b> ${a.name}<span class="rounds">${Math.floor(rounds)}</span>`);
    } else {
      this._set(this.el.ammo, 'html', '<span class="rounds">ENERGY ONLY</span>');
    }

    // -- target panel --------------------------------------------------------
    if (tgt.target && !tgt.target.disposed) {
      const t = tgt.target;
      this._set(this.el.target, 'display', 'block');
      this._set(this.el.targetName, 'text', `${t.hull.name} · ${t.name}`);
      const dist = t.position.distanceTo(ship.position);
      const closing = _v.copy(t.velocity).sub(ship.velocity)
        .dot(_v.copy(t.position).sub(ship.position).normalize());
      const sub = tgt.subsystem ? t.sys.get(tgt.subsystem) : null;
      const scan = tgt.lock < 1 ? ` · SCAN ${Math.round(tgt.lock * 100)}%` : '';
      this._set(this.el.targetSub, 'text',
        `${formatRange(dist)} · ${closing >= 0 ? '+' : ''}${Math.round(closing)} m/s${scan}`
        + (sub ? ` · ${sub.label}` : ''));
      const shieldPct = Math.round(t.sys.shieldFraction() * 100);
      const hullPct = Math.round(t.sys.hullFraction() * 100);
      // Interior detail is a scan reward: no completed lock, no readout.
      const detail = tgt.lock >= 1
        ? `<div class="tbar"><i style="width:${Math.round(t.sys.integrity * 100)}%"></i>`
          + `<em>SYSTEMS ${Math.round(t.sys.integrity * 100)}%</em></div>`
          + `<div class="tsmall">CREW ${Math.round(t.crew.complement * 100)}%`
          + `  ·  ${t.sys.fireCount() ? 'FIRE' : 'NO FIRE'}`
          + `  ·  ${t.derelict ? 'DERELICT' : (t.sys.driveAuthority() > 0.1 ? 'MOBILE' : 'CRIPPLED')}</div>`
        : '<div class="tsmall">SCANNING…</div>';
      this._set(this.el.targetBars, 'html',
        `<div class="tbar sh"><i style="width:${shieldPct}%"></i><em>SHIELD ${shieldPct}%</em></div>`
        + `<div class="tbar hl"><i style="width:${hullPct}%"></i><em>HULL ${hullPct}%</em></div>`
        + detail);
    } else {
      this._set(this.el.target, 'display', 'none');
    }

    // -- messages ------------------------------------------------------------
    let msgHtml = '';
    for (const n of this.nudges.keys()) {
      msgHtml += `<div class="msg live">${n}</div>`;
    }
    for (const m of this.messages) {
      msgHtml += `<div class="msg" style="opacity:${clamp01(m.t / 1.4)}">${m.text}</div>`;
    }
    this._set(this.el.msg, 'html', msgHtml);

    this._drawMarks();
  }

  /**
   * Second render pass: the locked target, framed consistently, painted into
   * the PiP rect on the main canvas.
   *
   * Called from the frame loop AFTER the main render, with the scissor test
   * confining both the clear and the draw to the frame. It re-renders the real
   * scene rather than a schematic, so everything the simulation is already
   * doing to that hull — scorch, venting compartments, open fires, the shield
   * lighting where it is being struck — shows up for free and stays true.
   *
   * Gated on sensors: no array, no picture. Blinding a ship should cost you the
   * ability to watch what you are doing to it.
   */
  renderTargetView(renderer, scene) {
    const game = this.game;
    const el = this.el.pip;
    if (!el) {
      return;
    }
    const t = game.targeting.target;
    const player = game.player;
    const live = t && !t.disposed && player && !player.ship.disposed
      && player.ship.sys.sensorQuality() > 0.05;
    el.classList.toggle('hidden', !live);
    if (!live) {
      return;
    }

    const r = this.pipRect;
    if (r.width < 8 || r.height < 8) {
      return;
    }

    // Look along the player's own bearing to the target, pulled back to a
    // normalised standoff. A perspective camera fits a sphere of radius R at
    // R / tan(fov/2); the extra margin keeps the hull off the frame edge.
    _v.copy(t.position).sub(player.ship.position);
    const range = _v.length();
    if (range < 1e-3) {
      return;
    }
    _v.multiplyScalar(1 / range);
    const fit = t.hitRadius / Math.tan((this.pipCam.fov * Math.PI) / 360);
    const cam = this.pipCam;
    cam.position.copy(t.position).addScaledVector(_v, -fit * 1.22);
    // Keep the frame's horizon aligned with the player's, so left in the PiP is
    // left on screen and a rolling target reads as the target rolling.
    cam.up.set(0, 1, 0).applyQuaternion(player.camera.quaternion);
    cam.lookAt(t.position);
    cam.aspect = r.width / r.height;
    cam.near = Math.max(1, fit * 0.05);
    cam.updateProjectionMatrix();

    // Viewport origin is bottom-left and in CSS pixels; three.js applies the
    // pixel ratio itself.
    const x = r.left;
    const y = window.innerHeight - r.bottom;
    renderer.setScissorTest(true);
    renderer.setViewport(x, y, r.width, r.height);
    renderer.setScissor(x, y, r.width, r.height);
    renderer.render(scene, cam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);

    // Caption: which facet is turned toward you and what state it is in. That
    // is the one thing the picture cannot show and the one thing that decides
    // whether to keep shooting this side of the ship.
    _v.copy(player.ship.position).sub(t.position).normalize();
    const facet = t.faceFor(_v);
    const f = t.sys.shield.facets[facet];
    const pct = f && f.max > 0 ? Math.round(clamp01(f.charge / f.max) * 100) : 0;
    this._set(this.el.pipAspect, 'text', `${facet} aspect`);
    const down = f && f.down;
    this._set(this.el.pipState, 'text',
      t.derelict ? 'DERELICT'
        : (down ? `FACET ${f.cause}` : `FACET ${pct}%`));
    this._set(this.el.pipState, 'class', down || t.derelict ? 'bad' : '');
  }

  // -- canvas marks ----------------------------------------------------------

  _drawMarks() {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = window.innerWidth;
    const H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);

    const game = this.game;
    const player = game.player;
    const ship = player.ship;
    const tgt = game.targeting;
    const cx = W / 2;
    const cy = H / 2;

    // --- own shield rose ---------------------------------------------------
    const rose = 46;
    for (const f of FACETS) {
      const facet = ship.sys.shield.facets[f];
      const [dx, dy] = ROSE[f];
      const x = cx + dx * rose;
      const y = cy + dy * rose;
      const frac = facet.max > 0 ? clamp01(facet.charge / facet.max) : 0;
      const load = facet.loadMax > 0 ? clamp01(facet.load / facet.loadMax) : 0;
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      // Blue is charge. The dot warms toward orange as the emitters saturate,
      // so the two failure modes are distinguishable before either happens:
      // a fading dot is running out of power, a glowing one is overheating.
      ctx.fillStyle = facet.down
        ? (facet.cause === 'SATURATED' ? 'rgba(255,150,60,0.95)' : 'rgba(255,80,70,0.9)')
        : `rgba(${Math.round(110 + 145 * load)},${Math.round(200 - 60 * load)},${Math.round(255 - 195 * load)},${0.12 + 0.7 * frac})`;
      ctx.fill();
      if (!facet.down && (frac < 0.999 || load > 0.05)) {
        ctx.strokeStyle = load > 0.5
          ? 'rgba(255,170,80,0.75)'
          : 'rgba(180,220,255,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      // A collapsed facet gets struck through. Colour alone is not enough at
      // four and a half pixels in peripheral vision while something is
      // shooting at you — and "which side is open" is the one thing on this
      // display worth interrupting the player for.
      if (facet.down) {
        ctx.strokeStyle = facet.cause === 'SATURATED'
          ? 'rgba(255,190,110,0.95)' : 'rgba(255,120,105,0.95)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x - 7, y - 7); ctx.lineTo(x + 7, y + 7);
        ctx.moveTo(x + 7, y - 7); ctx.lineTo(x - 7, y + 7);
        ctx.stroke();
      }
    }

    // --- reticle -----------------------------------------------------------
    // Reticle health reflects the group bound to the left button, not the AI's
    // fixed-mount group — otherwise it reports on guns the player is not firing.
    const primary = ship.weaponGroups[player.primary];
    const canFire = (primary ? primary.mounts : ship.fireGroups[0])
      .some((m) => m.mod.eff > 0.12 && !m.mod.destroyed);
    ctx.strokeStyle = canFire ? 'rgba(190,225,245,0.85)' : 'rgba(255,110,90,0.85)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx, cy, 11, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 20, cy); ctx.lineTo(cx - 13, cy);
    ctx.moveTo(cx + 13, cy); ctx.lineTo(cx + 20, cy);
    ctx.moveTo(cx, cy - 20); ctx.lineTo(cx, cy - 13);
    ctx.stroke();

    // --- hit confirmation --------------------------------------------------
    // At six hundred metres you cannot see whether a round connected, and
    // "did that go through the plate or into something behind it" is the
    // question this whole game is about. Two ticks for a plate strike, four
    // and brighter for an internal one.
    if (this._hitT > 0) {
      const k = this._hitT / (this._hitKind > 1 ? 0.30 : 0.18);
      const spread = 17 + (1 - k) * 9;
      ctx.strokeStyle = this._hitKind > 1
        ? `rgba(255,170,90,${k})`
        : `rgba(220,240,255,${k * 0.8})`;
      ctx.lineWidth = this._hitKind > 1 ? 2.2 : 1.6;
      const arms = this._hitKind > 1
        ? [[-1, -1], [1, -1], [-1, 1], [1, 1]]
        : [[-1, 0], [1, 0]];
      for (const [ax, ay] of arms) {
        const n = Math.hypot(ax, ay);
        ctx.beginPath();
        ctx.moveTo(cx + (ax / n) * spread, cy + (ay / n) * spread);
        ctx.lineTo(cx + (ax / n) * (spread + 6), cy + (ay / n) * (spread + 6));
        ctx.stroke();
      }
    }

    // --- velocity vector ---------------------------------------------------
    // Where the ship is actually going, which under flight assist off is
    // rarely where it is pointing. This mark is the whole reason FA-off is
    // flyable rather than a novelty.
    const vel = ship.body.vel;
    if (vel.lengthSq() > 25) {
      _v.copy(ship.position).addScaledVector(vel, 12 / vel.length() * 40);
      player.project(_v, _proj);
      if (_proj.visible) {
        ctx.strokeStyle = 'rgba(120,230,180,0.75)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(_proj.x, _proj.y, 7, 0, Math.PI * 2);
        ctx.moveTo(_proj.x - 11, _proj.y); ctx.lineTo(_proj.x - 7, _proj.y);
        ctx.moveTo(_proj.x + 7, _proj.y); ctx.lineTo(_proj.x + 11, _proj.y);
        ctx.moveTo(_proj.x, _proj.y - 11); ctx.lineTo(_proj.x, _proj.y - 7);
        ctx.stroke();
      }
    }

    // --- ordnance in flight ------------------------------------------------
    // A torpedo takes the better part of ten seconds to cross three kilometres
    // and is a two-metre cone against a starfield, so without a mark on it the
    // ship's only homing weapon is fire-and-forget in the literal sense —
    // nothing tells you it launched, nothing tells you it is still running, and
    // nothing tells you one is running at YOU. Yours are drawn amber outbound;
    // anything tracking this hull is drawn red, and says so.
    let inbound = 0;
    for (const m of game.ballistics.missiles) {
      const mine = m.owner === ship;
      const atMe = m.target === ship;
      if (atMe) {
        inbound++;
      }
      player.project(m.pos, _proj2);
      if (!_proj2.visible) {
        continue;
      }
      ctx.strokeStyle = atMe ? 'rgba(255,90,70,0.95)'
        : (mine ? 'rgba(255,190,90,0.8)' : 'rgba(160,180,195,0.5)');
      ctx.lineWidth = atMe ? 1.8 : 1.2;
      const s = atMe ? 7 : 5;
      ctx.beginPath();
      ctx.moveTo(_proj2.x, _proj2.y - s);
      ctx.lineTo(_proj2.x + s, _proj2.y);
      ctx.lineTo(_proj2.x, _proj2.y + s);
      ctx.lineTo(_proj2.x - s, _proj2.y);
      ctx.closePath();
      ctx.stroke();
    }
    if (inbound > 0) {
      this.nudge(`TORPEDO INBOUND x${inbound} — POINT DEFENCE`, 0.5);
    }

    if (!tgt.target || tgt.target.disposed) {
      return;
    }
    const t = tgt.target;

    // --- target bracket ----------------------------------------------------
    player.project(t.position, _proj);
    const dist = t.position.distanceTo(ship.position);
    if (_proj.visible) {
      // Bracket size tracks the ship's true angular size, so it doubles as a
      // range cue without a number attached.
      const ang = Math.atan2(t.hitRadius, Math.max(dist, 1));
      const r = Math.max(14, Math.min(220, ang / (player.camera.fov * Math.PI / 360) * (H / 2)));
      ctx.strokeStyle = tgt.lock >= 1 ? 'rgba(255,210,110,0.95)' : 'rgba(255,210,110,0.45)';
      ctx.lineWidth = 1.6;
      const c = r * 0.38;
      const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
      for (const [sx, sy] of corners) {
        const x = _proj.x + sx * r;
        const y = _proj.y + sy * r;
        ctx.beginPath();
        ctx.moveTo(x - sx * c, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y - sy * c);
        ctx.stroke();
      }
      // Scan sweep while the lock is still building.
      if (tgt.lock < 1) {
        ctx.strokeStyle = 'rgba(255,210,110,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(_proj.x, _proj.y, r + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * tgt.lock);
        ctx.stroke();
      }

      // Target's shield facets, laid out the same way as your own rose so the
      // two read identically — that symmetry is what lets you decide which
      // side of an enemy to attack.
      if (tgt.lock >= 1) {
        for (const f of FACETS) {
          const facet = t.sys.shield.facets[f];
          const [dx, dy] = ROSE[f];
          const frac = facet.max > 0 ? clamp01(facet.charge / facet.max) : 0;
          const load = facet.loadMax > 0 ? clamp01(facet.load / facet.loadMax) : 0;
          ctx.beginPath();
          ctx.arc(_proj.x + dx * (r + 20), _proj.y + dy * (r + 20), 2.6, 0, Math.PI * 2);
          ctx.fillStyle = facet.down
            ? (facet.cause === 'SATURATED' ? 'rgba(255,150,60,0.95)' : 'rgba(255,80,70,0.9)')
            : `rgba(${Math.round(110 + 145 * load)},${Math.round(200 - 60 * load)},${Math.round(255 - 195 * load)},${0.15 + 0.7 * frac})`;
          ctx.fill();
        }
      }
    } else {
      // Off-screen: point at it round the edge of the display.
      _v.copy(t.position).sub(player.camera.position);
      player.project(t.position, _proj2);
      let dx = _proj2.x - cx;
      let dy = _proj2.y - cy;
      if (_proj2.behind) {
        dx = -dx;
        dy = -dy;
      }
      const len = Math.hypot(dx, dy) || 1;
      const rad = Math.min(W, H) * 0.36;
      const ax = cx + (dx / len) * rad;
      const ay = cy + (dy / len) * rad;
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(Math.atan2(dy, dx));
      ctx.fillStyle = 'rgba(255,210,110,0.85)';
      ctx.beginPath();
      ctx.moveTo(9, 0); ctx.lineTo(-6, 5); ctx.lineTo(-6, -5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // --- subsystem marker --------------------------------------------------
    const subPoint = tgt.subsystemPoint(_v);
    if (subPoint) {
      player.project(subPoint, _proj2);
      if (_proj2.visible) {
        ctx.strokeStyle = 'rgba(255,140,90,0.95)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(_proj2.x, _proj2.y, 6, 0, Math.PI * 2);
        ctx.moveTo(_proj2.x - 10, _proj2.y - 10);
        ctx.lineTo(_proj2.x - 5, _proj2.y - 5);
        ctx.stroke();
      }
    }

    // --- lead pip ----------------------------------------------------------
    const lead = tgt.leadPoint(_v);
    if (lead) {
      player.project(lead, _proj2);
      if (_proj2.visible) {
        const onTarget = Math.hypot(_proj2.x - cx, _proj2.y - cy) < 16;
        ctx.strokeStyle = onTarget ? 'rgba(120,255,170,0.95)' : 'rgba(255,230,150,0.8)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(_proj2.x, _proj2.y, 5, 0, Math.PI * 2);
        ctx.stroke();
        if (onTarget) {
          ctx.beginPath();
          ctx.arc(_proj2.x, _proj2.y, 1.8, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(120,255,170,0.95)';
          ctx.fill();
        }
      }
    }
  }
}
