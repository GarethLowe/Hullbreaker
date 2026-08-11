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

#### A gun that cannot bear holds its fire

The other half of that clamp went unread for just as long. A mount pinned
against its traverse stop still fired every time the trigger was held, because
`updateWeapons` asked whether the group was triggered and never whether the
barrel had arrived. Point the MERIDIAN at something and its entire off-side
battery emptied itself into space: eight repeating drivers at 240 rpm is about
three hundred rounds per ten seconds of held trigger, bought by the player and
guaranteed to miss.

The test is aim against the *solution*, never against the target's position. A
gun correctly leading a crossing target is deliberately not pointing at it, so
comparing the two would hold fire exactly when the shot is good. `_bears`
compares `mount.aim` — where the barrel has actually slewed to — against
`mount.want`, the unclamped demand recorded before the arc clamp, and widens the
tolerance by the target's angular size, because the same error is a hit on
something big and close and a miss on something small and far.

The effect on a hull built around a broadside, ten seconds of every trigger held:

| target bearing | mounts bearing | rounds fired |
|-|-|-|
| dead ahead | 3 of 13 | 11 |
| 65° off the bow | 5 of 13 | 93 |
| abeam | 5 of 13 | 90 |

Which is the ship telling the truth about its own doctrine. Ammunition is now
spent by pointing the hull the right way rather than by holding the trigger, and
the gun that stays quiet is not broken — it is out of arc, which the mount list
already says.

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

#### The dreadnought carried enough; it could only use it through six degrees

Those eight extra drivers did not survive. At 4.7 deg/s of yaw the BASTION never
reached the 71 degree aspect its own guns then wanted, held 34, and brought two
of fifteen guns to bear — so they were pulled and the four wing turrets were
given 76 degree arcs instead. That fixed the doctrine and left the real problem
standing: the wings *rest* at 70 degrees, so their two cones overlap across five
degrees of bow. The hull carried 104 MJ/s against the cruiser's 75 and could use
all of it through a **six degree window**. Twenty degrees off the nose it was on
36 MJ/s, two guns of seven, and it stayed there all the way aft.

Four rapid-fire mounts now sit on the dorsal shoulder resting at 38 degrees with
the same 76 degree arc, so port and starboard overlap across seventy-five degrees
instead of five. Every one of them bears dead ahead, so `fightAspect` stays at
3 degrees and the pilot's doctrine does not move — which is precisely what
separates this from the reverted experiment. The same four guns on the wing
bearing give an identical peak and a third less weight everywhere the hull is
actually pointed.

Measured against a paired control at identical seeds, 240 duels a side:

| | before | after |
|-|-|-|
| W‑L‑D | 180‑8‑52 | 223‑3‑14 |
| stalemates | 21.7% | 5.8% |
| median time to kill | 115 s | 66 s |
| throw weight on target | 100.5 | 181.8 MJ/s |

**The story that came with it was wrong, and that is the more useful half.** The
obvious reading of a six degree window on a hull that needs twenty seconds to
swing a quarter turn is that a good pilot parks on the shoulder and farms it. It
does not survive measurement. Flown deliberately for the beam, at full thrust,
starting already established on station, a MERIDIAN holds a mean bearing of
**8.1 degrees** and never once reached 70 in forty attempts: at four kilometres
its 92 m/s buys 1.35 deg/s of bearing against 4.70 deg/s of yaw. The shoulder is
not purchasable, and the geometry that would make it purchasable is inside a
kilometre and a half, where the dreadnought's own range-hold will not go. The
battery earns its place on plain weight of fire at the bow, where the fight
actually happens — it wins what it was already winning, faster, and its share of
*decided* fights barely moves.

Two drafts of the fitting were wrong before this one, both caught by
instrumentation rather than by reading:

- At 52 MW a mount the four of them drew 152.7 MW sustained, and since
  `_tickPower` sheds in ascending priority — shield capacitors at 3, generator
  at 4, guns at 6 — the ship began **shedding its own shield to feed its guns**
  above half throttle. It escaped only by running out of ammunition first, which
  is not a margin. At 34 MW nothing sheds in 1.4 million frames.
