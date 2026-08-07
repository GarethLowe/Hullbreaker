# HULLBREAK

A browser 6DOF **capital-ship** combat simulator whose ships are **modelled
interiors**, not health bars. Every vessel is 95 to 380 metres of pressurised
compartments holding 32 to 72 functional components, wired together by three
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
| **SABRE** | picket | 95 m | 4,100 t | 85 | 8 | 32 |
| **HALBERD** | line frigate | 165 m | 15,900 t | 180 | 11 | 48 |
| **MERIDIAN** | heavy cruiser *(yours)* | 250 m | 45,500 t | 420 | 14 | 72 |
| **BASTION** | dreadnought | 380 m | 165,900 t | 1,050 | 14 | 69 |

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
test/selfcheck.js        81 headless assertions over the simulation
```

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
