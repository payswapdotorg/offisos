"""Deterministic IFC fixture corpus for RESEARCH-CAD-003 (issue #3 scope 1).

Builds the representative architectural model with fixed parameters (no
randomness): 6 walls (2 with openings: 1 door + 2 windows), 1 slab, 2
spaces, typed property sets (including custom/project properties and the
Pset_OffisosIdentity domain identity), quantity sets, non-trivial
placements, METRE units pinned, containment + aggregation + voids + fills
relationships.

Analytic expectations are declared alongside the fixture so every
benchmark assertion is numeric and reproducible.
"""
from __future__ import annotations

from typing import Any

import ifcopenshell
import ifcopenshell.api

IDENTITY_PSET = "Pset_OffisosIdentity"

WALL_HEIGHT = 3.0
WALL_THICKNESS = 0.3
SLAB_THICKNESS = 0.25
STOREY_ELEVATION = 0.0

# Wall fixture: (domain_id, name, x0, y0, x1, y1, openings, fire_rating)
WALLS: list[dict[str, Any]] = [
    {
        "domain_id": "off:cad3:wall:north",
        "name": "wall-north",
        "x0": 0.0, "y0": 8.0, "x1": 10.0, "y1": 8.0,
        "openings": [
            {"kind": "window", "x": 5.0, "width": 1.2, "height": 1.5, "sill": 0.9},
        ],
        "fire_rating": "REI60",
        "external": True,
    },
    {
        "domain_id": "off:cad3:wall:south",
        "name": "wall-south",
        "x0": 0.0, "y0": 0.0, "x1": 10.0, "y1": 0.0,
        "openings": [
            {"kind": "door", "x": 2.0, "width": 1.0, "height": 2.1, "sill": 0.0},
            {"kind": "window", "x": 6.5, "width": 1.2, "height": 1.5, "sill": 0.9},
        ],
        "fire_rating": "REI60",
        "external": True,
    },
    {
        "domain_id": "off:cad3:wall:east",
        "name": "wall-east",
        "x0": 10.0, "y0": 0.0, "x1": 10.0, "y1": 8.0,
        "openings": [],
        "fire_rating": "REI90",
        "external": True,
    },
    {
        "domain_id": "off:cad3:wall:west",
        "name": "wall-west",
        "x0": 0.0, "y0": 0.0, "x1": 0.0, "y1": 8.0,
        "openings": [],
        "fire_rating": "REI90",
        "external": True,
    },
    {
        "domain_id": "off:cad3:wall:interior-1",
        "name": "wall-interior-1",
        "x0": 5.0, "y0": 0.0, "x1": 5.0, "y1": 8.0,
        "openings": [
            {"kind": "door", "x": 4.0, "width": 0.9, "height": 2.1, "sill": 0.0},
        ],
        "fire_rating": "REI30",
        "external": False,
    },
    {
        "domain_id": "off:cad3:wall:interior-2",
        "name": "wall-interior-2",
        "x0": 5.0, "y0": 4.0, "x1": 10.0, "y1": 4.0,
        "openings": [],
        "fire_rating": "REI30",
        "external": False,
    },
]

SPACES: list[dict[str, Any]] = [
    {
        "domain_id": "off:cad3:space:living",
        "name": "Living Room",
        "long_name": "LIVING",
        "length": 4.7,
        "width": 7.7,
        "placement": (0.15, 0.15),
    },
    {
        "domain_id": "off:cad3:space:bedroom",
        "name": "Bedroom",
        "long_name": "BEDROOM",
        "length": 4.7,
        "width": 3.7,
        "placement": (5.15, 0.15),
    },
]

# Custom/project property set carried by every wall (scope 1:
# "representative custom/project properties").
PROJECT_PSET = "Pset_OffisosProject"
PROJECT_PROPERTIES = {
    "PhaseCode": "PH-001",
    "WorkPackage": "WP-A2",
    "ZoneIdentifier": "Z1",
}


def wall_length(w: dict[str, Any]) -> float:
    return ((w["x1"] - w["x0"]) ** 2 + (w["y1"] - w["y0"]) ** 2) ** 0.5


def wall_gross_volume(w: dict[str, Any]) -> float:
    return wall_length(w) * WALL_THICKNESS * WALL_HEIGHT


def wall_openings_volume(w: dict[str, Any]) -> float:
    return sum(o["width"] * o["height"] * WALL_THICKNESS for o in w["openings"])


def wall_net_volume(w: dict[str, Any]) -> float:
    return wall_gross_volume(w) - wall_openings_volume(w)


