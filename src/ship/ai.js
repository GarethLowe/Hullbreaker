// -----------------------------------------------------------------------------
// ai.js — the hostile pilot.
//
// The AI writes into exactly the same command struct the player's stick feeds,
// so it flies the same physics with the same damage penalties. It gets no
// hidden authority: an AI ship with its bow RCS shot off pitches badly for the
// same reason the player's would.
//
// What it knows is gated by its own sensors. Kill the array and it degrades to
// a last known position that goes stale, which is why a blinded ship flails
// instead of tracking. That is the point of modelling sensors as a module.
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { ENGAGEMENT_RANGE } from './hulls.js';
import { clamp, clamp01, damp, rand, interceptTime } from '../core/mathx.js';

const _v = new THREE.Vector3();
const _sep = new THREE.Vector3();
/**
 * How far past the nose a target must get before a broadside ship changes
 * shoulders. About thirty degrees — enough that ordinary jinking never triggers
 * a reversal, since swapping beams costs the whole battery its line for the
 * length of the turn.
 */
const BEAM_SWAP = 0.55;

const _local = new THREE.Vector3();
const _lead = new THREE.Vector3();
const _qi = new THREE.Quaternion();
/** Held across the whole gunnery call, so it cannot share with `_aimScan`. */
const _aim = new THREE.Vector3();
const _aimScan = new THREE.Vector3();
/** Second scratch for the facing test; `_aimScan` holds the bearing. */
const _aimFace = new THREE.Vector3();

export const AI_STATE = {
  PATROL: 'PATROL',
  APPROACH: 'APPROACH',
  ENGAGE: 'ENGAGE',
  BREAK: 'BREAK',
  WITHDRAW: 'WITHDRAW',
};

/**
 * How far a crippled ship tries to get before it turns and faces again. Kept
 * inside weapons range on purpose: a wreck that parks beyond the horizon is not
 * retreating, it is deleting itself from the fight and leaving the player
 * nothing to finish.
 */
const DISENGAGE_RANGE = ENGAGEMENT_RANGE * 1.3;
/** Beyond this the AI will not open fire. The weapons' useful reach. */
const WEAPONS_FREE = ENGAGEMENT_RANGE * 1.5;
/** And how long it is willing to spend running before it gives up on that. */
const WITHDRAW_LIMIT = 22;

/**
 * How often a shooter re-picks what it is aiming at.
 *
 * Long enough that a gun is not chasing a new point every frame — it lays,
 * fires for a while, then reconsiders — and short enough that no one part of
 * the target absorbs a whole engagement.
 */
const AIM_REVIEW = 2.5;

export class Pilot {
  constructor(ship, game) {
    this.ship = ship;
    this.game = game;
    this.state = AI_STATE.PATROL;
    this.target = null;
    this.stateT = 0;
    /** Where the target was when we could last actually see it. */
    this.lastSeen = new THREE.Vector3();
    this.lastSeenAge = 1e9;
    this.breakDir = new THREE.Vector3(1, 0, 0);
    // Per-ship personality so a wing does not fly in perfect unison.
    this.aggression = rand(0.7, 1.25);
    this.preferred = rand(ENGAGEMENT_RANGE * 0.62, ENGAGEMENT_RANGE * 1.15);
    this.reflex = rand(0.8, 1.3);
    this.wander = new THREE.Vector3();
    this.wanderT = 0;
    this.withdrawT = 0;
    /** Set once running has failed; from then on it fights where it stands. */
    this.lastStand = false;
    this.triggers = [false, false];
    /** Which shoulder is offered to the target; latched, see `_steer`. */
    this.beamSide = 0;
    /** The module this ship is trying to break, and when to reconsider it. */
    this.aimModule = null;
    this.aimT = 0;
    this._shouldFire = (m) => this.triggers[
      (m.turret || m.weapon.kind === 'missile') ? 1 : 0
    ];
  }

