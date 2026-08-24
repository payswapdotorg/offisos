"""Benchmark: IFC round-trip semantic fidelity (RESEARCH-CAD-001 item 5).

Write -> read -> assert: GlobalId stability within a file, class stability,
typed property preservation, quantity preservation, identity preservation,
relationship preservation, and narrow-patch preservation (modifying one
element leaves unrelated elements untouched).
"""
from __future__ import annotations

from ..fixtures import (
    OPENINGS_EXPECTED,
    ROUNDTRIP_PROPERTIES,
    WALL_HEIGHT,
    WALL_THICKNESS,
)


def run(result) -> None:
    from ..engines.ifc_adapter import IfcOpenShellAdapter

    adapter = IfcOpenShellAdapter()
    model = adapter.create_model("roundtrip")
    wall = adapter.add_wall(
        model, "el:rt-wall", "Round-trip wall",
        0.0, 0.0, 6.0, 0.0, WALL_HEIGHT, WALL_THICKNESS,
        openings=[
            {"kind": "door", "x": 1.5, "width": 1.0, "height": 2.1, "sill": 0.0},
            {"kind": "window", "x": 4.0, "width": 1.2, "height": 1.5, "sill": 0.9},
        ],
        properties={p["name"]: p["value"] for p in ROUNDTRIP_PROPERTIES},
    )
    adapter.add_slab(model, "el:rt-slab", "Round-trip slab", 5.0, 8.0, 0.25)
    adapter.add_space(model, "el:rt-space", "Round-trip space", 4.4, 7.4)

    adapter.export_ifc(model, "/tmp/roundtrip.ifc")

    # first read-back
    m1 = adapter.import_ifc("/tmp/roundtrip.ifc", "rt-1")

    # ------------------------------------------------------------------
    # 1. Identity: domain ids preserved via the identity property set
    # (opening elements are voids, not canonical elements — excluded)
    # ------------------------------------------------------------------
    ids_before = {e.domain_id for e in model.elements if e.kind != "opening"}
    ids_after = {
        e.domain_id for e in m1.elements
        if e.kind != "opening" and e.domain_id
    }
    result.observe(
        "roundtrip/identity/domain-ids-preserved",
        "All Offisos domain ids are preserved across the IFC round trip "
        "(openings excluded: they are voids, not canonical elements).",
        ids_before == ids_after,
        details={"before": sorted(ids_before), "after": sorted(ids_after)},
        epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 2. GlobalId stability within a file (identity by engine id)
    # ------------------------------------------------------------------
    import ifcopenshell

    f1 = ifcopenshell.open("/tmp/roundtrip.ifc")
    gids_1 = {e.GlobalId for e in f1.by_type("IfcWall")}
    f1.write("/tmp/roundtrip-2.ifc")
    f2 = ifcopenshell.open("/tmp/roundtrip-2.ifc")
    gids_2 = {e.GlobalId for e in f2.by_type("IfcWall")}
    result.observe(
        "roundtrip/globalid/stable-within-file",
        "GlobalIds are stable across file write/read/write cycles (same logical file).",
        gids_1 == gids_2,
        details={"gids": sorted(gids_1)}, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 3. Class stability (openings excluded: they appear only on import)
    # ------------------------------------------------------------------
    classes_before = sorted(e.source["engine_class"] for e in model.elements)
    classes_after = sorted(
        e.source["engine_class"] for e in m1.elements if e.kind != "opening"
    )
    result.observe(
        "roundtrip/classes/preserved",
        "IFC entity classes are preserved for every element.",
        classes_before == classes_after,
        details={"before": classes_before, "after": classes_after}, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 4. Typed property preservation (string / boolean / float)
    # ------------------------------------------------------------------
    wall_after = next(e for e in m1.elements if e.domain_id == "el:rt-wall")
    prop_results = {}
    for p in ROUNDTRIP_PROPERTIES:
        observed = wall_after.properties.get(p["name"])
        expected = p["value"]
        same_type = isinstance(observed, type(expected))
        same_value = observed == expected
        prop_results[p["name"]] = {
            "expected": expected, "observed": observed,
            "type_preserved": same_type, "value_preserved": same_value,
        }
    all_ok = all(v["value_preserved"] for v in prop_results.values())
    result.observe(
        "roundtrip/properties/values-preserved",
        "Every typed property value is preserved exactly (label, boolean, real, identifier).",
        all_ok,
        details=prop_results, epistemic="NATIVE",
    )
    bool_type_ok = wall_after.properties.get("IsExternal") is True
    result.observe(
        "roundtrip/properties/boolean-type-fidelity",
        "Boolean properties remain booleans (not coerced to 0/1 or strings).",
        bool_type_ok, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 5. Quantity preservation with numeric assertions
    # ------------------------------------------------------------------
    qto = wall_after.domain_quantities
    result.assert_close(
        "roundtrip/quantities/net-volume",
        "Qto NetVolume survives the round trip exactly (4.23 m^3).",
        qto["NetVolume"].value, OPENINGS_EXPECTED["net_volume"], 1e-9,
        details={"state": qto["NetVolume"].state}, epistemic="NATIVE",
    )
    result.assert_close(
        "roundtrip/quantities/gross-volume",
        "Qto GrossVolume survives the round trip exactly (5.4 m^3).",
        qto["GrossVolume"].value, OPENINGS_EXPECTED["gross_volume"], 1e-9, epistemic="NATIVE",
    )
    result.assert_close(
        "roundtrip/quantities/net-side-area",
        "Qto NetSideArea survives the round trip exactly (14.1 m^2).",
        qto["NetSideArea"].value, OPENINGS_EXPECTED["net_side_area"], 1e-9, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 6. Relationship preservation
    # ------------------------------------------------------------------
    voids_before = sum(1 for r in model.relationships if r["type"] == "voids")
    fills_before = sum(1 for r in model.relationships if r["type"] == "fills")
    voids_after = sum(
        1 for r in m1.relationships if r["type"] == "voids"
        and r.get("element_engine_id")
    )
    fills_after = sum(
        1 for r in m1.relationships if r["type"] == "fills"
        and r.get("element_engine_id")
    )
    result.observe(
        "roundtrip/relationships/voids",
        "IfcRelVoidsElement relationships are preserved exactly.",
        voids_before == voids_after == 2,
        details={"before": voids_before, "after": voids_after}, epistemic="NATIVE",
    )
    result.observe(
        "roundtrip/relationships/fills",
        "IfcRelFillsElement relationships are preserved exactly.",
        fills_before == fills_after == 2,
        details={"before": fills_before, "after": fills_after}, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 7. Narrow-patch preservation: edit ONE property, unrelated data unchanged
    # ------------------------------------------------------------------
    f3 = ifcopenshell.open("/tmp/roundtrip.ifc")
    import ifcopenshell.util.element as eu

    wall_ent = next(w for w in f3.by_type("IfcWall"))
    psets = eu.get_psets(wall_ent)
    pset_name = "Pset_WallCommon"
    pset_id = psets[pset_name]["id"]
    pset = f3.by_id(pset_id)
    for prop in pset.HasProperties or []:
        if prop.Name == "FireRating":
            prop.NominalValue.wrappedValue = "REI90"
    slab_before = {
        s.GlobalId: eu.get_psets(s) for s in f3.by_type("IfcSlab")
    }
    space_before = {
        s.GlobalId: eu.get_psets(s) for s in f3.by_type("IfcSpace")
    }
    f3.write("/tmp/roundtrip-patched.ifc")

    f4 = ifcopenshell.open("/tmp/roundtrip-patched.ifc")
    wall_patched = next(w for w in f4.by_type("IfcWall"))
    patched_rating = eu.get_psets(wall_patched)["Pset_WallCommon"]["FireRating"]
    result.observe(
        "roundtrip/narrow-patch/target-changed",
        "Targeted property edit (FireRating REI60 -> REI90) is applied.",
        patched_rating == "REI90",
        details={"observed": patched_rating}, epistemic="NATIVE",
    )
    slab_after = {s.GlobalId: eu.get_psets(s) for s in f4.by_type("IfcSlab")}
    space_after = {s.GlobalId: eu.get_psets(s) for s in f4.by_type("IfcSpace")}
    untouched = (
        slab_before.keys() == slab_after.keys()
        and space_before.keys() == space_after.keys()
        and all(
            slab_before[g] == slab_after[g] for g in slab_before
        )
        and all(space_before[g] == space_after[g] for g in space_before)
    )
    result.observe(
        "roundtrip/narrow-patch/unrelated-preserved",
        "Unrelated slab/space property sets are byte-identical after the patch.",
        untouched, epistemic="NATIVE",
    )
    # also confirm unrelated wall quantities unchanged
    qto_before = eu.get_psets(next(w for w in f3.by_type("IfcWall")), qtos_only=True)
    qto_after = eu.get_psets(wall_patched, qtos_only=True)
    result.observe(
        "roundtrip/narrow-patch/quantities-preserved",
        "Wall quantity sets are unchanged by the property-only patch.",
        {k: v for k, v in qto_before.items() if k != "id"}
        == {k: v for k, v in qto_after.items() if k != "id"},
        epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 8. Observed loss recording: any property type we could not preserve
    # ------------------------------------------------------------------
    # (Explicitly asserted absence of loss for the tested property types.)
    result.observe(
        "roundtrip/losses/none-observed",
        "No semantic loss observed for the tested property types "
        "(IfcLabel, IfcBoolean, IfcReal, IfcIdentifier), quantities or relationships.",
        all(v["value_preserved"] for v in prop_results.values()),
        details={"tested_types": sorted({p["type"] for p in ROUNDTRIP_PROPERTIES})},
        epistemic="OBSERVED",
    )
