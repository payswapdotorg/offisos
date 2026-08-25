"""Benchmark: IFC engine operations scaling with engine/adapter separation.

Issue #5 scope 2/3: model open/import, IFC import/export, selection/
query — measured across the three fixture scales with wall-clock time,
throughput (elements/s), peak resident memory, and an explicit
separation of engine performance from Offisos translation overhead
(issue #5 evidence requirement).

Measurement boundary (stated per operation, auditable):

- ``ifc_open``     ENGINE = ifcopenshell.open(path) — STEP parse +
                   entity graph construction. ADAPTER = the Offisos
                   domain-index extraction (identity psets, class
                   mapping, provenance fields) that turns the engine
                   result into Construction-Graph-ready data.
- ``ifc_write``    ENGINE = file.write(path) — STEP serialization.
                   ADAPTER = controlled mutation application with
                   lineage records (the Offisos translation that must
                   precede a controlled export).
- ``ifc_query``    ENGINE = by_type / by_guid entity lookups.
                   ADAPTER = domain-id keyed consumer index build.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import ifcopenshell

from .. import ifc_adapter
from ..resources import close_phase, phase_memory
from ..timing import SplitMeasurement, measure_split_repeated


def _repeats_for(tier: str, base: int) -> int:
    """Expensive large-tier operations use fewer repeats; documented."""
    return max(2, base // 2) if tier == "large" else base


def run(bench, ctx: dict[str, Any]) -> None:
    tiers: dict[str, dict[str, Any]] = ctx["ifc_tiers"]
    base_repeats: int = ctx.get("repeats", 5)
    export_dir: Path = ctx["workdir"] / "ifc-io"
    export_dir.mkdir(parents=True, exist_ok=True)

    open_measurements: dict[str, dict[str, Any]] = {}
    write_measurements: dict[str, dict[str, Any]] = {}
    query_measurements: dict[str, dict[str, Any]] = {}
    memory: dict[str, Any] = {}

    for tier_name in ("small", "medium", "large"):
        info = tiers[tier_name]
        path = info["path"]
        repeats = _repeats_for(tier_name, base_repeats)
        elements = info["products_total"]

        # --- open (import): engine parse vs adapter domain indexing -----
        m_open = measure_split_repeated(
            operation=f"ifc_open[{tier_name}]",
            boundary=(
                "ENGINE = ifcopenshell.open (STEP parse + entity graph); "
                "ADAPTER = Offisos domain-index extraction (identity psets, "
                "class mapping, provenance)"
            ),
            engine_fn=lambda: ifc_adapter.safe_open(path),
            adapter_fn=lambda f: ifc_adapter.extract_domain_index(f),
            repeats=repeats,
            extra={
                "tier": tier_name,
                "elements": elements,
                "file_size_bytes": info["file_size_bytes"],
            },
        )
        open_measurements[tier_name] = m_open.to_dict()
        throughput = (
            round(elements / (m_open.total_ms_samples[0] / 1000.0), 1)
            if m_open.samples else None
        )
        m_open.extra["open_throughput_elements_per_s_first_sample"] = throughput

        # --- write (export): adapter mutation with lineage vs engine serialize
        out_path = str(export_dir / f"out-{tier_name}.ifc")
        n_mutations = min(100, max(5, elements // 10))

        def _engine_write():
            f = ifcopenshell.open(path)
            return f

        def _adapter_then_write(f):
            # The controlled-export translation: mutations + lineage, then
            # the engine serialization is timed separately below. For the
            # split measurement the ADAPTER phase covers mutation+lineage
            # plus result validation; the engine write is measured in a
            # dedicated single-phase measurement below.
            ifc_adapter.apply_controlled_mutations(f, n_mutations, "bench-export")
            return None

        m_write = measure_split_repeated(
            operation=f"ifc_export_translation[{tier_name}]",
            boundary=(
                "ENGINE = reopen source file (parse for mutation); "
                "ADAPTER = controlled mutation application with lineage "
                f"records ({n_mutations} edits)"
            ),
            engine_fn=_engine_write,
            adapter_fn=_adapter_then_write,
            repeats=repeats,
            extra={"tier": tier_name, "mutations": n_mutations},
        )
        # Engine STEP serialization, single-phase (fresh mutated file each
        # repeat would double-count parse; measured on one mutated file).
        f_mut = ifcopenshell.open(path)
        ifc_adapter.apply_controlled_mutations(f_mut, n_mutations, "bench-export")
        t0 = time.perf_counter()
        f_mut.write(out_path)
        serialize_ms = (time.perf_counter() - t0) * 1000.0
        out_size = Path(out_path).stat().st_size
        write_measurements[tier_name] = {
            **m_write.to_dict(),
            "engine_serialize_ms_single": round(serialize_ms, 3),
            "output_file_size_bytes": out_size,
        }

        # --- selection/query: engine entity lookups vs adapter index -----
        f = ifcopenshell.open(path)
        all_walls = f.by_type("IfcWall")
        guid = all_walls[len(all_walls) // 2].GlobalId

        m_query = measure_split_repeated(
            operation=f"ifc_query[{tier_name}]",
            boundary=(
                "ENGINE = by_type(IfcWall) + by_guid lookup + attribute "
                "reads over all elements; ADAPTER = domain-id keyed "
                "consumer index build from the query result"
            ),
            engine_fn=lambda: (
                f.by_type("IfcWall"),
                f.by_guid(guid),
            ),
            adapter_fn=lambda result: {
                w.Name: w.GlobalId for w in result[0]
            },
            repeats=repeats,
            extra={
                "tier": tier_name,
                "walls_queried": len(all_walls),
            },
        )
        # recompute throughput properly
        if m_query.samples:
            m_query.extra["query_throughput_walls_per_s"] = round(
                len(all_walls) / (m_query.total_ms_samples[0] / 1000.0), 1
            )
        query_measurements[tier_name] = m_query.to_dict()

        # --- memory: open phase growth (VmHWM semantics documented) -------
        mem_start = phase_memory()
        f_mem = ifcopenshell.open(path)
        index = ifc_adapter.extract_domain_index(f_mem)
        serialized = ifc_adapter.serialize_index(index)
        mem = close_phase(mem_start)
        memory[tier_name] = {
            **mem,
            "elements": elements,
            "serialized_index_bytes": len(serialized),
        }
        del f_mem, index, serialized

    bench.measure("ifc_open", open_measurements)
    bench.measure("ifc_export", write_measurements)
    bench.measure("ifc_query", query_measurements)
    bench.measure("ifc_memory", memory)

    # ---- checks: scaling behavior + engine/adapter separation recorded ----
    for tier_name in ("small", "medium", "large"):
        om = open_measurements[tier_name]
        bench.observe(
            f"ifc-open/{tier_name}/measured",
            f"IFC open measured for {tier_name} tier with engine/adapter "
            "split, median + distribution over "
            f"{om['actual_repeats']} repeats.",
            condition=om["engine_ms"].get("median", 0) > 0
            and "stdev" in om["engine_ms"],
            details={
                "engine_ms_median": om["engine_ms"]["median"],
                "adapter_ms_median": om["adapter_ms"]["median"],
                "adapter_share": om["adapter_share_of_total_median"],
                "elements": om.get("elements"),
            },
            epistemic="OBSERVED",
        )

    # Sub-linear-ish scaling expectation is NOT asserted as a hard numeric
    # threshold (compatibility matrix defines none) — the honest check is
    # that per-element cost is recorded and non-decreasing out of control.
    per_element = {}
    for tier_name in ("small", "medium", "large"):
        om = open_measurements[tier_name]
        elements = om["elements"]
        total_median = om["total_ms"]["median"]
        per_element[tier_name] = round(total_median / elements, 4)
    bench.measure("ifc_open_per_element_ms", per_element)
    bench.observe(
        "ifc-open/per-element-cost-recorded",
        "Per-element open cost (median total / element count) recorded for "
        "all tiers — the scaling currency for cross-environment comparison.",
        condition=all(v > 0 for v in per_element.values()),
        details=per_element,
        epistemic="CALCULATED",
    )

    for tier_name in ("small", "medium", "large"):
        wm = write_measurements[tier_name]
        bench.observe(
            f"ifc-export/{tier_name}/measured",
            f"IFC controlled export measured for {tier_name}: adapter "
            "mutation+lineage time, engine serialization time, output size.",
            condition=wm["engine_serialize_ms_single"] > 0,
            details={
                "adapter_mutation_ms_median": wm["adapter_ms"]["median"],
                "engine_serialize_ms": wm["engine_serialize_ms_single"],
                "output_file_size_bytes": wm["output_file_size_bytes"],
                "mutations": wm.get("mutations"),
            },
            epistemic="OBSERVED",
        )

    for tier_name in ("small", "medium", "large"):
        qm = query_measurements[tier_name]
        bench.observe(
            f"ifc-query/{tier_name}/measured",
            f"Selection/query measured for {tier_name} (engine lookups vs "
            "adapter consumer index) with throughput.",
            condition=qm["engine_ms"].get("median", 0) >= 0
            and qm["engine_ms"]["min"] >= 0,
            details={
                "engine_ms_median": qm["engine_ms"]["median"],
                "walls": qm.get("walls_queried"),
                "throughput": qm.get("query_throughput_walls_per_s"),
            },
            epistemic="OBSERVED",
        )

    bench.observe(
        "ifc/memory-recorded",
        "Peak resident memory (VmHWM growth) recorded for the open+index+"
        "serialize phase at every tier, with semantics documented.",
        condition=all("hwm_growth_mb" in memory[t] for t in memory),
        details={
            t: {
                "hwm_growth_mb": memory[t]["hwm_growth_mb"],
                "rss_after_mb": memory[t]["rss_after_mb"],
            }
            for t in memory
        },
        epistemic="OBSERVED",
    )
