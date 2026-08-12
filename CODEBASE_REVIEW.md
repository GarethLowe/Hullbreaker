# Codebase review

Date: 2026-08-12

## Scope

This review covered the runtime architecture, ship and weapon simulation, physics, lifecycle management, browser input and UI, tests, build tooling, dependency posture, and project documentation. The Ponytail review/audit workflow was deliberately excluded as requested.

This began as a read-only review. The implementation pass is tracked below; recommendations still pending are intentional follow-up work rather than unrecorded omissions.

## Implementation progress

Last updated: 2026-08-12
Implementation commit: f22d1e7

### Completed

- [x] R-01 through R-05: fixed thermal NaN, Euler sign, centre-of-mass impulse, collision response/energy accounting, and rejected-shot ammunition loss; added focused regressions.
- [x] R-06 through R-09: corrected COM-relative collision bounds, seeker acquisition/FOV loss, wave teardown ordering, and simulation-time gameplay decisions.
- [x] R-10 through R-12: added pointer-lock error handling, keyboard-accessible start/resume controls, responsive/DPR/reduced-motion improvements, and upgraded audited development dependencies.
- [x] R-13 through R-22: made browser smoke failures fail closed, added deterministic test seeds, CI, Node requirements, loopback no-build serving, documentation updates, inactive-frame throttling, and a production startup smoke check.
- [x] R-29: removed confirmed unused state, exports, and helpers identified in the review.
- [x] R-30 and R-31: corrected stale operational documentation and made production source maps opt-in by removing them from the default build.

### Pending — requires a separate, scoped change

- [ ] R-23: make ECS or the current ordered scheduler the single lifecycle authority. The immediate wave-transition bug is fixed, but the duplicate ownership model remains.
- [ ] R-24 and R-25: incrementally separate simulation, rendering, effects, and authored hull data; split oversized modules only alongside domain changes that establish testable seams.
- [ ] R-26: introduce gradual JSDoc/checkJs typing at authored/live-state boundaries.
- [ ] R-27: decide and document the power-versus-energy model before renaming fields or changing balance behavior.
- [ ] R-28: route outcome-affecting simulation randomness through an injectable seeded RNG; the test harness is deterministic, but runtime simulation is not yet replayable.
- [ ] R-32: add an explicit deployment CSP/self-hosted asset policy if the game is publicly hosted.
- [ ] R-33: profile trace storage before replacing its bounded array with a circular buffer.

### Deferred by evidence

- [ ] Application code splitting: Vite still warns about the approximately 534 kB application chunk, but no startup performance measurement has demonstrated that splitting it would improve play. Keep this deferred until profiling identifies a noncritical boundary.

## Executive summary

The codebase has a substantial self-check suite and a working production build, but several core paths contain defects that the current tests do not detect. The most urgent problems are:

1. Beam damage can permanently turn a compartment temperature into NaN.
2. Two rigid-body calculations are wrong: torque-free rotation uses the opposite Euler-term sign, and impulses subtract the centre of mass twice.
3. Collision response applies part of the linear impulse twice and overstates collision energy.
4. A failed weapon shot can consume ammunition before the power check rejects it.
5. Collision bounds are calculated around the authored origin rather than the actual centre of mass.

The next tier is lifecycle and control correctness: active seekers do not enforce their field of view consistently, wave changes leave old entities alive for one extra simulation tick, gameplay randomness partly follows wall time rather than simulation time, and pointer-lock failure can leave the game running without usable pitch or aim controls.

The architectural issue behind several bugs is duplicated state ownership. The ECS queues entity lifecycle changes, while Game.ships and Game.pilots are separate authoritative arrays iterated directly by the simulation. The project should choose one lifecycle source of truth rather than maintain both.

## Verification performed

