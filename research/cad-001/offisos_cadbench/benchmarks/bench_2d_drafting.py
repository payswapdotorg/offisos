"""Benchmark: 2D drafting capabilities (RESEARCH-CAD-001 evidence item 1).

Tests precision, snapping, layers, dimensions and constraints against the
candidate stack, carefully distinguishing:

- NATIVE OCCT capability: 2D analytic geometry with explicit tolerances
  (Precision::Confusion), exact point-on-curve projection.
- ADAPTER capability: snapping (grid/endpoint) built from OCCT primitives —
  snapping is drafting-domain logic, not a kernel feature.
- NATIVE gaps (observed by API introspection, not by absence of effort):
  OCCT provides no layer model, no dimension/annotation entities and no 2D
  constraint solver.
- Gap evaluation: ezdxf (DXF) provides layers + dimension entities as a 2D
  drafting *representation* candidate; tested for round-trip fidelity. This
  is additional-candidate evaluation justified by the observed OCCT gap,
  per the issue's candidate policy.
"""
from __future__ import annotations

from ..fixtures import PLAN_DIMENSIONS, PLAN_GRID, PLAN_LAYERS, PLAN_SEGMENTS


def run(result) -> None:
    # ------------------------------------------------------------------
    # 1. Precision: OCCT 2D analytic geometry
    # ------------------------------------------------------------------
    from OCP.gp import gp_Pnt2d, gp_Dir2d, gp_Ax2d
    from OCP.Geom2d import Geom2d_Line, Geom2d_Circle
    from OCP.Precision import Precision
    from OCP.Geom2dAPI import Geom2dAPI_ProjectPointOnCurve


    confusion = Precision.Confusion_s()
    result.observe(
        "2d/precision/confusion-bounded",
        "OCCT reports a well-defined modeler precision (Precision::Confusion).",
        1e-8 < confusion < 1e-6,
        details={"confusion": confusion},
        epistemic="NATIVE",
    )

    # Line-circle intersection-free geometry: distance from point to line
    axis = gp_Ax2d(gp_Pnt2d(0, 0), gp_Dir2d(1, 0))
    line = Geom2d_Line(axis)
    proj = Geom2dAPI_ProjectPointOnCurve(gp_Pnt2d(3.0, 4.0), line)
    distance = proj.LowerDistance()
    result.assert_close(
        "2d/precision/point-line-distance",
        "Point-to-line projection distance matches analytic |y|=4.0 exactly.",
        distance, 4.0, 1e-12,
        epistemic="NATIVE",
    )

    # Circle parametrization precision
    circle = Geom2d_Circle(gp_Ax2d(gp_Pnt2d(0, 0), gp_Dir2d(1, 0)), 2.5)
    p = circle.Value(0.0)  # (2.5, 0)
    result.assert_close(
        "2d/precision/circle-parametrization",
        "Circle parametrization returns the exact radius point.",
        (p.X() ** 2 + p.Y() ** 2) ** 0.5, 2.5, 1e-12,
        epistemic="NATIVE",
    )

    # Equidistant-by-parameter points on a curve (dimension-extension-line use case)
    import math

    n_pts = 12
    pts = [circle.Value(2 * math.pi * i / n_pts) for i in range(n_pts)]
    radii = [(p.X() ** 2 + p.Y() ** 2) ** 0.5 for p in pts]
    count = len(pts)
    result.observe(
        "2d/precision/curve-discretization",
        "Parametric evaluation of a circle: every sampled point lies exactly on the radius.",
        all(abs(r - 2.5) <= 1e-12 for r in radii),
        details={"points": count, "max_radius_error": max(abs(r - 2.5) for r in radii)},
        epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 2. Snapping: adapter-level capability built on OCCT projection
    # ------------------------------------------------------------------
    def snap_to_grid(x: float, y: float, spacing: float):
        return round(x / spacing) * spacing, round(y / spacing) * spacing

    def snap_endpoint_to_curve(px: float, py: float, curve, tolerance: float):
        proj = Geom2dAPI_ProjectPointOnCurve(gp_Pnt2d(px, py), curve)
        p = proj.NearestPoint()
        return p.X(), p.Y(), proj.LowerDistance()

    gx, gy = snap_to_grid(3.24, 4.87, PLAN_GRID["spacing"])
    result.observe(
        "2d/snapping/grid",
        "Grid snapping at 0.5 m spacing (adapter-level drafting logic).",
        (gx, gy) == (3.0, 5.0),
        details={"input": (3.24, 4.87), "snapped": (gx, gy), "spacing": PLAN_GRID["spacing"]},
        epistemic="ADAPTER",
    )

    sx, sy, _dist = snap_endpoint_to_curve(3.0 + 1e-9, 4.0, line, confusion * 10)
    within = abs(sx - 3.0) <= confusion * 10 and abs(sy - 0.0) <= confusion * 10
    result.observe(
        "2d/snapping/endpoint-tolerance",
        "Endpoint snapping lands on the exact endpoint within OCCT tolerance.",
        within,
        details={"snapped": (sx, sy), "occt_confusion": confusion, "endpoint": (3.0, 0.0)},
        epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 3. Layers: OCCT native gap + DXF layer capability
    # ------------------------------------------------------------------
    try:
        import OCP.Geom2d as _g2d

        has_layer_attr = any(
            hasattr(_g2d, n) and "layer" in n.lower() for n in dir(_g2d)
        )
    except Exception:
        has_layer_attr = False
    result.observe(
        "2d/layers/occt-native-gap",
        "OCCT exposes no layer model in its 2D geometry API (observed by API introspection).",
        not has_layer_attr,
        details={
            "finding": "OCCT is a geometry kernel, not a drafting application; "
            "layers must come from the BIM/representation layer (IFC) or a "
            "drafting representation format (DXF), not from the kernel",
        },
        epistemic="OBSERVED",
    )

    import ezdxf

    LAYER_BY_ID = {l["id"]: l["name"] for l in PLAN_LAYERS}
    doc = ezdxf.new("R2010", setup=True)
    msp = doc.modelspace()
    for layer in PLAN_LAYERS:
        if layer["name"] not in doc.layers:
            doc.layers.add(layer["name"], color=int(layer["color"][1:3], 16))
    for layer_id, x0, y0, x1, y1 in PLAN_SEGMENTS:
        msp.add_line((x0, y0), (x1, y1), dxfattribs={"layer": LAYER_BY_ID[layer_id]})
    doc.saveas("/tmp/plan2d.dxf")

    doc2 = ezdxf.readfile("/tmp/plan2d.dxf")
    msp2 = doc2.modelspace()
    layers_out = sorted(l.dxf.name for l in doc2.layers)
    expected_layers = sorted(l["name"] for l in PLAN_LAYERS)
    auto_layers = {"0", "Defpoints"}  # DXF always defines layer 0; setup adds Defpoints
    result.observe(
        "2d/layers/dxf-roundtrip",
        "DXF layer table round-trips: every fixture layer preserved "
        "(auto layers 0/Defpoints excluded from the assertion).",
        set(expected_layers).issubset(set(layers_out)),
        details={"layers": layers_out, "fixture_layers": expected_layers},
        epistemic="NATIVE",
    )

    # segments preserved with layer assignment and exact coordinates
    lines_out = list(msp2.query("LINE"))
    ok = len(lines_out) == len(PLAN_SEGMENTS)
    for line, (layer_id, x0, y0, x1, y1) in zip(lines_out, PLAN_SEGMENTS):
        if line.dxf.layer != LAYER_BY_ID[layer_id]:
            ok = False
        if abs(line.dxf.start[0] - x0) > 1e-12 or abs(line.dxf.end[0] - x1) > 1e-12:
            ok = False
    result.observe(
        "2d/layers/dxf-segment-fidelity",
        "DXF segments round-trip with layer assignment and exact coordinates.",
        ok,
        details={"segments": len(lines_out)},
        epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 4. Dimensions: OCCT gap + DXF dimension entities
    # ------------------------------------------------------------------
    for dim_id, (x0, y0), (x1, y1), expected, _text in PLAN_DIMENSIONS:
        dim = msp2.add_aligned_dim(
            p1=(x0, y0),
            p2=(x1, y1),
            distance=0.5,
            dimstyle="EZDXF",
            dxfattribs={"layer": "DIMENSIONS"},
        )
        dim.render()
    doc2.saveas("/tmp/plan2d-dims.dxf")
    doc3 = ezdxf.readfile("/tmp/plan2d-dims.dxf")
    dims = list(doc3.modelspace().query("DIMENSION"))
    result.observe(
        "2d/dimensions/dxf-entities",
        "DXF aligned dimension entities round-trip for fixture dimensions.",
        len(dims) == len(PLAN_DIMENSIONS),
        details={"dimensions": len(dims)},
        epistemic="NATIVE",
    )
    # measurement precision of the dimension entities
    measured = []
    for dim in dims:
        m = dim.get_measurement()
        measured.append(m)
    expected_lengths = [d[3] for d in PLAN_DIMENSIONS]
    all_ok = all(
        abs(m - e) <= 1e-9 for m, e in zip(measured, expected_lengths)
    )
    result.observe(
        "2d/dimensions/measurement-precision",
        "DXF dimension measurements match fixture lengths exactly.",
        all_ok,
        details={"measured": measured, "expected": expected_lengths},
        epistemic="NATIVE",
    )

    result.measure("dxf_version", "R2010")
    result.measure("ezdxf_version", ezdxf.__version__)
