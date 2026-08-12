// -----------------------------------------------------------------------------
// flight.js — rigid-body dynamics and the flight control law.
//
// Two layers, deliberately separated:
//
//   Body     honest 6DOF Newton-Euler integration. Forces and torques in,
//            position and orientation out. It knows nothing about ships. The
//            gyroscopic term is included, so an asymmetric hull tumbling with
//            its RCS shot away precesses the way it should instead of spinning
//            on a fixed axis forever.
//
//   Autopilot  the thing that makes it feel like Elite rather than like a
//            physics demo. Flight assist is a RATE COMMAND loop: the stick asks
//            for an angular velocity and the controller spends whatever torque
//            it has to hold it, and a velocity-matching loop that pulls the
//            ship's actual velocity toward "throttle setting along the nose".
//            Turn assist off and you get the honest Newtonian ship underneath.
//
// Damage enters here as authority: `driveAuthority`, `rcsAuthority` per axis and
// the pilot's own station quality all scale what the controller is allowed to
// ask for. A ship with its port roll jets shot out does not fly a bit worse in
// general — it rolls one way and not the other.
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { clamp, clamp01 } from '../core/mathx.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _spin = new THREE.Quaternion();

// Ship-local basis. The hull tables are authored with the bow at +Z and the
// deck at +Y. In a right-handed frame that puts +X to PORT, so "starboard" —
// the direction the pilot calls right — is -X. Naming it explicitly here so
// nothing downstream has to rediscover it the hard way.
export const FORWARD = new THREE.Vector3(0, 0, 1);
export const UP = new THREE.Vector3(0, 1, 0);
export const STARBOARD = new THREE.Vector3(-1, 0, 0);

/**
 * Propellant drawn per second, as a fraction of a full bunker, by a drive at
 * full duty carrying the WHOLE ship — a hull with two drives at share 0.5 pulls
 * half this from each of its two tanks.
 *
 * These are fusion drives (hulls.js calls the plant a FUSION CORE), and that
 * settles the order of magnitude rather than being flavour text. A fusion torch
 * exhausts at something like 1e5 m/s; the fastest hull here tops out at 230 m/s
 * and a whole engagement is a few km/s of throttling all told. Tsiolkovsky then
 * puts the propellant cost of an entire fight in the low single-digit per cent
 * of the tankage. Spending a bunker to fly one battle is not a balance choice,
 * it is off by two orders of magnitude.
 *
 * At the old 0.30 a MERIDIAN had 667 seconds of held throttle and 370 with the
 * boost lit. That is not a reserve, it is a fuse — and the throttle is a HELD
 * demand (pilot.js: release W and an assisted ship brakes itself to a stop), so
 * the player is at full duty for essentially the whole fight and burns the
 * entire allowance. Waves are 45 s apart plus the fighting, so the tanks ran dry
 * somewhere around wave five and the cruiser spent the rest of the run coasting:
 * `driveAuthority` gates on `store > 0.5` and drops the drive's whole share the
 * instant it crosses, so it is a cliff, not a taper.
 *
 * 0.04 gives that MERIDIAN 5000 s of held throttle, 2778 with the boost lit. A
 * fifteen-wave run is about 1530 s of flying and costs 31% of a bunker: the
 * gauge moves enough to be worth watching and never ends the run. What still
 * empties a tank is being shot: a breached bunker leaks 10 units a second
 * (systems.js `_tickThermal`), so damage outruns burn by 500x and the bunker
 * stays a thing worth putting a round through.
 */
export const BURN_RATE = 0.04;

export class Body {
  constructor(hull) {
    this.mass = hull.mass;
    this.invMass = 1 / hull.mass;
    this.inertia = new THREE.Vector3(...hull.inertia);
    this.invInertia = new THREE.Vector3(
      1 / hull.inertia[0], 1 / hull.inertia[1], 1 / hull.inertia[2],
    );
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    /** Angular velocity in the BODY frame — Euler's equations live there. */
    this.omega = new THREE.Vector3();
    this.force = new THREE.Vector3();
    this.torque = new THREE.Vector3();     // body frame
    this.radius = hull.radius;
    /** Centre of mass offset in body coordinates, from the hull tables. */
    this.com = new THREE.Vector3(...hull.com);
  }

