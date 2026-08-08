// -----------------------------------------------------------------------------
// diagnostics.js — the damage-control display.
//
// Three views of one ship, side by side, all reading the same live state:
//
//   TREE      every module grouped by system, with the number that actually
//             matters for that kind of module. Its colours come from
//             `moduleStatus` in systems.js, so this panel and the cutaway can
//             never disagree about whether something is in trouble.
//   CUTAWAY   a true scale drawing of the hull in plan and profile, built from
//             the same compartment boxes the ballistics solver tests against.
//             What you see here is exactly what a round will hit. Compartments
//             are drawn to the shell's tapered profile rather than as plain
//             rectangles, so the schematic and the ship outside agree on what
//             shape the vessel is.
//   CREW      where the people are, what they are doing, and how they are.
//
// The panel can be pointed at the locked target (to plan a shot) or at your own
// ship (to work out what just broke). Both use identical code, because the two
// jobs are the same job seen from different ends.
// -----------------------------------------------------------------------------
import { SYSTEM_ORDER, NETS } from '../ship/hulls.js';
import { moduleStatus, LEVEL, ATMO_CRITICAL } from '../ship/systems.js';
import { XRAY_DRAW, XRAY_HOLD, XRAY_FADE } from '../ship/ship.js';
import { clamp01, formatRange } from '../core/mathx.js';
import { skinFraction } from '../world/hardware.js';

/**
 * The damage-control mark. Drawn rather than typed: at nine pixels a glyph is a
 * smudge, and this has to be recognisable in peripheral vision while something
 * is shooting at you.
 */
const WRENCH = '<svg viewBox="0 0 16 16" aria-hidden="true">'
  + '<path fill="currentColor" d="M11.4 1a4.6 4.6 0 0 0-4.3 6.2L1.5 12.8a1.4 1.4 0 '
  + '0 0 2 2l5.6-5.6A4.6 4.6 0 1 0 11.4 1zm0 2.1c.3 0 .6 0 .9.1l-1.8 1.8a1 1 0 0 0 '
  + '0 1.4l.7.7a1 1 0 0 0 1.4 0l1.8-1.8a2.5 2.5 0 1 1-3-2.2z"/></svg>';

const LEVEL_CLASS = {
  [LEVEL.OK]: 'ok', [LEVEL.WARN]: 'warn', [LEVEL.CRIT]: 'crit', [LEVEL.DEAD]: 'dead',
};
const LEVEL_COLOR = {
  [LEVEL.OK]: '#5fd39a', [LEVEL.WARN]: '#ffc65c', [LEVEL.CRIT]: '#ff8a4a', [LEVEL.DEAD]: '#ff5a5a',
};

const ROLE_COLOR = {
  pilot: '#8fd8ff', gunner: '#ffc65c', engineer: '#7ae6a0', damage: '#e0e6ec',
};

/** Divisions of a few hundred draw as a bar, not a dot. */
const CREW_DOT = 3.4;

/**
 * How a penetration trace draws. The round is animated ALONG its path rather
 * than appearing whole, because the question the display exists to answer is
 * "where did it go", and a static line does not carry direction.
 */
const XRAY_COLOR = {
  shield: [130, 210, 255],
  shieldStop: [130, 210, 255],
  wall: [235, 245, 255],
  wallStop: [255, 190, 90],
  exit: [235, 245, 255],
  surface: [255, 190, 90],
  ricochet: [255, 235, 150],
  module: [255, 110, 90],
  moduleStop: [255, 110, 90],
  stop: [255, 190, 90],
};
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** Joules for a human. The cutaway has no room for exponent notation. */
function energyText(j) {
  if (j >= 1e6) {
    return `${(j / 1e6).toFixed(j >= 1e7 ? 0 : 1)} MJ`;
  }
  if (j >= 1e3) {
    return `${Math.round(j / 1e3)} kJ`;
  }
  return `${Math.round(j)} J`;
}

