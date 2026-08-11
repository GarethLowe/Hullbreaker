// -----------------------------------------------------------------------------
// audio.js — every sound is synthesised at run time. No audio files.
//
// There is no air out here, so nothing you hear arrives through it. What the
// crew actually hear is structure-borne: the recoil of their own mounts coming
// up through the deck, a slug arriving as a hammer blow on the plating, a
// magazine letting go somewhere forward as a shock through the frames. That is
// not a licence to make things up — it is a specification, and it is why every
// sound in here is built the same way a real transient is:
//
//   crack   the first two milliseconds. Broadband, unfiltered, and gone. This
//           is what tells the ear how big and how close a thing was, and it is
//           what a pure oscillator blip has none of.
//   body    the event itself, forty to four hundred milliseconds of filtered
//           noise sweeping downward as the energy spreads out.
//   thump   the sub. A sine falling from a hundred hertz to twenty. Felt more
//           than heard, and the entire difference between a gun and a beep.
//   ring    what the hull does about it afterwards — a resonant tail, because
//           a warship is a very large bell and it is being hit.
//
// Everything below is those four layers in different proportions. Distance
// dulls it (air is not required for a low-pass: the further a shock travels
// through structure, the more of the top of it is gone) and the whole mix goes
// through one compressor, so a broadside is loud without being a clipped mess.
//
// Positional audio is deliberately faked with a simple distance-and-pan model
// rather than a PannerNode graph: there can be a hundred impacts a second and
// building a spatialiser per shot is the expensive way to do a cheap job.
// -----------------------------------------------------------------------------

/**
 * Concurrent nodes. Every sound here is three or four layers, so this is the
 * old budget times four — it is the same number of simultaneous EVENTS.
 */
