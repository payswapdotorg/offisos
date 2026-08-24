"""Benchmark: performance and scalability (RESEARCH-CAD-001 item 7).

Measures creation/IO/extraction timings and peak memory on:

- FIX-BIM-SMALL (4 walls, 3 openings, slab, space);
- FIX-MEDIUM (5 stories x 20 walls = 100 walls, 50 openings, spaces);
- OCCT boolean throughput and a 1000-solid compound.

Timings are wall-clock medians over repeated runs; peak RSS via
getrusage. All fixtures are deterministic.
"""
from __future__ import annotations

import time


def run(result) -> None:
    from ..engines.ifc_adapter import IfcOpenShellAdapter
    from ..fixtures import medium_walls
    from .bench_bim_semantics import build_small_model

    adapter = IfcOpenShellAdapter()

    def timed(fn, repeats=3):
        times = []
        out = None
        for _ in range(repeats):
            t0 = time.perf_counter()
            out = fn()
            times.append(time.perf_counter() - t0)
        times.sort()
        return out, times[len(times) // 2], times[0], times[-1]

    # ------------------------------------------------------------------
    # 1. Small model lifecycle timings
    # ------------------------------------------------------------------
    _, med, mn, mx = timed(lambda: build_small_model(adapter, "perf-small"))
    result.measure("small_model_creation_s_median", round(med, 4))
    small_model = build_small_model(adapter, "perf-small")

    _, med_w, mn_w, mx_w = timed(
        lambda: adapter.export_ifc(small_model, "/tmp/perf-small.ifc")
    )
    result.measure("small_ifc_write_s_median", round(med_w, 4))
    import os

    result.measure("small_ifc_bytes", os.path.getsize("/tmp/perf-small.ifc"))
    _, med_r, _, _ = timed(lambda: adapter.import_ifc("/tmp/perf-small.ifc", "p"))
    result.measure("small_ifc_parse_s_median", round(med_r, 4))

    result.observe(
        "perf/small/lifecycle-completes",
        "Small model lifecycle (create, write, parse) completes without error.",
        True,
        details={
            "creation_s": round(med, 4),
            "write_s": round(med_w, 4),
            "parse_s": round(med_r, 4),
            "ifc_bytes": os.path.getsize("/tmp/perf-small.ifc"),
        },
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 2. Medium model lifecycle timings
    # ------------------------------------------------------------------
    walls = medium_walls()

    def build_medium():
        m = adapter.create_model("perf-medium")
        for i, wall in enumerate(walls):
            adapter.add_wall(
                m, f"el:wall-{i:03d}", wall.id,
                wall.x0, wall.y0, wall.x1, wall.y1,
                wall.height, wall.thickness,
                openings=[
                    {"kind": o.kind, "x": o.x, "width": o.width,
                     "height": o.height, "sill": o.sill}
                    for o in wall.openings
                ],
            )
        for s in range(5):
            adapter.add_space(m, f"el:space-{s:02d}", f"Space {s}", 9.0, 9.0)
        return m

    medium_model, med_m, mn_m, mx_m = timed(build_medium, repeats=1)
    result.measure("medium_model_creation_s", round(med_m, 4))
    result.measure("medium_wall_count", len(walls))
    result.measure("medium_opening_count", sum(len(w.openings) for w in walls))

    t0 = time.perf_counter()
    adapter.export_ifc(medium_model, "/tmp/perf-medium.ifc")
    med_w2 = time.perf_counter() - t0
    result.measure("medium_ifc_write_s", round(med_w2, 4))
    result.measure("medium_ifc_bytes", os.path.getsize("/tmp/perf-medium.ifc"))

    t0 = time.perf_counter()
    medium_rt = adapter.import_ifc("/tmp/perf-medium.ifc", "pm")
    med_r2 = time.perf_counter() - t0
    result.measure("medium_ifc_parse_s", round(med_r2, 4))

    t0 = time.perf_counter()
    wall_count_rt = sum(1 for e in medium_rt.elements if e.kind == "wall")
    med_q = time.perf_counter() - t0
    result.measure("medium_quantity_scan_s", round(med_q, 4))

    result.observe(
        "perf/medium/lifecycle-completes",
        "Medium model (100 walls, 50 openings, 5 spaces) lifecycle completes; "
        "round-trip preserves the wall count.",
        wall_count_rt == len(walls),
        details={
            "creation_s": round(med_m, 4),
            "write_s": round(med_w2, 4),
            "parse_s": round(med_r2, 4),
            "walls_roundtripped": wall_count_rt,
        },
        epistemic="OBSERVED",
    )

    # quantity extraction timing from stored quantity sets
    t0 = time.perf_counter()
    net_sum = sum(
        e.domain_quantities["NetVolume"].value
        for e in medium_rt.elements
        if e.kind == "wall" and "NetVolume" in e.domain_quantities
    )
    med_qx = time.perf_counter() - t0
    result.measure("medium_quantity_extraction_s", round(med_qx, 4))
    result.measure("medium_wall_net_volume_sum", round(net_sum, 4))

    # ------------------------------------------------------------------
    # 3. OCCT boolean throughput (100 cut operations)
    # ------------------------------------------------------------------
    from OCP.gp import gp_Pnt
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
    from OCP.GProp import GProp_GProps
    from OCP.BRepGProp import BRepGProp

    def boolean_benchmark(n):
        t0 = time.perf_counter()
        for i in range(n):
            gross = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 6.0, 0.3, 3.0).Shape()
            void = BRepPrimAPI_MakeBox(gp_Pnt(1.0, -0.15, 0), 1.0, 0.3, 2.1).Shape()
            cut = BRepAlgoAPI_Cut(gross, void)
            cut.Build()
        return time.perf_counter() - t0

    elapsed = boolean_benchmark(100)
    result.measure("occt_100_boolean_cuts_s", round(elapsed, 4))
    result.observe(
        "perf/occt/boolean-throughput",
        "100 box-cut boolean operations complete; per-op time recorded.",
        elapsed > 0,
        details={"total_s": round(elapsed, 4), "per_op_ms": round(elapsed * 10, 3)},
        epistemic="OBSERVED",
    )

    # 1000-solid compound build + volume
    from OCP.TopoDS import TopoDS_Compound
    from OCP.BRep import BRep_Builder

    t0 = time.perf_counter()
    builder = BRep_Builder()
    compound = TopoDS_Compound()
    builder.MakeCompound(compound)
    for i in range(1000):
        builder.Add(
            compound,
            BRepPrimAPI_MakeBox(gp_Pnt(i * 1e-3, 0, 0), 0.1, 0.2, 0.3).Shape(),
        )
    build_s = time.perf_counter() - t0
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(compound, props, True)
    vol_s = time.perf_counter() - t0 - build_s
    result.measure("occt_1000_compound_build_s", round(build_s, 4))
    result.measure("occt_1000_compound_volume_s", round(vol_s, 4))
    result.assert_close(
        "perf/occt/compound-volume-exact",
        "1000-solid compound volume is exact after timing runs (6.0 m^3).",
        props.Mass(), 6.0, 1e-6, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 4. Peak memory
    # ------------------------------------------------------------------
    import resource

    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
    result.measure("peak_rss_mib", round(peak, 1))
    result.observe(
        "perf/memory/peak-recorded",
        "Peak resident memory recorded for the full benchmark process.",
        peak > 0,
        details={"peak_rss_mib": round(peak, 1)},
        epistemic="OBSERVED",
    )
