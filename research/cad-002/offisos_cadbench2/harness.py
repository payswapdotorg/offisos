"""Evidence harness for the RESEARCH-CAD-002 benchmark.

Vendored and adapted from research/cad-001/offisos_cadbench/harness.py
(the harness conventions proven in RESEARCH-CAD-001) so this evidence
package is independently reproducible without runtime coupling between
work items.

Every check recorded through this harness carries:

- an id and description;
- a status (pass/fail/unknown — unknown is a first-class result, never
  silently coerced to pass or fail);
- an epistemic class distinguishing what was actually measured:
    OBSERVED   — directly measured/verified against the engine in this run;
    CALCULATED — derived arithmetically from measurements or analytic
                 expectations (tolerances stated);
    ADAPTER    — capability provided by Offisos adapter code, NOT by the
                 engine itself (never claimed as native capability);
    NATIVE     — capability exercised directly on the candidate engine;
    INFERRED   — conclusion drawn from evidence, not itself a measurement
                 (always accompanied by the supporting evidence ids).

This mirrors spec/architecture-lock.md LOCK-007 (epistemic honesty) and the
work-item requirement to distinguish native capability, adapter capability
and inferred conclusions.
"""
from __future__ import annotations

import json
import platform
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

EPISTEMIC_CLASSES = {"OBSERVED", "CALCULATED", "ADAPTER", "NATIVE", "INFERRED"}


@dataclass
class Check:
    id: str
    description: str
    status: str  # "pass" | "fail" | "unknown"
    epistemic: str  # one of EPISTEMIC_CLASSES
    details: dict[str, Any] = field(default_factory=dict)
    tolerance: Optional[float] = None
    evidence_refs: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "description": self.description,
            "status": self.status,
            "epistemic": self.epistemic,
            "tolerance": self.tolerance,
            "details": self.details,
            "evidence_refs": self.evidence_refs,
        }


class BenchmarkResult:
    def __init__(self, benchmark_id: str, description: str):
        self.benchmark_id = benchmark_id
        self.description = description
        self.checks: list[Check] = []
        self.measurements: dict[str, Any] = {}
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.finished_at: Optional[str] = None

    def observe(
        self,
        check_id: str,
        description: str,
        condition: bool,
        details: dict[str, Any] | None = None,
        epistemic: str = "OBSERVED",
        tolerance: float | None = None,
        unknown_reason: str | None = None,
    ) -> Check:
        """Record a check. `condition` True -> pass, False -> fail.

        If `unknown_reason` is given, the check is recorded as `unknown`
        regardless of condition — used when a capability could not be tested
        (environment limitation); the reason is mandatory.
        """
        if epistemic not in EPISTEMIC_CLASSES:
            raise ValueError(f"invalid epistemic class: {epistemic}")
        status = "pass" if condition else "fail"
        if unknown_reason is not None:
            status = "unknown"
            details = {**(details or {}), "unknown_reason": unknown_reason}
        check = Check(
            id=check_id,
            description=description,
            status=status,
            epistemic=epistemic,
            details=details or {},
            tolerance=tolerance,
        )
        self.checks.append(check)
        return check

    def assert_close(
        self,
        check_id: str,
        description: str,
        measured: float,
        expected: float,
        tolerance: float,
        epistemic: str = "OBSERVED",
        details: dict[str, Any] | None = None,
    ) -> Check:
        delta = abs(measured - expected)
        detail = {
            "measured": measured,
            "expected": expected,
            "delta": delta,
            **(details or {}),
        }
        return self.observe(
            check_id,
            description,
            delta <= tolerance,
            details=detail,
            epistemic=epistemic,
            tolerance=tolerance,
        )

    def measure(self, key: str, value: Any) -> None:
        self.measurements[key] = value

    def conclude(self) -> dict[str, Any]:
        counts = {"pass": 0, "fail": 0, "unknown": 0}
        for check in self.checks:
            counts[check.status] = counts.get(check.status, 0) + 1
        self.finished_at = datetime.now(timezone.utc).isoformat()
        return {
            "benchmark": self.benchmark_id,
            "description": self.description,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "summary": counts,
            "measurements": self.measurements,
            "checks": [c.to_dict() for c in self.checks],
        }


def environment_snapshot() -> dict[str, Any]:
    """Capture the exact execution environment for reproducibility."""
    import importlib.metadata as md

    packages = {}
    for dist_name in [
        "ifcopenshell",
        "cadquery",
        "cadquery-ocp",
        "numpy",
        "ezdxf",
    ]:
        try:
            packages[dist_name] = md.version(dist_name)
        except md.PackageNotFoundError:
            packages[dist_name] = None
    env: dict[str, Any] = {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "python": sys.version,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "packages": packages,
    }
    try:
        import importlib.metadata as _md

        env["occt_version"] = _md.version("cadquery-ocp")  # e.g. 7.8.1.1.post1 -> OCCT 7.8.1
    except Exception as exc:  # pragma: no cover
        env["occt_version"] = f"unavailable: {exc}"
    try:  # FreeCAD provenance
        from .freecad_runner import find_freecadcmd, freecad_version

        cmd = find_freecadcmd()
        if cmd is not None:
            env["freecad"] = freecad_version(cmd)
        else:
            env["freecad"] = None
    except Exception as exc:  # pragma: no cover
        env["freecad"] = f"unavailable: {exc}"
    try:
        import resource

        env["cpu_count_limit_note"] = "see /proc limits"
        with open("/proc/meminfo") as f:
            first = f.readline().strip()
        env["total_memory"] = first
    except Exception:
        pass
    return env


def write_evidence(
    out_dir: Path,
    environment: dict[str, Any],
    results: list[dict[str, Any]],
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "environment.json").write_text(
        json.dumps(environment, indent=2) + "\n"
    )
    results_dir = out_dir / "results"
    results_dir.mkdir(exist_ok=True)
    for result in results:
        name = f"{result['benchmark']}.json"
        (results_dir / name).write_text(json.dumps(result, indent=2) + "\n")
    total = {"pass": 0, "fail": 0, "unknown": 0}
    for result in results:
        for key in total:
            total[key] += result["summary"].get(key, 0)
    summary = {
        "written_at": datetime.now(timezone.utc).isoformat(),
        "benchmarks": [r["benchmark"] for r in results],
        "totals": total,
        "exit_code": 1 if total["fail"] > 0 else 0,
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return out_dir / "summary.json"


def timed(func: Callable[[], Any], repeats: int = 1) -> tuple[Any, list[float]]:
    """Run func `repeats` times, return (last_result, seconds_per_run)."""
    import time

    times: list[float] = []
    result = None
    for _ in range(repeats):
        start = time.perf_counter()
        result = func()
        times.append(time.perf_counter() - start)
    return result, times


def peak_rss_mb() -> float:
    """Peak resident set size in MiB (Linux ru_maxrss is KiB)."""
    import resource

    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
