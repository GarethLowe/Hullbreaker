# HULLBREAK

A browser 6DOF **capital-ship** combat simulator whose ships are **modelled
interiors**, not health bars. Every vessel is 95 to 380 metres of pressurised
compartments holding 39 to 105 functional components, wired together by three
utility networks — **power**, **data** and **coolant** — and crewed by hundreds
of hands in divisions that have to walk to a problem before they can fix it.

You do not have to destroy a turret. Cut the conduit that feeds it, boil the
loop that cools it, vent the compartment it sits in, or kill the gunnery
division that lays it. All four work, because all four are simulated.

Engagements run at four to eight kilometres and take minutes, and you can read
an enemy's interior in the same detail as your own. The point is to watch damage
propagate through a complex system over time, not to win a reflex contest.

## The roster

| | role | length | mass | crew | compartments | components |
|-|-|-|-|-|-|-|
| **SABRE** | picket | 95 m | 4,100 t | 85 | 8 | 39 |
| **HALBERD** | line frigate | 165 m | 15,900 t | 180 | 11 | 56 |
| **MERIDIAN** | heavy cruiser *(yours)* | 250 m | 45,900 t | 420 | 14 | 96 |
| **BASTION** | dreadnought | 380 m | 165,900 t | 1,050 | 14 | 105 |

Thirty seconds of cruiser gunnery into a frigate, measured: shields to 43%, nine
compartments opened, and the frigate had lost its **sensors**, **both fuel
bunkers**, **both forward power runs** (dorsal *and* keel), its **fire-control
and damage-control data buses**, and 119 of its 180 hands — while its shields
partly recovered as the surviving projectors fought back.

---

## Run it

```bash
npm install
npm start
```

That is the whole loop. Other entry points:

| command | what it does |
|-|-|
| `npm start` | dev server on :5174 with HMR, opens a browser |
| `npm run dev` | same, without opening a browser |
| `npm run play` | production build, then serve it on :4174 and open a browser |
| `npm run build` | production bundle into `dist/` |
| `npm test` | headless assertions over the simulation (see below) |
| `npm run serve:nobuild` | static-serve the source with **no build at all** |

**No-build path.** `index.html` carries a CDN import map for Three.js, so the
source folder can be served by any static file server and played without
installing anything:

```bash
npx --yes serve -l 5174 .
```

It has to be over HTTP either way — browsers refuse ES module imports from
`file://`. Under Vite the import map is inert, and `vite build` strips it.

**Build output.** Two chunks: app ~153 kB, `three` ~472 kB. There is no physics
library. Everything else — textures, materials, sound — is generated at runtime,
so there are no binary assets in the repository.

**Requirements:** any WebGL2 browser.

### Controls

| | |
|-|-|
| `Mouse` | aim — pitch and yaw (a virtual stick that springs back to centre) |
| `W` | hold to build speed; release and the ship brakes itself to a stop |
| `S` | hold to reverse |
| `A` `D` | yaw left / right |
| `Q` `E` | roll left / right |
| `R` `F` | translate up / down |
| `Z` `C` | translate left / right |
| `Space` | boost (spends capacitor charge) |
| `X` | stabilise on / off — flight assist, or manual helm if the computer is gone |
| `LMB` / `RMB` | fire the primary / secondary weapon |
| `Wheel` | select the primary weapon; `Shift`+wheel selects the secondary |
| `1` `2` `3` | load solid shot / high explosive / delay-fused |
| `T` | lock whatever is ahead |
| `Y` | cycle contacts |
| `[` `]` | cycle the locked ship's subsystems |
| `U` | jump to its weakest subsystem |
| `H` | damage-control panel |
| `,` `.` | scroll the module tree |
| `J` | point the panel at your ship or at the target |
| `B` | emergency-vent the worst fire aboard |
| `V` | cockpit / chase view |
| `N` | time dilation — 1x / 0.35x / 0.12x |
| `G` | deploy a test contact |
| `M` | mute |
| `Esc` | pause |

Throttle is a **held demand**, not Elite's persistent setting: speed builds while
you hold `W` and falls away to a stop when you let go. Under flight assist the
ship actively brakes, so releasing the key parks it.

---

## Architecture

