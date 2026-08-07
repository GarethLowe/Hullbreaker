# -----------------------------------------------------------------------------
# kit_build.py — the modelling source for every piece of hardware in the game.
#
# Run inside Blender (see tools/README.md). Builds the whole kit procedurally
# with bmesh, then writes src/world/kit.js: a self-contained geometry module of
# base64 buffers. There are still no binary assets in the repository — this
# script is the asset, and kit.js is its compiled form.
#
# Coordinates are GAME space, not Blender space: +Z forward, +Y up, +X port.
# Nothing is converted on export, so what is modelled here is what flies.
#
# Hull shells are modelled to fill the unit cube (-0.5..0.5) because the runtime
# scales them by a compartment's half-extents, and those boxes are also the
# damage model's raycast volumes. A shell that spills outside the cube would be
# geometry the guns cannot hit.
# -----------------------------------------------------------------------------
import base64
import math
import os
import struct

import bmesh
import bpy
from mathutils import Matrix, Vector

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'world', 'kit.js')
SMOOTH = math.radians(38.0)

# ---------------------------------------------------------------------------
# bmesh helpers
# ---------------------------------------------------------------------------


def add_box(bm, center, half):
    vs = bmesh.ops.create_cube(bm, size=1.0)['verts']
    bmesh.ops.scale(bm, vec=Vector((half[0] * 2, half[1] * 2, half[2] * 2)), verts=vs)
    bmesh.ops.translate(bm, vec=Vector(center), verts=vs)
    return vs


