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
import { captureState, captureList, applyList } from '../core/state.js';

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

/**
 * Hands in one working party.
 *
 * A division is a roster entry, not a mob that walks around together. Damage
 * control is done by small parties spread across a ship, and treating a
 * division as one indivisible unit that takes ONE job meant a seventy-hand
 * division put at most `HANDS_PER_JOB` onto a single repair while the other
 * fifty-six stood at their station. Measured on a cruiser with seventeen
 * outstanding jobs: three of eight divisions tasked, forty-two hands working
 * out of four hundred and twenty aboard.
 */
const PARTY_SIZE = 6;

/**
 * Parties a station role keeps at its post once the ship has stopped being able
 * to fight with it. One: somebody stays on the wheel in case steerage comes
 * back, everybody else turns to.
 */
const SKELETON_PARTIES = 1;

/**
 * Cross-decking: hands per second that walk from a division with people to
 * spare to one that has been gutted, and how often the ship reconsiders who
 * needs them. Deliberately slow — this is a working party being told to leave
 * its own station and cross a damaged warship, not a number moving between two
 * counters.
 */
const REINFORCE_RATE = 1.4;
const REINFORCE_INTERVAL = 3.0;
/**
 * A donor never goes below this fraction of its own establishment. Stripping a
 * station bare to man another one is how you end up with neither, and it is
 * what makes the whole thing run out: once nobody is above the floor there is
 * no surplus left and the ship simply fights with what it has.
 */