```
index.html               import map, HUD markup, all CSS
vite.config.js           chunk splitting + strips the CDN import map on build
src/
  main.js                Game facade, fixed-step loop, ECS system schedule
  core/
    ecs.js               entity/component store + ordered system scheduler
    mathx.js             clamps, damping, ray primitives, the intercept solver
    input.js             keyboard/mouse/pointer-lock with edge-triggered queries
    audio.js             fully procedural Web Audio (noise bursts + FM blips)
  world/
    assets.js            runtime-generated textures, materials, environment probe
    kit.js               GENERATED: hull shells + weapon hardware, as geometry
    hardware.js          decodes the kit; works out how a gun sits on a hull
    space.js             starfield, wrapping dust field, nebula, lighting
  ship/
    hulls.js             DATA: four ship classes — compartments, modules, networks
    systems.js           networks / power / atmosphere / fire / thermal / shields
    crew.js              crew agents, compartment pathing, casualties, repair
    flight.js            6DOF Newton-Euler body + the flight control law
    ship.js              assembly, the analytic hit stack, weapon mounts
    ai.js                sensor-gated hostile pilot
  weapons/
    defs.js              armory + ammunition natures
    ballistics.js        projectile integration + the penetration solver
  player/pilot.js        virtual stick, throttle, camera rig
  ui/
    hud.js               reticle, lead pip, shield rose, gauges, messages
    targeting.js         contact tracking, lock, subsystem select, 3D radar
    diagnostics.js       live system tree + hull cutaway + crew roster
  fx/fx.js               pooled particles, streaks, debris, light flashes
test/selfcheck.js        headless assertions over the simulation
tools/                   Blender modelling source for the kit + preview rigs
```

### Every gun is a real machine

A compartment is not drawn as a box and a weapon is not drawn as nothing. Both
come out of one kit — twenty-one parts, about 7,600 triangles all told —
modelled in Blender by `tools/kit_build.py` and compiled to `src/world/kit.js`.
Still no binary assets: the models are code, and `kit.js` is what that code
produces.

Hull shells are modelled to fill the unit cube, because the runtime scales them
by a compartment's half-extents and those boxes are also the damage model's
raycast volumes. What you can see is still exactly what you can shoot.

Weapons are separate items, carried three ways, and the hull tables already said
which is which — `arc`, the traverse a mount has, is the whole taxonomy:

| carriage | when | what it is |
|-|-|-|
| turret | `arc >= 0.25` | barbette ring, rotating house, trunnions |
| gimbal | `arc < 0.25` | ball in a socket set into the plating |
| fixed | ordnance | tubes in an armoured fairing; nothing moves |

Each is assembled at runtime as a hierarchy that mirrors the machine — base,
train, elevate, gun — and the gunnery model drives it directly. `_syncMounts`
takes the one world vector the solver already decided on, `mount.aim`, and
decomposes it into the two angles the mount can physically make. Nothing is
animated independently, so the barrel cannot disagree with the shot.

That matters because the muzzle is now load-bearing: rounds spawn from the tip
of the barrel that fired, multi-barrel mounts alternate, and guns recoil on the
shot. A wrecked mount stops training and its barrel drops, which reads from
further out than any damage decal.

#### A gun cannot shoot through its own deck

`arc` is a symmetric cone about the rest bearing, and for a long time nothing
knew the deck was there: every mount aboard could swing its barrel down through
its own plating — the broadsides to 26 degrees below their ring, the point
defence to 42 — and the shot went with it.

A mount may now depress about five degrees below the face it is bolted to and no
further, which is roughly what a real barbette allows before the breech fouls
its own ring. It is applied after the traverse arc rather than before it: the
arc is authored, this is physical, and when the two disagree the metal wins. A
gun denied elevation stops at the plating rather than swinging off its bearing,
and `onTarget` then reports false on its own — nothing had to be told that a
masked gun should hold fire, because a masked gun simply is not pointing at
anything.

The consequence is real blind arcs under the keel, so the pilot had to learn
about them. It already rolled a contact onto the pitch axis — the strongest on
every hull — but it rolled to whichever side came first, and for a target abeam
that was reliably the ventral one: the ship turned to face a contact and masked
its own broadside doing it. It now rolls the contact onto the DECK. Same
manoeuvre, aimed properly.

#### A gun with nothing locked lays on the reticle

`arc` describes where a mount *may* point; something still has to ask it to. For
a long time nothing did unless a target was locked, and with no lock every mount
reverted to the bearing the tables bolted it down at — the MERIDIAN's lances
five degrees out to port and starboard, its broadsides twelve, its point
defence forty-odd. The reticle therefore described exactly one gun on the ship
and every other mount threw its rounds off at an angle, which reads from the
cockpit as half the arsenal being broken. Nothing was: the mounts could always
traverse and the clamp was always correct.

A mount with a live fire-control link and no target now lays on the boresight,
so the reticle means what it looks like it means. Losing the link is what drops
a gun back to its rest bearing, which is the state that should look like nobody
is telling it where to shoot.

The corollary is an authoring invariant, asserted in `selfcheck`: **every mount
must be able to traverse onto the boresight.** Two dorsal repeaters were aimed
up and *aft* — 135 degrees off the bow with a 75 degree arc, sixty degrees short
— so triggering the point-defence group fired a third of it into empty space no
matter what the ship was pointing at.

#### The field encloses the hardware, not just the compartments

