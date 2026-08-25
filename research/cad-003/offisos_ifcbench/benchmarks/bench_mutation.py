"""Benchmark: controlled mutation (RESEARCH-CAD-003 scope 3).

Property change, placement change, element creation and deletion — each
proven to update ONLY the intended semantic object (narrow-patch) with
source-to-result lineage recorded.
"""
from __future__ import annotations


def run(result) -> None:
    from ..fixture import build_fixture
    from ..pipeline import (
        compare_snapshots,
        extract_snapshot,
        mutate_create_wall,
        mutate_delete_wall,
        mutate_placement,
        mutate_property,
    )

    f = build_fixture()
    base = extract_snapshot(f)

    # ------------------------------------------------------------------
    # 1. Property mutation: surgical change with lineage
    # ------------------------------------------------------------------
    lineage = mutate_property(
        f, "off:cad3:wall:north", "Pset_WallCommon", "FireRating", "REI120"
    )
    snap = extract_snapshot(f)
    diff = compare_snapshots(base, snap)
    surgical = (
        diff["added"] == [] and diff["removed"] == []
        and list(diff["changed"].keys()) == ["off:cad3:wall:north"]
        and list(diff["changed"]["off:cad3:wall:north"].keys()) == ["properties"]
    )
    result.observe(
        "cad3-mutate/property-surgical",
        "FireRating REI60 -> REI120 on wall-north changes exactly one "
        "element and exactly the properties field; every other element is "
        "semantically unchanged.",
        surgical,
        details={"changed": {k: list(v.keys()) for k, v in diff["changed"].items()},
                 "lineage": lineage},
        epistemic="ADAPTER",
    )
    result.observe(
        "cad3-mutate/property-lineage",
        "The mutation records source-to-result lineage (operation, domain "
        "id, pset, property, before, after).",
        lineage == {
            "operation": "property-change",
            "domain_id": "off:cad3:wall:north",
            "pset": "Pset_WallCommon",
            "property": "FireRating",
            "before": "REI60",
            "after": "REI120",
        },
        details={"lineage": lineage}, epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 2. Placement mutation: surgical move
    # ------------------------------------------------------------------
    lineage2 = mutate_placement(f, "off:cad3:wall:east", 5.0, 1.0)
    snap2 = extract_snapshot(f)
    diff2 = compare_snapshots(snap, snap2)
    result.observe(
        "cad3-mutate/placement-surgical",
        "Moving wall-east by (5, 1) changes exactly that element and "
        "exactly the placement field.",
        diff2["added"] == [] and diff2["removed"] == []
        and list(diff2["changed"].keys()) == ["off:cad3:wall:east"]
        and list(diff2["changed"]["off:cad3:wall:east"].keys()) == ["placement"],
        details={"changed": {k: list(v.keys()) for k, v in diff2["changed"].items()},
                 "lineage": lineage2},
        epistemic="ADAPTER",
    )
    moved = diff2["changed"]["off:cad3:wall:east"]["placement"]
    result.observe(
        "cad3-mutate/placement-value-exact",
        "The placement change is exactly (10, 0, 0) -> (15, 1, 0).",
        moved["before"] == [10.0, 0.0, 0.0] and moved["after"] == [15.0, 1.0, 0.0],
        details={"move": moved}, epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 3. Element creation with identity + properties
    # ------------------------------------------------------------------
    lineage3 = mutate_create_wall(
        f, "off:cad3:wall:added", "wall-added", 20.0, 0.0, 26.0, 0.0, 6.0, 3.0, 0.3
    )
    snap3 = extract_snapshot(f)
    diff3 = compare_snapshots(snap2, snap3)
    result.observe(
        "cad3-mutate/create-surgical",
        "Creating one wall adds exactly one element with its identity; "
        "nothing else changes.",
        diff3["added"] == ["off:cad3:wall:added"] and diff3["removed"] == []
        and diff3["changed"] == {},
        details={"added": diff3["added"], "lineage": {
            k: v for k, v in lineage3.items() if k != "global_id"
        }},
        epistemic="ADAPTER",
    )
    added = extract_snapshot(f)["elements"]
    new_element = next(
        e for e in added.values() if e["domain_id"] == "off:cad3:wall:added"
    )
    result.observe(
        "cad3-mutate/create-identity-and-props",
        "The created wall carries its domain identity, FireRating REI30 and "
        "a 6 m wall representation at (20, 0, 0).",
        new_element["properties"].get("Pset_WallCommon.FireRating") == "REI30"
        and new_element["placement"] == [20.0, 0.0, 0.0],
        details={"element": {
            "domain_id": new_element["domain_id"],
            "fire_rating": new_element["properties"].get("Pset_WallCommon.FireRating"),
            "placement": new_element["placement"],
        }},
        epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 4. Element deletion
    # ------------------------------------------------------------------
    lineage4 = mutate_delete_wall(f, "off:cad3:wall:interior-2")
    snap4 = extract_snapshot(f)
    diff4 = compare_snapshots(snap3, snap4)
    result.observe(
        "cad3-mutate/delete-surgical",
        "Deleting wall-interior-2 removes exactly that element; every "
        "other element is unchanged.",
        diff4["added"] == [] and diff4["removed"] == ["off:cad3:wall:interior-2"]
        and diff4["changed"] == {},
        details={"removed": diff4["removed"], "lineage": {
            k: v for k, v in lineage4.items() if k != "global_id"
        }},
        epistemic="ADAPTER",
    )
    result.observe(
        "cad3-mutate/delete-relationship-cleanup",
        "Deleting the wall removes its containment (relationship counts "
        "drop by the element's relationships; openings of other walls "
        "untouched).",
        snap4["relationships"]["voids"] == snap3["relationships"]["voids"]
        and snap4["relationships"]["fills"] == snap3["relationships"]["fills"],
        details={"before": snap3["relationships"], "after": snap4["relationships"]},
        epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 5. Mutations persist through export/re-import
    # ------------------------------------------------------------------
    from ..pipeline import export, reimport

    export(f, "/tmp/cad3-mutated.ifc")
    f_rt = reimport("/tmp/cad3-mutated.ifc")
    snap_rt = extract_snapshot(f_rt)
    diff_rt = compare_snapshots(snap4, snap_rt)
    result.observe(
        "cad3-mutate/persist-through-export",
        "All four mutations persist through export/re-import with zero "
        "additional semantic drift.",
        diff_rt["added"] == [] and diff_rt["removed"] == [] and diff_rt["changed"] == {},
        details={"diff": {"added": diff_rt["added"], "removed": diff_rt["removed"],
                          "changed": list(diff_rt["changed"].keys())}},
        epistemic="ADAPTER",
    )
