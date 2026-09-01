#!/usr/bin/env python3
"""Offisos IFC worker (COMPAT-IFC-001 / Issue #47).

The Python side of the IFC/openBIM adapter boundary — the ONLY place
IfcOpenShell / IfcTester / bcf-client appear (RESEARCH-CAD-003-proven
toolchain: ifcopenshell 0.8.5, IfcTester 0.8.5, bcf-client 0.8.5).

Discipline (mirrors the OCCT worker, CAD-005 findings):
  * one JSON request per DISPOSABLE process on stdin, one JSON response
    on stdout (the parent enforces the wall-clock budget at the process
    boundary; this script never hangs: every path returns exactly once);
  * typed failures {ok: false, code, message} — never a bare traceback;
  * deterministic output: canonical ordering everywhere, fixed header
    timestamp on generated files, deterministic IfcGuid normalization for
    non-product roots so generated IFC bytes are byte-identical for equal
    inputs (COMPAT-IFC-001 designed invariant).

Wire units are METRES (the export convention); the canonical mm domain
lives on the TypeScript side.

Ops:
  ping       — engine identity + toolchain versions
  parse      — IFC bytes -> deterministic semantic IR (world placements,
               profile bbox facts, psets/qtos, relationships, units; the
               CAD-PARITY-014 documentation IfcGroup records — D2)
  build      — build model (+ optional documentation IfcGroup carrier) ->
               deterministic IFC4 bytes
  ids        — IDS XML validation of an IFC file (IfcTester)
  bcf_build  — topics (+ optional camera viewpoints + source-revision
               lineage — CAD-PARITY-014 D3) -> deterministic BCF-XML v3
               .bcf container bytes (fixed entry dates + sorted order)
  bcf_parse  — .bcf container bytes -> topics (references = IfcGuids,
               the camera viewpoint, the source lineage)
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import sys
import zipfile
from typing import Any

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.guid
import ifcopenshell.util.element as eu
import ifcopenshell.util.placement as up

try:
    import ifctester
    from ifctester.ids import Ids
    from ifctester.facet import Entity, Property
except Exception:  # pragma: no cover — ping still works without IfcTester
    ifctester = None  # type: ignore[assignment]

ENGINE = "ifc"
FIXED_TIMESTAMP = "2026-01-01T00:00:00"
IDENTITY_PSET = "Pset_OffisosIdentity"
PARAMS_PSET = "Pset_OffisosParams"
CUSTOM_PSET = "Pset_OffisosCustom"
MATERIAL_PSET = "Pset_OffisosMaterial"
COMPONENT_PSET = "Pset_OffisosComponent"
# CAD-PARITY-014 (Issue #107): the documentation exchange carrier pset (the
# IfcGroup record fields — D2).
DOCS_PSET = "Pset_OffisosDocs"
GUID_SALT = "offisos-ifc-root:v1"
OPENING_LATERAL_OVERHANG = 0.002  # m — matches the canonical 1 mm cut overhang per side
# CAD-PARITY-014: the BCF determinism salts (the comment-guid precedent —
# sha256-truncated uuid-shaped values keyed by the topic index so two builds
# of the same topics payload are byte-identical).
BCF_TOPIC_GUID_SALT = "offisos-bcf-topic"
BCF_VIEWPOINT_GUID_SALT = "offisos-bcf-viewpoint"
BCF_COMMENT_GUID_SALT = "offisos-bcf-comment"
BCF_DOCREF_GUID_SALT = "offisos-bcf-docref"
# CAD-PARITY-014: the BCF source-lineage carrier (D3). The BCF 3.0 Topic has
# a conformant document-reference list (TopicDocumentReferences); the source
# revision rides there: description = this marker, url = the caller-chosen
# canonical revision identity. Parse reads it back through the same marker.
BCF_SOURCE_REVISION_MARKER = "offisos-source-model-revision"
# CAD-PARITY-014: the fixed zip entry date for the BCF container (bcf.save
# embeds the current wall clock in every entry — the post-processed
# deterministic rebuild pins 2026-01-01 and sorts the entries).
BCF_ZIP_DATE = (2026, 1, 1, 0, 0, 0)

# COMPAT-BIM-003: component category → IFC class. Component walls/doors/windows
# are FREESTANDING parametric boxes (they do not void/fill anything) — the
# component pset distinguishes them from bim.wall/bim.door/bim.window exports.
COMPONENT_IFC_CLASS = {
    "wall": "IfcWall",
    "door": "IfcDoor",
    "window": "IfcWindow",
    "furniture": "IfcFurnishingElement",
    "fixture": "IfcFurnishingElement",
}

ELEMENT_CLASSES = {
    "IfcWall": "wall",
    "IfcSlab": "slab",
    "IfcSpace": "space",
    "IfcDoor": "door",
    "IfcWindow": "window",
    "IfcOpeningElement": "opening",
    "IfcFurnishingElement": "furnishing",
}


class OpError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def fail(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "code": code, "message": message}


def identity_header() -> dict[str, Any]:
    return {
        "ok": True,
        "engine": ENGINE,
        "engineVersion": ifcopenshell.version,
        "toolchain": {
            "ifctester": getattr(ifctester, "__version__", "0.8.5") if ifctester else "unavailable",
            "bcf": "0.8.5 (bcf.v3.bcfxml)",
        },
    }


def normalize_set_order(f: Any) -> None:
    """Reassign every multi-entity aggregate attribute in STEP-id order.

    IFC SET attributes serialize in engine-internal (memory-address) order,
    which varies per process; sorting the stored aggregates makes the
    serialization deterministic. STEP ids themselves are deterministic
    (fixed creation order), so the sorted order is stable across runs.
    """
    for e in f:
        try:
            n = len(e)
        except Exception:
            continue
        for i in range(n):
            try:
                v = e[i]
            except Exception:
                continue
            if (
                isinstance(v, tuple)
                and len(v) > 1
                and all(hasattr(x, "id") and callable(x.id) for x in v)
            ):
                try:
                    e[i] = tuple(sorted(v, key=lambda x: x.id()))
                except Exception:
                    pass


def det_root_guid(step_id: int) -> str:
    """Deterministic IfcGuid for non-product IfcRoot entities (STEP-id keyed;
    creation order is deterministic, so STEP ids are too)."""
    h = hashlib.sha256(f"{GUID_SALT}:{step_id}".encode()).hexdigest()[:32]
    return ifcopenshell.guid.compress(h)


def r9(v: float) -> float:
    return round(float(v), 9)


# --- helpers --------------------------------------------------------------------


def world_matrix(product) -> Any:
    """Accumulate the ObjectPlacement chain (PlacementRelTo) into one 4x4.

    chain = [M_element (innermost), M_parent, ... M_outermost]; the world
    matrix is M_outer @ ... @ M_parent @ M_element (outer transforms apply
    to the result of the inner), so the fold is m <- cm @ m walking the
    chain innermost -> outermost. Translations commute, but rotations do
    not — the order matters as soon as a rotated host nests a placement
    (IfcRelVoidsElement nests opening placements under the host wall).
    """
    chain: list[Any] = []
    pl = getattr(product, "ObjectPlacement", None)
    while pl is not None:
        chain.append(up.get_local_placement(pl))
        pl = getattr(pl, "PlacementRelTo", None)
    m = (
        (1.0, 0.0, 0.0, 0.0),
        (0.0, 1.0, 0.0, 0.0),
        (0.0, 0.0, 1.0, 0.0),
        (0.0, 0.0, 0.0, 1.0),
    )
    for cm in chain:
        m = tuple(  # type: ignore[assignment]
            tuple(sum(cm[i][k] * m[k][j] for k in range(4)) for j in range(4))
            for i in range(4)
        )
    return m


def clean_psets(product) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    psets: dict[str, dict[str, Any]] = {}
    qtos: dict[str, dict[str, Any]] = {}
    for pset_name, values in eu.get_psets(product).items():
        if not isinstance(values, dict):
            continue
        clean = {k: v for k, v in values.items() if k != "id"}
        if pset_name.startswith("Qto_"):
            qtos[pset_name] = dict(sorted(clean.items()))
        else:
            psets[pset_name] = dict(sorted(clean.items()))
    return dict(sorted(psets.items())), dict(sorted(qtos.items()))


def curve_points_2d(curve: Any) -> list[tuple[float, float]] | None:
    """[(x, y), ...] from an IfcIndexedPolyCurve or IfcPolyline.

    IfcIndexedPolyCurve.Points is the IfcCartesianPointList ENTITY — its
    attribute 0 is the CoordList (iterating the entity yields ONE item, the
    whole coordinate list, never the points). IfcPolyline.Points is a tuple
    of IfcCartesianPoint entities with .Coordinates.
    """
    if curve.is_a("IfcIndexedPolyCurve"):
        pl = curve.Points
        if pl is None:
            return None
        coords: Any = pl
        if hasattr(pl, "is_a") and pl.is_a("IfcCartesianPointList"):
            coords = pl[0]  # attribute 0 = CoordList
        pts: list[tuple[float, float]] = []
        for c in coords or []:
            vals = list(c)
            if len(vals) >= 2:
                pts.append((float(vals[0]), float(vals[1])))
            elif len(vals) == 1:
                pts.append((float(vals[0]), 0.0))
        return pts if pts else None
    if curve.is_a("IfcPolyline"):
        pts = []
        for p in curve.Points or []:
            c = list(p.Coordinates)
            if len(c) >= 2:
                pts.append((float(c[0]), float(c[1])))
        return pts if pts else None
    return None


def profile_facts(product) -> dict[str, Any] | None:
    """Extruded-rect body profile bbox facts, when extractable."""
    rep = getattr(product, "Representation", None)
    if rep is None:
        return None
    for shape_rep in rep.Representations or []:
        if shape_rep.ContextOfItems.ContextIdentifier != "Body":
            continue
        for item in shape_rep.Items or []:
            if not item.is_a("IfcExtrudedAreaSolid"):
                continue
            swept = item.SweptArea
            if swept.is_a("IfcRectangleProfileDef"):
                xdim, ydim = float(swept.XDim), float(swept.YDim)
                pos = getattr(swept, "Position", None)
                px, py = 0.0, 0.0
                if pos is not None and getattr(pos, "Location", None) is not None:
                    coords = list(pos.Location.Coordinates or [])
                    px = float(coords[0]) if len(coords) > 0 else 0.0
                    py = float(coords[1]) if len(coords) > 1 else 0.0
                return {
                    "kind": "rect",
                    "x0": r9(px - xdim / 2.0),
                    "y0": r9(py - ydim / 2.0),
                    "xdim": r9(xdim),
                    "ydim": r9(ydim),
                    "depth": r9(item.Depth),
                }
            if swept.is_a("IfcArbitraryClosedProfileDef"):
                curve = swept.OuterCurve
                pts = curve_points_2d(curve)
                if pts is not None and len(pts) >= 3:
                    xs = [p[0] for p in pts]
                    ys = [p[1] for p in pts]
                    return {
                        "kind": "rect",
                        "x0": r9(min(xs)),
                        "y0": r9(min(ys)),
                        "xdim": r9(max(xs) - min(xs)),
                        "ydim": r9(max(ys) - min(ys)),
                        "depth": r9(item.Depth),
                    }
    return None


def footprint_facts(product) -> list[list[float]] | None:
    """Footprint curve points (object coords, 2D), when extractable."""
    rep = getattr(product, "Representation", None)
    if rep is None:
        return None
    for shape_rep in rep.Representations or []:
        if shape_rep.ContextOfItems.ContextIdentifier != "Body":
            continue
        for item in shape_rep.Items or []:
            curves: list[Any] = []
            if item.is_a("IfcGeometricCurveSet"):
                curves = list(item.Elements or [])
            elif item.is_a("IfcIndexedPolyCurve") or item.is_a("IfcPolyline"):
                curves = [item]
            for curve in curves:
                pts2d = curve_points_2d(curve)
                if pts2d is not None and len(pts2d) >= 3:
                    return [[r9(x), r9(y)] for x, y in pts2d]
    return None


# --- parse ----------------------------------------------------------------------


def op_parse(req: dict[str, Any]) -> dict[str, Any]:
    try:
        raw = base64.b64decode(req["ifc"], validate=True)
    except Exception as e:
        raise OpError("ifc_invalid", f"ifc payload is not valid base64: {e}")
    try:
        text = raw.decode("utf-8")
        f = ifcopenshell.file.from_string(text)
    except Exception as e:
        raise OpError("ifc_invalid", f"ifcopenshell cannot open the file: {e}")

    units: dict[str, Any] = {"lengthUnitName": None, "lengthUnitPrefix": None}
    for assignment in f.by_type("IfcUnitAssignment"):
        for unit in assignment.Units or []:
            if unit.is_a("IfcSIUnit") and unit.UnitType == "LENGTHUNIT":
                units["lengthUnitName"] = unit.Name
                units["lengthUnitPrefix"] = unit.Prefix
            elif unit.is_a("IfcConversionBasedUnit") and unit.UnitType == "LENGTHUNIT":
                units["lengthUnitName"] = getattr(unit, "Name", None)
                units["lengthUnitPrefix"] = None

    # story index (containment/aggregation lookups)
    story_of: dict[str, str] = {}
    for rel in f.by_type("IfcRelContainedInSpatialStructure"):
        for el in rel.RelatedElements or []:
            if getattr(rel.RelatingStructure, "GlobalId", None):
                story_of[el.GlobalId] = rel.RelatingStructure.GlobalId
    for rel in f.by_type("IfcRelAggregates"):
        for el in rel.RelatedObjects or []:
            if getattr(el, "GlobalId", None) and getattr(rel.RelatingObject, "GlobalId", None):
                if el.is_a("IfcSpace") and rel.RelatingObject.is_a("IfcBuildingStorey"):
                    story_of[el.GlobalId] = rel.RelatingObject.GlobalId

    host_of: dict[str, str] = {}
    for rel in f.by_type("IfcRelVoidsElement"):
        opening = rel.RelatedOpeningElement
        host = rel.RelatingBuildingElement
        if getattr(opening, "GlobalId", None) and getattr(host, "GlobalId", None):
            host_of[opening.GlobalId] = host.GlobalId

    fill_of: dict[str, str] = {}
    for rel in f.by_type("IfcRelFillsElement"):
        fill = rel.RelatedBuildingElement
        opening = rel.RelatingOpeningElement
        if getattr(fill, "GlobalId", None) and getattr(opening, "GlobalId", None):
            fill_of[fill.GlobalId] = opening.GlobalId

    # COMPAT-BIM-003: materials (IfcMaterial has no GlobalId — identity and
    # exchange semantics live in IfcMaterialProperties sets) + per-element
    # material associations (IfcRelAssociatesMaterial → IfcMaterial by name).
    def _material_psets(material: Any) -> dict[str, dict[str, Any]]:
        psets: dict[str, dict[str, Any]] = {}
        for mp in f.by_type("IfcMaterialProperties"):
            if mp.Material == material:
                props: dict[str, Any] = {}
                for p in mp.Properties or []:
                    if p is None:  # malformed external file — skip, never crash
                        continue
                    value = p.NominalValue.wrappedValue if p.NominalValue is not None else None
                    props[p.Name or ""] = value
                psets[mp.Name or ""] = props
        return psets

    materials: list[dict[str, Any]] = []
    for material in f.by_type("IfcMaterial"):
        materials.append(
            {
                "name": material.Name or "",
                "description": material.Description or None,
                "psets": _material_psets(material),
            }
        )
    materials.sort(key=lambda m: (m["name"], json.dumps(m["psets"], sort_keys=True)))

    # CAD-PARITY-014 (Issue #107): the documentation IfcGroup records (D2) —
    # walk the groups (sorted by guid), extract the two psets. Absent groups
    # → the key is omitted entirely (legacy parse results stay identical).
    documentation: list[dict[str, Any]] = []
    for group in sorted(f.by_type("IfcGroup"), key=lambda g: g.GlobalId or ""):
        psets, _ = clean_psets(group)
        identity = psets.get(IDENTITY_PSET)
        fields = psets.get(DOCS_PSET)
        documentation.append(
            {
                "globalId": group.GlobalId,
                "name": group.Name or "",
                "identity": dict(identity) if isinstance(identity, dict) else None,
                "fields": dict(fields) if isinstance(fields, dict) else {},
            }
        )

    material_name_of: dict[str, str] = {}
    for rel in f.by_type("IfcRelAssociatesMaterial"):
        relating = rel.RelatingMaterial
        if relating is None or not relating.is_a("IfcMaterial"):
            continue
        for product in rel.RelatedObjects or []:
            if getattr(product, "GlobalId", None):
                material_name_of[product.GlobalId] = relating.Name or ""

    stories: list[dict[str, Any]] = []
    for storey in f.by_type("IfcBuildingStorey"):
        psets, qtos = clean_psets(storey)
        height = None
        params = psets.get(PARAMS_PSET)
        if isinstance(params, dict) and isinstance(params.get("Height"), (int, float)):
            height = r9(params["Height"])
        stories.append(
            {
                "globalId": storey.GlobalId,
                "name": storey.Name or "",
                "elevation": r9(storey.Elevation or 0.0),
                "height": height,
                "psets": psets,
                "qtos": qtos,
            }
        )
    stories.sort(key=lambda s: (s["elevation"], s["name"], s["globalId"]))

    elements: list[dict[str, Any]] = []
    for ifc_class in ELEMENT_CLASSES:
        for product in f.by_type(ifc_class):
            psets, qtos = clean_psets(product)
            placement = None
            rotation = None
            if getattr(product, "ObjectPlacement", None) is not None:
                m = world_matrix(product)
                placement = [r9(m[i][3]) for i in range(3)]
                rotation = [[r9(m[0][0]), r9(m[0][1])], [r9(m[1][0]), r9(m[1][1])]]
            elements.append(
                {
                    "globalId": product.GlobalId,
                    "ifcClass": ifc_class,
                    "name": product.Name or "",
                    "storyGlobalId": story_of.get(product.GlobalId),
                    "hostGlobalId": host_of.get(product.GlobalId),
                    "fillOpeningGlobalId": fill_of.get(product.GlobalId),
                    "materialName": material_name_of.get(product.GlobalId),
                    "psets": psets,
                    "qtos": qtos,
                    "placement": placement,
                    "rotation": rotation,
                    "profile": profile_facts(product),
                    "footprint": footprint_facts(product),
                    "overallWidth": r9(product.OverallWidth) if getattr(product, "OverallWidth", None) else None,
                    "overallHeight": r9(product.OverallHeight) if getattr(product, "OverallHeight", None) else None,
                }
            )
    elements.sort(key=lambda e: (e["ifcClass"], e["name"], e["globalId"]))

    result = {
        "schema": f.schema,
        "lengthUnitName": units["lengthUnitName"],
        "lengthUnitPrefix": units["lengthUnitPrefix"],
        "stories": stories,
        "elements": elements,
        "materials": materials,
        "relationships": {
            "voids": len(f.by_type("IfcRelVoidsElement")),
            "fills": len(f.by_type("IfcRelFillsElement")),
            "containment": len(f.by_type("IfcRelContainedInSpatialStructure")),
            "aggregation": len(f.by_type("IfcRelAggregates")),
            "materialAssociations": len(f.by_type("IfcRelAssociatesMaterial")),
        },
    }
    if documentation:
        result["documentation"] = {"records": documentation}
    out = identity_header()
    out["result"] = result
    return out


# --- build ----------------------------------------------------------------------


def _add_pset(f: Any, product: Any, name: str, properties: dict[str, Any]) -> None:
    pset = ifcopenshell.api.run("pset.add_pset", f, product=product, name=name)
    ifcopenshell.api.run("pset.edit_pset", f, pset=pset, properties=dict(properties))


def _add_qto(f: Any, product: Any, name: str, quantities: dict[str, float]) -> None:
    qto = ifcopenshell.api.run("pset.add_qto", f, product=product, name=name)
    ifcopenshell.api.run(
        "pset.edit_qto", f, qto=qto, properties={k: float(v) for k, v in quantities.items()}
    )


def op_build(req: dict[str, Any]) -> dict[str, Any]:
    model = req.get("model")
    if not isinstance(model, dict):
        raise OpError("ifc_invalid", "build requires a model object")

    import numpy as np
    from ifcopenshell.util.shape_builder import ShapeBuilder

    f = ifcopenshell.api.run("project.create_file", version="IFC4")
    f.header.file_name.time_stamp = FIXED_TIMESTAMP
    project = ifcopenshell.api.run(
        "root.create_entity", f, ifc_class="IfcProject", name=str(model.get("projectName", "Offisos"))
    )
    ifcopenshell.api.run("unit.assign_unit", f, length={"is_metric": True, "raw": "METERS"})
    # The unit assignment is an IFC SET — serialization order varies between
    # runs; pin it deterministically (byte-determinism requirement).
    for assignment in f.by_type("IfcUnitAssignment"):
        assignment.Units = tuple(sorted(assignment.Units or [], key=lambda u: str(u)))
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
    locked: set[int] = set()  # entity ids with caller-provided guids

    storeys: dict[str, Any] = {}
    for s in model.get("stories", []):
        storey = ifcopenshell.api.run(
            "root.create_entity", f, ifc_class="IfcBuildingStorey", name=s["name"] or ""
        )
        storey.GlobalId = s["guid"]
        locked.add(storey.id())
        ifcopenshell.api.run("aggregate.assign_object", f, products=[storey], relating_object=building)
        storey.Elevation = float(s["elevation"])
        _add_pset(f, storey, IDENTITY_PSET, dict(s["identity"]))
        _add_pset(f, storey, PARAMS_PSET, {"Height": float(s["height"])})
        storeys[s["guid"]] = storey

    walls: dict[str, Any] = {}
    for w in model.get("walls", []):
        wall = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcWall", name=w["name"] or "")
        wall.GlobalId = w["guid"]
        locked.add(wall.id())
        ifcopenshell.api.run(
            "spatial.assign_container", f, products=[wall], relating_structure=storeys[w["storyGuid"]]
        )
        rep = ifcopenshell.api.run(
            "geometry.add_wall_representation", f, context=body,
            length=float(w["length"]), height=float(w["height"]), thickness=float(w["thickness"]),
        )
        ifcopenshell.api.run("geometry.assign_representation", f, product=wall, representation=rep)
        # CAD-PARITY-014 (Issue #107): round the trig through r9 — numpy's
        # ufunc inner loops are SIMD-dispatched by CPU features at runtime,
        # so unrounded cos/sin differ in the last bits across CPU families
        # (a latent cross-host byte-nondeterminism exposed by the P014
        # pinned-sha test; the placement values round to 1e-9 — nanometre
        # scale, far inside the 1e-3 mm round-trip tolerance).
        cos_a, sin_a = r9(np.cos(float(w["angle"]))), r9(np.sin(float(w["angle"])))
        # The wall body profile spans local Y ∈ [0, t] (one-sided from the
        # placement origin); shift the placement origin by −n·t/2 so the body
        # maps to the canonical centred [-t/2, +t/2] (the import reconstructs
        # the axis at the profile bbox centre line).
        sx, sy = float(w["start"][0]), float(w["start"][1])
        tx = sx + sin_a * float(w["thickness"]) / 2.0
        ty = sy - cos_a * float(w["thickness"]) / 2.0
        ifcopenshell.api.run(
            "geometry.edit_object_placement", f, product=wall,
            matrix=(
                (cos_a, -sin_a, 0.0, tx),
                (sin_a, cos_a, 0.0, ty),
                (0.0, 0.0, 1.0, float(w["baseZ"])),
                (0.0, 0.0, 0.0, 1.0),
            ),
        )
        _add_pset(f, wall, IDENTITY_PSET, dict(w["identity"]))
        if w.get("qtos"):
            _add_qto(f, wall, "Qto_WallCommon", dict(w["qtos"]))
        if w.get("custom"):
            _add_pset(f, wall, CUSTOM_PSET, dict(w["custom"]))
        walls[w["guid"]] = wall

    for sl in model.get("slabs", []):
        slab = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSlab", name=sl["name"] or "")
        slab.GlobalId = sl["guid"]
        locked.add(slab.id())
        ifcopenshell.api.run(
            "spatial.assign_container", f, products=[slab], relating_structure=storeys[sl["storyGuid"]]
        )
        c1, c2 = sl["corner1"], sl["corner2"]
        x0, y0 = min(float(c1[0]), float(c2[0])), min(float(c1[1]), float(c2[1]))
        x1, y1 = max(float(c1[0]), float(c2[0])), max(float(c1[1]), float(c2[1]))
        rep = ifcopenshell.api.run(
            "geometry.add_slab_representation", f, context=body, depth=float(sl["thickness"]),
            polyline=[(x0, y0), (x1, y0), (x1, y1), (x0, y1)],
        )
        ifcopenshell.api.run("geometry.assign_representation", f, product=slab, representation=rep)
        ifcopenshell.api.run(
            "geometry.edit_object_placement", f, product=slab,
            matrix=(
                (1.0, 0.0, 0.0, 0.0),
                (0.0, 1.0, 0.0, 0.0),
                (0.0, 0.0, 1.0, float(sl["baseZ"])),
                (0.0, 0.0, 0.0, 1.0),
            ),
        )
        _add_pset(f, slab, IDENTITY_PSET, dict(sl["identity"]))
        if sl.get("qtos"):
            _add_qto(f, slab, "Qto_SlabCommon", dict(sl["qtos"]))
        if sl.get("custom"):
            _add_pset(f, slab, CUSTOM_PSET, dict(sl["custom"]))

    openings: dict[str, Any] = {}
    for op in model.get("openings", []):
        opening = ifcopenshell.api.run(
            "root.create_entity", f, ifc_class="IfcOpeningElement", name=op["name"] or ""
        )
        opening.GlobalId = op["guid"]
        locked.add(opening.id())
        # Void box convention (same as walls): profile XY = plan dimensions
        # (axis width x lateral through-cut thickness), extruded +Z by the
        # clear height. IfcRelVoidsElement NESTS the opening's placement
        # under the HOST WALL, so the placement is written in the HOST'S
        # frame with IDENTITY rotation: local T = (distance, -overhang, sill)
        # — the box then spans axis [d, d+w], lateral [-eps, t+eps] (the
        # through-cut centred on the wall), vertical [sill, sill+h].
        through = float(op["thickness"]) + OPENING_LATERAL_OVERHANG
        rect = builder.rectangle(size=np.array([float(op["width"]), through], dtype="float64"))
        item = builder.extrude(rect, float(op["height"]))
        rep = f.createIfcShapeRepresentation(body, "Body", "SweptSolid", item if isinstance(item, list) else [item])
        ifcopenshell.api.run("geometry.assign_representation", f, product=opening, representation=rep)
        ifcopenshell.api.run(
            "geometry.edit_object_placement", f, product=opening,
            matrix=(
                (1.0, 0.0, 0.0, float(op["distance"])),
                (0.0, 1.0, 0.0, -OPENING_LATERAL_OVERHANG / 2.0),
                (0.0, 0.0, 1.0, float(op["sill"])),
                (0.0, 0.0, 0.0, 1.0),
            ),
        )
        _add_pset(f, opening, IDENTITY_PSET, dict(op["identity"]))
        ifcopenshell.api.run("feature.add_feature", f, feature=opening, element=walls[op["hostGuid"]])
        openings[op["guid"]] = opening

    for kind, entries in (("door", model.get("doors", [])), ("window", model.get("windows", []))):
        ifc_class = "IfcDoor" if kind == "door" else "IfcWindow"
        for entry in entries:
            fill = ifcopenshell.api.run(
                "root.create_entity", f, ifc_class=ifc_class, name=entry["name"] or ""
            )
            fill.GlobalId = entry["guid"]
            locked.add(fill.id())
            ifcopenshell.api.run(
                "attribute.edit_attributes", f, product=fill,
                attributes={"OverallWidth": float(entry["overallWidth"]), "OverallHeight": float(entry["overallHeight"])},
            )
            ifcopenshell.api.run(
                "spatial.assign_container", f, products=[fill],
                relating_structure=storeys[entry["storyGuid"]],
            )
            _add_pset(f, fill, IDENTITY_PSET, dict(entry["identity"]))
            if entry.get("params"):
                _add_pset(f, fill, PARAMS_PSET, dict(entry["params"]))
            ifcopenshell.api.run("feature.add_filling", f, opening=openings[entry["openingGuid"]], element=fill)

    for sp in model.get("spaces", []):
        space = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSpace", name=sp["name"] or "")
        space.GlobalId = sp["guid"]
        locked.add(space.id())
        ifcopenshell.api.run(
            "aggregate.assign_object", f, products=[space], relating_object=storeys[sp["storyGuid"]]
        )
        pts = np.array([[float(p[0]), float(p[1]), 0.0] for p in sp["footprint"]], dtype="float64")
        poly = builder.polyline(pts, closed=True)
        rep = ifcopenshell.api.run(
            "geometry.add_footprint_representation", f, context=body, curves=[poly]
        )
        ifcopenshell.api.run("geometry.assign_representation", f, product=space, representation=rep)
        ifcopenshell.api.run(
            "geometry.edit_object_placement", f, product=space,
            matrix=(
                (1.0, 0.0, 0.0, float(sp["position"][0])),
                (0.0, 1.0, 0.0, float(sp["position"][1])),
                (0.0, 0.0, 1.0, float(sp["z"])),
                (0.0, 0.0, 0.0, 1.0),
            ),
        )
        _add_pset(f, space, IDENTITY_PSET, dict(sp["identity"]))
        _add_pset(f, space, PARAMS_PSET, {"Height": float(sp["height"])})
        _add_pset(f, space, "Pset_SpaceCommon", {"LongName": sp["longName"]})
        if sp.get("qtos"):
            _add_qto(f, space, "Qto_SpaceCommon", dict(sp["qtos"]))
        if sp.get("custom"):
            _add_pset(f, space, CUSTOM_PSET, dict(sp["custom"]))

    # --- COMPAT-BIM-003: materials ------------------------------------------------
    # IfcMaterial is NOT an IfcRoot (no GlobalId): identity provenance and the
    # canonical material properties ride as IfcMaterialProperties sets; the
    # canonical id in the identity set is the reconciliation key on re-import.
    def _add_material_pset(material: Any, name: str, properties: dict[str, Any]) -> None:
        props = []
        for key, value in dict(properties).items():
            if isinstance(value, bool):
                nominal = f.create_entity("IfcBoolean", value)
            elif isinstance(value, (int, float)):
                nominal = f.create_entity("IfcReal", float(value))
            else:
                nominal = f.create_entity("IfcLabel", str(value))
            props.append(f.create_entity("IfcPropertySingleValue", key, None, nominal, None))
        mp = f.create_entity("IfcMaterialProperties")
        mp.Material = material
        mp.Name = name
        mp.Properties = props

    materials_by_guid: dict[str, Any] = {}
    for m in model.get("materials", []):
        material = ifcopenshell.api.run(
            "material.add_material", f, name=str(m["name"]),
            description=str(m["description"]) if m.get("description") else None,
        )
        materials_by_guid[m["guid"]] = material
        _add_material_pset(material, IDENTITY_PSET, dict(m["identity"]))
        if m.get("properties"):
            _add_material_pset(material, MATERIAL_PSET, dict(m["properties"]))

    # --- COMPAT-BIM-003: component instances --------------------------------------
    # Freestanding parametric boxes: profile spans local [0, sx] × [0, sy]
    # (corner-anchored, like the opening void convention); the placement origin
    # is shifted by −R·(sx/2, sy/2) so the box maps to the canonical CENTERED
    # placement (the import reconstructs the centre from the profile bbox).
    component_products: dict[str, Any] = {}
    for c in model.get("components", []):
        ifc_class = COMPONENT_IFC_CLASS[str(c["category"])]
        comp = ifcopenshell.api.run("root.create_entity", f, ifc_class=ifc_class, name=c["name"] or "")
        comp.GlobalId = c["guid"]
        locked.add(comp.id())
        ifcopenshell.api.run(
            "spatial.assign_container", f, products=[comp], relating_structure=storeys[c["storyGuid"]]
        )
        sx, sy, sz = (float(c["size"][0]), float(c["size"][1]), float(c["size"][2]))
        rect = builder.rectangle(size=np.array([sx, sy], dtype="float64"))
        item = builder.extrude(rect, sz)
        rep = f.createIfcShapeRepresentation(body, "Body", "SweptSolid", item if isinstance(item, list) else [item])
        ifcopenshell.api.run("geometry.assign_representation", f, product=comp, representation=rep)
        if ifc_class in ("IfcDoor", "IfcWindow"):
            ifcopenshell.api.run(
                "attribute.edit_attributes", f, product=comp,
                attributes={"OverallWidth": sx, "OverallHeight": sz},
            )
        # CAD-PARITY-014 (Issue #107): the same r9 trig rounding (see the
        # wall placement note — cross-CPU byte-determinism).
        cos_r, sin_r = r9(np.cos(float(c["rotation"]))), r9(np.sin(float(c["rotation"])))
        px, py = float(c["position"][0]), float(c["position"][1])
        tx = px - (cos_r * sx / 2.0 - sin_r * sy / 2.0)
        ty = py - (sin_r * sx / 2.0 + cos_r * sy / 2.0)
        ifcopenshell.api.run(
            "geometry.edit_object_placement", f, product=comp,
            matrix=(
                (cos_r, -sin_r, 0.0, tx),
                (sin_r, cos_r, 0.0, ty),
                (0.0, 0.0, 1.0, float(c["baseZ"])),
                (0.0, 0.0, 0.0, 1.0),
            ),
        )
        _add_pset(f, comp, IDENTITY_PSET, dict(c["identity"]))
        _add_pset(f, comp, COMPONENT_PSET, dict(c["component"]))
        component_products[c["guid"]] = comp

    # Material associations (deterministic component order — sorted by the TS side).
    for c in model.get("components", []):
        if c.get("materialGuid"):
            ifcopenshell.api.run(
                "material.assign_material", f, products=[component_products[c["guid"]]],
                material=materials_by_guid[c["materialGuid"]],
            )

    # --- CAD-PARITY-014 (Issue #107): the documentation exchange carrier ------
    # One IfcGroup per documentation table record (D2): IfcGroup is an IfcRoot
    # (the caller guid is LOCKED like every product guid) AND an IfcObject
    # (psets attach through the standard path). Pset_OffisosIdentity carries
    # the identity provenance; Pset_OffisosDocs carries the record fields as
    # scalar property values (arrays pre-encoded as joined strings by the TS
    # side — the docmap encoding). Groups are created in the request's fixed
    # kind-group order (deterministic STEP ids); absent "documentation" (the
    # legacy model) creates nothing — the bytes stay byte-identical to the
    # pre-P014 export.
    documentation = model.get("documentation")
    if isinstance(documentation, dict):
        for g in documentation.get("groups", []):
            group = ifcopenshell.api.run("group.add_group", f, name=str(g["name"]))
            group.GlobalId = str(g["guid"])
            locked.add(group.id())
            _add_pset(f, group, IDENTITY_PSET, dict(g["identity"]))
            if g.get("fields"):
                _add_pset(f, group, DOCS_PSET, dict(g["fields"]))

    # Deterministic GlobalIds for every remaining IfcRoot (relationships,
    # psets, spatial structure): STEP-id-keyed normalization. Combined with
    # the fixed header timestamp, deterministic creation order and the
    # aggregate-order normalization below, this makes the generated bytes
    # byte-identical for equal inputs.
    for e in f.by_type("IfcRoot"):
        if e.id() in locked:
            continue
        e.GlobalId = det_root_guid(e.id())
    normalize_set_order(f)

    text = f.to_string()
    data = text.encode("utf-8")
    out = identity_header()
    out["ifc"] = base64.b64encode(data).decode("ascii")
    out["size"] = len(data)
    out["sha256"] = hashlib.sha256(data).hexdigest()
    return out


# --- ids ------------------------------------------------------------------------


def op_ids(req: dict[str, Any]) -> dict[str, Any]:
    if ifctester is None:
        raise OpError("ifc_unavailable", "IfcTester is not installed in this worker environment")
    try:
        raw = base64.b64decode(req["ifc"], validate=True)
    except Exception as e:
        raise OpError("ifc_invalid", f"ifc payload is not valid base64: {e}")
    ids_xml = req.get("ids")
    if not isinstance(ids_xml, str) or not ids_xml.strip():
        raise OpError("ifc_invalid", "ids requires a non-empty IDS XML string")
    try:
        text = raw.decode("utf-8")
        f = ifcopenshell.file.from_string(text)
        ids = Ids()
        import xml.etree.ElementTree as ET  # noqa: F401 — availability probe
        from ifctester.ids import from_string

        ids = from_string(ids_xml)
        ids.validate(f)
    except OpError:
        raise
    except Exception as e:
        raise OpError("ifc_invalid", f"IDS validation failed: {e}")

    specs: list[dict[str, Any]] = []
    for spec in ids.specifications:
        def guids(entities: Any) -> list[str]:
            out: list[str] = []
            for e in entities or []:
                gid = getattr(e, "GlobalId", None)
                if gid:
                    out.append(gid)
            return sorted(out)

        specs.append(
            {
                "name": spec.name or "",
                "status": "pass" if spec.status is True else "fail",
                "applicable": guids(spec.applicable_entities),
                "passed": guids(spec.passed_entities),
                "failed": guids(spec.failed_entities),
            }
        )
    specs.sort(key=lambda s: s["name"])
    out = identity_header()
    out["result"] = {"specs": specs}
    return out


# --- bcf ------------------------------------------------------------------------


def _det_uuid(salt: str, key: str) -> str:
    """Deterministic uuid-shaped value (the comment-guid precedent): sha256
    of the salted key truncated to 36 chars. bcf-client requires uuid-shaped
    guids; the sha256 hex alphabet is a subset, so this always validates."""
    return hashlib.sha256(f"{salt}:{key}".encode()).hexdigest()[:36]


def _deterministic_zip(data: bytes) -> bytes:
    """Rebuild a .bcf zip container with FIXED entry dates + sorted entry
    order (CAD-PARITY-014, D3).

    bcf-client's InMemoryZipFile writes every entry with the CURRENT wall
    clock (zipfile.ZipFile.writestr defaults date_time to now), so two
    builds of the same topics payload differ byte-wise. The post-process
    rebuilds the container in memory: every entry re-created with the fixed
    2026-01-01 date, entry order sorted by name (BCF readers locate entries
    by name — the order is a container detail). Bounded + documented: the
    payload bytes of every entry are copied VERBATIM (no re-serialization).
    """
    src = zipfile.ZipFile(io.BytesIO(data), "r")
    try:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as out:
            for name in sorted(src.namelist()):
                info = zipfile.ZipInfo(name, date_time=BCF_ZIP_DATE)
                info.compress_type = zipfile.ZIP_DEFLATED
                out.writestr(info, src.read(name))
        return buf.getvalue()
    finally:
        src.close()


def _viewpoint_of(
    i: int,
    t: dict[str, Any],
    refs: list[str],
) -> Any:
    """Build the topic's VisualizationInfo (CAD-PARITY-014, D3).

    With a viewpoint payload: the caller's camera (position/direction/up,
    perspective — or orthogonal with viewToWorldScale) + the selection
    components (the IfcGuid refs). Without one: the LEGACY origin-target
    camera (the pre-P014 add_viewpoint_from_point_and_guids semantics —
    camera at target+(5,5,5) looking back), reproduced with a deterministic
    guid so legacy payloads now build byte-identical containers too.
    Camera floats round to 9 decimals (the parse discipline r9).
    """
    import bcf.v3.model as bcf_model
    import bcf.v3.visinfo as bcf_visinfo

    guid = _det_uuid(BCF_VIEWPOINT_GUID_SALT, str(i))
    components = bcf_visinfo.build_components(*refs)
    payload = t.get("viewpoint")

    def vec(key: str) -> list[float]:
        v = payload.get(key) if isinstance(payload, dict) else None
        if not isinstance(v, list) or len(v) != 3:
            raise OpError("ifc_invalid", f"viewpoint.{key} must be a 3-number array")
        out = []
        for x in v:
            if not isinstance(x, (int, float)) or isinstance(x, bool):
                raise OpError("ifc_invalid", f"viewpoint.{key} must contain finite numbers")
            out.append(r9(float(x)))
        return out

    if isinstance(payload, dict):
        position, direction, up = vec("cameraViewPoint"), vec("cameraDirection"), vec("cameraUpVector")
        orthogonal = payload.get("orthogonal") is True
        if orthogonal:
            scale = payload.get("viewToWorldScale")
            if not isinstance(scale, (int, float)) or isinstance(scale, bool) or not (float(scale) > 0):
                raise OpError("ifc_invalid", "viewpoint.viewToWorldScale must be a positive number for orthogonal cameras")
            camera = bcf_model.OrthogonalCamera(
                camera_view_point=bcf_model.Point(x=position[0], y=position[1], z=position[2]),
                camera_direction=bcf_model.Direction(x=direction[0], y=direction[1], z=direction[2]),
                camera_up_vector=bcf_model.Direction(x=up[0], y=up[1], z=up[2]),
                view_to_world_scale=float(scale),
                aspect_ratio=1.0,
            )
            return bcf_model.VisualizationInfo(guid=guid, components=components, orthogonal_camera=camera)
        camera = bcf_model.PerspectiveCamera(
            camera_view_point=bcf_model.Point(x=position[0], y=position[1], z=position[2]),
            camera_direction=bcf_model.Direction(x=direction[0], y=direction[1], z=direction[2]),
            camera_up_vector=bcf_model.Direction(x=up[0], y=up[1], z=up[2]),
            aspect_ratio=1.0,
            field_of_view=60.0,
        )
        return bcf_model.VisualizationInfo(guid=guid, components=components, perspective_camera=camera)

    # Legacy path: the origin-target camera of
    # add_viewpoint_from_point_and_guids(np.zeros(3), *refs).
    import numpy as np

    target = np.array([0.0, 0.0, 0.0], dtype="float64")
    position, direction, up = bcf_visinfo.camera_vectors_from_target_position(target)
    camera = bcf_model.PerspectiveCamera(
        camera_view_point=bcf_model.Point(x=r9(position[0]), y=r9(position[1]), z=r9(position[2])),
        camera_direction=bcf_model.Direction(x=r9(direction[0]), y=r9(direction[1]), z=r9(direction[2])),
        camera_up_vector=bcf_model.Direction(x=r9(up[0]), y=r9(up[1]), z=r9(up[2])),
        aspect_ratio=1.0,
        field_of_view=60.0,
    )
    return bcf_model.VisualizationInfo(guid=guid, components=components, perspective_camera=camera)


def op_bcf_build(req: dict[str, Any]) -> dict[str, Any]:
    topics = req.get("topics")
    if not isinstance(topics, list) or len(topics) == 0:
        raise OpError("ifc_invalid", "bcf_build requires a non-empty topics array")
    try:
        import os
        import tempfile
        from pathlib import Path

        import numpy as np  # noqa: F401 — bcf.v3.visinfo imports numpy
        from bcf.v3 import bcfxml as bcf_v3
        import bcf.v3.model as bcf_model
        import bcf.v3.visinfo as bcf_visinfo  # noqa: F401 — viewpoint construction
        from xsdata.models.datatype import XmlDateTime
    except Exception as e:
        raise OpError("ifc_unavailable", f"bcf-client is not available: {e}")

    try:
        bcf = bcf_v3.BcfXml()
        for i, t in enumerate(topics):
            refs = [str(g) for g in t.get("references", [])]
            handler = bcf.add_topic(
                title=str(t["title"]),
                description=str(t["description"]),
                author=str(t.get("author", "offisos")),
                topic_type=str(t.get("type", "Issue")),
                topic_status=str(t.get("status", "Open")),
            )
            # CAD-PARITY-014 (D3): deterministic topic identity + creation
            # date — add_topic() draws a uuid4 and stamps NOW, so both are
            # replaced with salted-sha256/fixed-date values and the topics
            # map is re-keyed AND the handler's topic_dir repointed (the
            # dir name is the saved container's topic path — it must match
            # the topic guid for save AND load to agree).
            det_topic_guid = _det_uuid(BCF_TOPIC_GUID_SALT, str(i))
            random_topic_guid = handler.topic.guid
            handler.topic.guid = det_topic_guid
            handler.topic.creation_date = XmlDateTime(2026, 1, 1, 0, 0, 0)
            handler._topic_dir = Path(det_topic_guid)
            if random_topic_guid in bcf.topics:
                del bcf.topics[random_topic_guid]
            bcf.topics[det_topic_guid] = handler

            # The viewpoint (payload camera or the legacy origin camera) —
            # always with a deterministic guid; the selection components
            # keep carrying the IfcGuid refs.
            vi_handler = bcf_visinfo.VisualizationInfoHandler(
                visualization_info=_viewpoint_of(i, t, refs)
            )
            handler.add_visinfo_handler(vi_handler)

            # CAD-PARITY-014 (D3): the source lineage. The BCF 3.0 Topic
            # has a conformant document-reference list — the source revision
            # (the caller-chosen canonical model state reference) rides as
            # one DocumentReference: description = the marker, url = the
            # revision identity, guid = the deterministic salted value.
            source_revision = t.get("sourceRevision")
            if isinstance(source_revision, str) and source_revision:
                handler.topic.document_references = bcf_model.TopicDocumentReferences(
                    document_reference=[
                        bcf_model.DocumentReference(
                            guid=_det_uuid(BCF_DOCREF_GUID_SALT, str(i)),
                            url=source_revision,
                            description=BCF_SOURCE_REVISION_MARKER,
                        )
                    ]
                )

            comment_text = t.get("comment")
            if isinstance(comment_text, str) and comment_text:
                comment = bcf_model.Comment(
                    guid=_det_uuid(BCF_COMMENT_GUID_SALT, str(i)),
                    comment=comment_text,
                    date=XmlDateTime(2026, 1, 1, 0, 0, 0),
                    author=str(t.get("commentAuthor", "offisos")),
                )
                handler.topic.comments = bcf_model.TopicComments(comment=[comment])
        fd, path = tempfile.mkstemp(suffix=".bcf")
        os.close(fd)
        try:
            bcf.save(path)
            with open(path, "rb") as fh:
                data = fh.read()
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass
        # The container determinism post-process (see
        # _deterministic_zip): fixed entry dates + sorted entry order.
        data = _deterministic_zip(data)
    except OpError:
        raise
    except Exception as e:
        raise OpError("ifc_invalid", f"BCF build failed: {e}")

    out = identity_header()
    out["bcf"] = base64.b64encode(data).decode("ascii")
    out["size"] = len(data)
    return out


def _camera_of(vis: Any) -> dict[str, Any] | None:
    """The parsed camera viewpoint of a VisualizationInfo (D3): position/
    direction/up + the perspective/orthogonal distinction. Values round to 9
    decimals (the r9 parse discipline — cross-host XML float stability)."""
    import bcf.v3.model as bcf_model

    camera = getattr(vis, "perspective_camera", None)
    orthogonal = False
    if camera is None:
        camera = getattr(vis, "orthogonal_camera", None)
        orthogonal = camera is not None
    if camera is None:
        return None
    scale = getattr(camera, "view_to_world_scale", None) if orthogonal else None

    def vec3(p: Any) -> list[float]:
        return [r9(float(p.x)), r9(float(p.y)), r9(float(p.z))]

    return {
        "cameraViewPoint": vec3(camera.camera_view_point),
        "cameraDirection": vec3(camera.camera_direction),
        "cameraUpVector": vec3(camera.camera_up_vector),
        "orthogonal": orthogonal,
        "viewToWorldScale": r9(float(scale)) if scale is not None else None,
    }


def op_bcf_parse(req: dict[str, Any]) -> dict[str, Any]:
    try:
        raw = base64.b64decode(req["bcf"], validate=True)
    except Exception as e:
        raise OpError("ifc_invalid", f"bcf payload is not valid base64: {e}")
    try:
        import os
        import tempfile

        from bcf.v3 import bcfxml as bcf_v3

        fd, path = tempfile.mkstemp(suffix=".bcf")
        os.close(fd)
        try:
            with open(path, "wb") as fh:
                fh.write(raw)
            bcf = bcf_v3.BcfXml(path)
            topics: list[dict[str, Any]] = []
            for key in sorted(bcf.topics.keys()):
                h = bcf.get_topic(key)
                topic = h.topic
                references: list[str] = []
                # CAD-PARITY-014 (D3): the camera of the topic's FIRST
                # viewpoint in sorted filename order (one viewpoint per
                # topic in this writer — the bounded selection rule).
                viewpoint: dict[str, Any] | None = None
                for vp_name in sorted(h.viewpoints.keys()):
                    vis = h.viewpoints[vp_name].visualization_info
                    if vis is None:
                        continue
                    if viewpoint is None:
                        viewpoint = _camera_of(vis)
                    for component in vis.components.selection.component:
                        if component.ifc_guid:
                            references.append(component.ifc_guid)
                # CAD-PARITY-014 (D3): the source lineage — the marker'd
                # document reference (first match in document order).
                source_revision: str | None = None
                docrefs = getattr(topic, "document_references", None)
                for ref in docrefs.document_reference if docrefs else []:
                    if ref.description == BCF_SOURCE_REVISION_MARKER and ref.url:
                        source_revision = str(ref.url)
                        break
                comments = [
                    {
                        "author": c.author or "",
                        "comment": c.comment or "",
                        "date": str(c.date) if c.date else "",
                    }
                    for c in h.comments
                ]
                topics.append(
                    {
                        "guid": topic.guid,
                        "title": topic.title or "",
                        "description": topic.description or "",
                        "type": topic.topic_type or "",
                        "status": topic.topic_status or "",
                        "comments": comments,
                        "references": sorted(set(references)),
                        "viewpoint": viewpoint,
                        "sourceRevision": source_revision,
                    }
                )
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass
    except OpError:
        raise
    except Exception as e:
        raise OpError("ifc_invalid", f"BCF parse failed: {e}")

    out = identity_header()
    out["topics"] = topics
    return out


# --- main -----------------------------------------------------------------------


OPS = {
    "ping": lambda req: identity_header(),
    "parse": op_parse,
    "build": op_build,
    "ids": op_ids,
    "bcf_build": op_bcf_build,
    "bcf_parse": op_bcf_parse,
}


def main() -> None:
    try:
        line = sys.stdin.readline()
        if not line.strip():
            print(json.dumps(fail("ifc_invalid", "no request on stdin"), separators=(",", ":")))
            return
        req = json.loads(line)
        op = req.get("op")
        handler = OPS.get(op)
        if handler is None:
            print(json.dumps(fail("ifc_invalid", f"unknown op {op!r}"), separators=(",", ":")))
            return
        result = handler(req)
        print(json.dumps(result, separators=(",", ":")))
    except OpError as e:
        print(json.dumps(fail(e.code, e.message), separators=(",", ":")))
    except Exception as e:  # never a traceback on stdout — typed failure only
        import traceback as _tb
        _tb.print_exc(file=sys.stderr)  # diagnostics for the parent (bounded there)
        print(json.dumps(fail("engine_error", f"{type(e).__name__}: {e}"), separators=(",", ":")))


if __name__ == "__main__":
    main()
