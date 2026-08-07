// -----------------------------------------------------------------------------
// systems.js — the simulated interior of a ship.
//
// Owns the live state of every module, compartment and shield facet, plus the
// coupled sims that run over them each tick:
//
//   1. NETWORKS    one undirected flood-fill per utility network (power, data,
//                  coolant) from its intact sources. A severed conduit kills
//                  everything that has no second route to a source. This is the
//                  whole thesis: you do not have to shoot the turret, you have
//                  to shoot something the turret needs.
//   2. POWER       reactor output vs demand, buffered by the capacitor, then
//                  load-shed by priority when the budget will not close.
//   3. ATMOSPHERE  breached compartments vent; life support fights to refill.
//   4. FIRE        needs atmosphere and fuel. Burns soft goods, heats the local
//                  loop, spreads along the compartment graph. Venting kills it —
//                  and anyone standing in the compartment.
//   5. THERMAL     modules dump heat into their coolant loop; radiators reject
//                  it. A dry, unpumped or unradiated loop means runaway heat.
//   6. SHIELDS     six facets fed by the projectors, which are themselves just
//                  modules on the power and coolant networks.
//   7. ORDNANCE    magazine cook-off.
//   8. CASUALTY    reactor containment loss.
//
// Nothing here touches Three.js. It is pure state, so it can be reasoned about
// on its own and the diagnostics UI can read it directly.
// -----------------------------------------------------------------------------
import { NETS, FACETS, MATERIALS } from './hulls.js';
import { clamp, clamp01, lerp } from '../core/mathx.js';

export const LEVEL = { OK: 'ok', WARN: 'warn', CRIT: 'crit', DEAD: 'dead' };
const WARN_AT = 0.85;
const CRIT_AT = 0.45;

/** Interior reference temperature (C). Everything relaxes back toward this. */
export const AMBIENT_C = 18;
/** Above this a module starts losing output. */
export const DERATE_TEMP_C = 95;
/** Above this it trips offline until it cools back below DERATE. */
export const TRIP_TEMP_C = 155;
/** Junction temperature at which the ship computer latches off permanently. */
const COMPUTER_LATCH_C = 128;

/** Speed air leaves a hull breach at, m/s. Sets how fast a compartment vents. */
const EXHAUST_SPEED = 260;
/** Emergency vents open this fraction of a compartment's volume as area. */
const VENT_AREA_FRAC = 0.004;

/** Atmosphere below this and unsuited crew start taking casualties. */
export const ATMO_CRITICAL = 0.35;
/** Fire needs at least this much oxygen to keep burning. */
const FIRE_MIN_ATMO = 0.14;

// Fire tuning. Fire is a degrader that can become a finisher only by reaching
// something that finishes you — a magazine or a fuel tank. On its own it eats
// conduits and cooks compartments.
const FIRE_HEAT = 165;           // degrees/s into the local loop at full intensity
/**
 * Fire and arcing eat a FRACTION of what they are attacking per second rather
 * than an absolute number of joules. Expressed that way they survive a change
 * of ship scale untouched: a conduit takes the same ~50 seconds to burn through
 * whether it is a picket's or a dreadnought's, which is the behaviour you want,
 * and neither has to be re-tuned when the roster is re-pitched.
 */
const FIRE_BURN_FRAC = 0.020;    // of maxHp per second, at full intensity
const FIRE_ATMO_BURN = 0.055;    // atmosphere consumed per second
const FIRE_SPREAD_DELAY = 4.0;

// Arcing from a severed power conduit. Never touches anything flagged critical,
// so it degrades a ship without ever finishing one by itself.
const ARC_CHANCE = 0.30;
const ARC_DAMAGE_FRAC = 0.03;   // of the victim's maxHp

/** Odds a breached reactor actually lets go rather than just scramming. */
const BREACH_DETONATE_CHANCE = 0.35;

// --- shield model ---------------------------------------------------------
// Depth of the field a projectile has to cross before it is through, in metres.
// Dividing this by the round's velocity gives the time over which its energy is
// delivered, and therefore the instantaneous power the emitters have to handle.
// This is the whole reason a slug beats a shield and a laser does not.
export const FIELD_DEPTH = 3.0;
/** How much load a facet can hold before its emitters saturate, vs capacity. */
const FACET_LOAD_RATIO = 0.9;
/** Joules of field energy spent re-establishing per joule absorbed. */
const CHARGE_COST = 0.55;
/** Field energy bought per joule of electrical energy. */
const RECHARGE_EFF = 0.35;
/**
 * Softness of the coupling saturation curve. 1.0 would make the field a hard
 * low-pass filter (perfect below the limit, nothing above it); this exponent
 * makes it a gradual roll-off, so a shield always does *something* to a slug
 * and never fully stops one.
 */
const COUPLING_EXP = 0.35;
/**
 * Coupling capacity of one facet, in watts per joule of that facet's energy
 * capacity. Expressed as a RATIO rather than an absolute so it survives a
 * change of ship scale: a capital shield holds forty times the energy of a
 * picket's and channels power in proportion, and neither has to be re-tuned
 * when the roster is re-pitched.
 */
const COUPLING_PER_JOULE = 28;
/**
 * Heat the emitters can shed with no radiators at all, and the watts each unit
 * of radiator area adds. Sized so a ship with its panels intact can just about
 * live under one sustained beam and not under two — and so a ship whose
 * radiators have been shot off saturates in seconds. Stripping the radiators is
 * therefore a legitimate way to take a shield down without ever hitting it.
 */
const DISSIPATION_BASE_FRAC = 0.0156;
const DISSIPATION_PER_RADIATOR_FRAC = 0.266;

/** Kinds whose electrical draw follows what they are actually doing. */
const DUTY_KINDS = new Set(['thruster', 'rcs', 'hardpoint']);

/**
 * Thermal-mass references for `injectHeat`. Deposited energy raises a thing's
 * temperature in inverse proportion to how much of it there is; these fix the
 * scale, so a module or compartment of this size behaves exactly as the old
 * unscaled constants did and everything larger heats more slowly.
 *
 * `maxHp` is the stand-in for a module's bulk — it already tracks how big and
 * how substantial a fitting is across the roster, from a 1.5 MJ conduit to a
 * 140 MJ main drive — and using it avoids adding a mass column to every row of
 * the hull tables purely to feed one equation.
 */
const REF_BULK = 1.0e7;
const REF_VOLUME = 900;

/**
 * Waste heat a projector takes per watt its facets dissipate. Chosen so full
 * dissipation lands near the projectors' authored `heat` on every hull in the
 * roster (SABRE 8.3e-5, MERIDIAN 5.5e-5, BASTION 4.3e-5 to hit design duty
 * exactly), which keeps "shields are bought from the radiators" a real cost
 * without making a working shield self-destructive.
 */
const SHED_HEAT_PER_WATT = 5.0e-5;

