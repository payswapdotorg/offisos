"""Deterministic model-version fixture corpus for RESEARCH-CAD-004.

Three controlled model versions plus a mixed-unit variant of v1:

- **v1**: base model — 4 exterior walls (north with 1 window, south with
  1 door + 1 window, east, west), ground slab, 2 spaces. All elements
  carry Offisos domain identities via Pset_OffisosIdentity and analytic
  quantity sets (Qto_*).
- **v2**: ONE controlled geometry change — wall-north Height 3.0 -> 3.5.
- **v3**: TWO controlled changes — window-south width 1.2 -> 1.5
  (geometry, affects the window and its host wall quantities) AND
  wall-east FireRating REI90 -> REI120 (property-only: must produce NO
  quantity delta — the negative control for change propagation).
- **v1-mm**: the v1 model authored with MILLIMETRE project units
  (ifcopenshell's default) — the mixed-unit conversion demonstration.

Expected quantities are declared analytically so every benchmark
assertion is numeric and reproducible. No randomness anywhere.
"""
from __future__ import annotations

from typing import Any

import ifcopenshell
import ifcopenshell.api

IDENTITY_PSET = "Pset_OffisosIdentity"

WALL_HEIGHT = 3.0
WALL_THICKNESS = 0.3
SLAB_THICKNESS = 0.25
# Deterministic parameter for CALCULATED weight quantities (concrete).
CONCRETE_DENSITY_KG_M3 = 2400.0

BASE_MODEL = {"width": 10.0, "length": 8.0}


def _walls_for(version: str) -> list[dict[str, Any]]:
    """Wall fixture spec for a model version (controlled changes applied)."""
    north_height = 3.5 if version in ("v2", "v3") else 3.0
    # v3: south window widened 1.2 -> 1.5 (affects window + host wall)
    south_window_width = 1.5 if version == "v3" else 1.2
    east_fire_rating = "REI120" if version == "v3" else "REI90"
    return [
        {
            "domain_id": "off:cad4:wall:north", "name": "wall-north",
            "x0": 0.0, "y0": 8.0, "x1": 10.0, "y1": 8.0,
            "height": north_height,
            "openings": [
                {"kind": "window", "x": 5.0, "width": 1.2, "height": 1.5, "sill": 0.9},
            ],
            "fire_rating": "REI60", "external": True,
        },
        {
            "domain_id": "off:cad4:wall:south", "name": "wall-south",
            "x0": 0.0, "y0": 0.0, "x1": 10.0, "y1": 0.0,
            "height": WALL_HEIGHT,
            "openings": [
                {"kind": "door", "x": 2.0, "width": 1.0, "height": 2.1, "sill": 0.0},
                {"kind": "window", "x": 6.5, "width": south_window_width, "height": 1.5, "sill": 0.9},
            ],
            "fire_rating": "REI60", "external": True,
        },
        {
            "domain_id": "off:cad4:wall:east", "name": "wall-east",
            "x0": 10.0, "y0": 0.0, "x1": 10.0, "y1": 8.0,
            "height": WALL_HEIGHT, "openings": [],
            "fire_rating": east_fire_rating, "external": True,
        },
        {
            "domain_id": "off:cad4:wall:west", "name": "wall-west",
            "x0": 0.0, "y0": 0.0, "x1": 0.0, "y1": 8.0,
            "height": WALL_HEIGHT, "openings": [],
            "fire_rating": "REI90", "external": True,
        },
    ]


SPACES = [
    {"domain_id": "off:cad4:space:living", "name": "Living Room",
     "long_name": "LIVING", "length": 9.4, "width": 7.4, "placement": (0.3, 0.3)},
    {"domain_id": "off:cad4:space:bedroom", "name": "Bedroom",
     "long_name": "BEDROOM", "length": 9.4, "width": 0.3, "placement": (0.3, 7.7)},
]
# NOTE: bedroom kept as a slim circulation strip so areas stay analytic
# and independent of wall-net geometry (fixture determinism).
SPACES = [
    {"domain_id": "off:cad4:space:living", "name": "Living Room",
     "long_name": "LIVING", "length": 9.4, "width": 7.4, "placement": (0.3, 0.3)},
]