  update(dt) {
    const ship = this.ship;
    const cmd = ship.autopilot.cmd;
    const sys = ship.sys;
    this.stateT += dt;
    this.lastSeenAge += dt;

    // Without a computer there is no flight assist for anyone, AI included —
    // but a hostile crew works its helm by hand for the same reason the
    // player's does, so a crippled ship still fights its drift instead of
    // sailing off in a straight line.
    cmd.assist = sys.flightComputer;
    cmd.manual = true;

    this._acquire(dt);
    this._transition();

    switch (this.state) {
      case AI_STATE.PATROL:
        this._patrol(dt, cmd);
        break;
      case AI_STATE.APPROACH:
        this._approach(dt, cmd);
        break;
      case AI_STATE.ENGAGE:
        this._engage(dt, cmd);
        break;
      case AI_STATE.BREAK:
        this._break(dt, cmd);
        break;
      case AI_STATE.WITHDRAW:
        this._withdraw(dt, cmd);
        break;
      default:
        break;
    }

    // Fixed mounts fire on trigger 0, self-aiming mounts on trigger 1.
    ship.updateWeapons(dt, this.target, this._shouldFire, this._gunAim(dt, _aim));
  }

  /**
   * Where this ship's guns are laid: the doctrine module if it can pick one,
   * the hull centre otherwise.
   *
   * Which module of the preferred system it goes for is decided by geometry —
   * the one nearest the shooter, so it is aiming at the part of the target it
   * can actually see. That is what keeps a wing from stacking up on one point
   * even when two of them share a doctrine: two pickets on opposite beams
   * choose opposite drives, because each one's nearest is the other's far side.
   *
   * Aiming needs a firing solution, so it needs the sensor picture. A ship down
   * to a stale contact does not get to pick a subsystem — it is shooting at a
   * memory of a hull, and the memory does not have parts.
   */
  _gunAim(dt, out) {
    const target = this.target;
    if (!target || this.lastSeenAge > 0.4) {
      this.aimModule = null;
      return null;
    }
    this.aimT -= dt;
    const chosen = this.aimModule && target.sys.get(this.aimModule);
    if (this.aimT <= 0 || !chosen || chosen.destroyed) {
      this.aimT = AIM_REVIEW;
      this.aimModule = this._pickAim(target);
    }
    return this.aimModule ? target.modulePoint(this.aimModule, out) : null;
  }

  /**
   * Something live on the side of the target this ship can actually reach,
   * chosen at random.
   *
   * Random on purpose, and it is a correction. Laying every gun on the centre of
   * mass put a whole wave through one compartment — on the cruisers and up, the
   * engineering deck. Choosing by the SHOOTER's role instead only moved the
   * problem: every heavy in a wave wants the same system, so the plant became
   * the new centroid and the player spent every lull welding the same two
   * hundred square metres. Any rule that maps a shooter to a part of the target
   * concentrates, because waves arrive with duplicate hull classes in them.
   *
   * So the only thing that genuinely spreads damage is not having a rule. Each
   * ship picks afresh every `AIM_REVIEW` seconds, and a four-hull wave over a
   * minute of firing walks its damage over the whole target rather than boring
   * one hole through it. That is also the fairer arrangement: the player gets a
   * repair problem spread across the ship instead of one compartment they can
   * never get ahead of.
   *
   * "What is possible to it" is the near hemisphere. A gun cannot reach the far
   * side of a two-hundred-metre hull, so aiming there means aiming through the
   * ship — the rounds land on the near plating anyway and the choice is a lie.
   * Two ships on opposite beams therefore still work on opposite flanks.
   */
  _pickAim(target) {
    _aimScan.copy(this.ship.position).sub(target.position);
    if (_aimScan.lengthSq() < 1e-6) {
      return null;
    }
    let count = 0;
    let chosen = null;
    for (const m of target.sys.modules.values()) {
      // Conduits are wiring threaded through the whole ship rather than a place
      // on it, and they are already the thing a stray round cuts. Aim at the
      // machinery; severing the run that feeds it is a bonus, not a plan.
      if (m.destroyed || m.kind === 'conduit') {
        continue;
      }
      // Facing test in the target's own frame: is this module on the half of
      // the hull turned toward the shooter?
      target.modulePoint(m.id, _aimFace).sub(target.position);
      if (_aimFace.dot(_aimScan) <= 0) {
        continue;
      }
      // Reservoir sample, so one pass over the modules picks uniformly without
      // building an array every 2.5 seconds for every ship in the wave.
      count++;
      if (Math.random() < 1 / count) {
        chosen = m.id;
      }
    }
    return chosen;
  }

