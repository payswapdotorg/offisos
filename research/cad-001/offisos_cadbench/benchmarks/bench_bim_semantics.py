"""Benchmark: BIM semantics (RESEARCH-CAD-001 evidence item 4).

Creation and read-back of representative IFC building elements and
relationships through the IfcOpenShell adapter: walls, slab, spaces,
door/window fillings, voids relationships, property sets and quantity
sets, with exact count assertions against FIX-BIM-SMALL.
"""
from __future__ import annotations

from ..fixtures import SMALL_BUILDING, SMALL_EXPECTED, SMALL_SPACE, SMALL_WALLS


def build_small_model(adapter, model_id: str):
    model = adapter.create_model(model_id)
    for i, wall in enumerate(SMALL_WALLS):
        adapter.add_wall(
            model,
            f"el:wall-{i:02d}",
            wall.id,
            wall.x0, wall.y0, wall.x1, wall.y1,
            wall.height, wall.thickness,
            openings=[
                {
                    "kind": o.kind,
                    "x": o.x,
                    "width": o.width,
                    "height": o.height,
                    "sill": o.sill,
                }
                for o in wall.openings
            ],
            properties={
                "FireRating": "REI60" if i % 2 == 0 else "REI30",
                "IsExternal": True,
                "LoadBearing": i < 2,
            },
        )
    adapter.add_slab(
        model, "el:slab-00", "Ground slab",
        SMALL_BUILDING["width"], SMALL_BUILDING["length"],
        SMALL_BUILDING["slab"]["thickness"],
    )
    adapter.add_space(
        model, "el:space-101", SMALL_SPACE["name"],
        SMALL_BUILDING["width"] - 0.6, SMALL_BUILDING["length"] - 0.6,
        properties={"LongName": SMALL_SPACE["long_name"]},
    )
    return model


