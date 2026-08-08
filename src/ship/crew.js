// -----------------------------------------------------------------------------
// crew.js — the people aboard, modelled as DIVISIONS on the compartment graph.
//
// A capital ship carries hundreds of hands, so the unit of simulation is a
// division — a party of N people with a station, a job and a location — rather
// than an individual. Everything that made individuals interesting survives the
// abstraction, because none of it was ever about a specific person:
//
//   * They have to WALK to a problem. The route is a shortest path over the
//     compartment graph whose edge costs rise with fire, vacuum and buckled
//     frames — so wrecking the middle of a ship does not just break what it
//     hits, it strands the damage-control parties on the wrong side of it.
//   * They take CASUALTIES. Vacuum, fire, heat, and compartments blown open
//     around them. Losses are continuous rather than binary: a party caught in
//     a decompression is thinned, not deleted, and what is left keeps working
//     more slowly.
//   * They are what makes a ship REPAIRABLE. Nothing self-heals. Every joule of
//     health restored was carried there by people who are still breathing, out
//     of spares that are a finite cargo item.
//
// Work does not scale linearly with headcount — only so many hands fit around a
// ruptured conduit — so a division's output saturates. That is what stops a
// thousand-strong dreadnought crew from repairing everything at once, and it is
// why losing a third of your people hurts more than a third as much.
//
// Pure state, like systems.js: no Three.js, no rendering. The schematic reads
// `at`/`heading`/`progress` and draws the parties.
// -----------------------------------------------------------------------------
import { ATMO_CRITICAL } from './systems.js';
import { clamp01 } from '../core/mathx.js';

/** Seconds to cross one compartment of a capital hull under ideal conditions. */
const TRAVERSE_TIME = 5.5;
/** Joules of module repair one able hand delivers per second. */
const REPAIR_PER_HAND = 3.4e4;
/** Hull patching is slower than swapping a part — it is welding, not wiring. */
const PATCH_PER_HAND = 2.6e4;
/** Joules of repair bought by one unit of spares. */
const JOULES_PER_SPARE = 1.1e6;
/**
 * Hands that can usefully work one job at once. Past this they are queuing for
 * the same hatch, so a bigger party finishes sooner only up to a point.
 */
const HANDS_PER_JOB = 14;

/** Fraction of an exposed party lost per second, by cause. */
const VACUUM_LOSS = 0.085;
const FIRE_LOSS = 0.11;
const HEAT_LOSS = 0.045;

/** Roles that hold a station and are worth something for being there. */
const STATION_ROLES = new Set(['pilot', 'gunner', 'engineer']);