  /** Sensor-gated target acquisition. Bad sensors mean a stale, noisy picture. */
  _acquire(dt) {
    const q = this.ship.sys.sensorQuality();
    let best = null;
    let bestD = Infinity;
    for (const s of this.game.ships) {
      if (s === this.ship || s.disposed || s.faction === this.ship.faction) {
        continue;
      }
      const d = s.position.distanceTo(this.ship.position);
      // A degraded array simply cannot see as far.
      if (d > 200 + ENGAGEMENT_RANGE * 3.4 * q) {
        continue;
      }
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best) {
      this.target = best;
      if (q > 0.15) {
        this.lastSeen.copy(best.position);
        this.lastSeenAge = 0;
      }
    } else if (this.lastSeenAge > 12) {
      this.target = null;
    }
  }

  /**
   * State selection. Hysteresis on every boundary: a ship that is exactly at
   * its preferred range must not flip between closing and holding once per
   * tick, which is what produces the twitchy, indecisive behaviour that reads
   * as "spinning" from outside.
   */
  _transition() {
    const sys = this.ship.sys;
    const crippled = sys.integrity < 0.30 || sys.driveAuthority() < 0.12
      || this.ship.crew.complement < 0.30;

    // Recovery: the crew may well put it back together, and if they do it
    // rejoins the fight rather than running for the rest of the engagement.
    if (this.state === AI_STATE.WITHDRAW) {
      const recovered = sys.integrity > 0.45 && sys.driveAuthority() > 0.30
        && this.ship.crew.complement > 0.40;
      if (recovered) {
        this.lastStand = false;
        this._setState(this.target ? AI_STATE.APPROACH : AI_STATE.PATROL);
      } else if (this.withdrawT > WITHDRAW_LIMIT + 12) {
        // Running has not worked. Commit to fighting where it stands, and
        // latch it so the crippled test below cannot drag it straight back —
        // that flip-flop left the hull parked at max range doing nothing.
        this.lastStand = true;
        this._setState(this.target ? AI_STATE.ENGAGE : AI_STATE.PATROL);
      }
      return;
    }
    if (crippled && !this.lastStand) {
      this._setState(AI_STATE.WITHDRAW);
      return;
    }
    if (!this.target) {
      if (this.state !== AI_STATE.PATROL) {
        this._setState(AI_STATE.PATROL);
      }
      return;
    }

    const d = this.target.position.distanceTo(this.ship.position);
    const minR = this._minRange();
    switch (this.state) {
      case AI_STATE.PATROL:
        this._setState(AI_STATE.APPROACH);
        break;
      case AI_STATE.APPROACH:
        if (d < this.preferred * 1.5) {
          this._setState(AI_STATE.ENGAGE);
        }
        break;
      case AI_STATE.ENGAGE:
        if (d < minR) {
          this._setState(AI_STATE.BREAK);
        } else if (d > this.preferred * 3.2) {
          this._setState(AI_STATE.APPROACH);
        }
        break;
      case AI_STATE.BREAK:
        // Leave on distance OR a short timer, so a break always terminates.
        if (this.stateT > 1.6 || d > minR * 2.2) {
          this._setState(AI_STATE.ENGAGE);
        }
        break;
      default:
        break;
    }
  }

  _setState(s) {
    if (this.state === s) {
      return;
    }
    this.state = s;
    this.stateT = 0;
    if (s === AI_STATE.WITHDRAW) {
      this.withdrawT = 0;
    }
    if (s === AI_STATE.BREAK) {
      // Pick a break direction once, so the manoeuvre is committed rather than
      // re-rolled every frame into a twitch.
      this.breakDir.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
    }
  }