export class Diagnostics {
  /**
   * `prefix` selects which panel this instance drives, so the same code renders
   * your ship and your target side by side. Reading an enemy's interior in the
   * same detail as your own is the whole point of the display: it is how you
   * decide which conduit to cut rather than merely how much damage to do.
   */
  constructor(game, prefix = 'diag') {
    this.game = game;
    this.prefix = prefix;
    this.ship = null;
    this.root = document.getElementById(`${prefix}Panel`);
    this.titleEl = document.getElementById(`${prefix}Title`);
    this.subEl = document.getElementById(`${prefix}Sub`);
    this.treeEl = document.getElementById(`${prefix}Tree`);
    this.crewEl = document.getElementById(`${prefix}Crew`);
    this.canvas = document.getElementById(`${prefix}Cutaway`);
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.hitsEl = document.getElementById(`${prefix}Hits`);
    this._hitsHtml = '';
    this.visible = true;
    this._rows = new Map();
    this._builtFor = null;
    this._selected = null;
  }

  setShip(ship) {
    if (this.ship === ship) {
      return;
    }
    this.ship = ship;
    if (this.root) {
      this.root.classList.toggle('hidden', !ship || !this.visible);
    }
  }

  /** Scrolls the module tree by roughly half a panel. See Game._hotkeys. */
  scrollTree(dir) {
    if (!this.treeEl) {
      return;
    }
    this.treeEl.scrollTop += dir * Math.max(80, this.treeEl.clientHeight * 0.6);
  }

  toggle() {
    this.visible = !this.visible;
    if (this.root) {
      this.root.classList.toggle('hidden', !this.ship || !this.visible);
    }
    return this.visible;
  }

  /** Rebuilds the row skeleton. Only when the ship class changes, not per frame. */
  _build(ship) {
    this.treeEl.innerHTML = '';
    this._rows.clear();
    const groups = new Map();
    for (const m of ship.sys.modules.values()) {
      const g = m.def.sys;
      if (!groups.has(g)) {
        groups.set(g, []);
      }
      groups.get(g).push(m);
    }
    this._groups = [];
    for (const sys of SYSTEM_ORDER) {
      const mods = groups.get(sys);
      if (!mods || mods.length === 0) {
        continue;
      }
      const head = document.createElement('div');
      head.className = 'diag-group';
      head.textContent = sys;
      this.treeEl.appendChild(head);
      const members = [];
      this._groups.push({ head, members });
      mods.sort((a, b) => a.label.localeCompare(b.label));
      for (const m of mods) {
        const row = document.createElement('div');
        row.className = 'diag-row';
        const bar = document.createElement('span');
        bar.className = 'diag-bar';
        const fill = document.createElement('i');
        bar.appendChild(fill);
        const name = document.createElement('span');
        name.className = 'diag-name';
        name.textContent = m.label;
        const val = document.createElement('span');
        val.className = 'diag-val';
        // A party actually working on this module, rather than a text suffix
        // buried at the end of a number nobody reads mid-fight. It pulses, so
        // the eye finds "somebody is on it" without reading anything.
        const fix = document.createElement('span');
        fix.className = 'diag-fix';
        fix.innerHTML = WRENCH;
        row.appendChild(name);
        row.appendChild(bar);
        row.appendChild(val);
        row.appendChild(fix);
        this.treeEl.appendChild(row);
        const entry = { row, fill, val, name, shown: true, fixing: null };
        entry.fix = fix;
        this._rows.set(m.id, entry);
        members.push(entry);
      }
    }
    // Shown when the whole tree is hidden, so an empty panel reads as "nothing
    // is wrong" rather than as a panel that failed to draw.
    this._nominal = document.createElement('div');
    this._nominal.className = 'diag-nominal';
    this._nominal.textContent = 'ALL SYSTEMS NOMINAL';
    this.treeEl.appendChild(this._nominal);
    this._builtFor = ship.hull.id;
  }