- Moving the forward pair onto `l.fwd` read better on paper and measured worse.
  `l_batF` is a run *from* `l.fwd`, so it put six of the nine guns behind one
  parent and total gun-offline time went up. Those trips were never steady-state
  heat — every loop sits in the low twenties all fight — they are severed runs
  and dead pumps in the one duel in eight where the ship is badly hit. The answer
  to battle damage is two parents and a cross-tie, which the hull already had.
  Cut any single coolant run now and no gun goes offline at all.

#### Point defence lays itself

A repeater is a director and a fast tracker whose entire job is killing things
already on their way, and it has to react quicker than any trigger a person is
holding. It leaves the player's selectable groups and the AI's triggers
altogether and lays itself: inbound ordnance out to 2.2 km, and — once nothing
is inbound — any hull inside 3 km. Ordnance always wins the argument; a mount
tracking a ship drops it the instant a warhead enters its arc.

The two bands differ because the gun does. It throws a 5 mrad cone: at three
kilometres that is fifteen metres of scatter, which is a hit on a hull and a
wasted magazine against a three-metre warhead. A director holds its fire on
ordnance until the solution is worth the ammunition.

Every ring feeds from its own ready-use locker, never a gun battery's. A
director cycles at 520 rpm in bursts nobody schedules, and sharing a magazine
with a weapon that has to last the engagement means that weapon runs dry for
reasons its crew cannot see.

See **A ring, not a roof** below for what the mounts cover.

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

#### An arc may not set off the magazines

`_tickArcing` promises in its own comment that it "degrades a ship without ever
finishing one" — small per-tick energy, critical fittings immune. It did not
keep that promise: its victim could be a MAGAZINE, and a cook-off dumps the
whole stowed charge into the compartment, wrecks the frame from inside and takes
everything sharing the space with it.

Measured over four hundred trials, a severed cable detonated a magazine on its
own in 2.8% of runs, costing up to 13% of the hull with nothing fired at the
ship. That is not a secondary effect, it is a coin flip deciding the fight, and
it was the cause of the one long-standing flaky assertion in the suite.

Ordnance is excluded from arcing now. Six hundred trials, no cook-offs, worst
hull loss 0.0000. Fire still reaches magazines — `ignite` is untouched, so a
burning compartment cooks off through the thermal model, where the crew get a
chance to fight it.

#### A ring, not a roof

A mount cannot depress below the deck it is bolted to — five degrees, which is
about what a real barbette allows before the breech fouls its own ring. That is
a fact about machines, and it means a ship carrying nothing but dorsal repeaters
is *completely open from underneath*. Every hull here was. A torpedo run from
below arrived unopposed against all four.

Point defence is now fitted as rings: one director on each of a compartment's
four long faces, trained thirty degrees out from the hull and sixty along it,
with a second ring on a well-separated compartment trained the other way. Eight
bearings cover the whole sphere with overlap to spare, and splitting them across
two compartments means one round through a spine does not leave the ship blind.

| | directors | sky covered |
|-|-|-|
| **SABRE** | 2 | 55% |
| **HALBERD** | 8 | 100% |
| **MERIDIAN** | 8 | 100% |
| **BASTION** | 12 | 100% |

The picket is the deliberate exception: no deck space for a ring, no plant to
run one, and real blind arcs. That is the class.

The bearing is not decoration. `mountFrame` picks which face a gun is bolted to
by asking which one it is most nearly *square* to, so a director authored to
point straight out of its own plating gets seated on the wrong face and trains
about its own barrel.

#### Directors track one thing each

Every mount picking the nearest warhead meant a ring of eight stacked on the
leader of a salvo while the rest arrived untouched. A second director now joins
a warhead another is already on only when the next threat out is more than 900 m
further away, so salvos split the battery and a lone torpedo gets all of it.

