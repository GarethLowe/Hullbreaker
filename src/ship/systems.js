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
import { NETS, FACETS, MATERIALS, HOIST_FILL_SECONDS } from './hulls.js';
import { createLiveSection, sectionHeatDelta } from './hull-types.js';
import { clamp, clamp01, lerp } from '../core/mathx.js';
import {
  captureState, applyState, captureMap, applyMap, captureRecord, applyRecord,
} from '../core/state.js';

export const LEVEL = { OK: 'ok', WARN: 'warn', CRIT: 'crit', DEAD: 'dead' };
const WARN_AT = 0.85;
const CRIT_AT = 0.45;

/** Interior reference temperature (C). Everything relaxes back toward this. */
export const AMBIENT_C = 18;
/** Above this a module starts losing output. */
export const DERATE_TEMP_C = 95;
/** Above this it trips offline until it cools back below DERATE. */
export const TRIP_TEMP_C = 155;
/**
 * Junction temperature at which a ship computer cooks itself off the bus.
 *
 * It used to latch PERMANENTLY, ship-wide, and that was two bugs wearing one
 * coat. A boiled coolant loop took the helm for the rest of the run with no
 * recovery of any kind — the module sat at a hundred per cent health and ambient
 * temperature with the flag still set, so "repair the computer" was advice that
 * could not be followed, and later waves were unflyable. And because the flag
 * was on the SHIP, cooking the bridge machine also disabled a perfectly healthy
 * auxiliary two decks away, which is the opposite of why a second one is fitted.
 *
 * It is per-module now, and it is real damage rather than a flag: a computer
 * that cooks its junctions is left at `COMPUTER_COOKED_HP` of rated health, so
 * getting the helm back is a damage-control job like any other. The weight the
 * permanent latch was reaching for is still there — losing the helm mid-fight
 * is severe, and on a hull with one computer it is very severe — but it is a
 * problem the crew can be sent at instead of the end of the run.
 */
const COMPUTER_LATCH_C = 128;
/** Health a cooked computer is left at, and what it must be nursed back past. */
const COMPUTER_COOKED_HP = 0.12;
const COMPUTER_REBOOT_HP = 0.55;

/**
 * How sound a coolant run has to be before its loop will hold pressure. The
 * same threshold `repairModule` uses to stop the leak, named here because two
 * places now depend on agreeing about when a pipe counts as mended.
 */
const COOLANT_TIGHT_FRAC = 0.6;
/**
 * Fraction of a loop's charge the pumps put back per second, at full flow.
 *
 * 1/140th: a loop drained to nothing comes back over about two and a half
 * minutes, which is three wave gaps. That is deliberately slower than the
 * welding — losing your coolant should be a wound you nurse across a couple of
 * engagements, not a thing the crew undoes the moment they finish the pipe —
 * and it is far slower than the seconds a dry loop takes to cook a drive, so
 * the recovery is something the player watches happen. Coupling scales with
 * `level`, so a half-full loop is genuinely half a cooling system: the drives
 * come back off their trip late in the charge rather than the moment it starts.
 *
 * The reserve behind it is unmodelled and effectively infinite. A make-up tank
 * with a finite charge would be the honest version and is the obvious upgrade
 * if coolant ever needs to be a resource the player manages; today nothing
 * else in the ship treats it as one.
 */
const LOOP_RECHARGE = 1 / 140;

/**
 * Bunker units lost per second, per unit of `leak`, through a breached tank.
 *
 * A fusion drive carries very little reaction mass for what it does — that is
 * the whole point of the exhaust velocity — so a bunker is a small, dense,
 * heavily-boxed thing rather than a chemical tanker's wing full of kerosene.
 * At the old 100 a breach emptied a tank in eight to fourteen SECONDS: two
 * hundred and fifty times the burn rate, faster than a damage-control party
 * can cross a compartment, and with no decision anywhere in it. The crew's own
 * repair path clears `leakRate` the moment the tank is above 60% health, and
 * they were never once given the chance to use it.
 *
 * At 4 the same breach takes three and a half to six minutes. That is still an
 * order of magnitude above the burn — a holed bunker is unambiguously why you
 * are losing fuel, never the flying — but it is now a job on the board that a
 * party can be sent to and can win. Losing propellant should cost you a repair
 * you had to prioritise, not a coin flip you never saw.
 */
export const FUEL_LEAK_RATE = 4;
/**
 * How fast a punctured bunker closes itself, in `leak` units per second.
 *
 * Self-sealing tanks are eighty-year-old technology on aircraft — a bladder
 * whose inner layer swells shut around a hole — and a warship carrying reaction
 * mass through gunfire is the obvious place for the idea to have kept going.
 * Mechanically it is what turns a breach from a countdown into a decision: the
 * tank will close on its own in about two minutes and you will lose roughly a
 * quarter of what was in it, OR you send a party and lose almost none. Damage
 * control is still strictly better and still worth prioritising; it is no
 * longer the difference between a working ship and a hulk.
 */
export const FUEL_SELF_SEAL = 0.12 / 120;
/**
 * Cryogenic boil-off, in bunker units per second, always.
 *
 * A tenth of what one drive draws at full throttle, so it can never be the
 * reason you are short — over a twenty-five minute run it is about three per
 * cent — but a hull left drifting for an hour is not quite as full as it was.
 * Reaction mass is not a number in a box; it is a cold thing in a tank, and it
 * is trying to leave.
 */
export const FUEL_BOIL_OFF = 0.002;

/** Speed air leaves a hull breach at, m/s. Sets how fast a compartment vents. */
const EXHAUST_SPEED = 260;
/** Emergency vents open this fraction of a compartment's volume as area. */
const VENT_AREA_FRAC = 0.004;
/**
 * Fraction of a damage-control party's work that goes into structure once the
 * hull is sealed. Well under one: shoring a buckled frame is the slowest job on
 * the ship, and it should feel like the difference between a hull you have
 * patched and a hull you have actually repaired.
 */
