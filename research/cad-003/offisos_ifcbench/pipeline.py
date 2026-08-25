"""Offisos IFC semantic pipeline for RESEARCH-CAD-003.

The Offisos-side adapter layer over IfcOpenShell (ADAPTER epistemic
class): deterministic semantic extraction, controlled mutation with
lineage, export/re-import and semantic comparison. Domain identity is
carried by Pset_OffisosIdentity; engine GlobalIds are recorded as
provenance only and are never canonical (Construction Graph invariant).
"""
from __future__ import annotations

import copy
from typing import Any

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.element as eu

from .fixture import IDENTITY_PSET

ELEMENT_CLASSES = {
    "IfcWall": "wall",
    "IfcSlab": "slab",
    "IfcSpace": "space",
    "IfcDoor": "door",
    "IfcWindow": "window",
    "IfcOpeningElement": "opening",
}


def extract_snapshot(f: ifcopenshell.file) -> dict[str, Any]:
    """Deterministically extract the semantic snapshot of an IFC file.

    Snapshot: per-element identity/class/name/psets/qtos/placement plus
    file-level units and relationship counts. Sorting is canonical so
    extraction is byte-deterministic across runs.
    """
    snapshot: dict[str, Any] = {
        "elements": {},
        "relationships": {"voids": 0, "fills": 0, "containment": 0, "aggregation": 0},
        "units": {},
    }
    for unit in f.by_type("IfcUnitAssignment")[0].Units or []:
        if unit.is_a("IfcSIUnit") and unit.UnitType == "LENGTHUNIT":
            snapshot["units"]["length"] = {
                "name": unit.Name,
                "prefix": unit.Prefix,
            }
    for ifc_class, kind in ELEMENT_CLASSES.items():
        for product in f.by_type(ifc_class):
            identity: dict[str, Any] = {}
            props: dict[str, Any] = {}
            qtos: dict[str, Any] = {}
            for pset_name, values in eu.get_psets(product).items():
                if not isinstance(values, dict):
                    continue
                clean = {k: v for k, v in values.items() if k != "id"}
                if pset_name == IDENTITY_PSET:
                    identity = clean
                elif pset_name.startswith("Qto_"):
                    qtos.update(clean)
            for pset_name, values in eu.get_psets(product).items():
                if not isinstance(values, dict) or pset_name == IDENTITY_PSET or pset_name.startswith("Qto_"):
                    continue
                for k, v in values.items():
                    if k == "id":
                        continue
                    props[f"{pset_name}.{k}"] = v
            placement = None
            if getattr(product, "ObjectPlacement", None) is not None:
                import ifcopenshell.util.placement as up

                m = up.get_local_placement(product.ObjectPlacement)
                placement = [round(float(m[i][3]), 9) for i in range(3)]
            element_key = product.GlobalId
            snapshot["elements"][element_key] = {
                "global_id": product.GlobalId,
                "domain_id": identity.get("DomainId", ""),
                "domain_kind": identity.get("DomainKind", kind),
                "model_revision": identity.get("ModelRevision", ""),
                "identity_pset_found": bool(identity),
                "ifc_class": ifc_class,
                "name": product.Name or "",
                "properties": dict(sorted(props.items())),
                "quantities": dict(sorted(qtos.items())),
                "placement": placement,
                "overall_width": float(product.OverallWidth) if getattr(product, "OverallWidth", None) else None,
                "overall_height": float(product.OverallHeight) if getattr(product, "OverallHeight", None) else None,
            }
    snapshot["relationships"]["voids"] = len(f.by_type("IfcRelVoidsElement"))
    snapshot["relationships"]["fills"] = len(f.by_type("IfcRelFillsElement"))
    snapshot["relationships"]["containment"] = len(
        f.by_type("IfcRelContainedInSpatialStructure")
    )
    snapshot["relationships"]["aggregation"] = len(f.by_type("IfcRelAggregates"))
    return snapshot


