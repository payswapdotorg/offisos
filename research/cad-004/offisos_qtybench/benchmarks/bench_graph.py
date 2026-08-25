"""Benchmark: Construction Graph mapping (RESEARCH-CAD-004 scope 4).

Domain-id keyed graph mapping with provenance and uncertainty surviving;
engine-id non-canonicality in the quantity context; the consumer API
(no engine access); graph diff across revisions.
"""
from __future__ import annotations


def run(result) -> None:
    from ..fixtures import build_model
    from ..graph import (
        build_quantity_graph,
        diff_graphs,
        engine_id_independence_check,
        graph_get_quantity,
        graph_quantity_ids,
        graph_uncertainty_summary,
    )
    from ..quantity_records import extract_snapshot

    snaps = {v: extract_snapshot(build_model(v), v) for v in ("v1", "v2", "v3")}
    graphs = {v: build_quantity_graph(snaps[v]) for v in snaps}

    # ------------------------------------------------------------------
    # 1. Graph keyed by canonical domain ids (not engine ids)
    # ------------------------------------------------------------------
    node_ids = graph_quantity_ids(graphs["v1"])
    result.observe(
        "cad4-graph/domain-id-keyed",
        "Graph nodes are keyed by canonical domain ids only — no engine "
        "GlobalId appears as a node key (10 nodes: 4 walls + ghost + "
        "slab + space + door + 2 windows).",
        len(node_ids) == 10 and all(n.startswith("off:cad4:") for n in node_ids),
        details={"node_count": len(node_ids),
                 "sample": sorted(node_ids)[:4]},
        epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 2. Provenance refs + uncertainty survive the mapping
    # ------------------------------------------------------------------
    ghost = graphs["v1"]["nodes"]["off:cad4:wall:ghost"]
    north = graphs["v1"]["nodes"]["off:cad4:wall:north"]
    result.observe(
        "cad4-graph/provenance-and-uncertainty-survive",
        "Provenance references survive the mapping (every quantity "
        "carries its record id for full provenance lookup) and the "
        "uncertainty state is visible in the graph (ghost wall's "
        "NetVolume is UNKNOWN with value None; BRep quantities are "
        "CALCULATED with parameters addressable via the record id).",
        ghost["quantities"]["NetVolume"]["state"] == "UNKNOWN"
        and ghost["quantities"]["NetVolume"]["value"] is None
        and north["provenance_refs"]["BRepNetVolume"]
        == "off:cad4:wall:north#BRepNetVolume@v1",
        details={"ghost_state": ghost["quantities"]["NetVolume"],
                 "north_provenance_refs": north["provenance_refs"]},
        epistemic="ADAPTER",
    )
    summary = graph_uncertainty_summary(graphs["v1"])
    result.observe(
        "cad4-graph/uncertainty-summary",
        "The graph exposes an uncertainty summary: OBSERVED, CALCULATED "
        "and UNKNOWN quantities all counted (epistemic honesty at the "
        "Graph boundary).",
        summary["OBSERVED"] > 0 and summary["CALCULATED"] > 0
        and summary["UNKNOWN"] > 0,
        details={"summary": summary}, epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 3. Engine-id non-canonicality (quantity context)
    # ------------------------------------------------------------------
    snap_regen = extract_snapshot(build_model("v1"), "v1")
    check = engine_id_independence_check(snaps["v1"], snap_regen)
    result.observe(
        "cad4-graph/engine-id-non-canonicality",
        "DIRECT OBSERVATION: two independent builds of model version v1 "
        "produce DISJOINT engine GlobalId sets in quantity provenance, "
        "while the quantity graphs (domain-id keyed) are IDENTICAL — "
        "engine ids cannot be canonical identity for quantities.",
        check["engine_ids_disjoint"] and check["graphs_identical"],
        details=check, epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 4. Consumer API: quantities read from the graph without engines
    # ------------------------------------------------------------------
    q = graph_get_quantity(graphs["v1"], "off:cad4:wall:north", "BRepNetVolume")
    result.observe(
        "cad4-graph/consumer-api",
        "The consumer API reads quantities from the graph (value, unit, "
        "state, tolerance) with no engine imports, no engine ids and no "
        "file access — applications consume Graph quantities, not engine "
        "internals.",
        q is not None and abs(q["value"] - 8.46) <= 1e-6
        and q["unit"] == "m^3" and q["state"] == "CALCULATED",
        details={"read_quantity": q}, epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 5. Graph diff across revisions matches the quantity diff
    # ------------------------------------------------------------------
    gd12 = diff_graphs(graphs["v1"], graphs["v2"])
    result.observe(
        "cad4-graph/diff-v1-v2",
        "The graph diff detects exactly wall-north as changed across "
        "v1 -> v2 (all other nodes unchanged, none added/removed).",
        gd12["changed"].keys() == {"off:cad4:wall:north"}
        and len(gd12["unchanged"]) == 9
        and not gd12["added_nodes"] and not gd12["removed_nodes"],
        details={"changed": list(gd12["changed"].keys()),
                 "changed_quantities": gd12["changed"]["off:cad4:wall:north"]},
        epistemic="ADAPTER",
    )
    gd23 = diff_graphs(graphs["v2"], graphs["v3"])
    result.observe(
        "cad4-graph/diff-v2-v3",
        "The graph diff detects exactly the window + host wall as "
        "changed across v2 -> v3 (property-only wall-east unchanged).",
        set(gd23["changed"].keys())
        == {"off:cad4:wall:south", "off:cad4:wall:south:window-2"}
        and "off:cad4:wall:east" in gd23["unchanged"],
        details={"changed": sorted(gd23["changed"].keys())},
        epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 6. Graph reflects the dual-path agreement (engine independence)
    # ------------------------------------------------------------------
    from ..quantity_records import analytic_snapshot

    graph_analytic = build_quantity_graph(analytic_snapshot("v1"))
    # common quantity surface comparison: BRep records exist only in the
    # engine path; compare the OBSERVED+shared surface and the BRep values
    # against analytic NetVolume/GrossVolume
    ok = True
    for w in ("north", "south", "east", "west"):
        wid = f"off:cad4:wall:{w}"
        g_engine = graphs["v1"]["nodes"][wid]["quantities"]
        g_analytic = graph_analytic["nodes"][wid]["quantities"]
        for q_name in ("NetVolume", "GrossVolume", "Weight"):
            if q_name in g_analytic and q_name in g_engine:
                if abs(g_engine[q_name]["value"] - g_analytic[q_name]["value"]) > 1e-9:
                    ok = False
        if abs(g_engine["BRepNetVolume"]["value"]
               - g_analytic["NetVolume"]["value"]) > 1e-6:
            ok = False
    result.observe(
        "cad4-graph/dual-path-graph-agreement",
        "The graph built from the engine-path extraction and the graph "
        "built from the pure-Python analytic snapshot agree on every "
        "shared quantity (and the BRep quantities match their analytic "
        "counterparts) — the Graph mapping is engine-independent.",
        ok, epistemic="OBSERVED",
    )
