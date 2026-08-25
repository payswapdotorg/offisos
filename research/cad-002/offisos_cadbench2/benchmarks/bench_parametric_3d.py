"""Benchmark: 3D parametric modeling (RESEARCH-CAD-002 scope 2+3).

Part parametric primitives, PartDesign body/sketch/pad chains, dimension
change propagation with before/after assertions, dependency/recompute
behavior (touched states, recompute counts), and failure behavior when
parameters become invalid.
"""
from __future__ import annotations


def run(result) -> None:
    from ..freecad_runner import find_freecadcmd, run_freecad_script

    freecadcmd = find_freecadcmd()
    if freecadcmd is None:
        result.observe(
            "cad2-p3d/availability", "FreeCAD not available.", False,
            details={}, epistemic="OBSERVED",
            unknown_reason="FreeCAD not installed (see README)",
        )
        return

    script = """
import FreeCAD, Part, Sketcher

doc = FreeCAD.newDocument("benchp3d")

# ------------------------------------------------------------------
# 1. Parametric primitive: Part::Box property edit -> exact volume
# ------------------------------------------------------------------
box = doc.addObject("Part::Box", "Box")
box.Length, box.Width, box.Height = 2.0, 3.0, 4.0
doc.recompute()
v_before = box.Shape.Volume
box.Length = 5.0
touched = [o.Name for o in doc.Objects if "Touched" in o.State]
doc.recompute()
v_after = box.Shape.Volume
record("cad2-p3d/primitive-parametric-edit",
       "Part::Box Length edit 2.0 -> 5.0: volume changes from exactly 24.0 "
       "to exactly 60.0 (before/after assertions).",
       abs(v_before - 24.0) <= 1e-9 and abs(v_after - 60.0) <= 1e-9,
       details={"volume_before": v_before, "volume_after": v_after,
                "touched_objects": touched,
                "state_after_recompute": box.State})

# ------------------------------------------------------------------
# 2. PartDesign chain: Body + constrained Sketch + Pad
# ------------------------------------------------------------------
body = doc.addObject("PartDesign::Body", "Body")
sk = doc.addObject("Sketcher::SketchObject", "Profile")
body.addObject(sk)
sk.addGeometry([
    Part.LineSegment(FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(4, 0, 0)),
    Part.LineSegment(FreeCAD.Vector(4, 0, 0), FreeCAD.Vector(4, 3, 0)),
    Part.LineSegment(FreeCAD.Vector(4, 3, 0), FreeCAD.Vector(0, 3, 0)),
    Part.LineSegment(FreeCAD.Vector(0, 3, 0), FreeCAD.Vector(0, 0, 0)),
], False)
for i in range(4):
    sk.addConstraint(Sketcher.Constraint("Coincident", i, 2, (i + 1) % 4, 1))
sk.addConstraint(Sketcher.Constraint("Horizontal", 0))
sk.addConstraint(Sketcher.Constraint("Horizontal", 2))
sk.addConstraint(Sketcher.Constraint("Vertical", 1))
sk.addConstraint(Sketcher.Constraint("Vertical", 3))
sk.addConstraint(Sketcher.Constraint("Coincident", 0, 1, -1, 1))
sk.addConstraint(Sketcher.Constraint("DistanceX", 0, 1, 0, 2, 4.0))
sk.addConstraint(Sketcher.Constraint("DistanceY", 1, 1, 1, 2, 3.0))
pad = doc.addObject("PartDesign::Pad", "Pad")
body.addObject(pad)
pad.Profile = sk
pad.Length = 2.0
doc.recompute()
pad_v1 = pad.Shape.Volume
record("cad2-p3d/partdesign-pad",
       "PartDesign Body + constrained sketch + Pad: solid volume is exactly "
       "the profile area x pad length (4x3x2 = 24.0).",
       abs(pad_v1 - 24.0) <= 1e-9,
       details={"volume": pad_v1, "expected": 24.0})

# ------------------------------------------------------------------
# 3. Dimension change propagation through the parametric chain
# ------------------------------------------------------------------
didx = [i for i, c in enumerate(sk.Constraints) if c.Type == "DistanceX"][0]
sk.setDatum(didx, 6.0)
doc.recompute()
pad_v2 = pad.Shape.Volume
record("cad2-p3d/dimension-propagation-through-chain",
       "Sketch datum edit 4.0 -> 6.0 propagates sketch -> pad: volume "
       "changes from exactly 24.0 to exactly 36.0 (6x3x2).",
       abs(pad_v1 - 24.0) <= 1e-9 and abs(pad_v2 - 36.0) <= 1e-9,
       details={"before": pad_v1, "after": pad_v2})

# pad length edit propagates too
pad.Length = 3.0
doc.recompute()
pad_v3 = pad.Shape.Volume
record("cad2-p3d/pad-length-edit",
       "Pad length edit 2.0 -> 3.0 propagates to exactly 54.0 (6x3x3).",
       abs(pad_v3 - 54.0) <= 1e-9,
       details={"after": pad_v3})

# ------------------------------------------------------------------
# 4. Pocket: subtraction inside the parametric chain
# ------------------------------------------------------------------
sk2 = doc.addObject("Sketcher::SketchObject", "Hole")
body.addObject(sk2)
sk2.addGeometry(Part.Circle(FreeCAD.Vector(3, 1.5, 0), FreeCAD.Vector(0, 0, 1), 0.5), False)
# position the hole center at (3, 1.5) via dimensional constraints
# (NOT Coincident-to-origin: that would anchor the center to the sketch
#  origin at the pad corner — a real constraint-semantics trap, recorded
#  as a finding in the report)
sk2.addConstraint(Sketcher.Constraint("DistanceX", -1, 1, 0, 3, 3.0))
sk2.addConstraint(Sketcher.Constraint("DistanceY", -1, 1, 0, 3, 1.5))
radius_idx = sk2.addConstraint(Sketcher.Constraint("Radius", 0, 0.5))
import math
pocket = doc.addObject("PartDesign::Pocket", "Pocket")
body.addObject(pocket)
pocket.Profile = sk2
pocket.Length = 1.0
# the pad extrudes +Z from the sketch plane, so the pocket must cut in the
# reversed direction to reach the material (default direction misses it)
pocket.Reversed = True
doc.recompute()
expected = 54.0 - math.pi * 0.25 * 1.0  # box minus cylinder pocket
record("cad2-p3d/pocket-subtraction",
       "PartDesign Pocket removes an exact cylinder volume from the pad "
       "(54 - pi*0.25*1 within 1e-6).",
       abs(pocket.Shape.Volume - expected) <= 1e-6,
       details={"volume": pocket.Shape.Volume, "expected": expected})

# edit the pocket sketch circle radius -> volume follows
sk2.setDatum(radius_idx, 0.8)
doc.recompute()
expected2 = 54.0 - math.pi * 0.64 * 1.0
record("cad2-p3d/pocket-edit-propagation",
       "Editing the pocket circle radius 0.5 -> 0.8 propagates to the exact "
       "new volume (54 - pi*0.64 within 1e-6).",
       abs(pocket.Shape.Volume - expected2) <= 1e-6,
       details={"volume": pocket.Shape.Volume, "expected": expected2})

# ------------------------------------------------------------------
# 5. Dependency/recompute behavior with explicit states
# ------------------------------------------------------------------
sk.setDatum(didx, 4.0)
states_after_edit = {o.Name: list(o.State) for o in doc.Objects if "Touched" in o.State}
recomputed = doc.recompute()
states_after_recompute = {o.Name: list(o.State) for o in doc.Objects}
record("cad2-p3d/dependency-recompute-states",
       "Editing the base sketch marks the sketch (and dependents) Touched; "
       "a full recompute restores Up-to-date states and returns a positive "
       "recomputed-object count.",
       len(states_after_edit) >= 1 and recomputed >= 1
       and all("Touched" not in s for s in states_after_recompute.values()),
       details={"touched_after_edit": states_after_edit,
                "recompute_count": recomputed,
                "any_invalid": [n for n, s in states_after_recompute.items()
                                if "Invalid" in s]})

# volume returned to the edited state
record("cad2-p3d/recompute-result-exact",
       "After the revert edit (DistanceX 6.0 -> 4.0) and recompute, the pad "
       "volume returns to exactly 4 x 3 x 3 = 36.0 (deterministic "
       "regeneration; pad length is 3.0 from the earlier edit).",
       abs(pad.Shape.Volume - 36.0) <= 1e-9,
       details={"volume": pad.Shape.Volume, "expected": 36.0})

# ------------------------------------------------------------------
# 6. Failure behavior: invalid parameter -> Invalid state, no crash
# ------------------------------------------------------------------
box2 = doc.addObject("Part::Box", "BadBox")
box2.Length, box2.Width, box2.Height = 1.0, 1.0, 1.0
doc.recompute()
box2.Length = -1.0
doc.recompute()
invalid_state = "Invalid" in box2.State
record("cad2-p3d/failure-invalid-parameter",
       "Setting an invalid (negative) length leaves the object in the "
       "Invalid state (detected, typed; no crash, no fake geometry).",
       invalid_state,
       details={"state": list(box2.State),
                "note": "Part::Box accepts the assignment but recompute "
                        "flags Invalid; the failure is detectable via State"})

# recovery: fix the parameter -> object returns to Up-to-date
box2.Length = 2.0
doc.recompute()
record("cad2-p3d/failure-recovery",
       "Correcting the parameter recovers the object to Up-to-date with "
       "the exact expected volume (2.0).",
       "Invalid" not in box2.State and abs(box2.Shape.Volume - 2.0) <= 1e-9,
       details={"state": list(box2.State), "volume": box2.Shape.Volume})
"""
    checks = run_freecad_script(script, freecadcmd)
    for check in checks:
        result.observe(
            check["id"], check["description"], check["status"] == "pass",
            details=check.get("details") or {}, epistemic=check.get("epistemic", "NATIVE"),
        )