VERSIONS = ("v1", "v2", "v3")


# ---------------------------------------------------------------------------
# Analytic expectations (CALCULATED ground truth)
# ---------------------------------------------------------------------------

def wall_length(w: dict[str, Any]) -> float:
    return ((w["x1"] - w["x0"]) ** 2 + (w["y1"] - w["y0"]) ** 2) ** 0.5


def wall_gross_volume(w: dict[str, Any]) -> float:
    return wall_length(w) * WALL_THICKNESS * w["height"]


def wall_openings_volume(w: dict[str, Any]) -> float:
    return sum(o["width"] * o["height"] * WALL_THICKNESS for o in w["openings"])


def wall_net_volume(w: dict[str, Any]) -> float:
    return wall_gross_volume(w) - wall_openings_volume(w)


def wall_gross_side_area(w: dict[str, Any]) -> float:
    return wall_length(w) * w["height"]


def wall_net_side_area(w: dict[str, Any]) -> float:
    return wall_gross_side_area(w) - sum(o["width"] * o["height"] for o in w["openings"])


def expected_quantities(version: str) -> dict[str, dict[str, float]]:
    """Full analytic quantity expectation per element domain id."""
    out: dict[str, dict[str, float]] = {}
    for w in _walls_for(version):
        q = {
            "Length": wall_length(w),
            "Height": w["height"],
            "Width": WALL_THICKNESS,
            "GrossVolume": wall_gross_volume(w),
            "NetVolume": wall_net_volume(w),
            "OpeningsVolume": wall_openings_volume(w),
            "GrossSideArea": wall_gross_side_area(w),
            "NetSideArea": wall_net_side_area(w),
            "OpeningCount": float(len(w["openings"])),
            "Weight": wall_net_volume(w) * CONCRETE_DENSITY_KG_M3,
        }
        out[w["domain_id"]] = q
        for i, o in enumerate(w["openings"]):
            out[f"{w['domain_id']}:{o['kind']}-{i + 1}"] = {
                "OverallWidth": o["width"],
                "OverallHeight": o["height"],
                "OverallArea": o["width"] * o["height"],
            }
    out["off:cad4:slab:ground"] = {
        "GrossVolume": BASE_MODEL["width"] * BASE_MODEL["length"] * SLAB_THICKNESS,
        "Weight": BASE_MODEL["width"] * BASE_MODEL["length"] * SLAB_THICKNESS
        * CONCRETE_DENSITY_KG_M3,
    }
    for s in SPACES:
        out[s["domain_id"]] = {
            "GrossFloorArea": s["length"] * s["width"],
            "Perimeter": 2.0 * (s["length"] + s["width"]),
        }
    return out


EXPECTED = {
    "v1": expected_quantities("v1"),
    "v2": expected_quantities("v2"),
    "v3": expected_quantities("v3"),
}

# v2 -> v3: south window width 1.2 -> 1.5 (geometry; affects the window
# and its host wall) + wall-east FireRating REI90 -> REI120 (property-only:
# NO quantity delta — the negative control)
_window_delta_area = (1.5 - 1.2) * 1.5
DELTA_V2_V3 = {
    "off:cad4:wall:south:window-2": {
        "OverallWidth": 0.3,
        "OverallArea": _window_delta_area,
    },
    "off:cad4:wall:south": {
        "NetVolume": -_window_delta_area * WALL_THICKNESS,
        "BRepNetVolume": -_window_delta_area * WALL_THICKNESS,
        "NetSideArea": -_window_delta_area,
        "BRepWeight": -_window_delta_area * WALL_THICKNESS * CONCRETE_DENSITY_KG_M3,
    },
}
# v1 -> v2: wall-north height 3.0 -> 3.5 (all length/area/volume/mass
# measures of that wall shift exactly)
_north = _walls_for("v2")[0]
_height_delta = 0.5
DELTA_V1_V2 = {
    "off:cad4:wall:north": {
        "Height": _height_delta,
        "GrossVolume": wall_length(_north) * WALL_THICKNESS * _height_delta,
        "NetVolume": wall_length(_north) * WALL_THICKNESS * _height_delta,
        "BRepGrossVolume": wall_length(_north) * WALL_THICKNESS * _height_delta,
        "BRepNetVolume": wall_length(_north) * WALL_THICKNESS * _height_delta,
        "GrossSideArea": wall_length(_north) * _height_delta,
        "NetSideArea": wall_length(_north) * _height_delta,
        "BRepWeight": wall_length(_north) * WALL_THICKNESS * _height_delta
        * CONCRETE_DENSITY_KG_M3,
    }
}