`shield.radii` is derived, and it used to be derived from the compartment boxes
alone. That was true when a hull was a row of boxes. It is not any more: a
MERIDIAN mass driver is a twenty-seven metre machine on a hull twenty-eight
metres tall, it stands *on* the plating rather than inside it, and it swings.
The HALBERD's dorsal driver ended up two per cent outside its own ship's bubble,
where a round could reach it without the field getting a say.

The derivation now encloses each mount's traverse sweep as well — bounded by the
cone the arc actually allows, not by the sphere around the trunnion, because
treating a barrel as free to point anywhere trebles a ship's dorsal shield
radius to cover a position it can never reach.

#### Point defence has something to defend against

The repeater's stated job is shredding incoming torpedoes and it could not:
nothing tested a round against anything but ships, so a warhead once launched
always arrived. Aimed fire now kills ordnance in flight, which is the half of
the homing-weapon loop that was missing — and it makes the dorsal mounts worth
their tonnage rather than a worse broadside. Blast fragments deliberately do not
do this: sympathetic detonation would splice the missile array from inside the
loop already walking it, and one torpedo should not clear a salvo.

#### Doctrine is a property of the hull

The MERIDIAN put 130 MJ/s on its bow and 31 abeam. It was a pure nose-fighter,
it out-gunned the dreadnought forward, and it had the only MEDIUM-armoured bow
in the roster — 0.26 m of plate, thinner than the frigate a class below it —
on the one compartment that eats every round of a head-on pass, holding the
ship's only sensor. It had to nose in, everything landed on one facet, and the
first thing through was the array that let it see.

Its wings and both lances swing outboard now, with a second driver in each wing,
and its bow is heavy armour at 0.50 m. It fights beam-on: 31 forward, 61 across
24 to 105 degrees.

That immediately broke the roster twice over, and both breaks were instructive.

**A wide-arc ship beats a narrow-arc ship it can out-turn.** Rebuilt, the
cruiser beat the dreadnought four duels out of four without taking a single hull
hit — it simply stayed outside the BASTION's arcs. A dreadnought does not get to
be the second-best broadside in the fleet, so it got the same doctrine at its own
scale: eight more drivers, 76 MJ/s on a beam against the cruiser's 61.

**The pilot flew every hull as a nose-fighter.** With both big ships rebuilt,
each presented its bow and fought with the 31 MJ/s it could point forward
instead of the 61 or 76 it carried. `fightAspect` is derived per hull from where
its guns can actually point, and the pilot holds the target on that bearing.

The first version of that derivation took the EARLIEST bearing reaching maximum
weight, which for the cruiser is 24 degrees — one degree inside its arc limit.
The pilot dutifully sat on the stop and the guns fell out of train on every
overshoot: measured mid-fight, one of seven drivers bearing, 115 rounds away, the
enemy on 99% hull. It returns the centre of the band now, and the ships fight
where their guns are.

#### Point defence lays itself

A repeater is a director and a fast tracker whose entire job is killing
warheads, and it has to react quicker than any trigger a person is holding. It
leaves the player's selectable groups and the AI's triggers altogether and
engages inbound torpedoes on its own inside 2.6 km — and nothing else, because
every second spent shooting at a belt is a second with no defence against the one
weapon that opens three compartments at once. Three torpedoes inbound, no
triggers touched: all three killed, hull and shields untouched.

#### Sensors, fitted rather than dropped on the centreline

Every hull carried exactly one array, in the tip of the nose. The main array
still looks from where it has to, but rides high in the compartment rather than
on the axis a shot aimed at the ship's centre travels down; an auxiliary sits
deep amidships behind the belt, on a different power bus, with a smaller
aperture — `gain`, so a fallback lets a blinded ship fight rather than handing it
a free second array.

#### Nothing vital exists only once

The three utility networks were trees. Seventy nodes across the four hulls hung
off a single run each, so one round in the right compartment took a whole
branch — a cruiser's port battery, its fire control, its core cooling loop —
and nothing about that is how anything this size is built.

Runs are rated now. `cap` is what a conduit carries, 0..1 of full service, and
`_tickNetworks` is a widest-path search rather than a reachability flood: a
node's service level is the best any surviving route can deliver, and a route is
only as good as its narrowest run. Main trunks are 1. Emergency ties are thinner
cable or smaller-bore pipe laid down a different part of the ship and rated 0.45
to 0.6, and every hull now carries them — keel trunks, battery cross-ties,
casualty buses, coolant cross-connects.

So cutting a main no longer switches a branch off. It drops it onto the tie, and
everything on it runs derated: `eff` folds in the power level, coolant coupling
and loop rejection fold in the flow. Cut both of the MERIDIAN's forward trunks
and the bow does not go dark — it runs at 45% until somebody re-lays the main.
Cut the tie as well and *then* it is dark. Redundancy costs capability instead
of being free, which is the trade that makes it worth modelling at all.