- Ran npm test after implementation. It passed all 883 deterministic assertions using seed 1729.
- Ran npm run build successfully with Vite 8.2.1.
- Current production build sizes are approximately 24.1 kB for index HTML, 485.9 kB for the Three.js chunk, and 534.1 kB for the application chunk before compression. Vite still warns that the application chunk exceeds 500 kB.
- Ran the Playwright smoke capture against the production preview. The game initialized, the MERIDIAN loaded, all 22 reported mounts were rigged, and no browser console or page errors were reported.
- Ran npm audit --omit=dev after the dependency upgrade. It reported zero production vulnerabilities.
- Reproduced the heat, centre-of-mass impulse, collision restitution, and collision-radius defects with focused headless checks.

Passing the existing suite therefore does not imply that the core physics and thermal paths are correct; the missing assertions are listed with each finding.

## P0 — fix correctness defects first

### R-01: Beam heat injection produces NaN

**Status:** Confirmed defect
**Locations:** src/ship/systems.js:383-405 and 793-800; src/weapons/ballistics.js:976-977

Live section state retains its authored definition as section.def and does not copy a top-level volume property. Systems.injectHeat reads section.volume, so its temperature delta divides by undefined. A beam hull hit calls this path and changes the affected section temperature to NaN. Subsequent comparisons against that temperature silently fail, leaving the thermal state poisoned.

**Recommendation**

- Read section.def.volume in Systems.injectHeat.
- Validate authored section volume as finite and greater than zero during hull compilation.
- Consider a finite-number assertion at the simulation boundary in development builds so similar state corruption fails close to its cause.

**Regression check**

- Apply beam heat to a live compartment and assert that temperature remains finite and rises by the expected amount.
- Advance several thermal ticks and assert that the value remains finite.

### R-02: Torque-free Euler rotation uses the wrong sign

**Status:** Confirmed defect
**Location:** src/ship/flight.js:167-176

The implementation comment states the correct rigid-body equation:

I times omega-dot equals torque minus omega cross I-omega.

The code computes I-omega cross omega and then negates it. Since I-omega cross omega already equals minus omega cross I-omega, the extra negation changes the term to plus omega cross I-omega. This reverses the expected torque-free angular acceleration for an asymmetric body.

**Recommendation**

- Remove the final negate operation from that Euler term.
- Keep the formula and implementation in the same operand order to make the sign auditable.

**Regression check**

- Use an asymmetric inertia tensor with a known angular velocity and assert the sign and magnitude of omega-dot directly.
- Include a short free-precession check. Conservation-only assertions are insufficient because the wrong sign can still conserve scalar energy.

### R-03: Impulse-at-point subtracts the centre of mass twice

**Status:** Confirmed defect
**Locations:** src/ship/flight.js:136-155; src/ship/ship.js:235-237

Body.pos is the world-space centre of mass. Local/world transforms and rendered geometry already account for hull.com. Body.applyImpulseAt first forms point minus body.pos, which is the correct centre-of-mass lever arm, then transforms it and subtracts this.com again. An impulse applied exactly at Body.pos therefore creates angular velocity. This was reproduced on MERIDIAN.

**Recommendation**

- Remove the second subtraction of this.com.
- Document Body.pos explicitly as the world-space centre of mass.
- Audit callers to ensure their contact point is in world coordinates before applying the shared fix.

**Regression check**

- Apply an impulse exactly at Body.pos and assert that linear velocity changes while angular velocity remains unchanged.
- Apply a known off-centre impulse and assert the expected torque direction.

### R-04: Collision response applies linear impulse twice

**Status:** Confirmed defect
**Location:** src/ship/flight.js:438-470

Collision resolution first updates both bodies' linear velocities with the full impulse. It then calls applyImpulseAt with 35 percent of that impulse to create angular response, but applyImpulseAt also changes linear velocity. Equal hulls configured for restitution 0.25 produced effective restitution 0.6875 in a focused check.

The associated collision-energy estimate also needs correction. One half times absolute impulse times closing speed is not dissipated energy; with restitution 0.25 it reports more than the initial normal relative kinetic energy. This value is later split into damage, so the accounting error affects combat outcomes.

