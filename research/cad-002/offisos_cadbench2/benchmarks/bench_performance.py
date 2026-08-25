"""Benchmark: quantitative performance (RESEARCH-CAD-002 evidence reqs).

Operation time, model size, object count, recompute time and peak memory
on deterministic fixtures, measured inside the FreeCAD process:
- 100-feature parametric document (creation, full recompute,
  incremental recompute after one parameter edit);
- PartDesign chain recompute after a sketch datum edit;
- STEP export/import timing and file size;
- medium assembly (from bench_assemblies) timings already recorded there.
"""
from __future__ import annotations


def run(result) -> None:
    from ..freecad_runner import find_freecadcmd, run_freecad_script

    freecadcmd = find_freecadcmd()
    if freecadcmd is None:
        result.observe(
            "cad2-perf/availability", "FreeCAD not available.", False,
            details={}, epistemic="OBSERVED",
            unknown_reason="FreeCAD not installed (see README)",
        )
        return

    script = """
import os, time, resource
import FreeCAD, Part, Sketcher

doc = FreeCAD.newDocument("benchperf")

# ------------------------------------------------------------------
# 1. 100-feature parametric document: creation + full recompute
# ------------------------------------------------------------------
N = 100
t0 = time.perf_counter()
for i in range(N):
    b = doc.addObject("Part::Box", f"B{i:03d}")
    b.Length = 1.0 + (i % 5) * 0.1
    b.Width = 1.0
    b.Height = 1.0
create_s = time.perf_counter() - t0
t0 = time.perf_counter()
doc.recompute()
full_recompute_s = time.perf_counter() - t0
volumes_ok = all(
    abs(doc.getObject(f"B{i:03d}").Shape.Volume - (1.0 + (i % 5) * 0.1)) <= 1e-9
    for i in range(N)
)
record("cad2-perf/feature-document",
       f"Document with {N} parametric features: creation and full recompute "
       f"complete, every volume exact.",
       volumes_ok,
       details={"features": N, "creation_s": round(create_s, 4),
                "full_recompute_s": round(full_recompute_s, 4),
                "document_objects": len(doc.Objects)})

# ------------------------------------------------------------------
# 2. Incremental recompute after a single parameter edit
# ------------------------------------------------------------------
t0 = time.perf_counter()
doc.getObject("B050").Length = 2.5
touched = [o.Name for o in doc.Objects if "Touched" in o.State]
incremental_s = time.perf_counter() - t0
t0 = time.perf_counter()
recomputed = doc.recompute()
incremental_recompute_s = time.perf_counter() - t0
record("cad2-perf/incremental-recompute",
       "Editing one parameter touches exactly that feature; the "
       "incremental recompute is cheaper than the full recompute.",
       len(touched) == 1 and abs(doc.getObject("B050").Shape.Volume - 2.5) <= 1e-9
       and incremental_recompute_s <= full_recompute_s,
       details={"touched": touched, "recomputed_count": recomputed,
                "incremental_recompute_s": round(incremental_recompute_s, 4),
                "full_recompute_s": round(full_recompute_s, 4)})

# ------------------------------------------------------------------
# 3. PartDesign chain: recompute time after a sketch datum edit
# ------------------------------------------------------------------
body = doc.addObject("PartDesign::Body", "Body")
sk = doc.addObject("Sketcher::SketchObject", "Prof")
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
v_before = pad.Shape.Volume
t0 = time.perf_counter()
didx = [i for i, c in enumerate(sk.Constraints) if c.Type == "DistanceX"][0]
sk.setDatum(didx, 6.0)
doc.recompute()
chain_recompute_s = time.perf_counter() - t0
v_after = pad.Shape.Volume
record("cad2-perf/partdesign-chain-recompute",
       "Sketch datum edit propagates through the PartDesign chain with "
       "the exact expected volume change (24.0 -> 36.0) and a recorded "
       "recompute time.",
       abs(v_before - 24.0) <= 1e-9 and abs(v_after - 36.0) <= 1e-9,
       details={"volume_before": v_before, "volume_after": v_after,
                "chain_recompute_s": round(chain_recompute_s, 4)})

# ------------------------------------------------------------------
# 4. STEP export/import timing and file size
# ------------------------------------------------------------------
t0 = time.perf_counter()
Part.export([doc.getObject(f"B{i:03d}") for i in range(N)], "/tmp/cad2-perf.step")
export_s = time.perf_counter() - t0
step_bytes = os.path.getsize("/tmp/cad2-perf.step")
t0 = time.perf_counter()
imported = Part.read("/tmp/cad2-perf.step")
import_s = time.perf_counter() - t0
record("cad2-perf/step-io",
       f"STEP export/import of {N} solids completes with recorded timings "
       f"and file size; the import returns the exact object count.",
       len(imported.Solids) == N,
       details={"solids": len(imported.Solids),
                "export_s": round(export_s, 4), "import_s": round(import_s, 4),
                "step_bytes": step_bytes,
                "bytes_per_solid": step_bytes // N})

# ------------------------------------------------------------------
# 5. FCStd save timing and size
# ------------------------------------------------------------------
t0 = time.perf_counter()
doc.saveAs("/tmp/cad2-perf.FCStd")
save_s = time.perf_counter() - t0
fcstd_bytes = os.path.getsize("/tmp/cad2-perf.FCStd")
record("cad2-perf/fcstd-save",
       "FCStd save of the full fixture completes with recorded timing and "
       "size.",
       fcstd_bytes > 0,
       details={"save_s": round(save_s, 4), "fcstd_bytes": fcstd_bytes,
                "document_objects": len(doc.Objects)})

# ------------------------------------------------------------------
# 6. Peak memory inside the engine process
# ------------------------------------------------------------------
peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
record("cad2-perf/peak-memory",
       "Peak resident memory of the FreeCAD benchmark process recorded.",
       peak > 0,
       details={"peak_rss_mib": round(peak, 1)})
"""
    checks = run_freecad_script(script, freecadcmd)
    for check in checks:
        result.observe(
            check["id"], check["description"], check["status"] == "pass",
            details=check.get("details") or {}, epistemic=check.get("epistemic", "NATIVE"),
        )
        # surface quantitative measurements
        if check["id"] == "cad2-perf/feature-document":
            d = check.get("details") or {}
            result.measure("perf_100_features_creation_s", d.get("creation_s"))
            result.measure("perf_100_features_full_recompute_s", d.get("full_recompute_s"))
            result.measure("perf_feature_document_objects", d.get("document_objects"))
        elif check["id"] == "cad2-perf/incremental-recompute":
            d = check.get("details") or {}
            result.measure("perf_incremental_recompute_s", d.get("incremental_recompute_s"))
            result.measure("perf_incremental_recomputed_count", d.get("recomputed_count"))
        elif check["id"] == "cad2-perf/partdesign-chain-recompute":
            d = check.get("details") or {}
            result.measure("perf_partdesign_chain_recompute_s", d.get("chain_recompute_s"))
        elif check["id"] == "cad2-perf/step-io":
            d = check.get("details") or {}
            result.measure("perf_step_export_s", d.get("export_s"))
            result.measure("perf_step_import_s", d.get("import_s"))
            result.measure("perf_step_bytes", d.get("step_bytes"))
            result.measure("perf_step_solids", d.get("solids"))
        elif check["id"] == "cad2-perf/fcstd-save":
            d = check.get("details") or {}
            result.measure("perf_fcstd_save_s", d.get("save_s"))
            result.measure("perf_fcstd_bytes", d.get("fcstd_bytes"))
        elif check["id"] == "cad2-perf/peak-memory":
            d = check.get("details") or {}
            result.measure("perf_peak_rss_mib", d.get("peak_rss_mib"))
