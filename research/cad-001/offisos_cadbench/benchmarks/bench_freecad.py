"""Benchmark: FreeCAD Draft and TechDraw capabilities (RESEARCH-CAD-001).

Produces the missing FreeCAD evidence required by the Architect's
changes-requested directive (PR #15, DEC-001 remediation item 2):

- **Draft** (evidence item 1, 2D drafting): lines, rectangles, layers,
  linear dimensions with exact measurements, and the Draft parameter
  system (grid spacing) — all in console mode.
- **TechDraw** (drawing production): hidden-line projection, a real
  DrawPage/DrawViewPart with an A4 template, view geometry, and DXF page
  export. SVG/PDF page export is GUI-only (TechDrawGui cannot load in a
  console application) — recorded as an explicit observed limitation.

FreeCAD 1.1.3 runs via the headless runner (freecad_runner.py): every
FreeCAD import stays inside the engine boundary; benchmark code consumes
structured JSON results. Engine provenance: official AppImage
FreeCAD_1.1.3-Linux-x86_64-py311.AppImage, SHA256
3a853eb69ee595f779f2255dbf80a765926981d8ff68903cefee4dfb03a8f5ef.
"""
from __future__ import annotations

# Exact AppImage provenance for reproducibility (the 782 MB binary itself
# is not committed; see README "FreeCAD environment").
FREECAD_APPIMAGE = {
    "version": "1.1.3",
    "url": "https://github.com/FreeCAD/FreeCAD/releases/download/1.1.3/FreeCAD_1.1.3-Linux-x86_64-py311.AppImage",
    "sha256": "3a853eb69ee595f779f2255dbf80a765926981d8ff68903cefee4dfb03a8f5ef",
    "bytes": 820795896,
}

DRAFT_TECHDRAW_SCRIPT = """
import os, traceback
import FreeCAD, Part, Draft, TechDraw

doc = FreeCAD.newDocument("bench_freecad")

# ------------------------------------------------------------------
# 1. Draft: exact 2D primitives
# ------------------------------------------------------------------
line = Draft.make_line(FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(8, 0, 0))
doc.recompute()
record("freecad/draft/line-exact",
       "Draft line: length and endpoints exact (8.0 m fixture segment).",
       abs(line.Length.Value - 8.0) <= 1e-9
       and abs(line.Start.x - 0.0) <= 1e-9 and abs(line.End.x - 8.0) <= 1e-9,
       details={"length": line.Length.Value,
                "start": (line.Start.x, line.Start.y),
                "end": (line.End.x, line.End.y)})

rect = Draft.make_rectangle(8.0, 5.0)
doc.recompute()
record("freecad/draft/rectangle-exact",
       "Draft rectangle: Length/Height exact and shape area = 40 m^2 with 4 edges.",
       abs(rect.Length.Value - 8.0) <= 1e-9
       and abs(rect.Height.Value - 5.0) <= 1e-9
       and abs(rect.Shape.Area - 40.0) <= 1e-9
       and len(rect.Shape.Edges) == 4,
       details={"length": rect.Length.Value, "height": rect.Height.Value,
                "area": rect.Shape.Area, "edges": len(rect.Shape.Edges)})

# ------------------------------------------------------------------
# 2. Draft: layers (group semantics)
# ------------------------------------------------------------------
layer = Draft.make_layer("WALL")
layer.Group = layer.Group + [line]
doc.recompute()
members = [o.Name for o in layer.Group]
record("freecad/draft/layer-assignment",
       "Draft layer: object assignment via Group round-trips with exact membership.",
       members == [line.Name] and layer.Label == "WALL",
       details={"layer": layer.Label, "members": members})

# ------------------------------------------------------------------
# 3. Draft: linear dimension with exact measured value
# ------------------------------------------------------------------
dim = Draft.make_dimension(FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(8, 0, 0),
                           FreeCAD.Vector(0, 1, 0))
doc.recompute()
record("freecad/draft/dimension-exact",
       "Draft linear dimension measures the fixture length exactly (Distance = 8.0).",
       abs(dim.Distance.Value - 8.0) <= 1e-9,
       details={"distance": dim.Distance.Value})

dim2 = Draft.make_dimension(FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(0, 5, 0),
                            FreeCAD.Vector(1, 0, 0))
doc.recompute()
record("freecad/draft/dimension-vertical-exact",
       "Second dimension (vertical fixture edge) measures exactly 5.0.",
       abs(dim2.Distance.Value - 5.0) <= 1e-9,
       details={"distance": dim2.Distance.Value})

# ------------------------------------------------------------------
# 4. Draft: parameter system (grid spacing) — console evidence
# ------------------------------------------------------------------
prefs = FreeCAD.ParamGet("User parameter:BaseApp/Preferences/Mod/Draft")
prefs.SetFloat("gridSpacing", 0.5)
grid = prefs.GetFloat("gridSpacing", -1.0)
prefs.SetBool("gridSnap", True)
snap = prefs.GetBool("gridSnap", False)
record("freecad/draft/grid-parameters",
       "Draft grid parameters (spacing, snap) read/write exactly through the "
       "console parameter system; interactive snapping itself is a GUI workflow.",
       abs(grid - 0.5) <= 1e-9 and snap is True,
       details={"grid_spacing": grid, "grid_snap": snap,
                "note": "Draft snap toolbar is GUI-only; parameter state is the "
                        "console-observable part"})

# ------------------------------------------------------------------
# 5. TechDraw: hidden-line projection
# ------------------------------------------------------------------
box = doc.addObject("Part::Box", "Box")
box.Length, box.Width, box.Height = 2.0, 3.0, 4.0
doc.recompute()
projection = TechDraw.project(box.Shape, FreeCAD.Vector(0, 0, 1))
vis_edges = len(projection[0].Edges)
hidden_edges = len(projection[1].Edges)
record("freecad/techdraw/hlr-projection",
       "TechDraw HLR projection of a box along Z: exactly 4 visible edges, "
       "0 hidden edges (top view outline).",
       vis_edges == 4 and hidden_edges == 0,
       details={"visible_edges": vis_edges, "hidden_edges": hidden_edges})

# ------------------------------------------------------------------
# 6. TechDraw: page, template and part view
# ------------------------------------------------------------------
tpl = os.path.join(FreeCAD.getResourceDir(), "Mod", "TechDraw", "Templates",
                   "Default_Template_A4_Landscape.svg")
record("freecad/techdraw/template-available",
       "A standard A4 landscape SVG template ships with the engine.",
       os.path.exists(tpl), details={"template": os.path.basename(tpl)})

page = doc.addObject("TechDraw::DrawPage", "Page")
template = doc.addObject("TechDraw::DrawSVGTemplate", "Template")
template.Template = tpl
page.Template = template
view = doc.addObject("TechDraw::DrawViewPart", "View")
view.Source = [box]
view.Direction = FreeCAD.Vector(0, 0, 1)
page.addView(view)
doc.recompute()
record("freecad/techdraw/page-view",
       "DrawPage with A4 template carries the DrawViewPart (1 view).",
       len(page.Views) == 1 and view.Scale == 1.0,
       details={"views": len(page.Views), "scale": view.Scale})

edge_count = 0
try:
    while edge_count < 200:
        view.getEdgeByIndex(edge_count)
        edge_count += 1
except Exception:
    pass
record("freecad/techdraw/view-geometry",
       "The view exposes exactly 4 projected edges for the box top view.",
       edge_count == 4, details={"edges": edge_count})

# ------------------------------------------------------------------
# 7. TechDraw: DXF export (console-capable)
# ------------------------------------------------------------------
out_dxf = "/tmp/freecad-bench-page.dxf"
TechDraw.writeDXFPage(page, out_dxf)
size = os.path.getsize(out_dxf)
with open(out_dxf) as f:
    head = f.read(200)
record("freecad/techdraw/dxf-export",
       "TechDraw page exports to DXF in console mode with valid DXF content.",
       size > 1000 and ("SECTION" in head or head.startswith("0") or "DXF" in head),
       details={"bytes": size})

# ------------------------------------------------------------------
# 8. TechDraw: SVG export is GUI-only (explicit limitation)
# ------------------------------------------------------------------
svg_importable = True
try:
    import TechDrawGui  # noqa: F401
except ImportError:
    svg_importable = False
record("freecad/techdraw/svg-export-gui-only",
       "FINDING: TechDrawGui cannot load in a console application; SVG/PDF "
       "page export requires the GUI runtime. DXF export (checked above) is "
       "the console-capable path. Recorded as an engine capability boundary, "
       "not a failure.",
       not svg_importable,
       details={"techdrawgui_importable": svg_importable,
                "console_export_path": "TechDraw.writeDXFPage"})

# ------------------------------------------------------------------
# 9. Document persistence (FCStd)
# ------------------------------------------------------------------
out_fcstd = "/tmp/freecad-bench-doc.FCStd"
doc.saveAs(out_fcstd)
record("freecad/persistence/fcstd",
       "The benchmark document persists to FCStd and reopens with the Draft "
       "objects intact.",
       os.path.getsize(out_fcstd) > 0,
       details={"bytes": os.path.getsize(out_fcstd)})

doc2 = FreeCAD.openDocument(out_fcstd)
reopened = doc2.getObject(line.Name)
record("freecad/persistence/reopen-objects",
       "Reopened FCStd preserves the Draft line with its exact geometry.",
       reopened is not None and abs(reopened.Length.Value - 8.0) <= 1e-9,
       details={"length_after_reopen": reopened.Length.Value if reopened else None})
"""


