"""Benchmark: automation/API determinism (RESEARCH-CAD-002 scope 4).

- Repeatable scripted creation/edit/export: the identical adapter call
  sequence (create parametric box -> edit parameter -> export STEP ->
  reimport) run TWICE produces identical results.
- Process isolation: every adapter operation runs in a fresh FreeCADCmd
  process — the stable-adapter-not-application-global-state proof.
- In-process determinism: the same document build twice in one process
  yields identical measurements.
- STEP semantic round-trip exactness; byte-level export determinism
  recorded honestly (timestamps make bytes differ — a finding, not a
  failure; semantic determinism is what is asserted).
"""
from __future__ import annotations


def run(result) -> None:
    from ..freecad_runner import find_freecadcmd, run_freecad_script
    from ..engines.freecad_adapter import FreeCadCadAdapter
    from ..adapter import InvalidInputError

    freecadcmd = find_freecadcmd()
    if freecadcmd is None:
        result.observe(
            "cad2-auto/availability", "FreeCAD not available.", False,
            details={}, epistemic="OBSERVED",
            unknown_reason="FreeCAD not installed (see README)",
        )
        return

    # ------------------------------------------------------------------
    # 1. Engine identity through the adapter (exact version)
    # ------------------------------------------------------------------
    adapter = FreeCadCadAdapter()
    identity = adapter.engine_identity()
    result.observe(
        "cad2-auto/adapter-engine-identity",
        "The adapter reports the exact engine identity (FreeCAD version and "
        "build date) through the stable contract.",
        identity.ok and identity.measurements.get("version") == "1.1.3",
        details=identity.measurements, epistemic="ADAPTER",
    )
    result.measure("adapter_engine", adapter.engine_id)
    result.measure("adapter_engine_version", adapter.engine_version)

    # ------------------------------------------------------------------
    # 2. Adapter workflow determinism: identical call sequence, twice
    # ------------------------------------------------------------------
    def adapter_workflow():
        created = adapter.create_parametric_box_document(3.0, 4.0, 5.0)
        doc_path = created.measurements["doc_path"]
        edited = adapter.edit_parameter(doc_path, "Box", "Length", 6.0)
        step_path = doc_path.replace(".FCStd", ".step")
        exported = adapter.export_step(doc_path, "Box", step_path)
        imported = adapter.import_step_volume(step_path)
        return {
            "create_volume": created.measurements["volume"],
            "edit_before": edited.measurements["volume_before"],
            "edit_after": edited.measurements["volume_after"],
            "recompute_count": edited.measurements["recompute_count"],
            "step_bytes": exported.measurements["bytes"],
            "reimport_volume": imported.measurements["volume"],
            "reimport_solids": imported.measurements["solids"],
        }

    run_a = adapter_workflow()
    run_b = adapter_workflow()
    semantic_keys = [
        "create_volume", "edit_before", "edit_after",
        "recompute_count", "reimport_volume", "reimport_solids",
    ]
    identical = all(run_a[k] == run_b[k] for k in semantic_keys)
    result.observe(
        "cad2-auto/adapter-workflow-determinism",
        "The identical adapter workflow (create -> edit -> export STEP -> "
        "reimport), executed twice with fresh process-isolated calls, "
        "produces identical results for every semantic measurement.",
        identical,
        details={"run_a": run_a, "run_b": run_b,
                 "compared_keys": semantic_keys},
        epistemic="OBSERVED",
    )

    # workflow correctness with exact expectations
    result.observe(
        "cad2-auto/adapter-workflow-correctness",
        "The adapter workflow computes exact values: create 3x4x5 = 60.0; "
        "edit Length to 6.0 -> 120.0; STEP reimport volume matches the "
        "edited source exactly (within 1e-9).",
        abs(run_a["create_volume"] - 60.0) <= 1e-9
        and abs(run_a["edit_after"] - 120.0) <= 1e-9
        and abs(run_a["reimport_volume"] - 120.0) <= 1e-9
        and run_a["reimport_solids"] == 1,
        details=run_a, epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 3. In-process scripted determinism: same build, two documents
    # ------------------------------------------------------------------
    script = """
import FreeCAD, Part

def build_document():
    doc = FreeCAD.newDocument("det")
    box = doc.addObject("Part::Box", "Box")
    box.Length, box.Width, box.Height = 2.5, 3.5, 4.5
    cyl = doc.addObject("Part::Cylinder", "Cyl")
    cyl.Radius, cyl.Height = 0.75, 3.0
    cut = doc.addObject("Part::Cut", "Cut")
    cut.Base, cut.Tool = box, cyl
    doc.recompute()
    return doc, cut

import math
doc1, cut1 = build_document()
doc2, cut2 = build_document()
same_volume = cut1.Shape.Volume == cut2.Shape.Volume
same_faces = len(cut1.Shape.Faces) == len(cut2.Shape.Faces)
same_edges = len(cut1.Shape.Edges) == len(cut2.Shape.Edges)
record("cad2-auto/inprocess-build-determinism",
       "Building the identical parametric model twice in one process "
       "yields bit-identical volume and identical topology counts.",
       same_volume and same_faces and same_edges,
       details={"volume": cut1.Shape.Volume,
                "faces": len(cut1.Shape.Faces), "edges": len(cut1.Shape.Edges),
                "volume_identical": same_volume})
"""
    checks = run_freecad_script(script, freecadcmd)
    for check in checks:
        result.observe(
            check["id"], check["description"], check["status"] == "pass",
            details=check.get("details") or {}, epistemic=check.get("epistemic", "NATIVE"),
        )

    # ------------------------------------------------------------------
    # 4. Export byte-determinism findings (recorded honestly)
    # ------------------------------------------------------------------
    script2 = """
import hashlib
import FreeCAD, Part

doc = FreeCAD.newDocument("exp")
box = doc.addObject("Part::Box", "Box")
box.Length, box.Width, box.Height = 2.0, 3.0, 4.0
doc.recompute()

Part.export([box], "/tmp/cad2-a.step")
Part.export([box], "/tmp/cad2-b.step")
ha = hashlib.sha256(open("/tmp/cad2-a.step", "rb").read()).hexdigest()
hb = hashlib.sha256(open("/tmp/cad2-b.step", "rb").read()).hexdigest()
head = open("/tmp/cad2-a.step").read(600)
step_same = ha == hb
record("cad2-auto/step-byte-determinism-finding",
       "FINDING: two STEP exports of the identical shape are NOT "
       "byte-identical (the STEP header embeds a generation timestamp). "
       "Semantic determinism is asserted separately; byte-level "
       "reproducibility of exports is not provided by the engine. "
       "Implication for Offisos: content hashing for change detection must "
       "be semantic (geometry/properties), not file-byte based.",
       not step_same,
       details={"hash_a": ha[:16], "hash_b": hb[:16],
                "header_contains_file_name": "FILE_NAME" in head},
       epistemic="OBSERVED")

# semantic determinism: reimport both exports -> identical volumes
va = Part.read("/tmp/cad2-a.step").Volume
vb = Part.read("/tmp/cad2-b.step").Volume
record("cad2-auto/step-semantic-determinism",
       "Reimporting both STEP exports yields the identical exact volume "
       "(24.0 within 1e-9): semantic content IS deterministic.",
       abs(va - 24.0) <= 1e-9 and abs(vb - 24.0) <= 1e-9 and va == vb,
       details={"volume_a": va, "volume_b": vb})

doc.saveAs("/tmp/cad2-a.FCStd")
doc.saveAs("/tmp/cad2-b.FCStd")
fa = hashlib.sha256(open("/tmp/cad2-a.FCStd", "rb").read()).hexdigest()
fb = hashlib.sha256(open("/tmp/cad2-b.FCStd", "rb").read()).hexdigest()
record("cad2-auto/fcstd-byte-determinism-finding",
       "FINDING: FCStd saves of the identical document are NOT "
       "byte-identical (container embeds save timestamps). Same "
       "implication as the STEP finding.",
       fa != fb,
       details={"hash_a": fa[:16], "hash_b": fb[:16]},
       epistemic="OBSERVED")
"""
    checks = run_freecad_script(script2, freecadcmd)
    for check in checks:
        result.observe(
            check["id"], check["description"], check["status"] == "pass",
            details=check.get("details") or {}, epistemic=check.get("epistemic", "NATIVE"),
        )

    # ------------------------------------------------------------------
    # 5. Typed failure through the adapter (missing object)
    # ------------------------------------------------------------------
    try:
        adapter.edit_parameter("/tmp/does-not-exist-999.FCStd", "Box", "Length", 2.0)
        typed_failure = False
    except InvalidInputError:
        typed_failure = True
    except Exception:
        typed_failure = False
    result.observe(
        "cad2-auto/adapter-typed-failure",
        "Adapter operations on a missing document raise the typed "
        "InvalidInputError (no silent fallback).",
        typed_failure, epistemic="ADAPTER",
    )
