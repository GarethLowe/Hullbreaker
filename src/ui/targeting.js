// -----------------------------------------------------------------------------
// targeting.js — contact tracking, target lock, subsystem selection, and the
// spherical radar.
//
// The radar is Elite's, because Elite's is right: a flat disc showing bearing
// and horizontal range, with a vertical stalk from the disc plane giving
// relative elevation. Two dimensions on the disc plus the stalk reads as three
// dimensions at a glance, and — unlike a perspective 3D scope — it stays
// legible when a contact is directly above you.
//
// Lock is a process, not a flag. A scan takes time, the time depends on your
// sensor array, and only a completed scan opens up the target's interior for
// subsystem selection. So shooting the sensors off a ship is not just a way to
// blind it — it is a way to stop it from picking YOUR components apart.
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { SYSTEM_ORDER, ENGAGEMENT_RANGE } from '../ship/hulls.js';
import { clamp01, interceptTime, formatRange } from '../core/mathx.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _local = new THREE.Vector3();
const _qi = new THREE.Quaternion();

/**
 * Radar range rings, metres. Derived from the engagement band rather than
 * fixed: the scope has to show the whole approach, not just the last moments
 * of it, or the player flies a twenty-kilometre battle on a four-kilometre
 * instrument.
 */
const RADAR_RANGE = ENGAGEMENT_RANGE * 3.6;
/** Half-angle of the "in the reticle" cone used by the direct-lock key. */
const LOCK_CONE = Math.cos(0.16);

export class Targeting {
  constructor(game) {
    this.game = game;
    this.target = null;
    this.subsystem = null;
    this.lock = 0;             // 0..1 scan progress on the current target
    this.contacts = [];
    this.canvas = document.getElementById('radar');
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this._lockBeep = 0;
    this._subIndex = -1;
  }

  get ship() {
    return this.game.player ? this.game.player.ship : null;
  }

  /** Ordered list of the target's modules, for subsystem cycling. */
  subsystemList() {
    if (!this.target) {
      return [];
    }
    const mods = [...this.target.sys.modules.values()];
    mods.sort((a, b) => {
      const d = SYSTEM_ORDER.indexOf(a.def.sys) - SYSTEM_ORDER.indexOf(b.def.sys);
      return d !== 0 ? d : a.label.localeCompare(b.label);
    });
    return mods;
  }

  // -- selection -------------------------------------------------------------

  /** Locks whatever is closest to the reticle. */
  lockAhead() {
    const ship = this.ship;
    if (!ship) {
      return;
    }
    ship.forward(_v);
    let best = null;
    let bestDot = LOCK_CONE;
    for (const c of this.game.ships) {
      if (c === ship || c.disposed) {
        continue;
      }
      _v2.copy(c.position).sub(ship.position);
      const d = _v2.length();
      if (d > RADAR_RANGE) {
        continue;
      }
      _v2.multiplyScalar(1 / d);
      // Bigger, closer ships subtend more sky and are correspondingly easier
      // to designate, which stops the key from feeling like a pixel hunt.
      const slack = c.hitRadius / Math.max(d, 1);
      const dot = _v2.dot(_v) + slack;
      if (dot > bestDot) {
        bestDot = dot;
        best = c;
      }
    }
    this.setTarget(best);
  }

  /** Cycles hostiles by range — Elite's "next target" key. */
  cycle(hostileOnly = true) {
    const ship = this.ship;
    if (!ship) {
      return;
    }
    const list = this.game.ships
      .filter((c) => c !== ship && !c.disposed
        && (!hostileOnly || c.faction !== ship.faction))
      .sort((a, b) => a.position.distanceToSquared(ship.position)
        - b.position.distanceToSquared(ship.position));
    if (list.length === 0) {
      this.setTarget(null);
      return;
    }
    const i = list.indexOf(this.target);
    this.setTarget(list[(i + 1) % list.length]);
  }

  setTarget(ship) {
    if (this.target === ship) {
      return;
    }
    this.target = ship;
    this.lock = 0;
    this.subsystem = null;
    this._subIndex = -1;
    if (ship) {
      this.game.audio.alarm('lock');
    }
  }

