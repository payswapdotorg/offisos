"""The CAD/BIM engine adapter contract (Architecture v1.0, LOCK-003).

This module defines the stable Offisos-side capability surface that the
domain layer (benchmarks, future Construction Graph services) consumes.
Candidate engines (IfcOpenShell+OCCT today, FreeCAD or another engine
tomorrow) live behind concrete adapter implementations of this contract.

What this proves
----------------
- Engine independence: domain code depends only on this contract and the
  plain data classes below — never on ``ifcopenshell``, ``OCP``, FreeCAD or
  any engine import.
- Replacement path: swapping engines means writing a new adapter; the
  ``bench_adapter_replacement`` benchmark runs the identical domain-level
  test suite through two different adapter implementations and requires
  identical results.

Typed failures
--------------
Adapter methods never silently fall back. They raise the typed exceptions
below (or return explicitly UNKNOWN quantity values) so that missing
capability surfaces as a first-class epistemic state, per LOCK-007.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class EngineError(Exception):
    """Base typed failure for engine operations performed through adapters."""


class UnsupportedOperationError(EngineError):
    """The engine behind the adapter cannot perform the requested operation."""


class InvalidInputError(EngineError):
    """The input (file, geometry, parameters) is malformed or invalid."""


class QuantityState(str, Enum):
    """Epistemic state of a extracted quantity value (LOCK-007)."""

    OBSERVED = "OBSERVED"          # read directly from the model data
    CALCULATED = "CALCULATED"      # computed from authoritative geometry
    UNKNOWN = "UNKNOWN"            # no basis for a value — never fake 0


@dataclass
class DomainQuantity:
    """A quantity extracted from a model, with explicit epistemic state."""

    name: str
    value: Optional[float]
    state: QuantityState
    unit: str = "SI"
    basis: str = ""

    @classmethod
    def unknown(cls, name: str, basis: str = "no geometric or quantity basis") -> "DomainQuantity":
        return cls(name=name, value=None, state=QuantityState.UNKNOWN, basis=basis)


@dataclass
class DomainElement:
    """Engine-agnostic domain element representation.

    ``domain_id`` is the Offisos canonical identity. ``source`` carries
    provenance/lineage: which engine, which engine-native id, which model
    revision. The engine-native id is NEVER the canonical identity
    (Construction Graph invariant).
    """

    domain_id: str
    kind: str  # "wall" | "slab" | "door" | "window" | "space" | ...
    name: str
    domain_quantities: dict[str, DomainQuantity] = field(default_factory=dict)
    properties: dict[str, Any] = field(default_factory=dict)
    source: dict[str, Any] = field(default_factory=dict)  # provenance


@dataclass
class DomainModel:
    """Engine-agnostic representation of a BIM model revision."""

    model_id: str
    elements: list[DomainElement] = field(default_factory=list)
    relationships: list[dict[str, Any]] = field(default_factory=list)
    source_engine: str = ""
    source_revision: str = ""


class CadBimAdapter(ABC):
    """Stable capability surface consumed by the Offisos domain layer.

    Implementations wrap exactly one engine stack. Domain code must never
    import engine modules directly — that is the adapter boundary
    (spec/architecture.md section on adapters; LOCK-003).
    """

    #: Short engine identity recorded in provenance (e.g. "ifcopenshell+occt").
    engine_id: str = "abstract"

    #: Human-readable engine version string, captured per implementation.
    engine_version: str = "abstract"

    # -- model lifecycle ---------------------------------------------------

    @abstractmethod
    def create_model(self, model_id: str) -> DomainModel:
        """Create an empty model bound to the Offisos model id."""

    @abstractmethod
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
        """Add a wall (with optional rectangular openings) to the model."""

    @abstractmethod
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
        """Add a horizontal slab to the model."""

    @abstractmethod
    def add_space(
        self,
        model: DomainModel,
        domain_id: str,
        name: str,
        width: float,
        length: float,
        properties: Optional[dict[str, Any]] = None,
    ) -> DomainElement:
        """Add a bounded space to the model."""

    # -- persistence / interoperability ------------------------------------

    @abstractmethod
    def export_ifc(self, model: DomainModel, path: str) -> None:
        """Persist the model to IFC. Raises InvalidInputError on failure."""

    @abstractmethod
    def import_ifc(self, path: str, model_id: str) -> DomainModel:
        """Load an IFC file into a DomainModel, preserving provenance.

        Raises InvalidInputError when the file cannot be parsed.
        """

    # -- quantities ---------------------------------------------------------

    @abstractmethod
    def extract_quantities(self, model: DomainModel) -> None:
        """Populate element.domain_quantities for every element.

        Elements with no geometric or quantity basis must receive
        QuantityState.UNKNOWN entries — never fabricated zeros.
        """