  /**
   * Where the hull is and what it is doing. Everything else on a Body is mass
   * properties read straight off the hull tables and identical on any ship of
   * the class, so it is not state and does not travel.
   */
  snapshot() {
    return {
      pos: this.pos.toArray(),
      vel: this.vel.toArray(),
      quat: this.quat.toArray(),
      omega: this.omega.toArray(),
    };
  }

  restore(snap) {
    if (!snap) {
      return;
    }
    this.pos.fromArray(snap.pos);
    this.vel.fromArray(snap.vel);
    this.quat.fromArray(snap.quat);
    this.omega.fromArray(snap.omega);
    // Accumulators, not state: whatever was pushing on the hull belongs to the
    // tick it was pushing in.
    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
  }

  addForce(worldVec) {
    this.force.add(worldVec);
  }

  addForceLocal(localVec) {
    _v.copy(localVec).applyQuaternion(this.quat);
    this.force.add(_v);
  }

  addTorqueLocal(localVec) {
    this.torque.add(localVec);
  }

  /**
   * Off-centre impulse: a hit on a wingtip both shoves and spins the ship, which
   * is why raking a hull along one flank sets it tumbling. `point` is world.
   */
  applyImpulseAt(point, dirUnit, magnitude) {
    _v.copy(dirUnit).multiplyScalar(magnitude);
    this.vel.addScaledVector(_v, this.invMass);
    // r x F, taken about the real centre of mass and expressed body-frame.
    // Body.pos is already the world-space centre of mass, so point - pos is
    // the complete lever arm. Subtracting this.com here would count it twice.
    _v2.copy(point).sub(this.pos);
    _v2.applyQuaternion(_q.copy(this.quat).invert());
    _v.applyQuaternion(_q);                 // impulse into body frame
    _v2.cross(_v);
    this.omega.x += _v2.x * this.invInertia.x;
    this.omega.y += _v2.y * this.invInertia.y;
    this.omega.z += _v2.z * this.invInertia.z;
  }

  localToWorld(local, out = new THREE.Vector3()) {
    return out.copy(local).sub(this.com).applyQuaternion(this.quat).add(this.pos);
  }

  worldToLocal(world, out = new THREE.Vector3()) {
    return out.copy(world).sub(this.pos)
      .applyQuaternion(_q.copy(this.quat).invert()).add(this.com);
  }

  forward(out = new THREE.Vector3()) {
    return out.copy(FORWARD).applyQuaternion(this.quat);
  }

  /** Semi-implicit Euler. Fixed step, so the gains above stay meaningful. */
  integrate(dt) {
    this.vel.addScaledVector(this.force, this.invMass * dt);
    this.pos.addScaledVector(this.vel, dt);

    _v2.set(
      this.omega.x * this.inertia.x,
      this.omega.y * this.inertia.y,
      this.omega.z * this.inertia.z,
    );
    const momentumSq = this.torque.lengthSq() === 0 ? _v2.lengthSq() : 0;

    // Euler's rotation equation: I·ω' = τ - ω × (I·ω).
    _v.set(
      this.omega.x * this.inertia.x,
      this.omega.y * this.inertia.y,
      this.omega.z * this.inertia.z,
    );
    _v.cross(this.omega).add(this.torque);
    this.omega.x += _v.x * this.invInertia.x * dt;
    this.omega.y += _v.y * this.invInertia.y * dt;
    this.omega.z += _v.z * this.invInertia.z * dt;
    if (momentumSq > 0) {
      _v2.set(
        this.omega.x * this.inertia.x,
        this.omega.y * this.inertia.y,
        this.omega.z * this.inertia.z,
      );
      const afterSq = _v2.lengthSq();
      if (afterSq > 0) {
        this.omega.multiplyScalar(Math.sqrt(momentumSq / afterSq));
      }
    }

    // Quaternion derivative from the world-frame angular velocity.
    _v.copy(this.omega).applyQuaternion(this.quat);
    _spin.set(_v.x, _v.y, _v.z, 0).multiply(this.quat);
    this.quat.x += _spin.x * 0.5 * dt;
    this.quat.y += _spin.y * 0.5 * dt;
    this.quat.z += _spin.z * 0.5 * dt;
    this.quat.w += _spin.w * 0.5 * dt;
    this.quat.normalize();

    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
  }
}