  /** Steps through the locked ship's modules. Requires a completed scan. */
  cycleSubsystem(dir = 1) {
    if (!this.target || this.lock < 1) {
      return;
    }
    const list = this.subsystemList();
    if (list.length === 0) {
      return;
    }
    // Slot 0 is "no subsystem, aim at the hull"; slots 1..n are the modules.
    const slots = list.length + 1;
    const slot = (((this._subIndex + 1 + dir) % slots) + slots) % slots;
    this._subIndex = slot - 1;
    if (this._subIndex < 0) {
      this.subsystem = null;
    } else {
      this.subsystem = list[this._subIndex].id;
    }
    this.game.audio.ui();
  }

  /** Jumps straight to the most damaged live module — a triage shortcut. */
  targetWeakest() {
    if (!this.target || this.lock < 1) {
      return;
    }
    const list = this.subsystemList().filter((m) => !m.destroyed);
    if (list.length === 0) {
      return;
    }
    list.sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp));
    this.subsystem = list[0].id;
    this._subIndex = this.subsystemList().indexOf(list[0]);
    this.game.audio.ui();
  }

  // -- per-frame -------------------------------------------------------------

  update(dt) {
    const ship = this.ship;
    if (!ship) {
      return;
    }
    if (this.target && this.target.disposed) {
      this.setTarget(null);
    }
    const q = ship.sys.sensorQuality();

    // Scan progress. No array, no lock — and a damaged array takes longer.
    if (this.target) {
      const d = this.target.position.distanceTo(ship.position);
      if (q <= 0.05 || d > RADAR_RANGE) {
        this.lock = Math.max(0, this.lock - dt * 0.8);
      } else {
        const rate = q * (0.55 + 0.45 * clamp01(1 - d / RADAR_RANGE));
        const was = this.lock;
        this.lock = clamp01(this.lock + rate * dt);
        if (was < 1 && this.lock >= 1) {
          this.game.audio.alarm('lock');
        }
      }
      if (this.subsystem) {
        const m = this.target.sys.get(this.subsystem);
        if (!m || m.destroyed) {
          this.subsystem = null;
          this._subIndex = -1;
        }
      }
    }

    this._buildContacts(q);
  }

  _buildContacts(sensorQuality) {
    const ship = this.ship;
    this.contacts.length = 0;
    if (sensorQuality <= 0.05) {
      return;
    }
    const range = RADAR_RANGE * (0.35 + 0.65 * sensorQuality);
    _qi.copy(ship.body.quat).invert();
    for (const c of this.game.ships) {
      if (c === ship || c.disposed) {
        continue;
      }
      _local.copy(c.position).sub(ship.position);
      const dist = _local.length();
      if (dist > range) {
        continue;
      }
      _local.applyQuaternion(_qi);
      this.contacts.push({
        ship: c,
        x: _local.x,
        y: _local.y,
        z: _local.z,
        dist,
        hostile: c.faction !== ship.faction,
        locked: c === this.target,
      });
    }
  }

  /** Aim point for the HUD lead pip and for the "on target" test. */
  leadPoint(out = new THREE.Vector3()) {
    const ship = this.ship;
    if (!ship || !this.target) {
      return null;
    }
    // Lead is computed for the guns the LEFT BUTTON is actually going to fire,
    // and within those for the slowest, because that is the one that will miss
    // if you trust the fastest.
    //
    // This used to read fireGroups[0] — the mounts the AI has to point the ship
    // at. On the player's cruiser that group is the ion projector and the two
    // lances, so the pip solved for a 1400 m/s weapon while the mass drivers
    // doing the actual shooting run at 2600, over-leading by 86% — about a
    // hundred metres of error at three kilometres against a crossing target.
    // The pip is the single mark the player aims by; it has to describe the
    // gun under their finger.
    const group = ship.weaponGroups[this.game.player ? this.game.player.primary : 0];
    const mounts = group ? group.mounts : ship.fireGroups[0];
    let speed = Infinity;
    for (const m of mounts) {
      if (m.weapon.muzzleVel) {
        speed = Math.min(speed, m.weapon.muzzleVel);
      }
    }
    if (!Number.isFinite(speed)) {
      return null;
    }
    const aimAt = this.subsystem ? this._modulePoint(this.target, this.subsystem, _v2) : null;
    _v.copy(aimAt || this.target.position).sub(ship.position);
    _v2.copy(this.target.velocity).sub(ship.velocity);
    const t = interceptTime(_v, _v2, speed);
    if (t === null || t > 8) {
      return null;
    }
    return out.copy(aimAt || this.target.position).addScaledVector(_v2, t);
  }

  _modulePoint(target, moduleId, out) {
    const def = target.hull.moduleById[moduleId];
    if (!def) {
      return out.copy(target.position);
    }
    const s = target.hull.sectionById[def.section];
    return out.set(
      s.pos[0] + def.pos[0] - target.hull.com[0],
      s.pos[1] + def.pos[1] - target.hull.com[1],
      s.pos[2] + def.pos[2] - target.hull.com[2],
    ).applyQuaternion(target.body.quat).add(target.position);
  }

  subsystemPoint(out = new THREE.Vector3()) {
    if (!this.target || !this.subsystem) {
      return null;
    }
    return this._modulePoint(this.target, this.subsystem, out);
  }

  // -- radar rendering -------------------------------------------------------

  render() {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2;
    const cy = H * 0.56;
    const R = Math.min(W, H * 1.55) * 0.42;
    // Vertical squash: the disc is drawn in perspective, viewed from slightly
    // above, which is what makes the elevation stalks readable.
    const squash = 0.42;

    const ship = this.ship;
    const blind = !ship || ship.sys.sensorQuality() <= 0.05;

    // --- disc --------------------------------------------------------------
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, squash);
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(0, 0, (R * i) / 3, 0, Math.PI * 2);
      ctx.strokeStyle = i === 3 ? 'rgba(120,190,220,0.40)' : 'rgba(120,190,220,0.16)';
      ctx.lineWidth = i === 3 ? 1.5 : 1;
      ctx.stroke();
    }
    // Cross hairs: forward is up, starboard is right.
    ctx.strokeStyle = 'rgba(120,190,220,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-R, 0); ctx.lineTo(R, 0);
    ctx.moveTo(0, -R); ctx.lineTo(0, R);
    ctx.stroke();
    ctx.restore();

    if (blind) {
      ctx.fillStyle = 'rgba(255,110,90,0.9)';
      ctx.font = '600 11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('SENSORS OFFLINE', cx, cy);
      return;
    }

    // --- contacts ----------------------------------------------------------
    const range = RADAR_RANGE;
    for (const c of this.contacts) {
      // Horizontal (in the ship's XZ plane) distance sets the radius; the
      // bearing sets the angle. Forward (+Z local) is up on the disc.
      const horiz = Math.hypot(c.x, c.z);
      const rr = Math.min(1, horiz / range) * R;
      // NEGATED x. The body frame is right-handed with +Z forward, which puts
      // +X to PORT (see flight.js) — so `atan2(c.x, c.z)` swept the wrong way
      // and the scope was mirrored left-for-right: a contact off the port bow
      // was painted off the starboard bow, and every evasive turn read as a
      // turn into the threat rather than away from it. The crosshair label
      // below has always said "starboard is right"; now it is.
      const ang = Math.atan2(-c.x, c.z);
      const px = cx + Math.sin(ang) * rr;
      const pyBase = cy - Math.cos(ang) * rr * squash;
      // Elevation stalk: height above/below the disc plane, same scale as the
      // radial axis so "twice as far up" looks twice as far up.
      const stalk = -(Math.min(Math.max(c.y / range, -1), 1)) * R * 0.62;
      const py = pyBase + stalk;

      ctx.strokeStyle = c.hostile ? 'rgba(255,120,90,0.45)' : 'rgba(120,230,160,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, pyBase);
      ctx.lineTo(px, py);
      ctx.stroke();

      // Base tick on the disc so the horizontal position is unambiguous.
      ctx.beginPath();
      ctx.ellipse(px, pyBase, 2.2, 2.2 * squash, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(180,210,230,0.35)';
      ctx.fill();

      const size = c.locked ? 5 : 3.4;
      ctx.fillStyle = c.hostile ? '#ff7a5a' : '#7ae6a0';
      ctx.beginPath();
      ctx.arc(px, py, size, 0, Math.PI * 2);
      ctx.fill();
      if (c.locked) {
        ctx.strokeStyle = '#ffe08a';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(px, py, size + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // --- own ship ----------------------------------------------------------
    ctx.fillStyle = '#cfe6f5';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx - 4, cy + 4);
    ctx.lineTo(cx + 4, cy + 4);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(150,190,215,0.55)';
    ctx.font = '500 9px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(formatRange(RADAR_RANGE), 6, H - 6);
    ctx.textAlign = 'right';
    ctx.fillText(`${this.contacts.length} CONTACTS`, W - 6, H - 6);
  }
}

export { RADAR_RANGE };
