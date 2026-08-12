// -----------------------------------------------------------------------------
// input.js — keyboard / mouse / pointer-lock aggregation.
// Exposes edge-triggered "pressed" queries that are consumed once per frame.
// -----------------------------------------------------------------------------

/** Keys the browser would otherwise act on while we have the pointer locked. */
const SWALLOW = new Set([
  'Space', 'Tab', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyF',
  'KeyZ', 'KeyX', 'KeyC', 'Comma', 'Period', 'Semicolon', 'Quote',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8',
]);

export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = new Set();
    this.pressedThisFrame = new Set();
    this.mouse = { dx: 0, dy: 0, wheel: 0 };
    this.buttons = [false, false, false];
    this.buttonsPressed = [false, false, false];
    this.locked = false;
    this.sensitivity = 0.0016;
    this.onLockChange = null;
    this.onLockError = null;

    this._onKeyDown = (e) => {
      // Let the browser keep its own chords (devtools, reload, tab switching).
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }
      if (!this.keys.has(e.code)) {
        this.pressedThisFrame.add(e.code);
      }
      this.keys.add(e.code);
      if (this.locked && SWALLOW.has(e.code)) {
        e.preventDefault();
      }
    };
    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
    };
    this._onMouseMove = (e) => {
      if (!this.locked) {
        return;
      }
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    };
    this._onMouseDown = (e) => {
      if (e.button < 3) {
        if (!this.buttons[e.button]) {
          this.buttonsPressed[e.button] = true;
        }
        this.buttons[e.button] = true;
      }
    };
    this._onMouseUp = (e) => {
      if (e.button < 3) {
        this.buttons[e.button] = false;
      }
    };
    this._onWheel = (e) => {
      if (!this.locked) {
        return;
      }
      this.mouse.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    };
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.dom;
      if (!this.locked) {
        this.keys.clear();
        this.buttons = [false, false, false];
      }
      if (this.onLockChange) {
        this.onLockChange(this.locked);
      }
    };
    this._onLockError = () => {
      if (this.onLockError) {
        this.onLockError();
      }
    };
    this._reset = () => {
      this.keys.clear();
      this.pressedThisFrame.clear();
      this.buttons = [false, false, false];
      this.buttonsPressed = [false, false, false];
      this.mouse.dx = 0;
      this.mouse.dy = 0;
      this.mouse.wheel = 0;
    };
    this._onContext = (e) => e.preventDefault();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('wheel', this._onWheel, { passive: false });
    document.addEventListener('pointerlockchange', this._onLockChange);
    document.addEventListener('pointerlockerror', this._onLockError);
    window.addEventListener('blur', this._reset);
    this._onVisibilityChange = () => {
      if (document.hidden) {
        this._reset();
      }
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    domElement.addEventListener('contextmenu', this._onContext);
  }

  requestLock() {
    if (this.locked) {
      return true;
    }
    if (!this.dom.requestPointerLock) {
      this._onLockError();
      return false;
    }
    // Chrome rejects this if it arrives too soon after an Esc-driven exit, and
    // newer versions return a promise that becomes an unhandled rejection if
    // nobody catches it. The user just clicks again; it is not an error worth
    // reporting to them.
    try {
      const p = this.dom.requestPointerLock();
      if (p && typeof p.catch === 'function') {
        p.catch(() => this._onLockError());
      }
    } catch (e) {
      this._onLockError();
    }
    return false;
  }

  exitLock() {
    if (this.locked) {
      document.exitPointerLock();
    }
  }

  dispose() {
    this.exitLock();
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('blur', this._reset);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    document.removeEventListener('pointerlockerror', this._onLockError);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    this.dom.removeEventListener('contextmenu', this._onContext);
  }

  down(code) {
    return this.keys.has(code);
  }

  pressed(code) {
    return this.pressedThisFrame.has(code);
  }

  /** -1/0/+1 from a pair of keys, for the discrete axes. */
  axis(negCode, posCode) {
    return (this.down(posCode) ? 1 : 0) - (this.down(negCode) ? 1 : 0);
  }

  buttonPressed(i) {
    return this.buttonsPressed[i];
  }

  /** Call once at the very end of a frame. */
  endFrame() {
    this.pressedThisFrame.clear();
    this.buttonsPressed = [false, false, false];
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.wheel = 0;
  }
}