Getting this wrong the first way was instructive: folding the doubling-up
penalty into the *range* budget rather than using it to rank candidates meant
the fourth director to look at a lone torpedo scored it 2700 m past where it
actually was, decided it was out of reach, and went off to shoot at the ship. A
ring of eight engaged with three and everything got through.

What the fit is worth, measured. A HALBERD with all eight directors up shot down
seventy seekers and nine torpedoes for nothing through. With its directors
wrecked, the same frigate took every torpedo fired at it, lost half its plate and
finished with eight compartments open. **A complete ring beats ordnance, and the
answer to one is to break it** — the cutaway shows you where the mounts are. A
BASTION leaks about half the seekers thrown at it even with all twelve up,
because a 380 m hull cannot bring three rings to bear on one bearing.

#### Seekers steer by sight-line rate, not by prediction

The old guidance was lead pursuit: work out where the target will be, point at
it, repeat. That is stable against a stationary target and hopeless against a
manoeuvring one, because the aim point moves every frame and the seeker spends
its whole turn budget chasing an error it re-creates.

Proportional navigation steers to null the *rotation* of the line of sight. If
the bearing to the target is not changing, the two are on a collision course
whatever either is doing — so a seeker on a good intercept flies almost straight
and has its entire turn rate left for the moment the target breaks. Four lines
of vector algebra, and it is what every real missile since the 1950s uses.

It is also easy to implement in a way that looks right and misses every time.
The first pass rate-limited the *nose*, lerping the heading toward the commanded
one by `turnRate * dt` each frame. That sounds equivalent and is not: the
commanded heading is only a couple of degrees off the current one by
construction, so the lerp clipped every command to about a sixteenth of the
demand. Measured, the seeker sailed past a stationary picket at 250 metres,
every single time, with the guidance apparently working perfectly. The turn
limit belongs on the *velocity vector* — `min(accel × maxTilt, turnRate × speed)`
of lateral acceleration — and `selfcheck` now asserts miss distances rather than
trusting that the maths looks correct.

#### The seeker rack

A new ordnance class, because a torpedo cannot answer a ring of directors.

| | mass | speed | turn | warhead | guidance |
|-|-|-|-|-|-|
| TORPEDO TUBES | 4,000 kg | 620 m/s | 0.34 rad/s | 450 MJ | command, tracks the locked *subsystem* |
| SEEKER RACK | 260 kg | 1,400 m/s | 1.07 rad/s | 65 MJ | active, finds its own target |

The head runs two channels and the difference between them is the character of
the weapon. **Infrared** scores a contact by how hot it is — drives at burn, a
reactor under load, fires aboard — so it will leave a cold dreadnought coasting
and chase a picket that just lit its engines. **Optical** scores by angular size,
so it takes the biggest thing in frame, cannot be dimmed by shutting anything
down, and cannot tell a wreck from a warship. Whichever gives the stronger return
wins, and the head looks again whenever it loses what it had.

Both racks ripple. A single warhead against a full ring is a donation, so the
tubes empty at two-second intervals and the rack at four rounds a second — a
dozen in the air inside the time one of them takes to cross three kilometres,
which is more than a ring can lay on at once.

Toughness is per-weapon and it is not body size, it is how much of a near miss
the thing does not survive. A seeker is a thin-skinned 260 kg vehicle carrying a
lens: anything within 6 m ends it. A torpedo is four tonnes with structure around
the warhead and wants very nearly a direct hit at 3 m.

#### Four layers make an explosion

The old one was a spray of orange dots and a light. An explosion needs all four
of these or it reads as a puff:

- **flash** — the light it throws on everything around it
- **wave** — the fireball as a real expanding volume that thins into a shell
- **particle** — incandescent gas, embers, and smoke
- **chunk** — lit, tumbling, solid pieces of the thing that came apart

Two of those needed new machinery. Fragments are an `InstancedMesh` of jittered
icosahedra — one draw call for every piece of debris in the world, each tumbling
under its own angular velocity. Blast fronts are a small pool of shader spheres
that start opaque and boil, then thin to a luminous rim.