/**
 * The control law. `cmd` is the pilot's (or the AI's) demand, all in -1..1
 * except `throttle`, which is -0.4..1 so a ship can back off but not fly
 * backwards as fast as it flies forwards.
 */
export function makeCommand() {
  return {
    pitch: 0, yaw: 0, roll: 0,
    throttle: 0,
    strafeX: 0, strafeY: 0,
    boost: false,
    assist: true,
    /**
     * Helm under manual control. Only does anything when the flight computer
     * is gone — it is the crew flying the drives by hand instead of nothing at
     * all happening.
     */
    manual: true,
  };
}

export class Autopilot {
  constructor(hull, systems, crew) {
    this.hull = hull;
    this.sys = systems;
    this.crew = crew;
    this.cmd = makeCommand();
    this.boostT = 0;
    this.boostCool = 0;
    this._auth = [0, 0, 0];
    /** Cached for the HUD: what the ship could actually manage this tick. */
    this.readout = { speed: 0, setSpeed: 0, maxSpeed: 0, drive: 1, assist: true };
  }

  /**
   * Applies the command to the body for one step. Returns nothing; the caller
   * integrates. Split out so the AI and the player run identical physics.
   */
  update(body, dt) {
    const f = this.hull.flight;
    const sys = this.sys;
    const cmd = this.cmd;

    const drive = sys.driveAuthority();
    const lateral = sys.lateralAuthority();
    sys.rcsAuthority(this._auth);
    // An empty helm still flies — badly. The autopilot holds the ship but has
    // none of a pilot's gain, so it wallows.
    const pilot = this.crew ? 0.45 + 0.55 * this.crew.station('pilot') : 1;
    // Flight assist IS the computer. Lose it and you get the raw ship.
    const assist = cmd.assist && sys.flightComputer;
    this.readout.assist = assist;
    this.readout.drive = drive;

    // -- boost ---------------------------------------------------------------
    if (this.boostCool > 0) {
      this.boostCool -= dt;
    }
    if (cmd.boost && this.boostT <= 0 && this.boostCool <= 0
        && sys.capStore > sys.capMax * 0.25 && drive > 0.2) {
      this.boostT = 2.2;
      this.boostCool = 7.0;
      sys.capStore = Math.max(0, sys.capStore - sys.capMax * 0.45);
    }
    if (this.boostT > 0) {
      this.boostT -= dt;
    }
    const boosting = this.boostT > 0;

    const maxSpeed = (boosting ? f.boostSpeed : f.maxSpeed) * (0.35 + 0.65 * drive);
    const thrust = (boosting ? f.boostThrust : f.mainThrust) * drive;
    this.readout.maxSpeed = maxSpeed;

    // -- rotation ------------------------------------------------------------
    // Rate command under assist, direct torque without it. Both are limited by
    // the surviving RCS on that specific axis, which is why losing one block
    // costs you a particular axis rather than a general sluggishness.
    //
    // Sign convention. The body frame is right-handed with +Z forward and +Y
    // up, which means +X points to PORT — not starboard, however much it reads
    // like it should. (Right-handed: X x Y = Z, and right x up = backward, so a
    // frame whose +Z is forward has its +X on the left.) Getting this backwards
    // is what made yaw and roll come out mirrored. Measured, not reasoned:
    //   +omega.x tips the top of the hull forward -> nose DOWN
    //   +omega.y swings the nose toward port      -> yaw LEFT
    //   +omega.z lifts the port side              -> roll LEFT
    // The command is in pilot intent (+pitch nose up, +yaw right, +roll
    // starboard-down), so all three invert.
    const wantRate = [
      -cmd.pitch * f.pitchRate * this._auth[0],
      -cmd.yaw * f.yawRate * this._auth[1],
      cmd.roll * f.rollRate * this._auth[2],
    ];
    const axisTorque = f.torque;
    const fullRate = [f.pitchRate, f.yawRate, f.rollRate];
    const omega = [body.omega.x, body.omega.y, body.omega.z];
    const out = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const cap = axisTorque[i] * this._auth[i];
      if (cap <= 0) {
        continue;
      }
      if (assist) {
        // Rate error into a saturating proportional term, normalised by the
        // axis's OWN full rate. The gain is then "fraction of available torque
        // per full-scale rate error", which makes the loop indifferent to hull
        // rate as well as to hull mass: full stick from rest saturates the
        // jets on an interceptor turning at 2 rad/s and on a cruiser turning
        // at 0.06 alike, and both reach their commanded rate in `spool`.
        //
        // The gain used to be per rad/s absolute. That is fine at fighter
        // rates and silently collapses at capital ones — 0.063 rad/s x 3.2 is
        // a 20% torque request, so the cruiser crawled to a rate it was built
        // to hit in three seconds, and the first second of held yaw moved the
        // nose 0.15 degrees. It read, correctly, as a dead control.
        const err = (wantRate[i] - omega[i]) / Math.max(fullRate[i], 1e-4);
        out[i] = clamp(err * 3.2 * pilot, -1, 1) * cap;
      } else {
        // Raw torque: the stick is wired to the jets and nothing damps you.
        out[i] = Math.sign(wantRate[i]) * Math.abs(
          i === 0 ? cmd.pitch : (i === 1 ? cmd.yaw : cmd.roll),
        ) * cap;
      }
    }
    body.torque.x += out[0];
    body.torque.y += out[1];
    body.torque.z += out[2];