EXPECTED = {
    "wall_count": 6,
    "slab_count": 1,
    "space_count": 2,
    "door_count": 2,
    "window_count": 2,
    "opening_count": 4,
    "voids_relationships": 4,
    "fills_relationships": 4,
    "wall_gross_volume_sum": round(sum(wall_gross_volume(w) for w in WALLS), 9),
    "wall_net_volume_sum": round(sum(wall_net_volume(w) for w in WALLS), 9),
    "slab_volume": 10.0 * 8.0 * SLAB_THICKNESS,
    "space_area_sum": round(
        sum(s["length"] * s["width"] for s in SPACES), 9
    ),
    "length_unit": "METRE",
}


def build_fixture() -> ifcopenshell.file:
    """Build the deterministic fixture file (IFC4, METRE units pinned)."""
    f = ifcopenshell.api.run("project.create_file", version="IFC4")
    project = ifcopenshell.api.run(
        "root.create_entity", f, ifc_class="IfcProject", name="Offisos CAD-003 Fixture"
    )
    # METRE pinned explicitly (CAD-001 finding: default is MILLIMETRE)
    ifcopenshell.api.run(
        "unit.assign_unit", f, length={"is_metric": True, "raw": "METERS"}
    )
    ctx = ifcopenshell.api.run("context.add_context", f, context_type="Model")
    body = ifcopenshell.api.run(
        "context.add_context", f, context_type="Model",
        context_identifier="Body", target_view="MODEL_VIEW", parent=ctx,
    )
    site = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSite", name="Site")
    building = ifcopenshell.api.run(
        "root.create_entity", f, ifc_class="IfcBuilding", name="Building"
    )
    storey = ifcopenshell.api.run(
        "root.create_entity", f, ifc_class="IfcBuildingStorey", name="Storey 0"
    )
    ifcopenshell.api.run("aggregate.assign_object", f, products=[site], relating_object=project)
    ifcopenshell.api.run("aggregate.assign_object", f, products=[building], relating_object=site)
    ifcopenshell.api.run("aggregate.assign_object", f, products=[storey], relating_object=building)
    storey.Elevation = STOREY_ELEVATION

    from ifcopenshell.util.shape_builder import ShapeBuilder

    builder = ShapeBuilder(f)

    for w in WALLS:
        length = wall_length(w)
        wall = ifcopenshell.api.run(
            "root.create_entity", f, ifc_class="IfcWall", name=w["name"]
        )
        ifcopenshell.api.run(
            "spatial.assign_container", f, products=[wall], relating_structure=storey
        )
        representation = ifcopenshell.api.run(
            "geometry.add_wall_representation", f, context=body,
            length=length, height=WALL_HEIGHT, thickness=WALL_THICKNESS,
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", f, product=wall, representation=representation
        )
        ifcopenshell.api.run(
            "geometry.edit_object_placement", f, product=wall,
            matrix=(
                (1.0, 0.0, 0.0, w["x0"]),
                (0.0, 1.0, 0.0, w["y0"]),
                (0.0, 0.0, 1.0, 0.0),
                (0.0, 0.0, 0.0, 1.0),
            ),
        )
        # identity + common + project property sets
        _add_pset(f, wall, IDENTITY_PSET, {
            "DomainId": w["domain_id"],
            "DomainKind": "wall",
            "ModelRevision": "fixture-v1",
        })
        _add_pset(f, wall, "Pset_WallCommon", {
            "FireRating": w["fire_rating"],
            "IsExternal": w["external"],
            "LoadBearing": w["name"] in ("wall-north", "wall-south"),
            "ThermalTransmittance": 0.35,
        })
        _add_pset(f, wall, PROJECT_PSET, dict(PROJECT_PROPERTIES))
        # quantity set
        gross_v = wall_gross_volume(w)
        net_v = wall_net_volume(w)
        _add_qto(f, wall, "Qto_WallCommon", {
            "GrossVolume": gross_v,
            "NetVolume": net_v,
            "GrossSideArea": length * WALL_HEIGHT,
            "NetSideArea": length * WALL_HEIGHT - sum(
                o["width"] * o["height"] for o in w["openings"]
            ),
            "Height": WALL_HEIGHT,
            "Length": length,
            "Width": WALL_THICKNESS,
        })
        # openings (semantic voids) + door/window fillings
        for i, o in enumerate(w["openings"]):
            opening = ifcopenshell.api.run(
                "root.create_entity", f, ifc_class="IfcOpeningElement",
                name=f"{w['name']}-op{i + 1}",
            )
            rect = builder.rectangle(size=__import__("numpy").array([o["width"], o["height"]]))
            item = builder.extrude(rect, WALL_THICKNESS + 0.002, extrusion_vector=(0.0, 1.0, 0.0))
            rep = f.createIfcShapeRepresentation(body, "Body", "SweptSolid", item if isinstance(item, list) else [item])
            ifcopenshell.api.run(
                "geometry.assign_representation", f, product=opening, representation=rep
            )
            ifcopenshell.api.run(
                "geometry.edit_object_placement", f, product=opening,
                matrix=(
                    (1.0, 0.0, 0.0, o["x"] - o["width"] / 2.0),
                    (0.0, 1.0, 0.0, w["y0"] - WALL_THICKNESS / 2.0 - 0.001),
                    (0.0, 0.0, 1.0, o["sill"]),
                    (0.0, 0.0, 0.0, 1.0),
                ),
            )
            ifcopenshell.api.run("feature.add_feature", f, feature=opening, element=wall)
            if o["kind"] in ("door", "window"):
                ifc_class = "IfcDoor" if o["kind"] == "door" else "IfcWindow"
                filling = ifcopenshell.api.run(
                    "root.create_entity", f, ifc_class=ifc_class,
                    name=f"{w['name']}-{o['kind']}-{i + 1}",
                )
                ifcopenshell.api.run(
                    "attribute.edit_attributes", f, product=filling,
                    attributes={"OverallWidth": o["width"], "OverallHeight": o["height"]},
                )
                ifcopenshell.api.run(
                    "spatial.assign_container", f, products=[filling],
                    relating_structure=storey,
                )
                ifcopenshell.api.run("feature.add_filling", f, opening=opening, element=filling)
                _add_pset(f, filling, IDENTITY_PSET, {
                    "DomainId": f"{w['domain_id']}:{o['kind']}-{i + 1}",
                    "DomainKind": o["kind"],
                    "ModelRevision": "fixture-v1",
                })

    # slab
    slab = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSlab", name="slab-ground")
    ifcopenshell.api.run(
        "spatial.assign_container", f, products=[slab], relating_structure=storey
    )
    slab_rep = ifcopenshell.api.run(
        "geometry.add_slab_representation", f, context=body, depth=SLAB_THICKNESS,
        polyline=[(0.0, 0.0), (10.0, 0.0), (10.0, 8.0), (0.0, 8.0)],
    )
    ifcopenshell.api.run(
        "geometry.assign_representation", f, product=slab, representation=slab_rep
    )
    ifcopenshell.api.run(
        "geometry.edit_object_placement", f, product=slab,
        matrix=(
            (1.0, 0.0, 0.0, 0.0),
            (0.0, 1.0, 0.0, 0.0),
            (0.0, 0.0, 1.0, -SLAB_THICKNESS),
            (0.0, 0.0, 0.0, 1.0),
        ),
    )
    _add_pset(f, slab, IDENTITY_PSET, {
        "DomainId": "off:cad3:slab:ground", "DomainKind": "slab", "ModelRevision": "fixture-v1",
    })
    _add_qto(f, slab, "Qto_SlabCommon", {"GrossVolume": EXPECTED["slab_volume"]})

    # spaces (aggregate into the storey per IFC4 spatial semantics)
    for s in SPACES:
        space = ifcopenshell.api.run(
            "root.create_entity", f, ifc_class="IfcSpace", name=s["name"]
        )
        ifcopenshell.api.run(
            "aggregate.assign_object", f, products=[space], relating_object=storey
        )
        polyline = builder.polyline(
            __import__("numpy").array([
                (0.0, 0.0, 0.0), (s["length"], 0.0, 0.0),
                (s["length"], s["width"], 0.0), (0.0, s["width"], 0.0),
            ]),
            closed=True,
        )
        rep = ifcopenshell.api.run(
            "geometry.add_footprint_representation", f, context=body, curves=[polyline],
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", f, product=space, representation=rep
        )
        ifcopenshell.api.run(
            "geometry.edit_object_placement", f, product=space,
            matrix=(
                (1.0, 0.0, 0.0, s["placement"][0]),
                (0.0, 1.0, 0.0, s["placement"][1]),
                (0.0, 0.0, 1.0, 0.0),
                (0.0, 0.0, 0.0, 1.0),
            ),
        )
        _add_pset(f, space, IDENTITY_PSET, {
            "DomainId": s["domain_id"], "DomainKind": "space", "ModelRevision": "fixture-v1",
        })
        _add_pset(f, space, "Pset_SpaceCommon", {"LongName": s["long_name"]})
        _add_qto(f, space, "Qto_SpaceCommon", {
            "GrossFloorArea": s["length"] * s["width"],
        })
    return f


def _add_pset(f, product, name: str, properties: dict[str, Any]) -> None:
    pset = ifcopenshell.api.run("pset.add_pset", f, product=product, name=name)
    ifcopenshell.api.run("pset.edit_pset", f, pset=pset, properties=dict(properties))


def _add_qto(f, product, name: str, quantities: dict[str, float]) -> None:
    qto = ifcopenshell.api.run("pset.add_qto", f, product=product, name=name)
    ifcopenshell.api.run(
        "pset.edit_qto", f, qto=qto, properties={k: float(v) for k, v in quantities.items()}
    )
