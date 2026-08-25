"""Benchmark: geometric constraints deep-dive (RESEARCH-CAD-002 scope 1+3).

Sketcher constraint solving with before/after assertions: full
constraint (DoF 0), tangent, perpendicular, equal-length propagation,
dimension edit propagation, redundancy/conflict detection, and typed
rejection of invalid datums.
"""
from __future__ import annotations


def run(result) -> None:
    from ..freecad_runner import find_freecadcmd, run_freecad_script

    freecadcmd = find_freecadcmd()
    if freecadcmd is None:
        result.observe(
            "cad2-constraints/availability", "FreeCAD not available.", False,
            details={}, epistemic="OBSERVED",
            unknown_reason="FreeCAD not installed (see README)",
        )
        return

    script = """
import FreeCAD, Part, Sketcher

# ------------------------------------------------------------------
# 1. Fully constrained rectangle: solve -> DoF 0, FullyConstrained
# ------------------------------------------------------------------
doc = FreeCAD.newDocument("benchcon")
sk = doc.addObject("Sketcher::SketchObject", "Rect")
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
sk.addConstraint(Sketcher.Constraint("Coincident", 0, 1, -1, 1))  # origin anchor
sk.addConstraint(Sketcher.Constraint("DistanceX", 0, 1, 0, 2, 4.0))
sk.addConstraint(Sketcher.Constraint("DistanceY", 1, 1, 1, 2, 3.0))
doc.recompute()
solve_rc = sk.solve()
record("cad2-constraints/rectangle-full-constraint",
       "Rectangle with geometric + dimensional + origin constraints solves "
       "successfully (solver rc 0) and reports FullyConstrained (DoF = 0).",
       solve_rc == 0 and bool(sk.FullyConstrained),
       details={"solve_rc": solve_rc, "fully_constrained": bool(sk.FullyConstrained)})

# ------------------------------------------------------------------
# 2. Dimension edit propagation with before/after assertions
# ------------------------------------------------------------------
w_before = sk.Geometry[0].EndPoint.x - sk.Geometry[0].StartPoint.x
h_before = sk.Geometry[1].EndPoint.y - sk.Geometry[1].StartPoint.y
idx = [i for i, c in enumerate(sk.Constraints) if c.Type == "DistanceX"][0]
sk.setDatum(idx, 6.5)
doc.recompute()
w_after = sk.Geometry[0].EndPoint.x - sk.Geometry[0].StartPoint.x
h_after = sk.Geometry[1].EndPoint.y - sk.Geometry[1].StartPoint.y
record("cad2-constraints/datum-edit-propagation",
       "Editing DistanceX 4.0 -> 6.5 re-solves: width becomes exactly 6.5 "
       "while the height constraint still holds at exactly 3.0.",
       abs(w_before - 4.0) <= 1e-12 and abs(w_after - 6.5) <= 1e-12
       and abs(h_before - 3.0) <= 1e-12 and abs(h_after - 3.0) <= 1e-12,
       details={"width_before": w_before, "width_after": w_after,
                "height_before": h_before, "height_after": h_after})

# opposite side follows exactly (corner moves): the top-RIGHT corner is
# the end of the right edge (geo1), which tracks the width datum
top_right = sk.Geometry[1].EndPoint
record("cad2-constraints/corner-follows-edit",
       "The top-right corner follows the edit exactly ((6.5, 3.0)) while "
       "the origin-anchored corners stay fixed.",
       abs(top_right.x - 6.5) <= 1e-12 and abs(top_right.y - 3.0) <= 1e-12,
       details={"top_right": (top_right.x, top_right.y)})

# ------------------------------------------------------------------
# 3. Tangent constraint: fully constrained -> exact tangency
# ------------------------------------------------------------------
sk2 = doc.addObject("Sketcher::SketchObject", "Tangent")
sk2.addGeometry(Part.Circle(FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(0, 0, 1), 2.0), False)
sk2.addGeometry(Part.LineSegment(FreeCAD.Vector(2, 3, 0), FreeCAD.Vector(6, 3, 0)), False)
sk2.addConstraint(Sketcher.Constraint("Coincident", 0, 3, -1, 1))  # circle center at origin
sk2.addConstraint(Sketcher.Constraint("Radius", 0, 2.0))
sk2.addConstraint(Sketcher.Constraint("Horizontal", 1))
sk2.addConstraint(Sketcher.Constraint("Tangent", 0, 1))
sk2.addConstraint(Sketcher.Constraint("DistanceX", 1, 1, 1, 2, 4.0))  # line length
sk2.addConstraint(Sketcher.Constraint("DistanceX", -1, 1, 1, 1, 3.0))  # start x
doc.recompute()
t_rc = sk2.solve()
line_y = sk2.Geometry[1].StartPoint.y
record("cad2-constraints/tangent-line-circle",
       "Fully constrained tangency: the horizontal line is forced to "
       "y = +2.0 EXACTLY (distance from center equals radius; solver "
       "converges with FullyConstrained).",
       t_rc == 0 and bool(sk2.FullyConstrained) and abs(abs(line_y) - 2.0) <= 1e-12,
       details={"solve_rc": t_rc, "fully_constrained": bool(sk2.FullyConstrained),
                "line_y": line_y, "radius": 2.0})

# FINDING: underconstrained tangency may converge partially
sk2b = doc.addObject("Sketcher::SketchObject", "TangentUnder")
sk2b.addGeometry(Part.Circle(FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(0, 0, 1), 2.0), False)
sk2b.addGeometry(Part.LineSegment(FreeCAD.Vector(2, 3, 0), FreeCAD.Vector(6, 3, 0)), False)
sk2b.addConstraint(Sketcher.Constraint("Coincident", 0, 3, -1, 1))
sk2b.addConstraint(Sketcher.Constraint("Horizontal", 1))
sk2b.addConstraint(Sketcher.Constraint("Tangent", 0, 1))
doc.recompute()
rc_u = sk2b.solve()
y_u = sk2b.Geometry[1].StartPoint.y
record("cad2-constraints/tangent-underconstrained-finding",
       "FINDING: an UNDERCONSTRAINED tangent sketch can converge "
       "(solve rc 0) with the line NOT yet at the tangency distance "
       "(observed y != |r|). Implication: Offisos adapters must treat "
       "solver success and geometric satisfaction as separate assertions, "
       "and constrain sketches fully before relying on tangency.",
       rc_u == 0 and abs(abs(y_u) - 2.0) > 1e-9,
       details={"solve_rc": rc_u, "line_y": y_u, "radius": 2.0,
                "tangency_error": abs(abs(y_u) - 2.0)},
       epistemic="OBSERVED")

# ------------------------------------------------------------------
# 4. Perpendicular constraint with exact corner
# ------------------------------------------------------------------
sk3 = doc.addObject("Sketcher::SketchObject", "Perp")
sk3.addGeometry([
    Part.LineSegment(FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(4, 0, 0)),
    Part.LineSegment(FreeCAD.Vector(4, 0, 0), FreeCAD.Vector(4, 3, 0)),
], False)
sk3.addConstraint(Sketcher.Constraint("Coincident", 0, 2, 1, 1))
sk3.addConstraint(Sketcher.Constraint("Coincident", 0, 1, -1, 1))
sk3.addConstraint(Sketcher.Constraint("Horizontal", 0))
sk3.addConstraint(Sketcher.Constraint("Perpendicular", 0, 1))
sk3.addConstraint(Sketcher.Constraint("DistanceX", 0, 1, 0, 2, 4.0))
sk3.addConstraint(Sketcher.Constraint("DistanceY", 1, 1, 1, 2, 3.0))
doc.recompute()
joint = sk3.Geometry[1].StartPoint      # the shared corner of the two lines
far_end = sk3.Geometry[1].EndPoint      # end of the vertical edge
record("cad2-constraints/perpendicular-corner-exact",
       "Perpendicular constraint solves the shared corner to exactly (4, 0) "
       "and the vertical edge end to exactly (4, 3).",
       abs(joint.x - 4.0) <= 1e-12 and abs(joint.y - 0.0) <= 1e-12
       and abs(far_end.x - 4.0) <= 1e-12 and abs(far_end.y - 3.0) <= 1e-12,
       details={"joint": (joint.x, joint.y), "vertical_end": (far_end.x, far_end.y)})

# ------------------------------------------------------------------
# 5. Equal-length propagation: edit one datum, both lines change
# ------------------------------------------------------------------
sk4 = doc.addObject("Sketcher::SketchObject", "Equal")
sk4.addGeometry([
    Part.LineSegment(FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(3, 0, 0)),
    Part.LineSegment(FreeCAD.Vector(0, 2, 0), FreeCAD.Vector(3, 2, 0)),
], False)
sk4.addConstraint(Sketcher.Constraint("Horizontal", 0))
sk4.addConstraint(Sketcher.Constraint("Horizontal", 1))
sk4.addConstraint(Sketcher.Constraint("Coincident", 0, 1, -1, 1))
sk4.addConstraint(Sketcher.Constraint("Equal", 0, 1))
sk4.addConstraint(Sketcher.Constraint("DistanceX", 0, 1, 0, 2, 3.0))
sk4.addConstraint(Sketcher.Constraint("DistanceY", 0, 1, 1, 1, 2.0))
doc.recompute()
def line_len(s, i):
    g = s.Geometry[i]
    return g.StartPoint.distanceToPoint(g.EndPoint)
l1_before = line_len(sk4, 0)
l2_before = line_len(sk4, 1)
eidx = [i for i, c in enumerate(sk4.Constraints) if c.Type == "DistanceX"][0]
sk4.setDatum(eidx, 5.0)
sk4.solve()
doc.recompute()
l1_after = line_len(sk4, 0)
l2_after = line_len(sk4, 1)
record("cad2-constraints/equal-length-propagation",
       "With an Equal constraint, editing the single length datum 3.0 -> 5.0 "
       "changes BOTH lines to exactly 5.0 (before/after assertions; the "
       "solver may slide the unanchored line, so lengths are measured "
       "point-to-point).",
       abs(l1_before - 3.0) <= 1e-12 and abs(l2_before - 3.0) <= 1e-12
       and abs(l1_after - 5.0) <= 1e-12 and abs(l2_after - 5.0) <= 1e-12,
       details={"line1_before": l1_before, "line2_before": l2_before,
                "line1_after": l1_after, "line2_after": l2_after})

# ------------------------------------------------------------------
# 6. Redundancy and conflict detection
# ------------------------------------------------------------------
sk5 = doc.addObject("Sketcher::SketchObject", "Redundant")
sk5.addGeometry(Part.LineSegment(FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(4, 0, 0)), False)
sk5.addConstraint(Sketcher.Constraint("Horizontal", 0))
sk5.addConstraint(Sketcher.Constraint("DistanceX", 0, 1, 0, 2, 4.0))
doc.recompute()
dof5 = sk5.solve()
redundant = list(getattr(sk5, "RedundantConstraints", []) or [])
# add a second, conflicting dimensional constraint on the same line
sk5.addConstraint(Sketcher.Constraint("DistanceX", 0, 1, 0, 2, 5.0))
doc.recompute()
dof5b = sk5.solve()
conflicting = list(getattr(sk5, "ConflictingConstraints", []) or [])
redundant_b = list(getattr(sk5, "RedundantConstraints", []) or [])
record("cad2-constraints/conflict-detection",
       "Adding a second conflicting dimension on the same measured distance "
       "is detected: solver reports conflicts/redundancy (DoF changes, "
       "non-empty detection lists).",
       (dof5b != 0) or len(conflicting) > 0 or len(redundant_b) > 0,
       details={"dof_before": dof5, "dof_after": dof5b,
                "conflicting": conflicting, "redundant_after": redundant_b,
                "redundant_before": redundant})

# ------------------------------------------------------------------
# 7. Typed rejection of invalid datums
# ------------------------------------------------------------------
sk6 = doc.addObject("Sketcher::SketchObject", "Invalid")
sk6.addGeometry(Part.LineSegment(FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(4, 0, 0)), False)
sk6.addConstraint(Sketcher.Constraint("Distance", 0, 4.0))
doc.recompute()
zero_rejected = False
try:
    sk6.setDatum(0, 0.0)
except ValueError:
    zero_rejected = True
neg_rejected = False
try:
    sk6.setDatum(0, -5.0)
except ValueError:
    neg_rejected = True
record("cad2-constraints/invalid-datum-typed-rejection",
       "Zero and negative unsigned Distance datums are rejected with typed "
       "ValueError (no silent acceptance).",
       zero_rejected and neg_rejected,
       details={"zero_rejected": zero_rejected, "negative_rejected": neg_rejected})
"""
    checks = run_freecad_script(script, freecadcmd)
    for check in checks:
        result.observe(
            check["id"], check["description"], check["status"] == "pass",
            details=check.get("details") or {}, epistemic=check.get("epistemic", "NATIVE"),
        )
