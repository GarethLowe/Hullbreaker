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
//             What you see here is exactly what a round will hit.
//   CREW      where the people are, what they are doing, and how they are.
//
// The panel can be pointed at the locked target (to plan a shot) or at your own
// ship (to work out what just broke). Both use identical code, because the two
// jobs are the same job seen from different ends.
// -----------------------------------------------------------------------------
import { SYSTEM_ORDER, NETS } from '../ship/hulls.js';
import { moduleStatus, LEVEL, ATMO_CRITICAL } from '../ship/systems.js';
import { clamp01, formatRange } from '../core/mathx.js';

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
    for (const sys of SYSTEM_ORDER) {
      const mods = groups.get(sys);
      if (!mods || mods.length === 0) {
        continue;
      }
      const head = document.createElement('div');
      head.className = 'diag-group';
      head.textContent = sys;
      this.treeEl.appendChild(head);
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
        row.appendChild(name);
        row.appendChild(bar);
        row.appendChild(val);
        this.treeEl.appendChild(row);
        this._rows.set(m.id, { row, fill, val, name });
      }
    }
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
    for (const [id, r] of this._rows) {
      const m = sys.get(id);
      if (!m) {
        continue;
      }
      const st = moduleStatus(sys, m);
      const cls = LEVEL_CLASS[st.level];
      if (r.row.dataset.lvl !== cls) {
        r.row.dataset.lvl = cls;
        r.row.className = `diag-row ${cls}`;
      }
      const sel = id === this._selected;
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
      const txt = m.repairing ? `${st.text} ·R` : st.text;
      if (r.val.textContent !== txt) {
        r.val.textContent = txt;
      }
    }

    this._renderCrew(ship);
    this._renderCutaway(ship);
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
        ? (c.heading ? 'MOVING' : c.task.toUpperCase())
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

        // Fill shows atmosphere: a vented compartment reads as empty.
        const atmo = st.atmo;
        ctx.fillStyle = `rgba(70,110,140,${0.06 + 0.20 * atmo})`;
        ctx.fillRect(x0, y0, w, h);
        if (st.fire > 0) {
          const f = clamp01(st.fire / 6);
          ctx.fillStyle = `rgba(255,110,40,${0.18 + 0.4 * f})`;
          ctx.fillRect(x0, y0, w, h);
        }
        if (atmo < ATMO_CRITICAL) {
          // Hatching marks a compartment nobody can work in without a suit.
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0, y0, w, h);
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
        ctx.strokeRect(x0, y0, w, h);
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
          if (def.id === this._selected) {
            ctx.strokeStyle = '#ffe08a';
            ctx.lineWidth = 1.4;
            ctx.strokeRect(mx - mw / 2 - 2, my - mh / 2 - 2, mw + 4, mh + 4);
          }
        }
      }

      // Crew, drawn last so they sit on top of the machinery they are fixing.
      for (const c of ship.crew.divisions) {
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
    }
  }
}
