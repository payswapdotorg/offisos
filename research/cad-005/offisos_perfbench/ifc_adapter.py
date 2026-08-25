"""Offisos translation layer over the IFC engine for RESEARCH-CAD-005.

This is the ADAPTER side of the engine/adapter measurement boundary: the
Offisos code that translates engine output into Construction-Graph-ready
domain objects (domain-id indexing, semantic snapshots, quantity records
with provenance, controlled mutations with lineage). Adapted from the
proven cad-003/cad-004 modules so the measured adapter work is
representative of the real translation layer, with typed failures
(LOCK-003 adapter contract obligations) throughout.

Every public function here is *pure Offisos translation* — the engine
(ifcopenshell) is called only through its documented API, and the time
spent in this module is what the benchmark records as adapter_ms.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from ifcopenshell.util.element import get_psets

IDENTITY_PSET = "Pset_OffisosIdentity"

ELEMENT_CLASSES = {
    "IfcWall": "wall",
    "IfcSlab": "slab",
    "IfcSpace": "space",
    "IfcDoor": "door",
    "IfcWindow": "window",
    "IfcOpeningElement": "opening",
}


class AdapterFailure(Exception):
    """Typed adapter failure (LOCK-003): recoverable by default.

    ``kind`` classifies the failure (malformed_input, engine_error,
    resource_exhausted, timeout, integrity) so the worker boundary can
    decide retry vs abort; ``recoverable`` records whether the adapter
    believes the calling process can continue serving requests.
    """

    def __init__(
        self,
        kind: str,
        message: str,
        recoverable: bool = True,
        cause: Optional[Exception] = None,
        details: Optional[dict[str, Any]] = None,
    ):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.recoverable = recoverable
        self.cause = cause
        self.details = details or {}

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "message": self.message,
            "recoverable": self.recoverable,
            "cause": repr(self.cause) if self.cause else None,
            **self.details,
        }


def safe_open(path: str) -> Any:
    """Typed IFC open: malformed input -> AdapterFailure(malformed_input)."""
    import ifcopenshell

    try:
        return ifcopenshell.open(path)
    except Exception as exc:  # ifcopenshell raises varied types
        raise AdapterFailure(
            "malformed_input",
            f"engine refused to open IFC file: {exc}",
            recoverable=True,
            cause=exc,
            details={"path": path, "engine_exception_type": type(exc).__name__},
        ) from exc


def extract_domain_index(f) -> dict[str, Any]:
    """Build the Offisos domain index from an IFC file (adapter translation).

    This is the cad-003-style semantic extraction: per-element identity,
    class, name, placement and pset snapshot keyed by Offisos domain id;
    engine GlobalIds are provenance only (never canonical).
    """
    index: dict[str, dict[str, Any]] = {}
    unkeyed: list[str] = []
    for ifc_class, kind in ELEMENT_CLASSES.items():
        for product in f.by_type(ifc_class):
            psets = get_psets(product)
            identity = psets.get(IDENTITY_PSET, {})
            domain_id = identity.get("DomainId")
            entry = {
                "kind": kind,
                "ifc_class": ifc_class,
                "name": product.Name,
                "engine_guid": product.GlobalId,
                "psets": {
                    name: {
                        k: v
                        for k, v in props.items()
                        if not k.startswith("id") and k != "HasProperties"
                    }
                    for name, props in psets.items()
                    if name != IDENTITY_PSET
                },
            }
            if domain_id:
                index[domain_id] = entry
            else:
                unkeyed.append(product.GlobalId)
    return {
        "index": index,
        "unkeyed_count": len(unkeyed),
        "element_count": len(index) + len(unkeyed),
    }


def serialize_index(result: dict[str, Any]) -> bytes:
    """Canonical JSON serialization of the domain index (adapter work)."""
    return json.dumps(
        result["index"], sort_keys=True, separators=(",", ":"),
        default=str,
    ).encode("utf-8")


@dataclass
class QuantityRecord:
    """Offisos quantity record (cad-004 contract, minimal core)."""

    domain_id: str
    quantity: str
    value: float
    unit: str
    source: str  # OBSERVED (qto read) | CALCULATED (BRep) | ANALYTIC
    model_version: str
    provenance: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "domain_id": self.domain_id,
            "quantity": self.quantity,
            "value": self.value,
            "unit": self.unit,
            "source": self.source,
            "model_version": self.model_version,
            "provenance": self.provenance,
        }


def extract_quantity_records(f, model_version: str) -> list[QuantityRecord]:
    """Quantity extraction + record assembly with provenance (adapter side).

    The engine side (qto reads via get_psets) happens inside this call
    too — the benchmark splits them by measuring the pure-recorded phases
    separately (see bench_extraction); this combined function is the
    canonical end-to-end adapter translation.
    """
    records: list[QuantityRecord] = []
    for ifc_class, kind in ELEMENT_CLASSES.items():
        for product in f.by_type(ifc_class):
            psets = get_psets(product, qtos_only=True)
            identity = get_psets(product).get(IDENTITY_PSET, {})
            domain_id = identity.get("DomainId") or f"unkeyed:{product.GlobalId}"
            for qto_name, quantities in psets.items():
                for qname, value in quantities.items():
                    if not isinstance(value, (int, float)) or isinstance(value, bool):
                        continue
                    records.append(
                        QuantityRecord(
                            domain_id=domain_id,
                            quantity=qname,
                            value=float(value),
                            unit="SI",
                            source="OBSERVED",
                            model_version=model_version,
                            provenance={
                                "engine_guid": product.GlobalId,
                                "qto": qto_name,
                                "ifc_class": ifc_class,
                                "extracted_at_monotonic": round(time.monotonic(), 6),
                            },
                        )
                    )
    return records


def apply_controlled_mutations(f, n: int, revision: str) -> list[dict[str, Any]]:
    """Apply n controlled property mutations with lineage (adapter side).

    This is the Offisos translation that must run before a controlled
    export: edit n elements' FireRating and record the lineage for each
    edit. Returns the lineage records.
    """
    import ifcopenshell.api

    walls = sorted(f.by_type("IfcWall"), key=lambda w: w.GlobalId)
    lineage: list[dict[str, Any]] = []
    step = max(1, len(walls) // n) if walls else 1
    for i in range(min(n, len(walls))):
        wall = walls[i * step]
        new_rating = f"REI{120 + (i % 3) * 30}"
        psets = get_psets(wall)
        old = psets.get("Pset_WallCommon", {}).get("FireRating")
        pset = None
        for rel in wall.IsDefinedBy or []:
            if rel.is_a("IfcRelDefinesByProperties"):
                p = rel.RelatingPropertyDefinition
                if p.is_a("IfcPropertySet") and p.Name == "Pset_WallCommon":
                    pset = p
                    break
        if pset is None:
            pset = ifcopenshell.api.run(
                "pset.add_pset", f, product=wall, name="Pset_WallCommon"
            )
        ifcopenshell.api.run(
            "pset.edit_pset", f, pset=pset,
            properties={"FireRating": new_rating},
        )
        identity = get_psets(wall).get(IDENTITY_PSET, {})
        lineage.append(
            {
                "domain_id": identity.get("DomainId", f"unkeyed:{wall.GlobalId}"),
                "field": "Pset_WallCommon.FireRating",
                "old": old,
                "new": new_rating,
                "revision": revision,
                "engine_guid": wall.GlobalId,
            }
        )
    return lineage


def query_by_domain_id(index: dict[str, Any], domain_id: str) -> dict[str, Any] | None:
    """Consumer-side lookup on the Offisos index (adapter work)."""
    return index["index"].get(domain_id) if "index" in index else index.get(domain_id)
