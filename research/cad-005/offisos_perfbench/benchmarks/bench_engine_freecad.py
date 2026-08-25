"""Benchmark: FreeCAD engine lifecycle and document operations scaling.

Issue #5 scope 2/3: application start/load; model open/import;
parametric edit/recompute; controlled save/reopen — measured across
three FCStd document scales, inside a PROCESS-ISOLATED engine
(every operation runs in a fresh FreeCADCmd subprocess; the parent
never imports FreeCAD).

Measurement boundary:
- ``cold_start``   ENGINE = FreeCADCmd process startup + FreeCAD import
                   + version probe (measured parent-side as process
                   wall time — the application start/load cost).
- ``build``        ENGINE = document construction + first recompute
                   + saveAs (in-engine timing).
- ``open_edit``    ENGINE = openDocument, selection query, parametric
                   edit + targeted recompute, full recompute, saveAs
                   (in-engine timing).
- ``reopen``       ENGINE = openDocument of the saved artifact +
                   selection query (in-engine timing).
- The ADAPTER/process overhead is the JSON protocol + subprocess
   management measured parent-side (process_wall_ms minus the sum of
   in-engine operation timings).
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from .. import freecad_runner as fr
from ..fixtures import FCSTD_TIERS


def _tier_json(spec) -> str:
    return json.dumps(
        {
            "tier": spec.tier,
            "walls": spec.walls,
            "opening_cuts": spec.opening_cuts,
            "edits": spec.edits,
        }
    )


def run(bench, ctx: dict[str, Any]) -> None:
    cmd = fr.find_freecadcmd()
    if cmd is None:
        bench.observe(
            "freecad/available",
            "FreeCAD engine available for the process-isolated benchmark.",
            condition=False,
            unknown_reason=(
                "FreeCADCmd not found (FREECADCMD env, research/cad-005/"
                ".freecad, research/cad-001/.freecad, PATH all missing)"
            ),
        )
        return

    base_repeats: int = ctx.get("repeats", 5)
    fc_dir: Path = ctx["workdir"] / "freecad"
    fc_dir.mkdir(parents=True, exist_ok=True)

    # --- engine version pinned in evidence --------------------------------
    version = fr.freecad_version(cmd)
    bench.measure("freecad_version", version)

    # --- application start/load: cold process startup, repeated ------------
    cold_samples: list[float] = []
    cold_rss: list[float] = []
    for _ in range(base_repeats):
        r = fr.run_script(fr.cold_start_script(), cmd, timeout=120,
                          script_hint="cold-start")
        cold_samples.append(r["process_wall_ms"])
        cold_rss.append(r["child_resources"].get("peak_rss_mb") or 0)
    cold = {
        "samples_ms": [round(s, 3) for s in cold_samples],
        "median_ms": round(sorted(cold_samples)[len(cold_samples) // 2], 3),
        "min_ms": round(min(cold_samples), 3),
        "max_ms": round(max(cold_samples), 3),
        "peak_rss_mb_max": round(max(cold_rss), 2),
        "boundary": (
            "ENGINE = full FreeCADCmd process startup incl. FreeCAD module "
            "import and version probe; parent-side wall clock"
        ),
    }
    bench.measure("cold_start", cold)
    bench.observe(
        "freecad/cold-start-measured",
        "Application start/load (FreeCADCmd cold process startup) measured "
        f"over {len(cold_samples)} repeats with distribution.",
        condition=len(cold_samples) >= 2 and cold["median_ms"] > 0,
        details={
            "median_ms": cold["median_ms"],
            "min_ms": cold["min_ms"],
            "max_ms": cold["max_ms"],
        },
        epistemic="OBSERVED",
    )

    results: dict[str, dict[str, Any]] = {}
    for tier_name in ("small", "medium", "large"):
        spec = FCSTD_TIERS[tier_name]
        tj = _tier_json(spec)
        doc_path = str(fc_dir / f"doc-{tier_name}.FCStd")
        out_path = str(fc_dir / f"doc-{tier_name}-edited.FCStd")
        repeats = max(2, base_repeats // 2) if tier_name == "large" else base_repeats

        # build once (fixture generation; recorded, not the scored op)
        build_r = fr.run_script(
            fr.BUILD_DOC_SCRIPT.format(tier_json=tj, doc_path=doc_path),
            cmd, timeout=600, script_hint=f"build-{tier_name}",
        )
        build_ok = any(c["status"] == "pass" for c in build_r["checks"])

        open_samples: list[float] = []
        edit_samples: list[float] = []
        recompute_samples: list[float] = []
        save_samples: list[float] = []
        reopen_samples: list[float] = []
        proc_overhead_samples: list[float] = []
        rss_values: list[float] = []
        for _ in range(repeats):
            r = fr.run_script(
                fr.OPEN_RECOMPUTE_SAVE_SCRIPT.format(
                    tier_json=tj, doc_path=doc_path, out_path=out_path,
                ),
                cmd, timeout=600, script_hint=f"open-edit-{tier_name}",
            )
            m = r["measurements"]
            open_samples.append(m["engine_open_document_ms"])
            edit_samples.append(m["engine_parametric_edit_recompute_ms"])
            recompute_samples.append(m["engine_full_recompute_ms"])
            save_samples.append(m["engine_save_as_ms"])
            in_engine = (
                m["engine_open_document_ms"]
                + m["engine_parametric_edit_recompute_ms"]
                + m["engine_full_recompute_ms"]
                + m["engine_save_as_ms"]
                + m["engine_selection_query_ms"]
            )
            proc_overhead_samples.append(r["process_wall_ms"] - in_engine)
            rss_values.append(r["child_resources"].get("peak_rss_mb") or 0)
            rr = fr.run_script(
                fr.REOPEN_SCRIPT.format(tier_json=tj, doc_path=out_path),
                cmd, timeout=600, script_hint=f"reopen-{tier_name}",
            )
            reopen_samples.append(rr["measurements"]["engine_reopen_ms"])
            rss_values.append(rr["child_resources"].get("peak_rss_mb") or 0)

        def _stats(values):
            ordered = sorted(values)
            return {
                "samples_ms": [round(v, 3) for v in values],
                "median_ms": round(ordered[len(ordered) // 2], 3),
                "min_ms": round(min(values), 3),
                "max_ms": round(max(values), 3),
            }

        results[tier_name] = {
            "tier": tier_name,
            "objects": build_r["measurements"].get("object_count"),
            "fcstd_size_bytes": build_r["measurements"].get("doc_size_bytes"),
            "engine_build_document_ms": build_r["measurements"].get(
                "engine_build_document_ms"
            ),
            "open": _stats(open_samples),
            "parametric_edit_recompute": _stats(edit_samples),
            "full_recompute": _stats(recompute_samples),
            "save": _stats(save_samples),
            "reopen": _stats(reopen_samples),
            "adapter_process_overhead": _stats(proc_overhead_samples),
            "peak_child_rss_mb": {
                "max": round(max(rss_values), 2),
                "values": [round(v, 2) for v in rss_values],
            },
            "boundary": (
                "ENGINE timings measured inside the FreeCADCmd process "
                "(perf_counter around each engine call); the ADAPTER/"
                "process overhead is subprocess + JSON protocol cost "
                "measured parent-side (process wall minus in-engine sum)"
            ),
        }

    bench.measure("freecad_document_ops", results)

    for tier_name, res in results.items():
        bench.observe(
            f"freecad/{tier_name}/document-ops-measured",
            f"FreeCAD document operations measured at {tier_name} tier "
            f"({res['objects']} objects, {res['fcstd_size_bytes']} byte "
            "FCStd): open, selection query, parametric edit/recompute, "
            "full recompute, save, controlled reopen — with distributions "
            "and child peak RSS.",
            condition=res["open"]["median_ms"] > 0
            and res["reopen"]["median_ms"] > 0
            and res["peak_child_rss_mb"]["max"] > 0,
            details={
                "open_ms_median": res["open"]["median_ms"],
                "parametric_edit_recompute_ms_median": res["parametric_edit_recompute"]["median_ms"],
                "full_recompute_ms_median": res["full_recompute"]["median_ms"],
                "save_ms_median": res["save"]["median_ms"],
                "reopen_ms_median": res["reopen"]["median_ms"],
                "peak_child_rss_mb": res["peak_child_rss_mb"]["max"],
            },
            epistemic="OBSERVED",
        )

    # process overhead (adapter side) recorded per tier
    bench.observe(
        "freecad/adapter-process-overhead-recorded",
        "Adapter/process overhead (subprocess + JSON protocol, parent-side) "
        "separated from in-engine operation time at every tier — the "
        "engine-vs-Offisos-translation separation for the FreeCAD path.",
        condition=all(
            results[t]["adapter_process_overhead"]["median_ms"] >= 0
            for t in results
        ),
        details={
            t: {
                "adapter_overhead_ms_median": results[t]["adapter_process_overhead"]["median_ms"],
                "open_engine_ms_median": results[t]["open"]["median_ms"],
            }
            for t in results
        },
        epistemic="OBSERVED",
    )