const REINFORCE_FLOOR = 0.55;
/** Below this a station counts as needing help at all. */
const REINFORCE_NEED = 0.85;

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
    /**
     * The roster. A division is an establishment — a name, a trade, a station
     * and a headcount — and it is what the panel lists and the census counts.
     * It does not walk anywhere itself.
     */
    this.divisions = hull.crew.map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      /** Where this division is supposed to be when nothing is wrong. */
      station: c.post,
      max: c.size,
      /** Suited parties survive vacuum but work slower. Damage control suit up. */
      suited: c.role === 'damage',
      parties: [],
    }));

    /**
     * The working units. Each carries its own position, route and job, which is
     * how a division comes to be repairing six things in five compartments at
     * once instead of sending everybody to the same hatch.
     */
    this.parties = [];
    for (const d of this.divisions) {
      const n = Math.max(1, Math.round(d.max / PARTY_SIZE));
      for (let i = 0; i < n; i++) {
        const party = {
          div: d,
          role: d.role,
          station: d.station,
          suited: d.suited,
          size: d.max / n,
          max: d.max / n,
          at: d.station,
          heading: null,    // compartment being walked toward, or null
          progress: 0,      // 0..1 along the current edge
          path: [],
          task: null,       // { kind:'repair'|'patch'|'fire', target }
          // Stagger the first decision so the parties of one division do not
          // deliberate in lockstep and all pick whatever scored highest once.
          idleT: (i / n) * 1.5,
          casualtyAcc: 0,
        };
        d.parties.push(party);
        this.parties.push(party);
      }
    }
    /** One shortest-path solve per (origin, suit) per tick, shared by parties. */
    this._solveCache = new Map();
    /** Hands already committed to each job this tick; see `_findJob`. */
    this._load = new Map();
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

  /** Hands on a division's books, across all of its parties. */
  static strength(d) {
    let n = 0;
    for (const q of d.parties) {
      n += q.size;
    }
    return n;
  }

  _recount() {
    const c = { pilot: 0, gunner: 0, engineer: 0, damage: 0, alive: 0 };
    for (const q of this.parties) {
      if (q.size <= 0) {
        continue;
      }
      c.alive += q.size;
      // A station role only counts while the party is actually AT the station.
      if (STATION_ROLES.has(q.role)) {
        if (q.at === q.station && !q.heading) {
          c[q.role] += q.size;
        }
      } else {
        c[q.role] += q.size;
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

  // -- save and restore ------------------------------------------------------

  /**
   * The parties: how many hands each has left, where they are and where they
   * were going. The census is not in it — `tick` recounts it from the parties
   * every step, and a stored copy could only ever be a way to disagree with
   * them.
   */
  snapshot() {
    return {
      parties: this.parties.map((q) => ({
        ...captureState(q),
        // The one nested object in the simulation's state, and therefore the
        // one thing the generic capture cannot see — it takes primitives and
        // leaves object references alone, because object references are the
        // shared authored tables. A party's current job is neither: it is
        // `{ kind, target }`, two strings, and a party restored without it goes
        // back to work on whatever it was doing before the snapshot.
        task: q.task ? { ...q.task } : null,
      })),
    };
  }

  restore(snap) {
    if (!snap) {
      return;
    }
    applyList(this.parties, snap.parties);
    // Copied out again rather than shared, so restoring twice cannot hand two
    // ships the same task object.
    this.parties.forEach((q, i) => {
      const t = snap.parties[i] && snap.parties[i].task;
      q.task = t ? { ...t } : null;
    });
    this.events.length = 0;
  }

  /**
   * Replacements aboard, as a fraction of the ship's rated complement.
   *
   * Spread across the billets in proportion to how short each one is, so the
   * division that was gutted gets the draft and the one that came through
   * untouched gets none of it. A party that was wiped out entirely comes back
   * at its own station rather than wherever its last hands died.
   *
   * Returns the number actually taken on, which is less than asked for once
   * the ship is nearly full.
   */
  draft(fraction) {
    const short = this.parties.filter((q) => q.size < q.max);
    const total = short.reduce((a, q) => a + (q.max - q.size), 0);
    if (total <= 0) {
      return 0;
    }
    const budget = Math.min(total, this.complementMax * fraction);
    for (const q of short) {
      const wasEmpty = q.size <= 0;
      // Each share is at most that billet's own shortfall, because `budget`
      // never exceeds `total` — so this cannot overfill a party.
      q.size += budget * ((q.max - q.size) / total);
      if (wasEmpty) {
        q.at = q.station;
        q.heading = null;
        q.path = [];
        q.task = null;
      }
    }
    this._recount();
    return budget;
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

  /** `_solve` memoised for one tick. Parties cluster, so this collapses hard. */
  _solveCached(from, suited) {
    const k = from + '|' + (suited ? 1 : 0);
    let r = this._solveCache.get(k);
    if (r === undefined) {
      r = this._solve(from, suited);
      this._solveCache.set(k, r);
    }
    return r;
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
    /**
     * How much a job is still worth given who is already on it.
     *
     * Without this every party picks whatever scored highest and the whole
     * watch ends up in one compartment — which is the mob behaviour that having
     * parties at all is meant to fix. Falls to nothing once a job has as many
     * hands as it can use, so the next party looks elsewhere; never quite zero,
     * so a genuinely huge job can still take a second party when there is
     * nothing else to do.
     */
    const crowd = (kind, target) => {
      const busy = this._load.get(kind + ':' + target) || 0;
      return Math.max(0.04, 1 - busy / HANDS_PER_JOB);
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
        score *= near * crowd('fire', s.id);
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
        score *= near * crowd('patch', s.id);
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
      score *= near * crowd('repair', m.id);
      if (score > bestScore) {
        best = { kind: 'repair', target: m.id, section: m.section };
        bestScore = score;
      }
    }

    return best;
  }

  // -- tick ------------------------------------------------------------------

  tick(dt) {
    // One solve per origin per tick, shared by every party standing there, and
    // a census of who is already on each job so parties spread across the ship
    // instead of all converging on whatever scored highest.
    this._solveCache.clear();
    this._load.clear();
    // `repairing` is DERIVED from who is on the job, never set and forgotten.
    //
    // It used to be a flag the crew raised when a party started work and
    // lowered when it finished, which had no single owner once several parties
    // could be on one fitting — and no owner at all once the party that raised
    // it stopped for a reason other than finishing. A blast that killed the
    // working parties left three fittings flagged with nobody on them, showing
    // a spanner that pulsed forever on work that had stopped; meanwhile a
    // fitting a party was walking to showed nothing at all.
    //
    // Recomputing it costs one pass over the modules and tells the truth by
    // construction, including the case the flag could never express: a job
    // being handed from one party to another without a gap.
    for (const m of this.sys.modules.values()) {
      m.repairing = false;
    }
    for (const q of this.parties) {
      if (q.size <= 0 || !q.task) {
        continue;
      }
      const k = q.task.kind + ':' + q.task.target;
      this._load.set(k, (this._load.get(k) || 0) + q.size);
      if (q.task.kind === 'repair') {
        const m = this.sys.get(q.task.target);
        if (m) {
          m.repairing = true;
        }
      }
    }
    for (const q of this.parties) {
      if (q.size <= 0) {
        continue;
      }
      this._environment(q, dt);
      if (q.size <= 0) {
        continue;
      }
      this._act(q, dt);
    }
    this._redistribute(dt);
    this._recount();
  }

  /**
   * Cross-decking. Once a compartment is habitable again, hands come from
   * somewhere else to man it.
   *
   * A warship does not write off a battery because the people standing in it
   * were killed — it takes hands off a station that can spare them and puts
   * them where the fighting needs them. Without this a single hit that emptied
   * a gunnery deck cost the ship those guns permanently, however many hundreds
   * of people were still aboard, and repairing the mounts changed nothing
   * because there was nobody left to lay them.
   *
   * Three constraints make it a decision rather than a free heal:
   *   - The receiving station has to be TENABLE. Sealing the compartment comes
   *     first; nobody is posted into vacuum or fire.
   *   - The donor has to be able to WALK there, so a cut-off section is cut off.
   *   - The donor keeps `REINFORCE_FLOOR` of its own establishment, which is
   *     what makes this run out. When no division is above the floor there is
   *     no surplus, and the ship fights understrength everywhere — the point at
   *     which it stops being sustainable.
   */
  _redistribute(dt) {
    this.reinforceT = (this.reinforceT || 0) - dt;
    if (this.reinforceT > 0) {
      return;
    }
    this.reinforceT = REINFORCE_INTERVAL;

    // Neediest habitable station first.
    let need = null;
    let worst = REINFORCE_NEED;
    for (const d of this.divisions) {
      const frac = d.max > 0 ? Crew.strength(d) / d.max : 1;
      if (frac < worst && this._tenable(d.station)) {
        worst = frac;
        need = d;
      }
    }
    if (!need) {
      return;
    }

    // Best donor: most surplus, same trade preferred — a gunner cross-decked to
    // a gun is worth more than a stoker, and the census that drives lay quality
    // counts by role.
    let donor = null;
    let best = 0;
    for (const d of this.divisions) {
      const strength = Crew.strength(d);
      if (d === need || strength <= 0) {
        continue;
      }
      const spare = strength - d.max * REINFORCE_FLOOR;
      if (spare <= 0.5) {
        continue;
      }
      const score = spare * (d.role === need.role ? 2.2 : 1);
      // They have to be able to get there from where they actually are.
      // Reachable from where the division's people actually are.
      const home = d.parties.find((q) => q.size > 0) || d.parties[0];
      if (score > best
        && Number.isFinite(this._solveCached(home.at, d.suited).dist.get(need.station))) {
        best = score;
        donor = d;
      }
    }
    if (!donor) {
      return;
    }
    const moved = Math.min(REINFORCE_RATE * REINFORCE_INTERVAL,
      Crew.strength(donor) - donor.max * REINFORCE_FLOOR,
      need.max - Crew.strength(need));
    if (moved <= 0.01) {
      return;
    }
    // Taken off the donor's fullest party and posted to the receiver's
    // emptiest, which is how a party that was wiped out gets re-formed at its
    // own station rather than the hands vanishing into an average.
    const from = donor.parties.reduce((a, q) => (q.size > a.size ? q : a), donor.parties[0]);
    const to = need.parties.reduce((a, q) => (q.size < a.size ? q : a), need.parties[0]);
    from.size -= moved;
    if (to.size <= 0.01) {
      to.at = need.station;
      to.heading = null;
      to.path = [];
      to.task = null;
    }
    to.size += moved;
    this.events.push({ type: 'crossDeck', from: donor, to: need, hands: moved });
  }

  /**
   * Called by the ship when systems raises a compartment-killing event.
   * `lethality` is the fraction of anyone present who is lost.
   */
  killIn(sectionId, lethality = 1) {
    // Whoever is standing in it, party by party. A division no longer occupies
    // one compartment, so a blast takes the working parties that happen to be
    // in the room rather than an entire establishment wherever it is.
    const hit = new Map();
    for (const q of this.parties) {
      if (q.size <= 0 || q.at !== sectionId) {
        continue;
      }
      const lost = Math.min(q.size, q.size * clamp01(lethality));
      q.size -= lost;
      hit.set(q.div, (hit.get(q.div) || 0) + lost);
      if (q.size < 0.5) {
        this._wipe(q, 'blast');
      }
    }
    for (const [d, lost] of hit) {
      if (lost >= 1) {
        this.events.push({
          type: 'casualties', division: d, lost: Math.round(lost), cause: 'blast',
        });
      }
    }
  }

  _wipe(d, cause) {
    d.size = 0;
    d.task = null;
    d.heading = null;
    d.path = [];
    // Only worth reporting when it takes the whole establishment with it. One
    // six-hand party being lost is what `casualties` already says.
    if (Crew.strength(d.div) < 0.5) {
      this.events.push({ type: 'divisionLost', division: d.div, cause });
    }
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
        type: 'casualties', division: d.div, lost: Math.round(d.casualtyAcc),
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
      const solved = this._solveCached(d.at, d.suited);
      const job = this._findJob(d, solved);
      const holdsStation = STATION_ROLES.has(d.role);
      const stationSafe = holdsStation && this._tenable(d.station)
        && this._worthManning(d);

      if (stationSafe) {
        // Hold the post. Take a job only if it is in this very compartment —
        // the bridge watch does not leave the helm to go and weld two rooms
        // away, and a ship that lets them stops steering.
        d.task = job && (job.section || job.target) === d.at ? job : null;
        this._book(d);
        if (!d.task) {
          if (d.at !== d.station) {
            this._walk(d, solved, d.station);
          }
          return;
        }
      } else {
        d.task = job;
        this._book(d);
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
          d.task = null;
          break;
        }
        // Nobody works inside a fire they have not put out first.
        const s = this.sys.section(mod.section);
        if (s && s.fire > 0) {
          d.task = { kind: 'fire', target: s.id };
          break;
        }
        const want = REPAIR_PER_HAND * effort * dt;
        const spares = this.sys.takeSpares(want / JOULES_PER_SPARE);
        if (spares <= 0) {
          d.task = null;
          this.events.push({ type: 'noSpares' });
          break;
        }
        this.sys.repairModule(mod.id, Math.min(want, spares * JOULES_PER_SPARE));
        if (mod.hp >= mod.maxHp) {
          this.events.push({ type: 'repaired', module: mod, by: d.div });
          d.task = null;
        }
        break;
      }
      default:
        d.task = null;
        break;
    }
  }

  /**
   * Record a party's commitment against its job for the rest of this tick.
   *
   * The load census is built once at the top of `tick`, so without this every
   * party deciding on the same tick would see an empty board and pick the same
   * job — they would only discover each other a frame later, by which point
   * they are all walking to the same compartment.
   */
  _book(d) {
    if (!d.task) {
      return;
    }
    const k = d.task.kind + ':' + d.task.target;
    this._load.set(k, (this._load.get(k) || 0) + d.size);
  }

  /**
   * Is this party's station still worth standing at?
   *
   * Holding a post is right while the ship can still use it — a gunnery deck
   * that leaves its mounts stops shooting, and a bridge that wanders stops
   * steering, which is why station roles only take jobs in their own
   * compartment. On a ship that has been shot to a standstill it is the wrong
   * answer entirely: a disabled hull would sit with seventeen hands in
   * engineering and its whole watch at posts that no longer do anything, while
   * the ship span and the two damage-control divisions tried to recover it
   * alone.
   *
   * So once the ship can no longer manoeuvre, or has lost half of what it is
   * made of, a station keeps a skeleton and the rest turn to. That is what a
   * crew would actually do, and it is the difference between a wreck that gets
   * its drives back and one that drifts.
   */
  _worthManning(d) {
    // Three compartments open to space is not a gunnery problem, it is an
    // all-hands one: a watch standing at a mount while the ship comes apart
    // around it is the same mistake as an engineering watch sitting on a wreck.
    const crippled = this.sys.driveAuthority() < 0.15
      || this.sys.integrity < 0.5
      || this.sys.breachCount() >= 3;
    if (!crippled) {
      return true;
    }
    return d.div.parties.indexOf(d) < SKELETON_PARTIES;
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
    return this._walk(d, this._solveCached(d.at, d.suited), sectionId);
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  /**
   * Compact roster for the damage-control panel.
   *
   * A division is in several places at once now, so "where" is the compartment
   * holding most of its people and "state" is what most of its parties are
   * doing — with a count of how many are away from the station, which is the
   * number that actually tells you whether the ship is working on its damage.
   */
  roster() {
    return this.divisions.map((d) => {
      const size = Crew.strength(d);
      const live = d.parties.filter((q) => q.size > 0);
      const byWhere = new Map();
      const byTask = new Map();
      for (const q of live) {
        byWhere.set(q.at, (byWhere.get(q.at) || 0) + q.size);
        // Only the parties that are actually doing something get a vote on what
        // the division is doing. Counting the ones standing at their post too
        // produced "STATION 6/12" — a division reported as holding station and
        // as having six parties out, in the same breath.
        if (q.task || q.heading) {
          const k = q.heading ? 'moving' : q.task.kind;
          byTask.set(k, (byTask.get(k) || 0) + q.size);
        }
      }
      const top = (m, fallback) => [...m.entries()]
        .sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback;
      // What the parties are severally doing, grouped by job so eleven parties
      // on four jobs read as four lines rather than eleven. This is the thing
      // the panel could not say before: a division showed one state, and
      // "STATION" covered both "nothing to do" and "eleven parties spread over
      // the ship" equally badly.
      const byJob = new Map();
      for (const q of live) {
        if (!q.task && !q.heading) {
          continue;
        }
        // Walking to a job is not doing it. A party three compartments away with
        // a patch task was listed as WELDING, so a hole with fourteen hands
        // assigned and nobody there yet looked like a job that had stalled —
        // which is exactly what it was reported as. Crossing a breached, airless
        // compartment costs about fifteen seconds a hop, and the panel should
        // say so rather than imply work is happening.
        const kind = q.heading ? 'moving' : q.task.kind;
        const target = q.task ? q.task.target : q.heading;
        // The DISPLAY kind says whether they are there yet; the job kind says
        // what the target is, and the two must not be confused — looking a
        // module up as a compartment because its party happened to be walking
        // is how a fitting's name turns back into an id in the panel.
        const jobKind = q.task ? q.task.kind : 'moving';
        const k = kind + ':' + target;
        const at = byJob.get(k) || { kind, jobKind, target, hands: 0, parties: 0 };
        at.hands += q.size;
        at.parties += 1;
        byJob.set(k, at);
      }
      const label = (j) => {
        if (j.jobKind === 'repair') {
          const m = this.sys.get(j.target);
          return m ? m.label : j.target;
        }
        const sec = this.hull.sectionById[j.target];
        return sec ? sec.label : j.target;
      };
      /**
       * How far along, in the unit the job is actually measured in. "Twenty-two
       * parties patching" is a useless read-out on its own — what a damage
       * control officer needs is how much hole is left and whether it is going
       * down, so a breach reports square metres and a repair reports condition.
       */
      const note = (j) => {
        if (j.jobKind === 'repair') {
          const m = this.sys.get(j.target);
          return m ? `${Math.round(clamp01(m.hp / m.maxHp) * 100)}%` : '';
        }
        const sec = this.sys.section(j.target);
        if (!sec) {
          return '';
        }
        if (j.jobKind === 'patch') {
          return sec.breachSize > 0 ? `${sec.breachSize.toFixed(1)}m²` : 'frame';
        }
        if (j.jobKind === 'fire') {
          return `${sec.fire.toFixed(0)}`;
        }
        return '';
      };
      return {
        name: d.name,
        role: d.role,
        size: Math.round(size),
        max: d.max,
        alive: size > 0,
        frac: d.max > 0 ? clamp01(size / d.max) : 0,
        at: top(byWhere, d.station),
        /** Parties away from their own station, working. */
        out: live.filter((q) => q.task || q.heading).length,
        parties: live.length,
        task: top(byTask, 'station'),
        /** One entry per distinct job this division has parties on. */
        jobs: [...byJob.values()]
          .sort((a, b) => b.hands - a.hands)
          .map((j) => ({
            kind: j.kind, hands: Math.round(j.hands), what: label(j), note: note(j),
          })),
      };
    });
  }
}

export { TRAVERSE_TIME, HANDS_PER_JOB, JOULES_PER_SPARE };