**Recommendation**

- Apply the translational impulse exactly once.
- If an angular effect is intentional, apply torque/angular impulse separately without another linear update.
- Prefer a physically derived off-centre contact point. If the current sphere approximation cannot provide one, make the gameplay torque term explicit rather than routing it through a function that also translates the body.
- Compute dissipated normal energy as one half times reduced mass times closing speed squared times one minus restitution squared.
- Revisit the later half-per-ship damage split after the energy value is corrected.

**Regression check**

- For equal masses and a head-on collision, assert the configured restitution.
- Assert conservation of linear momentum.
- Assert that dissipated energy is non-negative and does not exceed initial relative kinetic energy.
- Add an off-centre case for angular impulse direction.

### R-05: Rejected shots can consume ammunition

**Status:** Confirmed control-flow defect
**Locations:** src/ship/ship.js:1475-1479; compare the safer point-defence ordering at 653-662

The non-beam firing path calls _takeAmmo before _canDraw. If the mount has ammunition but cannot draw the required energy, the shot is rejected after ammunition has already been removed. Point defence performs these checks in the safer order, so firing paths are inconsistent.

**Recommendation**

- Evaluate every non-mutating precondition before consuming ammunition, power, cooldown, or other state.
- Keep all firing paths on one transaction-like order: validate, reserve/consume resources, create projectile, then commit cooldown and effects.
- Reuse an existing shared firing path if one can represent both manually aimed and point-defence weapons; do not add a new abstraction solely for naming consistency.

**Regression check**

- Attempt a shot with ammunition present and insufficient charge. Assert no projectile, no cooldown change, and no ammunition loss.
- Assert exactly one unit of ammunition and the expected energy are consumed on a successful shot.

## P1 — high-impact runtime and interaction fixes

### R-06: Hull collision radii ignore centre-of-mass offset

**Status:** Confirmed defect
**Locations:** src/ship/hulls.js:2264-2274 and 2451-2455; src/ship/ship.js:235-237

boundingRadius measures section extents from the authored origin, while Body.pos and rendered geometry pivot around the derived centre of mass. All four current hulls are underbounded:

- SABRE: 48.26 m calculated versus approximately 52.97 m from centre of mass.
- HALBERD: 83.33 m versus approximately 89.40 m.
- MERIDIAN: 126.02 m versus approximately 133.27 m.
- BASTION: 191.54 m versus approximately 200.26 m.

This permits several metres of hull overlap before sphere collision, reduces explosion cross-section, and affects every consumer of the shared radius.

**Recommendation**

- Derive mass properties first, then calculate each section extent from section.pos minus hull.com.
- Audit all radius consumers after changing it, including collision, hit-radius logic, explosions, targeting, and any camera or weapon scaling.

**Regression check**

- Assert the known radius of every authored hull from centre-of-mass-relative extents.
- Add a collision case at the corrected touching distance.

### R-07: Active seekers bypass acquisition and field-of-view rules

**Status:** Confirmed defect
**Locations:** src/weapons/ballistics.js:167-193, 215-255, and 445-459

Field of view is enforced in _acquire, but a supplied launch target is retained without going through acquisition. The later lost-target check only considers disposal and range despite a comment saying an out-of-cone target is lost. Initial targets therefore bypass autonomous scoring and field-of-view enforcement, and their seeker band remains unset.

**Recommendation**

- Run the initial target through the same seeker acquisition contract used later.
- Include departure from the seeker cone in the lost condition.
- Define whether brief cone loss receives a grace period; if none is intended, make loss immediate and keep the implementation simple.
- Ensure seeker band and other acquisition metadata are set for every accepted target.

**Regression check**

- Launch with an alive but out-of-cone supplied target and assert that it is rejected or reacquired according to the stated policy.
- Move a tracked target outside the cone and assert lock loss.
- Verify band/scoring metadata for both initial and reacquired targets.