Smoke got its own pool, and the reason is worth writing down: it is the only
thing here that has to make the scene *darker*. Everything else an explosion
emits is light being added to the frame, which is what additive blending is for.
An additively-blended dark grey is not dark at all — it is a grey glow — and
with a reactor throwing hundred-metre clouds the whole blast came out as a field
of soft white bokeh with a fire in the middle of it.

Impacts got the same treatment. An over-penetration blows the inside of the
compartment it crossed out through the exit hole, along the round's own line; a
contact-fused shell throws a hemisphere of fire and stripped plate back off the
plating it burst on; an entry wound spits some of the hole back out of the hole.

Everything is sized in tens of metres, not metres. A point's screen size is
`psize × 320 / distance`, so a one-metre puff on a hull 200 m away is two pixels
and on one 2 km away is a third of a pixel — every damage effect in the file was
authored at hull-detail scale and was therefore invisible at the range the game
is actually fought at.

#### Debris is culled by what you can see, not by a timer

A wreck should still be a debris field when you come back to it, and "the
wreckage evaporated while I was looking at it" is the specific thing that makes
a kill feel cheap. A fragment lives until it is more than 5 km from the camera or
has been out of view for a continuous 30 seconds. The pool is finite, so a fresh
fragment recycles the oldest slot when every slot is live — that is the backstop,
not the mechanism.

Impact debris is gated on the round being a real penetrator for exactly this
reason: a repeater perforating a radiator a hundred times a second would
otherwise own the whole pool inside four seconds, and the pieces that matter —
the ones a wreck is made of — would be evicted by shell splinters.

#### Sound is four layers too

There is no air out here, so nothing you hear arrives through it. What the crew
hear is structure-borne: the recoil of their own mounts up through the deck, a
slug arriving as a hammer blow on the plating, a magazine letting go somewhere
forward as a shock through the frames. That is a specification, not a licence —
every sound is built the way a real transient is.

**Crack**, the first two milliseconds, broadband and gone: what tells the ear how
big and how close a thing was, and what a pure oscillator blip has none of.
**Body**, the event itself, filtered noise sweeping downward as the energy
spreads. **Thump**, a sine falling from a hundred hertz to twenty — felt more
than heard, and the entire difference between a gun and a beep. **Ring**, a
convolution tail, because a warship is a very large bell and it is being hit.

Distance dulls it through a low-pass, which is the strongest cue the ear has for
how far away something big is; the whole mix goes through one compressor, so a
broadside is loud rather than a clipped mess; and point defence is rate-limited
to one report per burst, because a hundred separate reports a second is not a
sound, it is a fuzz that eats the voice budget.

#### The repeating driver

The PLASMA ACCELERATOR was worst in class on every axis that mattered — 8.7 MJ/s
against the mass driver's 13.5, less shield load than anything but a lance, and
14 MJ through a wall where the driver put 38. Its `special: 'plasma'` flag was
dead config nothing read. It has been replaced rather than tuned.

| weapon | MJ/shot | rpm | MJ/s | shield load/s | facets/min | through a heavy belt |
|-|-|-|-|-|-|-|
| MASS DRIVER | 40.6 | 20 | 13.5 | 41 | 7.0 | **38.1 MJ** |
| REPEATING DRIVER | 5.7 | 240 | **22.9** | **50** | **8.7** | **−1.9 MJ** |
| ION PROJECTOR | 60.0 | 12 | 12.0 | 36 | 6.2 | 60.0 MJ |
| BEAM LANCE | 0.2 | — | 12.0 | 14 | 2.5 | — |

The most sustained output in the fleet and the fastest shield-breaker in it,
and it cannot get through an intact heavy belt at all — a round costs more to
cross one than it carries. It strips the plate first and only reaches anything
vital once the plating is spent, because `wallCost` falls with the plate's
condition. It does not defeat armour, it wears it away.

