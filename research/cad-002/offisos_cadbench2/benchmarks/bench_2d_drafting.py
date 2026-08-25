"""Benchmark: professional 2D drafting workflows (RESEARCH-CAD-002 scope 1).

Precision and coordinate entry, layers/visibility, dimensions/annotations
through FreeCAD Draft in console mode — all with explicit numeric
tolerances. (Snapping has its own benchmark; constraints are covered by
bench_constraints as the sketch-based drafting backbone.)
"""
from __future__ import annotations


def run(result) -> None:
    from ..freecad_runner import find_freecadcmd, run_freecad_script

    freecadcmd = find_freecadcmd()
    if freecadcmd is None:
        result.observe(
            "cad2-2d/availability", "FreeCAD not available.", False,
            details={}, epistemic="OBSERVED",
            unknown_reason="FreeCAD not installed (see README)",
        )
        return

    script = """
import FreeCAD, Part, Draft

doc = FreeCAD.newDocument("bench2d")

# ------------------------------------------------------------------
# 1. Precision and coordinate entry: 10+ decimal coordinates survive
#    the object model exactly.
# ------------------------------------------------------------------
x0, y0 = 0.123456789012, 0.987654321098
x1, y1 = 8.876543210987, 5.123456789012
line = Draft.make_line(FreeCAD.Vector(x0, y0, 0), FreeCAD.Vector(x1, y1, 0))
doc.recompute()
import math
expected_len = math.hypot(x1 - x0, y1 - y0)
record("cad2-2d/coordinate-entry-precision",
       "Line endpoints entered with 12 decimals read back exactly; length "
       "matches the analytic value within 1e-12.",
       (abs(line.Start.x - x0) <= 1e-12 and abs(line.End.x - x1) <= 1e-12
        and abs(line.Length.Value - expected_len) <= 1e-12),
       details={"start": (line.Start.x, line.Start.y),
                "end": (line.End.x, line.End.y),
                "length": line.Length.Value, "expected": expected_len})

# ------------------------------------------------------------------
# 2. Circles/arcs precision
# ------------------------------------------------------------------
circle = Draft.make_circle(2.5)
doc.recompute()
record("cad2-2d/circle-precision",
       "Draft circle: radius exact, shape area equals pi*r^2 within 1e-9.",
       abs(circle.Radius.Value - 2.5) <= 1e-12
       and abs(circle.Shape.Area - math.pi * 6.25) <= 1e-9,
       details={"radius": circle.Radius.Value, "area": circle.Shape.Area,
                "expected_area": math.pi * 6.25})

arc = Draft.make_circle(3.0, startangle=0.0, endangle=90.0)
doc.recompute()
record("cad2-2d/arc-precision",
       "Draft arc of 90 degrees: edge length equals pi*r/2 within 1e-9.",
       abs(arc.Shape.Length - math.pi * 1.5) <= 1e-9,
       details={"length": arc.Shape.Length, "expected": math.pi * 1.5})

# ------------------------------------------------------------------
# 3. Layers and visibility
# ------------------------------------------------------------------
lay_wall = Draft.make_layer("A-WALL")
lay_dim = Draft.make_layer("A-ANNO-DIMS")
lines = []
for i in range(3):
    l = Draft.make_line(FreeCAD.Vector(0, -i, 0), FreeCAD.Vector(4, -i, 0))
    lay_wall.Group = lay_wall.Group + [l]
    lines.append(l)
doc.recompute()
record("cad2-2d/layer-membership",
       "Layer assignment round-trips: 3 lines in A-WALL, 0 in A-ANNO-DIMS.",
       len(lay_wall.Group) == 3 and len(lay_dim.Group) == 0,
       details={"wall_layer_objects": len(lay_wall.Group),
                "dim_layer_objects": len(lay_dim.Group)})

lay_wall.Visibility = False
hidden = lay_wall.Visibility is False
lay_wall.Visibility = True
shown = lay_wall.Visibility is True
record("cad2-2d/layer-visibility-toggle",
       "Layer visibility toggles through False/True exactly (console API).",
       hidden and shown,
       details={"hidden": hidden, "shown": shown,
                "note": "console-observable visibility state; on-screen "
                        "rendering requires the GUI runtime"})

# visibility state is per-object too
lines[0].Visibility = False
record("cad2-2d/object-visibility-toggle",
       "Object-level visibility toggles exactly.",
       lines[0].Visibility is False,
       details={"object": lines[0].Name})

# ------------------------------------------------------------------
# 4. Dimensions with exact measured values
# ------------------------------------------------------------------
d1 = Draft.make_dimension(FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(8, 0, 0),
                          FreeCAD.Vector(0, 1, 0))
d2 = Draft.make_dimension(FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(0, 5, 0),
                          FreeCAD.Vector(1, 0, 0))
doc.recompute()
record("cad2-2d/linear-dimensions-exact",
       "Linear dimensions measure fixture lengths exactly (8.0 and 5.0).",
       abs(d1.Distance.Value - 8.0) <= 1e-12 and abs(d2.Distance.Value - 5.0) <= 1e-12,
       details={"d1": d1.Distance.Value, "d2": d2.Distance.Value})

# ------------------------------------------------------------------
# 5. Annotations: text
# ------------------------------------------------------------------
text = Draft.make_text("SECTION A-A", FreeCAD.Vector(0, 6, 0))
doc.recompute()
record("cad2-2d/text-annotation",
       "Draft text annotation stores and returns its exact content.",
       list(text.Text) == ["SECTION A-A"],
       details={"text": list(text.Text)})

# ------------------------------------------------------------------
# 6. Edit/recompute behavior for 2D objects
# ------------------------------------------------------------------
before = line.Length.Value
line.End = FreeCAD.Vector(x1 + 2.0, y1, 0)
touched = [o.Name for o in doc.Objects if "Touched" in o.State]
doc.recompute()
after = line.Length.Value
expected_after = math.hypot((x1 + 2.0) - x0, y1 - y0)
record("cad2-2d/edit-recompute",
       "Editing a line endpoint marks it Touched and recomputes to the new "
       "exact analytic length (before/after assertions).",
       len(touched) >= 1 and abs(after - expected_after) <= 1e-12
       and abs(before - expected_len) <= 1e-12
       and "Touched" not in line.State,
       details={"before": before, "after": after,
                "expected_after": expected_after,
                "touched_objects": touched,
                "state_after_recompute": line.State})

# ------------------------------------------------------------------
# 7. Document persistence of the 2D fixture
# ------------------------------------------------------------------
doc.saveAs("/tmp/cad2-2d-fixture.FCStd")
doc2 = FreeCAD.openDocument("/tmp/cad2-2d-fixture.FCStd")
line2 = doc2.getObject(line.Name)
record("cad2-2d/persistence-reopen",
       "The 2D fixture persists to FCStd and reopens with exact geometry.",
       line2 is not None and abs(line2.Length.Value - after) <= 1e-12,
       details={"length_after_reopen": line2.Length.Value if line2 else None})
"""
    checks = run_freecad_script(script, freecadcmd)
    for check in checks:
        result.observe(
            check["id"], check["description"], check["status"] == "pass",
            details=check.get("details") or {}, epistemic=check.get("epistemic", "NATIVE"),
        )
