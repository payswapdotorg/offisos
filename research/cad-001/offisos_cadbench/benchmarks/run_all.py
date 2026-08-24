"""RESEARCH-CAD-001 benchmark orchestrator.

Runs every benchmark module and writes the evidence package:

    evidence/<run-id>/
        environment.json    exact environment snapshot
        results/*.json      per-benchmark check/measurement records
        summary.json        totals and exit code

Exit code 0 iff no check failed. `unknown` results do not fail the run —
they are first-class epistemic states, but they are counted and visible.
"""
from __future__ import annotations

import sys
from pathlib import Path

from ..harness import BenchmarkResult, environment_snapshot, write_evidence
from . import (
    bench_2d_drafting,
    bench_3d_geometry,
    bench_adapter_replacement,
    bench_bim_semantics,
    bench_cg_mapping,
    bench_failure_modes,
    bench_ifc_roundtrip,
    bench_licensing,
    bench_parametric,
    bench_performance,
    bench_quantities,
)

BENCHMARKS = [
    ("bench-2d-drafting", bench_2d_drafting),
    ("bench-3d-geometry", bench_3d_geometry),
    ("bench-parametric", bench_parametric),
    ("bench-bim-semantics", bench_bim_semantics),
    ("bench-ifc-roundtrip", bench_ifc_roundtrip),
    ("bench-quantities", bench_quantities),
    ("bench-performance", bench_performance),
    ("bench-cg-mapping", bench_cg_mapping),
    ("bench-adapter-replacement", bench_adapter_replacement),
    ("bench-failure-modes", bench_failure_modes),
    ("bench-licensing", bench_licensing),
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