It wears the three-barrel pulse model, which nothing was using. Weapons may name
an `art` fitting to borrow — the kit is generated from Blender by
`tools/kit_build.py`, so a new gun borrows a model until someone builds it one.
Geometry and muzzle points are looked up through the same key, since taking
barrels from one model and firing points from another puts the shot beside the
barrel; `selfcheck` asserts that pairing, and the shield derivation reads muzzle
reach through it too — by weapon id it silently fell back to a two-metre stub
and would have left real barrels outside the ship's own field.

#### A field stops things; what it costs is dissipation

The shield model decided how much of a hit leaked through from the round's
instantaneous power against the facet's coupling — and the numbers made a
charged shield very nearly transparent to the weapon most likely to be pointed
at it. Measured on a FULL fore facet:

| round | energy | power | through | stopped |
|-|-|-|-|-|
| driver / AP | 40.6 MJ | 17.6 GW | 29.1 MJ | 28% |
| driver / HE | 40.6 MJ | 2.0 GW | 22.0 MJ | 46% |
| plasma | 20.0 MJ | 3.3 GW | 11.8 MJ | 41% |

Against a bow wall costing 2.5 MJ to cross, a single armour-piercing round went
through the shield, through the plate, and opened two compartments — with the
facet still reading full. The whole facet held 43 MJ, less energy than one round
carried, and there was an assertion enshrining it: *a shield never fully stops a
slug*.

The field blocks what it can pay for now. What it stops has to go somewhere, and
that is the real cost: charge to hold the impact, and heat the emitters must
then shed. Delivery time still decides everything, on the other side of the
ledger — the same joules arriving as a hypervelocity spike load the emitters
three times harder than a lance pouring them in slowly. **A slug is not hard to
stop, it is hard to dissipate.**

So the counter to a shield is weight of fire rather than a magic round type. You
drain the charge or you saturate the emitters, and only then does anything reach
the hull — which is what makes the facet read-out worth looking at. A charged
facet now stops a driver round outright and gives out after about six of them; a
spent one is no barrier at all.

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

#### A wrecked store still has something in it

Spares are inert boxes on shelves, not machinery, and a destroyed bay held
literally nothing. The SABRE carries its whole 260 units in one hold, so a
single round through it ended that ship's ability to repair anything at all,
permanently — the parties kept taking jobs, finding nothing to work with,
dropping them and walking back to station, which from the panel looks exactly
like a crew standing idle while the ship falls apart.

A wrecked bay keeps 40% of its stock now, lying in the compartment where anyone
can pick it up. Running your stores down over a long engagement is the
interesting failure; having them deleted by one hit was the arbitrary one.

#### Welding depends on the plate, not the size of the room

Closing a breach cost `plateMax / 12` joules per square metre — the
compartment's total HULL POINTS, which has nothing to do with welding a hole. A
big room was slower to patch than a small one made of identical plate, and a
dreadnought's compartments were glacial purely for being large:

| | slowest compartment | fastest |
|-|-|-|
| SABRE | spine, 4 s/m² | podR, 1 s/m² |
| MERIDIAN | spine, 23 s/m² | batteryRA, 10 s/m² |
| BASTION | spine, 51 s/m² | batteryRA, 23 s/m² |

A 7 m² hole in a cruiser's engineering bay was the better part of twenty minutes
with six hands, which reads from the panel as parties queuing. Thickness is what
a welder actually fights, so that is what it costs now — calibrated to leave the
MERIDIAN unchanged, give the dreadnought a quarter of its time back and cost the
picket, whose plate really is thin, a little.

#### Walking to a job is not doing it

Damage control dispatches to every open compartment at once — that was never the
problem. But crossing a breached, airless compartment costs about fifteen
seconds a hop, so a hole two compartments away sits untouched while its parties
walk, and the panel called them WELDING the whole time. It says `→` until they
arrive, and will show both rows for one job when some parties are on site and
others are still coming.