export class Systems {
  constructor(hull, ship = null) {
    this.hull = hull;
    this.ship = ship;
    this.events = [];

    // -- modules -------------------------------------------------------------
    this.modules = new Map();
    this.conduits = [];
    this.hardpoints = [];
    this.sources = { power: [], data: [], coolant: [] };

    for (const def of hull.modules) {
      const m = {
        def,
        id: def.id,
        kind: def.kind,
        label: def.label,
        section: def.section,
        hp: def.hp,
        maxHp: def.hp,
        destroyed: false,
        damagedAt: -1e9,
        temp: AMBIENT_C,
        /** Latched thermal trip; clears when the module cools back down. */
        tripped: false,
        /** Shed by the power manager this tick. */
        shed: false,
        /** Live electrical draw (MW). Usually the authored figure, but the
         *  shield projectors rewrite theirs every tick from how much field
         *  they are actually holding up. */
        drawNow: def.draw,
        /** 0..1 folded capability — health x power x heat. Read by everything. */
        eff: 1,
        // kind-specific live state
        store: def.store !== undefined ? def.store : 0,
        rounds: def.rounds !== undefined ? def.rounds : 0,
        spares: def.spares !== undefined ? def.spares : 0,
        leakRate: 0,
        breached: false,
        breachT: 0,
        detonated: false,
        heatAcc: 0,
        // repair bookkeeping
        repairing: false,
      };
      this.modules.set(def.id, m);
      if (def.kind === 'conduit') {
        this.conduits.push(m);
      }
      if (def.kind === 'hardpoint') {
        this.hardpoints.push(m);
      }
    }
    // A module is a network source if some conduit names it as `src.<id>`.
    for (const c of this.conduits) {
      if (c.def.from.startsWith('src.')) {
        const id = c.def.from.slice(4);
        if (!this.sources[c.def.net].includes(id)) {
          this.sources[c.def.net].push(id);
        }
      }
    }

    // -- compartments --------------------------------------------------------
    this.sections = new Map();
    for (const def of hull.sections) {
      this.sections.set(def.id, {
        def,
        id: def.id,
        label: def.label,
        plateHp: def.plateHp,
        plateMax: def.plateHp,
        breached: false,
        /** Open hole area in square metres. Drives the venting rate. */
        breachSize: 0,
        frameHp: def.frameHp,
        frameMax: def.frameHp,
        frameBroken: false,
        atmo: 1,
        /** Spilled fuel/coolant pooling here: the fuel for a fire. */
        spill: 0,
        fire: 0,          // remaining fire fuel, seconds
        fireSpreadT: 0,
        temp: AMBIENT_C,
        venting: false,   // crew-commanded emergency vent
      });
    }

    // -- coolant loops -------------------------------------------------------
    // Every coolant node in the hull table becomes a real loop with a fluid
    // level and its own temperature, so it is a shared thermal bus: one
    // overworked drive drags everything else on its loop up with it.
    this.loops = new Map();
    for (const node of hull.nodes.coolant) {
      if (node.startsWith('src.')) {
        continue;
      }
      this.loops.set(node, {
        id: node,
        level: 1,
        leak: 0,
        temp: AMBIENT_C,
        heatIn: 0,
        // Thermal mass scales with the ship, because a bigger hull carries more
        // fluid. A heavy cruiser's loops are correspondingly slower to boil,
        // which is why the same hit that cooks an interceptor only warms a
        // gunship — and why a drained loop on a big ship is such a shock.
        capacity: 5 + hull.mass / 25000,
      });
    }

    // -- networks ------------------------------------------------------------
    this.online = {};
    for (const net of NETS) {
      this.online[net] = new Set();
    }

    // -- power ---------------------------------------------------------------
    this.supply = 0;
    this.demand = 0;
    this.busQuality = 1;
    this.brownout = 0;
    this.capStore = 0;
    this.capMax = 0;
    for (const m of this.modules.values()) {
      if (m.kind === 'capacitor') {
        this.capMax += m.def.store;
      }
    }
    this.capStore = this.capMax;

    // -- shields -------------------------------------------------------------
    // See the shield model note above `damageShield`. A facet is not a hit
    // point pool; it is a small energy system with a supply side and a heat
    // side, both of which are plumbed into the rest of the ship.
    const perFacet = hull.shield.capacity / FACETS.length;
    this.shield = {
      facets: Object.fromEntries(FACETS.map((f) => [f, {
        id: f,
        charge: perFacet,            // J of field energy currently established
        max: perFacet,
        load: 0,                     // J absorbed and not yet dissipated
        loadMax: perFacet * FACET_LOAD_RATIO,
        coupling: 1,                 // W this facet can channel right now
        down: false,
        downT: 0,
        cause: null,                 // 'COLLAPSED' | 'SATURATED' | 'NO POWER'
        hitT: 0,                     // impact glow timer, read by the renderer
      }])),
      base: perFacet,
      up: true,
      /** Ship-wide dissipation headroom this tick, W. Radiator-limited. */
      dissipation: 0,
    };

    this.computerLatched = false;
    this.integrity = 1;
    this.destroyed = false;
    /** Set once the hull can no longer be considered a fighting ship. */
    this.strickenT = 0;
  }

  // -- lookups ---------------------------------------------------------------

  get(id) {
    return this.modules.get(id);
  }

  section(id) {
    return this.sections.get(id);
  }

  isAlive(id) {
    const m = this.modules.get(id);
    return !!m && !m.destroyed;
  }

  /** 0..1 folded capability of a module. The one number everything reads. */
  effOf(id) {
    const m = this.modules.get(id);
    return m ? m.eff : 0;
  }

  /** Whether a module's data link is up. Separate from `eff` on purpose: a gun
   *  with no fire-control link is not dead, it is reduced to boresight. */
  hasData(m) {
    const node = m.def.needs && m.def.needs.data;
    return !node || this.online.data.has(node);
  }

  /** Is any module of this kind still contributing? */
  anyLive(kind) {
    for (const m of this.modules.values()) {
      if (m.kind === kind && m.eff > 0.05) {
        return true;
      }
    }
    return false;
  }

  // -- damage entry points ---------------------------------------------------

  /**
   * Applies `joules` of absorbed energy to a module. Returns the damage dealt.
   * This is the only path by which a module loses health, so every consequence
   * of a hit is decided in one place.
   */
  damageModule(id, joules, hitPoint, hitDir) {
    const m = this.modules.get(id);
    if (!m) {
      return 0;
    }
    // Putting another round into an already-breaching reactor sets it off now,
    // rather than waiting to see whether it would have scrammed safely.
    if (m.kind === 'reactor' && m.breached && !m.detonated && joules > 5e4) {
      m.detonated = true;
      m.breached = false;
      this.events.push({ type: 'detonate', module: m, at: hitPoint });
      return joules;
    }
    if (m.destroyed) {
      return 0;
    }
    const dealt = joules * m.def.vuln;
    m.hp = Math.max(0, m.hp - dealt);
    m.damagedAt = performance.now();

    // Fluid carriers start weeping before they rupture outright, so plumbing
    // damage announces itself as a slow problem before it becomes a fast one.
    if (m.kind === 'conduit' && m.def.net === 'coolant' && m.hp > 0) {
      this._leak(m, m.def.leak * (1 - clamp01(m.hp / m.maxHp)) * 0.5);
    }
    if (m.kind === 'fuel' && m.hp > 0) {
      const frac = 1 - clamp01(m.hp / m.maxHp);
      m.leakRate = Math.max(m.leakRate, m.def.leak * frac * 0.6);
      this.events.push({ type: 'fuelLeak', module: m, at: hitPoint });
    }
    // A hit on a full magazine can touch off the propellant without destroying
    // the box first — the risk scales with how much is still in it.
    if (m.kind === 'magazine' && m.hp > 0 && m.rounds > 0) {
      const risk = clamp01(joules / 4e5) * clamp01(m.rounds / Math.max(m.def.rounds, 1)) * 0.30;
      if (Math.random() < risk) {
        this._cookOff(m, hitPoint);
      }
    }

    if (m.hp <= 0) {
      m.destroyed = true;
      m.eff = 0;
      this._onDestroyed(m, hitPoint, hitDir);
    } else if (m.kind === 'conduit' && m.def.net === 'power') {
      this.events.push({ type: 'arc', at: hitPoint, dir: hitDir, module: m, small: true });
    }
    return dealt;
  }