### R-08: Deferred destruction lets old wave entities simulate once more

**Status:** Confirmed defect
**Locations:** src/main.js:355-425; src/core/ecs.js:182-190

skipWave queues ECS destruction and immediately deploys the next wave. Brains, ships, weapons, and collision continue to iterate separate Game.ships and Game.pilots arrays until ECS.run flushes the queue. Old hostiles therefore receive one final tick against the new wave. The same deferred boundary can briefly preserve old visuals or entities during other world-clear transitions.

**Recommendation**

- Flush queued destruction synchronously at explicit lifecycle boundaries before deploying replacements.
- Make one structure authoritative for entity lifetime. Either have simulation queries derive from the ECS, or reduce the ECS to the ordered scheduler/lifecycle role the game actually uses.
- Add a small invariant after a world clear: no disposed old-wave ship or pilot may remain in an active simulation collection.

**Regression check**

- Skip a wave and assert that old brains, weapon systems, collisions, and views do not update after the transition.
- Assert that the first new-wave tick contains only new-wave entities.

### R-09: Gameplay decisions use wall time inside a scaled simulation

**Status:** Confirmed design defect
**Locations:** src/main.js:39-50; src/ship/ai.js:563-567; src/ship/ship.js:1247-1250

AI weave and gun-lay error use performance.now while movement and combat advance through scaled fixed steps. At 0.12x time scale they change at real-time speed, and after a pause they jump ahead even though no simulated time elapsed. This makes outcomes depend on rendering and pause duration.

**Recommendation**

- Maintain a simulation clock advanced only by fixed-step dt.
- Pass simulation time to combat and AI decisions.
- Keep wall time only for presentation effects that are intentionally independent of simulation, such as a visual beacon pulse.

**Regression check**

- Run the same seeded scenario at two rendering rates and time scales and compare combat decisions at equal simulated times.
- Pause and resume without stepping; assert that weave and gun error do not jump.

### R-10: Pointer-lock failure leaves the game running without usable aim

**Status:** Confirmed interaction defect
**Locations:** src/main.js:152-161; src/core/input.js:42-47 and 90-105

The start path hides the splash and begins play before pointer lock succeeds. Mouse movement is discarded unless the document is locked, and unsupported or rejected pointer lock has no visible error or fallback. The player can enter a running game without pitch or aim control.

**Recommendation**

- Treat pointerlockchange as the success signal before completing the start transition, or provide an intentional unlocked-mouse control mode.
- Handle pointerlockerror and rejected requestPointerLock promises with an actionable overlay.
- Reset held input on window blur and visibility changes so a lost key-up event cannot leave controls stuck.

**Regression check**

- Reject pointer lock in a browser test and assert that the game remains recoverable with an explanation.
- Verify start, pause, resume, and lock loss through keyboard as well as pointer interaction.

### R-11: Interactive overlays are not keyboard-accessible

**Status:** Confirmed accessibility defect
**Locations:** index.html:447-461 and 584-644; src/main.js:152-162 and 844-856

Start, resume, and related interactions are clickable div elements without native button semantics or a complete keyboard path.

**Recommendation**

- Replace interactive divs with button elements.
- Provide visible focus styles and logical initial focus when an overlay opens.
- Support Enter and Space through native button behavior.
- Announce important state changes such as pause, game over, and control errors through an appropriate live region.
- Give informative canvas regions accessible names or fallback text where they communicate state unavailable elsewhere.

### R-12: Development server dependencies have known advisories

**Status:** Confirmed tooling risk
**Locations:** package-lock.json entries for Vite 5.4.21 and esbuild 0.21.5

npm audit reports one high-severity Vite advisory group and one moderate esbuild advisory. The findings affect development tooling rather than the shipped runtime; npm audit --omit=dev reports zero production vulnerabilities.

**Recommendation**