  /**
   * Turns a desired world-space heading into stick deflections. The only place
   * the AI touches the controls, so every behaviour flies with the same hands.
   *
   * Errors are ANGLES, not raw axis components. A component-based error is
   * ill-conditioned when the target is behind you — both lateral components go
   * to zero at the exact rear even though the error is 180 degrees — which is
   * what makes a component-steered AI flail the moment it overshoots. atan2 is
   * correct everywhere and needs no special cases.
   *
   * Sign note: the body frame is right-handed with +Z forward, so +X is PORT
   * (see flight.js). A target at +X therefore needs LEFT yaw. Getting this
   * backwards turns the whole loop into positive feedback, and the ship spins
   * up and away instead of tracking.
   */
  _steer(cmd, desiredDir, dt, rollToTarget = true, holdAspect = false) {
    _qi.copy(this.ship.body.quat).invert();
    _local.copy(desiredDir).applyQuaternion(_qi);
    if (_local.lengthSq() < 1e-8) {
      return 1;
    }
    _local.normalize();

    // +yawErr means "bring the nose to starboard", matching cmd.yaw.
    let yawErr = Math.atan2(-_local.x, _local.z);
    // Fly the ship its guns were built for. A hull whose main battery lives on
    // its wings has to hold the target off the bow to bring that battery to
    // bear, and steering everything to zero meant a broadside dreadnought
    // presented its nose and fought with the 31 MJ/s it could point forward
    // instead of the 76 it carries. Whichever beam the target is already
    // nearest to is the one to offer — swapping sides mid-fight just spins.
    const aspect = holdAspect ? this.ship.hull.fightAspect : 0;
    if (aspect > 0.01) {
      // Commit to a beam and STAY on it.
      //
      // Choosing the nearer side afresh every frame is what the comment above
      // warned about and what the code then did: the instant the target drifted
      // across the nose the demand jumped to the other beam, the ship turned
      // back, and it crossed again. Both broadside hulls ended up parked
      // halfway between the bow and the aspect they wanted — the worst bearing
      // available, too far off for the chase guns and not far enough for the
      // battery. Measured: a dreadnought asking for 71 degrees held 51 and got
      // two of its fifteen guns onto the target.
      //
      // The target has to get well past the nose on the other side before the
      // ship will change shoulders, which is also how you would actually fly it.
      if (this.beamSide === 0
        || (this.beamSide > 0 && yawErr < -BEAM_SWAP)
        || (this.beamSide < 0 && yawErr > BEAM_SWAP)) {
        this.beamSide = yawErr >= 0 ? 1 : -1;
      }
      yawErr -= this.beamSide * aspect;
    }
    const pitchErr = Math.atan2(_local.y, Math.hypot(_local.x, _local.z));
    const g = 1.35 * this.reflex;
    cmd.yaw = clamp(yawErr * g, -1, 1);
    cmd.pitch = clamp(pitchErr * g, -1, 1);

    const off = Math.hypot(_local.x, _local.y);
    if (rollToTarget && off > 0.18) {
      // Roll the target onto the DORSAL side — not merely onto the pitch axis.
      //
      // Two reasons now. The old one: the pitch axis is the strongest on every
      // hull here, so putting the target overhead lets the best axis do the work
      // of the turn. The new one: guns are bolted to a face and cannot depress
      // more than a few degrees below it, so a target held under the keel is one
      // no dorsal turret can bear on. This used to roll to whichever side came
      // first and, for a target abeam, that was reliably the ventral one — the
      // ship would turn to face a contact and mask its own broadside doing it.
      //
      // `theta` is the target's bearing around the roll axis, zero dead
      // overhead. Driving it to zero is the same manoeuvre, aimed properly.
      // Only worth doing when the target is genuinely off-axis; rolling to
      // correct small errors looks drunk.
      const theta = Math.atan2(_local.x, _local.y);
      cmd.roll = clamp(-theta * 1.1 * clamp01((off - 0.18) * 2.5), -1, 1);
    } else {
      cmd.roll = damp(cmd.roll, 0, 5, dt);
    }
    return _local.z;   // cosine of the angle off boresight
  }

  /** Where to point to hit the target, accounting for shot travel time. */
  _aimPoint(out) {
    const target = this.target;
    let speed = Infinity;
    for (const m of this.ship.fireGroups[0]) {
      if (m.weapon.muzzleVel) {
        speed = Math.min(speed, m.weapon.muzzleVel);
      }
    }
    if (!Number.isFinite(speed)) {
      speed = 1200;
    }
    const stale = this.lastSeenAge > 0.4;
    out.copy(stale ? this.lastSeen : target.position).sub(this.ship.position);
    if (!stale) {
      _v.copy(target.velocity).sub(this.ship.velocity);
      const t = interceptTime(out, _v, speed);
      if (t !== null && t < 5) {
        out.addScaledVector(_v, t);
      }
    }
    return out;
  }

