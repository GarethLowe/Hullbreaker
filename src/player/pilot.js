// -----------------------------------------------------------------------------
// pilot.js — the player's hands, and the camera.
//
// The mouse is a virtual joystick for fine aim that springs back to centre;
// A/D and Q/E give sustained yaw and roll. Speed is a HELD demand rather than
// Elite's persistent throttle setting: hold W to build speed and release to
// coast back to a stop. Flight assist stays a toggle that changes what the ship
// is rather than a difficulty option.
//
// The camera is deliberately NOT rigidly parented to the hull. It lags the
// ship's rotation slightly and leans into the velocity vector, which is what
// makes a turn readable from inside the cockpit. Rigid parenting looks correct
// in a screenshot and reads as nothing at all in motion.
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { clamp, clamp01, damp, lerp } from '../core/mathx.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _euler = new THREE.Euler();

/** The hull tables put the bow at +Z; a Three.js camera looks down -Z. */
const NOSE_FIX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

export const VIEW = { COCKPIT: 'COCKPIT', CHASE: 'CHASE' };

/** How fast a held W/S builds the speed demand, and how fast it falls away. */
const THROTTLE_RATE = 1.15;
const THROTTLE_RELEASE = 3.0;
/** How fast the mouse stick returns to centre. Lower holds a deflection longer. */
const STICK_SPRING = 3.0;

/**
 * Camera shake per m/s of delta-v the hull took.
 *
 * Calibrated off the two ends of the real range rather than by taste. A
 * railgun slug carries 31 kNs, so it moves the cruiser 0.0007 m/s and lands at
 * 0.003 shake — below the threshold of noticing, which is the correct answer.
 * A magazine letting go inside the hull is 0.09 m/s and lands at 0.35, which is
 * a firm knock. Everything between falls where its momentum puts it, and a
 * picket feels each hit eleven times harder than a dreadnought because it
 * masses a fortieth as much.
 */
const SHAKE_PER_DV = 4.0;

export class PlayerPilot {
  constructor(game, ship) {
    this.game = game;
    this.ship = ship;
    this.input = game.input;
    this.camera = game.camera;

    /** Virtual stick position; the mouse pushes it, springs recentre it. */
    this.stick = { x: 0, y: 0 };
    this.throttle = 0;
    this.assist = true;
    this.view = VIEW.CHASE;
    /** Indices into ship.weaponGroups, fired by the left and right buttons. */
    this.primary = 0;
    this.secondary = ship.weaponGroups.length > 1 ? 1 : 0;
    this.firing = [false, false];
    /** Bound once so the per-step gunnery call allocates nothing. */
    this._fire = (m) => this.shouldFire(m);

    this.camPos = new THREE.Vector3();
    this.camQuat = new THREE.Quaternion();
    this.shake = 0;
    this.fov = 68;

    // Where the camera sits, in ship-local coordinates.
    const hull = ship.hull;
    const bridge = hull.sectionById.bridge || hull.sectionById.cockpit
      || hull.sectionById.citadel || hull.sections[0];
    this.cockpitOffset = new THREE.Vector3(
      0,
      bridge.pos[1] - hull.com[1] + bridge.half[1] * 0.35,
      bridge.pos[2] - hull.com[2] + bridge.half[2] * 0.55,
    );
    this.chaseOffset = new THREE.Vector3(0, hull.radius * 0.42, -hull.radius * 2.1);
    this.camPos.copy(ship.position);
    this.camQuat.copy(ship.body.quat).multiply(NOSE_FIX);
  }

