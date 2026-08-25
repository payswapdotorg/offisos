"""Benchmark: the IFC fixture corpus (RESEARCH-CAD-003 scope 1).

Asserts the deterministic fixture itself: entity counts by class,
relationship counts, units, placements, typed properties and quantities
against the analytic EXPECTED values.
"""
from __future__ import annotations


def run(result) -> None:
    from ..fixture import (
        EXPECTED,
        PROJECT_PSET,
        SPACES,
        WALLS,
        build_fixture,
        wall_gross_volume,
        wall_net_volume,
    )
    from ..pipeline import extract_snapshot

    f = build_fixture()
    snap = extract_snapshot(f)

    # ------------------------------------------------------------------
    # 1. Entity counts by class (exact fixture expectations)
    # ------------------------------------------------------------------
    counts: dict[str, int] = {}
    for e in snap["elements"].values():
        counts[e["ifc_class"]] = counts.get(e["ifc_class"], 0) + 1
    result.observe(
        "cad3-fixture/entity-counts",
        "Fixture entity counts match the analytic expectations exactly.",
        counts.get("IfcWall") == EXPECTED["wall_count"]
        and counts.get("IfcSlab") == EXPECTED["slab_count"]
        and counts.get("IfcSpace") == EXPECTED["space_count"]
        and counts.get("IfcDoor") == EXPECTED["door_count"]
        and counts.get("IfcWindow") == EXPECTED["window_count"]
        and counts.get("IfcOpeningElement") == EXPECTED["opening_count"],
        details={"counts": counts}, epistemic="CALCULATED",
    )

    # ------------------------------------------------------------------
    # 2. Relationship counts (containment + aggregation + voids + fills)
    # ------------------------------------------------------------------
    rels = snap["relationships"]
    result.observe(
        "cad3-fixture/relationship-counts",
        "Fixture relationship counts match expectations (voids=4, fills=4, "
        "containment=1 grouped rel, aggregation=4).",
        rels["voids"] == EXPECTED["voids_relationships"]
        and rels["fills"] == EXPECTED["fills_relationships"]
        and rels["containment"] == 1 and rels["aggregation"] == 4,
        details={"relationships": rels}, epistemic="CALCULATED",
    )

    # ------------------------------------------------------------------
    # 3. Units: METRE pinned
    # ------------------------------------------------------------------
    units = snap["units"]
    result.observe(
        "cad3-fixture/units-metre",
        "Project length unit is METRE without prefix (adapter pins it; "
        "ifcopenshell's default is MILLIMETRE — CAD-001 finding).",
        units.get("length", {}).get("name") == "METRE"
        and units.get("length", {}).get("prefix") is None,
        details={"units": units}, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 4. Placements exact (non-trivial positions)
    # ------------------------------------------------------------------
    idx = {e["domain_id"]: e for e in snap["elements"].values() if e["domain_id"]}
    wall_north = idx["off:cad3:wall:north"]
    wall_east = idx["off:cad3:wall:east"]
    space_bed = idx["off:cad3:space:bedroom"]
    result.observe(
        "cad3-fixture/placements-exact",
        "Wall placements read back exactly ((0, 8, 0) north, (10, 0, 0) east) "
        "and the bedroom space sits at its fixture placement (5.15, 0.15).",
        wall_north["placement"] == [0.0, 8.0, 0.0]
        and wall_east["placement"] == [10.0, 0.0, 0.0]
        and space_bed["placement"] == [SPACES[1]["placement"][0], SPACES[1]["placement"][1], 0.0],
        details={"north": wall_north["placement"], "east": wall_east["placement"],
                 "bedroom": space_bed["placement"]},
        epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 5. Typed property values exact (labels, booleans, reals)
    # ------------------------------------------------------------------
    props = wall_north["properties"]
    result.observe(
        "cad3-fixture/property-values",
        "Typed properties read back with value AND type fidelity: "
        "FireRating=REI60 (IfcLabel), IsExternal=True (IfcBoolean), "
        "LoadBearing=True, ThermalTransmittance=0.35 (IfcReal).",
        props.get("Pset_WallCommon.FireRating") == "REI60"
        and props.get("Pset_WallCommon.IsExternal") is True
        and props.get("Pset_WallCommon.LoadBearing") is True
        and abs(props.get("Pset_WallCommon.ThermalTransmittance", 0) - 0.35) <= 1e-12,
        details={"properties": {
            k: v for k, v in props.items() if k.startswith("Pset_WallCommon")
        }}, epistemic="NATIVE",
    )
    custom = {
        k: v for k, v in props.items() if k.startswith(PROJECT_PSET)
    }
    result.observe(
        "cad3-fixture/custom-project-properties",
        "Custom/project property set (PhaseCode/WorkPackage/ZoneIdentifier) "
        "reads back exactly.",
        custom == {
            f"{PROJECT_PSET}.PhaseCode": "PH-001",
            f"{PROJECT_PSET}.WorkPackage": "WP-A2",
            f"{PROJECT_PSET}.ZoneIdentifier": "Z1",
        },
        details={"custom": custom}, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 6. Quantities exact against analytic wall volumes
    # ------------------------------------------------------------------
    gross_sum = sum(e["quantities"]["GrossVolume"] for e in idx.values()
                    if e["ifc_class"] == "IfcWall")
    net_sum = sum(e["quantities"]["NetVolume"] for e in idx.values()
                  if e["ifc_class"] == "IfcWall")
    expected_gross = sum(wall_gross_volume(w) for w in WALLS)
    expected_net = sum(wall_net_volume(w) for w in WALLS)
    result.assert_close(
        "cad3-fixture/wall-gross-volume-sum",
        "Wall GrossVolume sum equals the analytic fixture sum (26.64 m^3).",
        gross_sum, expected_gross, 1e-9,
        details={"sum": gross_sum, "expected": expected_gross}, epistemic="CALCULATED",
    )
    result.assert_close(
        "cad3-fixture/wall-net-volume-sum",
        "Wall NetVolume sum equals the analytic fixture sum.",
        net_sum, expected_net, 1e-9,
        details={"sum": net_sum, "expected": expected_net}, epistemic="CALCULATED",
    )
    slab = idx["off:cad3:slab:ground"]
    result.assert_close(
        "cad3-fixture/slab-volume",
        "Slab GrossVolume equals 10 x 8 x 0.25 = 20.0 m^3.",
        slab["quantities"]["GrossVolume"], EXPECTED["slab_volume"], 1e-9,
        epistemic="CALCULATED",
    )
    area_sum = sum(e["quantities"]["GrossFloorArea"] for e in idx.values()
                   if e["ifc_class"] == "IfcSpace")
    result.assert_close(
        "cad3-fixture/space-area-sum",
        "Space GrossFloorArea sum equals the analytic fixture sum.",
        area_sum, EXPECTED["space_area_sum"], 1e-9, epistemic="CALCULATED",
    )

    # ------------------------------------------------------------------
    # 7. Door/window native attributes exact
    # ------------------------------------------------------------------
    doors = [e for e in snap["elements"].values() if e["ifc_class"] == "IfcDoor"]
    windows = [e for e in snap["elements"].values() if e["ifc_class"] == "IfcWindow"]
    result.observe(
        "cad3-fixture/filling-dimensions",
        "Doors report OverallWidth/Height exactly (1.0/2.1 and 0.9/2.1); "
        "windows exactly (1.2/1.5 both).",
        all(d["overall_width"] in (1.0, 0.9) and d["overall_height"] == 2.1 for d in doors)
        and all(w["overall_width"] == 1.2 and w["overall_height"] == 1.5 for w in windows),
        details={"doors": [(d["name"], d["overall_width"], d["overall_height"]) for d in doors],
                 "windows": [(w["name"], w["overall_width"], w["overall_height"]) for w in windows]},
        epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 8. Fixture regeneration determinism (two builds, same semantics)
    # ------------------------------------------------------------------
    f_b = build_fixture()
    snap_b = extract_snapshot(f_b)

    def domain_keyed_semantics(snapshot):
        # global ids are per-build by design (proven unstable in
        # bench_cg_mapping); semantic determinism excludes them
        return {
            e["domain_id"]: {k: v for k, v in e.items() if k != "global_id"}
            for e in snapshot["elements"].values() if e["domain_id"]
        }

    semantics_equal = (
        domain_keyed_semantics(snap) == domain_keyed_semantics(snap_b)
        and snap["relationships"] == snap_b["relationships"]
        and snap["units"] == snap_b["units"]
    )
    result.observe(
        "cad3-fixture/regeneration-determinism",
        "Two independent fixture builds produce identical SEMANTIC "
        "snapshots (identities, classes, properties, quantities, "
        "placements, relationships, units) — engine GlobalIds differ per "
        "build by design, which is the engine-id non-canonicality proof "
        "in bench_cg_mapping.",
        semantics_equal,
        details={"semantic_fields_identical": semantics_equal,
                 "excluded_field": "global_id (per-build)"},
        epistemic="OBSERVED",
    )
