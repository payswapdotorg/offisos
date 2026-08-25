"""Quantity records for RESEARCH-CAD-004 (issue #4 scopes 2+3).

The deterministic, provenance-preserving layer between CAD/BIM model
versions and the Construction Graph:

- :class:`QuantityRecord` — one quantity value with unit, tolerance,
  epistemic state (OBSERVED / CALCULATED / UNKNOWN) and full provenance
  (model version, element domain id, engine GlobalId, extraction method,
  engine version, parameters). Records carry version stamps, NOT
  wall-clock timestamps: determinism forbids time-dependent content.
- :class:`QuantitySnapshot` — the immutable quantity state of ONE model
  version. A revision produces a NEW snapshot; historical states are
  never mutated.
- :func:`extract_snapshot` — dual-path extraction from an IFC file:
  quantity-set values are OBSERVED; geometry-derived values are
  CALCULATED via exact OCCT BRep (booleans + mass properties) and via a
  pure-Python analytic reference path. Elements without a basis yield
  UNKNOWN — never a fabricated zero.
- :func:`diff_snapshots` — deterministic quantity deltas between two
  versions, with explicit unchanged sets.
- :func:`change_record` — the domain-event equivalent for downstream
  consumers.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

import ifcopenshell
import ifcopenshell.util.element as eu

from .fixtures import (
    CONCRETE_DENSITY_KG_M3,
    IDENTITY_PSET,
    WALL_THICKNESS,
    expected_quantities,
    wall_length,
)


class QuantityState(str, Enum):
    OBSERVED = "OBSERVED"      # read from the model's quantity sets
    CALCULATED = "CALCULATED"  # computed from geometry/parameters
    UNKNOWN = "UNKNOWN"        # no basis; never a fabricated value


@dataclass(frozen=True)
class QuantityRecord:
    record_id: str                     # deterministic: <domain_id>#<quantity>@<version>
    element_domain_id: str
    model_version: str
    quantity_name: str
    value: Optional[float]
    unit: str
    state: QuantityState
    tolerance: float
    provenance: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "record_id": self.record_id,
            "element_domain_id": self.element_domain_id,
            "model_version": self.model_version,
            "quantity_name": self.quantity_name,
            "value": self.value,
            "unit": self.unit,
            "state": self.state.value,
            "tolerance": self.tolerance,
            "provenance": self.provenance,
        }


UNITS = {
    "Length": "m", "Height": "m", "Width": "m", "OverallWidth": "m",
    "OverallHeight": "m",
    "GrossVolume": "m^3", "NetVolume": "m^3", "OpeningsVolume": "m^3",
    "GrossSideArea": "m^2", "NetSideArea": "m^2", "OverallArea": "m^2",
    "GrossFloorArea": "m^2",
    "Perimeter": "m", "OpeningCount": "count", "Weight": "kg",
}
TOLERANCE = 1e-9  # exact-measure tolerance for this fixture corpus


class QuantitySnapshot:
    """Immutable quantity state of one model version."""

    def __init__(self, model_version: str, records: list[QuantityRecord]):
        self.model_version = model_version
        self.records: dict[str, QuantityRecord] = {}
        for r in records:
            self.records[r.record_id] = r

    def element_quantities(self, domain_id: str) -> dict[str, QuantityRecord]:
        return {
            r.quantity_name: r
            for r in self.records.values()
            if r.element_domain_id == domain_id
        }

    def domain_ids(self) -> set[str]:
        return {r.element_domain_id for r in self.records.values()}

    def to_dict(self) -> dict[str, Any]:
        return {
            "model_version": self.model_version,
            "record_count": len(self.records),
            "records": {
                rid: r.to_dict() for rid, r in sorted(self.records.items())
            },
        }


def _identity_of(product) -> dict[str, Any]:
    values = eu.get_psets(product).get(IDENTITY_PSET, {})
    return values if isinstance(values, dict) else {}


def _engine_version() -> str:
    return f"ifcopenshell {ifcopenshell.version}"


def extract_snapshot(
    f: ifcopenshell.file, model_version: str, method: str = "file-qtos+occt-brep"
) -> QuantitySnapshot:
    """Extract the quantity snapshot from an IFC file.

    Quantity-set values are OBSERVED. For walls, volumes/areas are
    re-derived with exact OCCT BRep geometry (CALCULATED, engine path)
    including weight from the density parameter. Fillings carry their
    Overall attributes as OBSERVED. Elements with neither basis yield
    UNKNOWN records.
    """
    records: list[QuantityRecord] = []
    for ifc_class in ("IfcWall", "IfcSlab", "IfcSpace", "IfcDoor", "IfcWindow"):
        for product in f.by_type(ifc_class):
            identity = _identity_of(product)
            domain_id = identity.get("DomainId", "")
            version = identity.get("ModelVersion", model_version)
            qtos: dict[str, float] = {}
            for pset_name, values in eu.get_psets(product).items():
                if pset_name.startswith("Qto_") and isinstance(values, dict):
                    for k, v in values.items():
                        if k != "id" and isinstance(v, (int, float)):
                            qtos[k] = float(v)
            prov_base = {
                "engine": "ifcopenshell+occt",
                "engine_id": product.GlobalId,
                "engine_ifc_class": ifc_class,
                "method": method,
                "engine_version": _engine_version(),
            }
            if qtos:
                for q_name, q_value in sorted(qtos.items()):
                    records.append(QuantityRecord(
                        record_id=f"{domain_id}#{q_name}@{version}",
                        element_domain_id=domain_id,
                        model_version=version,
                        quantity_name=q_name,
                        value=q_value,
                        unit=UNITS.get(q_name, "?"),
                        state=QuantityState.OBSERVED,
                        tolerance=TOLERANCE,
                        provenance=dict(prov_base),
                    ))
            if ifc_class == "IfcWall" and domain_id:
                for rec in _brep_wall_records(
                    product, domain_id, version, prov_base
                ):
                    records.append(rec)
            if ifc_class in ("IfcDoor", "IfcWindow") and domain_id:
                ow = getattr(product, "OverallWidth", None)
                oh = getattr(product, "OverallHeight", None)
                if ow and oh:
                    records.append(QuantityRecord(
                        record_id=f"{domain_id}#OverallWidth@{version}",
                        element_domain_id=domain_id, model_version=version,
                        quantity_name="OverallWidth", value=float(ow),
                        unit="m", state=QuantityState.OBSERVED,
                        tolerance=TOLERANCE, provenance=dict(prov_base),
                    ))
                    records.append(QuantityRecord(
                        record_id=f"{domain_id}#OverallHeight@{version}",
                        element_domain_id=domain_id, model_version=version,
                        quantity_name="OverallHeight", value=float(oh),
                        unit="m", state=QuantityState.OBSERVED,
                        tolerance=TOLERANCE, provenance=dict(prov_base),
                    ))
                    records.append(QuantityRecord(
                        record_id=f"{domain_id}#OverallArea@{version}",
                        element_domain_id=domain_id, model_version=version,
                        quantity_name="OverallArea",
                        value=round(float(ow) * float(oh), 9),
                        unit="m^2", state=QuantityState.CALCULATED,
                        tolerance=TOLERANCE,
                        provenance=dict(
                            prov_base, method="width-x-height",
                            parameters={"formula": "OverallWidth * OverallHeight"},
                        ),
                    ))
            if not qtos and (ifc_class != "IfcWall"
                             or product.Representation is None):
                records.append(QuantityRecord(
                    record_id=f"{domain_id}#NetVolume@{version}",
                    element_domain_id=domain_id,
                    model_version=version,
                    quantity_name="NetVolume",
                    value=None,
                    unit="m^3",
                    state=QuantityState.UNKNOWN,
                    tolerance=TOLERANCE,
                    provenance=dict(
                        prov_base,
                        basis="no quantity set and no geometric basis on this element",
                    ),
                ))
    return QuantitySnapshot(model_version, records)


def _brep_wall_records(
    product, domain_id: str, version: str, prov_base: dict[str, Any]
) -> list[QuantityRecord]:
    """CALCULATED records from exact OCCT BRep geometry (engine path).

    Reads the wall's ACTUAL file geometry (swept-solid profile extents,
    extrusion depth, object placement — with an explicit unit-scale
    conversion when the project unit is not METRE), rebuilds the solid
    in OCCT, boolean-cuts the file's openings and computes exact mass
    properties. The geometry kernel is exercised against the file, not
    the stored quantity sets.
    """
    if product.Representation is None:
        return []  # no geometric basis -> caller records UNKNOWN
    import ifcopenshell.util.placement as up
    import ifcopenshell.util.unit as unit_util
    from OCP.gp import gp_Pnt, gp_Trsf
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
    from OCP.GProp import GProp_GProps
    from OCP.BRepGProp import BRepGProp

    scale = float(unit_util.calculate_unit_scale(product.file))

    def _matrix(shape, m):
        # placement matrices are in FILE units; scale translations to metres
        trsf = gp_Trsf()
        trsf.SetValues(
            m[0][0], m[0][1], m[0][2], m[0][3] * scale,
            m[1][0], m[1][1], m[1][2], m[1][3] * scale,
            m[2][0], m[2][1], m[2][2], m[2][3] * scale,
        )
        return BRepBuilderAPI_Transform(shape, trsf, True).Shape()

    def _profile_extents(item):
        pts = item.SweptArea.OuterCurve.Points.CoordList
        xs = [float(p[0]) for p in pts]
        ys = [float(p[1]) for p in pts]
        return (max(xs) - min(xs)) * scale, (max(ys) - min(ys)) * scale

    # wall solid: profile (length x thickness) extruded by Depth (height),
    # positioned by the object placement (rotation included)
    item = product.Representation.Representations[0].Items[0]
    p_x, p_y = _profile_extents(item)
    depth = float(item.Depth) * scale
    wall_local = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), p_x, p_y, depth).Shape()
    wall_m = up.get_local_placement(product.ObjectPlacement)
    solid = _matrix(wall_local, wall_m)

    # gross volume: the exact mass of the UNcut placed solid
    props_gross = GProp_GProps()
    BRepGProp.VolumeProperties_s(solid, props_gross, True)
    gross_volume = props_gross.Mass()

    # boolean-cut every opening that has a representation (file geometry)
    for rel in getattr(product, "HasOpenings", []) or []:
        opening = rel.RelatedOpeningElement
        if opening is None or getattr(opening, "Representation", None) is None:
            continue
        o_item = opening.Representation.Representations[0].Items[0]
        o_x, o_y = _profile_extents(o_item)
        o_depth = float(o_item.Depth) * scale
        void_local = BRepPrimAPI_MakeBox(
            gp_Pnt(0, 0, 0), o_x, o_depth, o_y
        ).Shape()
        o_m = up.get_local_placement(opening.ObjectPlacement)
        void = _matrix(void_local, o_m)
        solid = BRepAlgoAPI_Cut(solid, void).Shape()

    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(solid, props, True)
    net_volume = props.Mass()

    out = []
    for q_name, value, unit, tol in [
        ("BRepNetVolume", net_volume, "m^3", 1e-6),
        ("BRepGrossVolume", gross_volume, "m^3", 1e-6),
        ("BRepWeight", net_volume * CONCRETE_DENSITY_KG_M3, "kg", 1e-3),
    ]:
        out.append(QuantityRecord(
            record_id=f"{domain_id}#{q_name}@{version}",
            element_domain_id=domain_id,
            model_version=version,
            quantity_name=q_name,
            value=round(value, 9),
            unit=unit,
            state=QuantityState.CALCULATED,
            tolerance=tol,
            provenance=dict(
                prov_base,
                method="occt-brep",
                parameters={
                    "density_kg_m3": CONCRETE_DENSITY_KG_M3,
                    "unit_scale_file_to_m": scale,
                    "profile_extents_m": [round(p_x, 6), round(p_y, 6)],
                    "extrusion_depth_m": round(depth, 6),
                },
            ),
        ))
    return out


def analytic_snapshot(model_version: str) -> QuantitySnapshot:
    """The pure-Python analytic reference snapshot (no CAD engine).

    Values come from the fixture's analytic expectations. This is the
    engine-independence reference: if the BRep path and the analytic
    path agree, quantity records do not depend on the engine.
    """
    expected = expected_quantities(model_version)
    records = []
    for domain_id, quantities in sorted(expected.items()):
        for q_name, value in sorted(quantities.items()):
            params: dict[str, Any] = {}
            if q_name == "Weight":
                params["density_kg_m3"] = CONCRETE_DENSITY_KG_M3
            records.append(QuantityRecord(
                record_id=f"{domain_id}#{q_name}@{model_version}",
                element_domain_id=domain_id,
                model_version=model_version,
                quantity_name=q_name,
                value=round(value, 9),
                unit=UNITS.get(q_name, "?"),
                state=QuantityState.CALCULATED,
                tolerance=TOLERANCE,
                provenance={
                    "engine": "analytic-reference",
                    "engine_id": None,
                    "method": "fixture-analytic",
                    "engine_version": "pure-python",
                    "parameters": params,
                },
            ))
    return QuantitySnapshot(model_version, records)


def diff_snapshots(
    a: QuantitySnapshot, b: QuantitySnapshot
) -> dict[str, Any]:
    """Deterministic quantity delta between two model-version snapshots.

    Keyed by element domain id (canonical identity), quantity name.
    Elements absent from both are ignored; the unchanged set is
    explicit for the unchanged-element-identity proof.
    """
    def index(s: QuantitySnapshot):
        return {
            (r.element_domain_id, r.quantity_name): r for r in s.records.values()
        }

    ia, ib = index(a), index(b)
    changed: dict[str, dict[str, Any]] = {}
    unchanged: dict[str, list[str]] = {}
    added = sorted(
        f"{d}#{q}" for (d, q) in ib.keys() - ia.keys()
    )
    removed = sorted(
        f"{d}#{q}" for (d, q) in ia.keys() - ib.keys()
    )
    for key in sorted(ia.keys() & ib.keys()):
        ra, rb = ia[key], ib[key]
        domain_id, q_name = key
        if ra.value is None or rb.value is None:
            same = ra.value == rb.value and ra.state == rb.state
        else:
            same = abs(ra.value - rb.value) <= max(ra.tolerance, rb.tolerance)
        if same:
            unchanged.setdefault(domain_id, []).append(q_name)
        else:
            changed.setdefault(domain_id, {})[q_name] = {
                "before": ra.value, "after": rb.value,
                "delta": None if ra.value is None or rb.value is None
                else round(rb.value - ra.value, 12),
                "state_before": ra.state.value, "state_after": rb.state.value,
            }
    return {
        "from_version": a.model_version,
        "to_version": b.model_version,
        "changed": changed,
        "unchanged": {d: sorted(q) for d, q in sorted(unchanged.items())},
        "added": added,
        "removed": removed,
    }


def change_record(diff: dict[str, Any]) -> dict[str, Any]:
    """The domain-event equivalent emitted for downstream consumers."""
    changed_elements = sorted(diff["changed"].keys())
    # untouched elements: no changed quantity at all (the meaningful
    # unchanged count for downstream consumers)
    all_elements = set(diff["changed"].keys()) | set(diff["unchanged"].keys())
    untouched_elements = sorted(all_elements - set(changed_elements))
    changed_quantity_refs = sorted(
        f"{d}#{q}" for d, qs in diff["changed"].items() for q in qs
    )
    return {
        "event": "QuantityStateChanged",
        "from_version": diff["from_version"],
        "to_version": diff["to_version"],
        "changed_elements": changed_elements,
        "changed_quantity_refs": changed_quantity_refs,
        "untouched_elements": untouched_elements,
        "untouched_element_count": len(untouched_elements),
        "added_quantity_refs": diff["added"],
        "removed_quantity_refs": diff["removed"],
    }