  /**
   * Frame-scoped input. MUST run exactly once per animation frame, before the
   * simulation accumulator.
   *
   * Mouse deltas, the wheel and edge-triggered key presses are all accumulated
   * by the browser per frame and cleared by `Input.endFrame()` per frame. The
   * simulation, however, steps 0..5 times per frame depending on the display
   * rate. Reading this state from inside a per-step function therefore drops it
   * entirely on frames where no step runs (about 59% of frames at 144 Hz) and
   * applies it repeatedly when the display falls behind (twice at 30 fps).
   * That made the mouse feel dead on a fast monitor, oversensitive on a slow
   * one, and silently ate flight-assist and throttle keypresses.
   *
   * The rule: anything the browser hands us per frame is consumed here;
   * anything continuous (held keys, the stick's spring) is consumed per step.
   */
  readInput() {
    const input = this.input;

    if (input.locked) {
      this.stick.x += input.mouse.dx * input.sensitivity;
      this.stick.y += input.mouse.dy * input.sensitivity;
      this.stick.x = clamp(this.stick.x, -1, 1);
      this.stick.y = clamp(this.stick.y, -1, 1);
    }

    // Weapon selection. The wheel picks what the left button fires; hold shift
    // and it picks the right button's instead, so the two triggers can be laid
    // on any pair of the ship's weapons.
    const groups = this.ship.weaponGroups;
    if (input.mouse.wheel !== 0 && groups.length > 0) {
      const shift = input.down('ShiftLeft') || input.down('ShiftRight');
      const slot = shift ? 'secondary' : 'primary';
      const n = groups.length;
      this[slot] = (((this[slot] + Math.sign(input.mouse.wheel)) % n) + n) % n;
      this.game.hud.nudge(
        `${shift ? 'RMB' : 'LMB'} — ${groups[this[slot]].name}`, 1.8,
      );
      this.game.audio.ui();
    }

    if (input.pressed('KeyX')) {
      this.assist = !this.assist;
      this.game.hud.warn(`FLIGHT ASSIST ${this.assist ? 'ON' : 'OFF'}`);
      this.game.audio.ui();
    }

    this.firing[0] = input.buttons[0];
    this.firing[1] = input.buttons[2];
  }

  /**
   * Which mounts should be firing this tick. Passed to Ship.updateWeapons so
   * the player and the AI drive exactly the same gunnery code.
   */
  shouldFire(mount) {
    const groups = this.ship.weaponGroups;
    if (this.firing[0] && groups[this.primary]
        && groups[this.primary].mounts.includes(mount)) {
      return true;
    }
    return !!(this.firing[1] && groups[this.secondary]
      && groups[this.secondary].mounts.includes(mount));
  }

  /** Continuous input and the flight command. Called once per sim step. */
  update(dt) {
    const input = this.input;
    const cmd = this.ship.autopilot.cmd;
    const sys = this.ship.sys;

    // -- virtual stick -------------------------------------------------------
    // Spring back to centre. Elite's "relative mouse" feel comes from this
    // being weak enough that the stick holds a deflection for a moment. This is
    // dt-driven, so it belongs here and not in readInput.
    this.stick.x = damp(this.stick.x, 0, STICK_SPRING, dt);
    this.stick.y = damp(this.stick.y, 0, STICK_SPRING, dt);

    // -- axes ----------------------------------------------------------------
    // Mouse is fine aim on pitch and yaw (Y inverted, like a stick: pull back
    // to climb). A/D add sustained yaw, Q/E roll.
    cmd.pitch = -this.stick.y;
    cmd.yaw = clamp(this.stick.x + input.axis('KeyA', 'KeyD'), -1, 1);
    cmd.roll = input.axis('KeyQ', 'KeyE');

    // -- throttle ------------------------------------------------------------
    // Speed is a held demand, not a persistent setting: hold W to build speed,
    // hold S to back off, release and it falls away to a stop. Under flight
    // assist that means the ship actively brakes when you let go, which is the
    // whole point of the change — the ship parks itself instead of coasting.
    const drive = input.axis('KeyS', 'KeyW');
    if (drive !== 0) {
      this.throttle = clamp(this.throttle + drive * THROTTLE_RATE * dt, -0.45, 1);
    } else {
      this.throttle = damp(this.throttle, 0, THROTTLE_RELEASE, dt);
      if (Math.abs(this.throttle) < 0.002) {
        this.throttle = 0;
      }
    }
    cmd.throttle = this.throttle;

    // -- translation and boost ----------------------------------------------
    cmd.strafeX = input.axis('KeyZ', 'KeyC');
    cmd.strafeY = input.axis('KeyF', 'KeyR');
    cmd.boost = input.down('Space');

    // One switch, two things it can mean. With a computer aboard it is flight
    // assist; without one it is the order to the helm to fly the ship by hand.
    // The player learns "this is the stabilise key" once and it keeps working
    // as the ship degrades, which is the opposite of the key going dead at the
    // moment it is needed most.
    cmd.assist = this.assist;
    cmd.manual = this.assist;
    if (this.assist && !sys.flightComputer) {
      this.game.hud.nudge(this.ship.autopilot.readout.manual
        ? 'MANUAL HELM — CREW ARRESTING DRIFT'
        : 'NO FLIGHT COMPUTER — POINT RETROGRADE TO BRAKE');
    }
  }

