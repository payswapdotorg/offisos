"""Benchmark: quantity extraction (RESEARCH-CAD-001 evidence item 6).

Reproduce deterministic quantities from representative BIM fixtures with
numerical assertions:

- OCCT BRep-calculated quantities vs analytic fixture expectations (exact);
- quantity-set values observed after IFC round trip vs calculated values;
- sum checks over the small building;
- determinism (two runs -> identical values);
- UNKNOWN epistemic state for elements without a quantity basis (never 0).
"""
from __future__ import annotations

from ..fixtures import (
    OPENINGS_EXPECTED,
    OPENINGS_WALL,
    SMALL_EXPECTED,
    WALL_HEIGHT,
    WALL_THICKNESS,
)
from .bench_bim_semantics import build_small_model


def run(result) -> None:
    from ..engines.ifc_adapter import IfcOpenShellAdapter

    adapter = IfcOpenShellAdapter()

    # ------------------------------------------------------------------
    # 1. FIX-OPENINGS: OCCT BRep quantities vs analytic expectations
    # ------------------------------------------------------------------
    model = adapter.create_model("qty-openings")
    o = OPENINGS_WALL.openings
    wall = adapter.add_wall(
        model, "el:qty-wall", "Quantity wall",
        0.0, 0.0, 6.0, 0.0, WALL_HEIGHT, WALL_THICKNESS,
        openings=[
            {"kind": "door", "x": 1.5, "width": 1.0, "height": 2.1, "sill": 0.0},
            {"kind": "window", "x": 4.0, "width": 1.2, "height": 1.5, "sill": 0.9},
        ],
    )
    q = wall.domain_quantities
    result.assert_close(
        "qty/brep/gross-volume",
        "OCCT BRep gross volume equals the analytic fixture value (5.4 m^3).",
        q["GrossVolume"].value, OPENINGS_EXPECTED["gross_volume"], 1e-9,
        details={"state": q["GrossVolume"].state}, epistemic="NATIVE",
    )
    result.assert_close(
        "qty/brep/net-volume",
        "OCCT BRep net volume (boolean cut) equals analytic value (4.23 m^3).",
        q["NetVolume"].value, OPENINGS_EXPECTED["net_volume"], 1e-9,
        details={"state": q["NetVolume"].state}, epistemic="NATIVE",
    )
    result.assert_close(
        "qty/brep/openings-volume",
        "OCCT BRep openings volume = gross - net = 1.17 m^3 exactly.",
        q["OpeningsVolume"].value,
        OPENINGS_EXPECTED["door_volume"] + OPENINGS_EXPECTED["window_volume"],
        1e-9, epistemic="NATIVE",
    )
    result.assert_close(
        "qty/brep/net-side-area",
        "Net side area equals gross side area minus opening rectangles (14.1 m^2).",
        q["NetSideArea"].value, OPENINGS_EXPECTED["net_side_area"], 1e-9,
        epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 2. Determinism: recreate and compare
    # ------------------------------------------------------------------
    model_b = adapter.create_model("qty-openings-2")
    wall_b = adapter.add_wall(
        model_b, "el:qty-wall", "Quantity wall",
        0.0, 0.0, 6.0, 0.0, WALL_HEIGHT, WALL_THICKNESS,
        openings=[
            {"kind": "door", "x": 1.5, "width": 1.0, "height": 2.1, "sill": 0.0},
            {"kind": "window", "x": 4.0, "width": 1.2, "height": 1.5, "sill": 0.9},
        ],
    )
    identical = all(
        q[k].value == wall_b.domain_quantities[k].value for k in q
    )
    result.observe(
        "qty/determinism/identical-reruns",
        "Quantity extraction is deterministic: two runs produce identical values.",
        identical,
        details={k: q[k].value for k in ("GrossVolume", "NetVolume")},
        epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 3. Small building sum checks
    # ------------------------------------------------------------------
    small = build_small_model(adapter, "qty-small")
    walls = [e for e in small.elements if e.kind == "wall"]
    gross_sum = sum(e.domain_quantities["GrossVolume"].value for e in walls)
    net_sum = sum(e.domain_quantities["NetVolume"].value for e in walls)
    result.assert_close(
        "qty/sums/wall-gross-volume",
        "Sum of wall gross volumes equals the analytic fixture sum (23.4 m^3).",
        gross_sum, SMALL_EXPECTED["wall_gross_volume_sum"], 1e-9, epistemic="NATIVE",
    )
    result.assert_close(
        "qty/sums/wall-net-volume",
        "Sum of wall net volumes equals the analytic fixture sum (21.69 m^3).",
        net_sum, SMALL_EXPECTED["wall_net_volume_sum"], 1e-9, epistemic="NATIVE",
    )
    slab = next(e for e in small.elements if e.kind == "slab")
    result.assert_close(
        "qty/sums/slab-volume",
        "Slab volume equals the analytic fixture value (10.0 m^3).",
        slab.domain_quantities["GrossVolume"].value,
        SMALL_EXPECTED["slab_volume"], 1e-9, epistemic="NATIVE",
    )
    space = next(e for e in small.elements if e.kind == "space")
    result.assert_close(
        "qty/sums/space-area",
        "Space gross floor area equals the fixture footprint area.",
        space.domain_quantities["GrossFloorArea"].value,
        (8.0 - 0.6) * (5.0 - 0.6), 1e-9, epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 4. Round-trip: OBSERVED quantities equal CALCULATED quantities
    # ------------------------------------------------------------------
    adapter.export_ifc(small, "/tmp/qty-small.ifc")
    rt = adapter.import_ifc("/tmp/qty-small.ifc", "qty-small-rt")
    rt_wall = next(
        e for e in rt.elements if e.kind == "wall" and e.name == "wall-south"
    )
    created_wall = next(e for e in small.elements if e.name == "wall-south")
    result.assert_close(
        "qty/roundtrip/observed-equals-calculated",
        "OBSERVED (round-tripped) NetVolume equals the CALCULATED (BRep) value exactly.",
        rt_wall.domain_quantities["NetVolume"].value,
        created_wall.domain_quantities["NetVolume"].value,
        1e-9,
        details={
            "observed_state": rt_wall.domain_quantities["NetVolume"].state,
            "calculated_state": created_wall.domain_quantities["NetVolume"].state,
        },
        epistemic="NATIVE",
    )

    # ------------------------------------------------------------------
    # 5. UNKNOWN for elements without a quantity basis
    # ------------------------------------------------------------------
    import ifcopenshell
    import ifcopenshell.api

    f = ifcopenshell.api.run("project.create_file", version="IFC4")
    project = ifcopenshell.api.run(
        "root.create_entity", f, ifc_class="IfcProject", name="Ghost Project"
    )
    ifcopenshell.api.run("unit.assign_unit", f)
    site = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSite", name="S")
    building = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuilding", name="B")
    storey = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuildingStorey", name="G")
    ifcopenshell.api.run("aggregate.assign_object", f, products=[site], relating_object=project)
    ifcopenshell.api.run("aggregate.assign_object", f, products=[building], relating_object=site)
    ifcopenshell.api.run("aggregate.assign_object", f, products=[storey], relating_object=building)
    # a "ghost" wall: no representation, no quantity set
    ghost = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcWall", name="Ghost")
    ifcopenshell.api.run(
        "spatial.assign_container", f, products=[ghost], relating_structure=storey
    )
    f.write("/tmp/ghost.ifc")

    ghost_model = adapter.import_ifc("/tmp/ghost.ifc", "ghost-rt")
    ghost_element = next(e for e in ghost_model.elements if e.kind == "wall")
    adapter.extract_quantities(ghost_model)
    gq = ghost_element.domain_quantities.get("NetVolume")
    result.observe(
        "qty/unknown/ghost-wall",
        "A wall with no geometry and no quantity set yields UNKNOWN, never a fake 0.",
        gq is not None and gq.state.value == "UNKNOWN" and gq.value is None,
        details={"state": gq.state.value if gq else None, "value": gq.value if gq else None},
        epistemic="NATIVE",
    )