  /** Distance below which closing further is a ramming risk, not a pass. */
  _minRange() {
    const t = this.target;
    const sep = this.ship.hitRadius + (t ? t.hitRadius : 0);
    let closing = 0;
    if (t) {
      _v.copy(t.position).sub(this.ship.position);
      const d = _v.length();
      if (d > 1e-3) {
        _v.multiplyScalar(1 / d);
        _sep.copy(this.ship.velocity).sub(t.velocity);
        closing = Math.max(0, _sep.dot(_v));
      }
    }
    // Enough room to pull out at the rate this hull can actually manage.
    return Math.max(sep * 4, sep * 2.5 + closing * 6);
  }

  /**
   * Cosine of the largest boresight error that still puts rounds on the hull.
   * Derived from how much sky the target actually subtends, so it tightens
   * automatically with range. A fixed ten-degree cone is a 900 m lateral miss
   * at five kilometres, which is how an AI ends up emptying its magazines
   * into empty space while appearing to aim perfectly well.
   */
  _aimCos(target, dist) {
    const half = Math.atan2(target.hitRadius * 0.75, Math.max(dist, 1));
    return Math.cos(half + 0.0035);
  }

  _turretsBear(tolerance = 0.05) {
    const t = this.target;
    return !!t && this.ship.fireGroups[1].some((m) => this.ship.onTarget(m, t, tolerance));
  }

  _patrol(dt, cmd) {
    this.wanderT -= dt;
    if (this.wanderT <= 0) {
      this.wanderT = rand(3, 7);
      this.wander.set(rand(-1, 1), rand(-0.5, 0.5), rand(-1, 1)).normalize();
    }
    this._steer(cmd, this.wander, dt, false);
    cmd.throttle = damp(cmd.throttle, 0.3, 2, dt);
    cmd.boost = false;
    cmd.strafeX = 0;
    cmd.strafeY = 0;
    this.triggers[0] = false;
    this.triggers[1] = false;
  }

  /** Close the gap. Nose on the lead point, throttle up, no shooting yet. */
  _approach(dt, cmd) {
    if (!this.target) {
      this._patrol(dt, cmd);
      return;
    }
    this._aimPoint(_lead);
    const dist = _lead.length();
    _lead.normalize();
    const cos = this._steer(cmd, _lead, dt);
    // Only run the throttle up once roughly pointed the right way, or the ship
    // sails past sideways while it is still turning.
    cmd.throttle = damp(cmd.throttle, cos > 0.6 ? 1 : 0.35, 2, dt);
    cmd.boost = dist > 2600 && cos > 0.9;
    cmd.strafeX = 0;
    cmd.strafeY = 0;
    this.triggers[0] = false;
    this.triggers[1] = dist < WEAPONS_FREE && this._turretsBear();
  }