- Plan and test the Vite 8.2.1 upgrade identified by npm audit as the available fix, including its major-version and Node requirements.
- Regenerate the lockfile, run all tests and the browser smoke check, and verify no build or base-path regression.
- Until upgraded, bind development and preview servers to loopback and do not expose them to untrusted networks.

## P2 — reliability, UI, performance, and delivery

### R-13: Smoke capture reports failures but exits successfully

**Status:** Confirmed test-tool defect
**Location:** tools/shot.mjs:51-67 and 159-160

The script collects console errors, page errors, and a missing window.game condition but only prints them. Automation can therefore report success when initialization failed.

**Recommendation**

- Close Chromium in a finally block.
- Exit non-zero when the game is missing or captured errors are non-empty.
- Keep screenshot output on failure as a diagnostic artifact.
- Add the corrected smoke check to the automated verification gate.

### R-14: There is no automated repository gate

**Status:** Preventive improvement
**Locations:** package.json:7-14; CLAUDE.md:39-47

The repository defines useful commands but relies on contributors running them manually.

**Recommendation**

- Add one minimal CI workflow that runs npm ci, npm test, npm run build, and the corrected browser smoke check on supported changes.
- Cache dependencies only if CI duration becomes material; a simple deterministic gate is the priority.
- Add an explicit package.json engines.node range. The current Playwright lock entry requires Node 20 or newer.

### R-15: Stochastic tests are not reproducible

**Status:** Confirmed test weakness
**Location:** test/selfcheck.js:2663-2685

Some assertions sample Math.random without a controlled seed. Repeating the suite reduces the chance of a hidden problem but does not make a failure reproducible.

**Recommendation**

- Give the self-check harness a fixed default seed with an environment override.
- Print the effective seed on failure.
- Longer term, inject a seeded generator into simulation randomness while leaving purely visual randomness separate.

### R-16: Narrow-screen and zoom behavior are fragile

**Status:** Confirmed responsive/accessibility weakness
**Locations:** index.html:5, 33, 113, 228-300, and 447-503

The viewport disables user zoom despite very small HUD text. The only responsive breakpoint adjusts diagnostic width, while multiple panels remain fixed between 190 and 330 pixels. Narrow screens can overlap panels, and the splash combines hidden overflow, large fixed spacing, and a four-column key grid.

**Recommendation**

- Remove user-scalable=no.
- Add a narrow layout that stacks or collapses panels and makes overlays vertically scrollable.
- If small screens are intentionally unsupported, present a clear minimum-size message rather than an overlapping interface.
- Test keyboard zoom and 200 percent browser zoom as well as mobile-sized viewports.

### R-17: HUD canvases ignore device-pixel ratio and CSS size changes

**Status:** Confirmed rendering weakness
**Locations:** index.html:516, 527, and 573; src/ui/diagnostics.js:409-411; src/ui/targeting.js:289-291

Diagnostic and radar canvases use fixed backing dimensions and are not resized from their CSS client dimensions. They blur on high-DPI displays, and diagnostic output distorts when the breakpoint compresses its CSS width.

**Recommendation**

- Use one shared resize routine that sets backing width and height from client dimensions times devicePixelRatio and scales the drawing context.
- Refresh on ResizeObserver or the existing resize path.
- Test at DPR 1 and 2 and at the narrow breakpoint.

### R-18: Paused and overlay states continue full rendering work

**Status:** Confirmed performance/energy issue
**Location:** src/main.js:859-915

The animation loop continues camera updates, HUD writes, diagnostic/radar redraws, and WebGL rendering on the splash, while paused, and after game over.

**Recommendation**

- Render once when entering a static inactive state, then resume continuous frames on state changes or unpause.
- If a paused animation is intentionally visible, throttle it and update only that presentation path.
- Measure before introducing broader render scheduling machinery.

### R-19: HUD layout reads follow per-frame writes

**Status:** Likely performance issue
**Location:** src/ui/hud.js:168-386

