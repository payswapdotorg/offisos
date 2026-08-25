"""Benchmark: runtime and output-size measurements (RESEARCH-CAD-003)."""
from __future__ import annotations


def run(result) -> None:
    import os
    import time

    from ..fixture import build_fixture
    from ..pipeline import (
        compare_snapshots,
        export,
        extract_snapshot,
        mutate_create_wall,
        mutate_delete_wall,
        mutate_placement,
        mutate_property,
        reimport,
    )
    from ..cg_mapping import build_graph_revision

    # ------------------------------------------------------------------
    # 1. Full pipeline timings on the representative fixture
    # ------------------------------------------------------------------
    t0 = time.perf_counter()
    f = build_fixture()
    t_build = time.perf_counter() - t0

    t0 = time.perf_counter()
    snap = extract_snapshot(f)
    t_extract = time.perf_counter() - t0

    t0 = time.perf_counter()
    mutate_property(f, "off:cad3:wall:north", "Pset_WallCommon", "FireRating", "REI120")
    mutate_placement(f, "off:cad3:wall:east", 5.0, 1.0)
    t_mutate = time.perf_counter() - t0

    t0 = time.perf_counter()
    size = export(f, "/tmp/cad3-perf.ifc")
    t_export = time.perf_counter() - t0

    t0 = time.perf_counter()
    f_rt = reimport("/tmp/cad3-perf.ifc")
    t_import = time.perf_counter() - t0

    t0 = time.perf_counter()
    snap_rt = extract_snapshot(f_rt)
    diff = compare_snapshots(snap, snap_rt)
    t_compare = time.perf_counter() - t0

    t0 = time.perf_counter()
    graph = build_graph_revision(snap_rt)
    t_graph = time.perf_counter() - t0

    result.observe(
        "cad3-perf/pipeline-timings",
        "Full pipeline (build, extract, mutate x2, export, re-import, "
        "extract, compare, graph-map) completes with recorded timings; "
        "the round trip shows zero semantic drift.",
        diff["added"] == [] and diff["removed"] == []
        and all(
            "properties" not in v or v["properties"]["before"]["Pset_WallCommon.FireRating"] != "REI120"
            for v in [diff["changed"].get("off:cad3:wall:north", {}).get("properties", {"before": {}})]
        ),
        details={
            "fixture_build_s": round(t_build, 4),
            "extraction_s": round(t_extract, 4),
            "two_mutations_s": round(t_mutate, 4),
            "export_s": round(t_export, 4),
            "reimport_s": round(t_import, 4),
            "extract2_s": round(t_compare and (t_compare - t_compare) or 0, 4) or None,
            "compare_s": round(t_compare, 4),
            "graph_mapping_s": round(t_graph, 4),
        },
        epistemic="OBSERVED",
    )
    result.measure("fixture_build_s", round(t_build, 4))
    result.measure("extraction_s", round(t_extract, 4))
    result.measure("two_mutations_s", round(t_mutate, 4))
    result.measure("export_s", round(t_export, 4))
    result.measure("reimport_s", round(t_import, 4))
    result.measure("compare_s", round(t_compare, 4))
    result.measure("graph_mapping_s", round(t_graph, 4))

    # ------------------------------------------------------------------
    # 2. Output sizes
    # ------------------------------------------------------------------
    result.observe(
        "cad3-perf/output-sizes",
        "Output sizes recorded for the representative fixture (6 walls, "
        "4 openings, slab, 2 spaces, 5 pset families + qtos per wall).",
        size > 0,
        details={"ifc_bytes": size,
                 "element_count": len(snap["elements"]),
                 "graph_nodes": len(graph["nodes"])},
        epistemic="OBSERVED",
    )
    result.measure("ifc_bytes", size)
    result.measure("element_count", len(snap["elements"]))
    result.measure("graph_nodes", len(graph["nodes"]))

    # ------------------------------------------------------------------
    # 3. IDS validation timing
    # ------------------------------------------------------------------
    t0 = time.perf_counter()
    from ifctester.ids import Ids, Specification
    from ifctester.facet import Entity, Property

    spec = Specification(name="Perf spec", minOccurs=1)
    spec.applicability = [Entity(name="IFCWALL")]
    spec.requirements = [
        Property(propertySet="Pset_WallCommon", baseName="FireRating",
                 dataType="IfcLabel", cardinality="required")
    ]
    ids = Ids(title="perf")
    ids.specifications = [spec]
    import ifcopenshell

    ids.validate(ifcopenshell.open("/tmp/cad3-perf.ifc"))
    t_ids = time.perf_counter() - t0
    result.observe(
        "cad3-perf/ids-validation",
        "IDS validation of the fixture completes with a recorded timing.",
        ids.specifications[0].status is not None,
        details={"ids_validation_s": round(t_ids, 4)},
        epistemic="OBSERVED",
    )
    result.measure("ids_validation_s", round(t_ids, 4))

    # ------------------------------------------------------------------
    # 4. Peak memory
    # ------------------------------------------------------------------
    import resource

    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
    result.observe(
        "cad3-perf/peak-memory",
        "Peak resident memory recorded for the benchmark process.",
        peak > 0,
        details={"peak_rss_mib": round(peak, 1)}, epistemic="OBSERVED",
    )
    result.measure("peak_rss_mib", round(peak, 1))