# ---------------------------------------------------------------------------
# Fixture authoring
# ---------------------------------------------------------------------------

def _add_pset(f, product, name: str, properties: dict[str, Any]) -> None:
    pset = ifcopenshell.api.run("pset.add_pset", f, product=product, name=name)
    ifcopenshell.api.run("pset.edit_pset", f, pset=pset, properties=dict(properties))


def _add_qto(f, product, name: str, quantities: dict[str, float]) -> None:
    qto = ifcopenshell.api.run("pset.add_qto", f, product=product, name=name)
    ifcopenshell.api.run(
        "pset.edit_qto", f, qto=qto,
        properties={k: float(v) for k, v in quantities.items()},
    )


def build_model(version: str, unit: str = "METRE") -> ifcopenshell.file:
    """Build the fixture for a model version.

    ``unit`` selects the project length unit: "METRE" (pinned) or
    "MILLIMETRE" (the ifcopenshell default — the mixed-unit variant).
    """
    f = ifcopenshell.api.run("project.create_file", version="IFC4")
    project = ifcopenshell.api.run(
        "root.create_entity", f, ifc_class="IfcProject", name=f"Offisos CAD-004 {version}"
    )
    if unit == "MILLIMETRE":
        ifcopenshell.api.run("unit.assign_unit", f)  # engine default: MILLIMETRE
    else:
        ifcopenshell.api.run(
            "unit.assign_unit", f, length={"is_metric": True, "raw": "METERS"}
        )
    ctx = ifcopenshell.api.run("context.add_context", f, context_type="Model")
    body = ifcopenshell.api.run(
        "context.add_context", f, context_type="Model",
        context_identifier="Body", target_view="MODEL_VIEW", parent=ctx,
    )
    site = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSite", name="Site")
    building = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuilding", name="Building")
    storey = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuildingStorey", name="Storey 0")
    ifcopenshell.api.run("aggregate.assign_object", f, products=[site], relating_object=project)
    ifcopenshell.api.run("aggregate.assign_object", f, products=[building], relating_object=site)
    ifcopenshell.api.run("aggregate.assign_object", f, products=[storey], relating_object=building)

    from ifcopenshell.util.shape_builder import ShapeBuilder
    import numpy as np

    builder = ShapeBuilder(f)

    # TOOLCHAIN FINDING (recorded in report.md): ifcopenshell 0.8.5's
    # ShapeBuilder rectangle/extrude/polyline helpers store RAW values
    # without converting API metres to the project unit (unlike
    # geometry.add_wall_representation / add_slab_representation /
    # edit_object_placement, which convert). For an internally consistent
    # MILLIMETRE file, builder inputs must be pre-scaled by the unit factor.
    _uf = 1000.0 if unit == "MILLIMETRE" else 1.0

    for w in _walls_for(version):
        length = wall_length(w)
        wall = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcWall", name=w["name"])
        ifcopenshell.api.run(
            "spatial.assign_container", f, products=[wall], relating_structure=storey
        )
        rep = ifcopenshell.api.run(
            "geometry.add_wall_representation", f, context=body,
            length=length, height=w["height"], thickness=WALL_THICKNESS,
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", f, product=wall, representation=rep
        )
        vertical = abs(w["x1"] - w["x0"]) < 1e-12
        if vertical:
            # rotate 90 deg about Z: local +X (profile length) -> world +Y,
            # local +Y (thickness) -> world -X
            placement_matrix = (
                (0.0, -1.0, 0.0, w["x0"]),
                (1.0, 0.0, 0.0, w["y0"]),
                (0.0, 0.0, 1.0, 0.0),
                (0.0, 0.0, 0.0, 1.0),
            )
        else:
            placement_matrix = (
                (1.0, 0.0, 0.0, w["x0"]),
                (0.0, 1.0, 0.0, w["y0"]),
                (0.0, 0.0, 1.0, 0.0),
                (0.0, 0.0, 0.0, 1.0),
            )
        ifcopenshell.api.run(
            "geometry.edit_object_placement", f, product=wall,
            matrix=placement_matrix,
        )
        _add_pset(f, wall, IDENTITY_PSET, {
            "DomainId": w["domain_id"], "DomainKind": "wall",
            "ModelVersion": version,
        })
        _add_pset(f, wall, "Pset_WallCommon", {
            "FireRating": w["fire_rating"], "IsExternal": w["external"],
        })
        _add_qto(f, wall, "Qto_WallCommon", {
            "Length": length, "Height": w["height"], "Width": WALL_THICKNESS,
            "GrossVolume": wall_gross_volume(w),
            "NetVolume": wall_net_volume(w),
            "GrossSideArea": wall_gross_side_area(w),
            "NetSideArea": wall_net_side_area(w),
            "OpeningsVolume": wall_openings_volume(w),
            "OpeningCount": float(len(w["openings"])),
        })
        for i, o in enumerate(w["openings"]):
            opening = ifcopenshell.api.run(
                "root.create_entity", f, ifc_class="IfcOpeningElement",
                name=f"{w['name']}-op{i + 1}",
            )
            rect = builder.rectangle(
                size=np.array([o["width"] * _uf, o["height"] * _uf])
            )
            item = builder.extrude(
                rect, (WALL_THICKNESS + 0.002) * _uf,
                extrusion_vector=(0.0, 1.0, 0.0),
            )
            rep_o = f.createIfcShapeRepresentation(
                body, "Body", "SweptSolid", item if isinstance(item, list) else [item]
            )
            ifcopenshell.api.run(
                "geometry.assign_representation", f, product=opening, representation=rep_o
            )
            ifcopenshell.api.run(
                "geometry.edit_object_placement", f, product=opening,
                matrix=(
                    (1.0, 0.0, 0.0, o["x"] - o["width"] / 2.0),
                    (0.0, 1.0, 0.0, w["y0"] - 0.001),
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
                    "DomainKind": o["kind"], "ModelVersion": version,
                })

    # ghost wall: identity but NO representation and NO quantity set —
    # the uncertainty demonstration (extraction must yield UNKNOWN, never
    # a fabricated zero)
    ghost = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcWall", name="wall-ghost")
    ifcopenshell.api.run(
        "spatial.assign_container", f, products=[ghost], relating_structure=storey
    )
    _add_pset(f, ghost, IDENTITY_PSET, {
        "DomainId": "off:cad4:wall:ghost", "DomainKind": "wall",
        "ModelVersion": version,
    })

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
            (1.0, 0.0, 0.0, 0.0), (0.0, 1.0, 0.0, 0.0),
            (0.0, 0.0, 1.0, -SLAB_THICKNESS), (0.0, 0.0, 0.0, 1.0),
        ),
    )
    _add_pset(f, slab, IDENTITY_PSET, {
        "DomainId": "off:cad4:slab:ground", "DomainKind": "slab", "ModelVersion": version,
    })
    _add_qto(f, slab, "Qto_SlabCommon", {
        "GrossVolume": 10.0 * 8.0 * SLAB_THICKNESS,
    })

    for s in SPACES:
        space = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSpace", name=s["name"])
        ifcopenshell.api.run(
            "aggregate.assign_object", f, products=[space], relating_object=storey
        )
        polyline = builder.polyline(
            np.array([
                (0.0, 0.0, 0.0), (s["length"] * _uf, 0.0, 0.0),
                (s["length"] * _uf, s["width"] * _uf, 0.0),
                (0.0, s["width"] * _uf, 0.0),
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
                (0.0, 0.0, 1.0, 0.0), (0.0, 0.0, 0.0, 1.0),
            ),
        )
        _add_pset(f, space, IDENTITY_PSET, {
            "DomainId": s["domain_id"], "DomainKind": "space", "ModelVersion": version,
        })
        _add_qto(f, space, "Qto_SpaceCommon", {
            "GrossFloorArea": s["length"] * s["width"],
        })
    return f