getBoundingClientRect is called after many DOM writes in the same frame, which can force synchronous style and layout calculation.

**Recommendation**

- Cache the picture-in-picture rectangle and refresh it on resize or panel layout changes.
- Alternatively, perform required layout reads before DOM writes in the frame.
- Confirm the gain with a browser performance trace before larger HUD refactoring.

### R-20: Reduced-motion coverage is incomplete

**Status:** Accessibility improvement
**Locations:** index.html:385-387 and 497-503; src/player/pilot.js:243-269

The reduced-motion media query covers only one diagnostic animation. The start prompt continues pulsing, and camera shake/FOV effects are not reduced.

**Recommendation**

- Disable the start pulse under prefers-reduced-motion.
- Reduce or disable camera shake and rapid FOV transitions through the same preference, optionally exposed as an in-game setting.
- Keep immediate state feedback even when motion is removed.

### R-21: Initialization failures need a stable fatal-error path

**Status:** Reliability improvement
**Locations:** src/main.js initialization around 64-180 and frame scheduling around 859-915

WebGL renderer creation, asset/setup work, and warmup are not surfaced through a user-facing failure state. An unexpected recurring frame exception can also continue scheduling work.

**Recommendation**

- Catch startup failures at the top-level initialization boundary and show a persistent compatibility/error overlay.
- Schedule the next animation frame only after the current frame completes successfully, or stop the loop after a fatal error.
- Include the error in the browser smoke result.

### R-22: The no-build server command is unpinned and too broad

**Status:** Confirmed tooling weakness
**Locations:** package.json:13; README.md:52-57

serve:nobuild invokes the current npx serve package rather than a lockfile-pinned version and serves the repository root. The README also describes this as requiring no installation even though npx may download a package and the browser path uses CDN imports.

**Recommendation**

- Pin the server as a development dependency or use an already-installed server.
- Bind explicitly to 127.0.0.1.
- Serve only the minimum required directory where practical.
- Correct the README wording about downloads and network requirements.

## P3 — architecture and maintainability

### R-23: Choose one entity lifecycle source of truth

**Status:** Architectural priority
**Locations:** src/core/ecs.js:76-190; src/main.js:90-91 and 377-425

The ECS exposes component/query APIs, but gameplay primarily iterates Game.ships and Game.pilots. Repository search found no callers for several query/component APIs. The two lifecycle models can disagree, as demonstrated by R-08.

**Recommendation**

- Prefer the smaller direction that matches actual use: remove unused query/component machinery and retain a compact ordered scheduler plus synchronous lifecycle operations.
- If future requirements genuinely need component queries, instead migrate gameplay iteration to ECS queries and remove the parallel arrays.
- Do not preserve both systems for speculative flexibility.

### R-24: Separate simulation state from presentation at the Ship boundary

**Status:** Incremental architecture improvement
**Location:** src/ship/ship.js:142-200 and 1424-1629

Ship coordinates simulation, rendering, weapons, audio, HUD effects, and lifecycle while receiving the entire Game object as a service locator. That makes deterministic testing harder and allows unrelated dependencies to spread.

**Recommendation**

- Make this a staged change only when touching the affected area.
- Extract pure gunnery/state calculations first, leaving rendering and effects behind a narrow collaborator or callback surface.
- Separate a simulation-facing ship model from view/effects only when tests demonstrate a useful boundary; avoid a framework-wide rewrite.
- Pass required services explicitly instead of the whole Game object as new code is introduced.

### R-25: Break up oversized modules along existing domain boundaries

**Status:** Maintainability improvement

Current large files include:

- src/ship/hulls.js: roughly 2,500 lines.
- src/ship/systems.js: roughly 2,300 lines.
- src/ship/ship.js: roughly 1,800 lines.
- src/fx/fx.js: roughly 1,200 lines.
- src/weapons/ballistics.js and src/crew/crew.js: roughly 1,100 lines each.
- test/selfcheck.js: roughly 2,900 lines.