  render() {
    const ship = this.ship;
    if (!ship || !this.visible || !this.root || ship.disposed) {
      if (this.root) {
        this.root.classList.add('hidden');
      }
      return;
    }
    this.root.classList.remove('hidden');
    if (this._builtFor !== ship.hull.id) {
      this._build(ship);
    }
    const sys = ship.sys;
    const tgt = this.game.targeting;
    this._selected = this.ship === tgt.target ? tgt.subsystem : null;

    // --- header -------------------------------------------------------------
    const isSelf = ship === (this.game.player && this.game.player.ship);
    this.titleEl.textContent = `${ship.hull.name} · ${ship.name}`;
    const dist = isSelf ? 0 : ship.position.distanceTo(this.game.player.ship.position);
    const netBits = NETS.map((n) => {
      const total = [...sys.modules.values()].filter((m) => m.kind === 'conduit'
        && m.def.net === n);
      const up = total.filter((m) => sys.online[n].has(m.def.to)).length;
      return `${n.toUpperCase()} ${up}/${total.length}`;
    }).join('  ');
    this.subEl.textContent = isSelf
      ? `${ship.hull.role}  ·  ${netBits}`
      : `${formatRange(dist)}  ·  ${netBits}`;

    // --- tree ---------------------------------------------------------------
    // Only what is wrong. A healthy cruiser has seventy-odd modules and every
    // one of them drew a full-width green bar reading CONTINUITY, which is
    // seventy rows of "fine" for the two that are not — the one thing the
    // panel exists to tell you was the hardest thing on it to find. A row
    // appears when it stops being nominal, when it is being repaired, or when
    // it is the subsystem you have designated.
    for (const [id, r] of this._rows) {
      const m = sys.get(id);
      if (!m) {
        continue;
      }
      const st = moduleStatus(sys, m);
      const cls = LEVEL_CLASS[st.level];
      if (r.row.dataset.lvl !== cls) {
        r.row.dataset.lvl = cls;
        // Rewriting className drops `hidden` and `selected`; force both to be
        // re-applied below rather than leaving a row visible because its level
        // happened to change on the same tick it should have been folded away.
        r.row.className = `diag-row ${cls}`;
        r.shown = null;
        delete r.row.dataset.sel;
      }
      const sel = id === this._selected;
      const show = st.level !== LEVEL.OK || m.repairing || sel;
      if (r.shown !== show) {
        r.shown = show;
        r.row.classList.toggle('hidden', !show);
      }
      if (!show) {
        continue;
      }
      if (r.row.dataset.sel !== String(sel)) {
        r.row.dataset.sel = String(sel);
        r.row.classList.toggle('selected', sel);
        // Bring a newly targeted subsystem into view; most of the tree is
        // below the fold and hunting for it by hand is not a game mechanic.
        if (sel) {
          r.row.scrollIntoView({ block: 'nearest' });
        }
      }
      r.fill.style.width = `${Math.round(st.frac * 100)}%`;
      if (r.val.textContent !== st.text) {
        r.val.textContent = st.text;
      }
      if (r.fixing !== !!m.repairing) {
        r.fixing = !!m.repairing;
        r.fix.classList.toggle('on', r.fixing);
      }
    }

    // A heading with nothing under it is noise too.
    let any = false;
    for (const grp of this._groups) {
      const live = grp.members.some((e) => e.shown);
      any = any || live;
      grp.head.classList.toggle('hidden', !live);
    }
    this._nominal.classList.toggle('hidden', any);

    this._renderCrew(ship);
    this._renderCutaway(ship);
    this._renderHits(ship);
  }

