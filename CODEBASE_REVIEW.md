# Codebase review

Date: 2026-08-12 (second full pass)
Reviewed at: commit bab9811
Supersedes: the 2026-08-12 first-pass review and its implementation tracker
(see git history). That document's claims were treated as unverified input to
this one, and several of its "completed" items turn out to be partial — see
"The prior review, re-checked".

## Method

Seven parallel domain reviews (physics/flight, interior systems, weapons/combat,
lifecycle/main loop, AI/crew, browser/UI/effects, tests/tooling/build), each
reading its files in full at bab9811. Every finding marked **CONFIRMED** was
demonstrated by running the real modules headlessly — `node -e` against the
actual `Systems`/`Ballistics`/`Body`/`Pilot`/`FX` with no renderer — and each
P0, plus the headline P1s, was then re-reproduced independently of the reviewer
that found it. Findings that could not be demonstrated without a browser are
marked **SUSPECTED** and carry exact repro steps. Where two reviewers
disagreed, the measurement won (see F-07's note).

Numbering is fresh (F-nn); the old R-nn identifiers appear only when
cross-referencing the prior document.

## Executive summary

The headline result is inverted from the first pass: the physics fixes, the
lifecycle rewrite, and the resource-ordering fixes all genuinely hold — and the
worst defects now live in the two places the first pass called sound or never
measured: the interior power/thermal model and the AI's fire-control gates.

The four P0s, all confirmed by measurement:

1. **Any friendly round detonates allied ordnance in flight.** The intercept
   test checks ownership but not faction, so a broadside fired past a wingman's
   torpedo salvo sets it off and the blast damages the fleet (F-01).
2. **Load shedding deadlocks the capacitor bank and derates the bus forever.**
   Shed load is never subtracted from demand, so the recharge branch is
   unreachable: a MERIDIAN with 5.5 MW of genuine headroom holds its bank at
   0.000 MJ and its bus at 64% indefinitely (F-02).
3. **Idle modules draw 15% of rated power but make 100% of rated heat.**
   `duty` is uninitialised and its two consumers disagree about the default. A
   parked, untouched BASTION sits with both main drives at 94 °C — one degree
   under thermal derate (F-03).
4. **Repairing any one coolant feed seals a loop that another severed run is
   still holed into.** The leak is a latched scalar cleared outright by
   `repairModule`; mending the cheap emergency tie first (the natural repair
   order) stops the leak while the main run sits destroyed (F-04).

The most consequential P1s: torque-free rotation is unconditionally unstable
and reaches NaN inside a normal run's length on a derelict (F-05); the AI's
fixed-gun trigger contradicts its own commanded aspect, so the wave-1 and
wave-2 enemy fires 7.3× fewer rounds than its mounts are laid for (F-06);
per-shot weapon heat is integrated as if it were a rate, delivering 1/60 of the
authored figure and making five of six weapons thermally inert (F-07); a beam
spends 230% of its own energy budget once a plate is open (F-08); and a
lost-pointer-lock retry can strand the player in a running game with no mouse
and no visible way back (F-14).

None of this is visible to the test suite, and three findings explain why: the
suite has zero coverage of shot-versus-ship ray resolution (F-19), only the
unseeded fallback branch of the new RNG plumbing ever runs under test (F-20),
and at least one regression assertion is vacuous — its guard short-circuits
before the check it exists to make (F-21).

## The prior review, re-checked

Claims verified genuinely fixed and correct, by rerunning or re-deriving:

- **R-01** heat NaN: fixed. A 144-trial randomised damage fuzz across all four
  hulls (3000 ticks each, every field sampled) produced no NaN or Infinity
  anywhere in `Systems`.
- **R-02/R-03/R-04/R-06** Euler sign, COM impulse, single collision impulse,
  COM-relative radii: all re-derived and re-measured correct. Impulse at
  `body.pos` produces |ω| = 0; measured restitution is exactly 0.25 at 1:1 and
  40:1 mass ratios; dissipated energy matches ½µv²(1−e²) to six figures.
- **R-05** resource ordering: all four firing paths check before consuming;
  ammunition is the last gate everywhere.
- **R-07** seekers: launch targets route through `_acquire`; the cone is
  enforced on acquisition and retention.
- **R-08/R-23** lifecycle: the disposal hunt comes up clean. All three
  `_disposeShip` call sites either iterate a copy or drain a retired list;
  no reachable disposal-during-iteration exists.
- **R-09** sim-time: fixed. The only surviving `performance.now()` in the sim
  path is the beacon strobe, which the recommendation explicitly carved out.
- **R-15/R-28** determinism: real. 893 assertions, identical count and all-pass
  at seeds 1729, 7, 99, 424242, 99991. The suite's `Math.random` override lands
  before any construction, so even the fallback branches are seeded under test.
- **R-12/R-14/R-31**: `npm audit` 0 vulnerabilities including dev; CI exists;
  no source maps in dist.
- **R-18** inactive-frame throttling: works, except the resize path (F-28).
- **R-27**: the code matches `docs/power-units.md` everywhere it was checked —
  capacitor recharge is MW×dt into MJ, beam draw is MW×dt, discrete draw is
  MJ/shot. The `draw` field's double meaning remains open by design.

Claims marked done that are partial or wrong:

- **R-10** (pointer-lock recovery): the *ordering* is fixed — play starts only
  from `onLockChange(true)` — but failure reporting writes into an element
  that is hidden in every state where failure matters, and the message never
  clears (F-14, F-26).
- **R-11** (keyboard access): buttons are real buttons, but no overlay moves
  focus on open, the page behind is not inert, and the game-over card has no
  focusable control and no live region (F-30).
- **R-13** (smoke fails closed): the exit code landed; the `finally` did not —
  a failed `goto` leaks a headless Chromium (F-33).
- **R-17** (DPR canvases): the resize routine is correct but only runs while
  the target-diagnostics panel is hidden, leaving its cutaway a 1×1 backing
  store for the whole session (F-16).
- **R-19** (HUD layout thrash): not fixed. The per-frame
  `getBoundingClientRect` after DOM writes is exactly where the finding left
  it, and `diagnostics.js` adds a per-frame `innerHTML` read-back (F-27).
- **R-20** (reduced motion): coverage is done, but the preference is sampled
  once and never followed; toggling it mid-session does nothing (F-29).
- **R-21** (fatal-error path): only the smoke-check half landed. `game.init()`
  runs bare; a throwing frame reschedules itself forever (F-25).
- **R-22** (no-build server): pinned and loopback-bound, but it serves the
  repository root — `/.git/config` returns 200 — and the README's "no
  installation" wording it flagged is still there (F-34).
- **R-30** (stale docs): README and CLAUDE.md still claim "about a second" for
  a suite that measures 6.75 s, and README quotes an assertion count two
  releases stale (F-38).
- The old document's own text: `crew.js` is at `src/ship/crew.js`, not
  `src/crew/crew.js` as R-25 had it.

## Verification performed

- `node test/selfcheck.js`: 893 assertions pass at five seeds.
- `npm run typecheck:hull` and `npm run build`: clean.
- Headless browser smoke of both serving paths (production preview with CSP,
  no-build static): zero console/page errors; screenshots inspected.
- Randomised `Systems` fuzz: 4 hulls × 12 trials × 3000 ticks, no non-finite
  values.
- Every P0 and headline P1 reproduced twice: once by the domain reviewer, once
  independently from the report alone.

---

## P0 — fix before anything else

### F-01: Friendly fire detonates allied ordnance

**Status:** CONFIRMED (repro run twice)
**Locations:** src/weapons/ballistics.js:567-587 (`_interceptedMissile`), used
at :669-674; compare src/ship/ship.js:548 (`_pdThreat`, which gets it right)

`_interceptedMissile` skips a missile only when `m.owner === owner`. The
point-defence *director* that selects targets already skips same-faction
ordnance; the geometric intercept that actually kills it does not. So every
bolt any ship fires along a bearing passing within `interceptR` of an allied
missile detonates it — the 4.5e8 J torpedo blast then runs through
`Game.explode`, which damages all ships regardless of faction. The shooter is
even credited with the kill.

Measured: a friendly bolt fired down the path of a friendly torpedo removes it
and attributes the blast to the shooter.

The selfcheck at test/selfcheck.js:2509-2512 asserts "you cannot shoot down
your own ordnance" with stubs that carry no `faction` field, so it passes while
covering nothing.

**Fix:** match `_pdThreat`'s rule — skip when the owner is the same ship OR the
same faction. Give the selfcheck stubs factions in the same change, or the
regression stays invisible.

### F-02: Load shedding permanently deadlocks the capacitor and derates the bus

**Status:** CONFIRMED (repro run twice)
**Locations:** src/ship/systems.js:1183-1217, :1242-1244

`deficit = demand - supply` uses `this.demand`, the sum of every consumer's
`drawNow` including shed modules — nothing subtracts shed load. Once shedding
starts, the deficit stays positive forever: the recharge branch is unreachable,
`covered` is permanently false, and `busQuality` lerps against the phantom
demand, derating every surviving module ~37% on a bus that is actually fully
supplied. `isStricken`'s flat-bank clause is satisfied by a bank this bug pins
at zero — the comment at :2141 describes this failure as the reason the check
"works".

Measured: MERIDIAN loses its primary plant; post-shed live load is 60.0 MW
against 65.5 MW supply — real headroom — and the bank reads 0.000 MJ with bus
0.64 five simulated minutes later.

**Fix:** compute the shed total in the same pass and drive the recharge branch,
`covered`, and `busQuality` from live (unshed-excluded) demand. Decide
explicitly which figure the HUD's demand read-out wants (see F-45).

### F-03: Idle duty-modules draw 15% of rated power but make 100% of rated heat

**Status:** CONFIRMED (repro run twice)
**Locations:** src/ship/systems.js:347-356 (state literal, no `duty`),
:1163-1165 (`m.duty || 0` → idle), :1501 (`m.duty !== undefined ? m.duty :
m.eff` → full)

`duty` is never initialised, and the two consumers disagree about what absence
means: the power tick reads it as 0 (idle), the thermal tick falls back to
`eff` (1 on a healthy module). An untouched thruster, RCS block or mount is
idle on the bus and at full throttle in the thermal model, contradicting both
governing comments.

Measured: a parked, undamaged, never-fired BASTION reaches 94 °C on both main
drives — one degree below `DERATE_TEMP_C`. In-game the defect surfaces on the
first tick and after every snapshot restore (F-46); under test it is
permanent, so the suite's thermal-equilibrium assertions measure a ship at
full drive duty, not at idle.

**Fix:** add `duty: 0` to the module state literal and delete the `m.eff`
fallback at :1501 — with `duty` always present the fallback is dead and it is
the only source of disagreement.

### F-04: Mending one coolant feed seals a loop another severed run still leaks

**Status:** CONFIRMED (repro run twice)
**Locations:** src/ship/systems.js:915-921 (`repairModule`), :791-801 (`_leak`)

`loop.leak` is a single latched scalar per loop, written with `Math.max` from
any feeding conduit — but `repairModule` clears it outright once *the conduit
being repaired* is tight. Every hull authors loops with two or three feeds, and
the emergency tie is always the cheapest module to mend, so the natural repair
order (tie first) stops the leak while the main run sits at 0 hp, severed.

Measured: SABRE with both `l.aft` feeds burst drains to 20%; mending only the
tie sets `leak = 0` and the loop refills to 33% and climbing with the main run
still destroyed.

**Fix:** derive `loop.leak` from conduit state each tick (max over feeds below
`COOLANT_TIGHT_FRAC`) and delete the `repairModule` special case. This also
fixes the two-holes-leak-at-the-worse-rate asymmetry.

---

## P1 — high-impact correctness

### F-05: Torque-free rotation is unconditionally unstable and reaches NaN

**Status:** CONFIRMED (repro run twice)
**Location:** src/ship/flight.js:165-191

The gyroscopic term is integrated with explicit Euler, which multiplies the
precessing components by √(1+(λ·dt)²) every step — growth at every step size,
compounding because λ grows with ω. World-frame |L| must be constant for a
torque-free body; here it doubles on timescales inside a normal run.

Measured: SABRE (inertia ratio ~16:1) at ω = (1.5, 0.2, 0.3) rad/s with zero
torque reaches NaN in 360 simulated seconds; at (0.6, 0.1, 0.3), NaN by
1200 s. The NaN propagates silently through quat → pos → targeting → HUD.

Reachable in play: a derelict (drives and computer gone) has no assist damping
and no RCS, is a pure torque-free body for the rest of the run, and every hit
adds spin. Ships that die outright are retired at 6.5 s and are safe.

**Fix:** integrate the gyroscopic term with midpoint/RK2, or rescale ω after
the update to conserve world-frame |L| (one normalisation, analogous to the
existing `quat.normalize()`). A bare |ω| clamp hides the NaN but keeps the
momentum wrong.

### F-06: The AI's fixed-gun trigger contradicts its own commanded aspect

**Status:** CONFIRMED (repro run twice)
**Locations:** src/ship/ai.js:574 (trigger gate), :468 (`_aimCos`);
src/ship/hulls.js:259,290 (`fightAspect` one-sided sweep)

Two defects that are only harmful together. `_engage` gates trigger 0 on the
nose being within ~0.5–1° of the lead point — but `_steer` is simultaneously
told to hold the nose `fightAspect` degrees *off* the target. And
`fightAspect` itself is wrong for three of four hulls: the sweep covers
[0, π] only, so a bow battery's symmetric full-weight band [-8°, +8°] is seen
as [0°, 8°] and reported as its midpoint 4° — an artefact. Only MERIDIAN's 63°
is real.

Measured over 60 s of ENGAGE at preferred range: SABRE's mounts bear 100% of
the time, its trigger is held 2.6% of the time, and it fires 701 rounds where
1508 five thousand are available (7.3× fewer). HALBERD: 3.4× fewer. These are
the wave 1–8 enemies; their effective firepower is a fraction of what the hull
tables say.

**Fix:** (a) gate trigger 0 on the mounts, not the hull attitude — the same
shape as `_turretsBear()`, e.g. `fireGroups[0].some((m) => onTarget(m,
target))` — which deletes `_aimCos` and the `cos` plumbing; and (b) fix
`fightAspect` to sweep symmetrically or return 0 when the winning band starts
at zero, so three hulls stop flying 3–4° off a bearing for no reason.

### F-07: Per-shot weapon heat is integrated as a rate; five of six weapons are thermally inert

**Status:** CONFIRMED by measurement
**Locations:** src/ship/ship.js:1485, :666 (deposit); src/ship/systems.js:1501-1517 (consumption)

`heatAcc` is added to a per-second rate and then multiplied by dt. That is
correct for the beam (which deposits every frame; measured step-independent at
71.66 °C rise regardless of timescale) and wrong for every projectile weapon,
whose single-shot deposit is scaled by dt: the round delivers 1/60 of its
authored heat at normal speed, less at slow timescales.

Measured: 120 s of maximum-rate railgun fire raises its mount 0.81 °C against
an authored 320-per-shot figure; `TRIP_TEMP_C` is unreachable for railgun,
repeater, autocannon, ion projector and both ordnance mounts. Overheat and
derate exist only for the lance.

Note: a prior draft of this finding claimed the *beam* was timescale-dependent
by reading the same lines; measurement shows it is not. The defect is only in
the discrete-shot path.

**Fix:** deposit `w.heat / dt` for discrete shots (making the deposit
step-independent and the authored numbers meaningful), or convert projectile
`heat` to per-second figures scaled by firing rate. `updateWeapons` and
`_pointDefence` must agree.

### F-08: A beam spends 230% of its own output once the plate is open

**Status:** CONFIRMED
**Location:** src/weapons/ballistics.js:996-1021

The two-way split at :988-995 carefully sums to 1.0 of the delivered budget
(0.55 section + 0.45 heat), with a comment explaining why spending it twice is
wrong. The breach branch then adds `damageModule(…, joules * bite * 1.3)` on
top — an additional 130% of the same joules. A lance does 100% against an
intact compartment and 230% against a breached one.

**Fix:** make the module term part of the split (e.g. 0.35/0.30/0.35 when
breached), not an addition.

### F-09: A gun with its fire-control link cut is reported dead and fires anyway

**Status:** CONFIRMED by reading (three sites, two behaviours)
**Locations:** src/ship/ship.js:1437 (`live`, no data term), :1352
(`mountFault` → 'NO LINK'), :618 (point defence, has the data term);
src/ship/systems.js:477-481 (`hasData`'s stated contract)

`hasData`'s comment says a linkless gun drops to boresight, and `_aimMount`
implements that. But `updateWeapons` never checks it, and once the aim has
converged on the rest bearing `_bears` is true — so the mount empties its
magazine along boresight at full rate while `mountFault` reports 'NO LINK' and
the HUD paints the whole group dead. Point defence takes the opposite reading
and genuinely stops.

**Fix:** pick one interpretation. Given the comment and `_aimMount`, gunnery's
behaviour is intended: `mountFault` should report 'BORESIGHT' (or nothing)
rather than a fault, and not ahead of NO AMMO / NO CHARGE, which it masks.

### F-10: The "you got inside" hit marker is unreachable from gunfire

**Status:** CONFIRMED
**Locations:** src/weapons/ballistics.js:866, :930, :947-952; src/ui/hud.js:132-136

`_announce` fires once per resolved path, and the wall crossing always
announces first with `internal = false`. Since every externally-fired round
crosses a wall before reaching a module, the internal marker (`_hitKind = 2`)
is dead code.

**Fix:** announce the deepest layer reached — record the escalation during the
walk and announce once at path end.

### F-11: Coolant loops are heated once per module in the compartment naming them

**Status:** CONFIRMED
**Locations:** src/ship/systems.js:773-788, :1323-1333

Both `injectHeat` and the fire tick add heat to a loop inside the per-module
walk, multiplying the deposit by however many fittings in that compartment
name the loop — 7× between MERIDIAN's spine and reactor room for the same
joules — and double-counting against the direct module-heating path.

Related, same pass: `FIRE_HEAT`'s comment claims "degrees/s into the local
loop"; the code divides by loop capacity (170–6600), so a full-intensity spine
fire heats `l.core` at 0.8 °C/s, not 165 — and 0.11 °C/s once the 7× is
removed. The loop-heating path is close to decorative; the direct module term
is what actually costs kit. Per CLAUDE.md, measure and re-comment.

**Fix:** accumulate distinct loops for the section and deposit once per loop.

### F-12: `shieldFraction()` reports 1.0 on a ship with every projector destroyed

**Status:** CONFIRMED
**Locations:** src/ship/systems.js:2016-2024, :2036-2046, :1639-1640

With `gen = 0`, `f.max` floors at 35% of base and residual charge clips to it,
so charge/max reads 1.000 while `damageShield` passes 100% of every joule
through. This is the exact failure `shieldRated`'s docstring says it exists to
fix, and it is half-fixed: `shieldRated` reads 0.350 on a shield that is off.

**Fix:** gate both read-outs on `shield.up` (or fold `clamp01(gen)` in, as
`coupling` already does).

### F-13: Collision de-penetration ignores mass

**Status:** CONFIRMED
**Location:** src/ship/flight.js:455-457

The velocity impulse is invMass-weighted; the positional push is split 50/50.
A 4.1 kt SABRE grazing a 166 kt BASTION teleports the capital ship half the
overlap sideways in one frame — and the overlap is measured on bounding
spheres far larger than the hulls (F-42), so it happens at range. Shown one
frame late, too: `_syncVisual` (priority 30) runs before collide (40).

**Fix:** weight the push by `invMass / (a.invMass + b.invMass)` — one line each.

### F-14: A rejected pointer-lock on retry strands the player in a running game

**Status:** CONFIRMED (code path) / SUSPECTED (browser precondition)
**Locations:** src/main.js:317-322, :331-338; src/core/input.js:112-133;
index.html:598, 653, 661

`_resumePlaying` clears `over` and hides the game-over card *before* the lock
result is known, and `requestLock` routes rejection to a message written into
`#startStatus` — which lives inside the hidden splash. The precondition is
documented in input.js's own comment: Chrome rejects a request arriving too
soon after an Esc-driven exit, and the game-over path calls `exitLock()`
moments before the player presses R. Result: sim running, no pointer lock, no
visible control that can request one; only recovery is a reload — the exact
cost `retryWave` exists to remove.

**Fix:** make the lock the trigger, not the assumption: clear `over` from
`onLockChange(true)`, or on `onLockError` re-show the pause card, which has a
working resume button. Same hole exists for `newRun`.

### F-15: The recorded RNG seed cannot be replayed by anything

**Status:** CONFIRMED
**Locations:** src/main.js:87; src/core/trace.js:175;
src/weapons/ballistics.js:103, src/ship/systems.js:311, src/ship/ai.js:69

Every trace dump records `game.random.seed`, but `seededRandom()` is only ever
called with no argument (seed = Date.now), and no code path — URL, env,
console — injects a seed back in. Worse, three subsystems alias `game.random`
into a field at construction, so even a console reseed leaves `Ballistics` and
the player's `Systems` on the old stream. And honestly: replay would also need
identical step counts and inputs, which nothing records. The plumbing is in;
the entry point that makes it worth having is not.

**Fix:** accept `?seed=` at boot (one line), have subsystems read
`game.random` at call time, and document in trace.js what the seed does and
does not reproduce.

### F-16: The target damage-control cutaway renders into a 1×1 canvas all session

**Status:** CONFIRMED by code path (visual repro: lock a target, compare panels)
**Locations:** src/ui/diagnostics.js:111-137, :420-428; src/main.js:123-124, :160

`resize()` is correct but only runs from the constructor and `_onResize`, and
both panels start `display:none` — rect all zeros → 1×1 backing store. The
player's own panel is rescued by init ordering (unhidden before the resize);
the target panel is unhidden later from the frame loop, which never resizes.
Its cutaway — the feature the splash advertises — is one stretched pixel until
the window happens to be resized (which is the tell).

**Fix:** resize on `setShip` when transitioning to shown, or a ResizeObserver
on the canvas (also covers the `--diag-w` breakpoint).

### F-17: `#hudPip.hidden` matches no CSS rule; the empty target-view frame is always on screen

**Status:** CONFIRMED (verified against the stylesheet twice)
**Locations:** index.html:549 (markup), :296/:375/:465 (the only three
`.hidden` rules, all scoped); src/ui/hud.js:381

The stylesheet defines `display:none` only for `.dcpanel.hidden`,
`.diag-*.hidden` and `.overlay.hidden`. `#hudPip` is none of these, so the
toggle does nothing: an empty 260×156 bordered box with an em-dash caption is
painted top-right from the first frame, on the splash, while paused, and after
game over.

**Fix:** add `#hudPip.hidden { display: none; }` (or introduce the shared bare
rule and let all four users converge on it).

### F-18: `FX.clear()` leaves ghost particles that reappear with the next effect

**Status:** CONFIRMED empirically (headless probe against real three.js)
**Locations:** src/fx/fx.js:1157-1181 (`clear`), :960-962, :992, :1026

`clear()` zeroes lifetimes but not the GPU-side attribute arrays, and the
update loop skips dead slots before the branch that zeroes them. Draw range
collapses while pools are empty — but it is all-or-nothing, so the first new
particle re-draws every stale slot frozen at its old position. Measured: 315
stale particle slots and 72 stale smoke puffs survive a clear and return with
the next muzzle flash. Smoke is normal-blended, so the ghosts occlude.

Failure: lose a wave, press R — the fireball you died to snaps back into the
sky. The streak pool already does this correctly (dead branch runs
unconditionally); the two point pools need the same shape, or `clear()` should
zero `pSize`/`pCol`/`kSize`/`kAlpha` and mark dirty.

### F-19: Shot-versus-ship hit resolution has zero headless coverage

**Status:** CONFIRMED
**Locations:** test/selfcheck.js:2477, :2581 (stub games with `ships: []`);
src/ship/ship.js:792 (`gatherRayHits`, never called by the suite)

Every `resolvePath` call in the suite resolves against missiles only. The
shield-facet test even names the two code paths that once disagreed about the
X axis — and then tests only the cheap one (`faceFor`), not the ray walk that
was actually wrong. A sign slip in the hull-frame transform would send every
round to the wrong compartment with all 893 assertions green.

**Fix:** one block with a real Ship in `game.ships`: fire a known bearing,
assert the first section id and surviving energy. Highest coverage-per-line
available in the file.

### F-20: The seeded-RNG injection is untested; only the fallback branch runs under test

**Status:** CONFIRMED
**Locations:** src/ship/systems.js:311; src/weapons/ballistics.js:103;
src/ship/ai.js:69; test/selfcheck.js:67, :2476-2482, :2578-2585

Every construction in the suite omits `game.random`, so the branch the browser
actually runs has no assertion behind it. Concretely uncovered: the
`ship && ship.game.random` guard throws for a ship with undefined `game`
(checks `ship`, then dereferences `ship.game` unguarded), and wiring
`game.random` to the wrong generator would silently revert the sim to
unseeded `Math.random`.

**Fix:** one `Systems` and one `Ballistics` constructed with a stub
`{ random }` plus an assertion that the injected stream is consumed. Guard the
dereference (`ship?.game?.random ?? Math.random`).

### F-21: The frame-shoring regression assertion is vacuous

**Status:** CONFIRMED by instrumentation
**Location:** test/selfcheck.js:1833-1834

`ok(…, buckled === 0 || <recovery check>)` — and `buckled === 0` on every run,
so the recovery check never evaluates. The comment above it names the exact
regression it guards ("a buckled frame was forever"); delete the restore code
and the suite still passes 893.

**Fix:** raise the damage until frames buckle, assert `buckled > 0` as its own
check, then assert recovery unconditionally.

---

## P2 — real but bounded

Grouped by domain. All CONFIRMED unless noted.

### Physics and flight

- **F-40** Collisions impart no angular response at all (flight.js:464-466) —
  deliberate and documented, but it means a ram can never start a tumble.
  The honest fix is a real contact point; recording as accepted behaviour.
- **F-41** Coincident bodies are never separated (flight.js:448): the
  degenerate-normal bail leaves them welded. Deterministic nudge, two lines.
- **F-42** Bounding spheres are ~2–3× the hull's width (corner distance of the
  extreme box): two SABREs "collide" at 106 m separation, and collision energy
  is not geometry-scaled. The shield ellipsoid already carries the real shape
  and is already used for ray broadphase; reuse it for contact.
- **F-43** flight.js:272-286 comment says "all three invert"; measured, only
  pitch and yaw do. The code is right; the comment — the spec for a convention
  already got backwards once — is wrong. Fix the comment.
- **F-44** `Body.localToWorld`/`worldToLocal` are dead and use the opposite COM
  convention to the identically-named Ship methods. Delete or rename.
- Speed clamp runs before the tick's thrust is applied (harmless at current
  ratios); `ship.body.omega.multiplyScalar(1)` in main.js:725 is a no-op.