def snapshot_domain_index(snapshot: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Index snapshot elements by domain id (skipping openings)."""
    return {
        e["domain_id"]: e
        for e in snapshot["elements"].values()
        if e["domain_id"] and e["ifc_class"] != "IfcOpeningElement"
    }


def compare_snapshots(
    before: dict[str, Any], after: dict[str, Any]
) -> dict[str, Any]:
    """Semantic diff between two snapshots, keyed by domain id.

    Reports per-element added/removed/changed with field-level detail for
    changed elements. Openings are compared by relationship counts (they
    are voids of their hosts, not canonical elements).
    """
    idx_before = snapshot_domain_index(before)
    idx_after = snapshot_domain_index(after)
    diff: dict[str, Any] = {
        "added": sorted(idx_after.keys() - idx_before.keys()),
        "removed": sorted(idx_before.keys() - idx_after.keys()),
        "changed": {},
        "relationships_before": before["relationships"],
        "relationships_after": after["relationships"],
        "units_before": before["units"],
        "units_after": after["units"],
    }
    for domain_id in sorted(idx_before.keys() & idx_after.keys()):
        e1, e2 = idx_before[domain_id], idx_after[domain_id]
        changes: dict[str, Any] = {}
        for field in ("ifc_class", "name", "properties", "quantities", "placement",
                      "overall_width", "overall_height", "model_revision"):
            if e1[field] != e2[field]:
                changes[field] = {"before": e1[field], "after": e2[field]}
        if changes:
            diff["changed"][domain_id] = changes
    return diff


def mutate_property(
    f: ifcopenshell.file, domain_id: str, pset_name: str, prop_name: str, value: Any
) -> dict[str, Any]:
    """Change one property of the element carrying domain_id. Returns lineage."""
    element = _element_by_domain_id(f, domain_id)
    psets = eu.get_psets(element)
    old = psets.get(pset_name, {}).get(prop_name)
    pset_entity = _pset_by_name(f, element, pset_name)
    ifcopenshell.api.run(
        "pset.edit_pset", f, pset=pset_entity, properties={prop_name: value}
    )
    return {
        "operation": "property-change",
        "domain_id": domain_id,
        "pset": pset_name,
        "property": prop_name,
        "before": old,
        "after": value,
    }


def mutate_placement(
    f: ifcopenshell.file, domain_id: str, dx: float, dy: float
) -> dict[str, Any]:
    """Translate the element carrying domain_id by (dx, dy). Returns lineage."""
    import ifcopenshell.util.placement as up

    element = _element_by_domain_id(f, domain_id)
    m = up.get_local_placement(element.ObjectPlacement)
    before = [round(float(m[i][3]), 9) for i in range(3)]
    ifcopenshell.api.run(
        "geometry.edit_object_placement", f, product=element,
        matrix=(
            (1.0, 0.0, 0.0, before[0] + dx),
            (0.0, 1.0, 0.0, before[1] + dy),
            (0.0, 0.0, 1.0, before[2]),
            (0.0, 0.0, 0.0, 1.0),
        ),
    )
    return {
        "operation": "placement-change",
        "domain_id": domain_id,
        "before": before,
        "after": [before[0] + dx, before[1] + dy, before[2]],
        "delta": [dx, dy, 0.0],
    }


def mutate_create_wall(
    f: ifcopenshell.file, domain_id: str, name: str,
    x0: float, y0: float, x1: float, y1: float,
    length: float, height: float, thickness: float,
) -> dict[str, Any]:
    """Create a new wall with identity + properties. Returns lineage."""
    from .fixture import _add_pset

    storey = f.by_type("IfcBuildingStorey")[0]
    body = [
        c for c in f.by_type("IfcGeometricRepresentationSubContext")
        if c.ContextIdentifier == "Body"
    ][0]
    wall = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcWall", name=name)
    ifcopenshell.api.run(
        "spatial.assign_container", f, products=[wall], relating_structure=storey
    )
    rep = ifcopenshell.api.run(
        "geometry.add_wall_representation", f, context=body,
        length=length, height=height, thickness=thickness,
    )
    ifcopenshell.api.run(
        "geometry.assign_representation", f, product=wall, representation=rep
    )
    ifcopenshell.api.run(
        "geometry.edit_object_placement", f, product=wall,
        matrix=(
            (1.0, 0.0, 0.0, x0),
            (0.0, 1.0, 0.0, y0),
            (0.0, 0.0, 1.0, 0.0),
            (0.0, 0.0, 0.0, 1.0),
        ),
    )
    _add_pset(f, wall, IDENTITY_PSET, {
        "DomainId": domain_id, "DomainKind": "wall", "ModelRevision": "fixture-v1-mutated",
    })
    _add_pset(f, wall, "Pset_WallCommon", {
        "FireRating": "REI30", "IsExternal": False, "LoadBearing": False,
    })
    return {
        "operation": "create-wall",
        "domain_id": domain_id,
        "name": name,
        "global_id": wall.GlobalId,
    }


def mutate_delete_wall(f: ifcopenshell.file, domain_id: str) -> dict[str, Any]:
    """Delete the wall carrying domain_id (and its relationships). Returns lineage."""
    element = _element_by_domain_id(f, domain_id)
    global_id = element.GlobalId
    name = element.Name
    ifcopenshell.api.run("root.remove_product", f, product=element)
    return {
        "operation": "delete-wall",
        "domain_id": domain_id,
        "name": name,
        "global_id": global_id,
    }


def _element_by_domain_id(f: ifcopenshell.file, domain_id: str):
    for ifc_class in ("IfcWall", "IfcSlab", "IfcSpace", "IfcDoor", "IfcWindow"):
        for product in f.by_type(ifc_class):
            identity = eu.get_psets(product).get(IDENTITY_PSET, {})
            if isinstance(identity, dict) and identity.get("DomainId") == domain_id:
                return product
    raise KeyError(f"no element carries domain id {domain_id!r}")


def _pset_by_name(f: ifcopenshell.file, product, name: str):
    for rel in getattr(product, "IsDefinedBy", []) or []:
        if rel.is_a("IfcRelDefinesByProperties") and rel.RelatingPropertyDefinition.Name == name:
            return rel.RelatingPropertyDefinition
    raise KeyError(f"pset {name!r} not found on {product.Name!r}")


def export(f: ifcopenshell.file, path: str) -> int:
    f.write(path)
    import os

    return os.path.getsize(path)


def reimport(path: str) -> ifcopenshell.file:
    return ifcopenshell.open(path)