  /**
   * Hull plate takes the hit first; once it is gone the overflow starts eating
   * the frame behind it. Structural failure is therefore always earned by
   * stripping the armour first rather than rolled for.
   */
  damageSection(sectionId, joules, hitPoint, hitDir) {
    const s = this.sections.get(sectionId);
    if (!s) {
      return;
    }
    const absorbed = Math.min(s.plateHp, joules);
    s.plateHp -= absorbed;
    const overflow = joules - absorbed;

    if (s.plateHp <= 0 && !s.breached) {
      s.plateHp = 0;
      s.breached = true;
      this.events.push({ type: 'breach', at: hitPoint, dir: hitDir, section: sectionId });
    }
    if (s.breached) {
      // Every subsequent hit on an open compartment widens the hole, so a
      // compartment you keep shooting vents faster and refuses to hold air.
      s.breachSize += (joules / Math.max(s.plateMax, 1)) * 4 + 0.15;
    }
    if (overflow > 0 && !s.frameBroken) {
      s.frameHp -= overflow * 0.55;
      if (s.frameHp <= 0) {
        s.frameHp = 0;
        s.frameBroken = true;
        this.events.push({ type: 'frame', at: hitPoint, dir: hitDir, section: sectionId });
      }
    }
  }

  /**
   * A clean perforation. This is NOT plate attrition: a slug that fully crosses
   * a wall leaves an entry hole whatever the plate's remaining health, and that
   * compartment is open to space until somebody welds it shut. It is the reason
   * solid shot is a systems weapon rather than a damage weapon — a round that
   * passes clean through does very little to any one component and leaves a
   * line of decompressed compartments the crew now have to cross.
   */
  punchHole(sectionId, size) {
    const s = this.sections.get(sectionId);
    if (!s) {
      return;
    }
    // `size` is the hole's area in square metres — a solid shot bores about
    // half a square metre, an internal detonation opens several.
    s.breachSize += size;
    if (!s.breached) {
      s.breached = true;
      this.events.push({ type: 'perforate', section: sectionId });
    }
  }

  /**
   * A shield facet is a small energy system, not a hit point pool.
   *
   * An impact deposits `joules` over `dwell` seconds — for a projectile that is
   * the time it takes to cross the field, so a hypervelocity slug delivers its
   * energy as an enormous spike and a beam delivers it as a trickle. The
   * emitters can only channel so many watts, so the fraction of a hit the field
   * actually catches falls off with the instantaneous power of that hit. This
   * is why kinetics beat shields and light does not, and it is derived rather
   * than authored: there is no per-weapon "shield damage multiplier" anywhere.
   *
   * Whatever is caught costs field energy to re-establish (charge, bought back
   * with electrical power) and lands as heat that has to go somewhere (load,
   * bled off through the ship's radiators). Two failure modes follow, and they
   * are different problems with different fixes:
   *
   *   COLLAPSED  charge exhausted — the reactor could not keep the field lit.
   *              Fixed by restoring power, or by not being shot at for a while.
   *   SATURATED  load exceeded what the emitters can dissipate. Fixed only by
   *              cooling down, and made far worse by shooting the radiators —
   *              which is a legitimate and non-obvious way to strip a shield.
   *
   * Returns the energy that gets past the bubble.
   */
  damageShield(facet, joules, dwell) {
    const f = this.shield.facets[facet];
    if (!f || f.down) {
      return joules;
    }
    // Exhausted, and it has to SAY so. A facet whose charge is being drained
    // as fast as the reactor can put it back sits pinned just above zero: it
    // was passing every joule straight through while the rose still drew it as
    // a live facet, because the collapse latch only fired if a tick happened to
    // land on exactly zero. Under a slow drain that tick never comes. The whole
    // point of having two named failure modes is that the player can see which
    // one they are in.
    if (f.charge <= f.max * 1e-3 || f.coupling <= 0) {
      f.down = true;
      f.downT = 3.0;
      f.cause = 'COLLAPSED';
      this.events.push({ type: 'facetDown', facet, cause: 'COLLAPSED' });
      return joules;
    }
    const power = joules / Math.max(dwell, 1e-5);
    const frac = 1 / (1 + Math.pow(power / f.coupling, COUPLING_EXP));
    let absorbed = joules * frac;
    // The field cannot catch more than it has the energy to re-establish.
    const affordable = f.charge / CHARGE_COST;
    if (absorbed > affordable) {
      absorbed = affordable;
    }
    f.charge = Math.max(0, f.charge - absorbed * CHARGE_COST);
    f.load += absorbed;
    // Impact flare, read by the renderer. Brighter for a bigger bite.
    f.hitT = Math.max(f.hitT, 0.30 + 0.55 * clamp01(absorbed / (f.max * 0.25)));

    if (f.load >= f.loadMax) {
      f.down = true;
      f.downT = 4.0;
      f.cause = 'SATURATED';
      this.events.push({ type: 'facetDown', facet, cause: 'SATURATED' });
    } else if (f.charge <= 0) {
      f.down = true;
      f.downT = 3.0;
      f.cause = 'COLLAPSED';
      this.events.push({ type: 'facetDown', facet, cause: 'COLLAPSED' });
    }
    return joules - absorbed;
  }

  /** Electromagnetic hit: starves rather than breaks. Cannot damage structure. */
  ionPulse(joules) {
    this.brownout = Math.max(this.brownout, 3.2);
    this.capStore = Math.max(0, this.capStore - joules * 2e-6);
    // The induced energy is SHARED between the runs it couples into, not
    // delivered to each of them in full. Giving every conduit the same bite
    // meant one 60 MJ pulse dealt 144 MJ to a dreadnought's twenty runs and
    // only 58 MJ to a picket's eight — so the weapon got stronger the more
    // redundant its target was, which stands the entire point of wiring a ship
    // as a ring exactly on its head. Split the budget and redundancy protects
    // you again: more parallel paths, less energy into any one of them.
    const live = [];
    for (const c of this.conduits) {
      if (!c.destroyed && !c.def.critical && c.def.net !== 'coolant') {
        live.push(c);
      }
    }
    const each = live.length > 0 ? (joules * 0.6) / live.length : 0;
    for (const c of live) {
      this.damageModule(c.id, each, null, null);
    }
    const hit = live.length;
    // A shield is a field, and an induced field is exactly what an ion pulse
    // wrecks. It does not deposit heat to be dissipated — it drives the
    // emitters out of phase, so the charge goes and the coupling goes with it.
    for (const f of Object.values(this.shield.facets)) {
      f.charge = Math.max(0, f.charge - joules * 0.55);
      f.coupling *= 0.25;
      f.hitT = Math.max(f.hitT, 0.9);
      if (f.charge <= 0 && !f.down) {
        f.down = true;
        f.downT = 6.5;
        f.cause = 'DISRUPTED';
        this.events.push({ type: 'facetDown', facet: f.id, cause: 'DISRUPTED' });
      }
    }
    this.events.push({ type: 'ion', count: hit });
  }

  /** External heat source (beam weapons) dumped into a compartment. */
  injectHeat(sectionId, joules) {
    const s = this.sections.get(sectionId);
    if (s) {
      // Per unit of compartment, not per compartment. A dreadnought's drive
      // cluster is a hundred times the volume of a picket's avionics bay and
      // should not come to the same temperature off the same joule.
      s.temp = Math.min(900, s.temp + (joules * 4e-5) * (REF_VOLUME / Math.max(s.volume, 1)));
    }
    for (const m of this.modules.values()) {
      if (m.section !== sectionId || m.destroyed) {
        continue;
      }
      // Same argument for the kit inside. Without a thermal mass here, a 12 MW
      // lance raised a BASTION main drive 324 degrees per second and tripped
      // both of them — through a full-strength shield, at 89% hull, with a
      // 1400 MW power surplus — inside a second. That one unscaled term was
      // most of why the heaviest hull in the game lost to the lightest.
      m.temp = Math.min(900, m.temp + (joules * 3e-5) * (REF_BULK / Math.max(m.maxHp, 1)));
      const node = m.def.needs && m.def.needs.coolant;
      const loop = node && this.loops.get(node);
      if (loop) {
        loop.temp = Math.min(900, loop.temp + (joules * 1e-5) / loop.capacity);
      }
    }
  }

