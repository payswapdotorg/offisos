"""Benchmark: IFC round-trip semantic comparison (RESEARCH-CAD-003 scope 4).

Full pipeline: import fixture -> extract -> controlled transform ->
export -> re-import -> semantic comparison. Proves which identities,
classes, relationships, properties, quantities, units and placements
survive; geometry invariants are explicit about what is and is not
guaranteed; lossiness is recorded, never hidden.
"""
from __future__ import annotations


def run(result) -> None:
    from ..fixture import EXPECTED, build_fixture
    from ..pipeline import (
        compare_snapshots,
        export,
        extract_snapshot,
        mutate_property,
        reimport,
    )
    from ..cg_mapping import classify_fields

    f = build_fixture()
    snap_original = extract_snapshot(f)

    # controlled transform before export (the pipeline under test)
    lineage = mutate_property(
        f, "off:cad3:wall:south", "Pset_WallCommon", "FireRating", "REI90"
    )
    snap_transformed = extract_snapshot(f)

    # ------------------------------------------------------------------
    # 1. Export -> re-import -> semantic comparison
    # ------------------------------------------------------------------
    bytes_written = export(f, "/tmp/cad3-roundtrip.ifc")
    f_rt = reimport("/tmp/cad3-roundtrip.ifc")
    snap_rt = extract_snapshot(f_rt)
    diff = compare_snapshots(snap_transformed, snap_rt)

    result.observe(
        "cad3-roundtrip/semantic-zero-drift",
        "Export -> re-import introduces ZERO semantic drift: no added or "
        "removed elements and no changed fields relative to the "
        "pre-export snapshot.",
        diff["added"] == [] and diff["removed"] == [] and diff["changed"] == {},
        details={"bytes": bytes_written,
                 "added": diff["added"], "removed": diff["removed"],
                 "changed": list(diff["changed"].keys())},
        epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 2. Identity / class / name survival
    # ------------------------------------------------------------------
    ids_before = {
        e["domain_id"] for e in snap_transformed["elements"].values() if e["domain_id"]
    }
    ids_after = {
        e["domain_id"] for e in snap_rt["elements"].values() if e["domain_id"]
    }
    result.observe(
        "cad3-roundtrip/identity-survival",
        "All Offisos domain identities survive the round trip exactly.",
        ids_before == ids_after,
        details={"before": len(ids_before), "after": len(ids_after)},
        epistemic="NATIVE",
    )
    class_map_before = {
        e["domain_id"]: e["ifc_class"]
        for e in snap_transformed["elements"].values() if e["domain_id"]
    }
    class_map_after = {
        e["domain_id"]: e["ifc_class"]
        for e in snap_rt["elements"].values() if e["domain_id"]
    }
    result.observe(
        "cad3-roundtrip/class-survival",
        "IFC classes are preserved for every element across the round trip.",
        class_map_before == class_map_after, epistemic="NATIVE",
    )

    # GlobalIds survive too (same logical file)
    gids_before = {e["global_id"] for e in snap_transformed["elements"].values()}
    gids_after = {e["global_id"] for e in snap_rt["elements"].values()}
    result.observe(
        "cad3-roundtrip/globalid-survival",
        "GlobalIds are preserved across the export/re-import cycle "
        "(provenance continuity for the same logical file).",
        gids_before == gids_after, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 3. Relationships / units / placements survival
    # ------------------------------------------------------------------
    result.observe(
        "cad3-roundtrip/relationships-survival",
        "Voids/fills/containment/aggregation relationship counts are "
        "preserved exactly.",
        snap_transformed["relationships"] == snap_rt["relationships"],
        details={"before": snap_transformed["relationships"],
                 "after": snap_rt["relationships"]},
        epistemic="NATIVE",
    )
    result.observe(
        "cad3-roundtrip/units-survival",
        "The METRE project length unit is preserved exactly.",
        snap_transformed["units"] == snap_rt["units"]
        and snap_rt["units"]["length"]["name"] == "METRE",
        details={"units": snap_rt["units"]}, epistemic="NATIVE",
    )
    placements_before = {
        e["domain_id"]: e["placement"]
        for e in snap_transformed["elements"].values() if e["domain_id"]
    }
    placements_after = {
        e["domain_id"]: e["placement"]
        for e in snap_rt["elements"].values() if e["domain_id"]
    }
    result.observe(
        "cad3-roundtrip/placement-survival",
        "Object placement translations are preserved exactly for every "
        "element.",
        placements_before == placements_after, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 4. Properties and quantities survival (value + type)
    # ------------------------------------------------------------------
    wall_south = next(
        e for e in snap_rt["elements"].values()
        if e["domain_id"] == "off:cad3:wall:south"
    )
    result.observe(
        "cad3-roundtrip/mutation-visible",
        "The pre-export mutation is visible after re-import: wall-south "
        "FireRating is REI90 with boolean/reals intact.",
        wall_south["properties"].get("Pset_WallCommon.FireRating") == "REI90"
        and wall_south["properties"].get("Pset_WallCommon.IsExternal") is True
        and abs(wall_south["properties"].get("Pset_WallCommon.ThermalTransmittance", 0) - 0.35) <= 1e-12,
        details={"fire_rating": wall_south["properties"].get("Pset_WallCommon.FireRating"),
                 "lineage": lineage},
        epistemic="NATIVE",
    )
    qty_ok = True
    for e_before in snap_transformed["elements"].values():
        if not e_before["domain_id"]:
            continue
        e_after = next(
            e for e in snap_rt["elements"].values()
            if e["domain_id"] == e_before["domain_id"]
        )
        for q_name, q_value in e_before["quantities"].items():
            if abs(e_after["quantities"].get(q_name, float("nan")) - q_value) > 1e-9:
                qty_ok = False
    result.observe(
        "cad3-roundtrip/quantity-survival",
        "Every quantity set value survives the round trip within 1e-9 "
        "(across all walls, the slab and both spaces).",
        qty_ok, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 5. Geometry invariants: explicit about guarantees
    # ------------------------------------------------------------------
    import ifcopenshell

    wall_north_rt = next(
        w for w in f_rt.by_type("IfcWall") if w.Name == "wall-north"
    )
    rep = wall_north_rt.Representation.Representations[0]
    depth = float(rep.Items[0].Depth)
    result.assert_close(
        "cad3-roundtrip/geometry-extrusion-depth",
        "GUARANTEED geometry invariant: the wall SweptSolid extrusion depth "
        "equals the fixture wall height (3.0 m) after the round trip.",
        depth, 3.0, 1e-9, epistemic="NATIVE",
    )
    opening_count_rt = len(f_rt.by_type("IfcOpeningElement"))
    result.observe(
        "cad3-roundtrip/geometry-opening-count",
        "GUARANTEED geometry invariant: the semantic opening count (4) is "
        "preserved with voids relationships intact.",
        opening_count_rt == EXPECTED["opening_count"]
        and snap_rt["relationships"]["voids"] == EXPECTED["voids_relationships"],
        details={"openings": opening_count_rt}, epistemic="NATIVE",
    )
    result.observe(
        "cad3-roundtrip/geometry-not-guaranteed",
        "NOT GUARANTEED (explicit): tessellated mesh equivalence, "
        "face/edge ordering and BRep byte-equality across "
        "export/re-import. These are engine-internal representations; the "
        "benchmark asserts semantic + quantity invariants instead. "
        "Geometry provenance is recorded as opaque lineage in the "
        "Construction Graph mapping.",
        True,
        details={"guaranteed": ["extrusion depth", "opening/void semantics",
                                "quantity values", "placement translations"],
                 "not_guaranteed": ["tessellation equality", "face/edge ordering",
                                    "BRep byte equality"]},
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 6. Lossiness classification (explicit, from the measured diff)
    # ------------------------------------------------------------------
    classification = classify_fields(diff["changed"])
    result.observe(
        "cad3-roundtrip/lossiness-classification",
        "Field classification from the measured round-trip diff: zero LOSSY "
        "fields observed for the fixture corpus; geometry contents are "
        "OPAQUE-LINEAGE by design; the recorded UNSUPPORTED set is "
        "schema-scoped (IFC4X3-only entities in IFC4).",
        classification["LOSSY"] == [] and classification["INFERRED"] == [
            "none: no inferred values are promoted to observed facts in this pipeline"
        ],
        details={"classification": classification},
        epistemic="OBSERVED",
    )
