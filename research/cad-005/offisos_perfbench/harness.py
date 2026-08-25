"""Evidence harness for the RESEARCH-CAD-005 benchmark.

Vendored and adapted from research/cad-004/offisos_qtybench/harness.py
(conventions proven in RESEARCH-CAD-001/002/003/004) so this evidence
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

This mirrors spec/architecture-lock.md LOCK-007 (epistemic honesty) and
the work-item requirement to distinguish native capability, adapter
capability and inferred conclusions.

RESEARCH-CAD-005 additions: the harness is measurement-first — benchmark
modules record structured ``measurements`` (timings with engine/adapter
separation, memory, counts) alongside the pass/fail checks that assert
properties of those measurements. Raw measurements are always written to
the evidence package even when a check fails, and failed runs /
resource-exhaustion events are recorded rather than omitted (issue #5
evidence requirements).
"""
from __future__ import annotations

import json
import os
import platform
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

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
        evidence_refs: list[str] | None = None,
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
            evidence_refs=evidence_refs or [],
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


def _read_first_line(path: str) -> Optional[str]:
    try:
        with open(path) as f:
            return f.readline().strip()
    except OSError:
        return None


def environment_snapshot() -> dict[str, Any]:
    """Capture the exact execution environment for reproducibility.

    RESEARCH-CAD-005 extends the proven snapshot with the hardware/OS
    details required by issue #5 ("Record exact engine/library versions,
    hardware, OS, runtime, compiler/build details where relevant, and
    benchmark configuration") plus an explicit statement that absolute
    wall-clock numbers are environment-specific.
    """
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
        "in_ci": bool(os.environ.get("GITHUB_ACTIONS")),
        "comparability_note": (
            "Absolute wall-clock and memory numbers are specific to this "
            "environment. Cross-environment comparisons use ratios and "
            "orderings only; both the local evidence run and the CI run "
            "use identical pinned toolchains and identical fixtures."
        ),
    }
    try:
        import resource

        env["occt_version"] = md.version("cadquery-ocp")
    except Exception as exc:  # pragma: no cover
        env["occt_version"] = f"unavailable: {exc}"
    # Hardware / OS details (Linux /proc — the evidence environments are
    # Linux; absence is recorded honestly rather than guessed).
    cpu_model = None
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("model name"):
                    cpu_model = line.split(":", 1)[1].strip()
                    break
    except OSError:
        pass
    env["cpu_model"] = cpu_model or "unavailable"
    env["cpu_count"] = os.cpu_count()
    mem_total = _read_first_line("/proc/meminfo")
    env["total_memory"] = mem_total or "unavailable"
    env["os_release"] = _read_first_line("/proc/sys/kernel/osrelease") or platform.release()
    for limit_name, limit in (
        ("rlimit_as", resource.RLIMIT_AS),
        ("rlimit_data", resource.RLIMIT_DATA),
    ):
        try:
            import resource as _r

            soft, hard = _r.getrlimit(limit)
            env[limit_name] = {"soft": soft, "hard": hard}
        except Exception:
            env[limit_name] = "unavailable"
    try:
        import ifcopenshell

        env["ifcopenshell"] = ifcopenshell.version
    except Exception as exc:  # pragma: no cover
        env["ifcopenshell"] = f"unavailable: {exc}"
    return env


def write_evidence(
    out_dir: Path,
    environment: dict[str, Any],
    results: list[dict[str, Any]],
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    results_dir = out_dir / "results"
    results_dir.mkdir(exist_ok=True)
    with open(out_dir / "environment.json", "w") as f:
        json.dump(environment, f, indent=2, sort_keys=False)
    total = {"pass": 0, "fail": 0, "unknown": 0}
    for result in results:
        with open(results_dir / f"{result['benchmark']}.json", "w") as f:
            json.dump(result, f, indent=2)
        for key in total:
            total[key] += result["summary"].get(key, 0)
    summary = {
        "run_id": out_dir.name,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total": total,
        "benchmarks": [
            {
                "benchmark": r["benchmark"],
                "description": r["description"],
                "summary": r["summary"],
            }
            for r in results
        ],
    }
    with open(out_dir / "summary.json", "w") as f:
        json.dump(summary, f, indent=2)
    return out_dir / "summary.json"
