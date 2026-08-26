"""Evidence harness for the RESEARCH-CAD-006 licensing/composition inventory.

Mirrors the RESEARCH-CAD-001 harness contract (BenchmarkResult with
observe/measure/assert_close/conclude; environment_snapshot; write_evidence)
so the orchestrator and tests behave identically across gates. This gate is
a records/inventory benchmark — no engine timing or peak-RSS is measured;
the environment snapshot captures the licensing-relevant provenance sources.
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
        evidence_refs: list[str] | None = None,
    ) -> Check:
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


def _read_pin_file(path: Path) -> dict[str, str]:
    """Parse a requirements.txt-style pin file into {dist: version}."""
    pins: dict[str, str] = {}
    if not path.exists():
        return pins
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        # match "dist==version"  (ignore trailing inline comments)
        if "==" in line:
            spec = line.split("#", 1)[0].strip()
            if "==" in spec:
                dist, ver = spec.split("==", 1)
                pins[dist.strip().lower()] = ver.strip()
    return pins


def _read_freecad_sha256(path: Path) -> str | None:
    """Extract the FreeCAD AppImage SHA256 from a requirements.txt comment.

    The CAD-001 requirements.txt records the pinned AppImage provenance as
    comment lines (url/sha256/bytes); this is the authoritative repo source
    for the hash, committed alongside the pinned toolchain.
    """
    if not path.exists():
        return None
    import re

    text = path.read_text()
    m = re.search(r"sha256:\s*([0-9a-fA-F]{64})\b", text)
    return m.group(1).lower() if m else None


def environment_snapshot() -> dict[str, Any]:
    """Capture the licensing-relevant environment for reproducibility.

    Records (a) the Python/platform runtime, (b) currently-importable
    distribution metadata cross-check, (c) the authoritative pinned-source
    provenance (CAD-001 requirements.txt + FreeCAD AppImage SHA256 manifest),
    and (d) the FreeCAD AppImage SHA256 if the manifest is present.
    """
    import importlib.metadata as md

    root = Path(__file__).resolve().parents[2]  # research/
    research_root = root  # parents[2] is already research/ (parents[1]=cad-006, parents[0]=offisos_licbench)
    env: dict[str, Any] = {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "python": sys.version,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "gate": "RESEARCH-CAD-006",
        "note": (
            "Records/inventory benchmark: versions are asserted from the "
            "authoritative pinned sources (CAD-001 requirements.txt, the "
            "CAD-001..005 environment.json snapshots and the FreeCAD AppImage "
            "SHA256 manifest), cross-checked against the currently-importable "
            "distribution metadata where present. The CAD/BIM engines are NOT "
            "exercised by this gate."
        ),
    }

    # (b) currently-importable distribution metadata cross-check
    installed: dict[str, Any] = {}
    for dist_name in ["ifcopenshell", "cadquery", "cadquery-ocp", "ezdxf", "numpy", "pytest"]:
        try:
            dist_info = md.distribution(dist_name)
            installed[dist_name] = {
                "version": dist_info.version,
                "license_field": (dist_info.metadata.get("License", "") or "")[:120],
                "home_page": dist_info.metadata.get("Home-page", "") or "",
            }
        except md.PackageNotFoundError:
            installed[dist_name] = None
    env["installed_metadata"] = installed

    # (c) authoritative pinned-source provenance
    cad001_pins = _read_pin_file(research_root / "cad-001" / "requirements.txt")
    env["cad001_requirements_pins"] = cad001_pins

    # cross-reference the committed environment snapshots from CAD-001..005
    env["snapshot_cross_reference"] = {}
    for gate in ["cad-001", "cad-002", "cad-003", "cad-004", "cad-005"]:
        snap = research_root / gate / "evidence" / "run-001" / "environment.json"
        if snap.exists():
            try:
                data = json.loads(snap.read_text())
                env["snapshot_cross_reference"][gate] = {
                    "packages": data.get("packages"),
                    "python": data.get("python"),
                    "ifcopenshell": data.get("ifcopenshell"),
                    "occt_version": data.get("occt_version"),
                }
            except Exception as exc:  # pragma: no cover
                env["snapshot_cross_reference"][gate] = {"error": str(exc)}
        else:
            env["snapshot_cross_reference"][gate] = None

    # cadquery-ocp is a transitive dep of cadquery (not a direct pin); its
    # version is derived from the committed environment snapshots.
    env["occt_runtime_version"] = "unknown"
    cad001_snap = env["snapshot_cross_reference"].get("cad-001") or {}
    if isinstance(cad001_snap, dict) and cad001_snap.get("occt_version"):
        env["occt_runtime_version"] = cad001_snap["occt_version"]

    # (d) FreeCAD AppImage SHA256 provenance: the authoritative repo source is
    # the CAD-001 requirements.txt comment (committed alongside the pinned
    # toolchain). The hash is cross-checked against inventory.py.
    cad001_req = research_root / "cad-001" / "requirements.txt"
    parsed_sha = _read_freecad_sha256(cad001_req)
    env["freecad_appimage_manifest"] = {
        "source": "research/cad-001/requirements.txt (committed pinned-toolchain provenance)",
        "version": "1.1.3",
        "sha256": parsed_sha,
        "expected_sha256": "3a853eb69ee595f779f2255dbf80a765926981d8ff68903cefee4dfb03a8f5ef",
        "matches_expected": parsed_sha == "3a853eb69ee595f779f2255dbf80a765926981d8ff68903cefee4dfb03a8f5ef",
    }
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
        "gate": "RESEARCH-CAD-006",
        "benchmarks": [r["benchmark"] for r in results],
        "totals": total,
        "exit_code": 1 if total["fail"] > 0 else 0,
        "note": (
            "unknown results are first-class epistemic states (do not fail "
            "the run); the run fails iff any check status == fail."
        ),
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