const FRAME_REPAIR_FRAC = 0.22;

/**
 * Work needed to weld a square metre shut, per metre of plate thickness.
 *
 * Welding used to cost `plateMax / 12` joules per square metre — that is, the
 * speed depended on the compartment's total HULL POINTS, which has nothing to
 * do with closing a hole. A big room was slower to patch than a small one made
 * of the same plate, and a dreadnought's compartments were glacial purely
 * because they are large: 51 seconds a square metre on a BASTION spine against
 * one second on a SABRE pod, so a 7 m² hole took the better part of twenty
 * minutes and looked to the player as though the parties were queuing.
 *
 * Thickness is what a welder actually fights. Calibrated so a MERIDIAN is
 * unchanged; the dreadnought gets a quarter of its time back and the picket,
 * whose plate really is thin, loses a little.
 */
const WELD_PER_M2 = 6.0e6;

/**
 * What fraction of its rating a run actually carries, from its condition.
 *
 * A conduit used to be a switch: intact or severed, with nothing in between.
 * That was invisible until the network started carrying a service level, and
 * then it produced something plainly wrong — `repairModule` clears `destroyed`
 * on the FIRST joule of work, so a party touching a severed main trunk restored
 * the whole branch to full service at 0.2% of the cable's health. A cruiser's
 * forward bus came back one second after being cut, which made the cross-ties
 * decorative and made cutting anything pointless.
 *
 * So a run is a gradient. Nothing until the splice is holding, full only once
 * the work is properly finished, and a chewed-but-live cable carries less than
 * a sound one — which is also the honest answer for battle damage, and the
 * thing that lets a network be degraded rather than only ever on or off.
 */
/**
 * What a shield costs just to stay lit, as a fraction of the projectors' rated
 * draw and heat. Emitters idling into a standing field is real load — it is not
 * free — but it is a hotel service, not the main event. Everything above this
 * is bought by work: re-striking drained facets and channelling what the field
 * is absorbing.
 */
const SHIELD_HOLD_DUTY = 0.25;

/**
 * Standing losses of a fusion plant carrying no load, as a fraction of its
 * rated waste heat. You cannot switch a reactor off and leave the ship dark, so
 * it is never free — it is just not the full number.
 */
const REACTOR_IDLE_DUTY = 0.15;

const RUN_DEAD = 0.15;
const RUN_SOUND = 0.65;
function runService(m) {
  return clamp01((m.hp / m.maxHp - RUN_DEAD) / (RUN_SOUND - RUN_DEAD));
}

/** Atmosphere below this and unsuited crew start taking casualties. */
export const ATMO_CRITICAL = 0.35;
/** Fire needs at least this much oxygen to keep burning. Below it, it is out. */
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
/** How much load a facet can hold before its emitters saturate, vs capacity. */
const FACET_LOAD_RATIO = 8;
/** Joules of field energy spent re-establishing per joule absorbed. */
const CHARGE_COST = 0.20;
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
 * Ceiling on how much harder a spike is to shed than a slow burn. Three: a
 * hypervelocity driver round loads a facet's emitters three times as hard as
 * the same joules delivered by a lance. That is the whole anti-shield story
 * now — not that the slug gets through, but that it saturates what stopped it.
 */
const SPIKE_MAX = 3.0;

/**
 * Fraction of a stores bay's stock still findable after the compartment is
 * wrecked.
 *
 * Spares are inert boxes on shelves, not machinery — a smashed store room does
 * not vaporise, it spills. Treating a destroyed bay as holding literally
 * nothing meant a SABRE, which carries its entire 260 units in one hold, lost
 * the whole damage-control capability to a single round: the parties kept
 * taking jobs, finding nothing to work with, and returning to station forever.
 * Running your stock down over a long fight is the interesting failure; having
 * it deleted by one hit is the arbitrary one.
 */
const SPARES_SALVAGE = 0.40;
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
 * Thermal-mass reference for module heat injection. Deposited energy raises a
 * thing's temperature in inverse proportion to how much of it there is.
 *
 * `maxHp` is the stand-in for a module's bulk — it already tracks how big and
 * how substantial a fitting is across the roster, from a 1.5 MJ conduit to a
 * 140 MJ main drive — and using it avoids adding a mass column to every row of
 * the hull tables purely to feed one equation.
 */