`selfcheck` cuts every conduit on every hull in turn and asserts nothing that
needs service loses it. Two exemptions are marked `sole` and are deliberate: a
gun hoist is meant to be the single feed to its own turret, and a picket's one
computer is meant to be its weakness.

#### Holding a shield is cheap; working one is not

A shield used to be billed for how much charge it was HOLDING — `draw * (0.22 +
0.78 * held)` — plus the entire recharge budget levied whether or not a single
joule was actually being put back. So a full, quiet, undamaged field was the
most expensive thing on the ship: **407 MW of a cruiser's 770 MW rating,
forever**. The projectors also declare the largest heat load aboard, 1360 units
on the MERIDIAN against both reactors' 1180, and nothing scaled it, because
`shieldGen` is not a duty kind and `heatIn` therefore fell back to `eff`.

Reactors had the same gap: `eff` is a plant's *condition*, not its load, so an
intact reactor made full rated waste heat whether the ship was drawing 73 MW or
770 — despite the line above it promising "duty-proportional, so a drive at 20 %
throttle runs cool".

Together those meant an undamaged cruiser could not hold a steady state parked.
It settled at 98 °C, derated its own reactors to two thirds of rating and shed
the amplifiers that set its shield ceiling — **silently**, because charge and
ceiling fall together and the HUD reads their ratio, so it showed 100 % shields
while 54 % of the shield was gone.

Both are billed for WORK now. A shield's duty is `max(deficit, load)` — pulling
drained facets back up, and channelling what the emitters are absorbing — with a
floor for standing losses; a plant's duty is its output against its rating. The
shield's *capability* is untouched: capacity, regen, coupling and dissipation
are all the same numbers. Only what it costs to keep lit changed.

| MERIDIAN, undamaged | demand | supply | loop | ceiling | shed |
|-|-|-|-|-|-|
| at rest, shields up | 363 MW | 770 | 30 °C | 100% | 0 |
| cruising | 573 MW | 770 | 59 °C | 100% | 0 |
| firing everything | 668 MW | 770 | 58 °C | 100% | 0 |
| shield under fire | 518 MW | 770 | 39 °C | 100% | 0 |
| **all three at once** | **992 MW** | **704** | 63 °C | 100% | **8** |

Any one of the three is comfortable. All three together flattens the capacitor,
drops the bus to 0.87 and starts shedding — which is the moment the strain is
supposed to arrive.

#### Panels, not a fudge factor — and cooling is not a shield buff

The two big hulls could not reject what they made. Four wing radiators left the
MERIDIAN at 94 °C and 78% of rated output, and the BASTION at 110 °C and 80%,
parked and undamaged. They carry real panels now — dorsal and keel, spread fore
and aft — rather than a multiplier on the existing four, because a radiator is a
module you can shoot off and heat rejection that all lives on four surfaces goes
away together the first time somebody rakes the broadsides.

That immediately broke something else. Shield dissipation scales with heat
rejection, and heat rejection was an ABSOLUTE figure which every hull happened
to author to exactly 1.0 — so it doubled as "fraction of my panels still
working" and the two uses were indistinguishable. Fitting the panels took the
dreadnought's total to 1.88 and, through that one number, very nearly doubled
its shield dissipation: its fore facet went from saturating under four lances in
7.5 seconds to surviving four hundred.

They are two quantities now. `rejectCapacity` is absolute area and drives how
fast the loops shed, so bolting panels on genuinely cools the ship.
`rejectFraction` is how much of the designed complement survives, and that is
what shield dissipation is actually about — "strip a ship's radiators and its
shields saturate" is a statement about losing them, not about how many the
designer fitted. Saturation is back to 1.9 s and 7.5 s exactly, and shooting
half the panels off still takes it to 1.4 s and 4.8 s.

| undamaged, at rest | before | after |
|-|-|-|
| MERIDIAN | 94 °C, 78% of rating | 85 °C, 91% |
| BASTION | 110 °C, 80% of rating | 79 °C, 99% |

#### The shield gauge could not report its own damage

`shieldFraction()` is charge divided by the CURRENT maximum, and killing a
projector lowers that maximum — so charge and ceiling fall together and the
ratio stays pinned near 1. A cruiser that had lost both amplifiers, and with
them nearly a third of its shield, read as a completely healthy shield. The
gauge a player trusts most was the one gauge that could not report the damage.

The six facet bars are measured against the hull's RATED per-facet capacity now.
The lit part is charge; the dim part behind it is ceiling you no longer have and
cannot recharge into until the projectors are repaired. Same event, both
amplifiers gone: the old ratio still says 100%, the bars say 72%.

#### A cut run is a gradient, not a switch

A conduit was intact or severed with nothing in between, and that was invisible
until the network started carrying a service level. Then it produced something
plainly wrong: `repairModule` clears `destroyed` on the FIRST joule of work, so
a party touching a severed main trunk restored the entire branch to full service
at 0.2% of the cable's health. A cruiser's forward bus came back one second
after being cut, which made the cross-ties decorative and made cutting anything
pointless.

