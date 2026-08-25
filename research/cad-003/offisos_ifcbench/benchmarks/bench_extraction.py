"""Benchmark: semantic extraction (RESEARCH-CAD-003 scope 2).

Deterministic extraction of entity identity and IFC class, property-set
and quantity extraction, relationship/containment extraction, placements
and representation references, and the stable mapping of source
identifiers into the ConstructionOS model boundary.
"""
from __future__ import annotations


def run(result) -> None:
    from ..fixture import IDENTITY_PSET, build_fixture
    from ..pipeline import extract_snapshot

    f = build_fixture()
    snap = extract_snapshot(f)

    # ------------------------------------------------------------------
    # 1. Extraction determinism (same file, twice)
    # ------------------------------------------------------------------
    snap_b = extract_snapshot(f)
    result.observe(
        "cad3-extract/determinism",
        "Extracting the same file twice produces identical snapshots "
        "(sorted keys, rounded placements).",
        snap == snap_b, epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 2. Identity: every non-opening element carries a domain id
    # ------------------------------------------------------------------
    elements = [
        e for e in snap["elements"].values() if e["ifc_class"] != "IfcOpeningElement"
    ]
    result.observe(
        "cad3-extract/identity-coverage",
        "Every wall/slab/space/door/window carries an Offisos domain id via "
        "the identity property set (stable mapping into the ConstructionOS "
        "model boundary).",
        all(e["identity_pset_found"] and e["domain_id"].startswith("off:cad3:") for e in elements),
        details={"element_count": len(elements),
                 "domain_ids": sorted(e["domain_id"] for e in elements)[:6]},
        epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 3. Identity pset is distinguishable from domain property sets
    # ------------------------------------------------------------------
    wall = next(e for e in elements if e["domain_id"] == "off:cad3:wall:north")
    result.observe(
        "cad3-extract/identity-not-in-properties",
        "The identity property set is consumed as identity metadata, not "
        "mixed into domain properties (no Pset_OffisosIdentity.* keys in "
        "the extracted properties).",
        not any(k.startswith(IDENTITY_PSET) for k in wall["properties"]),
        details={"property_keys": sorted(wall["properties"].keys())},
        epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 4. IFC class + name + engine id provenance recorded
    # ------------------------------------------------------------------
    result.observe(
        "cad3-extract/class-name-provenance",
        "Each element records its IFC class, name and engine GlobalId as "
        "provenance (engine ids are provenance, never canonical).",
        all(e["ifc_class"] and e["global_id"] and e["name"] for e in elements),
        details={"sample": {
            e["domain_id"]: (e["ifc_class"], e["name"], e["global_id"][:13])
            for e in elements[:3]
        }},
        epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 5. Property/quantity extraction coverage
    # ------------------------------------------------------------------
    wall_props = set(wall["properties"].keys())
    expected_props = {
        "Pset_WallCommon.FireRating", "Pset_WallCommon.IsExternal",
        "Pset_WallCommon.LoadBearing", "Pset_WallCommon.ThermalTransmittance",
        "Pset_OffisosProject.PhaseCode", "Pset_OffisosProject.WorkPackage",
        "Pset_OffisosProject.ZoneIdentifier",
    }
    result.observe(
        "cad3-extract/property-coverage",
        "Property extraction covers Pset_WallCommon (4 typed values) and the "
        "custom project property set (3 values) for the north wall.",
        expected_props.issubset(wall_props),
        details={"extracted": sorted(wall_props)}, epistemic="ADAPTER",
    )
    wall_qtos = set(wall["quantities"].keys())
    result.observe(
        "cad3-extract/quantity-coverage",
        "Quantity extraction covers the full Qto_WallCommon set "
        "(GrossVolume, NetVolume, GrossSideArea, NetSideArea, Height, "
        "Length, Width).",
        {"GrossVolume", "NetVolume", "GrossSideArea", "NetSideArea",
         "Height", "Length", "Width"}.issubset(wall_qtos),
        details={"extracted": sorted(wall_qtos)}, epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 6. Relationship extraction
    # ------------------------------------------------------------------
    result.observe(
        "cad3-extract/relationships",
        "Relationship extraction reports voids=4, fills=4, containment=1, "
        "aggregation=4 (exact fixture semantics).",
        snap["relationships"] == {
            "voids": 4, "fills": 4, "containment": 1, "aggregation": 4,
        },
        details={"relationships": snap["relationships"]}, epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 7. Placement + representation reference extraction
    # ------------------------------------------------------------------
    import ifcopenshell

    wall_entity = next(
        w for w in f.by_type("IfcWall") if w.Name == "wall-north"
    )
    has_representation = wall_entity.Representation is not None
    rep_items = 0
    if has_representation:
        rep_items = len(wall_entity.Representation.Representations[0].Items)
    result.observe(
        "cad3-extract/representation-reference",
        "Extraction records placements exactly, and representation "
        "references are reachable (wall-north: 1 representation item "
        "(SweptSolid)).",
        wall["placement"] == [0.0, 8.0, 0.0] and has_representation and rep_items == 1,
        details={"placement": wall["placement"], "representation_items": rep_items},
        epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 8. GlobalId stability within one file (write/read cycle)
    # ------------------------------------------------------------------
    f.write("/tmp/cad3-extract-wr.ifc")
    f2 = ifcopenshell.open("/tmp/cad3-extract-wr.ifc")
    snap_wr = extract_snapshot(f2)
    gids_1 = {e["global_id"] for e in snap["elements"].values()}
    gids_2 = {e["global_id"] for e in snap_wr["elements"].values()}
    result.observe(
        "cad3-extract/globalid-stable-in-file",
        "GlobalIds are stable across file write/read cycles of the same "
        "logical file (relevant for provenance continuity).",
        gids_1 == gids_2, epistemic="NATIVE",
    )