  /**
   * The penetration log in words. The drawing shows where a round went; this
   * says what it found, in order, and what that cost — which is the part you
   * cannot read off a line on a schematic.
   */
  _renderHits(ship) {
    if (!this.hitsEl) {
      return;
    }
    let html = '';
    for (let i = ship.xray.length - 1; i >= 0 && html.length < 900; i--) {
      const path = ship.xray[i];
      const inside = path.nodes.filter((n) => n.kind === 'module'
        || n.kind === 'moduleStop');
      if (path.nodes.length === 0) {
        continue;
      }
      const fade = clamp01(1 - (path.age - XRAY_HOLD) / (XRAY_FADE - XRAY_HOLD));
      const last = path.nodes[path.nodes.length - 1];
      // A round that crossed the far wall left the ship; calling that
      // "stopped" is exactly backwards, and a through-and-through that found
      // nothing is a real and useful outcome to be able to read.
      const VERB = {
        exit: 'THROUGH', ricochet: 'DEFLECTED', shieldStop: 'FIELD CAUGHT',
        surface: 'PLATE ONLY', wallStop: 'STOPPED', stop: 'STOPPED',
      };
      const verb = inside.length > 0 ? 'PENETRATED' : (VERB[last.kind] || 'STOPPED');
      const cls = inside.some((n) => n.killed) ? 'crit'
        : (inside.length > 0 ? 'warn' : 'ok');
      // What it found inside if it got inside; otherwise the compartments it
      // went through, which for a clean penetrator is the interesting part —
      // that line of opened compartments is the damage.
      let what;
      if (inside.length > 0) {
        what = inside.map((n) => (n.killed ? `<b>${n.label}</b>` : n.label)).join(' → ');
      } else {
        const crossed = [];
        for (const n of path.nodes) {
          if (n.label && crossed[crossed.length - 1] !== n.label) {
            crossed.push(n.label);
          }
        }
        what = crossed.join(' → ') || last.label;
      }
      html += `<div class="hit-row ${cls}" style="opacity:${fade.toFixed(2)}">`
        + `<span class="hit-verb">${verb}</span>`
        + `<span class="hit-what">${what}</span>`
        + `<span class="hit-e">${energyText(path.nodes.reduce((a, n) => a + n.e, 0))}</span>`
        + '</div>';
    }
    if (!html) {
      html = '<div class="hit-idle">NO RECENT IMPACTS</div>';
    }
    if (this._hitsHtml !== html) {
      this._hitsHtml = html;
      this.hitsEl.innerHTML = html;
    }
  }

  _renderCrew(ship) {
    if (!this.crewEl) {
      return;
    }
    const roster = ship.crew.roster();
    let html = '';
    for (const c of roster) {
      const sec = ship.hull.sectionById[c.at];
      const where = sec ? sec.label : '—';
      const state = c.alive
        ? (c.out > 0 ? `${c.task.toUpperCase()} ${c.out}/${c.parties}` : c.task.toUpperCase())
        : 'LOST';
      const cls = !c.alive ? 'dead' : (c.frac < 0.5 ? 'crit' : (c.frac < 0.85 ? 'warn' : 'ok'));
      html += `<div class="crew-row ${cls}"><span>${c.name}</span>`
        + `<span class="crew-count">${c.size}/${c.max}</span>`
        + `<span class="crew-where">${where}</span>`
        + `<span class="crew-state">${state}</span></div>`;
    }
    const spares = ship.sys.totalSpares();
    html += `<div class="crew-foot">SPARES ${spares}`
      + `  ·  COMPLEMENT ${ship.crew.headcount}/${ship.crew.complementMax}`
      + ` (${Math.round(ship.crew.complement * 100)}%)</div>`;
    if (this.crewEl.innerHTML !== html) {
      this.crewEl.innerHTML = html;
    }
  }