def run(result) -> None:
    from ..freecad_runner import find_freecadcmd, freecad_version, run_freecad_script

    freecadcmd = find_freecadcmd()
    if freecadcmd is None:
        result.observe(
            "freecad/availability",
            "FreeCAD is not available in this environment: Draft and TechDraw "
            "capabilities NOT tested here. Recorded as an explicit environment "
            "limitation, not an engine failure.",
            False,
            details={},
            epistemic="OBSERVED",
            unknown_reason="FreeCAD not installed (see research/cad-001/README.md "
            "for the reproducible AppImage setup)",
        )
        return

    # ------------------------------------------------------------------
    # Engine provenance: exact version from the engine itself
    # ------------------------------------------------------------------
    version = freecad_version(freecadcmd)
    result.observe(
        "freecad/version",
        "FreeCAD engine reports its exact version (matches the pinned AppImage).",
        version.get("version") == FREECAD_APPIMAGE["version"],
        details={
            "engine_version": version.get("version"),
            "appimage": FREECAD_APPIMAGE["url"].rsplit("/", 1)[-1],
            "appimage_sha256": FREECAD_APPIMAGE["sha256"],
            "build_date": version.get("build_date"),
        },
        epistemic="NATIVE",
    )
    result.measure("freecad_version", version.get("version"))
    result.measure("freecad_appimage_sha256", FREECAD_APPIMAGE["sha256"])

    # ------------------------------------------------------------------
    # Draft + TechDraw capability evidence
    # ------------------------------------------------------------------
    checks = run_freecad_script(DRAFT_TECHDRAW_SCRIPT, freecadcmd)
    for check in checks:
        result.observe(
            check["id"], check["description"], check["status"] == "pass",
            details=check.get("details") or {},
            epistemic=check.get("epistemic", "NATIVE"),
        )
