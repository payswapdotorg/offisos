"""FreeCAD-backed implementation of the RESEARCH-CAD-002 CAD adapter.

Every adapter method:
1. builds a self-contained FreeCAD script;
2. executes it in a fresh FreeCADCmd process (engine boundary preserved —
   this module never imports FreeCAD in-process);
3. persists document state explicitly via FCStd files between calls;
4. returns a structured OperationResult.

Process isolation IS the "stable adapter rather than application-global
state" demonstration required by issue #2 scope 4: no FreeCAD application
state can leak between operations because each operation starts from a
clean process, with state carried only through explicit document files.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from ..adapter import (
    CadEngineAdapter,
    InvalidInputError,
    OperationResult,
)
from ..freecad_runner import find_freecadcmd, freecad_version


class FreeCadCadAdapter(CadEngineAdapter):
    engine_id = "freecad+occt"

    def __init__(self, workdir: str | None = None, freecadcmd: str | None = None):
        self._freecadcmd = freecadcmd or find_freecadcmd()
        if self._freecadcmd is None:
            raise InvalidInputError(
                "FreeCADCmd not found (set FREECADCMD or install the pinned "
                "AppImage — see requirements.txt)"
            )
        self._workdir = Path(workdir or tempfile.mkdtemp(prefix="offisos-cad2-"))
        self._workdir.mkdir(parents=True, exist_ok=True)
        self._seq = 0
        v = freecad_version(self._freecadcmd)
        self.engine_version = f"freecad {v.get('version')} (build {v.get('build_date')})"

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------

    def _next_path(self, stem: str) -> Path:
        self._seq += 1
        return self._workdir / f"{stem}-{self._seq:03d}.FCStd"

    def _run(self, script: str) -> dict[str, Any]:
        """Execute a script that prints @@OP@@<json>; enforce typed errors."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False
        ) as f:
            f.write(script)
            script_path = f.name
        try:
            result = subprocess.run(
                [self._freecadcmd, "--console", script_path],
                capture_output=True, text=True, timeout=300,
                stdin=subprocess.DEVNULL,
            )
        finally:
            Path(script_path).unlink(missing_ok=True)
        payload = None
        for line in result.stdout.splitlines():
            if line.startswith("@@OP@@"):
                payload = line[len("@@OP@@"):]
        if payload is None:
            raise InvalidInputError(
                f"adapter script produced no result; stderr tail: "
                f"{result.stderr[-500:]}"
            )
        return json.loads(payload)

    # ------------------------------------------------------------------
    # parametric 3D
    # ------------------------------------------------------------------

    def create_parametric_box_document(
        self, length: float, width: float, height: float
    ) -> OperationResult:
        out = self._next_path("parambox")
        script = f"""
import json
import FreeCAD, Part

doc = FreeCAD.newDocument("parambox")
box = doc.addObject("Part::Box", "Box")
box.Length = {length!r}
box.Width = {width!r}
box.Height = {height!r}
doc.recompute()
doc.saveAs(r"{out}")
ok = "Invalid" not in box.State
print("@@OP@@" + json.dumps({{
    "ok": ok,
    "measurements": {{
        "object_count": len(doc.Objects),
        "volume": box.Shape.Volume,
        "doc_path": r"{out}",
        "box_state": box.State,
    }},
    "errors": [] if ok else ["box in invalid state"],
}}))
"""
        data = self._run(script)
        return OperationResult(
            operation="create_parametric_box_document",
            ok=data["ok"], measurements=data["measurements"], errors=data["errors"],
        )

    def edit_parameter(
        self, doc_path: str, object_name: str, parameter: str, value: float
    ) -> OperationResult:
        script = f"""
import json
import FreeCAD

doc = FreeCAD.openDocument(r"{doc_path}")
obj = doc.getObject({object_name!r})
if obj is None:
    print("@@OP@@" + json.dumps({{"ok": False, "measurements": {{}},
                                  "errors": ["object not found"]}}))
else:
    before = obj.Shape.Volume
    touched_before = [o.Name for o in doc.Objects if "Touched" in o.State]
    setattr(obj, {parameter!r}, {value!r})
    changed_touched = [o.Name for o in doc.Objects if "Touched" in o.State]
    recomputed = doc.recompute()
    after = obj.Shape.Volume
    ok = "Invalid" not in obj.State
    doc.save()
    print("@@OP@@" + json.dumps({{
        "ok": ok,
        "measurements": {{
            "volume_before": before,
            "volume_after": after,
            "touched_before": touched_before,
            "touched_after_change": changed_touched,
            "recompute_count": recomputed,
            "object_state": obj.State,
        }},
        "errors": [] if ok else ["object in invalid state after edit"],
    }}))
"""
        data = self._run(script)
        return OperationResult(
            operation="edit_parameter",
            ok=data["ok"], measurements=data["measurements"], errors=data["errors"],
        )

    # ------------------------------------------------------------------
    # interoperability
    # ------------------------------------------------------------------

    def export_step(self, doc_path: str, object_name: str, out_path: str) -> OperationResult:
        script = f"""
import json, os
import FreeCAD, Part

doc = FreeCAD.openDocument(r"{doc_path}")
obj = doc.getObject({object_name!r})
if obj is None:
    print("@@OP@@" + json.dumps({{"ok": False, "measurements": {{}},
                                  "errors": ["object not found"]}}))
else:
    Part.export([obj], r"{out_path}")
    print("@@OP@@" + json.dumps({{
        "ok": os.path.exists(r"{out_path}"),
        "measurements": {{"step_path": r"{out_path}",
                          "bytes": os.path.getsize(r"{out_path}")}},
        "errors": [],
    }}))
"""
        data = self._run(script)
        return OperationResult(
            operation="export_step",
            ok=data["ok"], measurements=data["measurements"], errors=data["errors"],
        )

    def import_step_volume(self, step_path: str) -> OperationResult:
        script = f"""
import json, os
import Part

if not os.path.exists(r"{step_path}"):
    print("@@OP@@" + json.dumps({{"ok": False, "measurements": {{}},
                                  "errors": ["step file not found"]}}))
else:
    shape = Part.read(r"{step_path}")
    print("@@OP@@" + json.dumps({{
        "ok": True,
        "measurements": {{"volume": shape.Volume, "solids": len(shape.Solids)}},
        "errors": [],
    }}))
"""
        data = self._run(script)
        return OperationResult(
            operation="import_step_volume",
            ok=data["ok"], measurements=data["measurements"], errors=data["errors"],
        )

    # ------------------------------------------------------------------
    # 2D drafting
    # ------------------------------------------------------------------

    def create_draft_document(
        self, segments: list[tuple[float, float, float, float]]
    ) -> OperationResult:
        out = self._next_path("draft")
        segs = json.dumps(segments)
        script = f"""
import json
import FreeCAD, Draft

doc = FreeCAD.newDocument("draft")
segs = {segs}
for i, (x0, y0, x1, y1) in enumerate(segs):
    Draft.make_line(FreeCAD.Vector(x0, y0, 0), FreeCAD.Vector(x1, y1, 0))
doc.recompute()
total = sum(o.Length.Value for o in doc.Objects if hasattr(o, "Length"))
doc.saveAs(r"{out}")
print("@@OP@@" + json.dumps({{
    "ok": len(doc.Objects) == len(segs),
    "measurements": {{"line_count": len(doc.Objects),
                      "total_length": total,
                      "doc_path": r"{out}"}},
    "errors": [],
}}))
"""
        data = self._run(script)
        return OperationResult(
            operation="create_draft_document",
            ok=data["ok"], measurements=data["measurements"], errors=data["errors"],
        )

    # ------------------------------------------------------------------
    # engine identity
    # ------------------------------------------------------------------

    def engine_identity(self) -> OperationResult:
        script = """
import json
import FreeCAD

v = FreeCAD.Version()
print("@@OP@@" + json.dumps({
    "ok": True,
    "measurements": {
        "version": ".".join(str(x) for x in v[:3]),
        "version_tuple": [int(x) for x in v[:3]],
        "build_date": str(v[3]) if len(v) > 3 else "",
    },
    "errors": [],
}))
"""
        data = self._run(script)
        return OperationResult(
            operation="engine_identity",
            ok=data["ok"], measurements=data["measurements"], errors=data["errors"],
        )
