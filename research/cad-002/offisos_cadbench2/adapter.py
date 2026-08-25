"""CAD engine adapter contract for RESEARCH-CAD-002 (Architecture v1.0, LOCK-003).

The stable Offisos-side CAD operation surface consumed by the benchmark
and automation evidence. The concrete implementation wraps FreeCAD/
OpenCascade behind a process-isolated interface: every operation is a
self-contained script executed in a fresh FreeCADCmd process with state
persisted explicitly through FCStd documents between calls.

What this proves (issue #2, scope 4 — Automation/API):
- required operations are invocable through a stable adapter rather than
  application-global state: there IS no application-global state — each
  call is an isolated process with explicit document persistence;
- repeatable scripted creation/edit/export: the same adapter call
  sequence produces identical results (asserted in bench_automation).
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


class CadEngineError(Exception):
    """Base typed failure for CAD operations performed through adapters."""


class UnsupportedOperationError(CadEngineError):
    """The engine behind the adapter cannot perform the requested operation."""


class InvalidInputError(CadEngineError):
    """The input parameters or referenced document are invalid."""


@dataclass
class OperationResult:
    """Structured, JSON-serializable outcome of one adapter operation."""

    operation: str
    ok: bool
    measurements: dict[str, Any] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)


class CadEngineAdapter(ABC):
    """Stable CAD operation surface (2D/3D, parametric, automation)."""

    engine_id: str = "abstract"
    engine_version: str = "abstract"

    # -- parametric 3D -----------------------------------------------------

    @abstractmethod
    def create_parametric_box_document(
        self, length: float, width: float, height: float
    ) -> OperationResult:
        """Create a persisted document with one parametric Part::Box.

        Returns measurements: object_count, volume, doc_path.
        """

    @abstractmethod
    def edit_parameter(
        self, doc_path: str, object_name: str, parameter: str, value: float
    ) -> OperationResult:
        """Edit a named parameter of a persisted document object, recompute,
        and report before/after measurements (volume) and recompute count."""

    # -- interoperability ----------------------------------------------------

    @abstractmethod
    def export_step(self, doc_path: str, object_name: str, out_path: str) -> OperationResult:
        """Export one object of a persisted document to STEP."""

    @abstractmethod
    def import_step_volume(self, step_path: str) -> OperationResult:
        """Import a STEP file and report the solid volume."""

    # -- 2D drafting ---------------------------------------------------------

    @abstractmethod
    def create_draft_document(
        self, segments: list[tuple[float, float, float, float]]
    ) -> OperationResult:
        """Create a persisted document with Draft lines for each segment
        (x0, y0, x1, y1). Returns measurements: line_count, total_length."""

    # -- engine identity -----------------------------------------------------

    @abstractmethod
    def engine_identity(self) -> OperationResult:
        """Report the exact engine id/version and build provenance."""
