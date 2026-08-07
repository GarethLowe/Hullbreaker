// -----------------------------------------------------------------------------
// audio.js — every sound is synthesised at run time. No audio files.
//
// Two building blocks cover the whole game: a filtered noise burst (impacts,
// explosions, venting, ignition) and an FM-ish oscillator blip (weapon report,
// alarms, interface). Everything else is envelope shaping and filter choice.
//
// Positional audio is deliberately faked with a simple distance-and-pan model
// rather than a PannerNode graph: there can be a hundred impacts a second and
// building a spatialiser per shot is the expensive way to do a cheap job.
// -----------------------------------------------------------------------------

const MAX_VOICES = 26;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.voices = 0;
    this.listener = { pos: { x: 0, y: 0, z: 0 }, right: { x: 1, y: 0, z: 0 } };
    this._noise = null;
  }

  /** Must be called from a user gesture; browsers refuse to start audio before. */
  resume() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        return;
      }
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
      // One second of white noise, reused by every burst.
      const len = this.ctx.sampleRate;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        d[i] = Math.random() * 2 - 1;
      }
      this._noise = buf;
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  setListener(pos, right) {
    this.listener.pos = pos;
    this.listener.right = right;
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) {
      this.master.gain.value = this.muted ? 0 : 0.55;
    }
    return this.muted;
  }

  /**
   * Distance attenuation and stereo placement for a world-space event.
   * `reach` is a hard cull, and the half-gain distance is a fraction of it, so
   * both scale with the engagement band. Sized for capital ranges: at fighter
   * distances this was a 900 m cutoff, which made a three-kilometre gunnery
   * duel completely silent.
   */
  _place(pos, reach = 26000) {
    if (!pos) {
      return { gain: 1, pan: 0 };
    }
    const l = this.listener.pos;
    const dx = pos.x - l.x;
    const dy = pos.y - l.y;
    const dz = pos.z - l.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > reach) {
      return { gain: 0, pan: 0 };
    }
    const gain = 1 / (1 + (dist / (reach * 0.14)) ** 2);
    const r = this.listener.right;
    const pan = dist > 1e-3 ? (dx * r.x + dy * r.y + dz * r.z) / dist : 0;
    return { gain, pan };
  }

  _chain(gainValue, pan) {
    const g = this.ctx.createGain();
    g.gain.value = 0;
    if (this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      p.connect(this.master);
    } else {
      g.connect(this.master);
    }
    return g;
  }

  _budget() {
    if (!this.ctx || this.muted || this.voices >= MAX_VOICES) {
      return false;
    }
    this.voices++;
    return true;
  }

  _release(node, dur) {
    setTimeout(() => {
      this.voices = Math.max(0, this.voices - 1);
      try {
        node.disconnect();
      } catch (e) {
        // Already torn down by the context; nothing to do.
      }
    }, dur * 1000 + 60);
  }

  /** Filtered noise burst — the workhorse for anything percussive. */
  burst(pos, { dur = 0.2, freq = 900, q = 1, type = 'bandpass', level = 1, sweep = 0 }) {
    if (!this._budget()) {
      return;
    }
    const { gain, pan } = this._place(pos);
    if (gain <= 0.004) {
      this.voices--;
      return;
    }
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweep) {
      f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * sweep), t + dur);
    }
    f.Q.value = q;
    const g = this._chain(gain, pan);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain * level, t + Math.min(0.012, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f);
    f.connect(g);
    src.start(t);
    src.stop(t + dur + 0.02);
    this._release(g, dur);
  }

  /** Pitched blip — weapon reports, alarms, interface ticks. */
  blip(pos, { dur = 0.12, f0 = 420, f1 = 120, level = 0.5, type = 'sawtooth' }) {
    if (!this._budget()) {
      return;
    }
    const { gain, pan } = this._place(pos);
    if (gain <= 0.004) {
      this.voices--;
      return;
    }
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = this._chain(gain, pan);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain * level, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.02);
    this._release(g, dur);
  }

  // -- game events -----------------------------------------------------------

  fire(weaponId, pos, scale = 1) {
    switch (weaponId) {
      case 'pulse':
        this.blip(pos, { dur: 0.09, f0: 1500, f1: 420, level: 0.28, type: 'square' });
        break;
      case 'ion':
        this.blip(pos, { dur: 0.34, f0: 180, f1: 1400, level: 0.34, type: 'sine' });
        this.burst(pos, { dur: 0.3, freq: 2400, q: 3, level: 0.3, sweep: 0.2 });
        break;
      case 'autocannon':
        this.burst(pos, { dur: 0.09, freq: 1500, q: 0.9, level: 0.42, sweep: 0.25 });
        break;
      case 'railgun':
        this.blip(pos, { dur: 0.30, f0: 900, f1: 60, level: 0.5, type: 'sawtooth' });
        this.burst(pos, { dur: 0.28, freq: 700, q: 0.7, level: 0.55, sweep: 0.15 });
        break;
      case 'plasma':
        this.blip(pos, { dur: 0.26, f0: 300, f1: 900, level: 0.4, type: 'triangle' });
        this.burst(pos, { dur: 0.24, freq: 1100, q: 1.6, level: 0.35, sweep: 0.35 });
        break;
      case 'missile':
        this.burst(pos, { dur: 0.6, freq: 500, q: 0.6, level: 0.45, sweep: 2.4 });
        break;
      default:
        this.burst(pos, { dur: 0.1, freq: 1200, q: 1, level: 0.3 * scale });
        break;
    }
  }

  impact(kind, pos, level = 1) {
    switch (kind) {
      case 'shield':
        this.blip(pos, { dur: 0.16, f0: 900, f1: 1800, level: 0.22 * level, type: 'sine' });
        break;
      case 'metal':
        this.burst(pos, { dur: 0.13, freq: 2600, q: 1.4, level: 0.4 * level, sweep: 0.18 });
        break;
      case 'internal':
        this.burst(pos, { dur: 0.10, freq: 900, q: 2.4, level: 0.34 * level, sweep: 0.4 });
        break;
      case 'ricochet':
        this.blip(pos, { dur: 0.22, f0: 2600, f1: 700, level: 0.24 * level, type: 'triangle' });
        break;
      case 'breach':
        this.burst(pos, { dur: 0.9, freq: 400, q: 0.5, level: 0.5 * level, sweep: 0.3 });
        break;
      case 'ion':
        this.blip(pos, { dur: 0.5, f0: 2200, f1: 90, level: 0.4 * level, type: 'sine' });
        break;
      default:
        this.burst(pos, { dur: 0.15, freq: 1200, q: 1, level: 0.3 * level });
        break;
    }
  }

  boom(pos, level = 1) {
    this.burst(pos, { dur: 1.5, freq: 260, q: 0.4, level: 0.9 * level, sweep: 0.12 });
    this.blip(pos, { dur: 0.9, f0: 130, f1: 32, level: 0.7 * level, type: 'sine' });
  }

  alarm(kind = 'warn') {
    const p = this.listener.pos;
    if (kind === 'lock') {
      this.blip(p, { dur: 0.08, f0: 1400, f1: 1400, level: 0.20, type: 'square' });
    } else if (kind === 'bad') {
      this.blip(p, { dur: 0.35, f0: 330, f1: 180, level: 0.26, type: 'square' });
    } else {
      this.blip(p, { dur: 0.10, f0: 760, f1: 640, level: 0.16, type: 'square' });
    }
  }

  ui() {
    this.blip(this.listener.pos, { dur: 0.04, f0: 1800, f1: 1500, level: 0.10, type: 'square' });
  }
}