def add_cyl(bm, center, r1, r2, depth, seg=12, axis='Z', cap=True):
    """A cone/cylinder built along +Z then rotated onto `axis`."""
    try:
        res = bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=seg,
                                    radius1=r1, radius2=r2, depth=depth)
    except TypeError:                                    # pre-2.90 argument names
        res = bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=seg,
                                    diameter1=r1 * 2, diameter2=r2 * 2, depth=depth)
    vs = res['verts']
    if axis == 'X':
        bmesh.ops.rotate(bm, verts=vs, cent=(0, 0, 0),
                         matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'))
    elif axis == 'Y':
        bmesh.ops.rotate(bm, verts=vs, cent=(0, 0, 0),
                         matrix=Matrix.Rotation(-math.pi / 2, 3, 'X'))
    bmesh.ops.translate(bm, vec=Vector(center), verts=vs)
    return vs


def bevel(bm, verts=None, offset=0.02, segments=2, profile=0.62):
    geom = list(bm.edges) if verts is None else [
        e for e in bm.edges if e.verts[0] in verts and e.verts[1] in verts
    ]
    if not geom:
        return
    bmesh.ops.bevel(bm, geom=geom, offset=offset, offset_type='OFFSET',
                    segments=segments, profile=profile, affect='EDGES',
                    clamp_overlap=True)


MEASURED = {}


def record_skin(style, bm):
    """Stash a shell's measured plating profile for export into kit.js."""
    MEASURED[style] = measure_skin(list(bm.verts))


def measure_skin(verts):
    """
    Where a shell's plating actually is, as a fraction of the unit cube, at the
    aft end and the fore end, per lateral axis.

    Measured off the built body rather than declared alongside it. The runtime
    needs these numbers — a mount has to stand on the plating, a scorch mark has
    to land on it, and a module has to fit inside it — and every one of those is
    wrong by metres if the table drifts from the model. Call this after the body
    is tapered and bevelled and BEFORE any strake is added, so ribs and raceways
    standing proud of the hull do not count as hull.

    The two faces on an axis are measured separately, because shells are not
    symmetric: the prow's nose rides high, so its deck and its keel taper by
    quite different amounts, and averaging them puts ventral ordnance out in
    space. Result is [[aft, fore] for the negative face, [aft, fore] for the
    positive face], each as a positive fraction of the half-extent.
    """
    out = {}
    for axis, key in ((0, 'x'), (1, 'y')):
        faces = []
        for sign in (-1, 1):
            ends = []
            for side in (-1, 1):
                near = [v.co[axis] * sign for v in verts if v.co.z * side > 0.30]
                ends.append(round(max(near) / 0.5, 4) if near else 1.0)
            faces.append(ends)
        out[key] = faces
    return out


def strake(bm, center, half, chamfer=0.012):
    """
    A raised strip. All shell relief is additive.

    Cutting relief in with `inset_individual` was tried and abandoned: the faces
    have already been bevelled by then, so the operator finds the bevel's own
    sliver faces alongside the one that was wanted and insetting a sliver
    produces a shard. Additive strips cannot degenerate, cost the same triangles
    and survive the anisotropic scaling a compartment applies to them.
    """
    vs = add_box(bm, center, half)
    bevel(bm, verts=vs, offset=chamfer, segments=1)
    return vs


def taper(verts, z_at, factor, axes=(0, 1), pivot=(0.0, 0.0)):
    """Pull verts near a given z toward the centreline. Turns a box into a hull."""
    for v in verts:
        if abs(v.co.z - z_at) > 1e-4:
            continue
        if 0 in axes:
            v.co.x = pivot[0] + (v.co.x - pivot[0]) * factor
        if 1 in axes:
            v.co.y = pivot[1] + (v.co.y - pivot[1]) * factor


def shift(verts, pred, delta):
    for v in verts:
        if pred(v.co):
            v.co += Vector(delta)


# ---------------------------------------------------------------------------
# Hull shells. Unit cube, -0.5..0.5, +Z forward.
#
# The style names match `sec(..., {style})` in hulls.js one for one.
# ---------------------------------------------------------------------------


def shell_hull():
    """
    A run-of-the-hull compartment. Chamfered hard, tapered fore and aft, and
    banded by two frame ribs — the ribs are the single detail that stops a line
    of compartments reading as one long extrusion.
    """
    bm = bmesh.new()
    vs = add_box(bm, (0, 0, 0), (0.5, 0.5, 0.5))
    taper(vs, 0.5, 0.90)
    taper(vs, -0.5, 0.95)
    # A heavy chamfer on the long edges: the cross-section goes octagonal and
    # the compartment stops being a crate.
    bevel(bm, offset=0.11, segments=2)
    record_skin('hull', bm)

    for z in (0.24, -0.14):                                        # frame ribs
        strake(bm, (0, 0, z), (0.512, 0.512, 0.030), 0.014)
    # Longitudinal strakes down each flank, at the chamfer shoulders.
    for sx in (-1, 1):
        for sy in (-1, 1):
            strake(bm, (sx * 0.44, sy * 0.44, 0.02), (0.055, 0.055, 0.42), 0.012)
    # Dorsal raceway — the runs the damage model wires up have to go somewhere.
    strake(bm, (0, 0.505, -0.02), (0.15, 0.045, 0.40), 0.018)
    strake(bm, (0, -0.505, 0.10), (0.24, 0.035, 0.26), 0.014)
    return bm


def shell_prow():
    """
    A bow. Wedge in plan and in elevation, blunt-nosed because this is armour
    and not an airframe, with an armoured brow deck and a ventral sensor chin.
    """
    bm = bmesh.new()
    vs = add_box(bm, (0, 0, 0), (0.5, 0.5, 0.5))
    taper(vs, 0.5, 0.30, axes=(0,))                                # narrow in plan
    taper(vs, 0.5, 0.46, axes=(1,))
    shift(vs, lambda c: c.z > 0, (0, 0.06, 0))                     # nose rides high
    taper(vs, -0.5, 0.97)
    bevel(bm, offset=0.085, segments=2)
    record_skin('prow', bm)

    # Armoured brow: a raised deck running back from the nose.
    br = add_box(bm, (0, 0.24, 0.02), (0.26, 0.055, 0.44))
    taper(br, 0.46, 0.42, axes=(0,))
    shift(br, lambda c: c.z > 0.4, (0, -0.06, 0))
    bevel(bm, verts=br, offset=0.028, segments=1)

    # Ram keel below, and cheek strakes running aft from the shoulders.
    kl = add_box(bm, (0, -0.21, 0.04), (0.13, 0.06, 0.42))
    taper(kl, 0.46, 0.45, axes=(0,))
    bevel(bm, verts=kl, offset=0.024, segments=1)
    for sx in (-1, 1):
        strake(bm, (sx * 0.33, 0.02, -0.24), (0.055, 0.20, 0.22), 0.02)
    add_cyl(bm, (0, -0.27, 0.30), 0.085, 0.045, 0.14, seg=10, axis='Y')
    return bm


def shell_engine():
    """Drive bay: flares aft to a transom of four bells, radiator fins amidships."""
    bm = bmesh.new()
    vs = add_box(bm, (0, 0, 0), (0.5, 0.5, 0.5))
    taper(vs, 0.5, 0.84)
    bevel(bm, offset=0.10, segments=2)
    record_skin('engine', bm)

    # Bell housings standing off the transom, so the drive glow has a socket.
    # Kept close to the box: a compartment's box is what a round is tested
    # against, so anything that reaches well past it is hull you cannot shoot.
    for x, y in ((0.25, 0.23), (-0.25, 0.23), (0.25, -0.23), (-0.25, -0.23)):
        add_cyl(bm, (x, y, -0.475), 0.20, 0.155, 0.20, seg=12, axis='Z')
        add_cyl(bm, (x, y, -0.545), 0.135, 0.115, 0.09, seg=12, axis='Z')
    # Transom frame tying the four bells together.
    strake(bm, (0, 0, -0.50), (0.50, 0.50, 0.035), 0.016)

    # Radiator fins: the ship's waste heat has to leave somewhere visible.
    for sy in (1, -1):
        for z in (0.26, 0.08, -0.10):
            strake(bm, (0, sy * 0.52, z), (0.40, 0.055, 0.045), 0.018)
    for sx in (-1, 1):
        strake(bm, (sx * 0.52, 0, 0.06), (0.05, 0.34, 0.30), 0.02)
    # Manoeuvring block on the shoulders.
    strake(bm, (0, 0.50, 0.30), (0.26, 0.075, 0.10), 0.02)
    return bm


def shell_wing():
    """A pod or sponson: thin, tapered leading edge, ribbed, with a mount pad."""
    bm = bmesh.new()
    vs = add_box(bm, (0, 0, 0), (0.5, 0.5, 0.5))
    taper(vs, 0.5, 0.44, axes=(1,))
    taper(vs, 0.5, 0.66, axes=(0,))
    taper(vs, -0.5, 0.74, axes=(1,))
    bevel(bm, offset=0.085, segments=2)
    record_skin('wing', bm)
    for z in (0.16, -0.18):
        strake(bm, (0, 0, z), (0.512, 0.515, 0.028), 0.012)
    # Leading-edge cap and a spar strake down the length of each face.
    strake(bm, (0, 0, 0.46), (0.30, 0.16, 0.055), 0.02)
    for sy in (1, -1):
        strake(bm, (0, sy * 0.44, -0.04), (0.30, 0.05, 0.34), 0.016)
    # Outboard pad, where a sponson mount would actually bolt on.
    strake(bm, (0, 0.48, 0.06), (0.20, 0.06, 0.24), 0.02)
    return bm


def shell_canopy():
    """
    A bridge: armoured box with a raked, stepped face. The glass is a separate
    part so it can take a transmissive material and the armour cannot.
    """
    bm = bmesh.new()
    vs = add_box(bm, (0, 0, 0), (0.5, 0.5, 0.5))
    taper(vs, 0.5, 0.70, axes=(0,))
    shift(vs, lambda c: c.z > 0 and c.y > 0, (0, -0.14, -0.04))    # raked front
    bevel(bm, offset=0.07, segments=2)
    record_skin('canopy', bm)

    # Brow over the window band, and the sill under it.
    strake(bm, (0, 0.30, 0.30), (0.30, 0.055, 0.10), 0.022)
    strake(bm, (0, 0.02, 0.40), (0.32, 0.05, 0.09), 0.02)
    for sx in (-1, 1):                                             # window mullions
        strake(bm, (sx * 0.11, 0.16, 0.375), (0.022, 0.14, 0.075), 0.008)
    # Mast and yard: a bridge without one reads as a shipping container. Short,
    # for the same reason the drive bells are — it has to stay near the box the
    # damage model actually tests against.
    add_cyl(bm, (0, 0.545, -0.14), 0.030, 0.014, 0.15, seg=6, axis='Y')
    strake(bm, (0, 0.60, -0.14), (0.11, 0.012, 0.040), 0.006)
    strake(bm, (0, 0.53, -0.30), (0.16, 0.05, 0.14), 0.02)
    return bm


def shell_canopy_glass():
    bm = bmesh.new()
    vs = add_box(bm, (0, 0.16, 0.355), (0.27, 0.10, 0.075))
    taper(vs, 0.43, 0.80, axes=(0,))
    shift(vs, lambda c: c.z > 0.40 and c.y > 0.20, (0, -0.035, 0))
    bevel(bm, verts=vs, offset=0.014, segments=1)
    return bm


# ---------------------------------------------------------------------------
# Mounts. Modelled in metres for a `medium` fitting; the runtime scales by the
# MOUNTS table (small 0.7 / medium 1.0 / large 1.45).
#
# Rig convention, and every part below obeys it:
#   base  — bolted to the hull. +Y is the hull normal it stands on, +Z is the
#           rest bearing. Never moves.
#   yoke  — child of the yaw node, rotates about +Y. Carries the trunnions.
#   gun   — child of the pitch node, rotates about +X. Fires down +Z.
# ---------------------------------------------------------------------------


def base_turret():
    """A barbette: ring sunk into the plating, sloped armour skirt above it."""
    bm = bmesh.new()
    add_cyl(bm, (0, -0.35, 0), 2.35, 2.05, 0.70, seg=20, axis='Y')     # deck ring
    add_cyl(bm, (0, 0.10, 0), 1.95, 1.72, 0.34, seg=20, axis='Y')      # race
    # Bolt bosses around the ring, so it reads as fastened rather than glued.
    for i in range(8):
        a = i * math.pi / 4 + math.pi / 8
        add_cyl(bm, (math.cos(a) * 2.18, -0.16, math.sin(a) * 2.18),
                0.16, 0.16, 0.22, seg=6, axis='Y')
    return bm


def yoke_turret():
    """The rotating house: sloped cheeks, open trunnion slot, aft counterweight."""
    bm = bmesh.new()
    body = add_box(bm, (0, 0.72, -0.10), (1.62, 0.62, 1.55))
    taper(body, 1.34, 0.74, axes=(0,))                                 # sloped roof
    shift(body, lambda c: c.z > 1.0 and c.y < 0.5, (0, 0.12, 0))       # glacis
    bevel(bm, verts=body, offset=0.09, segments=2)

    # Trunnion cheeks the gun pivots between.
    for x in (-1.30, 1.30):
        ch = add_box(bm, (x, 1.30, 0.30), (0.24, 0.52, 0.62))
        taper(ch, 0.92, 0.70, axes=(1,))
        bevel(bm, verts=ch, offset=0.06, segments=1)
        add_cyl(bm, (x, 1.34, 0.30), 0.30, 0.30, 0.56, seg=10, axis='X')

    # Aft counterweight and the rangefinder ears.
    cw = add_box(bm, (0, 0.86, -1.62), (1.10, 0.46, 0.30))
    bevel(bm, verts=cw, offset=0.05, segments=1)
    for x in (-1.52, 1.52):
        add_cyl(bm, (x, 1.05, -0.55), 0.16, 0.16, 0.40, seg=8, axis='X')
    return bm


def base_gimbal():
    """
    A socket, not a pedestal: the weapon sits IN the plating. An octagonal
    armoured collar around an aperture, sloped so nothing lands square on it.
    """
    bm = bmesh.new()
    add_cyl(bm, (0, 0.05, 0), 2.30, 1.75, 0.85, seg=8, axis='Y')       # collar
    add_cyl(bm, (0, 0.30, 0), 1.30, 1.30, 0.50, seg=8, axis='Y')       # aperture lip
    # Blast shutters flanking the aperture, angled off the axis.
    for sx in (-1, 1):
        s = add_box(bm, (sx * 1.72, 0.62, 0.05), (0.26, 0.62, 1.05))
        taper(s, 1.24, 0.55, axes=(0,))
        bevel(bm, verts=s, offset=0.07, segments=1)
    # Elevation jacks, one per side, so the thing looks driven.
    for sx in (-1, 1):
        add_cyl(bm, (sx * 1.05, 0.40, -1.15), 0.16, 0.16, 1.30, seg=6, axis='Z')
    return bm


def yoke_gimbal():
    """The ball the barrel comes out of, riding proud of its socket."""
    bm = bmesh.new()
    try:
        res = bmesh.ops.create_uvsphere(bm, u_segments=14, v_segments=8, radius=1.30)
    except TypeError:
        res = bmesh.ops.create_uvsphere(bm, u_segments=14, v_segments=8, diameter=2.60)
    bmesh.ops.translate(bm, vec=Vector((0, 0.30, 0)), verts=res['verts'])
    for v in res['verts']:                      # sunk into the plating, not floating
        if v.co.y < -0.35:
            v.co.y = -0.35
    # Mantlet: a sloped shield around the barrel root, which is what actually
    # reads as "gimbal" from three kilometres out.
    mv = add_box(bm, (0, 0.30, 1.00), (1.32, 1.20, 0.42))
    taper(mv, 1.42, 0.62)
    bevel(bm, verts=mv, offset=0.12, segments=2)
    return bm


def base_fixed():
    """
    A fixed installation. Nothing rotates, so the armour can be part of the
    hull line: a long raked fairing with the ordnance buried in it.
    """
    bm = bmesh.new()
    b = add_box(bm, (0, 0.05, -0.20), (2.25, 0.80, 3.00))
    taper(b, 2.80, 0.58, axes=(0,))
    shift(b, lambda c: c.z > 2.5 and c.y > 0.4, (0, -0.42, 0))         # raked deck
    shift(b, lambda c: c.z < -3.0 and c.y > 0.4, (0, -0.20, 0))
    bevel(bm, verts=b, offset=0.16, segments=2)
    # Loading gantry down the spine and cable runs along the flanks.
    g = add_box(bm, (0, 0.92, -1.30), (1.30, 0.20, 1.30))
    bevel(bm, verts=g, offset=0.07, segments=1)
    for sx in (-1, 1):
        add_cyl(bm, (sx * 2.05, 0.30, -0.30), 0.18, 0.18, 5.0, seg=6, axis='Z')
    return bm


# ---------------------------------------------------------------------------
# Guns. Each fires down +Z from the pitch pivot at the origin.
# ---------------------------------------------------------------------------


def gun_railgun():
    """
    Twin rails on a capacitor breech. Length is the entire read on a naval
    mount — at three kilometres a gun is a line, and everything else is texture.
    """
    bm = bmesh.new()
    br = add_box(bm, (0, 0, -0.75), (0.95, 0.80, 1.60))                # breech
    taper(br, -2.35, 0.72)
    bevel(bm, verts=br, offset=0.11, segments=2)
    for sx in (-1, 1):                                                 # the rails
        r = add_box(bm, (sx * 0.40, 0, 4.60), (0.17, 0.34, 3.80))
        taper(r, 8.40, 0.72, axes=(1,))
        bevel(bm, verts=r, offset=0.05, segments=1)
    # Accelerator coils, thinning toward the muzzle.
    for i in range(6):
        z = 0.95 + i * 1.30
        s = 1.0 - i * 0.075
        c = add_box(bm, (0, 0, z), (0.86 * s, 0.52 * s, 0.15))
        bevel(bm, verts=c, offset=0.05, segments=1)
    # Muzzle brace tying the rails together — the tell that it is a railgun.
    mb = add_box(bm, (0, 0, 8.50), (0.78, 0.44, 0.28))
    bevel(bm, verts=mb, offset=0.07, segments=1)
    add_box(bm, (0, 0.70, 0.60), (0.26, 0.22, 2.60))                   # bus bar
    add_box(bm, (0, -0.70, 0.10), (0.34, 0.20, 1.70))                  # rammer
    return bm


def gun_beam():
    """A focusing horn: a long taper, three heavy rings, an emitter throat."""
    bm = bmesh.new()
    cv = add_box(bm, (0, 0, -0.55), (0.98, 0.92, 1.55))                # cavity block
    bevel(bm, verts=cv, offset=0.14, segments=2)
    add_cyl(bm, (0, 0, 3.20), 0.74, 0.34, 5.10, seg=14, axis='Z')      # the horn
    for i in range(3):                                                 # focus rings
        z = 1.20 + i * 1.85
        r = 0.80 - i * 0.16
        add_cyl(bm, (0, 0, z), r, r, 0.34, seg=14, axis='Z')
    add_cyl(bm, (0, 0, 6.05), 0.30, 0.44, 0.55, seg=14, axis='Z')      # muzzle flare
    # Heat sink fins. This weapon cooks its own mount; show the attempt.
    for a in range(6):
        t = a * math.pi / 3
        f = add_box(bm, (math.cos(t) * 1.02, math.sin(t) * 1.02, -0.30),
                    (0.07, 0.30, 1.60))
        bmesh.ops.rotate(bm, verts=f, cent=(0, 0, -0.30),
                         matrix=Matrix.Rotation(t, 3, 'Z'))
    return bm


def gun_beam_glow():
    bm = bmesh.new()
    add_cyl(bm, (0, 0, 6.22), 0.26, 0.17, 0.34, seg=14, axis='Z')
    for i in range(3):
        add_cyl(bm, (0, 0, 1.20 + i * 1.85), 0.62 - i * 0.14, 0.62 - i * 0.14,
                0.11, seg=14, axis='Z')
    return bm


def gun_pulse():
    """Three long barrels in a vented cage — a repeater's big brother."""
    bm = bmesh.new()
    hb = add_box(bm, (0, 0, -0.40), (0.84, 0.80, 1.25))
    bevel(bm, verts=hb, offset=0.10, segments=2)
    for i in range(3):
        t = math.pi / 2 + i * 2 * math.pi / 3
        x, y = math.cos(t) * 0.44, math.sin(t) * 0.44
        add_cyl(bm, (x, y, 2.60), 0.21, 0.16, 4.60, seg=8, axis='Z')
        add_cyl(bm, (x, y, 4.75), 0.26, 0.22, 0.30, seg=8, axis='Z')   # flash hider
    for i in range(2):                                                 # vented shroud
        add_cyl(bm, (0, 0, 1.10 + i * 1.55), 0.80, 0.74, 0.26, seg=12, axis='Z')
    add_box(bm, (0, -0.86, -0.20), (0.52, 0.26, 1.05))                 # feed
    add_box(bm, (0, 0.86, -0.30), (0.30, 0.22, 0.85))                  # director
    return bm


def gun_ion():
    """A projector, not a gun: an open coil cage down a long central spike."""
    bm = bmesh.new()
    hb = add_box(bm, (0, 0, -0.55), (1.00, 0.96, 1.45))
    bevel(bm, verts=hb, offset=0.13, segments=2)
    for i in range(4):                                                 # coil hoops
        add_cyl(bm, (0, 0, 1.10 + i * 1.45), 1.16 - i * 0.16, 1.16 - i * 0.16,
                0.26, seg=14, axis='Z')
    for a in range(4):                                                 # cage spars
        t = math.pi / 4 + a * math.pi / 2
        add_box(bm, (math.cos(t) * 0.95, math.sin(t) * 0.95, 3.00),
                (0.09, 0.09, 2.60))
    add_cyl(bm, (0, 0, 3.40), 0.34, 0.09, 5.20, seg=10, axis='Z')      # spike
    add_box(bm, (0, 1.02, -0.30), (0.32, 0.24, 1.30))                  # charge line
    return bm


def gun_ion_glow():
    bm = bmesh.new()
    add_cyl(bm, (0, 0, 3.60), 0.22, 0.04, 4.90, seg=10, axis='Z')
    for i in range(4):
        add_cyl(bm, (0, 0, 1.10 + i * 1.45), 0.98 - i * 0.16, 0.98 - i * 0.16,
                0.13, seg=14, axis='Z')
    return bm


def gun_repeater():
    """
    Point defence: twin long barrels on a compact receiver. It is a `small`
    mount and gets scaled to 0.7, so the barrels have to be generous here or
    they vanish entirely on the hull.
    """
    bm = bmesh.new()
    hb = add_box(bm, (0, 0, -0.30), (0.70, 0.62, 1.00))
    taper(hb, 0.70, 0.78)
    bevel(bm, verts=hb, offset=0.09, segments=2)
    for sx in (-1, 1):
        x = sx * 0.30
        add_cyl(bm, (x, 0, 2.15), 0.155, 0.115, 3.40, seg=8, axis='Z')
        add_cyl(bm, (x, 0, 3.90), 0.20, 0.17, 0.26, seg=8, axis='Z')
        for i in range(3):                                             # cooling jacket
            add_cyl(bm, (x, 0, 0.70 + i * 0.52), 0.235, 0.235, 0.14, seg=8, axis='Z')
    for sx in (-1, 1):                                                 # ready drums
        d = add_cyl(bm, (sx * 0.86, -0.10, -0.55), 0.42, 0.42, 0.44, seg=10, axis='X')
        bevel(bm, verts=d, offset=0.05, segments=1)
    st = add_box(bm, (0, 0.72, -0.20), (0.30, 0.20, 0.72))             # sight head
    bevel(bm, verts=st, offset=0.05, segments=1)
    return bm


def gun_plasma():
    """A heavy bore off a chamber bulb. Slow, and it should look slow."""
    bm = bmesh.new()
    add_cyl(bm, (0, 0, -0.85), 1.18, 1.28, 1.70, seg=14, axis='Z')     # chamber
    add_cyl(bm, (0, 0, 0.35), 1.28, 0.86, 0.90, seg=14, axis='Z')      # shoulder
    add_cyl(bm, (0, 0, 3.10), 0.78, 0.62, 4.70, seg=14, axis='Z')      # bore
    add_cyl(bm, (0, 0, 5.70), 0.90, 1.02, 0.65, seg=14, axis='Z')      # bell
    for a in range(8):                                                 # cooling fins
        t = a * math.pi / 4
        f = add_box(bm, (math.cos(t) * 1.05, math.sin(t) * 1.05, 1.90),
                    (0.06, 0.28, 2.10))
        bmesh.ops.rotate(bm, verts=f, cent=(0, 0, 1.90),
                         matrix=Matrix.Rotation(t, 3, 'Z'))
    add_box(bm, (0, -1.20, -0.60), (0.46, 0.30, 1.20))                 # feed line
    return bm


def gun_plasma_glow():
    bm = bmesh.new()
    add_cyl(bm, (0, 0, 5.92), 0.62, 0.52, 0.28, seg=14, axis='Z')
    add_cyl(bm, (0, 0, -0.85), 1.10, 1.20, 1.30, seg=14, axis='Z')
    return bm


def gun_torpedo():
    """
    Four tubes in an armoured block. Ordnance, not a gun: the read is the
    square of muzzle doors, so they sit proud and the block stays angular.
    """
    bm = bmesh.new()
    blk = add_box(bm, (0, 0, 0.30), (1.70, 1.15, 2.55))
    taper(blk, 2.85, 0.84)
    shift(blk, lambda c: c.z < -2.0 and c.y > 0, (0, -0.30, 0))
    bevel(bm, verts=blk, offset=0.13, segments=2)
    for x, y in ((-0.82, 0.50), (0.82, 0.50), (-0.82, -0.50), (0.82, -0.50)):
        add_cyl(bm, (x, y, 2.95), 0.58, 0.54, 0.70, seg=10, axis='Z')  # tube collar
        add_cyl(bm, (x, y, 3.18), 0.42, 0.42, 0.44, seg=10, axis='Z')  # door
    hd = add_box(bm, (0, 1.24, -0.40), (1.30, 0.16, 1.50))             # loading hatch
    bevel(bm, verts=hd, offset=0.06, segments=1)
    for sx in (-1, 1):                                                 # hoist rails
        add_box(bm, (sx * 1.78, 0, 0.10), (0.13, 0.66, 2.10))
    return bm


# ---------------------------------------------------------------------------
# The kit. `mat` names a runtime material preset; `muzzles` are the points a
# round actually leaves from, in the gun's own frame, so tracers come out of the
# barrel rather than out of the middle of the ship.
# ---------------------------------------------------------------------------
KIT = [
    ('shell_hull',        shell_hull,        'plate'),
    ('shell_prow',        shell_prow,        'plate'),
    ('shell_engine',      shell_engine,      'plate'),
    ('shell_wing',        shell_wing,        'plate'),
    ('shell_canopy',      shell_canopy,      'plate'),
    ('shell_canopy_glass', shell_canopy_glass, 'glass'),

    ('base_turret',       base_turret,       'gunDark'),
    ('yoke_turret',       yoke_turret,       'gun'),
    ('base_gimbal',       base_gimbal,       'gunDark'),
    ('yoke_gimbal',       yoke_gimbal,       'gun'),
    ('base_fixed',        base_fixed,        'gunDark'),

    ('gun_railgun',       gun_railgun,       'gun'),
    ('gun_beam',          gun_beam,          'gun'),
    ('gun_beam_glow',     gun_beam_glow,     'glow'),
    ('gun_pulse',         gun_pulse,         'gun'),
    ('gun_ion',           gun_ion,           'gun'),
    ('gun_ion_glow',      gun_ion_glow,      'glow'),
    ('gun_repeater',      gun_repeater,      'gun'),
    ('gun_plasma',        gun_plasma,        'gun'),
    ('gun_plasma_glow',   gun_plasma_glow,   'glow'),
    ('gun_torpedo',       gun_torpedo,       'gun'),
]

MUZZLES = {
    'railgun':  [[0.0, 0.0, 8.85]],
    'beam':     [[0.0, 0.0, 6.40]],
    'pulse':    [[0.0, 0.44, 4.95], [-0.38, -0.22, 4.95], [0.38, -0.22, 4.95]],
    'ion':      [[0.0, 0.0, 6.05]],
    'repeater': [[-0.30, 0.0, 4.08], [0.30, 0.0, 4.08]],
    'plasma':   [[0.0, 0.0, 6.10]],
    'torpedo':  [[-0.82, 0.50, 3.45], [0.82, 0.50, 3.45],
                 [-0.82, -0.50, 3.45], [0.82, -0.50, 3.45]],
}

# Where the pitch pivot sits above the base plane, per mount style. The gun
# hangs off this, so it decides how much of the barrel is above the plating.
PIVOTS = {'turret': 1.34, 'gimbal': 0.30, 'fixed': 0.30}


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


def smooth_normals(bm):
    """
    Angle-weighted split normals, computed here rather than leaned on Blender's
    auto-smooth: that API moved twice between 3.x and 4.x and this is 20 lines.
    """
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.normal_update()
    out = []
    for f in bm.faces:
        fn = f.normal.copy()
        if fn.length_squared < 1e-12:
            continue
        for v in f.verts:
            n = Vector((0.0, 0.0, 0.0))
            for lf in v.link_faces:
                ln = lf.normal
                if ln.length_squared < 1e-12 or ln.dot(fn) < math.cos(SMOOTH):
                    continue
                n += ln * lf.calc_area()
            if n.length_squared < 1e-12:
                n = fn.copy()
            out.append((v.co.copy(), n.normalized()))
    return out


def pack(bm):
    corners = smooth_normals(bm)
    bm.free()
    index = {}
    pos, nrm, idx = [], [], []
    for co, n in corners:
        key = (round(co.x, 4), round(co.y, 4), round(co.z, 4),
               round(n.x, 2), round(n.y, 2), round(n.z, 2))
        i = index.get(key)
        if i is None:
            i = len(pos) // 3
            index[key] = i
            pos.extend((co.x, co.y, co.z))
            nrm.extend((n.x, n.y, n.z))
        idx.append(i)
    if len(pos) // 3 > 65535:
        raise RuntimeError('part exceeds a 16-bit index buffer')
    b64 = lambda b: base64.b64encode(b).decode('ascii')
    return {
        'v': len(pos) // 3,
        't': len(idx) // 3,
        'pos': b64(struct.pack('<%df' % len(pos), *pos)),
        # Normals as signed bytes: they are unit vectors and a 1/127 quantum is
        # far below what a shaded pixel can tell apart. Quarter the size.
        'nrm': b64(bytes((max(-127, min(127, int(round(x * 127)))) & 0xFF) for x in nrm)),
        'idx': b64(struct.pack('<%dH' % len(idx), *idx)),
    }


def build(preview=False):
    packed = {}
    stats = []
    for name, fn, mat in KIT:
        bm = fn()
        if preview:
            me = bpy.data.meshes.new(name)
            bm2 = bm.copy()
            bmesh.ops.triangulate(bm2, faces=bm2.faces[:])
            bm2.to_mesh(me)
            bm2.free()
            ob = bpy.data.objects.new(name, me)
            bpy.context.collection.objects.link(ob)
        d = pack(bm)
        d['mat'] = mat
        packed[name] = d
        stats.append((name, d['v'], d['t']))
    return packed, stats


def write(packed):
    lines = [
        '// -----------------------------------------------------------------------------',
        '// kit.js — GENERATED by tools/kit_build.py. Do not hand-edit.',
        '//',
        '// Every hull shell and every piece of weapon hardware in the game, as base64',
        '// buffers: float32 positions, signed-byte normals, uint16 indices. Modelled in',
        '// game space (+Z forward, +Y up), so nothing is rotated on the way in.',
        '//',
        '// A module rather than a .glb because the project ships no binary assets and can',
        '// be played by serving the folder statically — there is no fetch to get wrong,',
        '// no loader to import, and no async gap between a ship spawning and having guns.',
        '// -----------------------------------------------------------------------------',
        '',
        'export const PARTS = {',
    ]
    for name, d in packed.items():
        lines.append('  %s: {' % name)
        lines.append("    mat: '%s', v: %d, t: %d," % (d['mat'], d['v'], d['t']))
        lines.append("    pos: '%s'," % d['pos'])
        lines.append("    nrm: '%s'," % d['nrm'])
        lines.append("    idx: '%s'," % d['idx'])
        lines.append('  },')
    lines.append('};')
    lines.append('')
    lines.append('/** Where a round leaves each gun, in the gun\'s own frame. */')
    lines.append('export const MUZZLES = {')
    for k, v in MUZZLES.items():
        lines.append('  %s: [%s],' % (k, ', '.join('[%g, %g, %g]' % tuple(p) for p in v)))
    lines.append('};')
    lines.append('')
    lines.append('/** Height of the pitch pivot above the base plane, per mount style. */')
    lines.append('export const PIVOTS = { %s };' % ', '.join(
        '%s: %g' % (k, v) for k, v in PIVOTS.items()))
    lines.append('')
    lines.append('/**')
    lines.append(' * Where each shell\'s plating sits, as a fraction of the compartment\'s')
    lines.append(' * half-extent. MEASURED off the built shells, not authored.')
    lines.append(' *')
    lines.append(' * A compartment box is the damage model\'s volume; the shell is inscribed in')
    lines.append(' * it and tapers, so the two disagree by metres at the ends. Anything that has')
    lines.append(' * to touch the visible hull — a gun standing on it, a scorch mark landing on')
    lines.append(' * it, a reactor fitting inside it, the cutaway drawing it — goes through this.')
    lines.append(' *')
    lines.append(' * Per axis, [negative face, positive face]; per face, [aft end, fore end].')
    lines.append(' * The faces differ: a prow\'s nose rides high, so its deck and keel are not')
    lines.append(' * the same shape and one number for both puts ventral tubes outside the hull.')
    lines.append(' */')
    lines.append('export const SKIN = {')
    for style, band in MEASURED.items():
        lines.append('  %s: {' % style)
        for key in ('x', 'y'):
            lo, hi = band[key]
            lines.append('    %s: [[%g, %g], [%g, %g]],' % (key, lo[0], lo[1], hi[0], hi[1]))
        lines.append('  },')
    lines.append('};')
    lines.append('')
    path = os.path.normpath(OUT)
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines))
    return path, len('\n'.join(lines))


def clear():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for me in list(bpy.data.meshes):
        if me.users == 0:
            bpy.data.meshes.remove(me)


def main(preview=True, layout=True):
    clear()
    packed, stats = build(preview=preview)
    if preview and layout:
        # Lay the kit out in a row so one render shows the whole armoury.
        x = 0.0
        for name, _fn, _m in KIT:
            ob = bpy.data.objects.get(name)
            if not ob:
                continue
            if name.endswith('_glow') or name.endswith('_glass'):
                continue                                   # sits on its parent
            span = max(1.0, max(ob.dimensions) )
            x += span * 0.7
            ob.location.x = x
            for suffix in ('_glow', '_glass'):
                child = bpy.data.objects.get(name + suffix)
                if child:
                    child.location.x = x
            x += span * 0.7
    path, size = write(packed)
    return {'path': path, 'bytes': size, 'parts': stats}
