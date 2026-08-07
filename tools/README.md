# tools

Modelling and preview rig. Nothing in here ships to the browser; the only thing
it produces that does is `src/world/kit.js`.

## The asset chain

    tools/kit_build.py   ->   src/world/kit.js   ->   src/world/hardware.js
    (bmesh, in Blender)       (base64 buffers)        (BufferGeometry + rigs)

`kit_build.py` is the asset. It builds every hull shell and every piece of
weapon hardware procedurally with `bmesh`, then writes `kit.js`: float32
positions, signed-byte normals, uint16 indices, base64 in a JS module.

A module rather than a `.glb` because the project ships no binary assets and can
be played by serving the folder statically with no build step. There is no fetch
to get wrong, no loader to import, and no async gap between a ship spawning and
having guns.

**`src/world/kit.js` is generated. Do not hand-edit it** — change the modelling
code and re-export.

## Re-exporting the kit

Blender has to be running with the MCP add-on connected. In its Python console,
or through the MCP `execute_blender_code` tool:

```python
import sys; sys.path.insert(0, r'<repo>/tools')
import kit_build
kit_build.main(preview=False, layout=False)     # writes src/world/kit.js
```

`preview=True` leaves the parts in the scene as objects, laid out in a row, so
Blender's own viewport is the model preview. There is no separate preview rig.

Nothing about the models is kept by hand on the JS side. `MUZZLES`, `PIVOTS`
and `SKIN` are all exported into `kit.js`, and `SKIN` in particular is
**measured off the built shells** rather than authored — it records where each
shell's plating actually is, per face, at each end. Re-shape a shell and every
consumer follows: mounts stand on the new plating, decals land on it, modules
re-seat inside it, and the cutaway draws the new silhouette.

`measure_skin` runs after the body is tapered and bevelled and BEFORE any strake
is added, so ribs and raceways standing proud of the hull do not count as hull.
If you add relief to a shell, add it after the `record_skin` call.

`npm test` asserts every part decodes, that its declared vertex and triangle
counts are honest, that no normal came out zero, that every compartment style
and every weapon in the armoury has hardware modelled for it, and that no shell
spills more than 15% of a half-extent outside the compartment box a round is
actually tested against.

Module containment is not checked here — `validate` in `hulls.js` enforces it at
import and throws, so a hull whose interior no longer fits its own plating fails
before anything can test it. Re-shaping a shell therefore breaks the four hulls
loudly; the fix is to re-fit the affected modules, not to relax the check.

## Looking at it

**`shot.mjs`** — photograph the running game. The only preview worth keeping:
it shows the real renderer, so it covers materials, lighting and the shield
shader as well as shape and placement.

A Blender-side rig that rebuilt whole ships from exported transforms used to
live here. It was deleted — it re-implemented the runtime's mount hierarchy in
Python, which could drift and start lying, and this shows the actual thing.

```sh
npm run dev
node tools/shot.mjs shot.png --view quarter --mount 0 --enemy --fire
node tools/shot.mjs bastion.png --hull bastion --view beam
```

- `--view` `quarter` | `bow` | `beam` | `high` | `aft` | `belly`
- `--hull ID` photographs any hull, spawning it if it is not in the scene
- `--mount N` frames one mount closely instead of the whole ship
- `--enemy` spawns a contact so the turrets visibly train off their rest bearing
- `--fire` holds both triggers, catching guns mid-recoil with emitters lit
- `--chrome` keeps the HUD (hidden by default)

It drives headless Chromium on SwiftShader — the point is a frame that always
renders, not one that renders fast — and overrides the camera at render time,
because the game's chase camera looks along the ship's nose rather than at the
ship. It reports any console error it saw; an empty `errors` array is part of
the check.

Requires `npm i` (playwright is a devDependency) and, once,
`npx playwright install chromium`.