A run carries a fraction of its rating from its condition now — nothing until
the splice is holding, full only once the work is properly finished. Cutting
both of the MERIDIAN's forward trunks drops the bus to 0.45 on the tie, and
re-laying one walks it back up: 0.45 while the party is splicing, 0.83 at 57%
cable health, full at about ten seconds. It is also the honest answer for battle
damage, and it is what lets a network be *degraded* rather than only ever on or
off.

#### Every heat source is on a loop

Eighteen components across the four hulls produced heat and were wired to no
coolant loop at all — every sensor array, every point-defence mount, the torpedo
tubes, and on the light hulls the main battery, which is the single biggest heat
source on the ship. With nowhere to put it they equilibrated far above the
derate threshold on an *undamaged, idle* hull: the MERIDIAN's sensor suite sat
at 109 °C and 80% efficiency having done nothing at all.

That breaks the invariant `_tickCoolant` is built around and states outright —
that a hot reading always means damage, an overdriven duty cycle or a failing
loop, and never merely "this is a big ship". All eighteen are on a loop now, and
the sensors read 100% at rest on three of the four hulls.

#### The ship cross-decks to stay in the fight

A vented compartment can only be worked by the two suited damage-control
divisions out of eight — the other six cannot path into vacuum at all — and they
have to seal it before anything inside gets touched. That is correct, and it is
why a gutted battery can sit untouched with hundreds of hands still aboard.

What was missing is what happens next. A warship does not write off a battery
because the people standing in it were killed; it takes hands off a station that
can spare them. Without that, one hit that emptied a gunnery deck cost those guns
permanently, and repairing the mounts changed nothing because nobody was left to
lay them.

Three constraints keep it a decision rather than a free heal: the receiving
station has to be habitable, so sealing comes first; the donor has to be able to
walk there, so a cut-off section stays cut off; and a donor keeps 55% of its own
establishment, which is what makes it run out. Once no division is above that
floor there is no surplus and the ship fights understrength everywhere — the
point at which it stops being sustainable.

A starboard battery gutted, its gunnery division wiped out and the compartment
opened to space: sealed and every module rebuilt by five minutes, the station
back to 29 of 45 hands, and gunnery fitness settling at 66% because the ship had
lost 126 of its 420 people and spread what was left rather than leaving one
battery dead.

#### Damage control does not give up

A mauled ship with a full crew and full lockers has to be recoverable, or the
spares, the parties and the whole repair model are decoration. Modules already
rebuilt from nothing — a destroyed one costs its whole health bar in spares and
time, which is the intended "limping, with a chance". Two things were permanent
and should not have been.

The patch job was filtered on `s.breached && s.atmo > 0.03`, so a compartment
that finished venting was never worked on again. A bow array sat open for
twenty-five minutes with its plating already welded back to full, a four square
metre hole and two thousand three hundred spares in the lockers, and nobody
aboard would go near it. Vacuum is what the suits are for — and only suited
parties can path into one, so the job is scored and the pathing decides who can
take it.

And nothing anywhere restored `frameHp`. A buckled frame meant a compartment was
twice as slow to move through and counted against integrity for the rest of the
ship's life. Reframing is a job now, deliberately the slowest one aboard, and it
happens once the hull is shut.

Ten wrecked modules, two breaches and a buckled frame now recover in about seven
minutes for 280 spares.

#### Which side is open

An aggregate shield bar reading 60% is worthless: 60% with the fore facet
collapsed and 60% spread evenly are different ships in different amounts of
trouble, and only one of them should be pointing its nose at anything. The six
facets are named and read out individually — charge, saturation, and the CAUSE
when one is down, because an emitter that ran out of power comes straight back
and one that saturated will not until it has cooled. The rose at the reticle
keeps its glance-cue job and strikes a collapsed facet through, since colour
alone does not carry at four pixels while something is shooting at you.

#### The inside agrees with the outside

A compartment box is what the ballistics solver tests against; the shell is
inscribed in that box and tapers. Everything that has to touch the visible hull
goes through one measured table — `SKIN` in the generated `kit.js`, taken off
the built shells by the exporter, per face, at each end.

That table is what keeps the ship coherent in three places at once:

- **Modules.** The interiors are authored to the shells, not clamped to fit
  them. Re-shaping the hulls put fifty-eight modules outside the visible
  plating — bow sensors floating clear of a wedge, radiators and magazines
  hanging out of the sides of tapered sponsons — and each family was re-fitted
  to the form it now lives in rather than nudged until the numbers passed. Bow
  arrays became long and narrow on the centreline instead of wide slabs across
  a nose that no longer exists; sponson radiators became long thin panels that
  stop before the pod starts tapering; broadside magazines dropped low and
  inboard, which is where a magazine belongs anyway. `validate` then enforces
  it strictly, and throws at load rather than quietly moving anything — a
  silently relocated magazine changes what a shot into that sponson hits.
