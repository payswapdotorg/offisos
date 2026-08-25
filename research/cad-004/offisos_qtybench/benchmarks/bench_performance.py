"""Benchmark: runtime and fixture characteristics (RESEARCH-CAD-004)."""
from __future__ import annotations


def run(result) -> None:
    import time

    from ..fixtures import build_model
    from ..graph import build_quantity_graph
    from ..quantity_records import extract_snapshot
    from ..downstream import derive_estimate, group_rfq_scopes

    timings: dict[str, float] = {}

    t0 = time.perf_counter()
    f1 = build_model("v1")
    timings["model_build_v1_s"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    snap1 = extract_snapshot(f1, "v1")
    timings["extraction_v1_s"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    graph1 = build_quantity_graph(snap1)
    timings["graph_mapping_s"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    est1 = derive_estimate(snap1)
    scopes1 = group_rfq_scopes(est1)
    timings["downstream_derivation_s"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    for v in ("v2", "v3"):
        extract_snapshot(build_model(v), v)
    timings["build_extract_v2_v3_s"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    f_mm = build_model("v1", unit="MILLIMETRE")
    snap_mm = extract_snapshot(f_mm, "v1")
    timings["mixed_unit_extract_s"] = time.perf_counter() - t0

    result.observe(
        "cad4-perf/pipeline-timings",
        "Full pipeline timings recorded: model build, quantity "
        "extraction (OBSERVED + BRep), graph mapping, downstream "
        "derivation, version chain, mixed-unit extraction.",
        len(snap1.records) > 0 and len(graph1["nodes"]) > 0
        and len(est1) > 0,
        details={k: round(v, 4) for k, v in timings.items()},
        epistemic="OBSERVED",
    )
    for k, v in timings.items():
        result.measure(k, round(v, 4))

    import tempfile, os

    with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as tmp:
        path = tmp.name
    f1.write(path)
    result.measure("ifc_bytes_v1", os.path.getsize(path))
    os.unlink(path)
    result.measure("quantity_records_v1", len(snap1.records))
    result.measure("graph_nodes_v1", len(graph1["nodes"]))
    result.measure("estimate_line_items_v1", len(est1))
    result.measure("rfq_scopes_v1", len(scopes1))
    result.measure("quantity_records_v1_mm", len(snap_mm.records))

    import resource

    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
    result.observe(
        "cad4-perf/peak-memory",
        "Peak resident memory of the benchmark process recorded.",
        peak > 0,
        details={"peak_rss_mib": round(peak, 1)}, epistemic="OBSERVED",
    )
    result.measure("peak_rss_mib", round(peak, 1))