const REF_BULK = 1.0e7;

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
    this.random = ship && ship.game.random ? ship.game.random : Math.random;
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
        temp: AMBIENT_C,
        /** Latched thermal trip; clears when the module cools back down. */
        tripped: false,
        /**
         * A computer that has cooked its junctions. Clears when it is cool AND
         * has been mended past COMPUTER_REBOOT_HP; see `_tickThermal`.
         */
        latched: false,
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
        duty: 0,
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
    /** @type {Map<string, import('./hull-types.js').LiveSection>} */
    this.sections = new Map();
    for (const def of hull.sections) {
      this.sections.set(def.id, createLiveSection(def, AMBIENT_C));
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
    // Node -> service level, 0..1. See `_tickNetworks`.
    this.online = {};
    for (const net of NETS) {
      this.online[net] = new Map();
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

    this.integrity = 1;
    this.destroyed = false;
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
      if (this.random() < risk) {
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
    // Ruptured services.
    //
    // Nothing aboard is empty space: hydraulic runs, coolant returns, lubricant
    // and the compartment's own stores are threaded through every bay on the
    // ship, and a hit that opens one puts some of that on the deck. Until this
    // existed the ONLY source of spill was a direct hit on a fuel tank or a
    // coolant module, so a hull could be shot to pieces without ever having a
    // fire in it — which is exactly what it looked like from outside, and it is
    // wrong. Fire is supposed to be the thing that turns a bad hit into a bad
    // hour, and it cannot be if it never starts.
    //
    // Deliberately small. It takes a real hit to leave enough to burn, and it
    // is bounded well below what a ruptured bunker spills.
    const rupture = clamp01(joules / Math.max(s.plateMax, 1)) * 2.2;
    if (rupture > 0.004) {
      s.spill = clamp01(s.spill + Math.min(rupture, 0.25));
      // And the ignition source arrives in the same instant. A hypervelocity
      // impact throws incandescent spall off the back face of the plate it just
      // crossed, into whatever has come out of the runs it cut on the way.
      //
      // A CHANCE, and one that never reaches certainty. At `rupture * 2` this
      // saturated: any hit taking about a quarter of a compartment's plate lit
      // it with probability one, which was survivable while every attacker
      // aimed at the centre of mass and stopped being so the moment they
      // started picking compartments. Measured against three hulls
      // concentrating properly, nine of a cruiser's fourteen compartments were
      // alight inside ten seconds and twelve by the time it died — at which
      // point fire is not an event, it is the ship's paint. A quarter is the
      // ceiling: a compartment under sustained fire catches soon enough, and
      // taking a couple of rounds usually costs you nothing but plate.
      if (this.random() < Math.min(0.25, rupture * 0.45)) {
        this.ignite(sectionId, 5 + 14 * s.spill);
      }
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
    // A FIELD STOPS THINGS. That is what it is for.
    //
    // This used to decide how much of a hit leaked through from the
    // instantaneous power of the round against the facet's coupling, and the
    // numbers made a charged shield very nearly transparent to the one weapon
    // most likely to be pointed at it: a full facet stopped 28% of an armour-
    // piercing driver round and passed 29 MJ into a bow wall that costs 2.5 MJ
    // to cross. One round, through the shield, through the plate, two
    // compartments open. There was even an assertion enshrining it.
    //
    // The field blocks what it can pay for. What it stops has to go SOMEWHERE,
    // and that is the real cost: charge to hold the impact, and heat the
    // emitters have to shed afterwards. A hypervelocity slug is not hard to
    // stop, it is hard to DISSIPATE — the same joules arriving as a spike load
    // the emitters several times harder than a beam pouring them in slowly.
    //
    // So the counter to a shield is weight of fire, not a magic round type: you
    // drain its charge or you saturate its emitters, and only then does
    // anything reach the hull. Which is also what makes the facet read-out
    // worth looking at.
    const affordable = f.charge / CHARGE_COST;
    const absorbed = Math.min(joules, affordable);
    f.charge = Math.max(0, f.charge - absorbed * CHARGE_COST);
    const power = joules / Math.max(dwell, 1e-5);
    const spike = Math.min(SPIKE_MAX,
      1 + Math.pow(power / Math.max(f.coupling, 1), COUPLING_EXP));
    f.load += absorbed * spike;
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
      s.temp = Math.min(900, s.temp + sectionHeatDelta(s.def, joules));
    }
    const loops = new Set();
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
        loops.add(loop);
      }
    }
    for (const loop of loops) {
      loop.temp = Math.min(900, loop.temp + (joules * 1e-5) / loop.capacity);
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
        if (m.rounds > 0 && this.random() < 0.75) {
          this._cookOff(m, at);
        } else {
          this.events.push({ type: 'moduleKill', at, dir, module: m });
        }
        break;
      case 'computer':
        this.events.push({ type: 'computerKill', at, dir, module: m });
        break;
      case 'cargo':
        // What survives being blown about is what the parties can dig out.
        m.spares *= SPARES_SALVAGE;
        this.events.push({ type: 'moduleKill', at, dir, module: m });
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
    // Welding closes area, and what it costs is set by how thick the plate is —
    // not by how much hull the compartment happens to be worth. See WELD_PER_M2.
    const perM2 = WELD_PER_M2 * Math.max(s.def.wall, 0.05);
    s.breachSize = Math.max(0, s.breachSize - joules / perM2);
    if (s.breached && s.breachSize <= 0.02 && s.plateHp > s.plateMax * 0.25) {
      s.breachSize = 0;
      s.breached = false;
      s.venting = false;
      this.events.push({ type: 'patched', section: sectionId });
    }
    // Reframing, once the hull is shut. A buckled frame was permanent: nothing
    // in the game restored `frameHp`, so a compartment that took a heavy hit
    // stayed twice as slow to move through and counted against integrity for
    // the rest of the ship's life however many spares were in the lockers. It
    // is deliberately slow — shoring up structure is the longest job aboard —
    // but it is a job that finishes, which is what makes a mauled ship worth
    // nursing rather than writing off.
    if (!s.breached && s.frameHp < s.frameMax) {
      s.frameHp = Math.min(s.frameMax, s.frameHp + joules * FRAME_REPAIR_FRAC);
      if (s.frameBroken && s.frameHp > s.frameMax * 0.30) {
        s.frameBroken = false;
        this.events.push({ type: 'reframed', section: sectionId });
      }
    }
    return applied;
  }

  /**
   * Draw repair stock from any bay that still has some. A wrecked bay counts:
   * it lost most of what it held when it was hit (see `SPARES_SALVAGE`), and
   * what is left is lying in the compartment where anyone can pick it up.
   */
  takeSpares(n) {
    let got = 0;
    for (const m of this.modules.values()) {
      if (m.kind !== 'cargo' || m.spares <= 0) {
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
      if (m.kind === 'cargo') {
        n += m.spares;
      }
    }
    return Math.round(n);
  }

  // -- save and restore ------------------------------------------------------

  /**
   * Everything the last few minutes did to this ship, as plain data.
   *
   * The networks are not in it and must not be: `online` is derived from the
   * conduits' health by `_tickNetworks` at the top of every tick, so restoring
   * a stale copy would be overwritten a frame later at best and would disagree
   * with the conduits at worst. The same goes for the census. Anything the sim
   * recomputes from first principles is left to recompute.
   */
  snapshot() {
    return {
      self: captureState(this),
      sections: captureMap(this.sections),
      modules: captureMap(this.modules),
      loops: captureMap(this.loops),
      shield: captureState(this.shield),
      facets: captureRecord(this.shield.facets),
    };
  }

  restore(snap) {
    if (!snap) {
      return;
    }
    applyState(this, snap.self);
    applyMap(this.sections, snap.sections);
    applyMap(this.modules, snap.modules);
    applyMap(this.loops, snap.loops);
    applyState(this.shield, snap.shield);
    applyRecord(this.shield.facets, snap.facets);
    // Events are a queue between the sim and the renderer, not state. Anything
    // still in it belongs to the run that just ended.
    this.events.length = 0;
    this._tickNetworks();
  }

  // -- per-tick simulation ---------------------------------------------------

  tick(dt) {
    this._tickNetworks();
    this._tickPower(dt);
    this._tickAtmosphere(dt);
    this._tickFire(dt);
    this._tickThermal(dt);
    this._tickHoists(dt);
    this._tickModules(dt);
    this._tickShields(dt);
    this._tickArcing(dt);
    this._tickCasualty(dt);
    this._tickIntegrity();
  }

  /**
   * One widest-path search per network, seeded from every intact source and
   * spreading across every intact conduit. Edges are undirected because a cable
   * is: that is what makes a power *ring* survive one cut and fail on the
   * second, without a single line of ring-specific code.
   *
   * What a node carries away is a SERVICE LEVEL, not a yes or no. Every run has
   * a rating — main trunks carry the ship, emergency ties carry a fraction of
   * it — and a node's level is the best any surviving path can deliver, which
   * is the smallest rating along that path. Take out the trunk and the branch
   * does not go dark; it falls back onto the tie and everything on it runs
   * derated until somebody re-lays the main. That is how a warship is wired,
   * and it is the difference between "disrupted" and "destroyed".
   *
   * `online[net]` stays a Map keyed by node, so every `.has()` in the codebase
   * still asks the question it always asked; `.get()` is the new answer.
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
          reached.set(`src.${srcId}`, 1);
        }
      }
      // Levels only ever rise and are bounded by the run ratings, so this
      // settles in a couple of sweeps over a couple of dozen edges.
      let changed = true;
      while (changed) {
        changed = false;
        for (const c of this.conduits) {
          if (c.destroyed || c.def.net !== net) {
            continue;
          }
          const cap = c.def.cap * runService(c);
          if (cap <= 0) {
            continue;
          }
          const a = reached.get(c.def.from) || 0;
          const b = reached.get(c.def.to) || 0;
          const viaA = Math.min(a, cap);
          const viaB = Math.min(b, cap);
          if (viaA > b + 1e-6) {
            reached.set(c.def.to, viaA);
            changed = true;
          }
          if (viaB > a + 1e-6) {
            reached.set(c.def.from, viaB);
            changed = true;
          }
        }
      }
    }
  }

  /**
   * Service level reaching a module over one network, 0..1. A module wired to
   * a node nothing can supply reads 0; one running off an emergency tie reads
   * whatever that tie is rated for.
   */
  netLevel(m, net) {
    const node = m.def.needs && m.def.needs[net];
    if (!node) {
      return 1;
    }
    return this.online[net].get(node) || 0;
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
    let rated = 0;
    for (const m of this.modules.values()) {
      if (m.kind !== 'reactor' || m.destroyed || m.breached || m.detonated) {
        continue;
      }
      const health = clamp01(m.hp / m.maxHp);
      const heat = 1 - clamp01((m.temp - DERATE_TEMP_C) / (TRIP_TEMP_C - DERATE_TEMP_C)) * 0.8;
      m.eff = clamp01(health * heat);
      rated += m.def.output;
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
    //
    // `covered` is the honest question for bus voltage: did anything actually
    // go unsupplied this tick? Not "is demand above the reactor's steady
    // output", which is what the headroom term below used to ask. Those are
    // different questions and conflating them meant every machine aboard
    // quietly derated the moment the drives lit — a burn is a 150 MW transient
    // the capacitor is there to absorb, and while it is absorbing it the bus is
    // at voltage. The visible symptom was the sensor array losing reach
    // whenever the engines were used, which is not a thing that should happen
    // to a ship with a charged capacitor bank.
    let liveDemand = demand;
    let deficit = liveDemand - supply;
    let covered = true;
    if (deficit > 0) {
      const drawn = Math.min(this.capStore, deficit * dt);
      this.capStore -= drawn;
      covered = drawn >= deficit * dt - 1e-9;
      if (this.capStore <= 1e-6) {
        consumers.sort((a, b) => a.def.priority - b.def.priority);
        let shedTotal = 0;
        for (const m of consumers) {
          if (liveDemand - shedTotal <= supply) {
            break;
          }
          m.shed = true;
          shedTotal += m.drawNow;
        }
        liveDemand -= shedTotal;
        deficit = liveDemand - supply;
        covered = deficit <= 1e-9;
      }
    }
    if (deficit <= 0) {
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
    // Waste heat follows LOAD. `heatIn` reads `m.duty` and falls back to `m.eff`
    // when a module declares none — and for a reactor `eff` is its CONDITION,
    // not how hard it is working — so every intact plant made its full rated
    // heat forever, and a cruiser drawing 73 MW cooked exactly as hard as one
    // drawing 770.
    //
    // Measured against RATED output rather than against `supply`. Dividing by
    // the derated figure is a positive feedback loop — a hot plant supplies
    // less, which reads as a higher duty, which makes more heat — and it ran
    // the two big hulls down to half output with every projector shed. What a
    // plant is physically producing is `min(demand, supply)`; what it was built
    // for does not change when it gets hot.
    const output = Math.min(liveDemand, supply);
    const loadFactor = rated > 1e-6 ? clamp01(output / rated) : 0;
    for (const m of this.modules.values()) {
      if (m.kind === 'reactor') {
        m.duty = REACTOR_IDLE_DUTY + (1 - REACTOR_IDLE_DUTY) * loadFactor;
      }
    }

    const headroom = covered || liveDemand <= 1e-6 ? 1 : clamp01(supply / liveDemand);
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
      // No air, no fire. Fire is an INTERNAL problem — it lives on the
      // compartment's atmosphere, and a compartment open to space does not have
      // one for long.
      //
      // This cuts both ways and both are the point. A bay that is opened while
      // it burns keeps burning for as long as there is pressure behind the
      // hole, which is a real window on a big compartment with a small hole and
      // is exactly when flame is visible from outside — it roars out of the
      // wound and then gutters as the room empties. And a hull that has been
      // comprehensively opened cannot burn at all, which is why fire is a
      // problem of the ship's still-intact parts rather than a status the whole
      // wreck acquires.
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

      const loops = new Set();
      for (const m of this.modules.values()) {
        if (m.section !== s.id || m.destroyed) {
          continue;
        }
        m.temp = Math.min(900, m.temp + 60 * intensity * dt);
        // Heat also backs up into whatever loop runs through this bay.
        const node = m.def.needs && m.def.needs.coolant;
        const loop = node && this.loops.get(node);
        if (loop) {
          loops.add(loop);
        }
        if (m.def.critical) {
          continue;
        }
        // Only soft goods actually burn. Conduits are both the fuel and the
        // casualty, which is why a fire reliably costs you a network.
        if (m.def.mat === 'soft') {
          this.damageModule(m.id, m.maxHp * FIRE_BURN_FRAC * intensity * dt, null, null);
        } else if (m.kind === 'magazine' && this.random() < 0.18 * intensity * dt) {
          this._cookOff(m, null);
        } else if (m.kind === 'fuel' && this.random() < 0.10 * intensity * dt) {
          this.damageModule(m.id, m.maxHp * 0.4, null, null);
        }
      }
      for (const loop of loops) {
        loop.temp = Math.min(900, loop.temp + (FIRE_HEAT / loop.capacity) * intensity * dt);
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
          if (this.random() < 0.4) {
            this.ignite(nId, s.fire * 0.6);
          }
        }
      }
    }
  }

  /**
   * Starts a fire where there is something to burn and air to burn it in.
   *
   * The test is the AIR, not the hole, and the difference matters both ways. A
   * compartment holed a second ago still has its atmosphere and will catch — it
   * has to, or fire barely exists in a real engagement, because the round that
   * spills something flammable is usually the round that opens the bay. A
   * compartment that has been open long enough to empty cannot catch at all,
   * whatever is still on its deck, and that is the same rule arriving a few
   * seconds later.
   *
   * So "open to space, no fire" holds in the state that lasts, and the seconds
   * in between are the ones where flame is coming out of the wound.
   *
   * A compartment the crew have deliberately opened is never a candidate: they
   * vented it to stop exactly this.
   */
  ignite(sectionId, seconds = 8) {
    const s = this.sections.get(sectionId);
    if (!s || s.spill < 0.08) {
      return false;
    }
    if (s.venting || s.atmo < FIRE_MIN_ATMO) {
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
    for (const loop of this.loops.values()) {
      loop.leak = 0;
    }
    for (const m of this.conduits) {
      if (m.def.net === 'coolant' && m.hp < m.maxHp * COOLANT_TIGHT_FRAC) {
        const loop = this.loops.get(m.def.to);
        if (loop) {
          loop.leak = Math.max(loop.leak, m.def.leak);
        }
      }
    }
    // Fuel leaks pool as spill (and drain the tank), which is what a fire eats.
    for (const m of this.modules.values()) {
      if (m.kind !== 'fuel' || m.destroyed || m.store <= 0) {
        continue;
      }
      if (m.leakRate > 0) {
        const lost = Math.min(m.store, m.leakRate * FUEL_LEAK_RATE * dt);
        m.store -= lost;
        const s = this.sections.get(m.section);
        if (s) {
          s.spill = clamp01(s.spill + m.leakRate * 0.6 * dt);
        }
        // The bladder swells shut around the hole. A party still beats it by a
        // wide margin — `repairModule` zeroes this outright above 60% health —
        // but an unattended breach now stops instead of running the tank dry.
        m.leakRate = Math.max(0, m.leakRate - FUEL_SELF_SEAL * dt);
      }
      // Boil-off. Small, and it never stops.
      m.store = Math.max(0, m.store - FUEL_BOIL_OFF * dt);
    }

    for (const loop of this.loops.values()) {
      if (loop.leak > 0 && loop.level > 0) {
        loop.level = clamp01(loop.level - loop.leak * dt);
        if (loop.level <= 0) {
          loop.level = 0;
          // `leak` is deliberately NOT cleared here. It is the one flag that
          // says "there is still a hole in this", and `repairModule` is the
          // only thing entitled to clear it. Zeroing it on empty made a dry
          // loop and a mended one indistinguishable, which is what forced the
          // refill below to go asking the conduits instead — and that test
          // disagreed with the network: a dented-but-flowing run reported
          // `flow: 1` and carried coolant while still counting as holed, so
          // the loop sat at 0% for the rest of the run with nothing leaking
          // and everything circulating. The event still fires exactly once,
          // because the branch needs `level > 0` to run at all.
          this.events.push({ type: 'dryLoop', loop: loop.id });
        }
      } else if (loop.leak <= 0 && loop.level < 1) {
        // Charge a mended loop back up off the ship's make-up reserve. Without
        // this `level` was a one-way ratchet — the only writes anywhere were
        // the drain above — so one holed pipe cost a loop its coolant for the
        // rest of the run. The crew would dutifully weld the run, the network
        // read COOLANT 8/8, and the drives on that loop went on cooking to 700
        // degrees and latching offline against a loop sitting empty at ambient,
        // with nothing on any readout naming the reason.
        //
        // Gated on circulation rather than on the pipe: a loop fills through
        // its own pump, so a dead pump leaves it dry however much reserve is
        // aboard, and a run cut badly enough to stop flow stops the top-up too.
        const flow = this.online.coolant.get(loop.id) || 0;
        loop.level = clamp01(loop.level + LOOP_RECHARGE * flow * dt);
      }
      loop.heatIn = 0;
    }

    // Radiator capacity is a ship-wide pool: lose a panel and every loop cools
    // worse, which is the honest reading of a shared heat-rejection system.
    //
    // Two quantities out of one sweep, because they answer different questions.
    // `rejectCapacity` is ABSOLUTE area and drives how fast the loops shed —
    // bolt more panels on and the ship genuinely runs cooler. `rejectFraction`
    // is how much of the DESIGNED complement is still working, and that is what
    // shield dissipation is really about: "strip a ship's radiators and its
    // shields saturate" is a statement about losing them, not about how many it
    // was built with.
    //
    // Every hull happened to author its panels to a total of exactly 1.0, so
    // the absolute figure doubled as the fraction and the two uses were
    // indistinguishable — until the MERIDIAN and BASTION needed real panels
    // added to hold thermal equilibrium. That took the dreadnought's total to
    // 1.88 and, through this one number, very nearly doubled its shield
    // dissipation: its fore facet went from saturating under four lances in
    // 7.5 seconds to surviving four hundred. Cooling is not a shield buff.
    let reject = 0;
    let ratedReject = 0;
    for (const m of this.modules.values()) {
      if (m.kind !== 'radiator') {
        continue;
      }
      ratedReject += m.def.reject;
      if (!m.destroyed) {
        reject += m.def.reject * clamp01(m.hp / m.maxHp);
      }
    }
    this.rejectCapacity = reject;
    this.rejectFraction = ratedReject > 1e-9 ? reject / ratedReject : 0;

    for (const m of this.modules.values()) {
      if (m.destroyed) {
        // Wreckage still cools off; it just makes no more heat.
        m.temp = lerp(m.temp, AMBIENT_C, 1 - Math.exp(-0.25 * dt));
        continue;
      }
      const node = m.def.needs && m.def.needs.coolant;
      const loop = node ? this.loops.get(node) : null;
      // Flow, not merely connectivity: a loop fed through a cross-connect
      // circulates at whatever that tie is rated for.
      const flow = loop ? (this.online.coolant.get(node) || 0) : 0;
      // Heat in: duty-proportional, so a drive at 20 % throttle runs cool.
      const heatIn = m.def.heat * m.duty + m.heatAcc;
      m.heatAcc = 0;
      // Heat exchangers are sized to the load they were built for, so at design
      // duty every module settles at roughly the same temperature above its
      // loop regardless of whether it is a 34 MW fusion plant or a sensor mast.
      // That matters: it means a hot reading always signifies damage, an
      // overdriven duty cycle or a failing loop, and never merely "this is a
      // big ship". Losing flow costs a module its exchanger, not its radiator,
      // which is why cutting a pipe cooks one system and not the whole ship.
      const exchanger = clamp(m.def.heat * 0.00225, 0.18, 2.5);
      const coupling = loop ? exchanger * (0.12 + 0.88 * flow) * loop.level : 0.05;
      const toLoop = loop ? (m.temp - loop.temp) * coupling : 0;
      const toHull = (m.temp - AMBIENT_C) * 0.035;
      if (loop) {
        loop.heatIn += toLoop;
      }
      m.temp = clamp(m.temp + (heatIn * 0.09 - toLoop - toHull) * dt * 1.4, AMBIENT_C, 900);
    }

    for (const loop of this.loops.values()) {
      const up = this.online.coolant.get(loop.id) || 0;
      const out = (loop.temp - AMBIENT_C) * (0.35 + reject * 1.5) * loop.level
        * (0.15 + 0.85 * up);
      loop.temp = clamp(loop.temp + ((loop.heatIn - out) / loop.capacity) * dt * 1.4, AMBIENT_C, 900);
      if (loop.level <= 0.001) {
        // An empty loop carries nothing; it just sheds to the hull.
        loop.temp = lerp(loop.temp, AMBIENT_C, 1 - Math.exp(-0.7 * dt));
      }
    }
  }

  /**
   * Rounds up from the main magazine into the ready-use lockers at the mounts.
   *
   * The lockers hold well under a minute of fire each; everything else is deep
   * in the hull. What makes that a mechanic rather than bookkeeping is where it
   * can be interrupted — the hoist is the gun's power run, so one cut takes the
   * mount's training and its supply together and the gun fires until its locker
   * is empty and then stops. Losing the main magazine does the same thing to
   * every gun at once, slowly.
   */
  _tickHoists(dt) {
    for (const m of this.modules.values()) {
      if (m.kind !== 'magazine' || !m.def.deep || m.destroyed) {
        continue;
      }
      const want = m.def.rounds - m.rounds;
      if (want <= 0) {
        continue;
      }
      const deep = this.modules.get(m.def.deep);
      if (!deep || deep.destroyed || deep.rounds <= 0) {
        continue;
      }
      // A partly-served bus lifts proportionally slower, same as everything
      // else on the run: a hoist on an emergency tie is a hoist on half power.
      const up = m.def.hoist ? (this.online.power.get(m.def.hoist) || 0) : 1;
      if (up <= 0) {
        continue;
      }
      const lift = Math.min(want, deep.rounds,
        (m.def.rounds / HOIST_FILL_SECONDS) * up * dt);
      m.rounds += lift;
      deep.rounds -= lift;
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
      // What its feeder can actually deliver. A module running off an emergency
      // tie rather than its main trunk works, and works badly — which is the
      // whole point of having the tie.
      const feed = this.netLevel(m, 'power');
      m.eff = clamp01(health * heat * volts * feed);
    }

    // The computer cooks itself if its loop boils — a real alternative to
    // putting a slug through the bridge. Slow on purpose: it reads as a gauge
    // climbing, not a switch flipping.
    for (const m of this.modules.values()) {
      if (m.kind !== 'computer' || m.destroyed) {
        continue;
      }
      if (m.temp >= COMPUTER_LATCH_C && !m.latched) {
        m.latched = true;
        // It really did cook. Leaving health alone and setting a flag is what
        // made this unrecoverable: there was nothing for the crew to mend.
        m.hp = Math.min(m.hp, m.maxHp * COMPUTER_COOKED_HP);
        this.events.push({ type: 'computerThermal', module: m });
      } else if (m.latched && m.temp < DERATE_TEMP_C
                 && m.hp > m.maxHp * COMPUTER_REBOOT_HP) {
        // Cool, and mended far enough to trust with the helm again.
        m.latched = false;
        this.events.push({ type: 'computerReset', module: m });
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
    // Fraction, not absolute area — see `rejectFraction`. A hull's dissipation
    // is set by its own shield capacity and by how much of its heat-rejection
    // system survives, never by how many panels its designer chose to fit.
    const dissipTotal = (cap * DISSIPATION_BASE_FRAC
      + (this.rejectFraction || 0) * cap * DISSIPATION_PER_RADIATOR_FRAC) * clamp01(gen);
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
    const budget0 = this.hull.shield.regen * clamp01(gen) * dt;
    let budget = budget0;
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

    // Bill the power system, and the coolant loops, for WORK — not for standing
    // there with the field lit.
    //
    // The old model charged by how much field you were holding, so a full,
    // quiet, undamaged shield was the most expensive thing on the ship: 407 MW
    // of a cruiser's 770 MW rating, forever, plus the entire recharge bill
    // whether or not a single joule was actually being put back. The projectors
    // also declare the largest heat load aboard — 1360 units on the MERIDIAN,
    // more than both reactors — and nothing scaled it, because `shieldGen` is
    // not a duty kind and `heatIn` therefore fell back to `eff`.
    //
    // Together those meant an undamaged cruiser parked with its shields up
    // could not hold a steady state: it settled at 98 C, derated its own
    // reactors to two thirds of rating, and shed the amplifiers that set its
    // shield ceiling — silently, because charge and ceiling fall together and
    // the HUD reads their ratio.
    //
    // Maintaining status is cheap now. WORKING is what costs: pulling a drained
    // facet back up, and channelling what the emitters are absorbing. So the
    // strain arrives when weapons, drives and a shield under fire compete for
    // the same plant, which is the moment it should.
    const deficit = 1 - clamp01(facets.reduce((a, f) => a + f.charge, 0)
      / Math.max(facets.length * Math.max(target, 1), 1e-9));
    const channelling = this.shieldLoadFraction();
    const work = clamp01(Math.max(deficit, channelling));
    const duty = SHIELD_HOLD_DUTY + (1 - SHIELD_HOLD_DUTY) * work;
    // Only what the recharge pool actually spent this tick, so a topped-up
    // field pays nothing to stay topped up.
    const spent = Math.max(0, budget0 - budget);
    const rechargeMW = ((spent / Math.max(dt, 1e-6)) / RECHARGE_EFF) * 1e-6;
    // Split between the projectors that are actually doing the recharging, and
    // paid by exactly those. Dividing by `projectors.length` while charging
    // every shieldGen aboard bills the ship more than the pool ever spent — on
    // a cruiser with one crippled amplifier and two sound ones that is 1.5x the
    // real cost, and it lands hardest in precisely the degraded states the
    // graded-service model exists to represent.
    const inPool = new Set(projectors);
    const share = projectors.length > 0 ? rechargeMW / projectors.length : 0;
    for (const m of this.modules.values()) {
      if (m.kind !== 'shieldGen') {
        continue;
      }
      // Holding load and waste heat are a property of the fitting being lit;
      // the recharge bill belongs only to the emitters doing the work.
      m.duty = duty;
      m.drawNow = m.def.draw * duty + (inPool.has(m) ? share : 0);
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
      if (!c.destroyed || c.def.net !== 'power' || this.random() > ARC_CHANCE * dt) {
        continue;
      }
      const victims = [];
      for (const m of this.modules.values()) {
        if (m.destroyed || m.def.critical || m.section !== c.section || m.kind === 'conduit') {
          continue;
        }
        // Not the ordnance. This routine promises above that it "degrades a
        // ship without ever finishing one", and a magazine is the one fitting
        // aboard whose destruction does exactly the opposite: a cook-off dumps
        // its whole stowed charge into the compartment, wrecks the frame from
        // inside and takes everything sharing the space with it.
        //
        // Left in, a severed cable had a few per cent chance per engagement of
        // detonating a magazine entirely on its own — measured at 2.8% of runs
        // over four hundred trials, costing up to 13% of the hull with no round
        // fired at it. That is not a secondary effect, it is a coin flip
        // deciding the fight, and it is exactly what the exclusion for
        // `critical` modules exists to prevent.
        //
        // Fire still reaches ordnance: `ignite` below is untouched, and a
        // burning magazine cooks off through the thermal model where the crew
        // have a chance to fight it.
        if (m.kind === 'magazine') {
          continue;
        }
        victims.push(m);
      }
      if (victims.length > 0) {
        const v = victims[Math.floor(this.random() * victims.length)];
        this.damageModule(v.id, v.maxHp * ARC_DAMAGE_FRAC, null, null);
      }
      // An arc next to spilled fuel is one of the two ways a fire starts.
      if (this.random() < 0.35) {
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
        if (this.random() < 1.4 * dt) {
          this.ignite(m.section, 10);
        }
      }
      // Most breaches scram. A reactor that genuinely lets go is meant to be a
      // payoff, not the default end of every fight — put another round in it if
      // you want to be sure.
      if (m.breachT > 2.4) {
        m.breached = false;
        if (this.random() < BREACH_DETONATE_CHANCE) {
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

  /**
   * Is there a working computer with power and a helm data link?
   *
   * ANY of them. The check is per-module because the latch is: a ship that
   * carries an auxiliary carries it precisely so that cooking or losing the
   * bridge machine is survivable, and a ship-wide flag threw that away.
   */
  get flightComputer() {
    if (!this.online.data.has('d.helm')) {
      return false;
    }
    for (const m of this.modules.values()) {
      if (m.kind === 'computer' && !m.latched && !m.destroyed && m.eff > 0.15) {
        return true;
      }
    }
    return false;
  }

  /** True when every computer aboard is cooked. For the read-outs. */
  get computerLatched() {
    let any = false;
    for (const m of this.modules.values()) {
      if (m.kind === 'computer' && !m.destroyed) {
        any = true;
        if (!m.latched) {
          return false;
        }
      }
    }
    return any;
  }

  /**
   * The bunker a drive can actually draw from: its own if it still holds
   * anything, otherwise any other bunker aboard that does.
   *
   * Warships run a transfer main between their bunkers, and without one modelled
   * here a single round through one tank cost a hull half its thrust for the
   * rest of the run while the other tank sat full — the drive was hard-wired to
   * `def.fuel` and nothing ever looked past it. A drive is fed by the ship, not
   * by one box.
   */
  fuelFor(drive, min = 0) {
    const own = this.modules.get(drive.def.fuel);
    if (own && !own.destroyed && own.store > min) {
      return own;
    }
    for (const m of this.modules.values()) {
      if (m.kind === 'fuel' && !m.destroyed && m.store > min) {
        return m;
      }
    }
    return null;
  }

  /** 0..1 main drive authority, weighted by each drive's share of the total. */
  driveAuthority() {
    let acc = 0;
    let share = 0;
    for (const m of this.modules.values()) {
      if (m.kind !== 'thruster') {
        continue;
      }
      const fuelOk = this.fuelFor(m, 0.5) ? 1 : 0;
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

  /**
   * The best picture anything aboard can still produce.
   *
   * `gain` is the aperture: a main array is 1, an auxiliary is a smaller dish
   * fitted deep in the hull as a fallback and reads correspondingly less. Taking
   * the maximum rather than a sum is deliberate — two arrays do not see further
   * than the better one, they just mean losing the mast is no longer the end of
   * the ship's ability to fight.
   */
  sensorQuality() {
    let best = 0;
    for (const m of this.modules.values()) {
      if (m.kind === 'sensor' && this.hasData(m)) {
        best = Math.max(best, m.eff * (m.def.gain !== undefined ? m.def.gain : 1));
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
    if (!this.shield.up) {
      return 0;
    }
    let charge = 0;
    let max = 0;
    for (const f of Object.values(this.shield.facets)) {
      charge += f.charge;
      max += f.max;
    }
    return max > 0 ? clamp01(charge / max) : 0;
  }

  /**
   * Charge against the field this hull is RATED for, not against the ceiling it
   * happens to have left.
   *
   * `shieldFraction` divides by the current maximum, and killing a projector
   * lowers that maximum — so charge and ceiling fall together and the ratio
   * stays pinned near 1. A ship that had lost the amplifiers setting a third of
   * its shield still reported a full shield. Anything a player reads to decide
   * whether to keep taking hits on this side needs the honest denominator.
   */
  shieldRated() {
    if (!this.shield.up) {
      return 0;
    }
    const cap = this.hull.shield.capacity;
    if (!(cap > 0)) {
      return 0;
    }
    let charge = 0;
    for (const f of Object.values(this.shield.facets)) {
      charge += f.charge;
    }
    return clamp01(charge / cap);
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

  /** Open hull, in square metres, across every breached compartment. */
  breachArea() {
    let a = 0;
    for (const s of this.sections.values()) {
      if (s.breached) {
        a += s.breachSize;
      }
    }
    return a;
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
      // Cold and dark: no plant, and nothing the banks can still reach.
      //
      // Charge STRANDED behind a dead distribution network is not a capability.
      // With no source seeded, no node is online, so every consumer fails
      // `_netsOk`, demand collapses to zero and the capacitor stops draining —
      // it simply sits there at whatever it held. Nothing can draw on it (a gun
      // needs `eff`, and `eff` is zero without a live node), so a hull with a
      // wrecked plant and a half-full bank is finished whatever the meter says.
      // This used to pass only by luck: the bank happened to be flat already
      // because the last surviving plant had been running a deficit into it.
      || (this.supply <= 0.4
        && (this.online.power.size === 0 || this.capStore <= this.capMax * 0.02));
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
