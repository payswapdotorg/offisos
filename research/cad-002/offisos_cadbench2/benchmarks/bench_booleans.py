"""Benchmark: boolean operations and transforms (RESEARCH-CAD-002 scope 2).

Scripted Part booleans and parametric document-object booleans with
deterministic geometric assertions; placement/rotation/transform exactness
on vertices.
"""
from __future__ import annotations


def run(result) -> None:
    from ..freecad_runner import find_freecadcmd, run_freecad_script

    freecadcmd = find_freecadcmd()
    if freecadcmd is None:
        result.observe(
            "cad2-bool/availability", "FreeCAD not available.", False,
            details={}, epistemic="OBSERVED",
            unknown_reason="FreeCAD not installed (see README)",
        )
        return

    script = """
import math
import FreeCAD, Part

doc = FreeCAD.newDocument("benchbool")

# ------------------------------------------------------------------
# 1. Scripted booleans with exact analytic volumes
# ------------------------------------------------------------------
a = Part.makeBox(2, 2, 2)
b = Part.makeBox(2, 2, 2)
b.translate(FreeCAD.Vector(1, 1, 0))
fuse = a.fuse(b)
record("cad2-bool/scripted-fuse",
       "Scripted fuse of two 2x2x2 boxes with 1x1x2 overlap: exactly "
       "8 + 8 - 2 = 14 m^3.",
       abs(fuse.Volume - 14.0) <= 1e-9,
       details={"volume": fuse.Volume, "expected": 14.0})

cut = a.cut(b)
record("cad2-bool/scripted-cut",
       "Scripted cut removes exactly the 2 m^3 overlap: 8 - 2 = 6 m^3.",
       abs(cut.Volume - 6.0) <= 1e-9,
       details={"volume": cut.Volume, "expected": 6.0})

common = a.common(b)
record("cad2-bool/scripted-common",
       "Scripted intersection returns exactly the 2 m^3 overlap.",
       abs(common.Volume - 2.0) <= 1e-9,
       details={"volume": common.Volume, "expected": 2.0})

# curved boolean: cylinder through box (hole)
plate = Part.makeBox(6, 6, 0.5)
drill = Part.makeCylinder(0.5, 2.0, FreeCAD.Vector(3, 3, -1))
holed = plate.cut(drill)
expected = 18.0 - math.pi * 0.25 * 0.5
record("cad2-bool/scripted-curved-cut",
       "Cylinder drill through a plate: exact analytic volume "
       "(18 - pi*0.25*0.5 within 1e-9).",
       abs(holed.Volume - expected) <= 1e-9,
       details={"volume": holed.Volume, "expected": expected})

# disjoint fuse: honest topology (2 solids, not a single solid)
d1 = Part.makeBox(1, 1, 1)
d2 = Part.makeBox(1, 1, 1)
d2.translate(FreeCAD.Vector(5, 5, 5))
disjoint = d1.fuse(d2)
record("cad2-bool/disjoint-fuse-topology",
       "Fusing disjoint solids yields a 2-solid shape with the exact total "
       "volume (2.0): topology change is measurable, not silent.",
       len(disjoint.Solids) == 2 and abs(disjoint.Volume - 2.0) <= 1e-9,
       details={"solids": len(disjoint.Solids), "volume": disjoint.Volume})

# ------------------------------------------------------------------
# 2. Parametric document-object booleans with propagation
# ------------------------------------------------------------------
base = doc.addObject("Part::Box", "Base")
base.Length, base.Width, base.Height = 6.0, 6.0, 2.0
tool = doc.addObject("Part::Cylinder", "Tool")
tool.Radius, tool.Height = 1.0, 6.0
tool.Placement = FreeCAD.Placement(FreeCAD.Vector(3, 3, -2), FreeCAD.Rotation())
doc.recompute()
cutobj = doc.addObject("Part::Cut", "Cut")
cutobj.Base = base
cutobj.Tool = tool
doc.recompute()
v1 = cutobj.Shape.Volume
expected1 = 72.0 - math.pi * 2.0  # box 6x6x2 minus cylinder r=1 through 2m
record("cad2-bool/parametric-cut-object",
       "Part::Cut document object: exact analytic volume "
       "(72 - 2*pi within 1e-6).",
       abs(v1 - expected1) <= 1e-6,
       details={"volume": v1, "expected": expected1})

# edit the base -> the boolean recomputes to the exact new value
base.Length = 8.0
doc.recompute()
v2 = cutobj.Shape.Volume
expected2 = 96.0 - math.pi * 2.0
record("cad2-bool/parametric-propagation",
       "Editing the base Length 6.0 -> 8.0 propagates through Part::Cut to "
       "the exact new volume (96 - 2*pi within 1e-6).",
       abs(v2 - expected2) <= 1e-6,
       details={"before": v1, "after": v2, "expected_after": expected2})

# edit the tool radius -> propagation
tool.Radius = 0.5
doc.recompute()
v3 = cutobj.Shape.Volume
expected3 = 96.0 - math.pi * 0.25 * 2.0
record("cad2-bool/parametric-tool-propagation",
       "Editing the tool radius 1.0 -> 0.5 propagates to the exact new "
       "volume (96 - pi*0.5 within 1e-6).",
       abs(v3 - expected3) <= 1e-6,
       details={"after": v3, "expected": expected3})

# ------------------------------------------------------------------
# 3. Transforms and placements with exact vertex verification
# ------------------------------------------------------------------
box = doc.addObject("Part::Box", "TBox")
box.Length, box.Width, box.Height = 2.0, 3.0, 4.0
doc.recompute()
pl = FreeCAD.Placement(FreeCAD.Vector(10, 20, 30),
                       FreeCAD.Rotation(FreeCAD.Vector(0, 0, 1), 90))
box.Placement = pl
doc.recompute()
# rotating box (2,3,4) 90 deg about Z: bbox becomes 3x2x4; vertices exact
# origin vertex (0,0,0) -> (10,20,30)
vtx = [v.Point for v in box.Shape.Vertexes]
origin_like = min(vtx, key=lambda p: (p.x - 10) ** 2 + (p.y - 20) ** 2 + (p.z - 30) ** 2)
record("cad2-bool/placement-rotation-vertex-exact",
       "Placement with 90-degree Z rotation and translation moves the "
       "origin vertex to exactly (10, 20, 30) within 1e-12.",
       abs(origin_like.x - 10.0) <= 1e-12 and abs(origin_like.y - 20.0) <= 1e-12
       and abs(origin_like.z - 30.0) <= 1e-12,
       details={"nearest_vertex": (origin_like.x, origin_like.y, origin_like.z)})

# the rotated extents: (0..2,0..3) rotated 90 deg -> (-3..0, 0..2) + translation
xs = [p.x for p in vtx]; ys = [p.y for p in vtx]
record("cad2-bool/placement-rotated-extents",
       "Rotated extents are exact: x in [7, 10], y in [20, 22] (width/depth "
       "swap under 90-degree rotation).",
       abs(min(xs) - 7.0) <= 1e-12 and abs(max(xs) - 10.0) <= 1e-12
       and abs(min(ys) - 20.0) <= 1e-12 and abs(max(ys) - 22.0) <= 1e-12,
       details={"x_range": (min(xs), max(xs)), "y_range": (min(ys), max(ys))})

# shape-level matrix transform on a copy (original untouched)
s = Part.makeBox(1, 1, 1)
m = FreeCAD.Matrix()
m.move(5, 0, 0)
m.rotateZ(math.pi / 2)
moved = s.transformGeometry(m)
vtx2 = [v.Point for v in moved.Vertexes]
xs2 = [p.x for p in vtx2]; ys2 = [p.y for p in vtx2]
record("cad2-bool/matrix-transform-extents",
       "Matrix move+rotate on a unit box: extents move to x in [-1, 0], "
       "y in [5, 6] exactly (rotation about the moved origin).",
       abs(min(xs2) - (-1.0)) <= 1e-12 and abs(max(xs2) - 0.0) <= 1e-12
       and abs(min(ys2) - 5.0) <= 1e-12 and abs(max(ys2) - 6.0) <= 1e-12,
       details={"x_range": (min(xs2), max(xs2)), "y_range": (min(ys2), max(ys2)),
                "note": "transformGeometry rotates about the origin after "
                        "the move, exactly as matrix composition specifies"})
"""
    checks = run_freecad_script(script, freecadcmd)
    for check in checks:
        result.observe(
            check["id"], check["description"], check["status"] == "pass",
            details=check.get("details") or {}, epistemic=check.get("epistemic", "NATIVE"),
        )
