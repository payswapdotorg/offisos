"""Timing and repeated-run statistics for RESEARCH-CAD-005.

Core requirements from issue #5 implemented here:

- **Engine vs Offisos translation overhead separation**: every measured
  operation is split into an ENGINE phase (time spent inside the
  candidate engine/library: ifcopenshell, OCCT, FreeCAD) and an
  ADAPTER phase (time spent in Offisos translation code: domain-id
  computation, semantic snapshot assembly, quantity derivation,
  provenance/lineage bookkeeping, JSON serialization). The boundary is
  stated per operation in the recorded measurement so the split is
  auditable rather than implied.
- **Medians and distributions**: repeated operations record every raw
  sample plus min/median/mean/max/stdev — never a single best-case
  sample.

Wall-clock uses ``time.perf_counter``. The statistics module is stdlib
(no numpy dependency for the measurement layer).
"""
from __future__ import annotations

import statistics
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional


@dataclass
class SplitSample:
    """One repeated run of an operation split into engine/adapter phases."""

    engine_ms: float
    adapter_ms: float

    @property
    def total_ms(self) -> float:
        return self.engine_ms + self.adapter_ms


@dataclass
class SplitMeasurement:
    """Repeated-run distribution of an engine/adapter-split operation."""

    operation: str
    boundary: str  # what exactly counts as ENGINE vs ADAPTER for this op
    repeats: int
    samples: list[SplitSample] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def engine_ms_samples(self) -> list[float]:
        return [s.engine_ms for s in self.samples]

    @property
    def adapter_ms_samples(self) -> list[float]:
        return [s.adapter_ms for s in self.samples]

    @property
    def total_ms_samples(self) -> list[float]:
        return [s.total_ms for s in self.samples]

    def stats(self, values: list[float]) -> dict[str, float]:
        if not values:
            return {}
        out: dict[str, float] = {
            "min": round(min(values), 3),
            "median": round(statistics.median(values), 3),
            "mean": round(statistics.fmean(values), 3),
            "max": round(max(values), 3),
        }
        if len(values) > 1:
            out["stdev"] = round(statistics.stdev(values), 3)
        out["samples"] = [round(v, 3) for v in values]
        return out

    def to_dict(self) -> dict[str, Any]:
        engine_stats = self.stats(self.engine_ms_samples)
        adapter_stats = self.stats(self.adapter_ms_samples)
        total_stats = self.stats(self.total_ms_samples)
        adapter_share = None
        if total_stats and total_stats.get("median", 0) > 0:
            adapter_share = round(
                adapter_stats["median"] / total_stats["median"], 4
            )
        return {
            "operation": self.operation,
            "boundary": self.boundary,
            "repeats": self.repeats,
            "actual_repeats": len(self.samples),
            "engine_ms": engine_stats,
            "adapter_ms": adapter_stats,
            "total_ms": total_stats,
            "adapter_share_of_total_median": adapter_share,
            **self.extra,
        }


def measure_split_repeated(
    operation: str,
    boundary: str,
    engine_fn: Callable[[], Any],
    adapter_fn: Callable[[Any], Any],
    repeats: int,
    extra: dict[str, Any] | None = None,
) -> SplitMeasurement:
    """Run ``engine_fn`` then ``adapter_fn(engine_result)`` ``repeats`` times.

    Each repeat is a fresh end-to-end execution; engine and adapter wall
    times are captured separately per repeat with perf_counter.
    """
    m = SplitMeasurement(
        operation=operation, boundary=boundary, repeats=repeats,
        extra=extra or {},
    )
    for _ in range(repeats):
        t0 = time.perf_counter()
        engine_result = engine_fn()
        t1 = time.perf_counter()
        adapter_fn(engine_result)
        t2 = time.perf_counter()
        m.samples.append(
            SplitSample(engine_ms=(t1 - t0) * 1000.0, adapter_ms=(t2 - t1) * 1000.0)
        )
    return m


def measure_repeated(
    operation: str,
    fn: Callable[[], Any],
    repeats: int,
    boundary: str = "single-phase operation (no adapter split applicable)",
    extra: dict[str, Any] | None = None,
) -> SplitMeasurement:
    """Repeated single-phase measurement (recorded under engine_ms)."""
    return measure_split_repeated(
        operation=operation,
        boundary=boundary,
        engine_fn=fn,
        adapter_fn=lambda _result: None,
        repeats=repeats,
        extra=extra,
    )


def coefficient_of_variation(samples: list[float]) -> Optional[float]:
    """Relative stdev (dimensionless) — the repeated-run variance metric."""
    if len(samples) < 2:
        return None
    mean = statistics.fmean(samples)
    if mean == 0:
        return None
    return round(statistics.stdev(samples) / mean, 6)