**Recommendation**

- Move authored hull data out of hull compilation/validation logic, then split per hull if navigation remains difficult.
- Split Systems around its real subsystems: power/network, atmosphere/fire, thermal, and shields.
- Separate index.html styles and markup when changing the UI, rather than continuing to grow a single document.
- Split selfcheck into domain test files using Node's built-in test runner or the existing assertion helpers; no additional test framework is required.
- Keep public boundaries small and avoid cross-module cyclic ownership.

### R-26: Add gradual type checking at authored/live-state boundaries

**Status:** Preventive improvement

The section.volume defect is the kind of authored-definition versus live-state mismatch that static checking should catch.

**Recommendation**

- Enable checkJs gradually rather than converting the project wholesale.
- Start with JSDoc types for hull definitions, compiled hulls, live sections, weapon definitions, and projectile state.
- Add the type check to CI only after the first selected boundary is clean.
- Preserve runtime validation for authored data; types do not replace it.

### R-27: Formalize energy and power units

**Status:** Design clarification required
**Locations:** weapon draw definitions; src/ship/ship.js power checks; src/ship/systems.js power integration

Weapon draw values are described in MW, while firing paths appear to deduct them directly from capacitor-like storage and the power network integrates MW over dt elsewhere. _canDraw can also accept a shot based on current supply without clearly demonstrating that the requested shot energy is available. The intended capacitor-versus-steady-draw model is not explicit enough to audit.

**Recommendation**

- Decide whether each value represents instantaneous power in MW, shot energy in MJ, or an intentional gameplay unit.
- Rename fields to encode the unit, such as shotEnergyMJ and powerMW.
- Centralize conversions involving dt.
- Add conservation/accounting tests for recharge, sustained beams, single shots, failed shots, and simultaneous mounts.
- Do not change balance values until the intended model is documented.

### R-28: Make simulation randomness injectable and traceable

**Status:** Reproducibility improvement

Direct Math.random calls are widespread in combat simulation as well as visual effects. This prevents exact replay and makes rare failures difficult to reproduce.

**Recommendation**

- First seed the test harness as described in R-15.
- Then route outcome-affecting randomness through one simulation RNG and include its seed in traces or bug reports.
- Leave non-gameplay particles and cosmetic noise on a separate generator so presentation changes do not alter combat outcomes.

### R-29: Remove confirmed dead state and unused APIs

**Status:** Cleanup after correctness fixes

Repository search identified likely unused items:

- main.js frameTimes.
- targeting.js _lockBeep.
- ship.js pdMounts and lastDamageT.
- systems.js strickenT and damagedAt.
- math helpers approach and gaussian.
- the conflicting or unused Systems FIELD_DEPTH export.
- the flight.js damp import/re-export.
- unused ECS query/component methods noted in R-23.
- adjacent duplicate documentation blocks in main.js and ballistics.js.

**Recommendation**

- Verify each item with repository-wide search, remove it in small domain-specific changes, and run the full suite.
- Add a lightweight lint/static check for unused imports and variables after the current backlog is cleared.
- Resolve the two FIELD_DEPTH definitions deliberately; a silent value conflict is more dangerous than ordinary dead code.

### R-30: Split operational documentation from design notes

**Status:** Documentation improvement

README.md is approximately 76 kB and mixes onboarding, controls, implementation rationale, measurements, and repeated sections. It contains duplicate Targeting headings around lines 1362 and 1389. Some volatile details are stale: the stated test duration and build sizes no longer match current measurements.

**Recommendation**

- Keep installation, commands, controls, compatibility, and a short architecture map in README.md.
- Move detailed design rationale and measurements into focused documents under docs.
- Rename or remove the duplicate Targeting section.
- Document Node 20 or newer for the current Playwright version.
- Replace the blanket any WebGL2 browser statement with required capabilities: WebGL2, Pointer Lock or a fallback, AudioContext, and modern JavaScript/CSS support.
- Avoid exact bundle-size claims unless they are generated automatically.