- **The cutaway.** Compartments are drawn to the shell's real profile instead of
  as rectangles, so the schematic stops claiming the bow is square while the
  ship outside is a wedge.
- **Shells themselves.** They are held to the box from the other side too. A
  drive bell hanging 42% of a compartment aft of it is hull you can see and
  cannot shoot, in a game where the repeater's entire job is shooting off
  radiators and sensor masts.

The shell-versus-box checks run in `npm test`; module containment is enforced
by `validate` at import, so a hull that no longer fits its own plating cannot
load at all.

Working out where a gun stands is the fiddly part, and `hardware.js` derives it
rather than making the tables repeat themselves. A face is scored on proximity
AND on being square to the gun's rest bearing: the nearest face to a broadside
battery is the bow face, and a turret bolted there would train about its own
barrels. The shells taper, so the mount is then stood on the shell's actual skin
rather than on the compartment's bounding box — the difference is metres at a
prow, and it is why the BASTION's tubes are on the hull instead of alongside it.

### There is no physics engine

The predecessor to this project used Rapier, because it needed jointed rigid
bodies for an active ragdoll and ground contact. In space there are no joints
and no ground. A 6DOF rigid body is thirty lines of semi-implicit integration
including the gyroscopic term, and every ray test is analytic against the hull
tables. Dropping the dependency removed 2.05 MB of WASM and the async boot, and
cost nothing — collisions fall out of the same machinery the weapons already
need.

### ECS boundary

The ECS owns exactly two things: the **ordered system schedule** for one
simulation step, and the **lifetime** of scene-scope entities.

```
10 intent      player input -> flight command
20 brains      AI pilots -> flight commands, then weapons for everyone
30 ships       systems + crew + control law + integration, per ship
40 collide     ship-vs-ship contact
50 ballistics  projectile integration + penetration resolution
60 fx          particles, streaks, flashes
70 targeting   contacts, lock, scan progress, HUD state
80 director    waves, wreck disposal
```

A ship's interior — the module graph, the three networks, the compartment
adjacency, the crew roster — is plain objects, not entities. It is a dense graph
walked every tick and gains nothing from archetype iteration.

The loop runs the simulation at a fixed 60 Hz *in wall-clock terms*, with
rendering decoupled at display rate. Time dilation shrinks the step rather than
thinning the steps out; scaling the accumulator instead means 0.12× runs the
world at 7 Hz and everything except the camera becomes a slideshow.

**Cost:** ~0.10 ms per simulation step with five ships fighting, measured in
Chrome. About 1% of a 60 Hz frame budget.

---

## The simulation

Everything below is mechanism. There are no damage numbers anywhere in this
project — no `damage: 40`, no `armour: 25`. Outcomes are what falls out.

### Ballistics is an energy budget

A round carries joules, derived from real mass and velocity (`E = ½mv²`). Each
layer along its path costs joules to cross:

* a compartment wall costs `thickness × material resistance ÷ cos θ`, so
  striking at an angle presents more material and flanking is a ballistic
  variable rather than a flavour note;
* a component costs the length of the chord through it times its material.

Whatever a layer absorbs is exactly the damage it takes. *"The round stopped in
the port magazine"* and *"the port magazine absorbed 1.9 MJ"* are the same
sentence. When the budget reaches zero the shot is spent, inside whatever
drained it. When it does not, the round carries on — through the far wall and
out of the ship.

A shallow strike that cannot make it through **ricochets** instead of burying
itself, keeping most of its energy and going somewhere else.

### Ammunition is the real choice

Three natures of round, all magazine-fed guns aboard loading the same one. They
modify the *same* projectile through the *same* solver:

| | solid shot (AP) | high explosive (HE) | delay fused (SAP) |
|-|-|-|-|
| penetration | 0.55× cost | 2.8× cost | 1.0× |
| fuse | none | on contact | after 2 walls |
| coupling time | 1× | 9× | 3× |

Eight seconds of identical fire from identical guns into an identical HALYARD:

| round | hull | compartments opened | destroyed | power left |
|-|-|-|-|-|
| **AP** | 0.61 | 6 | reactor, main trunk, sensors, both shield projectors, quarters | **0 MW** |
| **HE** | 0.87 | 1 | nothing | 24 MW |
| **SAP** | 0.76 | 2 | both drives + the drive coolant loop | 24 MW |

The mechanism behind AP's result is **perforation**: a round that fully crosses
a wall punches a hole in it *regardless of how much plate health remains*, and
that compartment is open to space until a crew member welds it shut. Solid shot
is therefore not "more damage" — it is a systems attack that leaves a line of
decompressed compartments and severed runs across the ship, which the crew then
have to cross to repair anything.