def run(result) -> None:
    from ..engines.ifc_adapter import IfcOpenShellAdapter

    adapter = IfcOpenShellAdapter()
    model = build_small_model(adapter, "bim-small")

    # ------------------------------------------------------------------
    # 1. Element counts by kind (exact fixture expectations)
    # ------------------------------------------------------------------
    kinds: dict[str, int] = {}
    for e in model.elements:
        kinds[e.kind] = kinds.get(e.kind, 0) + 1
    result.observe(
        "bim/elements/wall-count",
        f"Model contains exactly {SMALL_EXPECTED['wall_count']} walls.",
        kinds.get("wall", 0) == SMALL_EXPECTED["wall_count"],
        details={"counts": kinds}, epistemic="NATIVE",
    )
    result.observe(
        "bim/elements/slab-count",
        f"Model contains exactly {SMALL_EXPECTED['slab_count']} slab.",
        kinds.get("slab", 0) == SMALL_EXPECTED["slab_count"], epistemic="NATIVE",
    )
    result.observe(
        "bim/elements/space-count",
        f"Model contains exactly {SMALL_EXPECTED['space_count']} space.",
        kinds.get("space", 0) == SMALL_EXPECTED["space_count"], epistemic="NATIVE",
    )
    result.observe(
        "bim/elements/door-window-counts",
        f"Doors={SMALL_EXPECTED['door_count']}, windows={SMALL_EXPECTED['window_count']} as fillings.",
        kinds.get("door", 0) == SMALL_EXPECTED["door_count"]
        and kinds.get("window", 0) == SMALL_EXPECTED["window_count"],
        epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 2. Relationships: voids + fills
    # ------------------------------------------------------------------
    voids = [r for r in model.relationships if r["type"] == "voids"]
    fills = [r for r in model.relationships if r["type"] == "fills"]
    result.observe(
        "bim/relationships/voids-count",
        f"Voids relationships match opening count ({SMALL_EXPECTED['opening_count']}).",
        len(voids) == SMALL_EXPECTED["opening_count"],
        details={"voids": len(voids)}, epistemic="NATIVE",
    )
    result.observe(
        "bim/relationships/fills-count",
        "Fills relationships match door+window count (3).",
        len(fills) == SMALL_EXPECTED["door_count"] + SMALL_EXPECTED["window_count"],
        details={"fills": len(fills)}, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 3. Properties survive a round trip with values and types
    # ------------------------------------------------------------------
    adapter.export_ifc(model, "/tmp/bim-small.ifc")
    m2 = adapter.import_ifc("/tmp/bim-small.ifc", "bim-small-rt")
    walls = [e for e in m2.elements if e.kind == "wall"]
    wall0 = next(w for w in walls if w.name == "wall-north")
    result.observe(
        "bim/properties/string-roundtrip",
        "IfcLabel property FireRating round-trips exactly.",
        wall0.properties.get("FireRating") == "REI60",
        details={"observed": wall0.properties.get("FireRating")}, epistemic="NATIVE",
    )
    result.observe(
        "bim/properties/boolean-roundtrip",
        "IfcBoolean property IsExternal round-trips as True.",
        wall0.properties.get("IsExternal") is True,
        details={"observed": wall0.properties.get("IsExternal")}, epistemic="NATIVE",
    )
    load_bearing_values = sorted(
        {str(w.properties.get("LoadBearing")) for w in walls}
    )
    result.observe(
        "bim/properties/boolean-discrimination",
        "Boolean False values are preserved distinctly from True (no lossy coercion).",
        load_bearing_values == ["False", "True"],
        details={"distinct_values": load_bearing_values}, epistemic="NATIVE",
    )

    space = next((e for e in m2.elements if e.kind == "space"), None)
    result.observe(
        "bim/properties/space-longname",
        "Space LongName property survives the round trip.",
        space is not None and space.properties.get("LongName") == SMALL_SPACE["long_name"],
        details={"observed": space.properties.get("LongName") if space else None},
        epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 4. Spatial containment (IfcRelContainedInSpatialStructure)
    # ------------------------------------------------------------------
    import ifcopenshell

    f = ifcopenshell.open("/tmp/bim-small.ifc")
    contained = f.by_type("IfcRelContainedInSpatialStructure")
    contained_elements = {
        el for rel in contained for el in (rel.RelatedElements or [])
    }
    walls_in_storey = sum(1 for el in contained_elements if el.is_a("IfcWall"))
    result.observe(
        "bim/spatial/containment",
        "Every wall is contained in a building storey via IfcRelContainedInSpatialStructure.",
        walls_in_storey == SMALL_EXPECTED["wall_count"],
        details={"walls_in_storey": walls_in_storey}, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 5. Placements: wall object placements read back exactly
    # ------------------------------------------------------------------
    import ifcopenshell.util.placement as ifc_placement

    wall_north = next(w for w in f.by_type("IfcWall") if w.Name == "wall-north")
    matrix = ifc_placement.get_local_placement(wall_north.ObjectPlacement)
    # fixture places wall-north at (0, 5, 0); project length unit is METRE
    # (pinned by the adapter; see the units-consistency finding below)
    result.observe(
        "bim/placement/readback",
        "Wall placement matrix reads back with exact translation components (metres).",
        abs(matrix[0][3] - 0.0) <= 1e-9 and abs(matrix[1][3] - 5.0) <= 1e-9,
        details={"translation": (float(matrix[0][3]), float(matrix[1][3]), float(matrix[2][3]))},
        epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 5b. Units consistency finding: default project unit vs API units
    # ------------------------------------------------------------------
    length_units = [
        u for u in f.by_type("IfcUnitAssignment")[0].Units
        if u.is_a("IfcSIUnit") and u.UnitType == "LENGTHUNIT"
    ]
    unit_is_metre = (
        len(length_units) == 1
        and length_units[0].Name == "METRE"
        and not length_units[0].Prefix
    )
    result.observe(
        "bim/units/length-unit-metre",
        "Adapter pins the project length unit to METRE so representation "
        "geometry, placements and quantities share one unit system. "
        "FINDING: ifcopenshell's default (unpinned) length unit is MILLIMETRE "
        "while its geometry/placement APIs take metres — an interoperability "
        "trap the adapter must handle explicitly.",
        unit_is_metre,
        details={"length_unit": str(length_units[0]) if length_units else "none"},
        epistemic="OBSERVED",
    )
    # the wall representation extrusion depth (height) is stored in metres
    rep = wall_north.Representation.Representations[0]
    result.assert_close(
        "bim/units/representation-geometry-metres",
        "Wall representation extrusion depth equals the fixture height (3.0 m) "
        "in file units.",
        float(rep.Items[0].Depth), 3.0, 1e-9, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 6. Door/window OverallWidth/OverallHeight native attributes
    # ------------------------------------------------------------------
    doors = f.by_type("IfcDoor")
    windows = f.by_type("IfcWindow")
    from ..fixtures import DOOR_HEIGHT, DOOR_WIDTH, WINDOW_HEIGHT, WINDOW_WIDTH

    result.observe(
        "bim/door/overall-dimensions",
        "IfcDoor OverallWidth/OverallHeight native attributes read back exactly.",
        len(doors) == 1
        and abs(doors[0].OverallWidth - DOOR_WIDTH) <= 1e-9
        and abs(doors[0].OverallHeight - DOOR_HEIGHT) <= 1e-9,
        details={"doors": [(d.OverallWidth, d.OverallHeight) for d in doors]},
        epistemic="NATIVE",
    )
    result.observe(
        "bim/window/overall-dimensions",
        "IfcWindow OverallWidth/OverallHeight native attributes read back exactly.",
        len(windows) == 2
        and all(abs(w.OverallWidth - WINDOW_WIDTH) <= 1e-9 for w in windows)
        and all(abs(w.OverallHeight - WINDOW_HEIGHT) <= 1e-9 for w in windows),
        details={"windows": [(w.OverallWidth, w.OverallHeight) for w in windows]},
        epistemic="NATIVE",
    )

    result.measure("element_count_total", len(m2.elements))
    result.measure("ifc_schema", f.schema)
