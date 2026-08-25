"""IfcOpenShell-backed implementation of the Offisos CAD/BIM adapter.

This is the *real* candidate engine adapter: IfcOpenShell 0.8.x for IFC
authoring/parsing/round-trip and OCCT (via cadquery-ocp) for exact BRep
geometry used in quantity calculation. Every engine import lives in this
package — nothing leaks to domain code.

Design notes
------------
- Engine-native GlobalIds are engine-assigned. The Offisos domain identity
  is written to the file as a property set (``Pset_OffisosIdentity``) so it
  survives round-trips; the Construction Graph benchmark demonstrates that
  GlobalIds are NOT stable across model regeneration and therefore must
  never be canonical.
- Quantities are CALCULATED from exact OCCT BRep geometry (boolean cut of
  openings, ``BRepGProp`` volume/area integration) at creation time and
  exported as IFC quantity sets. On import, quantities are OBSERVED from
  the file; elements without a quantity basis get UNKNOWN — never zeros.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.element as ifc_element_utils
import numpy as np

from ..adapter import (
    CadBimAdapter,
    DomainElement,
    DomainModel,
    DomainQuantity,
    InvalidInputError,
    QuantityState,
)

IDENTITY_PSET = "Pset_OffisosIdentity"


class IfcOpenShellAdapter(CadBimAdapter):
    engine_id = "ifcopenshell+occt"
    engine_version = f"ifcopenshell {ifcopenshell.version}"

    def __init__(self, schema: str = "IFC4"):
        self.schema = schema

    # ------------------------------------------------------------------
    # internal helpers
    # ------------------------------------------------------------------

    def _new_file(self) -> None:
        f = ifcopenshell.api.run("project.create_file", version=self.schema)
        project = ifcopenshell.api.run(
            "root.create_entity", f, ifc_class="IfcProject", name="Offisos Benchmark Project"
        )
        # INTEROPERABILITY FINDING (recorded in bench_bim_semantics):
        # ifcopenshell's default project length unit is MILLIMETRE, while its
        # geometry/placement APIs take metres. The adapter therefore pins the
        # project length unit to METRE explicitly so that representation
        # geometry, placements and quantity values share one unit system.
        ifcopenshell.api.run(
            "unit.assign_unit", f, length={"is_metric": True, "raw": "METERS"}
        )
        ctx = ifcopenshell.api.run("context.add_context", f, context_type="Model")
        body = ifcopenshell.api.run(
            "context.add_context",
            f,
            context_type="Model",
            context_identifier="Body",
            target_view="MODEL_VIEW",
            parent=ctx,
        )
        site = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSite", name="Site")
        building = ifcopenshell.api.run(
            "root.create_entity", f, ifc_class="IfcBuilding", name="Building"
        )
        storey = ifcopenshell.api.run(
            "root.create_entity", f, ifc_class="IfcBuildingStorey", name="Storey"
        )
        ifcopenshell.api.run("aggregate.assign_object", f, products=[site], relating_object=project)
        ifcopenshell.api.run("aggregate.assign_object", f, products=[building], relating_object=site)
        ifcopenshell.api.run("aggregate.assign_object", f, products=[storey], relating_object=building)
        self._f = f
        self._body = body
        self._storey = storey

    def _body_context(self):
        return self._body

    def _place(self, product, x: float, y: float, z: float = 0.0) -> None:
        ifcopenshell.api.run(
            "geometry.edit_object_placement",
            self._f,
            product=product,
            matrix=(
                (1.0, 0.0, 0.0, x),
                (0.0, 1.0, 0.0, y),
                (0.0, 0.0, 1.0, z),
                (0.0, 0.0, 0.0, 1.0),
            ),
        )

    def _add_pset(self, product, pset_name: str, properties: dict[str, Any]) -> None:
        f = self._f
        pset = ifcopenshell.api.run("pset.add_pset", f, product=product, name=pset_name)
        # Plain values: the engine wraps them into IFC primitives.
        ifcopenshell.api.run("pset.edit_pset", f, pset=pset, properties=dict(properties))

    def _add_qto(self, product, qto_name: str, quantities: dict[str, float]) -> None:
        f = self._f
        qto = ifcopenshell.api.run("pset.add_qto", f, product=product, name=qto_name)
        # Plain floats: the engine infers the quantity type from the qto template.
        ifcopenshell.api.run(
            "pset.edit_qto", f, qto=qto, properties={k: float(v) for k, v in quantities.items()}
        )

    def _write_identity(self, element: DomainElement, product) -> None:
        self._add_pset(
            product,
            IDENTITY_PSET,
            {
                "DomainId": element.domain_id,
                "DomainKind": element.kind,
                "SourceEngine": element.source.get("engine", self.engine_id),
                "ModelRevision": element.source.get("model_revision", ""),
            },
        )

    @staticmethod
    def _occt_volume(shapes) -> float:
        """Exact BRep volume via OCCT mass properties."""
        from OCP.GProp import GProp_GProps
        from OCP.BRepGProp import BRepGProp

        props = GProp_GProps()
        for shape in shapes:
            BRepGProp.VolumeProperties_s(shape, props, True)
        return props.Mass()

    def _occt_wall_solids(self, length: float, height: float, thickness: float,
                          openings: list[dict[str, Any]]):
        """Build the wall BRep with openings cut (real OCCT booleans).

        Returns a list of solids (possibly one compound) whose total volume
        is the wall NET volume; the gross solid is also returned separately.
        """
        from OCP.gp import gp_Pnt
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
        from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut

        gross = BRepPrimAPI_MakeBox(
            gp_Pnt(0.0, -thickness / 2.0, 0.0), length, thickness, height
        ).Shape()
        net = gross
        for o in openings:
            void = BRepPrimAPI_MakeBox(
                gp_Pnt(o["x"] - o["width"] / 2.0, -thickness / 2.0 - 0.001, o["sill"]),
                o["width"],
                thickness + 0.002,
                o["height"],
            ).Shape()
            cut = BRepAlgoAPI_Cut(net, void)
            if not cut.IsDone():
                raise InvalidInputError(
                    f"OCCT boolean cut failed for opening at x={o['x']}"
                )
            net = cut.Shape()
        return gross, net

    def _opening_box_representation(self, width: float, height: float, depth: float):
        """A rectangular-prism representation used for IfcOpeningElement."""
        from ifcopenshell.util.shape_builder import ShapeBuilder

        builder = ShapeBuilder(self._f)
        rect = builder.rectangle(size=np.array([width, height]))
        return builder.extrude(
            rect, depth, extrusion_vector=(0.0, 1.0, 0.0)
        )

    # ------------------------------------------------------------------
    # model lifecycle
    # ------------------------------------------------------------------

    def create_model(self, model_id: str) -> DomainModel:
        self._new_file()
        return DomainModel(
            model_id=model_id,
            source_engine=self.engine_id,
            source_revision=model_id,
        )

    def add_wall(
        self,
        model: DomainModel,
        domain_id: str,
        name: str,
        x0: float,
        y0: float,
        x1: float,
        y1: float,
        height: float,
        thickness: float,
        openings: Optional[list[dict[str, Any]]] = None,
        properties: Optional[dict[str, Any]] = None,
    ) -> DomainElement:
        f = self._f
        openings = openings or []
        length = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5

        wall = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcWall", name=name)
        ifcopenshell.api.run(
            "spatial.assign_container", f, products=[wall], relating_structure=self._storey
        )
        representation = ifcopenshell.api.run(
            "geometry.add_wall_representation",
            f,
            context=self._body_context(),
            length=length,
            height=height,
            thickness=thickness,
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", f, product=wall, representation=representation
        )
        self._place(wall, x0, y0, 0.0)

        # semantic openings voiding the wall (IFC-correct modeling)
        for i, o in enumerate(openings):
            opening = ifcopenshell.api.run(
                "root.create_entity", f, ifc_class="IfcOpeningElement", name=f"{name}-opening-{i+1}"
            )
            item = self._opening_box_representation(o["width"], o["height"], thickness + 0.002)
            items = item if isinstance(item, list) else [item]
            opening_rep = f.createIfcShapeRepresentation(
                self._body_context(), "Body", "SweptSolid", items
            )
            ifcopenshell.api.run(
                "geometry.assign_representation",
                f,
                product=opening,
                representation=opening_rep,
            )
            self._place(opening, o["x"] - o["width"] / 2.0, y0 - thickness / 2.0 - 0.001, o["sill"])
            ifcopenshell.api.run("feature.add_feature", f, feature=opening, element=wall)

            # fill the opening with a door/window when the opening has a kind
            kind = o.get("kind")
            if kind in ("door", "window"):
                ifc_class = "IfcDoor" if kind == "door" else "IfcWindow"
                filling = ifcopenshell.api.run(
                    "root.create_entity",
                    f,
                    ifc_class=ifc_class,
                    name=f"{name}-{kind}-{i+1}",
                )
                ifcopenshell.api.run(
                    "attribute.edit_attributes",
                    f,
                    product=filling,
                    attributes={"OverallWidth": o["width"], "OverallHeight": o["height"]},
                )
                ifcopenshell.api.run(
                    "spatial.assign_container",
                    f,
                    products=[filling],
                    relating_structure=self._storey,
                )
                ifcopenshell.api.run(
                    "feature.add_filling", f, opening=opening, element=filling
                )
                filling_element = DomainElement(
                    domain_id=f"{domain_id}:{kind}-{i+1}",
                    kind=kind,
                    name=f"{name}-{kind}-{i+1}",
                    source={
                        "engine": self.engine_id,
                        "engine_id": filling.GlobalId,
                        "engine_class": ifc_class,
                        "model_revision": model.source_revision,
                    },
                    domain_quantities={},
                )
                filling_element.domain_quantities["OverallDimensions"] = DomainQuantity(
                    "OverallDimensions", o["width"] * o["height"],
                    QuantityState.OBSERVED,
                    basis="OverallWidth x OverallHeight IFC attributes",
                )
                self._write_identity(filling_element, filling)
                model.elements.append(filling_element)
                model.relationships.append(
                    {
                        "type": "fills",
                        "opening_of_wall": domain_id,
                        "filling_domain_id": filling_element.domain_id,
                        "kind": kind,
                    }
                )

        if properties:
            self._add_pset(wall, "Pset_WallCommon", properties)

        # quantities: CALCULATED from exact OCCT BRep geometry
        gross, net = self._occt_wall_solids(length, height, thickness, openings)
        gross_volume = self._occt_volume([gross])
        net_volume = self._occt_volume([net])
        gross_side_area = length * height
        net_side_area = gross_side_area - sum(o["width"] * o["height"] for o in openings)
        opening_volume = gross_volume - net_volume

        element = DomainElement(
            domain_id=domain_id,
            kind="wall",
            name=name,
            source={
                "engine": self.engine_id,
                "engine_id": wall.GlobalId,
                "engine_class": "IfcWall",
                "model_revision": model.source_revision,
            },
            domain_quantities={
                "GrossVolume": DomainQuantity(
                    "GrossVolume", gross_volume, QuantityState.CALCULATED,
                    basis="OCCT BRep volume of extruded wall solid",
                ),
                "NetVolume": DomainQuantity(
                    "NetVolume", net_volume, QuantityState.CALCULATED,
                    basis="OCCT BRep volume after boolean cut of openings",
                ),
                "OpeningsVolume": DomainQuantity(
                    "OpeningsVolume", opening_volume, QuantityState.CALCULATED,
                    basis="gross - net (OCCT booleans)",
                ),
                "GrossSideArea": DomainQuantity(
                    "GrossSideArea", gross_side_area, QuantityState.CALCULATED,
                    basis="length x height",
                ),
                "NetSideArea": DomainQuantity(
                    "NetSideArea", net_side_area, QuantityState.CALCULATED,
                    basis="gross side area minus opening rectangles",
                ),
                "Length": DomainQuantity(
                    "Length", length, QuantityState.CALCULATED, basis="fixture geometry"
                ),
                "Height": DomainQuantity(
                    "Height", height, QuantityState.CALCULATED, basis="fixture geometry"
                ),
                "Width": DomainQuantity(
                    "Width", thickness, QuantityState.CALCULATED, basis="fixture geometry"
                ),
            },
        )
        self._write_identity(element, wall)
        self._add_qto(
            wall,
            "Qto_WallCommon",
            {
                "GrossVolume": gross_volume,
                "NetVolume": net_volume,
                "GrossSideArea": gross_side_area,
                "NetSideArea": net_side_area,
                "Height": height,
                "Length": length,
                "Width": thickness,
            },
        )
        model.elements.append(element)
        for i, o in enumerate(openings):
            model.relationships.append(
                {
                    "type": "voids",
                    "wall_domain_id": domain_id,
                    "opening_index": i,
                    "kind": o.get("kind", "opening"),
                }
            )
        return element

    def add_slab(
        self,
        model: DomainModel,
        domain_id: str,
        name: str,
        width: float,
        length: float,
        thickness: float,
        z: float = 0.0,
    ) -> DomainElement:
        f = self._f
        slab = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSlab", name=name)
        ifcopenshell.api.run(
            "spatial.assign_container", f, products=[slab], relating_structure=self._storey
        )
        representation = ifcopenshell.api.run(
            "geometry.add_slab_representation",
            f,
            context=self._body_context(),
            depth=thickness,
            polyline=[(0.0, 0.0), (length, 0.0), (length, width), (0.0, width)],
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", f, product=slab, representation=representation
        )
        self._place(slab, 0.0, 0.0, z - thickness)

        volume = length * width * thickness
        element = DomainElement(
            domain_id=domain_id,
            kind="slab",
            name=name,
            source={
                "engine": self.engine_id,
                "engine_id": slab.GlobalId,
                "engine_class": "IfcSlab",
                "model_revision": model.source_revision,
            },
            domain_quantities={
                "GrossVolume": DomainQuantity(
                    "GrossVolume", volume, QuantityState.CALCULATED,
                    basis="length x width x thickness",
                ),
            },
        )
        self._write_identity(element, slab)
        self._add_qto(slab, "Qto_SlabCommon", {"GrossVolume": volume})
        model.elements.append(element)
        return element

    def add_space(
        self,
        model: DomainModel,
        domain_id: str,
        name: str,
        width: float,
        length: float,
        properties: Optional[dict[str, Any]] = None,
    ) -> DomainElement:
        f = self._f
        space = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSpace", name=name)
        # IfcSpace joins the spatial structure via IfcRelAggregates (decomposition),
        # not IfcRelContainedInSpatialStructure (IFC4 spatial hierarchy rule).
        ifcopenshell.api.run(
            "aggregate.assign_object", f, products=[space], relating_object=self._storey
        )
        from ifcopenshell.util.shape_builder import ShapeBuilder

        builder = ShapeBuilder(f)
        polyline = builder.polyline(
            np.array([(0.0, 0.0, 0.0), (length, 0.0, 0.0), (length, width, 0.0), (0.0, width, 0.0)]),
            closed=True,
        )
        footprint = ifcopenshell.api.run(
            "geometry.add_footprint_representation",
            f,
            context=self._body_context(),
            curves=[polyline],
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", f, product=space, representation=footprint
        )
        if properties:
            self._add_pset(space, "Pset_SpaceCommon", properties)

        area = length * width
        element = DomainElement(
            domain_id=domain_id,
            kind="space",
            name=name,
            source={
                "engine": self.engine_id,
                "engine_id": space.GlobalId,
                "engine_class": "IfcSpace",
                "model_revision": model.source_revision,
            },
            domain_quantities={
                "GrossFloorArea": DomainQuantity(
                    "GrossFloorArea", area, QuantityState.CALCULATED,
                    basis="length x width footprint",
                ),
            },
        )
        self._write_identity(element, space)
        self._add_qto(space, "Qto_SpaceCommon", {"GrossFloorArea": area})
        model.elements.append(element)
        return element

    # ------------------------------------------------------------------
    # persistence
    # ------------------------------------------------------------------

    def export_ifc(self, model: DomainModel, path: str) -> None:
        try:
            self._f.write(path)
        except Exception as exc:
            raise InvalidInputError(f"IFC export failed: {exc}") from exc

    def import_ifc(self, path: str, model_id: str) -> DomainModel:
        try:
            f = ifcopenshell.open(path)
        except Exception as exc:
            raise InvalidInputError(f"IFC import failed for '{path}': {exc}") from exc

        model = DomainModel(
            model_id=model_id,
            source_engine=self.engine_id,
            source_revision=Path(path).stem,
        )
        classes = {
            "IfcWall": "wall",
            "IfcSlab": "slab",
            "IfcSpace": "space",
            "IfcDoor": "door",
            "IfcWindow": "window",
            "IfcOpeningElement": "opening",
        }
        for ifc_class, kind in classes.items():
            for product in f.by_type(ifc_class):
                all_psets = ifc_element_utils.get_psets(product, qtos_only=False)
                identity = {}
                props: dict[str, Any] = {}
                quantities: dict[str, Any] = {}
                for pset_name, values in all_psets.items():
                    if not isinstance(values, dict):
                        continue
                    if pset_name == IDENTITY_PSET:
                        identity = values
                    elif pset_name.startswith("Qto_"):
                        quantities.update(values)
                    else:
                        props.update(
                            {k: v for k, v in values.items() if k not in ("id", "HasProperties")}
                        )
                domain_id = identity.get("DomainId", "")
                if not domain_id:
                    # element carries no Offisos identity: remains unassigned;
                    # the Construction Graph mapper decides its fate — never a
                    # fabricated mapping.
                    domain_id = ""
                element = DomainElement(
                    domain_id=domain_id,
                    kind=kind,
                    name=product.Name or "",
                    properties=props,
                    source={
                        "engine": self.engine_id,
                        "engine_id": product.GlobalId,
                        "engine_class": ifc_class,
                        "model_revision": model.source_revision,
                        "identity_pset_found": bool(identity),
                    },
                )
                for qname, qvalue in quantities.items():
                    if isinstance(qvalue, (int, float)) and qvalue is not None:
                        element.domain_quantities[qname] = DomainQuantity(
                            qname, float(qvalue), QuantityState.OBSERVED,
                            basis=f"quantity set value read from {path}",
                        )
                if kind in ("door", "window") and not element.domain_quantities:
                    # doors/windows without quantity sets: width/height are
                    # native IFC attributes, observable
                    oh = getattr(product, "OverallHeight", None)
                    ow = getattr(product, "OverallWidth", None)
                    if oh and ow:
                        element.domain_quantities["OverallDimensions"] = DomainQuantity(
                            "OverallDimensions", float(oh) * float(ow),
                            QuantityState.OBSERVED,
                            basis="OverallHeight x OverallWidth IFC attributes",
                        )
                model.elements.append(element)

        for rel in f.by_type("IfcRelVoidsElement"):
            model.relationships.append(
                {
                    "type": "voids",
                    "element_engine_id": rel.RelatingBuildingElement.GlobalId
                    if rel.RelatingBuildingElement
                    else None,
                    "opening_engine_id": rel.RelatedOpeningElement.GlobalId
                    if rel.RelatedOpeningElement
                    else None,
                }
            )
        for rel in f.by_type("IfcRelFillsElement"):
            model.relationships.append(
                {
                    "type": "fills",
                    "opening_engine_id": rel.RelatingOpeningElement.GlobalId
                    if rel.RelatingOpeningElement
                    else None,
                    "element_engine_id": rel.RelatedBuildingElement.GlobalId
                    if rel.RelatedBuildingElement
                    else None,
                }
            )
        return model

    # ------------------------------------------------------------------
    # quantities
    # ------------------------------------------------------------------

    def extract_quantities(self, model: DomainModel) -> None:
        """Fill domain_quantities for elements that lack them.

        For created models quantities are populated at creation
        (CALCULATED via OCCT). For imported models they are OBSERVED from
        quantity sets in ``import_ifc``. Anything still missing is recorded
        as UNKNOWN — never fabricated.
        """
        for element in model.elements:
            if not element.domain_quantities:
                element.domain_quantities["NetVolume"] = DomainQuantity.unknown(
                    "NetVolume",
                    basis="no quantity set and no geometric basis available on import",
                )