```
GUNNERY FORWARD  55/55  FORWARD BATTERY  MOVING 8/9
   →     FORWARD HOLD                4.0m²   49
DAMAGE CONTROL A 65/65  MAIN SPINE       PATCH 11/11
   WELD  MAIN SPINE                  3.7m²   65
```

Three compartments open is also an all-hands emergency now, not a gunnery
problem: the station watches turn out and leave a skeleton, on the same rule
that empties a wreck's posts.

#### The roster says what each party is on

With divisions split into parties, one state per division stopped meaning
anything: "STATION" covered both "nothing to do" and "eleven parties spread over
six compartments" equally badly. Each division now lists what its parties are
severally working, grouped by job so eleven parties on four jobs read as four
lines, with the fitting named and the hands on it.

Each line carries how far along it is, in the unit the job is actually measured
in — a breach reports the square metres still open, a repair reports condition —
and the panel foots with how much hull is open in total, so "everybody is
patching" finally has a denominator.

```
GUNNERY PORT      42/45  PORT BATTERY FWD   REPAIR 8/8
   WELD  PORT BATTERY FWD                  4.3m²   16
   FIX   PORT FWD FEED                       35%   11
   FIX   PORT ROLL JETS                       5%    5
   FIX   PORT RADIATOR FWD                    4%    5
DAMAGE CONTROL A  65/65  MAIN SPINE         MOVING 11/11
   WELD  MAIN SPINE                        4.3m²   30
   WELD  FORWARD HOLD                      5.0m²   18

HULL OPEN — 6 compartments, 27.5 m²
```

Twenty-two parties on patch duty turns out to be six holes with three parties on
each — the crowding spreading them exactly as intended — plus twenty-one more on
repairs. That was always what was happening; there was simply no way to see it.

#### Damage control works in parties, not as a mob

A division is an establishment — a name, a trade, a station and a headcount —
and it was also, wrongly, a single body of people who all walked to the same
hatch. One division took ONE job, and `HANDS_PER_JOB` capped it at fourteen, so
a seventy-hand division put fourteen onto a repair and the other fifty-six stood
at their post. Measured on a cruiser with seventeen outstanding jobs: three of
eight divisions tasked, **forty-two hands working out of four hundred and
twenty**.

The working unit is a party of about six now. A division owns several, each with
its own position, route and job, and the scoring discounts a job by the hands
already on it so parties spread across the ship instead of all converging on
whatever scored highest. The same cruiser, same damage: **163 hands working, 28
parties, six compartments**.

A tick solves each shortest path once and shares it between every party standing
in that compartment, which is what keeps seventy parties affordable.

#### A wreck turns its crew to recovery

Holding a post is right while the ship can still use it — a gunnery deck that
leaves its mounts stops shooting, and a bridge that wanders stops steering. On a
hull shot to a standstill it is exactly wrong: a disabled ship sat with its
engineering watch at a station that no longer did anything while the hull span
and two damage-control divisions tried to recover it alone.

Once the ship cannot manoeuvre, or has lost half of what it is made of, each
station keeps a skeleton and the rest turn to. A HALBERD shot to a standstill
now puts **27 of 30 parties and 161 of its 180 hands** onto recovery, with one
party still standing on every habitable post. A station that is on fire or open
to space is abandoned outright, which is also correct.

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
Fire needs spilled fuel *and* oxygen, consumes both, heats the local coolant
loop, burns through soft goods (conduits — so fire costs you a network) and
spreads only into neighbours that have air and something to burn.

**Fire is an internal problem, not a space problem.** A compartment open to
space does not burn — it has nothing to burn *with*. That is the rule, and the
interesting part is that it arrives on the compartment's own draining clock
rather than the instant the plate fails. A bay holed a second ago still has its
atmosphere and catches perfectly well; a big compartment with a small hole holds
pressure for a while, and those seconds are exactly when flame is visible from
outside, roaring out of the wound. Then it gutters as the room empties, and once
empty it will not catch again however much is still on its deck.