  /**
   * Plan view on top, profile below. Both are orthographic projections of the
   * same compartment boxes at the same scale, so a component's position in one
   * view lines up with its position in the other.
   */
  _renderCutaway(ship) {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    const hull = ship.hull;
    const sys = ship.sys;
    // Ships are long: the length axis runs across the panel.
    let maxZ = 0;
    let maxX = 0;
    let maxY = 0;
    for (const s of hull.sections) {
      maxZ = Math.max(maxZ, Math.abs(s.pos[2]) + s.half[2]);
      maxX = Math.max(maxX, Math.abs(s.pos[0]) + s.half[0]);
      maxY = Math.max(maxY, Math.abs(s.pos[1]) + s.half[1]);
    }
    const pad = 8;
    const half = (H - pad * 3) / 2;
    const scale = Math.min(
      (W - pad * 2) / (maxZ * 2),
      half / (Math.max(maxX, maxY) * 2),
    );

    const views = [
      { cy: pad + half / 2, up: 0, label: 'PLAN' },     // up = X (port/stbd)
      { cy: pad * 2 + half + half / 2, up: 1, label: 'PROFILE' },  // up = Y
    ];
    const cxOf = () => W / 2;

    // Which modules have been struck recently, and how hard. Derived from the
    // traces rather than stored on the modules, so nothing in the simulation
    // has to know a display exists.
    const struck = new Map();
    for (const path of ship.xray) {
      const glow = clamp01(1 - path.age / 1.8);
      if (glow <= 0) {
        continue;
      }
      for (const n of path.nodes) {
        if (!n.id) {
          continue;
        }
        const prev = struck.get(n.id);
        if (!prev || glow > prev.glow) {
          struck.set(n.id, { glow, killed: n.killed });
        }
      }
    }

    for (const view of views) {
      // Bow points right.
      const px = (z) => cxOf() + z * scale;
      const py = (u) => view.cy - u * scale;

      ctx.fillStyle = 'rgba(150,190,215,0.30)';
      ctx.font = '600 8px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(view.label, 4, view.cy - half / 2 + 8);

      for (const s of hull.sections) {
        const st = sys.section(s.id);
        const u = view.up === 0 ? s.pos[0] : s.pos[1];
        const hu = view.up === 0 ? s.half[0] : s.half[1];
        const x0 = px(s.pos[2] - s.half[2]);
        const x1 = px(s.pos[2] + s.half[2]);
        const y0 = py(u + hu);
        const y1 = py(u - hu);
        const w = x1 - x0;
        const h = y1 - y0;

        /**
         * The compartment as it is DRAWN, not as it is boxed.
         *
         * The cutaway used to be a row of rectangles, which was true when the
         * hull was a row of boxes. It is not any more: shells taper, so a
         * rectangle here would show a bow that is square in plan while the ship
         * outside is a wedge, and every module seated against the real plating
         * would read as floating in from the edge for no reason.
         *
         * Four corners, because the two faces of an axis taper independently.
         */
        const axis = view.up;
        const skin = (sign, end) => hu * skinFraction(
          s.style, axis, sign, end * s.half[2], s.half[2]);
        const outline = () => {
          ctx.beginPath();
          ctx.moveTo(x0, py(u + skin(1, -1)));
          ctx.lineTo(x1, py(u + skin(1, 1)));
          ctx.lineTo(x1, py(u - skin(-1, 1)));
          ctx.lineTo(x0, py(u - skin(-1, -1)));
          ctx.closePath();
        };

        // Fill shows atmosphere: a vented compartment reads as empty.
        const atmo = st.atmo;
        ctx.fillStyle = `rgba(70,110,140,${0.06 + 0.20 * atmo})`;
        outline();
        ctx.fill();
        if (st.fire > 0) {
          const f = clamp01(st.fire / 6);
          ctx.fillStyle = `rgba(255,110,40,${0.18 + 0.4 * f})`;
          outline();
          ctx.fill();
        }
        if (atmo < ATMO_CRITICAL) {
          // Hatching marks a compartment nobody can work in without a suit.
          ctx.save();
          outline();
          ctx.clip();
          ctx.strokeStyle = 'rgba(200,225,240,0.16)';
          ctx.lineWidth = 1;
          for (let d = -h; d < w; d += 6) {
            ctx.beginPath();
            ctx.moveTo(x0 + d, y1);
            ctx.lineTo(x0 + d + h, y0);
            ctx.stroke();
          }
          ctx.restore();
        }

        // Outline shows plate condition; a breach is drawn broken.
        const plate = clamp01(st.plateHp / st.plateMax);
        ctx.strokeStyle = st.breached
          ? 'rgba(255,90,70,0.95)'
          : `rgba(${Math.round(120 + 120 * (1 - plate))},${Math.round(190 * plate + 60)},${Math.round(215 * plate + 40)},0.75)`;
        ctx.lineWidth = st.frameBroken ? 0.8 : 1.4;
        if (st.breached) {
          ctx.setLineDash([3, 3]);
        }
        outline();
        ctx.stroke();
        ctx.setLineDash([]);

        // Modules.
        for (const def of hull.modulesBySection[s.id]) {
          const m = sys.get(def.id);
          if (!m) {
            continue;
          }
          const status = moduleStatus(sys, m);
          const mu = (view.up === 0 ? def.pos[0] : def.pos[1]) + u;
          const mhu = def.half ? (view.up === 0 ? def.half[0] : def.half[1]) : def.r;
          const mhz = def.half ? def.half[2] : def.r;
          const mx = px(s.pos[2] + def.pos[2]);
          const my = py(mu);
          const mw = Math.max(2, mhz * 2 * scale);
          const mh = Math.max(2, mhu * 2 * scale);
          ctx.fillStyle = LEVEL_COLOR[status.level];
          ctx.globalAlpha = m.destroyed ? 0.35 : 0.85;
          if (def.kind === 'conduit') {
            // Conduits draw as short runs so the networks read as plumbing
            // rather than as another box.
            ctx.fillRect(mx - mw, my - 1, mw * 2, 2);
          } else {
            ctx.fillRect(mx - mw / 2, my - mh / 2, mw, mh);
          }
          ctx.globalAlpha = 1;
          // Just been hit: flare the box so the eye is pulled to it before the
          // trace line has even finished drawing.
          const hit = struck.get(def.id);
          if (hit) {
            ctx.strokeStyle = hit.killed
              ? `rgba(255,90,70,${(0.35 + 0.65 * hit.glow).toFixed(2)})`
              : `rgba(255,170,90,${(0.3 + 0.6 * hit.glow).toFixed(2)})`;
            ctx.lineWidth = 1 + 1.6 * hit.glow;
            const g = 2 + 3 * hit.glow;
            ctx.strokeRect(mx - mw / 2 - g, my - mh / 2 - g, mw + g * 2, mh + g * 2);
          }
          if (def.id === this._selected) {
            ctx.strokeStyle = '#ffe08a';
            ctx.lineWidth = 1.4;
            ctx.strokeRect(mx - mw / 2 - 2, my - mh / 2 - 2, mw + 4, mh + 4);
          }
        }
      }

      // Crew, drawn last so they sit on top of the machinery they are fixing.
      //
      // Parties, not divisions: a division works as several small parties
      // scattered across the ship, and one dot per establishment put seventy
      // hands on a compartment most of them were nowhere near.
      for (const c of ship.crew.parties) {
        if (c.size <= 0) {
          continue;
        }
        const from = hull.sectionById[c.at];
        const to = c.heading ? hull.sectionById[c.heading] : from;
        const t = c.heading ? c.progress : 0;
        const z = from.pos[2] + (to.pos[2] - from.pos[2]) * t;
        const a = view.up === 0 ? from.pos[0] : from.pos[1];
        const b = view.up === 0 ? to.pos[0] : to.pos[1];
        const uu = a + (b - a) * t;
        // Marker area tracks headcount, so a division that has been gutted
        // visibly shrinks where it stands.
        const strength = c.max > 0 ? c.size / c.max : 0;
        ctx.beginPath();
        ctx.arc(px(z), py(uu), CREW_DOT * (0.45 + 0.55 * Math.sqrt(strength)),
          0, Math.PI * 2);
        ctx.fillStyle = ROLE_COLOR[c.role] || '#fff';
        ctx.globalAlpha = 0.4 + 0.6 * strength;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Shell paths last of all, over everything they went through.
      this._drawTraces(ctx, ship, px, py, view.up);
    }
  }

  /**
   * The penetration traces, drawn over the compartments they crossed.
   *
   * Each round walks its own path as it is replayed, so a burst reads as a
   * sequence of separate shots arriving rather than as a fan of static lines,
   * and the direction of attack is obvious without an arrowhead. Markers say
   * what happened at each layer: a tick for plate crossed, a dot for something
   * found inside, a ring for something finished, an X where the round stopped.
   */
  _drawTraces(ctx, ship, px, py, up) {
    const projX = (n) => px(n.z);
    const projY = (n) => py(up === 0 ? n.x : n.y);

    for (const path of ship.xray) {
      const n = path.nodes;
      if (n.length === 0) {
        continue;
      }
      const alpha = path.age <= XRAY_HOLD
        ? 1
        : clamp01(1 - (path.age - XRAY_HOLD) / (XRAY_FADE - XRAY_HOLD));
      if (alpha <= 0.01) {
        continue;
      }
      // Travel: how far along the path the replay has got, by arc length in
      // real metres so the round moves at a constant speed through the drawing
      // rather than jumping between widely-spaced layers.
      const seg = [];
      let total = 0;
      for (let i = 1; i < n.length; i++) {
        const d = Math.hypot(n[i].x - n[i - 1].x, n[i].y - n[i - 1].y, n[i].z - n[i - 1].z);
        seg.push(d);
        total += d;
      }
      const travelled = total * clamp01(path.age / XRAY_DRAW);

      // The line, laid down twice: a wide soft glow and a hot thin core.
      for (const pass of [{ w: 3.2, a: 0.16 }, { w: 1.1, a: 0.9 }]) {
        ctx.strokeStyle = `rgba(255,236,205,${(alpha * pass.a).toFixed(3)})`;
        ctx.lineWidth = pass.w;
        ctx.beginPath();
        ctx.moveTo(projX(n[0]), projY(n[0]));
        let run = 0;
        for (let i = 1; i < n.length; i++) {
          const d = seg[i - 1];
          if (run + d <= travelled || total === 0) {
            ctx.lineTo(projX(n[i]), projY(n[i]));
          } else {
            // Partial segment: stop the line where the round has got to.
            const f = d > 0 ? (travelled - run) / d : 0;
            ctx.lineTo(
              projX(n[i - 1]) + (projX(n[i]) - projX(n[i - 1])) * f,
              projY(n[i - 1]) + (projY(n[i]) - projY(n[i - 1])) * f,
            );
            break;
          }
          run += d;
        }
        ctx.stroke();
      }

      // Markers, revealed as the round reaches them.
      let run = 0;
      for (let i = 0; i < n.length; i++) {
        if (i > 0) {
          run += seg[i - 1];
        }
        if (run > travelled && total > 0) {
          break;
        }
        const node = n[i];
        const c = XRAY_COLOR[node.kind] || [255, 255, 255];
        const x = projX(node);
        const y = projY(node);
        const k = node.kind;
        if (k === 'module' || k === 'moduleStop') {
          ctx.fillStyle = rgba(c, alpha);
          ctx.beginPath();
          ctx.arc(x, y, node.killed ? 3.2 : 2.2, 0, Math.PI * 2);
          ctx.fill();
          if (node.killed) {
            ctx.strokeStyle = rgba(c, alpha * 0.8);
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.arc(x, y, 5.6, 0, Math.PI * 2);
            ctx.stroke();
          }
        } else if (k === 'stop' || k === 'wallStop' || k === 'surface') {
          ctx.strokeStyle = rgba(c, alpha);
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(x - 3, y - 3); ctx.lineTo(x + 3, y + 3);
          ctx.moveTo(x + 3, y - 3); ctx.lineTo(x - 3, y + 3);
          ctx.stroke();
        } else if (k === 'ricochet') {
          ctx.strokeStyle = rgba(c, alpha);
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(x, y, 3.4, 0, Math.PI * 2);
          ctx.stroke();
        } else if (k === 'shield' || k === 'shieldStop') {
          ctx.strokeStyle = rgba(c, alpha * 0.9);
          ctx.lineWidth = k === 'shieldStop' ? 2 : 1;
          ctx.beginPath();
          ctx.arc(x, y, 4.2, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          // Plate crossed: a short tick square to the path.
          ctx.strokeStyle = rgba(c, alpha * 0.85);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(x, y - 2.6); ctx.lineTo(x, y + 2.6);
          ctx.stroke();
        }
      }
    }
  }
}