export class Crew {
  constructor(hull, systems) {
    this.hull = hull;
    this.sys = systems;
    this.divisions = hull.crew.map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      /** Where this division is supposed to be when nothing is wrong. */
      station: c.post,
      at: c.post,
      heading: null,      // compartment being walked toward, or null
      progress: 0,        // 0..1 along the current edge
      path: [],
      size: c.size,
      max: c.size,
      /** Suited parties survive vacuum but work slower. Damage control suit up. */
      suited: c.role === 'damage',
      task: null,         // { kind:'repair'|'patch'|'fire', target }
      idleT: 0,
      casualtyAcc: 0,
    }));
    this.events = [];
    this.complementMax = this.divisions.reduce((a, d) => a + d.max, 0);
    /** Rolling census so capability queries are O(1) for the flight model. */
    this.census = { pilot: 0, gunner: 0, engineer: 0, damage: 0, alive: 0 };
    this._roleMax = {};
    for (const c of hull.crew) {
      this._roleMax[c.role] = (this._roleMax[c.role] || 0) + c.size;
    }
    this._recount();
  }

  /** Back-compat alias — plenty of call sites still say "members". */
  get members() {
    return this.divisions;
  }

  _recount() {
    const c = { pilot: 0, gunner: 0, engineer: 0, damage: 0, alive: 0 };
    for (const d of this.divisions) {
      if (d.size <= 0) {
        continue;
      }
      c.alive += d.size;
      // A station role only counts while the party is actually AT the station.
      if (STATION_ROLES.has(d.role)) {
        if (d.at === d.station && !d.heading) {
          c[d.role] += d.size;
        }
      } else {
        c[d.role] += d.size;
      }
    }
    this.census = c;
  }

  /** How much of the original complement is still breathing, 0..1. */
  get complement() {
    return this.complementMax > 0 ? clamp01(this.census.alive / this.complementMax) : 0;
  }

  /** Hands still alive. */
  get headcount() {
    return Math.round(this.census.alive);
  }

  /**
   * 0..1 quality of a manned station. Used by the flight model and the gunnery:
   * an empty bridge means the ship handles like the autopilot it is left with.
   */
  station(role) {
    const total = this._roleMax[role] || 0;
    return total > 0 ? clamp01(this.census[role] / total) : 0;
  }

  // -- pathing ---------------------------------------------------------------

  /**
   * Cost of walking a party into a compartment. Fire is nearly impassable,
   * vacuum is survivable only in a suit, and a buckled frame means squeezing
   * past collapsed structure. This function is the mechanism behind "damaging
   * corridors and conduits makes travel slower".
   */
  _cost(sectionId, suited) {
    const s = this.sys.section(sectionId);
    if (!s) {
      return Infinity;
    }
    let c = TRAVERSE_TIME;
    if (s.fire > 0) {
      c *= 4.5;
    }
    if (s.atmo < ATMO_CRITICAL) {
      if (!suited) {
        return Infinity;   // unsuited parties simply will not go in there
      }
      c *= 1.9;
    }
    if (s.frameBroken) {
      c *= 2.4;
    } else if (s.breached) {
      c *= 1.4;
    }
    if (s.temp > 120) {
      c *= 1.6;
    }
    return c;
  }

  /**
   * Dijkstra over the compartment graph, returning cost and predecessor for
   * EVERY compartment. Solving the whole map once per decision is both cheaper
   * and shorter than asking "can I reach this one?" fifty times while scoring
   * jobs — and with a dozen-plus compartments it still costs nothing.
   */
  _solve(from, suited) {
    const dist = new Map();
    const prev = new Map();
    const unvisited = new Set(this.hull.sectionIds);
    for (const id of unvisited) {
      dist.set(id, Infinity);
    }
    dist.set(from, 0);

    while (unvisited.size > 0) {
      let best = null;
      let bestD = Infinity;
      for (const id of unvisited) {
        const d = dist.get(id);
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      }
      if (best === null || bestD === Infinity) {
        break;
      }
      unvisited.delete(best);
      for (const n of this.hull.sectionById[best].adj) {
        if (!unvisited.has(n)) {
          continue;
        }
        const alt = bestD + this._cost(n, suited);
        if (alt < dist.get(n)) {
          dist.set(n, alt);
          prev.set(n, best);
        }
      }
    }
    return { dist, prev };
  }

  /** Walks the predecessor chain back into a forward path, or null. */
  _pathFrom(solved, from, to) {
    if (from === to) {
      return [];
    }
    if (!Number.isFinite(solved.dist.get(to))) {
      return null;   // unreachable: burning, airless or structurally cut off
    }
    const path = [];
    let cur = to;
    while (cur !== from) {
      path.unshift(cur);
      cur = solved.prev.get(cur);
      if (cur === undefined) {
        return null;
      }
    }
    return path;
  }

  _route(from, to, suited) {
    return this._pathFrom(this._solve(from, suited), from, to);
  }

  // -- task selection --------------------------------------------------------

  /**
   * Scores every open job and returns the best one this division can reach.
   * Distance is part of the score rather than a filter, so a small job next
   * door beats a big one three burning compartments away — which is how a real
   * damage-control party triages.
   */
  _findJob(division, solved) {
    const sys = this.sys;
    let best = null;
    let bestScore = 0;
    const reach = (id) => {
      const d = solved.dist.get(id);
      return Number.isFinite(d) ? 1 / (1 + d / TRAVERSE_TIME) : 0;
    };

    for (const s of sys.sections.values()) {
      const near = reach(s.id);
      if (near <= 0) {
        continue;
      }
      if (s.fire > 0) {
        let score = 40;
        // Fire next to ordnance or fuel is the thing that ends ships.
        for (const def of this.hull.modulesBySection[s.id]) {
          if (def.kind === 'magazine' || def.kind === 'fuel') {
            score = 110;
            break;
          }
        }
        score *= near;
        if (score > bestScore) {
          best = { kind: 'fire', target: s.id };
          bestScore = score;
        }
      }
      // A hull breach is a job until it is shut, and a compartment that has
      // finished venting is the MOST urgent one rather than an excluded one.
      //
      // This used to read `s.breached && s.atmo > 0.03`, which meant a hole big
      // enough to empty its compartment could never be worked on again: the
      // party stopped coming the moment the air ran out. A bow array sat open
      // for twenty-five minutes with its plating already welded back to full,
      // a four square metre hole and two thousand three hundred spares in the
      // lockers, and nobody aboard would go near it. Vacuum is what the suits
      // are for — and only suited parties can path into one, so this scores the
      // job and the pathing decides who is able to take it.
      //
      // Structural work counts too: a buckled frame is why a compartment stays
      // hard to move through after the hull is closed.
      if (s.breached || s.frameBroken) {
        // Capped, or a fifty square metre hole outranks a magazine fire by ten
        // to one and the ship burns while the party welds.
        let score = 34 + Math.min(s.breachSize, 5) * 20;
        if (s.atmo <= ATMO_CRITICAL) {
          score += 26;
        }
        if (!s.breached) {
          score -= 40;    // sealed already; reframing can wait for the fires
        }
        score *= near;
        if (score > bestScore) {
          best = { kind: 'patch', target: s.id };
          bestScore = score;
        }
      }
    }

    for (const m of sys.modules.values()) {
      if (m.hp >= m.maxHp) {
        continue;
      }
      const near = reach(m.section);
      if (near <= 0) {
        continue;
      }
      let score = (1 - m.hp / m.maxHp) * 30;
      if (m.def.critical) {
        score += 45;
      }
      if (m.destroyed) {
        score += 18;
      }
      // A cut conduit is cheap to fix and restores a whole branch, so it beats
      // grinding health back into a big module that is merely dented.
      if (m.kind === 'conduit') {
        score += 26;
        if (!sys.online[m.def.net].has(m.def.to)) {
          score += 30;
        }
      }
      if (m.kind === 'reactor' || m.kind === 'computer') {
        score += 20;
      }
      score *= near;
      if (score > bestScore) {
        best = { kind: 'repair', target: m.id, section: m.section };
        bestScore = score;
      }
    }

    return best;
  }

  // -- tick ------------------------------------------------------------------

  tick(dt) {
    for (const d of this.divisions) {
      if (d.size <= 0) {
        continue;
      }
      this._environment(d, dt);
      if (d.size <= 0) {
        continue;
      }
      this._act(d, dt);
    }
    this._recount();
  }

  /**
   * Called by the ship when systems raises a compartment-killing event.
   * `lethality` is the fraction of anyone present who is lost.
   */
  killIn(sectionId, lethality = 1) {
    for (const d of this.divisions) {
      if (d.size <= 0 || d.at !== sectionId) {
        continue;
      }
      const lost = Math.min(d.size, d.size * clamp01(lethality));
      d.size -= lost;
      if (lost >= 1) {
        this.events.push({
          type: 'casualties', division: d, lost: Math.round(lost), cause: 'blast',
        });
      }
      if (d.size < 0.5) {
        this._wipe(d, 'blast');
      }
    }
  }

  _wipe(d, cause) {
    d.size = 0;
    d.task = null;
    d.heading = null;
    this.events.push({ type: 'divisionLost', division: d, cause });
  }

  _environment(d, dt) {
    const s = this.sys.section(d.at);
    if (!s) {
      return;
    }
    let rate = 0;
    if (s.atmo < ATMO_CRITICAL && !d.suited) {
      rate += VACUUM_LOSS * (1 - s.atmo / ATMO_CRITICAL);
    }
    if (s.fire > 0) {
      rate += FIRE_LOSS * (d.suited ? 0.5 : 1);
    }
    if (s.temp > 140) {
      rate += HEAT_LOSS * clamp01((s.temp - 140) / 200);
    }
    if (rate <= 0) {
      return;
    }
    const before = d.size;
    // Exponential attrition: a party in a breached compartment thins out, it
    // does not vanish at a threshold.
    d.size = Math.max(0, d.size - d.size * rate * dt);
    d.casualtyAcc += before - d.size;
    if (d.casualtyAcc >= 5) {
      this.events.push({
        type: 'casualties', division: d, lost: Math.round(d.casualtyAcc),
        cause: s.fire > 0 ? 'fire' : 'vacuum',
      });
      d.casualtyAcc = 0;
    }
    if (d.size < 0.5) {
      this._wipe(d, s.fire > 0 ? 'fire' : 'vacuum');
    }
  }

  _act(d, dt) {
    // Moving: burn down the edge, then arrive.
    if (d.heading) {
      const cost = this._cost(d.heading, d.suited);
      if (!Number.isFinite(cost)) {
        // The route closed behind us — fire flared, or the air went. Stop and
        // re-plan from where we are standing.
        d.heading = null;
        d.path = [];
        d.task = null;
        return;
      }
      d.progress += dt / cost;
      if (d.progress >= 1) {
        d.at = d.heading;
        d.progress = 0;
        d.heading = d.path.shift() || null;
      }
      return;
    }

    // Decide what to do next. One shortest-path solve serves the whole
    // decision: scoring jobs, walking to them, and getting clear of danger.
    if (!d.task) {
      d.idleT -= dt;
      if (d.idleT > 0) {
        return;
      }
      d.idleT = 0.8;
      const solved = this._solve(d.at, d.suited);
      const job = this._findJob(d, solved);
      const holdsStation = STATION_ROLES.has(d.role);
      const stationSafe = holdsStation && this._tenable(d.station);

      if (stationSafe) {
        // Hold the post. Take a job only if it is in this very compartment —
        // the bridge watch does not leave the helm to go and weld two rooms
        // away, and a ship that lets them stops steering.
        d.task = job && (job.section || job.target) === d.at ? job : null;
        if (!d.task) {
          if (d.at !== d.station) {
            this._walk(d, solved, d.station);
          }
          return;
        }
      } else {
        d.task = job;
        if (!d.task) {
          // Nothing to do and nowhere safe to stand: move somewhere survivable.
          if (!this._tenable(d.at)) {
            const refuge = this._nearestTenable(solved);
            if (refuge && refuge !== d.at) {
              this._walk(d, solved, refuge);
            }
          }
          return;
        }
      }
    }

    const task = d.task;
    const targetSection = task.kind === 'repair' ? task.section : task.target;
    if (d.at !== targetSection) {
      if (!this._goTo(d, targetSection)) {
        d.task = null;
      }
      return;
    }

    // On station and working. Output is hands times competence, and hands
    // saturate — only so many people fit around one ruptured conduit.
    const hands = Math.min(d.size, HANDS_PER_JOB);
    const dcBus = this.sys.online.data.has('d.eng') ? 1 : 0.55;
    const skill = dcBus * (d.suited ? 0.85 : 1)
      * (d.role === 'engineer' ? 1.25 : (d.role === 'damage' ? 1.1 : 0.7));
    const effort = hands * skill;

    switch (task.kind) {
      case 'fire': {
        const s = this.sys.section(task.target);
        if (!s || s.fire <= 0) {
          d.task = null;
          break;
        }
        // Fighting a fire is smothering it faster than it consumes its fuel.
        s.fire = Math.max(0, s.fire - 0.14 * effort * dt);
        s.spill = clamp01(s.spill - 0.010 * effort * dt);
        if (s.fire <= 0) {
          this.events.push({ type: 'fireOut', section: s.id, by: d });
          d.task = null;
        }
        break;
      }
      case 'patch': {
        const s = this.sys.section(task.target);
        if (!s || (!s.breached && !s.frameBroken)) {
          d.task = null;
          break;
        }
        // Spares are drawn in proportion to the work actually done. Rounding up
        // to a whole unit per tick would empty the lockers in under a minute.
        const want = PATCH_PER_HAND * effort * dt;
        const spares = this.sys.takeSpares(want / JOULES_PER_SPARE);
        if (spares <= 0) {
          d.task = null;   // nothing left to patch with
          break;
        }
        this.sys.patchSection(s.id, Math.min(want, spares * JOULES_PER_SPARE));
        if (!s.breached && !s.frameBroken) {
          d.task = null;
        }
        break;
      }
      case 'repair': {
        const mod = this.sys.get(task.target);
        if (!mod || mod.hp >= mod.maxHp) {
          if (mod) {
            mod.repairing = false;
          }
          d.task = null;
          break;
        }
        // Nobody works inside a fire they have not put out first.
        const s = this.sys.section(mod.section);
        if (s && s.fire > 0) {
          d.task = { kind: 'fire', target: s.id };
          break;
        }
        mod.repairing = true;
        const want = REPAIR_PER_HAND * effort * dt;
        const spares = this.sys.takeSpares(want / JOULES_PER_SPARE);
        if (spares <= 0) {
          mod.repairing = false;
          d.task = null;
          this.events.push({ type: 'noSpares' });
          break;
        }
        this.sys.repairModule(mod.id, Math.min(want, spares * JOULES_PER_SPARE));
        if (mod.hp >= mod.maxHp) {
          mod.repairing = false;
          this.events.push({ type: 'repaired', module: mod, by: d });
          d.task = null;
        }
        break;
      }
      default:
        d.task = null;
        break;
    }
  }

  _tenable(sectionId) {
    const s = this.sys.section(sectionId);
    return !!s && s.fire <= 0 && s.atmo > ATMO_CRITICAL;
  }

  _nearestTenable(solved) {
    let best = null;
    let bestCost = Infinity;
    for (const id of this.hull.sectionIds) {
      const cost = solved.dist.get(id);
      if (!this._tenable(id) || !Number.isFinite(cost) || cost >= bestCost) {
        continue;
      }
      bestCost = cost;
      best = id;
    }
    return best;
  }

  /** Starts walking along an already-solved shortest-path tree. */
  _walk(d, solved, sectionId) {
    const path = this._pathFrom(solved, d.at, sectionId);
    if (!path || path.length === 0) {
      return path !== null;
    }
    d.path = path;
    d.heading = d.path.shift();
    d.progress = 0;
    return true;
  }

  _goTo(d, sectionId) {
    return this._walk(d, this._solve(d.at, d.suited), sectionId);
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** Compact roster for the damage-control panel. */
  roster() {
    return this.divisions.map((d) => ({
      name: d.name,
      role: d.role,
      size: Math.round(d.size),
      max: d.max,
      alive: d.size > 0,
      frac: d.max > 0 ? clamp01(d.size / d.max) : 0,
      at: d.at,
      heading: d.heading,
      task: d.task ? d.task.kind : (d.at === d.station ? 'station' : 'idle'),
    }));
  }
}

export { TRAVERSE_TIME, HANDS_PER_JOB, JOULES_PER_SPARE };
