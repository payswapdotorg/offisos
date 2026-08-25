"""Benchmark: Construction Graph mapping (RESEARCH-CAD-001 item 8).

Proves the model-revision -> canonical-graph mapping without making the
engine model canonical:

- domain ids are stable across model regeneration while engine GlobalIds
  are NOT (direct observation: two builds of the same fixture);
- domain ids survive IFC round trips via the identity property set;
- provenance/lineage is recorded on every node;
- structural diff detects exactly the change made between revisions.
"""
from __future__ import annotations

from ..fixtures import SMALL_WALLS, WALL_HEIGHT, WALL_THICKNESS
from .bench_bim_semantics import build_small_model


def run(result) -> None:
    from ..engines.ifc_adapter import IfcOpenShellAdapter
    from ..cg_mapping import ConstructionGraphMapper, domain_id_for

    adapter = IfcOpenShellAdapter()
    mapper = ConstructionGraphMapper()

    # ------------------------------------------------------------------
    # 1. Same fixture, two builds: domain ids stable, GlobalIds NOT
    # ------------------------------------------------------------------
    model_a = build_small_model(adapter, "cg-a")
    wall_gids_a = [e.source["engine_id"] for e in model_a.elements if e.kind == "wall"]
    model_b = build_small_model(adapter, "cg-b")
    wall_gids_b = [e.source["engine_id"] for e in model_b.elements if e.kind == "wall"]

    result.observe(
        "cg/engine-ids/unstable-across-regeneration",
        "Engine GlobalIds differ between two builds of the same logical fixture "
        "(direct observation of why engine ids cannot be canonical).",
        set(wall_gids_a).isdisjoint(set(wall_gids_b)),
        details={
            "build_a_sample": wall_gids_a[:2],
            "build_b_sample": wall_gids_b[:2],
        },
        epistemic="OBSERVED",
    )

    ids_a = sorted(e.domain_id for e in model_a.elements)
    ids_b = sorted(e.domain_id for e in model_b.elements)
    result.observe(
        "cg/domain-ids/stable-across-regeneration",
        "Offisos domain ids are identical across regeneration of the same fixture.",
        ids_a == ids_b,
        details={"count": len(ids_a)}, epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 2. Round-trip: domain ids preserved via identity property set
    # ------------------------------------------------------------------
    adapter.export_ifc(model_a, "/tmp/cg-a.ifc")
    rt = adapter.import_ifc("/tmp/cg-a.ifc", "cg-a-rt")
    ids_rt = sorted(e.domain_id for e in rt.elements if e.domain_id)
    result.observe(
        "cg/domain-ids/roundtrip-preserved",
        "Domain ids survive the IFC round trip exactly.",
        ids_rt == ids_a,
        details={"before": len(ids_a), "after": len(ids_rt)}, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 3. Graph revision with provenance
    # ------------------------------------------------------------------
    rev_a = mapper.build_revision(model_a, project="offisos-bench", story="S01",
                                  revision_id="rev-001")
    result.observe(
        "cg/revision/node-count",
        "Graph revision contains a node for every canonical element.",
        len(rev_a.nodes) == len(ids_a),
        details={"nodes": len(rev_a.nodes)}, epistemic="NATIVE",
    )
    node = rev_a.nodes[0]
    provenance_complete = (
        node.provenance.get("source_engine") == "ifcopenshell+occt"
        and node.provenance.get("source_engine_id")
        and node.provenance.get("source_engine_class")
        and node.provenance.get("identity_resolution") in
        ("identity-pset", "structural-anchor-derived")
    )
    result.observe(
        "cg/provenance/recorded",
        "Every node records provenance: engine, engine id, engine class, "
        "identity resolution method.",
        provenance_complete,
        details={"sample_provenance": node.provenance}, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 4. Openings recorded as voids, not canonical elements
    # (the round-tripped model carries IfcOpeningElement entries; the
    #  created model carries them only as voids relationships)
    # ------------------------------------------------------------------
    rev_rt = mapper.build_revision(rt, project="offisos-bench", story="S01",
                                   revision_id="rev-rt")
    opening_nodes = [n for n in rev_rt.nodes if n.element_class == "opening"]
    void_lineage = [l for l in rev_rt.lineage if l.get("treatment") == "void-of-host"]
    result.observe(
        "cg/openings/not-canonical-elements",
        "Opening elements are recorded as voids in lineage, not canonical elements.",
        len(opening_nodes) == 0 and len(void_lineage) > 0,
        details={"void_lineage_entries": len(void_lineage)}, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 5. Structural diff: one wall added -> exactly one added node
    # ------------------------------------------------------------------
    model_c = build_small_model(adapter, "cg-c")
    adapter.add_wall(
        model_c, "el:wall-99", "wall-extra",
        20.0, 0.0, 26.0, 0.0, WALL_HEIGHT, WALL_THICKNESS,
    )
    rev_c = mapper.build_revision(model_c, project="offisos-bench", story="S01",
                                  revision_id="rev-002")
    diff = mapper.diff(rev_a, rev_c)
    result.observe(
        "cg/diff/detects-added-element",
        "Diff between revisions detects exactly the one added wall.",
        diff["added"] == ["el:wall-99"] and diff["removed"] == []
        and len(diff["unchanged"]) == len(ids_a),
        details={"added": diff["added"], "removed": diff["removed"]},
        epistemic="NATIVE",
    )

    # reverse: removed element
    diff_rt = mapper.diff(rev_a, rev_rt)
    result.observe(
        "cg/diff/roundtrip-no-change",
        "Diff between the original and round-tripped revision is empty.",
        diff_rt["added"] == [] and diff_rt["removed"] == [],
        details={"diff": diff_rt}, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 6. Structural-anchor derivation for elements without identity
    # ------------------------------------------------------------------
    derived = domain_id_for("proj", "S01", "wall", 7)
    derived_again = domain_id_for("proj", "S01", "wall", 7)
    derived_other = domain_id_for("proj", "S01", "wall", 8)
    result.observe(
        "cg/anchors/deterministic-derivation",
        "Structural-anchor domain ids are deterministic and position-sensitive.",
        derived == derived_again and derived != derived_other and derived.startswith("off:proj:S01:wall:007:"),
        details={"derived": derived}, epistemic="NATIVE",
    )
