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
      hull: document.getElementById('hudHullFill'),
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
    };
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

    this._set(this.el.shield, 'width', `${Math.round(sys.shieldFraction() * 100)}%`);
    this._set(this.el.hull, 'width', `${Math.round(sys.hullFraction() * 100)}%`);
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

    // The two selected weapons, and whether each is actually able to fire.
    const groups = ship.weaponGroups;
    const slot = (idx, btn) => {
      const g = groups[idx];
      if (!g) {
        return `<div class="slot cold"><span class="btn">${btn}</span><span>—</span></div>`;
      }
      const live = g.mounts.some((m) => m.mod.eff > 0.12 && !m.mod.destroyed);
      return `<div class="slot${live ? '' : ' cold'}"><span class="btn">${btn}</span>`
        + `<span>${g.name}</span></div>`;
    };
    this._set(this.el.weapons, 'html',
      slot(player.primary, 'LMB') + slot(player.secondary, 'RMB'));

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
        + `${a.short}</b> ${a.name}<span class="rounds">${rounds}</span>`);
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
          + `  ·  ${t.sys.driveAuthority() > 0.1 ? 'MOBILE' : 'ADRIFT'}</div>`
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
    }

    // --- reticle -----------------------------------------------------------
    const canFire = ship.fireGroups[0].some((m) => m.mod.eff > 0.12);
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