An emergent consequence nobody designed: an AP burst starts **no fires at all**,
because it vents every compartment it passes through and vacuum will not burn.
HE leaves the ship pressurised, so HE leaves it flammable.

### Shields are an energy system, not a pool

A facet has **charge** (field energy, bought with electrical power) and **load**
(absorbed energy awaiting dissipation). How much of a hit the field can catch
depends on the hit's *instantaneous power* — joules divided by the time the
round takes to cross the field:

```
absorbed fraction = 1 / (1 + (E/dwell ÷ coupling)^0.35)
```

That single expression produces the entire weapon roster's relationship to
shields, with no per-weapon "shield multiplier" existing anywhere:

| weapon | delivery time | shield catches |
|-|-|-|
| beam laser | continuous | 85% |
| pulse laser | 20 ms | 63% |
| plasma | 5 ms | 46% |
| autocannon | 2.1 ms | 40% |
| mass driver | 1.2 ms | **15%** |

Two distinct, physical failure modes follow, and they need different fixes:

* **COLLAPSED** — charge exhausted; the reactor could not keep the field lit.
* **SATURATED** — load exceeded what the emitters can shed.

Dissipation is bought from the *same radiators that cool the drives*. Under one
sustained beam laser, a HALYARD's fore facet holds indefinitely with its
radiators intact and **saturates in 2.5 seconds** without them. Stripping a
ship's radiator panels is therefore a legitimate and non-obvious way to take its
shields down without ever shooting at them.

A facet under sustained fire also gets progressively *worse* at its job: as load
builds, coupling falls, so leak-through climbs (measured: 15% → 27% over 30
seconds). The shield degrades into transparency rather than switching off.

Impacts light the field where they land, and fade.

### Three networks, one solver

`power`, `data` and `coolant` are one undirected flood-fill each, seeded from
intact sources and spreading across intact conduits. Conduits are modules — you
can shoot them.

That single routine gives every hull its own failure character with no
per-ship code:

* the **HALYARD** runs two parallel routes forward; cut one and nothing happens,
  cut both and the whole bow goes dark;
* the **BASILISK** wires its buses as a *ring*, so any single cut is survivable
  and the right *pair* shuts down a broadside;
* the **SHRIKE** has one trunk and no redundancy at all.

Dependencies are declared, not hard-coded. A pump with no power moves no
coolant even through perfect pipes — which is why killing a ship's power can
boil it. A gun with no *data* link is not dead; it drops to boresight, because
nothing is telling it where to shoot.

Measured cascade — cutting one HALYARD coolant pipe:

```
+0s   reactor  84 °C   eff 1.00   supply 24.0 MW
+5s   reactor 145 °C   eff 0.33   supply  7.9 MW   computer 101 °C
+15s  reactor 158 °C   eff 0.20   supply  4.8 MW   computer 118 °C  (latches at 128)
```

### Power is a budget with load shedding

Reactor output versus demand, buffered by the capacitor bank. Machinery draws
when it is *doing* something — a drive at rest and a gun not cycling are hotel
load — so a plant that cannot run everything at once is normal rather than a
fault, and boosting while firing everything browns you out. When the budget will
not close, the computer sheds strictly by priority: shields go before the drives,
the drives before life support.

Heat exchangers are sized to the load they were built for, so at design duty a
34 MW fusion plant and a sensor mast settle at the same temperature above their
loop. A hot reading therefore always means damage, overdriven duty or a failing
loop — never "this is a big ship".

### Atmosphere, fire and the vent

Compartments hold air. Breaches vent it at a rate set by hole size and volume.
Fire needs oxygen *and* spilled fuel, consumes both, heats the local coolant
loop, burns through soft goods (conduits — so fire costs you a network) and
spreads only into neighbours that have air and something to burn.

`B` blows the emergency vent on the worst fire aboard. It goes out instantly,
because there is nothing to burn. So does anyone still in the compartment.

### Crew

Crew are not meshes and not hit boxes. They are a position in the compartment
graph, a job, and a life.

* They **walk**. Routes are shortest paths whose edge costs rise with fire (4.5×),
  vacuum (1.9× and only in a suit; unsuited crew simply will not go), buckled
  frames (2.4×) and heat. Wrecking the middle of a ship strands the
  damage-control party on the wrong side of it.
* They **triage**. Distance is part of the job score, not a filter — a fire next
  to a magazine outranks everything, but a small job next door beats a big job
  three burning compartments away.
* They **die**. Vacuum, fire, heat, and compartments blown open around them.
* They are **why repair exists**. Nothing self-heals. Every point of health
  restored was carried there by someone still breathing, out of a finite cargo
  of spares.

Losing people costs capability directly: an empty helm means the flight control
law loses its pilot gain and the ship wallows; an empty gunnery station costs
turret quality; damage control with its data bus cut works at 55%.