### R-31: Reconsider public source maps and bundle work based on deployment needs

**Status:** Optional deployment improvement
**Location:** vite.config.js:28

Production source maps add roughly 3.2 MB to current build artifacts. The application chunk also triggers Vite's 500 kB warning, but much of the application appears to be startup-critical.

**Recommendation**

- Keep source maps if they are actively used for debugging or error reporting; otherwise make them opt-in or hidden for public deployment.
- Measure startup parse/evaluation time before splitting the application chunk. A warning alone is not evidence that code splitting will improve this game.
- If splitting is justified, begin with clearly deferred UI/help or nonessential effects rather than core simulation initialization.

### R-32: Add a deployment security policy if the game is publicly hosted

**Status:** Conditional improvement

The runtime has no untrusted application input or network API, and reviewed innerHTML values are authored/local. The no-build path does, however, depend on CDN imports.

**Recommendation**

- For public hosting, self-host the pinned Three.js artifact or define an explicit trusted CDN policy.
- Add a Content Security Policy compatible with the chosen asset strategy.
- Do not classify local authored HTML rendering as an injection vulnerability without an actual untrusted source.

### R-33: Optimize trace storage only if profiling shows a cost

**Status:** Low-priority observation

Trace sampling is described as a ring buffer but uses array push and shift at a capacity of 6,000. That is linear work on eviction, though the current scale may be harmless.

**Recommendation**

- Correct the terminology if retaining the array.
- Replace it with a circular index only if tracing profiles as material; do not add machinery solely for theoretical complexity.

## Test coverage additions

Every P0/P1 fix should arrive with a focused assertion that fails on the current implementation. Beyond those specific checks, add:

- A deterministic end-to-end combat scenario with a printed seed.
- Browser startup tests for pointer-lock success, rejection, loss, pause, and keyboard resume.
- Wave-skip lifecycle coverage proving disposed entities cannot act.
- Viewport tests at narrow width, 200 percent zoom, and DPR 2.
- A browser smoke failure test proving console/page errors produce a non-zero result.
- Power-accounting tests once unit semantics are decided.
- A basic startup compatibility failure test for unavailable WebGL.

The existing self-check already covers substantial Systems, Crew, and Ballistics behavior. Extend it around the missed invariants rather than replacing it wholesale.

## Recommended implementation order

1. Add focused failing regressions for R-01 through R-05.
2. Fix heat injection, Euler sign, centre-of-mass impulse, collision response/energy, and firing resource ordering.
3. Correct hull bounds and audit all shared-radius consumers.
4. Fix seeker acquisition, lifecycle flushing, and simulation-time ownership.
5. Repair pointer-lock recovery and keyboard-accessible overlays.
6. Make the smoke tool fail closed, seed tests, and establish the CI gate.
7. Upgrade Vite and esbuild through the supported Vite release, then rerun the complete gate.
8. Address responsive/DPR/inactive-render work with browser measurements.
9. Simplify duplicated ECS lifecycle ownership before performing broader module splits.
10. Apply gradual types and cleanup as bounded follow-up changes.

For each stage, require npm test, npm run build, and the corrected browser smoke check. Physics changes should also record before/after numeric fixtures so balance changes are intentional rather than hidden inside bug fixes.

## Existing strengths worth preserving

- The fixed-step simulation structure is the right foundation for deterministic behavior once wall-clock gameplay inputs are removed.
- The self-check suite is broad and fast enough to run routinely, even though it needs stronger invariant coverage.
- Authored hull compilation and validation provide a natural place for geometry and finite-value checks.
- Production dependencies currently audit clean.
- The application builds and initializes successfully in a real browser with all reported mounts rigged.
- The code generally exposes domain concepts directly, so most urgent fixes can be local and regression-tested without a large rewrite.
