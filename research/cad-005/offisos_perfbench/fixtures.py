"""Tiered fixture corpus for RESEARCH-CAD-005.

Three fixture scales per issue #5, all procedurally generated and
deterministic (pure index arithmetic — no RNG anywhere):

- ``small``  — small architectural model: single-storey ring of walls
               with doors/windows, slab, spaces (~40 IfcProducts).
- ``medium`` — medium construction model: 3 storeys, more walls,
               openings on every wall, slab + spaces per storey
               (~250 IfcProducts).
- ``large``  — larger stress model representative of anticipated
               professional use: 20 storeys, 40 walls per storey
               (~2,100 IfcProducts, ~1.6k with geometry).

The same tiers exist for the CAD (OCCT) engine workload (primitive
counts for boolean/tessellation/STEP-IO scaling) and for FreeCAD
FCStd documents (parametric feature counts for open/recompute/save
scaling) — see :mod:`freecad_fixtures` scripts in the runner.

Fixture *definitions* (this module) are committed; the generated files
are written to the evidence working directory at run time and their
SHA256/entity counts recorded, so every measurement is bound to an
exactly describable fixture.

Determinism semantics (CAD-001 finding): IFC GlobalIds are regenerated
per build, so structural determinism is asserted (entity counts,
per-class element counts, geometric totals) rather than byte equality;
byte-level stability is separately measured where it applies (OCCT
geometry results, extraction outputs).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import ifcopenshell
import ifcopenshell.api
import numpy as np
from ifcopenshell.util.shape_builder import ShapeBuilder

IDENTITY_PSET = "Pset_OffisosIdentity"

WALL_THICKNESS = 0.3
STOREY_HEIGHT = 3.0


@dataclass
class IfcTierSpec:
    tier: str
    label: str
    storeys: int
    walls_per_storey: int
    openings_per_wall: int  # 0 = none, 1 = one door or window per wall
    spaces_per_storey: int
    slab: bool = True

    @property
    def expected_products(self) -> int:
        per_storey = (
            self.walls_per_storey
            + self.walls_per_storey * self.openings_per_wall * 2  # opening + fill
            + self.spaces_per_storey
            + (1 if self.slab else 0)
        )
        return per_storey * self.storeys + 4  # project/site/building/storey-root

    def describe(self) -> dict[str, Any]:
        return {
            "tier": self.tier,
            "label": self.label,
            "storeys": self.storeys,
            "walls_per_storey": self.walls_per_storey,
            "openings_per_wall": self.openings_per_wall,
            "spaces_per_storey": self.spaces_per_storey,
            "expected_products": self.expected_products,
        }


IFC_TIERS: dict[str, IfcTierSpec] = {
    "small": IfcTierSpec(
        tier="small", label="small architectural model",
        storeys=1, walls_per_storey=12, openings_per_wall=1,
        spaces_per_storey=4,
    ),
    "medium": IfcTierSpec(
        tier="medium", label="medium construction model",
        storeys=3, walls_per_storey=24, openings_per_wall=1,
        spaces_per_storey=6,
    ),
    "large": IfcTierSpec(
        tier="large",
        label="larger stress model (anticipated professional use)",
        storeys=30, walls_per_storey=50, openings_per_wall=1,
        spaces_per_storey=10,
    ),
}


# ---------------------------------------------------------------------------
# OCCT engine workload tiers (primitive/feature counts)
# ---------------------------------------------------------------------------

@dataclass
class OcctTierSpec:
    tier: str
    primitives: int          # simple solids for boolean chains
    plate_holes: int         # holes in the plate-with-holes stress shape
    cut_pairs: int           # sequential box-cut boolean chain length

    def describe(self) -> dict[str, Any]:
        return {
            "tier": self.tier,
            "primitives": self.primitives,
            "plate_holes": self.plate_holes,
            "cut_pairs": self.cut_pairs,
        }


OCCT_TIERS: dict[str, OcctTierSpec] = {
    "small": OcctTierSpec(tier="small", primitives=24, plate_holes=25, cut_pairs=12),
    "medium": OcctTierSpec(tier="medium", primitives=120, plate_holes=100, cut_pairs=60),
    "large": OcctTierSpec(tier="large", primitives=480, plate_holes=400, cut_pairs=200),
}


# ---------------------------------------------------------------------------
# FreeCAD FCStd workload tiers (parametric feature counts)
# ---------------------------------------------------------------------------

@dataclass
class FcstdTierSpec:
    tier: str
    walls: int          # Part::Box wall features
    opening_cuts: int   # Part::Cut parametric booleans
    edits: int          # features touched per parametric edit run

    def describe(self) -> dict[str, Any]:
        return {
            "tier": self.tier,
            "wall_features": self.walls,
            "opening_cut_features": self.opening_cuts,
            "parametric_edit_features_per_run": self.edits,
        }


FCSTD_TIERS: dict[str, FcstdTierSpec] = {
    "small": FcstdTierSpec(tier="small", walls=20, opening_cuts=10, edits=1),
    "medium": FcstdTierSpec(tier="medium", walls=120, opening_cuts=60, edits=6),
    "large": FcstdTierSpec(tier="large", walls=420, opening_cuts=210, edits=12),
}


# ---------------------------------------------------------------------------
# IFC fixture authoring (cad-004-proven api patterns)
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


def build_ifc_tier(spec: IfcTierSpec) -> ifcopenshell.file:
    """Build the IFC fixture for a tier (IFC4, METRE pinned)."""
    f = ifcopenshell.api.run("project.create_file", version="IFC4")
    project = ifcopenshell.api.run(
        "root.create_entity", f, ifc_class="IfcProject",
        name=f"Offisos CAD-005 {spec.tier}",
    )
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
    ifcopenshell.api.run("aggregate.assign_object", f, products=[site], relating_object=project)
    ifcopenshell.api.run("aggregate.assign_object", f, products=[building], relating_object=site)

    builder = ShapeBuilder(f)

    ring_w = 24.0  # building footprint width  (x)
    ring_l = 16.0  # building footprint length (y)

    for storey_idx in range(spec.storeys):
        storey = ifcopenshell.api.run(
            "root.create_entity", f, ifc_class="IfcBuildingStorey",
            name=f"Storey {storey_idx}",
        )
        ifcopenshell.api.run(
            "aggregate.assign_object", f, products=[storey], relating_object=building
        )
        z = storey_idx * STOREY_HEIGHT

        if spec.slab:
            slab = ifcopenshell.api.run(
                "root.create_entity", f, ifc_class="IfcSlab",
                name=f"Slab {storey_idx}",
            )
            ifcopenshell.api.run(
                "spatial.assign_container", f, products=[slab], relating_structure=storey
            )
            rep = ifcopenshell.api.run(
                "geometry.add_slab_representation", f, context=body,
                depth=0.25,
                polyline=[(0.0, 0.0), (ring_w + 1.0, 0.0),
                          (ring_w + 1.0, ring_l + 1.0), (0.0, ring_l + 1.0)],
            )
            ifcopenshell.api.run(
                "geometry.assign_representation", f, product=slab, representation=rep
            )
            ifcopenshell.api.run(
                "geometry.edit_object_placement", f, product=slab,
                matrix=(
                    (1.0, 0.0, 0.0, -0.5),
                    (0.0, 1.0, 0.0, -0.5),
                    (0.0, 0.0, 1.0, z - 0.25),
                    (0.0, 0.0, 0.0, 1.0),
                ),
            )
            _add_pset(f, slab, IDENTITY_PSET, {
                "DomainId": f"off:cad5:slab:{storey_idx}",
                "DomainKind": "slab", "ModelVersion": f"cad5-{spec.tier}",
            })
            _add_qto(f, slab, "Qto_SlabBaseQuantities", {
                "GrossVolume": (ring_w + 1.0) * (ring_l + 1.0) * 0.25,
            })

        for w_idx in range(spec.walls_per_storey):
            # Alternate the four building faces, axis-aligned, so every
            # wall is a deterministic function of (storey, index).
            face = w_idx % 4
            along = w_idx // 4
            seg_w = ring_w / max(1, spec.walls_per_storey // 4)
            seg_l = ring_l / max(1, spec.walls_per_storey // 4)
            if face == 0:    # north edge, running +x
                x0, y0, length, vertical = along * seg_w, ring_l, seg_w, False
            elif face == 1:  # south edge, running +x
                x0, y0, length, vertical = along * seg_w, 0.0, seg_w, False
            elif face == 2:  # west edge, running +y
                x0, y0, length, vertical = 0.0, along * seg_l, seg_l, True
            else:            # east edge, running +y
                x0, y0, length, vertical = ring_w, along * seg_l, seg_l, True
            wall_name = f"Wall-{storey_idx}-{w_idx:03d}"
            domain_id = f"off:cad5:wall:{storey_idx}:{w_idx:03d}"
            wall = ifcopenshell.api.run(
                "root.create_entity", f, ifc_class="IfcWall", name=wall_name
            )
            ifcopenshell.api.run(
                "spatial.assign_container", f, products=[wall], relating_structure=storey
            )
            rep = ifcopenshell.api.run(
                "geometry.add_wall_representation", f, context=body,
                length=length, height=STOREY_HEIGHT, thickness=WALL_THICKNESS,
            )
            ifcopenshell.api.run(
                "geometry.assign_representation", f, product=wall, representation=rep
            )
            if vertical:
                matrix = (
                    (0.0, -1.0, 0.0, x0),
                    (1.0, 0.0, 0.0, y0),
                    (0.0, 0.0, 1.0, z),
                    (0.0, 0.0, 0.0, 1.0),
                )
            else:
                matrix = (
                    (1.0, 0.0, 0.0, x0),
                    (0.0, 1.0, 0.0, y0),
                    (0.0, 0.0, 1.0, z),
                    (0.0, 0.0, 0.0, 1.0),
                )
            ifcopenshell.api.run(
                "geometry.edit_object_placement", f, product=wall, matrix=matrix
            )
            _add_pset(f, wall, IDENTITY_PSET, {
                "DomainId": domain_id, "DomainKind": "wall",
                "ModelVersion": f"cad5-{spec.tier}",
            })
            _add_pset(f, wall, "Pset_WallCommon", {
                "FireRating": "REI90" if w_idx % 2 == 0 else "REI60",
                "IsExternal": face in (0, 3),
            })
            gross = length * WALL_THICKNESS * STOREY_HEIGHT

            if spec.openings_per_wall:
                # One opening per wall, alternating door/window.
                is_door = w_idx % 2 == 0
                if is_door:
                    ow, oh = 1.0, 2.1
                    kind, ifc_class = "door", "IfcDoor"
                else:
                    ow, oh = 1.2, 1.5
                    kind, ifc_class = "window", "IfcWindow"
                opening = ifcopenshell.api.run(
                    "root.create_entity", f, ifc_class="IfcOpeningElement",
                    name=f"{wall_name}-op1",
                )
                rect = builder.rectangle(size=np.array([ow, oh]))
                item = builder.extrude(
                    rect, (WALL_THICKNESS + 0.002) * 1.0,
                    extrusion_vector=(0.0, 1.0, 0.0),
                )
                rep_o = f.createIfcShapeRepresentation(
                    body, "Body", "SweptSolid",
                    item if isinstance(item, list) else [item],
                )
                ifcopenshell.api.run(
                    "geometry.assign_representation", f, product=opening,
                    representation=rep_o,
                )
                ox = x0 + (length - ow) / 2.0 if not vertical else x0 - WALL_THICKNESS / 2.0
                oy = y0 - 0.001 if not vertical else y0 + (length - ow) / 2.0
                ifcopenshell.api.run(
                    "geometry.edit_object_placement", f, product=opening,
                    matrix=(
                        (1.0, 0.0, 0.0, ox),
                        (0.0, 1.0, 0.0, oy),
                        (0.0, 0.0, 1.0, z + 0.0 if is_door else 1.0),
                        (0.0, 0.0, 0.0, 1.0),
                    ),
                )
                ifcopenshell.api.run(
                    "feature.add_feature", f, feature=opening, element=wall
                )
                fill = ifcopenshell.api.run(
                    "root.create_entity", f, ifc_class=ifc_class,
                    name=f"{wall_name}-{kind}1",
                )
                ifcopenshell.api.run(
                    "attribute.edit_attributes", f, product=fill,
                    attributes={"OverallWidth": ow, "OverallHeight": oh},
                )
                ifcopenshell.api.run(
                    "spatial.assign_container", f, products=[fill],
                    relating_structure=storey,
                )
                ifcopenshell.api.run(
                    "feature.add_filling", f, opening=opening, element=fill
                )
                _add_pset(f, fill, IDENTITY_PSET, {
                    "DomainId": f"{domain_id}:{kind}-1",
                    "DomainKind": kind, "ModelVersion": f"cad5-{spec.tier}",
                })
                net = gross - ow * oh * WALL_THICKNESS
                _add_qto(f, wall, "Qto_WallCommon", {
                    "Length": length, "Height": STOREY_HEIGHT,
                    "Width": WALL_THICKNESS,
                    "GrossVolume": gross, "NetVolume": net,
                    "GrossSideArea": length * STOREY_HEIGHT,
                    "NetSideArea": length * STOREY_HEIGHT - ow * oh,
                    "OpeningsVolume": ow * oh * WALL_THICKNESS,
                    "OpeningCount": 1.0,
                })
                _add_qto(f, fill, "Qto_DoorBaseQuantities" if is_door else "Qto_WindowBaseQuantities", {
                    "OverallWidth": ow, "OverallHeight": oh,
                    "OverallArea": ow * oh,
                })
            else:
                _add_qto(f, wall, "Qto_WallCommon", {
                    "Length": length, "Height": STOREY_HEIGHT,
                    "Width": WALL_THICKNESS, "GrossVolume": gross,
                    "NetVolume": gross, "GrossSideArea": length * STOREY_HEIGHT,
                    "NetSideArea": length * STOREY_HEIGHT,
                    "OpeningsVolume": 0.0, "OpeningCount": 0.0,
                })

        for s_idx in range(spec.spaces_per_storey):
            space = ifcopenshell.api.run(
                "root.create_entity", f, ifc_class="IfcSpace",
                name=f"Space-{storey_idx}-{s_idx}",
            )
            ifcopenshell.api.run(
                "aggregate.assign_object", f, products=[space],
                relating_object=storey,
            )  # IfcSpace aggregates into the storey (IFC4: no ContainedInStructure)
            sw = ring_w / spec.spaces_per_storey
            rect = builder.rectangle(size=np.array([sw * 1.0, ring_l * 1.0]))
            item = builder.extrude(
                rect, STOREY_HEIGHT - 0.1, extrusion_vector=(0.0, 0.0, 1.0),
            )
            rep_s = f.createIfcShapeRepresentation(
                body, "Body", "SweptSolid",
                item if isinstance(item, list) else [item],
            )
            ifcopenshell.api.run(
                "geometry.assign_representation", f, product=space,
                representation=rep_s,
            )
            ifcopenshell.api.run(
                "geometry.edit_object_placement", f, product=space,
                matrix=(
                    (1.0, 0.0, 0.0, s_idx * sw),
                    (0.0, 1.0, 0.0, 0.0),
                    (0.0, 0.0, 1.0, z),
                    (0.0, 0.0, 0.0, 1.0),
                ),
            )
            _add_pset(f, space, IDENTITY_PSET, {
                "DomainId": f"off:cad5:space:{storey_idx}:{s_idx}",
                "DomainKind": "space", "ModelVersion": f"cad5-{spec.tier}",
            })
            _add_qto(f, space, "Qto_SpaceBaseQuantities", {
                "GrossFloorArea": sw * ring_l, "Perimeter": 2.0 * (sw + ring_l),
            })
    return f


def write_ifc_tier(spec: IfcTierSpec, path: Path) -> dict[str, Any]:
    """Build + write a tier fixture; return its recorded characteristics."""
    f = build_ifc_tier(spec)
    path.parent.mkdir(parents=True, exist_ok=True)
    f.write(str(path))
    walls = list(f.by_type("IfcWall"))
    openings = list(f.by_type("IfcOpeningElement"))
    doors = list(f.by_type("IfcDoor"))
    windows = list(f.by_type("IfcWindow"))
    spaces = list(f.by_type("IfcSpace"))
    slabs = list(f.by_type("IfcSlab"))
    products = walls + openings + doors + windows + spaces + slabs
    import hashlib
    from ifcopenshell.util.element import get_psets

    total_wall_length = 0.0
    total_gross_volume = 0.0
    for w in walls:
        qtos = get_psets(w, qtos_only=True)
        qto = qtos.get("Qto_WallCommon", {})
        total_wall_length += qto.get("Length", 0.0)
        total_gross_volume += qto.get("GrossVolume", 0.0)
    # Count STEP entities in the written file (the ifcopenshell 0.8.5
    # file object has no len(); parsing the written artifact doubles as a
    # write-integrity check).
    step_entities = 0
    with open(path) as fh:
        for line in fh:
            if line.startswith("#"):
                step_entities += 1
    return {
        "tier": spec.tier,
        "label": spec.label,
        "path": str(path),
        "file_size_bytes": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "step_entities": step_entities,
        "products_total": len(products),
        "walls": len(walls),
        "openings": len(openings),
        "doors": len(doors),
        "windows": len(windows),
        "spaces": len(spaces),
        "slabs": len(slabs),
        "total_wall_length_m": round(total_wall_length, 4),
        "total_wall_gross_volume_m3": round(total_gross_volume, 4),
        "schema": f.schema,
    }