Both halves are load-bearing. Testing the *hole* rather than the *air* removes
fire from the game almost entirely, because the round that spills something
flammable is usually the same round that opens the bay: measured, a cruiser
under three hulls for forty-five seconds never had more than two compartments
alight. Testing the air gives 0–3 burning at a time and eleven of fourteen
compartments alight at some point over that fight — a recurring event rather
than either a blanket status or nothing at all.

It also means fire concentrates in the parts of a ship that are still intact,
and a hull that has been comprehensively opened stops burning. Shooting a
compartment open is itself an answer to the fire in it.

Gunfire has to be able to start one, too. Nothing aboard is empty space —
hydraulic runs, coolant returns and the compartment's own stores are threaded
through every bay — so a hit that opens one puts some of that on the deck, and a
hypervelocity impact throws incandescent spall off the back face of the plate it
just crossed into whatever it cut on the way. Before that, the *only* source of
spill was a direct hit on a fuel tank.

`B` blows the emergency vent on the worst fire aboard. It goes out instantly —
the vent smothers a fire outright, whatever is on the deck. So does anyone still
in the compartment.

Both show from outside, and they show from the *wounds*: a compartment vents
through the holes shot in it, and a fire aboard is a bay full of burning stores
with a hole in the side of it, so what you see is a jet dragged flat by the
ship's own motion. Venting runs off the hole being open rather than off the air
being left, and keeps running until the crew weld it — thinning as the
atmosphere goes, then continuing as sublimating coolant and outgassing stores.
"The hole stopped smoking so it must be fixed" would be a lie the ship tells the
player about its own condition.

### Gunnery spreads its damage

Every ship in the game laid on the target's centre of mass, which is the one
point every attacker agrees on — so a four-contact wave put its entire output
through whichever compartment held the centroid, and on the cruisers and up that
is the engineering deck. The player spent every lull welding the same two
hundred square metres while the rest of the ship came through untouched, and the
interiors this game is mostly *about* never got hit.

Choosing an aim point by the shooter's role fixes that on paper and not in
practice: waves contain duplicate hull classes, so every heavy in one wants the
same system and the plant simply becomes the new centroid. **Any rule that maps
a shooter to a part of the target concentrates.** So there is no rule — each
ship picks a live module at random every 2.5 seconds, from the hemisphere of the
target actually turned toward it, because a gun cannot reach the far side of a
250 m hull and pretending otherwise is a lie about where the rounds land.

Measured over three hulls engaging a cruiser for forty-five seconds: every
compartment damaged, and the worst-hit one took 7% of total plate loss. Two
ships on opposite beams still work opposite flanks. It is also the fairer
arrangement — a repair problem spread across the ship, rather than one
compartment the damage-control parties can never get ahead of.

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

717 assertions, no framework, about a second. They drive the real `Systems`,
`Crew` and `Ballistics` classes with no renderer attached and cover the things
that are expensive to notice by flying around: network redundancy on each hull,
load-shed ordering, the shield coupling curve and both of its failure modes, the
radiator-to-shield coupling, perforation and decompression, fire surviving the
round that started it, magazine cook-off, crew repair and pathing, mount seating
and traverse, point-defence sky coverage per hull, directors spreading across a
salvo, and the capability read-outs.

Two of those are there because the bug was invisible without a number. Seeker
guidance asserts a **miss distance in metres**, not that the maths looks right —
a subtly wrong turn limit produced textbook-looking proportional navigation that
sailed past a stationary target at 250 m every time. Point-defence coverage
asserts the **fraction of the sphere** each hull can actually train onto, because
"it has eight repeaters" and "it can shoot at something below it" are different
claims and only the second one matters.

The hull tables also self-validate at import: every conduit endpoint and declared
dependency must resolve, compartments may not overlap (they would double-charge
bulkheads in the penetration walk), and components must fit inside the
compartment that owns them. A typo is a thrown error at load, not a mysteriously
dead subsystem at minute nine of a fight.

Three of these tests were written after the behaviour they check was found
broken — most usefully, a shield facet that went down could never come back,
because coming back required charge and downed facets were excluded from the
recharge pool.
