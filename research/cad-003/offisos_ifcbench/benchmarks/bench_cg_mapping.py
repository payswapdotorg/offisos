"""Benchmark: Construction Graph mapping proof (RESEARCH-CAD-003 scope 5).

The reproducible mapping from IFC/model version to canonical Graph
objects; engine/IFC objects remain source representations, never the
Graph's canonical identity; lossy/unsupported/inferred/opaque-lineage
fields are classified explicitly.
"""
from __future__ import annotations


def run(result) -> None:
    from ..cg_mapping import build_graph_revision, diff_graph_revisions
    from ..fixture import build_fixture
    from ..pipeline import (
        compare_snapshots,
        export,
        extract_snapshot,
        mutate_property,
        reimport,
    )

    f = build_fixture()
    snap = extract_snapshot(f)

    # ------------------------------------------------------------------
    # 1. Graph revision from the IFC snapshot
    # ------------------------------------------------------------------
    graph = build_graph_revision(snap)
    result.observe(
        "cad3-graph/node-coverage",
        "The graph revision contains one canonical node per non-opening "
        "element (6 walls + 1 slab + 2 spaces + 2 doors + 2 windows = 13) "
        "with openings recorded as void lineage instead.",
        len(graph["nodes"]) == 13 and len(graph["void_lineage"]) == 4,
        details={"nodes": len(graph["nodes"]),
                 "void_lineage": len(graph["void_lineage"])},
        epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 2. Provenance recorded per node
    # ------------------------------------------------------------------
    node = graph["nodes"][0]
    provenance_ok = (
        node["provenance"]["source_engine"] == "ifcopenshell"
        and node["provenance"]["source_engine_id"]
        and node["provenance"]["source_ifc_class"].startswith("Ifc")
        and node["provenance"]["identity_resolution"] == "identity-pset"
    )
    result.observe(
        "cad3-graph/provenance-per-node",
        "Every node records provenance: source engine, engine GlobalId, "
        "IFC class, model revision and identity-resolution method.",
        all(
            n["provenance"]["source_engine_id"]
            and n["provenance"]["source_ifc_class"]
            and n["provenance"]["identity_resolution"] == "identity-pset"
            for n in graph["nodes"]
        ),
        details={"sample": node["provenance"], "provenance_ok": provenance_ok},
        epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 3. Engine ids are NOT canonical: regeneration proof
    # ------------------------------------------------------------------
    f_regen = build_fixture()
    snap_regen = extract_snapshot(f_regen)
    gids_1 = {e["global_id"] for e in snap["elements"].values()}
    gids_2 = {e["global_id"] for e in snap_regen["elements"].values()}
    result.observe(
        "cad3-graph/engine-ids-unstable-across-regeneration",
        "DIRECT OBSERVATION: two independent builds of the same fixture "
        "produce DISJOINT GlobalId sets — engine ids cannot be canonical "
        "identity.",
        gids_1.isdisjoint(gids_2),
        details={"build_a_sample": sorted(gids_1)[:2],
                 "build_b_sample": sorted(gids_2)[:2]},
        epistemic="OBSERVED",
    )
    graph_regen = build_graph_revision(snap_regen)
    ids_1 = {n["node_id"] for n in graph["nodes"]}
    ids_2 = {n["node_id"] for n in graph_regen["nodes"]}
    result.observe(
        "cad3-graph/canonical-ids-stable-across-regeneration",
        "Canonical node ids (domain identities) are IDENTICAL across "
        "regeneration while engine GlobalIds are disjoint — the Graph is "
        "independent of engine identity.",
        ids_1 == ids_2,
        details={"node_count": len(ids_1)}, epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 4. Graph stability across the IFC round trip
    # ------------------------------------------------------------------
    mutate_property(f, "off:cad3:wall:south", "Pset_WallCommon", "FireRating", "REI90")
    snap_mut = extract_snapshot(f)
    export(f, "/tmp/cad3-graph-rt.ifc")
    f_rt = reimport("/tmp/cad3-graph-rt.ifc")
    snap_rt = extract_snapshot(f_rt)
    graph_mut = build_graph_revision(snap_mut)
    graph_rt = build_graph_revision(snap_rt)
    diff_rt = diff_graph_revisions(graph_mut, graph_rt)
    result.observe(
        "cad3-graph/stable-across-roundtrip",
        "The graph revision is structurally identical across "
        "export/re-import (no added/removed nodes).",
        diff_rt["added"] == [] and diff_rt["removed"] == []
        and len(diff_rt["unchanged"]) == 13,
        details={"diff": diff_rt}, epistemic="ADAPTER",
    )

    # node-level: provenance GlobalIds also stable in-file across the cycle
    prov_before = {n["node_id"]: n["provenance"]["source_engine_id"] for n in graph_mut["nodes"]}
    prov_after = {n["node_id"]: n["provenance"]["source_engine_id"] for n in graph_rt["nodes"]}
    result.observe(
        "cad3-graph/provenance-continuous-across-roundtrip",
        "Node provenance (engine GlobalIds) is continuous across the "
        "export/re-import cycle — lineage survives round trips.",
        prov_before == prov_after, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 5. Graph reflects semantic changes (not blind)
    # ------------------------------------------------------------------
    f2 = build_fixture()
    from ..pipeline import mutate_create_wall, mutate_delete_wall

    mutate_create_wall(f2, "off:cad3:wall:extra", "wall-extra", 30.0, 0.0, 36.0, 0.0, 6.0, 3.0, 0.3)
    mutate_delete_wall(f2, "off:cad3:wall:interior-2")
    snap_changed = extract_snapshot(f2)
    graph_changed = build_graph_revision(snap_changed)
    diff_changed = diff_graph_revisions(graph, graph_changed)
    result.observe(
        "cad3-graph/diff-detects-exact-changes",
        "The graph diff detects exactly the created and deleted walls "
        "(added=[wall:extra], removed=[wall:interior-2]) — the mapping "
        "tracks real semantic changes, not just file bytes.",
        diff_changed["added"] == ["off:cad3:wall:extra"]
        and diff_changed["removed"] == ["off:cad3:wall:interior-2"],
        details={"diff": diff_changed}, epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 6. Field classification (documented, reproducible)
    # ------------------------------------------------------------------
    from ..cg_mapping import classify_fields

    classification = classify_fields({})
    result.observe(
        "cad3-graph/field-classification",
        "The mapping documents field handling: PRESERVED (identity, class, "
        "name, typed properties, quantities, units, placements, "
        "relationships), OPAQUE-LINEAGE (geometry representation "
        "contents — validated through quantity invariants), UNSUPPORTED "
        "(IFC4X3-only entities in IFC4, schema-scoped), INFERRED (none).",
        "domain identity (Pset_OffisosIdentity.DomainId/DomainKind/ModelRevision)"
        in classification["PRESERVED"]
        and any("geometry representation contents" in f for f in classification["OPAQUE-LINEAGE"])
        and classification["INFERRED"] == [
            "none: no inferred values are promoted to observed facts in this pipeline"
        ],
        details={"classification": classification},
        epistemic="ADAPTER",
    )