### Flight

**Control authority is derived, never authored.** A hull table says how fast the
ship should turn and how long its thrusters should take to get there; the torque
follows from the inertia tensor, and the linear thrust from the mass and a
target acceleration time. Authoring those by hand is how the first pass went
wrong — plausible-looking numbers implied a 2.2-second spool on the HALYARD's
pitch axis, which reads to a pilot as a ship that simply will not turn. Now
resizing a compartment cannot silently wreck the handling, because the torque
moves with the mass.

|  | 0 to top speed | full stop | 180° turn |
|-|-|-|-|
| SHRIKE | 2.4 s | 3.2 s | 1.4 s |
| HALYARD | 3.2 s | 3.9 s | 2.0 s |
| BASILISK | 4.5 s | 5.1 s | 3.2 s |

Flight assist is a **rate-command** loop — the stick asks for an angular
velocity and the controller spends whatever torque it has to hold it — plus a
velocity-matching loop pulling the ship's actual velocity toward "throttle
setting along the nose". Switch it off and you get the honest Newtonian ship
underneath, which is why the HUD draws your velocity vector.

Damage enters as *authority*, per axis. A ship with its port roll jets shot away
does not fly generally worse; it rolls one way and not the other. Flight assist
*is* the flight computer — lose it and you are flying manually whether you
wanted to or not.

Manually, but not helplessly. With the computer gone `X` becomes **manual
helm**: nobody aboard can solve a three-axis velocity correction in real time,
but a crew can read the drift, swing the ship until retrograde is under the nose
and burn. So the main drive only bites to the extent you have already pointed it
the right way, the jets give a weak push in any direction, and the whole thing
is scaled by who is still at the helm — a bridge with its watch dead cannot do
it at all. Fifty metres per second takes about fifteen seconds to kill this way,
against a computer's four.

The two capital hulls carry that redundancy properly: a second computer in a
different compartment *and* a second helm run down the other side of the keel,
either of which can drive the helm alone. It takes two hits in two places to put
a cruiser out of control. A frigate has one of each, and feels it.

Mass and the inertia tensor are derived from the compartment boxes by the
parallel axis theorem, so every hull genuinely rolls more easily than it pitches
and nobody hand-authored a plausible number.

### Targeting

### The hostile pilot

The AI writes into the same command struct your stick feeds, so it flies the
same physics with the same damage penalties — an AI ship with its bow RCS shot
off pitches badly for the same reason yours would.

Steering errors are **angles**, not raw axis components. A component-based error
is ill-conditioned when the target is behind you (both lateral components go to
zero at the exact rear even though the error is 180°), which is what makes a
naively-steered AI flail the moment it overshoots.

The engagement is built to be *fightable*. Rather than merging, overshooting and
coming round again — which never gives either side sustained time on target —
the AI holds a standoff range with a proportional-derivative controller on the
gap. Measured against a stationary target it closes from 2.6 km, settles at
~550 m, and holds 0–1° off boresight indefinitely, with a closest approach of
470 m against a 22 m ramming distance.

A crippled ship fights a **withdrawal, not an exit**: it breaks contact, turns
and holds at ~1.7 km with its guns working, comes back if the crew get it flying
again, and — if running has not worked after ~34 seconds — commits to a last
stand and closes back in. A ship that simply runs at full boost forever is
unkillable and unfun; it turns every engagement into a stern chase you cannot
win.

### Targeting

Elite's radar, because Elite's is right: a disc showing bearing and horizontal
range, with a vertical stalk giving relative elevation. Three dimensions at a
glance, and unlike a perspective scope it stays legible when a contact is
directly above you.

Lock is a *process*. A scan takes time, the time depends on your sensor array,
and only a completed scan opens the target's interior for subsystem selection.
Shooting the sensors off a ship is therefore not just a way to blind it — it is
a way to stop it picking *your* components apart. Seekers track the locked
subsystem rather than the hull.

---

## Tests

```bash
npm test
```

81 assertions, no framework, about a second. They drive the real `Systems` and
`Crew` classes with no renderer attached and cover the things that are expensive
to notice by flying around: network redundancy on each hull, load-shed ordering,
the shield coupling curve and both of its failure modes, the radiator-to-shield
coupling, perforation and decompression, fire needing air, magazine cook-off,
crew repair and pathing, and the capability read-outs.

The hull tables also self-validate at import: every conduit endpoint and declared
dependency must resolve, compartments may not overlap (they would double-charge
bulkheads in the penetration walk), and components must fit inside the
compartment that owns them. A typo is a thrown error at load, not a mysteriously
dead subsystem at minute nine of a fight.

Three of these tests were written after the behaviour they check was found
broken — most usefully, a shield facet that went down could never come back,
because coming back required charge and downed facets were excluded from the
recharge pool.