  _leak(m, rate) {
    const node = m.def.to;
    const loop = this.loops.get(node);
    if (loop) {
      loop.leak = Math.max(loop.leak, rate);
    }
    const s = this.sections.get(m.section);
    if (s) {
      s.spill = clamp01(s.spill + rate * 0.5);
    }
  }

  _onDestroyed(m, at, dir) {
    switch (m.kind) {
      case 'reactor':
        m.breached = true;
        m.breachT = 0;
        this.events.push({ type: 'reactorBreach', at, dir, module: m });
        break;
      case 'conduit':
        if (m.def.net === 'coolant') {
          this._leak(m, m.def.leak);
          this.events.push({ type: 'burst', at, dir, module: m });
        } else {
          this.events.push({ type: 'arc', at, dir, module: m, big: true });
        }
        break;
      case 'fuel': {
        m.leakRate = Math.max(m.leakRate, m.def.leak);
        const s = this.sections.get(m.section);
        if (s) {
          s.spill = 1;
        }
        this.events.push({ type: 'fuelBurst', at, dir, module: m });
        break;
      }
      case 'magazine':
        // A destroyed magazine nearly always goes up: the box is what was
        // keeping the propellant apart.
        if (m.rounds > 0 && Math.random() < 0.75) {
          this._cookOff(m, at);
        } else {
          this.events.push({ type: 'moduleKill', at, dir, module: m });
        }
        break;
      case 'computer':
        this.events.push({ type: 'computerKill', at, dir, module: m });
        break;
      case 'quarters':
        // Crew berthed here die with it. Handled by the crew sim reading this
        // event, so casualties stay in one place.
        this.events.push({ type: 'quartersKill', at, dir, module: m, section: m.section });
        break;
      default:
        this.events.push({ type: 'moduleKill', at, dir, module: m });
        break;
    }
  }

  _cookOff(m, at) {
    if (m.rounds <= 0) {
      return;
    }
    const energy = m.def.cookoff * clamp01(m.rounds / Math.max(m.def.rounds, 1));
    m.rounds = 0;
    m.destroyed = true;
    m.hp = 0;
    m.eff = 0;
    const s = this.sections.get(m.section);
    if (s) {
      // The blast is *inside* the compartment: it wrecks the frame from within,
      // blows the plate outward and starts a fire in the wreckage.
      this.damageSection(m.section, energy * 0.55, at, null);
      s.fire = Math.max(s.fire, 9);
      s.spill = clamp01(s.spill + 0.5);
    }
    // Everything else sharing the compartment eats the rest of it.
    for (const other of this.modules.values()) {
      if (other === m || other.section !== m.section || other.destroyed) {
        continue;
      }
      this.damageModule(other.id, energy * 0.16, at, null);
    }
    this.events.push({ type: 'cookoff', module: m, at, section: m.section, energy });
  }

  /**
   * Emergency vent: dumps a compartment's atmosphere to space. Smothers a fire
   * instantly and is the only fast way to do so — at the cost of anyone in
   * there who has not made it to a suit. The crew sim reads the event.
   */
  ventSection(sectionId) {
    const s = this.sections.get(sectionId);
    if (!s || s.atmo < 0.05) {
      return false;
    }
    s.venting = true;
    s.fire = 0;
    this.events.push({ type: 'vent', section: sectionId });
    return true;
  }

  /** Crew repair hooks. Returns how much was actually applied. */
  repairModule(id, joules) {
    const m = this.modules.get(id);
    if (!m || m.hp >= m.maxHp) {
      return 0;
    }
    // A destroyed module has to be rebuilt from nothing; it comes back cold and
    // at a fraction of rated health, and only if the crew keep working on it.
    if (m.destroyed && m.hp <= 0) {
      m.destroyed = false;
      m.tripped = false;
      m.breached = false;
      m.detonated = false;
      this.events.push({ type: 'restored', module: m });
    }
    const applied = Math.min(joules, m.maxHp - m.hp);
    m.hp += applied;
    if (m.kind === 'conduit' && m.def.net === 'coolant' && m.hp > m.maxHp * 0.6) {
      const loop = this.loops.get(m.def.to);
      if (loop) {
        loop.leak = 0;
      }
    }
    if (m.kind === 'fuel' && m.hp > m.maxHp * 0.6) {
      m.leakRate = 0;
    }
    return applied;
  }

  patchSection(sectionId, joules) {
    const s = this.sections.get(sectionId);
    if (!s) {
      return 0;
    }
    const applied = Math.min(joules, s.plateMax - s.plateHp);
    s.plateHp += applied;
    // Welding closes area, so the rate is in square metres per joule of work.
    s.breachSize = Math.max(0, s.breachSize - (joules / Math.max(s.plateMax, 1)) * 12);
    if (s.breachSize <= 0.02 && s.plateHp > s.plateMax * 0.25) {
      s.breachSize = 0;
      s.breached = false;
      s.venting = false;
      this.events.push({ type: 'patched', section: sectionId });
    }
    return applied;
  }

  /** Draw repair stock from any intact cargo bay. Returns what was available. */
  takeSpares(n) {
    let got = 0;
    for (const m of this.modules.values()) {
      if (m.kind !== 'cargo' || m.destroyed || m.spares <= 0) {
        continue;
      }
      const take = Math.min(n - got, m.spares);
      m.spares -= take;
      got += take;
      if (got >= n) {
        break;
      }
    }
    return got;
  }

  /** Whole units remaining, for display. Stock itself is fractional. */
  totalSpares() {
    let n = 0;
    for (const m of this.modules.values()) {
      if (m.kind === 'cargo' && !m.destroyed) {
        n += m.spares;
      }
    }
    return Math.round(n);
  }

  // -- per-tick simulation ---------------------------------------------------

  tick(dt) {
    this._tickNetworks();
    this._tickPower(dt);
    this._tickAtmosphere(dt);
    this._tickFire(dt);
    this._tickThermal(dt);
    this._tickModules(dt);
    this._tickShields(dt);
    this._tickArcing(dt);
    this._tickCasualty(dt);
    this._tickIntegrity();
  }