### Interior systems

- **F-45** `this.demand` is the unshed total and is what the HUD reads — a
  shedding ship shows demand above supply forever. Resolve together with F-02.
- **F-46** Snapshot/restore leaves `duty` at its pre-restore value (absent from
  the capture because of F-03's missing initialiser): a restored ship keeps its
  pre-restore drive duty, drawing full power and heat. Same one-line fix.
- **F-47** A destroyed magazine emits both `cookoff` and `moduleKill` for the
  same module (systems.js:855-880, :531-546); kill counters double-count.
- **F-48** `isStricken` hard-codes the id `'reactor'`; `reactor_aux` letting go
  on MERIDIAN/BASTION does not strike the ship, purely because of a string.
- **F-49** `heatAcc` is not cleared on a destroyed module; a repair delivers the
  stale accumulation in one tick. Move the clear above the guard.
- **F-50** Radiator absolute capacity is applied per loop rather than pooled
  (systems.js:1520-1524) — three-loop hulls reject 3× the heat of the comment's
  "ship-wide pool". `rejectFraction` (shields) is correct.
- **F-51** `SHED_HEAT_PER_WATT`'s justifying comment does not reconcile with the
  current dissipation constants (2.8e-5 derived vs 8.3e-5 claimed). One
  measurement to settle; the constant is justified only by that sentence.

### Weapons and combat

- **F-52** Blast fragments omit `holeSize` and inherit the 0.5 m² default —
  AP-shell-sized holes from "tiny spikes"; one torpedo opens ~24 m² of hull via
  fragments alone. Pass 0.05–0.1 explicitly.
- **F-53** Shooting down a torpedo transfers blast ownership to the
  interceptor, which `resolvePath` then skips — the interceptor is immune to
  the fragments of the warhead it killed, asymmetrically (the radiated blast
  still hits). Keep owner for scoring; exclude nobody from fragments.
- **F-54** Point defence selects threats below its own depression stop
  (`_pdThreat` tests arc but not `MOUNT_DEPRESSION`), then holds fire on them
  for the whole run while `_pdLoad` records the director as engaged.
- **F-55** Ordnance is laid with `muzzleVel` (120 m/s for a torpedo) rather
  than `topSpeed` (620), so tube lead is usually null or absurd. Lead with
  `topSpeed` or skip lead for missiles.
- **F-56** Exit walls cost `ap * 1.1` with no recorded measurement — the only
  unexplained load-bearing constant in ballistics.js.
- **F-57** Beams cannot engage ordnance (`fireBeam` never tests missiles) —
  possibly by design; nothing says so. Decide and document.
- **F-58** `missile.band` is written, documented, and never read. Surface the
  seeker channel or delete it.
- **F-59** Bolt count is unbounded and each bolt is O(ships)/frame; a full
  BASTION engagement is thousands of live bolts. Measure before fixing —
  flagged because growth is unbounded by construction.

### Lifecycle and loop

- **F-60** The MAX_STEPS clamp discards leftover accumulator time even when the
  loop exited legitimately: at ~11 fps the sim runs at ~92% speed. Guard on
  `accumulator >= STEP_INTERVAL`.
- **F-61** Sim keeps stepping up to four more times after `over` is set
  mid-frame. Add `&& !this.over` to the loop.
- **F-62** `_disposeShip` leaves `this.player` / `diagnostics.ship` pointing at
  the disposed hull — self-healing today only by respawn ordering.
- **F-63** `_deployWave` dereferences `this.player.ship` unguarded three lines
  from a guarded sibling; latent, but the asymmetry invites the bug.
- **F-64** `skipWave` clears ballistics but not FX — the previous wave's debris
  burns around the new spawn.
- **F-65** `retryWave` keeps `kills`, so a retried wave banks its kills twice;
  `newRun` resets them. Decide, and comment the decision.
- **F-66** `Scheduler` still carries `enabled`/`ms`/`name` that nothing reads —
  the last of the machinery R-23 existed to delete.
- **F-67** `simTime` is never reset across runs — restart inherits an arbitrary
  weave/sway phase. Cosmetic.
- **F-68** `MIN_SIM_DT` is unreachable (floor below the smallest reachable dt).
  Dead constant on the hot path.

### AI and crew

- **F-69** Pilots never learn their target was disposed: 12 s and ~78 ghost
  rounds into the frozen last position (the wave shoots at empty space behind
  the game-over card). Null matching targets in `_disposeShip` — one loop where
  all callers route through.
- **F-70** `_approach` and `_break` skip the `seen` gate that `_engage` and
  `_withdraw` enforce; `_break` also ignores `WEAPONS_FREE` range. Four lines,
  side by side, two behaviours.
- **F-71** Degraded sensors never degrade aim: `_aimMount` falls back to the
  target's exact position when the contact is stale, so a blinded ship lays
  perfectly. The ai.js header comment promises otherwise; make the code meet
  the comment or soften it.
- **F-72** `Crew.snapshot` captures `parties` but not `reinforceT` — a restored
  wave resumes with the cross-decking phase shifted up to 3 s.
- **F-73** `_wipe` leaves `casualtyAcc`; a re-formed party's first scratch
  reports ~5 phantom deaths. One line.
- **F-74** Cross-decking caps at the division's shortfall but dumps it on one
  party with no per-party cap: measured 8.6/6.0 over-strength, invisible to
  `draft()`.
- **F-75** Dead code: `Crew._route()` (zero callers), `_findJob`'s unused
  `division` parameter (also misnamed — call sites pass a party).

### Browser, UI, effects, audio

- **F-25** No fatal-startup path: `game.init()` runs bare; renderer/assets
  construction throwing leaves a dead "CLICK TO FLY" button and an empty
  status region. And `_frame` schedules the next frame first, so a recurring
  exception loops at display rate. (R-21's runtime half.)
- **F-26** Pointer-lock failure text goes to `#startStatus` inside the hidden
  splash whenever play has started; never cleared on later success; wording
  blames the browser for what is usually Chrome's post-Esc cooldown.
- **F-27** R-19 stands: per-frame `getBoundingClientRect` after HUD DOM writes
  (hud.js:386), plus a per-frame `innerHTML` serialization read-back in
  diagnostics.js:410 (the `_hitsHtml` cache two functions up is the right
  pattern; copy it).
- **F-28** Resizing while paused/game-over leaves black behind the overlay:
  `_onResize` clears the drawing buffer but not `staticRendered`. One line.
- **F-29** `reducedMotion` is sampled once; no `change` listener. The JS half
  freezes at page-load state.
- **F-30** Overlays move no focus on open, the page behind is not inert, and
  the game-over card has no focusable control or live region; `_onOverKey`
  ignores modifiers, so Ctrl+R retries instead of reloading.
- **F-31** Audio: `_chain`'s first parameter is dead at four call sites; voice
  slots are held for the full scheduled tail (a reactor blast pins 5 of 60
  voices for ~4.5 s), so busy mixes silently drop gunnery reports. Release on
  `ended` or weight by audible level.
- **F-32** Fourteen permanent PointLights make every standard-material fragment
  pay fourteen light iterations forever. The comment defends the pool well but
  carries no measurement; per CLAUDE.md, measure 6 vs 14 on a full wave and
  record it.
- `Input` has no dispose and one unremovable listener (latent; single instance
  today). `_onWheel` accumulates unlocked, guarded only by another file's
  `endFrame` call.

### Tests, tooling, build, docs

- **F-33** shot.mjs has no try/finally: a failed `goto` leaks headless
  Chromium. (R-13's other half.)
- **F-34** `serve:nobuild` serves the repo root — `/.git/config` and
  `/node_modules/**` return 200 — and binds the same port as the dev server.
  README still claims the path needs no installation while it pulls three.js
  from unpkg.
- **F-35** CI gaps: `typecheck:hull` never runs anywhere; the suite runs once
  at one seed (CLAUDE.md asks for a few); nothing asserts the built page
  carries the CSP and no import map. SUSPECTED: the backgrounded preview
  server crossing step boundaries is the classic flake.
- **F-36** The build-time CSP injection fails open: both `String.replace` calls
  silently no-op if the anchors drift, shipping a page with no CSP or a live
  unpkg import map. Throw when a replace makes no change — converts a silent
  security regression into a failed build.
- **F-37** `SELFCHECK_SEED=banana` silently runs state 1 while printing
  "seed 0". Reject non-integer seeds loudly; print the normalised state.
- **F-38** Stale docs: README says 871 assertions (893) and "about a second"
  (measured 6.75 s); CLAUDE.md and the selfcheck header repeat the duration
  claim.
- **F-39** Coverage can shrink invisibly: guarded assertion blocks and
  missing-module-id skips silently deregister; nothing pins the total count.
  The seeded-RNG smoke test cannot fail for the reason it exists (a constant
  generator passes); `worker-src` is a dead CSP directive with no workers in
  the codebase; trace.js is the one headlessly-testable module with no tests.

---

## What was hunted and found sound

Recorded so the next review does not re-litigate it:

- **Physics core:** semi-implicit integration order; quaternion derivative in
  world frame with per-step normalisation (|q| = 1.000000 over 36k steps even
  in diverging runs); box inertia + parallel axis exact for these hulls;
  `pointVelocity`; ray/ellipsoid math including degenerate cases; single
  application of collision damage per contact.
- **Lifecycle:** no reachable disposal-during-iteration anywhere in the
  schedule; derelict/recovery bookkeeping cannot double-pay; LCG arithmetic
  stays under 2^53 with the low-bit weakness unexploited.
- **Combat:** resource ordering on all four firing paths; seeker acquisition
  and cone retention; proportional navigation's lateral-acceleration clamp;
  `gatherRayHits` broadphase, span clipping, and face normals; ricochet energy
  accounting; hoists and ready lockers behave as authored.
- **Systems:** no NaN under randomised fuzz; the network solver terminates and
  its cap/tie/sole-feed semantics hold; effusion venting clamps at any dt;
  probability×dt patterns safe at all shipped timescales; units match
  docs/power-units.md throughout.
- **AI/crew:** seeded-RNG threading verified empirically (zero `Math.random`
  reaches Pilot.update); damage control terminates without thrash (one
  reconsideration per party per ~15 s under heavy damage; idle parties are
  genuinely stranded or correctly holding post); crew.js contains no
  randomness at all; the state machine has no dead states.
- **Browser:** no event-listener leaks across restarts; three.js disposal is
  complete on every removal path (owned materials disposed, shared caches
  correctly spared); FX pools genuinely allocation-free; pointer-lock start
  ordering correct; DPR handling correct where it runs; the CSP matches what
  the code needs (`style-src 'unsafe-inline'` is genuinely required by the
  HUD's inline widths; nothing needs unsafe script).
- **Tooling:** determinism across five seeds with identical assertion counts;
  `near()` tolerances tight throughout (no tautologies found); audit clean
  including dev; dist correct (one CSP meta, no import map, no source maps).

## Test coverage to add, in order of value

1. A real-Ship ray-walk block (F-19) — first section hit, surviving energy,
   facet agreement with `faceFor`.
2. Faction-carrying stubs for the ordnance-intercept tests (F-01).
3. Un-vacuous frame shoring (F-21), a pinned assertion total (F-39), and a
   distinct-streams + range check on `seededRandom` (F-39).
4. Injected-RNG constructions for `Systems`/`Ballistics` (F-20).
5. Power-model regressions: recharge resumes after shedding with headroom
   (F-02), idle thermal equilibrium with duty initialised (F-03), loop leak
   derived from conduit state (F-04).
6. A torque-free |L| conservation bound (F-05) — the suite has energy checks
   but no momentum-conservation check, which is how the instability survived.
7. CSP presence and import-map absence asserted on the built page, in CI
   (F-35/F-36).

## Recommended order of work

1. F-01..F-04 (the P0s): all four are small, local fixes with regressions
   listed above.
2. F-05 and F-06: the integrator and the trigger gate — the two defects with
   the largest effect on how the game actually plays.
3. F-07..F-12: the combat/thermal correctness tier.
4. F-14, F-16..F-18: the player-facing browser tier (one CSS rule, one resize
   call, one buffer zero, one lock-flow change).
5. F-19..F-21 plus the coverage list: make the suite able to see this class of
   defect before the next pass.
6. P2s opportunistically, alongside domain work — except F-36 (CSP fail-open)
   and F-34 (served repo root), which are cheap and security-relevant, and
   should ride with the next tooling change.

## Standing observations

- The fixed-step simulation, the authored-hull compilation, and the selfcheck
  harness remain the right foundations; every serious defect found here was in
  behaviour the suite structurally cannot see (browser state, GPU buffers,
  thermal/power equilibria, and cross-subsystem contracts).
- The pattern across F-02/F-03/F-09/F-12 is one number or flag being asked two
  different questions by two consumers. Where a field has two meanings
  (`demand`, `duty`, `live`, `shieldFraction`), the fix that lasts is to split
  the meanings, not to patch one consumer.
- Comments are load-bearing in this codebase — several (F-43, F-51, F-11's
  FIRE_HEAT, ai.js's sensor header) now disagree with measured behaviour.
  Where this review measured a number, the fix should carry the measurement
  into the comment, per CLAUDE.md.
