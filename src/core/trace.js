// -----------------------------------------------------------------------------
// trace.js — a flight recorder for the simulation.
//
// The console can already answer "what is wrong with my ship RIGHT NOW", and
// that turned out to be the wrong question almost every time. `l.batA 0%` is not
// a diagnosis; the diagnosis is the sixty seconds before it, where the loop went
// dry and the pipe was welded and it never came back. State you can poke at
// tells you where you ended up. It cannot tell you how.
//
// So this samples the whole ship in a bounded array and — the part that actually
// matters — diffs each sample against the last, so the output is a TIMELINE of
// transitions rather than a wall of numbers. "t=143.2 l.batA level 0.41 -> 0.00"
// is the bug report.
//
// Deliberately not a WebSocket. A socket needs a server half, a protocol, a
// reconnect story and a Vite plugin to carry exactly the same bytes this hands
// you as a file. The browser can already write a file, and a file can be
// attached to a bug, diffed, and read six months later.
//
//   game.trace.start()          begin recording (10 Hz, ~10 minutes)
//   game.trace.changes()        print the timeline of transitions
//   game.trace.dump()           download the whole thing as JSON
//   game.trace.stop()
// -----------------------------------------------------------------------------

/** Sim seconds between samples, and how many to keep. 10 Hz for ~10 minutes. */
const SAMPLE_HZ = 10;
const KEEP = 6000;

/** Rounds for display without pretending to a precision the sim does not have. */
const r2 = (n) => Math.round(n * 100) / 100;

export class Trace {
  constructor(game) {
    this.game = game;
    this.samples = [];
    this.recording = false;
    this.t = 0;
    this._next = 0;
  }

  start() {
    this.samples = [];
    this.t = 0;
    this._next = 0;
    this.recording = true;
    return `recording at ${SAMPLE_HZ} Hz, keeping ${KEEP} samples `
      + `(${Math.round(KEEP / SAMPLE_HZ / 60)} min)`;
  }

  stop() {
    this.recording = false;
    return `stopped, ${this.samples.length} samples over ${r2(this.t)} s`;
  }

  tick(dt) {
    if (!this.recording) {
      return;
    }
    this.t += dt;
    if (this.t < this._next) {
      return;
    }
    this._next = this.t + 1 / SAMPLE_HZ;
    const s = this._sample();
    if (s) {
      this.samples.push(s);
      if (this.samples.length > KEEP) {
        this.samples.shift();
      }
    }
  }

  /**
   * One frame of everything worth knowing. Modules are recorded only when they
   * are NOT nominal — a hull has two hundred of them and a trace that lists all
   * of them every tenth of a second is a trace nobody reads.
   */
  _sample() {
    const ship = this.game.player ? this.game.player.ship : null;
    if (!ship || ship.disposed) {
      return null;
    }
    const sys = ship.sys;
    const mods = {};
    for (const m of sys.modules.values()) {
      const bad = m.destroyed || m.tripped || m.shed
        || m.hp < m.maxHp * 0.999 || m.leakRate > 0 || m.temp > 90;
      if (!bad) {
        continue;
      }
      mods[m.id] = [
        m.destroyed ? 'X' : (m.tripped ? 'T' : (m.shed ? 'S' : '-')),
        Math.round(100 * m.hp / m.maxHp),
        Math.round(m.temp),
        m.leakRate > 0 ? r2(m.leakRate) : 0,
      ].join('/');
    }
    const loops = {};
    for (const l of sys.loops.values()) {
      loops[l.id] = `${Math.round(l.level * 100)}/${Math.round(l.temp)}`
        + `/${r2(l.leak)}/${r2(this.game.player.ship.sys.online.coolant.get(l.id) || 0)}`;
    }
    const nets = {};
    for (const net of ['power', 'data', 'coolant']) {
      nets[net] = [...sys.online[net].keys()].sort().join(',');
    }
    return {
      t: r2(this.t),
      wave: this.game.wave,
      speed: Math.round(ship.body.vel.length()),
      auth: r2(sys.driveAuthority()),
      fuel: Math.round(sys.fuelFraction() * 100),
      crew: ship.crew ? ship.crew.headcount : 0,
      spares: sys.totalSpares(),
      supply: Math.round(sys.supply),
      demand: Math.round(sys.demand),
      rounds: Math.round([...sys.modules.values()]
        .filter((m) => m.kind === 'magazine').reduce((a, m) => a + m.rounds, 0)),
      guns: ship.mounts.filter((mt) => mt.bears).length,
      hostiles: this.game.ships.filter((x) => x.faction === 'hostile' && !x.dead).length,
      mods,
      loops,
      nets,
    };
  }

  /**
   * The timeline. Every scalar that moved and every module or loop that changed
   * state, with the moment it happened — which is the only view that has ever
   * answered "why is my repaired ship still broken".
   */
  changes({ scalars = true } = {}) {
    const out = [];
    const WATCH = ['wave', 'auth', 'fuel', 'crew', 'supply', 'guns', 'hostiles'];
    for (let i = 1; i < this.samples.length; i++) {
      const a = this.samples[i - 1];
      const b = this.samples[i];
      const line = [];
      if (scalars) {
        for (const k of WATCH) {
          if (a[k] !== b[k]) {
            line.push(`${k} ${a[k]}->${b[k]}`);
          }
        }
      }
      for (const group of ['mods', 'loops', 'nets']) {
        for (const k of new Set([...Object.keys(a[group]), ...Object.keys(b[group])])) {
          const was = a[group][k];
          const now = b[group][k];
          if (was !== now) {
            line.push(`${k} ${was === undefined ? 'OK' : was}->${now === undefined ? 'OK' : now}`);
          }
        }
      }
      if (line.length) {
        out.push(`t=${b.t}  ${line.join('  |  ')}`);
      }
    }
    const text = out.join('\n') || 'nothing changed over the recording';
    console.log(text);
    return `${out.length} transitions`;
  }

  /** The whole recording, as a file. Legend included so it reads cold. */
  dump(name = 'hullbreak-trace.json') {
    const blob = new Blob([JSON.stringify({
      legend: {
        mods: 'id: state/hp%/tempC/leak — state X=destroyed T=tripped S=shed',
        loops: 'id: level%/tempC/leak/flow',
        nets: 'nodes currently served',
        note: 'modules appear only while NOT nominal; absence means healthy',
      },
      hull: this.game.player ? this.game.player.ship.hull.id : null,
      seed: this.game.random ? this.game.random.seed : null,
      seconds: r2(this.t),
      samples: this.samples,
    }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    return `${this.samples.length} samples written to ${name}`;
  }
}