    // -- translation ---------------------------------------------------------
    body.forward(_v);
    const along = body.vel.dot(_v);
    this.readout.speed = body.vel.length();
    this.readout.setSpeed = cmd.throttle * maxSpeed;

    if (assist) {
      // Velocity matching: aim for "throttle × max speed, along the nose", plus
      // whatever strafe is being asked for. The difference is what the thrusters
      // are told to cancel — this is what makes an assisted ship turn and have
      // its velocity follow the nose around.
      _v2.copy(_v).multiplyScalar(cmd.throttle * maxSpeed);
      if (lateral > 0) {
        _v.copy(STARBOARD).applyQuaternion(body.quat)
          .multiplyScalar(cmd.strafeX * f.maxSpeed * 0.32 * lateral);
        _v2.add(_v);
        _v.copy(UP).applyQuaternion(body.quat)
          .multiplyScalar(cmd.strafeY * f.maxSpeed * 0.32 * lateral);
        _v2.add(_v);
      }
      _v2.sub(body.vel);
      const err = _v2.length();
      if (err > 1e-4) {
        // Split the correction into the part along the nose and the part across
        // it. The main drive services the axial component in BOTH directions —
        // that is what the assist system is for, and it is why letting go of the
        // throttle brings the ship to a stop as briskly as it got up to speed.
        // Everything lateral is jets, which are much weaker, so an assisted ship
        // still slides through a hard turn instead of railing round it.
        body.forward(_v);
        const axial = Math.abs(_v2.dot(_v)) / err;
        const cap = thrust * axial + f.rcsThrust * lateral * (1 - axial);
        _v2.multiplyScalar(1 / err);
        const wanted = Math.min(err * body.mass * 2.4, Math.max(cap, f.rcsThrust * lateral));
        body.force.addScaledVector(_v2, wanted);
      }
    } else {
      // Newtonian: the throttle is a raw main-engine setting and strafe is raw
      // RCS. Nothing cancels drift but you.
      if (cmd.throttle !== 0 && thrust > 0) {
        body.forward(_v);
        body.force.addScaledVector(_v, thrust * clamp(cmd.throttle, -0.55, 1));
      }
      if (lateral > 0) {
        _v.copy(STARBOARD).applyQuaternion(body.quat);
        body.force.addScaledVector(_v, cmd.strafeX * f.rcsThrust * lateral);
        _v.copy(UP).applyQuaternion(body.quat);
        body.force.addScaledVector(_v, cmd.strafeY * f.rcsThrust * lateral);
      }

      // -- manual helm -------------------------------------------------------
      // Losing the flight computer used to mean losing the brakes outright:
      // the ship kept its velocity forever and the only way to stop was to
      // turn around and hold the throttle by eye. A crewed warship is not that
      // helpless — but it is not a computer either, and the difference is
      // worth modelling rather than papering over.
      //
      // Nobody aboard can solve a three-axis velocity correction in real time.
      // What a crew CAN do is read the drift, swing the ship until retrograde
      // is under the nose, and burn. So the main drive only bites to the
      // extent the nose is already pointing the right way — turning the ship
      // is the player's job — while the jets give a weak push in any
      // direction, which is what attitude thrusters are actually for. The
      // whole thing is scaled by who is left at the helm, so a bridge with its
      // watch dead cannot do it at all.
      const hands = this.crew ? this.crew.station('pilot') : 1;
      const drift = body.vel.length();
      if (cmd.manual && cmd.throttle === 0 && hands > 0.05 && drift > 0.05) {
        _v2.copy(body.vel).multiplyScalar(-1 / drift);
        body.forward(_v);
        const facing = Math.max(_v2.dot(_v), 0);
        const reach = thrust * facing + f.rcsThrust * lateral * 0.5;
        // Never overshoot into a reverse burn: cap the push at what would just
        // null the remaining drift over this step.
        const push = Math.min(drift * body.mass * 0.4, reach) * hands;
        body.force.addScaledVector(_v2, push);
        this.readout.manual = true;
      } else {
        this.readout.manual = false;
      }
    }