const MAX_VOICES = 60;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.voices = 0;
    this.listener = { pos: { x: 0, y: 0, z: 0 }, right: { x: 1, y: 0, z: 0 } };
    this._noise = null;
    /** Per-key rate limits; see `_gate`. */
    this._gates = new Map();
  }

  /** Must be called from a user gesture; browsers refuse to start audio before. */
  resume() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        return;
      }
      this.ctx = new Ctx();

      // Master chain: everything -> compressor -> out. A capital engagement is
      // twenty mounts, forty impacts and a magazine going off inside two
      // seconds, and without this the sum of them clips into a buzz at exactly
      // the moment the fight is most worth listening to.
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 12;
      comp.ratio.value = 5;
      comp.attack.value = 0.004;
      comp.release.value = 0.22;
      comp.connect(this.ctx.destination);
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(comp);

      // One second of white noise, reused by every burst.
      const len = this.ctx.sampleRate;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        d[i] = Math.random() * 2 - 1;
      }
      this._noise = buf;

      this._buildTail(comp);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /**
   * The hull's own ring.
   *
   * One convolver on a send, fed a synthesised impulse: dense noise under an
   * exponential decay, lowpassed so the tail is dark rather than hissy. It is
   * the cheapest possible way to stop every sound ending abruptly the instant
   * its envelope closes, and an abrupt ending is most of what makes a
   * synthesised gun sound like a toy.
   */
  _buildTail(out) {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * 1.1);
    const imp = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = imp.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Squared decay: dense early reflections, a long quiet skirt.
        const env = Math.pow(1 - t, 3.2);
        // One-pole lowpass over the noise, so the tail is metal rather than
        // static. The coefficient falls with time, which darkens it as it dies.
        lp += ((Math.random() * 2 - 1) - lp) * (0.35 - 0.28 * t);
        d[i] = lp * env;
      }
    }
    const conv = this.ctx.createConvolver();
    conv.buffer = imp;
    this.tail = this.ctx.createGain();
    this.tail.gain.value = 0.42;
    this.tail.connect(conv);
    conv.connect(out);
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
   * Rate limit. Point defence puts a hundred rounds a second into the sky
   * across eight mounts, and a hundred separate reports a second is not a
   * sound — it is a fuzz that eats the whole voice budget and drowns out the
   * things the player needs to hear. One report per gate interval stands for
   * all of them, which is also how a real burst reads: as a burst.
   */
  _gate(key, interval) {
    if (!this.ctx) {
      return false;
    }
    const t = this.ctx.currentTime;
    const last = this._gates.get(key) || -1;
    if (t - last < interval) {
      return false;
    }
    this._gates.set(key, t);
    return true;
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
      return { gain: 1, pan: 0, dist: 0 };
    }
    const l = this.listener.pos;
    const dx = pos.x - l.x;
    const dy = pos.y - l.y;
    const dz = pos.z - l.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > reach) {
      return { gain: 0, pan: 0, dist };
    }
    const gain = 1 / (1 + (dist / (reach * 0.14)) ** 2);
    const r = this.listener.right;
    const pan = dist > 1e-3 ? (dx * r.x + dy * r.y + dz * r.z) / dist : 0;
    return { gain, pan, dist };
  }

  /**
   * Gain -> distance lowpass -> pan -> master, with a send to the hull tail.
   *
   * The lowpass is the part that matters. Distant events keep their bottom end
   * and lose their top, which is the single strongest cue the ear has for how
   * far away something big is — and it is what stops a battery two kilometres
   * off sounding exactly like one bolted to your own deck.
   */
  _chain(gainValue, pan, dist, send = 0.35) {
    const g = this.ctx.createGain();
    g.gain.value = 0;
    let node = g;
    if (dist > 120) {
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.max(280, 20000 / (1 + dist / 900));
      lp.Q.value = 0.4;
      g.connect(lp);
      node = lp;
    }
    if (this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      node.connect(p);
      node = p;
    }
    node.connect(this.master);
    if (this.tail && send > 0) {
      const s = this.ctx.createGain();
      s.gain.value = send;
      node.connect(s);
      s.connect(this.tail);
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

  // -- layers ----------------------------------------------------------------

  /**
   * Filtered noise burst — the body of anything percussive.
   *
   * `drive` runs it through a waveshaper first. Saturation is what a very loud
   * transient does to everything it passes through, ears included, and a
   * clean sine at high level reads as quiet where a saturated one reads as
   * enormous at the same peak.
   */
  burst(pos, {
    dur = 0.2, freq = 900, q = 1, type = 'bandpass', level = 1, sweep = 0,
    send = 0.35, attack = 0, drive = 0,
  }) {
    if (!this._budget()) {
      return;
    }
    const { gain, pan, dist } = this._place(pos);
    if (gain <= 0.004) {
      this.voices--;
      return;
    }
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    src.loop = true;
    src.playbackRate.value = 0.6 + Math.random() * 0.8;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweep) {
      f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * sweep), t + dur);
    }
    f.Q.value = q;
    const g = this._chain(gain, pan, dist, send);
    const atk = attack || Math.min(0.012, dur * 0.2);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain * level, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    let head = f;
    if (drive > 0) {
      head = this._shaper(drive);
      f.connect(head);
    }
    src.connect(f);
    head.connect(g);
    src.start(t);
    src.stop(t + dur + 0.02);
    this._release(g, dur);
  }

  /** A soft-clipping curve. `k` from 0 (clean) upward. */
  _shaper(k) {
    const ws = this.ctx.createWaveShaper();
    const n = 1024;
    const curve = new Float32Array(n);
    const a = 1 + k * 30;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * a) / Math.tanh(a);
    }
    ws.curve = curve;
    ws.oversample = '2x';
    return ws;
  }

  /** Pitched blip — alarms, interface ticks, and the pitched part of a report. */
  blip(pos, {
    dur = 0.12, f0 = 420, f1 = 120, level = 0.5, type = 'sawtooth', send = 0.25,
  }) {
    if (!this._budget()) {
      return;
    }
    const { gain, pan, dist } = this._place(pos);
    if (gain <= 0.004) {
      this.voices--;
      return;
    }
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = this._chain(gain, pan, dist, send);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain * level, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.02);
    this._release(g, dur);
  }

  /**
   * The sub. A sine falling from `f0` to `f1`, which is what every large
   * explosion and every heavy gun actually is underneath the noise — and the
   * layer whose absence is exactly what "8-bit pew pew" means.
   */
  thump(pos, { dur = 0.6, f0 = 110, f1 = 26, level = 0.9, send = 0.2 }) {
    if (!this._budget()) {
      return;
    }
    const { gain, pan, dist } = this._place(pos);
    if (gain <= 0.004) {
      this.voices--;
      return;
    }
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(16, f1), t + dur * 0.85);
    const g = this._chain(gain, pan, dist, send);
    g.gain.setValueAtTime(0, t);
    // Sub energy has to arrive instantly or it reads as a swell rather than a
    // hit; it is the decay that should be long.
    g.gain.linearRampToValueAtTime(gain * level, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.02);
    this._release(g, dur);
  }

  /**
   * The first two milliseconds. Unfiltered broadband, no sweep, no tail — the
   * click that tells the ear where the event started and how hard it was.
   */
  crack(pos, { level = 0.8, dur = 0.03, freq = 5200 }) {
    this.burst(pos, {
      dur, freq, q: 0.4, type: 'highpass', level, send: 0.15, attack: 0.0008,
    });
  }

  // -- game events -----------------------------------------------------------

  /**
   * A mount firing. Every one of these is crack + body + sub, in proportions
   * that say what kind of machine it is: a railgun is nearly all sub, a
   * repeater nearly all crack.
   */
  fire(weaponId, pos, scale = 1) {
    const s = Math.max(scale, 0.4);
    switch (weaponId) {
      case 'repeater':
        // Point defence is a saw, not a series of shots. One report stands for
        // the burst; see `_gate`.
        if (!this._gate('pd', 0.055)) {
          return;
        }
        this.crack(pos, { level: 0.34, dur: 0.045, freq: 3400 });
        this.burst(pos, {
          dur: 0.13, freq: 1500, q: 1.1, level: 0.30, sweep: 0.3, send: 0.5,
        });
        this.thump(pos, { dur: 0.14, f0: 150, f1: 60, level: 0.30 });
        break;
      case 'autocannon':
        if (!this._gate('ac', 0.03)) {
          return;
        }
        this.crack(pos, { level: 0.55, dur: 0.05, freq: 3000 });
        this.burst(pos, {
          dur: 0.20, freq: 1100, q: 0.8, level: 0.44, sweep: 0.18, drive: 0.4,
        });
        this.thump(pos, { dur: 0.24, f0: 190, f1: 48, level: 0.5 });
        break;
      case 'railgun':
        // Twelve kilos of tungsten leaving at 2.6 km/s. It should sound like a
        // dropped anvil, not like a laser.
        this.crack(pos, { level: 0.95 * s, dur: 0.07, freq: 2600 });
        this.burst(pos, {
          dur: 0.55, freq: 620, q: 0.55, level: 0.75 * s, sweep: 0.10,
          drive: 0.8, send: 0.6,
        });
        this.burst(pos, {
          dur: 1.1, freq: 260, q: 0.3, level: 0.42 * s, sweep: 0.25, send: 0.9,
        });
        this.thump(pos, { dur: 1.0, f0: 105, f1: 22, level: 1.0 * s, send: 0.4 });
        break;
      case 'ion':
        // A capacitor bank dumping. The rising whine is the charge, the crack
        // is the gap breaking down.
        this.blip(pos, { dur: 0.30, f0: 140, f1: 2200, level: 0.30, type: 'sine' });
        this.crack(pos, { level: 0.6 * s, dur: 0.05, freq: 6000 });
        this.burst(pos, {
          dur: 0.5, freq: 3000, q: 3.5, level: 0.34 * s, sweep: 0.12, send: 0.7,
        });
        this.thump(pos, { dur: 0.4, f0: 80, f1: 30, level: 0.45 * s });
        break;
      case 'beam':
        // Continuous, so this is one slice of a running sound rather than an
        // event; ship.js re-triggers it while the trigger is held.
        this.burst(pos, {
          dur: 0.16, freq: 2200, q: 6, level: 0.20 * s, sweep: 0.85, send: 0.4,
        });
        this.burst(pos, {
          dur: 0.16, freq: 420, q: 1.2, level: 0.14 * s, send: 0.3,
        });
        break;
      case 'torpedo':
        // A four-tonne warhead being pushed out of a tube, then the motor.
        this.thump(pos, { dur: 0.5, f0: 90, f1: 34, level: 0.8 * s });
        this.burst(pos, {
          dur: 0.35, freq: 700, q: 0.6, level: 0.5 * s, sweep: 0.4, drive: 0.3,
        });
        this.burst(pos, {
          dur: 1.4, freq: 380, q: 0.5, level: 0.45 * s, sweep: 3.2, send: 0.7,
        });
        break;
      case 'seeker':
        if (!this._gate('seeker', 0.05)) {
          return;
        }
        this.crack(pos, { level: 0.5 * s, dur: 0.04, freq: 4200 });
        this.burst(pos, {
          dur: 0.9, freq: 900, q: 0.7, level: 0.42 * s, sweep: 2.6, send: 0.6,
        });
        this.thump(pos, { dur: 0.3, f0: 130, f1: 55, level: 0.4 * s });
        break;
      default:
        this.crack(pos, { level: 0.4 * s });
        this.burst(pos, { dur: 0.18, freq: 1200, q: 1, level: 0.35 * s, sweep: 0.3 });
        break;
    }
  }

  impact(kind, pos, level = 1) {
    const l = Math.max(level, 0.15);
    switch (kind) {
      case 'shield':
        // A field shedding a spike: a struck harmonic that bends upward as the
        // emitters load.
        this.blip(pos, { dur: 0.22, f0: 700, f1: 2100, level: 0.20 * l, type: 'sine' });
        this.burst(pos, {
          dur: 0.18, freq: 3200, q: 5, level: 0.16 * l, sweep: 2.0, send: 0.5,
        });
        break;
      case 'metal':
        // Something very hard hitting something very large. The ring after it
        // is the compartment, and it is why this does not sound like a tick.
        if (!this._gate('metal', 0.03)) {
          return;
        }
        this.crack(pos, { level: 0.75 * l, dur: 0.04, freq: 4200 });
        this.burst(pos, {
          dur: 0.30, freq: 1500, q: 2.2, level: 0.42 * l, sweep: 0.12,
          drive: 0.5, send: 0.7,
        });
        this.thump(pos, { dur: 0.35, f0: 130, f1: 40, level: 0.5 * l });
        break;
      case 'exit':
        // A round leaving the far side takes a piece of the hull with it. More
        // bottom end than the entry, and a longer tear.
        if (!this._gate('exit', 0.04)) {
          return;
        }
        this.crack(pos, { level: 0.6 * l, dur: 0.05, freq: 2800 });
        this.burst(pos, {
          dur: 0.55, freq: 900, q: 1.1, level: 0.5 * l, sweep: 0.2,
          drive: 0.6, send: 0.9,
        });
        this.thump(pos, { dur: 0.7, f0: 115, f1: 26, level: 0.75 * l, send: 0.4 });
        break;
      case 'internal':
        this.burst(pos, { dur: 0.16, freq: 900, q: 2.4, level: 0.32 * l, sweep: 0.4 });
        this.thump(pos, { dur: 0.2, f0: 120, f1: 45, level: 0.28 * l });
        break;
      case 'ricochet':
        this.crack(pos, { level: 0.4 * l, dur: 0.03, freq: 5000 });
        this.blip(pos, { dur: 0.35, f0: 3200, f1: 500, level: 0.20 * l, type: 'triangle' });
        break;
      case 'breach':
        // A compartment losing its air through a hole. It is a roar, and it is
        // supposed to be alarming.
        this.burst(pos, {
          dur: 2.2, freq: 500, q: 0.45, level: 0.5 * l, sweep: 0.25, send: 0.8,
        });
        this.thump(pos, { dur: 1.2, f0: 70, f1: 24, level: 0.5 * l });
        break;
      case 'ion':
        this.crack(pos, { level: 0.7 * l, dur: 0.06, freq: 7000 });
        this.blip(pos, { dur: 0.7, f0: 2600, f1: 70, level: 0.34 * l, type: 'sine' });
        this.burst(pos, {
          dur: 0.8, freq: 2200, q: 4, level: 0.3 * l, sweep: 0.1, send: 0.8,
        });
        break;
      default:
        this.burst(pos, { dur: 0.2, freq: 1200, q: 1, level: 0.3 * l });
        break;
    }
  }

  /**
   * A detonation. Four layers and a two-second tail: the flash-crack, the
   * fireball, the sub, and the hull ringing afterwards.
   */
  boom(pos, level = 1) {
    const l = Math.max(level, 0.2);
    this.crack(pos, { level: 0.9 * l, dur: 0.09, freq: 2200 });
    this.burst(pos, {
      dur: 0.9, freq: 900, q: 0.5, level: 0.75 * l, sweep: 0.09,
      drive: 0.9, send: 0.8,
    });
    this.burst(pos, {
      dur: 2.4, freq: 300, q: 0.3, level: 0.6 * l, sweep: 0.2, send: 1.0,
    });
    this.thump(pos, { dur: 1.8, f0: 120, f1: 19, level: 1.0 * l, send: 0.5 });
  }

  /**
   * A reactor letting go. The largest sound in the game, and the only one that
   * is allowed to be — everything else is scaled so this still has room.
   */
  reactor(pos, level = 1) {
    const l = Math.max(level, 0.3);
    this.crack(pos, { level: 1.0 * l, dur: 0.14, freq: 1600 });
    this.burst(pos, {
      dur: 1.6, freq: 1400, q: 0.4, level: 0.9 * l, sweep: 0.05,
      drive: 1.2, send: 0.9,
    });
    this.burst(pos, {
      dur: 4.5, freq: 260, q: 0.25, level: 0.8 * l, sweep: 0.15, send: 1.0,
    });
    this.thump(pos, { dur: 3.4, f0: 150, f1: 16, level: 1.0 * l, send: 0.6 });
    this.blip(pos, { dur: 2.2, f0: 60, f1: 22, level: 0.7 * l, type: 'sine' });
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
    this.blip(this.listener.pos, {
      dur: 0.04, f0: 1800, f1: 1500, level: 0.10, type: 'square', send: 0,
    });
  }
}
