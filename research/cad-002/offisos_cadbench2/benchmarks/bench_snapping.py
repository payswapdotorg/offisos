"""Benchmark: snapping and object inference surface (RESEARCH-CAD-002 scope 1).

Distinguishes precisely what is console-observable from what is GUI-only:

- NATIVE (console): the Draft snapping parameter system (modes, ranges);
  geometric object inference via Part APIs (nearest point on shape,
  distToShape, vertex/edge access for endpoint/midpoint computation).
- ADAPTER: snapping logic (endpoint/midpoint/grid/intersection snapping)
  computed from native geometry queries — drafting domain logic, not an
  engine feature.
- GUI-only boundary (recorded from RESEARCH-CAD-001 and re-confirmed):
  the interactive snap toolbar and highlight UI run in the GUI runtime
  only; that is an application boundary, not a geometry limitation.
"""
from __future__ import annotations


def run(result) -> None:
    from ..freecad_runner import find_freecadcmd, run_freecad_script

    freecadcmd = find_freecadcmd()
    if freecadcmd is None:
        result.observe(
            "cad2-snap/availability", "FreeCAD not available.", False,
            details={}, epistemic="OBSERVED",
            unknown_reason="FreeCAD not installed (see README)",
        )
        return

    script = """
import math
import FreeCAD, Part, Draft

doc = FreeCAD.newDocument("benchsnap")

# ------------------------------------------------------------------
# 1. Draft snapping parameter system (console-observable native state)
# ------------------------------------------------------------------
prefs = FreeCAD.ParamGet("User parameter:BaseApp/Preferences/Mod/Draft")
prefs.SetBool("objectSnap", True)
prefs.SetBool("gridSnap", True)
prefs.SetFloat("gridSpacing", 0.25)
prefs.SetFloat("snapRange", 0.1)
object_snap = prefs.GetBool("objectSnap", False)
grid_snap = prefs.GetBool("gridSnap", False)
grid_spacing = prefs.GetFloat("gridSpacing", -1.0)
snap_range = prefs.GetFloat("snapRange", -1.0)
record("cad2-snap/parameter-system",
       "Draft snap parameters (objectSnap, gridSnap, gridSpacing, snapRange) "
       "read/write exactly through the console parameter system.",
       object_snap is True and grid_snap is True
       and abs(grid_spacing - 0.25) <= 1e-12 and abs(snap_range - 0.1) <= 1e-12,
       details={"objectSnap": object_snap, "gridSnap": grid_snap,
                "gridSpacing": grid_spacing, "snapRange": snap_range})

# ------------------------------------------------------------------
# 2. Native object inference: nearest point on shape, exact distances
# ------------------------------------------------------------------
box = Part.makeBox(4, 4, 4)
d = box.distToShape(Part.Vertex(FreeCAD.Vector(6, 0, 0)))
record("cad2-snap/native-nearest-distance",
       "Part.distToShape reports the exact nearest distance from a point to "
       "a solid (6.0 point to box face at x=4 -> 2.0).",
       abs(d[0] - 2.0) <= 1e-12,
       details={"distance": d[0], "expected": 2.0})

pair = box.distToShape(Part.Vertex(FreeCAD.Vector(6, 0, 0)))[1][0]
pt_on_box = pair[0]
record("cad2-snap/native-nearest-point",
       "The nearest-point query returns the exact point on the face (4, 0, 0).",
       abs(pt_on_box.x - 4.0) <= 1e-12 and abs(pt_on_box.y - 0.0) <= 1e-12
       and abs(pt_on_box.z - 0.0) <= 1e-12,
       details={"nearest": (pt_on_box.x, pt_on_box.y, pt_on_box.z)})

# ------------------------------------------------------------------
# 3. ADAPTER snapping: endpoint/midpoint/intersection from native queries
# ------------------------------------------------------------------
line = Draft.make_line(FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(8, 0, 0))
doc.recompute()
edge = line.Shape.Edges[0]

def snap_endpoint(candidate):
    best, best_d = None, float("inf")
    for v in line.Shape.Vertexes:
        dd = candidate.distanceToPoint(v.Point)
        if dd < best_d:
            best, best_d = v.Point, dd
    return best, best_d

near_end = FreeCAD.Vector(7.9999999, 0.0000001, 0)
snapped, dist = snap_endpoint(near_end)
record("cad2-snap/adapter-endpoint-snap",
       "Endpoint snapping via vertex distance query lands exactly on (8, 0).",
       abs(snapped.x - 8.0) <= 1e-12 and abs(snapped.y) <= 1e-12,
       details={"snapped": (snapped.x, snapped.y), "distance": dist})

def snap_midpoint(edge):
    return edge.valueAt((edge.FirstParameter + edge.LastParameter) / 2.0)

mid = snap_midpoint(edge)
record("cad2-snap/adapter-midpoint-snap",
       "Midpoint snapping via edge parametrization lands exactly on (4, 0).",
       abs(mid.x - 4.0) <= 1e-12 and abs(mid.y) <= 1e-12,
       details={"midpoint": (mid.x, mid.y)})

# intersection snapping of two crossing edges: distToShape returns
# distance 0 with the exact crossing point (native query)
l2 = Draft.make_line(FreeCAD.Vector(4, -3, 0), FreeCAD.Vector(4, 3, 0))
doc.recompute()
dist, pairs, _info = edge.distToShape(l2.Shape)
cross = pairs[0][0]
record("cad2-snap/adapter-intersection-snap",
       "Intersection snapping via distToShape on crossing edges reports "
       "distance 0 with the exact crossing point (4, 0).",
       abs(dist - 0.0) <= 1e-12 and abs(cross.x - 4.0) <= 1e-12
       and abs(cross.y - 0.0) <= 1e-12,
       details={"distance": dist, "crossing": (cross.x, cross.y),
                "note": "edge.common() computes overlap, not crossing; "
                        "distToShape is the correct native query"})

# grid snap via the parameter state (adapter arithmetic)
def snap_grid(v, spacing):
    return FreeCAD.Vector(round(v.x / spacing) * spacing,
                          round(v.y / spacing) * spacing, 0)

g = snap_grid(FreeCAD.Vector(1.13, 2.87, 0), 0.25)
record("cad2-snap/adapter-grid-snap",
       "Grid snapping at the configured 0.25 m spacing is exact.",
       abs(g.x - 1.25) <= 1e-12 and abs(g.y - 2.75) <= 1e-12,
       details={"snapped": (g.x, g.y), "spacing": 0.25})

# ------------------------------------------------------------------
# 4. GUI-only boundary (recorded, not worked around)
# ------------------------------------------------------------------
# GUI boundary: FreeCADGui imports as a stub with no GUI API in console
# mode; TechDrawGui cannot load at all
gui_stub = False
try:
    import FreeCADGui
    has_api = hasattr(FreeCADGui, "getMainWindow")
    gui_stub = not has_api  # imports but exposes no GUI API
except ImportError:
    gui_stub = False
techdrawgui_blocked = False
try:
    import TechDrawGui  # noqa: F401
except ImportError:
    techdrawgui_blocked = True
record("cad2-snap/gui-boundary",
       "FINDING: in console mode FreeCADGui imports only as a stub with no "
       "GUI API (no getMainWindow/activeDocument) and TechDrawGui cannot "
       "load at all. The geometry queries that snapping needs are fully "
       "console-capable (checked above); only the interactive snap "
       "toolbar/highlight UX layer requires the GUI runtime.",
       gui_stub and techdrawgui_blocked,
       details={"freecadgui_stub_without_api": gui_stub,
                "techdrawgui_loadable": not techdrawgui_blocked,
                "console_capable_layer": "geometry queries + parameter state",
                "gui_only_layer": "interactive snap toolbar/highlight"},
       epistemic="OBSERVED")
"""
    checks = run_freecad_script(script, freecadcmd)
    for check in checks:
        result.observe(
            check["id"], check["description"], check["status"] == "pass",
            details=check.get("details") or {}, epistemic=check.get("epistemic", "NATIVE"),
        )
