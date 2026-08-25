"""RESEARCH-CAD-002 benchmark orchestrator.

Runs every benchmark module and writes the evidence package under
evidence/<run-id>/ (environment snapshot, per-benchmark results, summary).
Exit code 0 iff no check failed; unknowns are counted and visible.
"""
from __future__ import annotations

import sys
from pathlib import Path

from ..harness import BenchmarkResult, environment_snapshot, write_evidence
from . import (
    bench_2d_drafting,
    bench_assemblies,
    bench_automation,
    bench_booleans,
    bench_constraints,
    bench_parametric_3d,
    bench_performance,
    bench_snapping,
)

BENCHMARKS = [
    ("bench-2d-drafting", bench_2d_drafting),
    ("bench-snapping", bench_snapping),
    ("bench-constraints", bench_constraints),
    ("bench-parametric-3d", bench_parametric_3d),
    ("bench-booleans", bench_booleans),
    ("bench-assemblies", bench_assemblies),
    ("bench-automation", bench_automation),
    ("bench-performance", bench_performance),
]


def run_all(out_dir: Path) -> int:
    results = []
    for benchmark_id, module in BENCHMARKS:
        description = (module.__doc__ or "").strip().split("\n")[0]
        print(f"[run] {benchmark_id}: {description}")
        bench = BenchmarkResult(benchmark_id, description)
        module.run(bench)
        concluded = bench.conclude()
        results.append(concluded)
        summary = concluded["summary"]
        print(
            f"      pass={summary['pass']} fail={summary['fail']} "
            f"unknown={summary['unknown']}"
        )
        for check in concluded["checks"]:
            if check["status"] == "fail":
                print(f"      FAIL {check['id']}: {check['details']}")
    summary_path = write_evidence(out_dir, environment_snapshot(), results)
    total = {"pass": 0, "fail": 0, "unknown": 0}
    for r in results:
        for key in total:
            total[key] += r["summary"].get(key, 0)
    print()
    print(
        f"TOTAL: pass={total['pass']} fail={total['fail']} "
        f"unknown={total['unknown']}"
    )
    print(f"Evidence written to: {summary_path}")
    return 1 if total["fail"] else 0


def main() -> None:
    run_id = sys.argv[1] if len(sys.argv) > 1 else "run-001"
    root = Path(__file__).resolve().parents[2]
    out_dir = root / "evidence" / run_id
    sys.exit(run_all(out_dir))


if __name__ == "__main__":
    main()
