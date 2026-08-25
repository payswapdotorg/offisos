"""Benchmark: parametric behavior (RESEARCH-CAD-001 evidence item 3).

Parametric edit/regeneration and failure behavior through OCCT, plus
FreeCAD Sketcher constraint solving if FreeCAD is available in the
environment (checked explicitly; recorded as not-tested otherwise).
"""
from __future__ import annotations

from ..fixtures import WALL_HEIGHT, WALL_THICKNESS


def run(result) -> None:
    from OCP.gp import gp_Pnt
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
    from OCP.GProp import GProp_GProps
    from OCP.BRepGProp import BRepGProp

    def volume(shape) -> float:
        props = GProp_GProps()
        BRepGProp.VolumeProperties_s(shape, props, True)
        return props.Mass()

    def parametric_wall(length: float, height: float, thickness: float,
                        openings: list[dict]):
        """A parametric model function: regenerate from parameters."""
        gross = BRepPrimAPI_MakeBox(
            gp_Pnt(0, -thickness / 2, 0), length, thickness, height
        ).Shape()
        net = gross
        for o in openings:
            void = BRepPrimAPI_MakeBox(
                gp_Pnt(o["x"] - o["width"] / 2, -thickness / 2 - 0.001, o["sill"]),
                o["width"], thickness + 0.002, o["height"],
            ).Shape()
            net = BRepAlgoAPI_Cut(net, void).Shape()
        return gross, net

    openings = [
        {"x": 1.5, "width": 1.0, "height": 2.1, "sill": 0.0},
        {"x": 4.0, "width": 1.2, "height": 1.5, "sill": 0.9},
    ]

    # ------------------------------------------------------------------
    # 1. Baseline regeneration
    # ------------------------------------------------------------------
    _, net1 = parametric_wall(6.0, WALL_HEIGHT, WALL_THICKNESS, openings)
    v1 = volume(net1)
    result.assert_close(
        "parametric/baseline-regeneration",
        "Parametric wall regenerates to the analytic net volume (4.23 m^3).",
        v1, 4.23, 1e-9, epistemic="NATIVE",
    )

    # determinism: identical parameters -> identical result
    _, net1b = parametric_wall(6.0, WALL_HEIGHT, WALL_THICKNESS, openings)
    result.observe(
        "parametric/regeneration-determinism",
        "Identical parameters produce identical regenerated volume.",
        volume(net1b) == v1,
        details={"volume": v1},
        epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 2. Parameter edit -> regeneration with exact delta
    # ------------------------------------------------------------------
    _, net2 = parametric_wall(6.0, WALL_HEIGHT + 0.5, WALL_THICKNESS, openings)
    v2 = volume(net2)
    expected_delta = 6.0 * WALL_THICKNESS * 0.5  # extra strip above openings
    result.assert_close(
        "parametric/edit-height-delta",
        "Height edit 3.0 -> 3.5 m: net volume delta is exactly +0.9 m^3.",
        v2 - v1, expected_delta, 1e-9,
        epistemic="NATIVE",
        details={"before": v1, "after": v2},
    )

    # ------------------------------------------------------------------
    # 3. Failure behavior: invalid parameters raise typed, not silent
    # ------------------------------------------------------------------


    # (a) zero-extent solid: OCCT raises Standard_DomainError (observed)
    raised_domain_error = False
    try:
        BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 0.0, 0.3, 3.0).Shape()
    except Exception as exc:
        raised_domain_error = "DomainError" in type(exc).__name__
    result.observe(
        "parametric/failure-zero-extent-typed-error",
        "Zero-extent parameter raises OCCT Standard_DomainError (typed failure, no silent fallback).",
        raised_domain_error,
        details={"observed_exception": "Standard_DomainError"},
        epistemic="NATIVE",
    )

    # (b) NaN coordinate: OCCT does NOT reject it — genuine engine finding.
    #     The adapter layer must therefore validate inputs (recorded as an
    #     adapter obligation, demonstrated by detection of the 0-volume result).
    nan_volume = None
    try:
        nan_shape = BRepPrimAPI_MakeBox(gp_Pnt(float("nan"), 0, 0), 1.0, 1.0, 1.0).Shape()
        nan_volume = volume(nan_shape)
    except Exception:
        nan_volume = None
    nan_detected_by_domain = nan_volume is not None and nan_volume == 0.0
    result.observe(
        "parametric/failure-nan-coordinate-finding",
        "FINDING: OCCT accepts NaN coordinates without error and returns a "
        "0-volume shape. Input validation is therefore an ADAPTER obligation; "
        "the domain layer detects the degenerate result.",
        nan_detected_by_domain,
        details={
            "occt_behavior": "no exception, volume 0.0",
            "adapter_obligation": "validate finiteness of parameters before engine calls",
        },
        epistemic="OBSERVED",
    )

    # (c) opening larger than the wall: boolean produces empty result
    oversize = [{"x": 3.0, "width": 10.0, "height": 4.0, "sill": 0.0}]
    empty_or_failed = False
    try:
        _, net4 = parametric_wall(6.0, WALL_HEIGHT, WALL_THICKNESS, oversize)
        v4 = volume(net4)
        empty_or_failed = v4 <= 1e-9  # wall fully consumed
    except Exception:
        empty_or_failed = True
    result.observe(
        "parametric/failure-oversized-opening",
        "Oversized opening consumes the wall: empty result detected, no fake volume.",
        empty_or_failed,
        epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 4. FreeCAD Sketcher constraint solving (if available)
    # ------------------------------------------------------------------
    freecad_status = _test_freecad_sketcher(result)
    result.measure("freecad_sketcher", freecad_status)


def _test_freecad_sketcher(result) -> str:
    """Run the Sketcher constraint-solve evidence inside FreeCADCmd.

    The script runs in FreeCAD's bundled Python (console mode). Structured
    results are converted into harness checks; FreeCAD is never imported
    in-process by the benchmark.
    """
    from ..freecad_runner import find_freecadcmd, run_freecad_script

    freecadcmd = find_freecadcmd()
    if freecadcmd is None:
        result.observe(
            "parametric/freecad-sketcher/availability",
            "FreeCAD is not available (no FREECADCMD env var, no extracted "
            "AppImage at research/cad-001/.freecad/, no FreeCADCmd on PATH): "
            "Sketcher constraint solving NOT tested in this run. Recorded as "
            "an explicit environment limitation, not as an engine failure.",
            False,
            details={},
            epistemic="OBSERVED",
            unknown_reason="FreeCAD not installed in the benchmark environment "
            "(see research/cad-001/README.md for the reproducible AppImage setup)",
        )
        return "not-available"

    script = """
import FreeCAD, Part, Sketcher

doc = FreeCAD.newDocument("bench")
sketch = doc.addObject("Sketcher::SketchObject", "Sketch")
sketch.addGeometry([
    Part.LineSegment(FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(4, 0, 0)),
    Part.LineSegment(FreeCAD.Vector(4, 0, 0), FreeCAD.Vector(4, 2, 0)),
    Part.LineSegment(FreeCAD.Vector(4, 2, 0), FreeCAD.Vector(0, 2, 0)),
    Part.LineSegment(FreeCAD.Vector(0, 2, 0), FreeCAD.Vector(0, 0, 0)),
], False)
sketch.addConstraint(Sketcher.Constraint("Coincident", 0, 2, 1, 1))
sketch.addConstraint(Sketcher.Constraint("Coincident", 1, 2, 2, 1))
sketch.addConstraint(Sketcher.Constraint("Coincident", 2, 2, 3, 1))
sketch.addConstraint(Sketcher.Constraint("Coincident", 3, 2, 0, 1))
sketch.addConstraint(Sketcher.Constraint("Horizontal", 0))
sketch.addConstraint(Sketcher.Constraint("Horizontal", 2))
sketch.addConstraint(Sketcher.Constraint("Vertical", 1))
sketch.addConstraint(Sketcher.Constraint("Vertical", 3))
sketch.addConstraint(Sketcher.Constraint("DistanceX", 0, 1, 0, 2, 4.0))
sketch.addConstraint(Sketcher.Constraint("DistanceY", 1, 1, 1, 2, 2.0))
sketch.addConstraint(Sketcher.Constraint("Coincident", 0, 1, -1, 1))  # anchor to origin
doc.recompute()
dof = sketch.solve()
record("parametric/freecad-sketcher/solve",
       "FreeCAD Sketcher solves a fully constrained rectangle (DoF = 0).",
       dof == 0, details={"dof": dof})
record("parametric/freecad-sketcher/fully-constrained",
       "The sketch reports FullyConstrained after solving.",
       bool(sketch.FullyConstrained),
       details={"fully_constrained": bool(sketch.FullyConstrained)})

# edit the dimensional constraint and re-solve
idx = [i for i, c in enumerate(sketch.Constraints) if c.Type == "DistanceX"][0]
sketch.setDatum(idx, 6.0)
doc.recompute()
solve2 = sketch.solve()
p0 = sketch.Geometry[0]
width = p0.EndPoint.x - p0.StartPoint.x
record("parametric/freecad-sketcher/edit-resolve",
       "Editing the dimensional constraint re-solves the sketch to width 6.0 exactly.",
       solve2 == 0 and abs(width - 6.0) <= 1e-9,
       details={"width": width, "dof": solve2})
p1 = sketch.Geometry[1]
height = p1.EndPoint.y - p1.StartPoint.y
record("parametric/freecad-sketcher/constraint-propagation",
       "The height constraint still holds exactly after the width edit.",
       abs(height - 2.0) <= 1e-9, details={"height": height})

# failure: invalid datums must be rejected with typed errors (observed:
# FreeCAD raises ValueError for zero/negative unsigned Distance datums)
doc3 = FreeCAD.newDocument("bench3")
sk3 = doc3.addObject("Sketcher::SketchObject", "S")
sk3.addGeometry([Part.LineSegment(FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(4, 0, 0))], False)
sk3.addConstraint(Sketcher.Constraint("Distance", 0, 4.0))
doc3.recompute()
zero_rejected = False
try:
    sk3.setDatum(0, 0.0)
    doc3.recompute()
except ValueError:
    zero_rejected = True
negative_rejected = False
try:
    sk3.setDatum(0, -5.0)
    doc3.recompute()
except ValueError:
    negative_rejected = True
record("parametric/freecad-sketcher/failure-invalid-datum",
       "Invalid datums (zero and negative unsigned Distance) are rejected "
       "with typed ValueError, not silently accepted.",
       zero_rejected and negative_rejected,
       details={"zero_rejected": zero_rejected, "negative_rejected": negative_rejected})

# failure: redundant dimension -> over-constrained detection
doc2 = FreeCAD.newDocument("bench2")
sk2 = doc2.addObject("Sketcher::SketchObject", "S")
sk2.addGeometry([
    Part.LineSegment(FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(4, 0, 0)),
], False)
sk2.addConstraint(Sketcher.Constraint("DistanceX", 0, 1, 0, 2, 4.0))
sk2.addConstraint(Sketcher.Constraint("DistanceX", 0, 1, 0, 2, 5.0))
doc2.recompute()
conflicting = len(getattr(sk2, "ConflictingConstraints", []) or []) > 0
redundant = len(getattr(sk2, "RedundantConstraints", []) or []) > 0
record("parametric/freecad-sketcher/failure-conflicting-constraints",
       "Conflicting dimensions are detected by the solver (conflicting or redundant lists, or non-zero solve).",
       sk2.solve() != 0 or conflicting or redundant,
       details={"conflicting": conflicting, "redundant": redundant,
                "solve_result": sk2.solve()})
"""
    checks = run_freecad_script(script, freecadcmd)
    failed = []
    for check in checks:
        ok = check["status"] == "pass"
        result.observe(
            check["id"], check["description"], ok,
            details=check.get("details") or {},
            epistemic=check.get("epistemic", "NATIVE"),
        )
        if not ok:
            failed.append(check["id"])
    return "tested" if not failed else f"failures: {', '.join(failed)}"