  /**
   * One flood-fill per network, seeded from every intact source module and
   * spreading across every intact conduit. Edges are undirected because a cable
   * is: that is what makes the BASILISK's power *ring* survive one cut and fail
   * on the second, without a single line of ring-specific code.
   */
  _tickNetworks() {
    for (const net of NETS) {
      const reached = this.online[net];
      reached.clear();
      for (const srcId of this.sources[net]) {
        const src = this.modules.get(srcId);
        // A source has to be intact AND doing its job. A pump with no power
        // moves no coolant, so its loops are offline even though the pipes are
        // perfectly good — which is why killing power can boil a ship.
        if (src && !src.destroyed && (net === 'power' || src.eff > 0.08)) {
          reached.add(`src.${srcId}`);
        }
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const c of this.conduits) {
          if (c.destroyed || c.def.net !== net) {
            continue;
          }
          const a = reached.has(c.def.from);
          const b = reached.has(c.def.to);
          if (a && !b) {
            reached.add(c.def.to);
            changed = true;
          } else if (b && !a) {
            reached.add(c.def.from);
            changed = true;
          }
        }
      }
    }
  }

  /** True if a module has every network it declares a dependency on. */
  _netsOk(m) {
    const needs = m.def.needs;
    if (!needs) {
      return true;
    }
    // Data is deliberately excluded here — see `hasData`.
    if (needs.power && !this.online.power.has(needs.power)) {
      return false;
    }
    return true;
  }

  _tickPower(dt) {
    // Supply: every intact reactor, derated by its own health and heat.
    let supply = 0;
    for (const m of this.modules.values()) {
      if (m.kind !== 'reactor' || m.destroyed || m.breached || m.detonated) {
        continue;
      }
      const health = clamp01(m.hp / m.maxHp);
      const heat = 1 - clamp01((m.temp - DERATE_TEMP_C) / (TRIP_TEMP_C - DERATE_TEMP_C)) * 0.8;
      m.eff = clamp01(health * heat);
      supply += m.def.output * m.eff;
    }
    this.supply = supply;

    // Demand: everything that draws and is reachable. Modules already dead or
    // network-isolated draw nothing, which is why a crippled ship is efficient.
    const consumers = [];
    let demand = 0;
    for (const m of this.modules.values()) {
      m.shed = false;
      if (m.def.draw <= 0 || m.destroyed || m.tripped || !this._netsOk(m)) {
        continue;
      }
      // Machinery draws when it is doing something. A drive at rest, a jet not
      // firing and a gun not cycling are all hotel load and nothing more, which
      // is why a reactor that cannot run everything at once is normal rather
      // than a fault — and why boosting while firing everything browns you out.
      if (DUTY_KINDS.has(m.kind)) {
        m.drawNow = m.def.draw * (0.15 + 0.85 * clamp01(m.duty || 0));
      }
      consumers.push(m);
      demand += m.drawNow;
    }
    this.demand = demand;

    // Shed lowest priority first until the budget closes. The capacitor covers
    // a transient overdraw; a sustained one starts switching things off.
    let deficit = demand - supply;
    if (deficit > 0) {
      const drawn = Math.min(this.capStore, deficit * dt);
      this.capStore -= drawn;
      if (this.capStore <= 1e-6) {
        consumers.sort((a, b) => a.def.priority - b.def.priority);
        let shedTotal = 0;
        for (const m of consumers) {
          if (demand - shedTotal <= supply) {
            break;
          }
          m.shed = true;
          shedTotal += m.drawNow;
        }
      }
    } else {
      const room = this.capMax - this.capStore;
      // Recharge is limited by the banks' own rate, not just by spare output.
      let rate = 0;
      for (const m of this.modules.values()) {
        if (m.kind === 'capacitor' && !m.destroyed) {
          rate += m.def.rate * clamp01(m.hp / m.maxHp);
        }
      }
      this.capStore += Math.min(room, Math.min(-deficit, rate) * dt);
    }
    this.capMax = 0;
    for (const m of this.modules.values()) {
      if (m.kind === 'capacitor' && !m.destroyed) {
        this.capMax += m.def.store * clamp01(m.hp / m.maxHp);
      }
    }
    this.capStore = Math.min(this.capStore, this.capMax);

    if (this.brownout > 0) {
      this.brownout = Math.max(0, this.brownout - dt);
    }
    const headroom = demand > 1e-6 ? clamp01(supply / demand) : 1;
    const target = (this.brownout > 0 ? 0.35 : 1) * lerp(0.55, 1, headroom);
    this.busQuality = lerp(this.busQuality, target, 1 - Math.exp(-5 * dt));
  }

  _tickAtmosphere(dt) {
    // Life support output is shared across the ship, so a big hull with one
    // scrubber refills slowly and a breached compartment can outpace it.
    let refill = 0;
    for (const m of this.modules.values()) {
      if (m.kind === 'lifeSupport') {
        refill += m.def.rate * m.eff;
      }
    }
    const n = this.sections.size;
    for (const s of this.sections.values()) {
      if (s.breached || s.venting) {
        // Effusion, not a magic number: air leaves through the hole at roughly
        // its own thermal speed, so the fraction of the compartment lost per
        // second is (hole area x exhaust speed) / volume. A half-square-metre
        // perforation empties a small compartment in seconds and a capital
        // ship's main hold in a minute and a half, which is exactly the
        // difference that ought to exist between them.
        const area = s.venting
          ? Math.max(s.breachSize, s.def.volume * VENT_AREA_FRAC)
          : s.breachSize;
        const rate = (area * EXHAUST_SPEED) / Math.max(s.def.volume, 1);
        s.atmo = clamp01(s.atmo - rate * dt);
        if (s.atmo <= 0.02 && s.venting) {
          s.venting = false;
        }
      } else if (s.atmo < 1) {
        s.atmo = clamp01(s.atmo + (refill / n) * dt);
      }
      // Compartment temperature relaxes toward ambient — faster when open to
      // space, which is a small mercy for a burning bay you just vented.
      const relax = s.breached ? 0.55 : 0.14;
      s.temp = lerp(s.temp, AMBIENT_C, 1 - Math.exp(-relax * dt));
    }
  }

  /**
   * Fire is not damage-over-time on modules. It is a heat source and a burner
   * of soft goods: it drives the local coolant loop up (so the compartment's
   * kit derates and trips), chews through conduits (so power and data are lost
   * downstream) and eats the air the crew need. It cannot touch plate or frame,
   * it needs oxygen, it needs fuel, and it spreads only where both exist.
   */
  _tickFire(dt) {
    for (const s of this.sections.values()) {
      if (s.fire <= 0) {
        continue;
      }
      if (s.atmo < FIRE_MIN_ATMO) {
        s.fire = 0;
        this.events.push({ type: 'extinguish', section: s.id, reason: 'vacuum' });
        continue;
      }
      s.fire -= dt;
      if (s.fire <= 0) {
        s.fire = 0;
        this.events.push({ type: 'extinguish', section: s.id, reason: 'fuel' });
        continue;
      }
      const intensity = clamp01(s.fire / 3) * clamp01(s.atmo / 0.5);
      s.atmo = clamp01(s.atmo - FIRE_ATMO_BURN * intensity * dt);
      s.spill = clamp01(s.spill - 0.06 * intensity * dt);
      s.temp = Math.min(900, s.temp + 120 * intensity * dt);

      for (const m of this.modules.values()) {
        if (m.section !== s.id || m.destroyed) {
          continue;
        }
        m.temp = Math.min(900, m.temp + 60 * intensity * dt);
        // Heat also backs up into whatever loop runs through this bay.
        const node = m.def.needs && m.def.needs.coolant;
        const loop = node && this.loops.get(node);
        if (loop) {
          loop.temp = Math.min(900, loop.temp + (FIRE_HEAT / loop.capacity) * intensity * dt);
        }
        if (m.def.critical) {
          continue;
        }
        // Only soft goods actually burn. Conduits are both the fuel and the
        // casualty, which is why a fire reliably costs you a network.
        if (m.def.mat === 'soft') {
          this.damageModule(m.id, m.maxHp * FIRE_BURN_FRAC * intensity * dt, null, null);
        } else if (m.kind === 'magazine' && Math.random() < 0.18 * intensity * dt) {
          this._cookOff(m, null);
        } else if (m.kind === 'fuel' && Math.random() < 0.10 * intensity * dt) {
          this.damageModule(m.id, m.maxHp * 0.4, null, null);
        }
      }

      // Spread: only into a neighbouring compartment that has air and something
      // to burn.
      s.fireSpreadT -= dt;
      if (s.fireSpreadT <= 0) {
        s.fireSpreadT = FIRE_SPREAD_DELAY;
        for (const nId of s.def.adj) {
          const n = this.sections.get(nId);
          if (!n || n.fire > 0 || n.atmo < 0.4 || n.spill < 0.12) {
            continue;
          }
          if (Math.random() < 0.4) {
            this.ignite(nId, s.fire * 0.6);
          }
        }
      }
    }
  }

  /** Starts a fire where there is spilled fuel or coolant and air to burn it. */
  ignite(sectionId, seconds = 8) {
    const s = this.sections.get(sectionId);
    if (!s || s.atmo < FIRE_MIN_ATMO || s.spill < 0.08) {
      return false;
    }
    const fresh = s.fire <= 0;
    s.fire = Math.max(s.fire, seconds * (0.4 + 0.6 * s.spill));
    if (fresh) {
      s.fireSpreadT = FIRE_SPREAD_DELAY;
      this.events.push({ type: 'ignite', section: sectionId });
    }
    return fresh;
  }

  _tickThermal(dt) {
    // Fuel leaks pool as spill (and drain the tank), which is what a fire eats.
    for (const m of this.modules.values()) {
      if (m.kind === 'fuel' && m.leakRate > 0 && m.store > 0) {
        const lost = Math.min(m.store, m.leakRate * 100 * dt);
        m.store -= lost;
        const s = this.sections.get(m.section);
        if (s) {
          s.spill = clamp01(s.spill + m.leakRate * 0.6 * dt);
        }
      }
    }

    for (const loop of this.loops.values()) {
      if (loop.leak > 0 && loop.level > 0) {
        loop.level = clamp01(loop.level - loop.leak * dt);
        if (loop.level <= 0) {
          loop.level = 0;
          loop.leak = 0;
          this.events.push({ type: 'dryLoop', loop: loop.id });
        }
      }
      loop.heatIn = 0;
    }

    // Radiator capacity is a ship-wide pool: lose a panel and every loop cools
    // worse, which is the honest reading of a shared heat-rejection system.
    let reject = 0;
    for (const m of this.modules.values()) {
      if (m.kind === 'radiator' && !m.destroyed) {
        reject += m.def.reject * clamp01(m.hp / m.maxHp);
      }
    }
    this.rejectCapacity = reject;

    for (const m of this.modules.values()) {
      if (m.destroyed) {
        // Wreckage still cools off; it just makes no more heat.
        m.temp = lerp(m.temp, AMBIENT_C, 1 - Math.exp(-0.25 * dt));
        continue;
      }
      const node = m.def.needs && m.def.needs.coolant;
      const loop = node ? this.loops.get(node) : null;
      const loopUp = !!loop && this.online.coolant.has(node);
      // Heat in: duty-proportional, so a drive at 20 % throttle runs cool.
      const heatIn = m.def.heat * (m.duty !== undefined ? m.duty : m.eff) + m.heatAcc;
      m.heatAcc = 0;
      // Heat exchangers are sized to the load they were built for, so at design
      // duty every module settles at roughly the same temperature above its
      // loop regardless of whether it is a 34 MW fusion plant or a sensor mast.
      // That matters: it means a hot reading always signifies damage, an
      // overdriven duty cycle or a failing loop, and never merely "this is a
      // big ship". Losing flow costs a module its exchanger, not its radiator,
      // which is why cutting a pipe cooks one system and not the whole ship.
      const exchanger = clamp(m.def.heat * 0.00225, 0.18, 2.5);
      const coupling = loop ? exchanger * (loopUp ? 1 : 0.12) * loop.level : 0.05;
      const toLoop = loop ? (m.temp - loop.temp) * coupling : 0;
      const toHull = (m.temp - AMBIENT_C) * 0.035;
      if (loop) {
        loop.heatIn += toLoop;
      }
      m.temp = clamp(m.temp + (heatIn * 0.09 - toLoop - toHull) * dt * 1.4, AMBIENT_C, 900);
    }

    for (const loop of this.loops.values()) {
      const up = this.online.coolant.has(loop.id);
      const out = (loop.temp - AMBIENT_C) * (0.35 + reject * 1.5) * loop.level * (up ? 1 : 0.15);
      loop.temp = clamp(loop.temp + ((loop.heatIn - out) / loop.capacity) * dt * 1.4, AMBIENT_C, 900);
      if (loop.level <= 0.001) {
        // An empty loop carries nothing; it just sheds to the hull.
        loop.temp = lerp(loop.temp, AMBIENT_C, 1 - Math.exp(-0.7 * dt));
      }
    }
  }

  /** Folds health, power, heat and shedding into each module's `eff`. */
  _tickModules() {
    for (const m of this.modules.values()) {
      if (m.kind === 'reactor') {
        continue;   // already resolved in _tickPower
      }
      if (m.destroyed) {
        m.eff = 0;
        continue;
      }
      // Thermal trip is a latch with hysteresis, so a module on the edge does
      // not chatter on and off once per tick.
      if (m.temp >= TRIP_TEMP_C && !m.tripped) {
        m.tripped = true;
        this.events.push({ type: 'trip', module: m });
      } else if (m.tripped && m.temp < DERATE_TEMP_C) {
        m.tripped = false;
        this.events.push({ type: 'reset', module: m });
      }
      if (m.tripped || m.shed || !this._netsOk(m)) {
        m.eff = 0;
        continue;
      }
      const health = clamp01(m.hp / m.maxHp);
      const heat = 1 - clamp01((m.temp - DERATE_TEMP_C) / (TRIP_TEMP_C - DERATE_TEMP_C)) * 0.85;
      const volts = m.def.draw > 0 ? this.busQuality : 1;
      m.eff = clamp01(health * heat * volts);
    }

    // The computer cooks itself if its loop boils — a real alternative to
    // putting a slug through the bridge. Slow on purpose: it reads as a gauge
    // climbing, not a switch flipping.
    for (const m of this.modules.values()) {
      if (m.kind !== 'computer' || m.destroyed) {
        continue;
      }
      if (m.temp >= COMPUTER_LATCH_C && !this.computerLatched) {
        this.computerLatched = true;
        this.events.push({ type: 'computerThermal', module: m });
      }
    }
  }

  _tickShields(dt) {
    const facets = FACETS.map((k) => this.shield.facets[k]);
    let gen = 0;
    let projectors = [];
    for (const m of this.modules.values()) {
      if (m.kind !== 'shieldGen' || m.destroyed) {
        continue;
      }
      gen += m.eff;
      if (m.eff > 0.02) {
        projectors.push(m);
      }
    }
    this.shield.up = gen > 0.05;
    // Ceiling scales with the projectors still working, so shooting one lowers
    // the roof permanently rather than merely slowing the recharge.
    const scale = clamp01(0.35 + 0.65 * clamp01(gen * 0.5));
    const target = this.shield.base * scale;

    // Dissipation is bought from the same radiators that cool the drives. This
    // is the interesting coupling: strip a ship's radiators and its shields
    // saturate after a fraction of the punishment they used to absorb.
    const cap = this.hull.shield.capacity;
    const dissipTotal = (cap * DISSIPATION_BASE_FRAC
      + (this.rejectCapacity || 0) * cap * DISSIPATION_PER_RADIATOR_FRAC) * clamp01(gen);
    this.shield.dissipation = dissipTotal;
    const perFacet = dissipTotal / facets.length;
    let shedTotal = 0;

    for (const f of facets) {
      f.max = target;
      f.loadMax = target * FACET_LOAD_RATIO;
      if (f.charge > f.max) {
        f.charge = f.max;
      }
      const shed = Math.min(f.load, perFacet * dt);
      f.load = Math.max(0, f.load - shed);
      shedTotal += shed;
      if (f.hitT > 0) {
        f.hitT = Math.max(0, f.hitT - dt);
      }
      if (f.down) {
        f.downT -= dt;
        // A saturated emitter will not restart until it has actually cooled;
        // a collapsed one only needs the field re-established.
        const cooled = f.load < f.loadMax * 0.45;
        const powered = this.shield.up && f.charge > f.max * 0.12;
        if (f.downT <= 0 && cooled && powered) {
          f.down = false;
          f.cause = null;
        }
      }
      // Coupling capacity: what the emitters can channel right now. It falls
      // with heat already in the facet, which is the "degrades as it has to
      // channel the energy elsewhere" behaviour — a facet under sustained fire
      // gets progressively worse at catching the next round.
      f.coupling = f.max * COUPLING_PER_JOULE * clamp01(gen)
        * clamp01(f.charge / Math.max(f.max, 1))
        * (1 - clamp01(f.load / Math.max(f.loadMax, 1)) * 0.8)
        * this.busQuality;
    }

    // The heat the emitters shed has to go somewhere: into the projectors, and
    // from there into their coolant loop like any other module's waste heat.
    //
    // Scaled so that a facet array shedding at FULL capacity runs its
    // projectors at roughly their design duty — the same principle as the heat
    // exchangers, where a hot reading means damage rather than "this is a big
    // ship". At the old 1.0e-3 a working shield fed its own projectors about
    // eighteen times their rated heat and tripped them within twenty seconds of
    // taking any fire at all, which turned the shield into a liability the
    // moment it did its job. That never showed up before because most shots
    // bypassed the bubble entirely, so the facets never carried load to shed.
    if (shedTotal > 0 && projectors.length > 0) {
      const each = (shedTotal / dt) * SHED_HEAT_PER_WATT / projectors.length;
      for (const m of projectors) {
        m.heatAcc += each;
      }
    }

    // Recharge, weakest facet first, so the bubble self-balances — which is why
    // holding station on one side of a ship works.
    //
    // A collapsed facet has to be in this pool too: re-establishing the field
    // IS how it comes back, and the restart test below asks for charge. Leave
    // it out and a facet that goes down once can never satisfy the condition
    // for coming back up, and stays dead for the rest of the engagement.
    // Re-striking from nothing is slower than topping up, and an emitter still
    // full of heat cannot start at all.
    let budget = this.hull.shield.regen * clamp01(gen) * dt;
    const live = facets.filter((f) => f.charge < f.max
      && (!f.down || f.load < f.loadMax * 0.45));
    if (live.length > 0 && budget > 0) {
      live.sort((a, b) => (a.charge / Math.max(a.max, 1)) - (b.charge / Math.max(b.max, 1)));
      for (const f of live) {
        // A hot facet recharges badly; the emitters are busy shedding.
        const eff = (1 - clamp01(f.load / Math.max(f.loadMax, 1)) * 0.7)
          * (f.down ? 0.45 : 1);
        const take = Math.min(budget, (f.max - f.charge) / Math.max(eff, 0.05));
        f.charge += take * eff;
        budget -= take;
        if (budget <= 0) {
          break;
        }
      }
    }

    // Bill the power system for both jobs. Holding a field costs by how much
    // field you are holding, which is why a collapsed shield stops being a
    // load and a healthy one is the biggest single draw aboard.
    const held = facets.reduce((a, f) => a + f.charge, 0)
      / Math.max(facets.length * Math.max(target, 1), 1e-9);
    const rechargeMW = ((this.hull.shield.regen * clamp01(gen)) / RECHARGE_EFF) * 1e-6;
    for (const m of this.modules.values()) {
      if (m.kind === 'shieldGen') {
        m.drawNow = m.def.draw * (0.22 + 0.78 * clamp01(held))
          + (m.destroyed ? 0 : rechargeMW / Math.max(projectors.length, 1));
      }
    }
  }

  /**
   * A severed power run arcs into its neighbours. Bounded hard: small per-tick
   * energy, and anything flagged critical is immune, so arcing degrades a ship
   * without ever finishing one.
   */
  _tickArcing(dt) {
    if (this.supply <= 0.05) {
      return;
    }
    for (const c of this.conduits) {
      if (!c.destroyed || c.def.net !== 'power' || Math.random() > ARC_CHANCE * dt) {
        continue;
      }
      const victims = [];
      for (const m of this.modules.values()) {
        if (m.destroyed || m.def.critical || m.section !== c.section || m.kind === 'conduit') {
          continue;
        }
        victims.push(m);
      }
      if (victims.length > 0) {
        const v = victims[Math.floor(Math.random() * victims.length)];
        this.damageModule(v.id, v.maxHp * ARC_DAMAGE_FRAC, null, null);
      }
      // An arc next to spilled fuel is one of the two ways a fire starts.
      if (Math.random() < 0.35) {
        this.ignite(c.section, 7);
      }
    }
  }

  _tickCasualty(dt) {
    for (const m of this.modules.values()) {
      if (m.kind !== 'reactor' || !m.breached || m.detonated) {
        continue;
      }
      m.breachT += dt;
      const s = this.sections.get(m.section);
      if (s) {
        s.temp = Math.min(900, s.temp + 220 * dt);
        s.spill = clamp01(s.spill + 0.3 * dt);
        if (Math.random() < 1.4 * dt) {
          this.ignite(m.section, 10);
        }
      }
      // Most breaches scram. A reactor that genuinely lets go is meant to be a
      // payoff, not the default end of every fight — put another round in it if
      // you want to be sure.
      if (m.breachT > 2.4) {
        m.breached = false;
        if (Math.random() < BREACH_DETONATE_CHANCE) {
          m.detonated = true;
          this.events.push({ type: 'detonate', module: m, at: null });
        } else {
          this.events.push({ type: 'scram', module: m });
        }
      }
    }
  }

  _tickIntegrity() {
    let sum = 0;
    let total = 0;
    for (const m of this.modules.values()) {
      const w = m.def.critical ? 3 : 1;
      sum += (m.hp / m.maxHp) * w;
      total += w;
    }
    for (const s of this.sections.values()) {
      sum += (s.frameHp / s.frameMax) * 2;
      total += 2;
    }
    this.integrity = total > 0 ? sum / total : 0;
  }

  // -- derived capability read-outs ------------------------------------------

  /** Is there a working computer with power and a helm data link? */
  get flightComputer() {
    if (this.computerLatched) {
      return false;
    }
    for (const m of this.modules.values()) {
      if (m.kind === 'computer' && m.eff > 0.15 && this.online.data.has('d.helm')) {
        return true;
      }
    }
    return false;
  }

  /** 0..1 main drive authority, weighted by each drive's share of the total. */
  driveAuthority() {
    let acc = 0;
    let share = 0;
    for (const m of this.modules.values()) {
      if (m.kind !== 'thruster') {
        continue;
      }
      const tank = this.modules.get(m.def.fuel);
      const fuelOk = tank && !tank.destroyed && tank.store > 0.5 ? 1 : 0;
      acc += m.eff * fuelOk * m.def.share;
      share += m.def.share;
    }
    return share > 0 ? clamp01(acc / share) : 0;
  }

  /** 0..1 authority about each body axis, from the surviving RCS blocks. */
  rcsAuthority(out = [0, 0, 0]) {
    out[0] = 0; out[1] = 0; out[2] = 0;
    let n = [0, 0, 0];
    for (const m of this.modules.values()) {
      if (m.kind !== 'rcs') {
        continue;
      }
      for (let i = 0; i < 3; i++) {
        out[i] += m.eff * m.def.axes[i];
        n[i] += m.def.axes[i];
      }
    }
    for (let i = 0; i < 3; i++) {
      out[i] = n[i] > 0 ? clamp01(out[i] / n[i]) : 0;
    }
    return out;
  }

  /** 0..1 lateral (strafe) authority — separate, because the jets differ. */
  lateralAuthority() {
    let acc = 0;
    let n = 0;
    for (const m of this.modules.values()) {
      if (m.kind !== 'rcs') {
        continue;
      }
      const l = m.def.lat;
      const s = (l[0] + l[1] + l[2]) / 3;
      acc += m.eff * s;
      n += s;
    }
    return n > 0 ? clamp01(acc / n) : 0;
  }

  sensorQuality() {
    let best = 0;
    for (const m of this.modules.values()) {
      if (m.kind === 'sensor' && this.hasData(m)) {
        best = Math.max(best, m.eff);
      }
    }
    return best;
  }

  fuelFraction() {
    let store = 0;
    let max = 0;
    for (const m of this.modules.values()) {
      if (m.kind === 'fuel') {
        store += m.store;
        max += m.def.store;
      }
    }
    return max > 0 ? clamp01(store / max) : 0;
  }

  shieldFraction() {
    let charge = 0;
    let max = 0;
    for (const f of Object.values(this.shield.facets)) {
      charge += f.charge;
      max += f.max;
    }
    return max > 0 ? clamp01(charge / max) : 0;
  }

  /** 0..1 how close the emitters are to saturating. The other failure mode. */
  shieldLoadFraction() {
    let load = 0;
    let max = 0;
    for (const f of Object.values(this.shield.facets)) {
      load += f.load;
      max += f.loadMax;
    }
    return max > 0 ? clamp01(load / max) : 0;
  }

  hullFraction() {
    let hp = 0;
    let max = 0;
    for (const s of this.sections.values()) {
      hp += s.plateHp + s.frameHp;
      max += s.plateMax + s.frameMax;
    }
    return max > 0 ? clamp01(hp / max) : 0;
  }

  hottestLoop() {
    let best = null;
    for (const loop of this.loops.values()) {
      if (!best || loop.temp > best.temp) {
        best = loop;
      }
    }
    return best;
  }

  fireCount() {
    let n = 0;
    for (const s of this.sections.values()) {
      if (s.fire > 0) {
        n++;
      }
    }
    return n;
  }

  breachCount() {
    let n = 0;
    for (const s of this.sections.values()) {
      if (s.breached) {
        n++;
      }
    }
    return n;
  }

  /**
   * A ship is DESTROYED when something aboard has actually finished it. Checked
   * by the director rather than by a single hit-point pool, so a kill is always
   * the result of a specific failure you can point at in the schematic.
   *
   * This used to read `!(hasPower && (canMove || canThink))`, and measurement
   * showed every kill in the game — 21 of 21 sampled — came out of that one
   * clause. `hasPower` is `supply > 0.4` MW, which a cruiser exceeds at idle by
   * three orders of magnitude, and the 0.10 hull floor was never reached, so
   * the whole test collapsed to "no drives AND no computer". Ships died at 36
   * to 62 percent hull with full magazines and working guns, and none of the
   * four bars on the HUD predicted it. Losing the ability to manoeuvre is now
   * `isDerelict` — a different outcome, handled differently.
   */
  isStricken() {
    const core = this.modules.get('reactor');
    if (core && core.detonated) {
      return true;
    }
    // The hull has come apart, or there is nobody left to fight it.
    return this.hullFraction() < 0.18
      || this.integrity < 0.12
      || (this.ship && this.ship.crew.complement < 0.06)
      // Cold and dark: no plant, no capacitor, nothing to shoot with.
      || (this.supply <= 0.4 && this.capStore <= this.capMax * 0.02);
  }

  /**
   * Mission-killed: adrift and unable to fly itself. Not the same event as
   * being destroyed — the guns may still bear and the crew are still aboard —
   * so the director treats it as a hulk rather than a wreck, and the player
   * gets the choice of finishing it or leaving it behind.
   */
  isDerelict() {
    return this.driveAuthority() <= 0.06 && !this.flightComputer;
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }
}

