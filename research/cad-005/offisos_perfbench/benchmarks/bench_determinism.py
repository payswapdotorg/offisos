"""Benchmark: repeated-run variance and determinism.

Issue #5 scope 4: "repeated identical runs ... deterministic versus
nondeterministic results" and the evidence requirement "medians and
distributions for repeated operations where meaningful, not only
best-case samples."

Two distinct questions, kept separate:

1. TIMING variance — coefficient of variation (stdev/mean) over N=10
   repeated runs of representative operations at the medium tier. Timings
   are never asserted to be constant; their distribution is the datum.
2. RESULT determinism — the *outputs* of deterministic operations
   (extraction snapshot bytes, OCCT volumes, quantity records) must be
   byte/value identical across repeats; nondeterministic outputs (IFC
   GlobalIds across regeneration) are shown to differ and explicitly
   classified as engine nondeterminism.
"""
from __future__ import annotations

import statistics
import tempfile
from pathlib import Path
from typing import Any

import ifcopenshell

from .. import ifc_adapter, occt_engine as oe
from ..timing import coefficient_of_variation


def run(bench, ctx: dict[str, Any]) -> None:
    tiers: dict[str, dict[str, Any]] = ctx["ifc_tiers"]
    n = int(ctx.get("determinism_repeats", 10))

    path = tiers["medium"]["path"]
    elements = tiers["medium"]["products_total"]

    # ---- 1. timing variance over N repeated runs --------------------------
    open_ms: list[float] = []
    extract_ms: list[float] = []
    bool_ms: list[float] = []
    f = ifcopenshell.open(path)
    shapes = oe.build_tier_primitives(60)

    import time

    for _ in range(n):
        t0 = time.perf_counter()
        f2 = ifcopenshell.open(path)
        open_ms.append((time.perf_counter() - t0) * 1000.0)
        t0 = time.perf_counter()
        ifc_adapter.extract_domain_index(f2)
        extract_ms.append((time.perf_counter() - t0) * 1000.0)
        del f2
        t0 = time.perf_counter()
        oe.cut_chain(shapes)
        bool_ms.append((time.perf_counter() - t0) * 1000.0)

    cv = {
        "ifc_open": coefficient_of_variation(open_ms),
        "semantic_extraction": coefficient_of_variation(extract_ms),
        "boolean_chain": coefficient_of_variation(bool_ms),
    }
    timing = {
        "repeats": n,
        "ifc_open": {
            "median_ms": round(statistics.median(open_ms), 3),
            "mean_ms": round(statistics.fmean(open_ms), 3),
            "stdev_ms": round(statistics.stdev(open_ms), 3),
            "cv": cv["ifc_open"],
            "samples_ms": [round(v, 3) for v in open_ms],
        },
        "semantic_extraction": {
            "median_ms": round(statistics.median(extract_ms), 3),
            "mean_ms": round(statistics.fmean(extract_ms), 3),
            "stdev_ms": round(statistics.stdev(extract_ms), 3),
            "cv": cv["semantic_extraction"],
            "samples_ms": [round(v, 3) for v in extract_ms],
        },
        "boolean_chain": {
            "median_ms": round(statistics.median(bool_ms), 3),
            "mean_ms": round(statistics.fmean(bool_ms), 3),
            "stdev_ms": round(statistics.stdev(bool_ms), 3),
            "cv": cv["boolean_chain"],
            "samples_ms": [round(v, 3) for v in bool_ms],
        },
    }
    bench.measure("timing_variance", timing)
    bench.observe(
        "determinism/timing-variance-measured",
        f"Repeated-run timing variance measured over {n} identical runs "
        "for three representative operations (medians, stdevs, "
        "coefficients of variation and full sample lists recorded).",
        condition=all(v is not None for v in cv.values()),
        details={"cv": cv},
        epistemic="OBSERVED",
    )

    # Timings vary; that is expected and recorded — not a failure. The
    # honest check is that the CV is finite and the samples were all
    # positive real measurements.
    bench.observe(
        "determinism/timings-are-distributed-not-constant",
        "Timing samples form a distribution (CV > 0) — recorded as the "
        "datum rather than hidden behind a single best-case number.",
        condition=all(v > 0 for v in cv.values() if v is not None),
        details={"cv": cv},
        epistemic="OBSERVED",
    )

    # ---- 2. result determinism -------------------------------------------
    # 2a. extraction outputs byte-identical across repeats
    snapshots: list[bytes] = []
    for _ in range(3):
        fx = ifcopenshell.open(path)
        idx = ifc_adapter.extract_domain_index(fx)
        snapshots.append(ifc_adapter.serialize_index(idx))
        del fx
    identical = all(s == snapshots[0] for s in snapshots)
    bench.observe(
        "determinism/extraction-result-byte-identical",
        "Semantic extraction output is byte-identical across repeated "
        "runs of the same fixture (deterministic operation).",
        condition=identical,
        details={
            "runs": len(snapshots),
            "identical": identical,
            "size_bytes": len(snapshots[0]),
        },
        epistemic="OBSERVED",
    )

    # 2b. OCCT volumes identical across repeats
    vols: list[float] = []
    for _ in range(3):
        plate, holes = oe.plate_with_holes(64)
        vols.append(round(oe.volume(plate), 9))
    bench.observe(
        "determinism/occt-volume-identical",
        "OCCT boolean result volume is identical across repeated runs of "
        "the same construction (deterministic geometry kernel).",
        condition=len(set(vols)) == 1,
        details={"volumes": vols, "holes": holes},
        epistemic="OBSERVED",
    )

    # 2c. quantity records value-identical across repeats
    rec_sets: list[list[float]] = []
    for _ in range(3):
        fx = ifcopenshell.open(path)
        recs = ifc_adapter.extract_quantity_records(fx, "det-test")
        rec_sets.append(sorted(r.value for r in recs))
        del fx
    qty_identical = all(rs == rec_sets[0] for rs in rec_sets)
    bench.observe(
        "determinism/quantity-records-identical",
        "Quantity record values are identical across repeated extractions "
        "(deterministic operation).",
        condition=qty_identical,
        details={
            "runs": len(rec_sets),
            "records": len(rec_sets[0]),
            "identical": qty_identical,
        },
        epistemic="OBSERVED",
    )

    # 2d. engine nondeterminism made explicit: GlobalIds across regeneration
    from ..fixtures import IFC_TIERS, write_ifc_tier

    with tempfile.TemporaryDirectory() as tmp:
        p1 = write_ifc_tier(IFC_TIERS["small"], Path(tmp) / "a.ifc")
        p2 = write_ifc_tier(IFC_TIERS["small"], Path(tmp) / "b.ifc")
        guids1 = {w.GlobalId for w in ifcopenshell.open(p1["path"]).by_type("IfcWall")}
        guids2 = {w.GlobalId for w in ifcopenshell.open(p2["path"]).by_type("IfcWall")}
        guids_disjoint = guids1.isdisjoint(guids2)
        bench.observe(
            "determinism/globalids-nondeterministic-across-regeneration",
            "IFC GlobalIds are regenerated per build (disjoint across two "
            "regenerations of the identical fixture definition) — engine "
            "nondeterminism restated as an explicit datum; Offisos domain "
            "ids are the canonical identity (Architecture v1.1 GRAPH "
            "invariant, LOCK on engine-id non-canonicity).",
            condition=guids_disjoint,
            details={
                "guids_run1": len(guids1),
                "guids_run2": len(guids2),
                "disjoint": guids_disjoint,
            },
            epistemic="OBSERVED",
        )