  /**
   * The state a fight actually happens in. The AI holds a standoff range with
   * a proportional-derivative controller on the gap rather than flying past and
   * coming round again, so there is a stable window in which both sides can
   * shoot each other. Without it every engagement is merge-and-overshoot and
   * the player never gets sustained time on target.
   */
  _engage(dt, cmd) {
    const target = this.target;
    if (!target) {
      this._patrol(dt, cmd);
      return;
    }
    this._aimPoint(_lead);
    const dist = _lead.length();
    _lead.normalize();
    const cos = this._steer(cmd, _lead, dt, true, true);

    // Range hold. `closing` is how fast the gap is shrinking; damping on it
    // keeps the controller from surging in and out.
    _v.copy(target.position).sub(this.ship.position);
    const d = Math.max(_v.length(), 1);
    _v.multiplyScalar(1 / d);
    _sep.copy(this.ship.velocity).sub(target.velocity);
    const closing = _sep.dot(_v);
    const gap = dist - this.preferred;
    let want = clamp(gap * 0.0035 - closing * 0.010, -0.45, 1);
    if (d < this._minRange() * 1.2 && closing > 0) {
      want = Math.min(want, -0.2);   // never drive forward into a collision
    }
    // Range is held along the LINE OF SIGHT, not along the nose.
    //
    // The main drive pushes where the ship is pointing, and a broadside hull
    // deliberately points 63 to 71 degrees away from what it is shooting at. So
    // throttle stopped controlling range for those ships and started controlling
    // tangential speed: the controller saw the gap widening, commanded more
    // throttle, and drove them further off. Two capital ships opened from 5.7 km
    // to 13.8 km and stopped fighting each other entirely, which is where the
    // draws came from.
    //
    // Resolving the demand into the axes the ship actually has costs nothing for
    // a nose-fighter — its line of sight IS its nose, so this reduces to the old
    // behaviour — and gives a broadside ship the lateral thrust it needs to hold
    // station on a target it is presenting its flank to.
    _qi.copy(this.ship.body.quat).invert();
    _local.copy(_v).applyQuaternion(_qi);
    cmd.throttle = damp(cmd.throttle, clamp(want * _local.z, -0.45, 1), 2.5, dt);
    cmd.boost = false;

    // Weave across the line of sight so it is not a stationary gun platform,
    // laid over the station-keeping rather than replacing it. `strafeX` pushes
    // to STARBOARD, which is -X in this frame, so closing on a target off the
    // port bow is a negative deflection.
    const t = performance.now() * 0.001;
    const hold = clamp(-want * _local.x, -1, 1);
    cmd.strafeX = clamp(hold
      + Math.sin(t * 0.9 * this.reflex + this.ship.id) * 0.45 * this.aggression, -1, 1);
    cmd.strafeY = Math.cos(t * 0.7 * this.reflex + this.ship.id * 1.7) * 0.45;

    const seen = this.lastSeenAge < 1.2;
    this.triggers[0] = seen && dist < WEAPONS_FREE && cos > this._aimCos(target, dist);
    this.triggers[1] = seen && dist < WEAPONS_FREE && this._turretsBear();
  }

  /** Short, committed separation when a pass has closed to ramming distance. */
  _break(dt, cmd) {
    if (this.target) {
      _v.copy(this.ship.position).sub(this.target.position).normalize()
        .addScaledVector(this.breakDir, 0.55).normalize();
    } else {
      _v.copy(this.breakDir);
    }
    this._steer(cmd, _v, dt);
    cmd.throttle = damp(cmd.throttle, 1, 3, dt);
    cmd.boost = false;
    cmd.strafeX = this.breakDir.x * 0.6;
    cmd.strafeY = this.breakDir.y * 0.6;
    this.triggers[0] = false;
    this.triggers[1] = this._turretsBear();
  }

  /**
   * Crippled. Break contact and buy the damage-control party time — but this is
   * a fighting withdrawal, not a permanent exit. A ship that runs at full boost
   * forever is unkillable and unfun: it turns every engagement into a stern
   * chase the player cannot win. So the retreat ends. Once clear it turns and
   * holds at standoff range with its turrets working, comes back if the crew
   * get it flying again, and stops running altogether after a while.
   */
  _withdraw(dt, cmd) {
    const threat = this.target;
    this.withdrawT += dt;
    if (!threat) {
      this._patrol(dt, cmd);
      return;
    }
    const dist = threat.position.distanceTo(this.ship.position);
    if (dist < DISENGAGE_RANGE && this.withdrawT < WITHDRAW_LIMIT) {
      _v.copy(this.ship.position).sub(threat.position).normalize();
      this._steer(cmd, _v, dt, false);
      cmd.throttle = damp(cmd.throttle, 1, 2, dt);
      // Boost to open the initial gap only — not on a permanent loop.
      cmd.boost = this.withdrawT < 4;
      cmd.strafeX = 0;
      cmd.strafeY = 0;
      this.triggers[0] = false;
      this.triggers[1] = this._turretsBear(0.06);
      return;
    }
    // Clear, or out of patience. Turn and face so the guns bear. A cornered
    // ship is still a ship with guns — and plenty of hulls here carry no
    // turrets at all, so leaving this to trigger 1 alone disarms them.
    this._aimPoint(_lead);
    const bear = _lead.length();
    _lead.normalize();
    const cos = this._steer(cmd, _lead, dt, true, true);
    cmd.throttle = damp(cmd.throttle, 0, 2, dt);
    cmd.boost = false;
    cmd.strafeX = 0;
    cmd.strafeY = 0;
    const seen = this.lastSeenAge < 1.5;
    this.triggers[0] = seen && bear < WEAPONS_FREE && cos > this._aimCos(threat, bear);
    this.triggers[1] = seen && this._turretsBear(0.06);
  }
}