/**
 * Grades one module for the diagnostic tree and the cutaway. Both call this, so
 * the two views can never disagree about what colour a row is.
 */
export function moduleStatus(sys, m) {
  const frac = clamp01(m.hp / m.maxHp);
  const def = m.def;

  if (m.destroyed) {
    let text = 'DESTROYED';
    if (m.kind === 'conduit') {
      text = def.net === 'coolant' ? 'RUPTURED' : 'SEVERED';
    } else if (m.kind === 'magazine') {
      text = 'DETONATED';
    }
    return { level: LEVEL.DEAD, text, frac: 0 };
  }

  const byHealth = frac < CRIT_AT ? LEVEL.CRIT : (frac < WARN_AT ? LEVEL.WARN : LEVEL.OK);

  if (def.needs && def.needs.power && !sys.online.power.has(def.needs.power)) {
    return { level: LEVEL.DEAD, text: 'NO POWER', frac };
  }
  if (m.shed) {
    return { level: LEVEL.CRIT, text: 'LOAD SHED', frac };
  }
  if (m.tripped) {
    return { level: LEVEL.CRIT, text: `${Math.round(m.temp)}° TRIPPED`, frac };
  }

  switch (m.kind) {
    case 'reactor': {
      if (m.breached) {
        return { level: LEVEL.CRIT, text: 'CONTAINMENT', frac };
      }
      const out = (def.output * m.eff).toFixed(1);
      return { level: byHealth, text: `${out} MW`, frac };
    }
    case 'capacitor': {
      const pct = sys.capMax > 0 ? Math.round((sys.capStore / sys.capMax) * 100) : 0;
      const level = pct < 15 ? LEVEL.CRIT : (pct < 45 ? LEVEL.WARN : byHealth);
      return { level, text: `${pct}% CHG`, frac };
    }
    case 'conduit': {
      if (def.net === 'coolant') {
        const loop = sys.loops.get(def.to);
        if (loop) {
          const level = loop.level < 0.3 || loop.temp > 150
            ? LEVEL.CRIT
            : (loop.level < 0.9 || loop.temp > 100 ? LEVEL.WARN : byHealth);
          return {
            level,
            text: `${Math.round(loop.temp)}° ${Math.round(loop.level * 100)}%`,
            frac,
          };
        }
      }
      const up = sys.online[def.net].has(def.to);
      return {
        level: up ? byHealth : LEVEL.CRIT,
        text: up ? (byHealth === LEVEL.OK ? 'CONTINUITY' : 'DEGRADED') : 'NO PATH',
        frac,
      };
    }
    case 'fuel': {
      const pct = Math.round((m.store / def.store) * 100);
      const level = m.leakRate > 0 ? LEVEL.CRIT : (pct < 25 ? LEVEL.WARN : byHealth);
      return { level, text: m.leakRate > 0 ? `${pct}% LEAKING` : `${pct}% FUEL`, frac };
    }
    case 'magazine': {
      const pct = Math.round((m.rounds / def.rounds) * 100);
      return { level: byHealth, text: `${pct}% ROUNDS`, frac };
    }
    case 'cargo':
      return { level: byHealth, text: `${Math.round(m.spares)} SPARES`, frac };
    case 'hardpoint': {
      if (!sys.hasData(m)) {
        return { level: LEVEL.WARN, text: 'BORESIGHT', frac };
      }
      return {
        level: m.temp > DERATE_TEMP_C ? LEVEL.WARN : byHealth,
        text: `${Math.round(m.temp)}° ${Math.round(m.eff * 100)}%`,
        frac,
      };
    }
    case 'thruster':
    case 'rcs':
    case 'shieldGen':
    case 'computer':
    case 'sensor':
    case 'pump':
      return {
        level: m.temp > DERATE_TEMP_C ? LEVEL.WARN : byHealth,
        text: `${Math.round(m.eff * 100)}%`,
        frac,
      };
    default:
      break;
  }

  const text = byHealth === LEVEL.OK
    ? 'NOMINAL'
    : (byHealth === LEVEL.WARN ? 'DAMAGED' : 'CRITICAL');
  return { level: byHealth, text, frac };
}

export { MATERIALS };