  /**
   * Camera. Runs at frame rate, not sim rate, so it stays smooth when the
   * simulation is being stepped in chunks.
   */
  updateCamera(dt) {
    const ship = this.ship;
    const body = ship.body;

    // Target orientation: the hull's, corrected for the +Z-forward convention.
    _q.copy(body.quat).multiply(NOSE_FIX);
    // Lag the roll and yaw slightly so hard manoeuvres are visible from inside.
    const lag = this.view === VIEW.COCKPIT ? 16 : 7;
    this.camQuat.slerp(_q, 1 - Math.exp(-lag * dt));

    if (this.view === VIEW.COCKPIT) {
      ship.localToWorld(this.cockpitOffset, _v);
      this.camPos.copy(_v);
    } else {
      // Chase: sit behind the hull, but bias toward the velocity vector so a
      // ship sliding sideways under flight assist off is legible.
      _v.copy(this.chaseOffset).applyQuaternion(body.quat).add(body.pos);
      if (body.vel.lengthSq() > 4) {
        _v2.copy(body.vel).normalize().multiplyScalar(-ship.hull.radius * 0.5);
        _v.add(_v2);
      }
      this.camPos.lerp(_v, 1 - Math.exp(-9 * dt));
    }

    // Speed widens the field of view — the cheapest and most effective way to
    // sell velocity when there is nothing nearby to compare against.
    const sp = body.vel.length();
    const maxSp = Math.max(ship.hull.flight.boostSpeed, 1);
    const motion = this.game.reducedMotion ? 0 : 1;
    const wantFov = 68 + motion * (20 * clamp01(sp / maxSp)
      + (ship.autopilot.boostT > 0 ? 8 : 0));
    this.fov = damp(this.fov, wantFov, 4, dt);

    // Shake is delta-v the hull actually took, not a damage number.
    //
    // It used to be driven off lost hull fraction, with a standing tremor for
    // fires and breaches. At capital mass that is simply false: a 40 MJ slug
    // carries 31 kNs, which moves 45,000 tonnes by 0.0007 m/s, and a fire in a
    // compartment 200 m away moves it by nothing at all. Reading the impulse
    // instead makes the camera honest for free — shellfire does not register,
    // a magazine going off underneath you does, and a picket feels every hit a
    // cruiser shrugs off because it masses a tenth as much.
    this.shake = damp(this.shake, 0, 4.5, dt);
    this.shake = Math.min(0.7, this.shake + ship.consumeJolt() * SHAKE_PER_DV * motion);

    this.camera.position.copy(this.camPos);
    this.camera.quaternion.copy(this.camQuat);
    if (this.shake > 0.001) {
      const s = this.shake * 0.7;
      _q2.setFromEuler(_euler.set(
        (Math.random() - 0.5) * 0.045 * s,
        (Math.random() - 0.5) * 0.045 * s,
        (Math.random() - 0.5) * 0.06 * s,
      ));
      this.camera.quaternion.multiply(_q2);
      this.camera.position.x += (Math.random() - 0.5) * s * 0.35;
      this.camera.position.y += (Math.random() - 0.5) * s * 0.35;
    }
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  toggleView() {
    this.view = this.view === VIEW.COCKPIT ? VIEW.CHASE : VIEW.COCKPIT;
    return this.view;
  }

  /** Screen-space projection helper used by the HUD for lead pips and markers. */
  project(worldPos, out) {
    _v.copy(worldPos).project(this.camera);
    out.x = (_v.x * 0.5 + 0.5) * window.innerWidth;
    out.y = (-_v.y * 0.5 + 0.5) * window.innerHeight;
    // `project` mirrors points behind the camera onto the screen, so the
    // in-front test has to be made explicitly rather than read off the NDC.
    _v2.copy(worldPos).sub(this.camera.position);
    _fwd.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    out.behind = _v2.dot(_fwd) < 0;
    out.visible = !out.behind && _v.z < 1;
    return out;
  }
}

export { NOSE_FIX };
