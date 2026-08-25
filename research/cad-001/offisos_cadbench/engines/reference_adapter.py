"""Pure-Python reference implementation of the Offisos CAD/BIM adapter.

This adapter exists to prove the replacement path required by
RESEARCH-CAD-001 evidence item 9 ("adapter/replacement proof"):

- It implements the exact same :class:`~offisos_cadbench.adapter.CadBimAdapter`
  contract as the IfcOpenShell+OCCT adapter.
- It uses **no CAD engine at all** — quantities are computed analytically
  and "IFC" persistence is a deterministic JSON sidecar. It is a reference
  implementation for contract verification, NOT a production candidate.

If the identical domain-level test suite passes through both adapters with
identical results, the domain layer demonstrably does not depend on the
engine behind the adapter — swapping engines requires only a new adapter
implementation. (Whether a *specific* replacement engine satisfies
professional CAD/BIM capability is a separate, engine-specific question
answered by the other benchmarks.)
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from ..adapter import (
    CadBimAdapter,
    DomainElement,
    DomainModel,
    DomainQuantity,
    InvalidInputError,
    QuantityState,
    UnsupportedOperationError,
)


class ReferenceAdapter(CadBimAdapter):
    engine_id = "reference-python"
    engine_version = "1.0.0 (benchmark reference implementation)"

    def __init__(self) -> None:
        self._store: dict[str, dict[str, Any]] = {}

    # ------------------------------------------------------------------
    # model lifecycle
    # ------------------------------------------------------------------

    def create_model(self, model_id: str) -> DomainModel:
        self._store = {"model_id": model_id, "elements": [], "relationships": []}
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
        openings = openings or []
        length = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        gross_volume = length * thickness * height
        openings_volume = sum(o["width"] * o["height"] * thickness for o in openings)
        net_volume = gross_volume - openings_volume
        gross_side_area = length * height
        net_side_area = gross_side_area - sum(o["width"] * o["height"] for o in openings)

        element = DomainElement(
            domain_id=domain_id,
            kind="wall",
            name=name,
            properties=dict(properties or {}),
            source={
                "engine": self.engine_id,
                "engine_id": f"ref:{domain_id}",
                "engine_class": "ReferenceWall",
                "model_revision": model.source_revision,
            },
            domain_quantities={
                "GrossVolume": DomainQuantity(
                    "GrossVolume", gross_volume, QuantityState.CALCULATED,
                    basis="analytic length x thickness x height",
                ),
                "NetVolume": DomainQuantity(
                    "NetVolume", net_volume, QuantityState.CALCULATED,
                    basis="analytic gross minus opening rectangles",
                ),
                "OpeningsVolume": DomainQuantity(
                    "OpeningsVolume", openings_volume, QuantityState.CALCULATED,
                    basis="analytic sum of opening boxes",
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
        model.elements.append(element)
        # fillings parity with the IFC adapter: openings with a kind produce
        # door/window domain elements
        for i, o in enumerate(openings):
            kind = o.get("kind")
            if kind in ("door", "window"):
                filling = DomainElement(
                    domain_id=f"{domain_id}:{kind}-{i+1}",
                    kind=kind,
                    name=f"{name}-{kind}-{i+1}",
                    source={
                        "engine": self.engine_id,
                        "engine_id": f"ref:{domain_id}:{kind}-{i+1}",
                        "engine_class": "ReferenceDoor" if kind == "door" else "ReferenceWindow",
                        "model_revision": model.source_revision,
                    },
                    domain_quantities={
                        "OverallDimensions": DomainQuantity(
                            "OverallDimensions", o["width"] * o["height"],
                            QuantityState.OBSERVED,
                            basis="OverallWidth x OverallHeight attribute parity",
                        ),
                    },
                )
                model.elements.append(filling)
                model.relationships.append(
                    {
                        "type": "fills",
                        "opening_of_wall": domain_id,
                        "filling_domain_id": filling.domain_id,
                        "kind": kind,
                    }
                )
        self._store["elements"].append(
            {
                "domain_id": domain_id,
                "kind": "wall",
                "name": name,
                "geometry": {
                    "x0": x0, "y0": y0, "x1": x1, "y1": y1,
                    "height": height, "thickness": thickness,
                    "openings": openings,
                },
                "properties": dict(properties or {}),
            }
        )
        for i, _o in enumerate(openings):
            model.relationships.append(
                {"type": "voids", "wall_domain_id": domain_id, "opening_index": i}
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
        volume = length * width * thickness
        element = DomainElement(
            domain_id=domain_id,
            kind="slab",
            name=name,
            source={
                "engine": self.engine_id,
                "engine_id": f"ref:{domain_id}",
                "engine_class": "ReferenceSlab",
                "model_revision": model.source_revision,
            },
            domain_quantities={
                "GrossVolume": DomainQuantity(
                    "GrossVolume", volume, QuantityState.CALCULATED,
                    basis="length x width x thickness",
                ),
            },
        )
        model.elements.append(element)
        self._store["elements"].append(
            {
                "domain_id": domain_id,
                "kind": "slab",
                "name": name,
                "geometry": {"width": width, "length": length, "thickness": thickness, "z": z},
            }
        )
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
        area = length * width
        element = DomainElement(
            domain_id=domain_id,
            kind="space",
            name=name,
            properties=dict(properties or {}),
            source={
                "engine": self.engine_id,
                "engine_id": f"ref:{domain_id}",
                "engine_class": "ReferenceSpace",
                "model_revision": model.source_revision,
            },
            domain_quantities={
                "GrossFloorArea": DomainQuantity(
                    "GrossFloorArea", area, QuantityState.CALCULATED,
                    basis="length x width footprint",
                ),
            },
        )
        model.elements.append(element)
        self._store["elements"].append(
            {
                "domain_id": domain_id,
                "kind": "space",
                "name": name,
                "geometry": {"width": width, "length": length},
                "properties": dict(properties or {}),
            }
        )
        return element

    # ------------------------------------------------------------------
    # persistence (JSON sidecar, explicitly NOT IFC — documented limitation)
    # ------------------------------------------------------------------

    def export_ifc(self, model: DomainModel, path: str) -> None:
        """Exports the reference sidecar format, NOT IFC.

        This is an explicit, documented capability gap of the reference
        implementation: it does not interoperate with IFC. The adapter
        contract allows this to raise ``UnsupportedOperationError``;
        instead of silently writing something that is not IFC to an .ifc
        path, we fail typed unless the caller opts into the sidecar
        extension explicitly.
        """
        raise UnsupportedOperationError(
            "ReferenceAdapter does not implement IFC persistence; "
            "use export_sidecar for contract testing"
        )

    def export_sidecar(self, model: DomainModel, path: str) -> None:
        Path(path).write_text(json.dumps(self._store, indent=2) + "\n")

    def import_ifc(self, path: str, model_id: str) -> DomainModel:
        raise UnsupportedOperationError(
            "ReferenceAdapter does not implement IFC persistence"
        )

    def import_sidecar(self, path: str, model_id: str) -> DomainModel:
        try:
            data = json.loads(Path(path).read_text())
        except Exception as exc:
            raise InvalidInputError(f"sidecar import failed: {exc}") from exc
        model = DomainModel(
            model_id=model_id,
            source_engine=self.engine_id,
            source_revision=Path(path).stem,
        )
        # Rebuild from stored geometry specs (same analytic path as creation).
        for el in data["elements"]:
            g = el["geometry"]
            if el["kind"] == "wall":
                self.add_wall(
                    model, el["domain_id"], el["name"],
                    g["x0"], g["y0"], g["x1"], g["y1"],
                    g["height"], g["thickness"], g["openings"], el.get("properties"),
                )
            elif el["kind"] == "slab":
                self.add_slab(model, el["domain_id"], el["name"], g["width"], g["length"], g["thickness"], g.get("z", 0.0))
            elif el["kind"] == "space":
                self.add_space(model, el["domain_id"], el["name"], g["width"], g["length"], el.get("properties"))
        return model

    # ------------------------------------------------------------------
    # quantities
    # ------------------------------------------------------------------

    def extract_quantities(self, model: DomainModel) -> None:
        for element in model.elements:
            if not element.domain_quantities:
                element.domain_quantities["NetVolume"] = DomainQuantity.unknown(
                    "NetVolume", basis="no geometric basis recorded"
                )