    // Hard ceiling on speed regardless of mode, so a long burn cannot outrun
    // the weapon ranges and turn every fight into a stern chase.
    const hardMax = f.boostSpeed * 1.25;
    const sp = body.vel.length();
    if (sp > hardMax) {
      body.vel.multiplyScalar(hardMax / sp);
    }

    // The drives are only working as hard as the throttle asks, and the thermal
    // model bills them for exactly that.
    const duty = clamp01(Math.abs(cmd.throttle) * (boosting ? 1.8 : 1));
    for (const m of sys.modules.values()) {
      if (m.kind === 'thruster') {
        m.duty = duty;
        // Burning propellant is what actually empties the tanks — whichever
        // tank the transfer main can actually reach, not just this drive's own.
        const tank = sys.fuelFor(m, 0);
        if (tank) {
          tank.store = Math.max(0, tank.store - duty * m.def.share * BURN_RATE * dt);
        }
      } else if (m.kind === 'rcs') {
        m.duty = clamp01(
          Math.abs(cmd.pitch) + Math.abs(cmd.yaw) + Math.abs(cmd.roll)
          + Math.abs(cmd.strafeX) + Math.abs(cmd.strafeY),
        );
      }
    }
    return { boosting, assist };
  }
}

/**
 * Elastic-ish impulse resolution between two spheres-with-inertia. Ships are
 * not billiard balls, so this is intentionally lossy: most of the energy goes
 * into the hull rather than back into motion.
 */
export function resolveCollision(a, b, restitution = 0.25) {
  // Dedicated temporaries kept local to collision resolution.
  const n = _colN;
  const rel = _colR;

  n.copy(b.pos).sub(a.pos);
  const dist = n.length();
  const minDist = a.radius + b.radius;
  if (dist >= minDist || dist < 1e-4) {
    return null;
  }
  n.multiplyScalar(1 / dist);          // contact normal, a -> b
  rel.copy(b.vel).sub(a.vel);
  const closing = rel.dot(n);
  // Push apart even when separating, so ships never end up welded together.
  const push = minDist - dist;
  const invMass = a.invMass + b.invMass;
  a.pos.addScaledVector(n, -push * a.invMass / invMass);
  b.pos.addScaledVector(n, push * b.invMass / invMass);
  if (closing >= 0) {
    return null;
  }
  const j = -(1 + restitution) * closing / (a.invMass + b.invMass);
  a.vel.addScaledVector(n, -j * a.invMass);
  b.vel.addScaledVector(n, j * b.invMass);
  // Sphere contact lies on the line of centres, so it has no physical torque.
  // A future hull-contact solver may add an angular impulse from its actual
  // off-centre contact point, but it must not apply translation a second time.
  const reducedMass = 1 / (a.invMass + b.invMass);
  const energy = 0.5 * reducedMass * closing * closing * (1 - restitution * restitution);
  return { impulse: j, energy, normal: n.clone() };
}

const _colN = new THREE.Vector3();
const _colR = new THREE.Vector3();
