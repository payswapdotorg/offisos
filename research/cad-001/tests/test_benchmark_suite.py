"""Deterministic CI tests for the RESEARCH-CAD-001 benchmark suite.

These tests run the complete benchmark in-process and assert:
- zero failed checks;
- critical capability checks pass (geometry exactness, round-trip fidelity,
  quantity assertions, adapter replacement, CG mapping);
- the only permitted `unknown` is the explicitly recorded FreeCAD
  environment limitation.

They give the governance CI a fast, attributable gate over the research
evidence code.
"""
from __future__ import annotations

import unittest
from pathlib import Path

import sys

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from offisos_cadbench.benchmarks.run_all import BENCHMARKS, run_all  # noqa: E402


def _run_all_checks() -> dict[str, dict]:
    """Run every benchmark and return {benchmark_id: concluded_result}."""
    from offisos_cadbench.harness import BenchmarkResult

    results = {}
    for benchmark_id, module in BENCHMARKS:
        description = (module.__doc__ or "").strip().split("\n")[0]
        bench = BenchmarkResult(benchmark_id, description)
        module.run(bench)
        results[benchmark_id] = bench.conclude()
    return results


RESULTS = _run_all_checks()


class BenchmarkSuiteTest(unittest.TestCase):
    def test_no_failed_checks(self):
        failures = {}
        for benchmark_id, result in RESULTS.items():
            failed = [
                c["id"] for c in result["checks"] if c["status"] == "fail"
            ]
            if failed:
                failures[benchmark_id] = failed
        self.assertEqual({}, failures, f"failed checks: {failures}")

    def test_only_permitted_unknown_is_freecad(self):
        unknowns = []
        for benchmark_id, result in RESULTS.items():
            for check in result["checks"]:
                if check["status"] == "unknown":
                    unknowns.append(f"{benchmark_id}:{check['id']}")
        self.assertEqual(
            ["bench-parametric:parametric/freecad-sketcher/availability"],
            unknowns,
            "the only unknown must be the recorded FreeCAD environment limitation",
        )

    def test_critical_geometry_checks_pass(self):
        result = RESULTS["bench-3d-geometry"]
        by_id = {c["id"]: c for c in result["checks"]}
        for critical in [
            "3d/booleans/fuse-volume",
            "3d/booleans/cut-volume",
            "3d/booleans/common-volume",
            "3d/booleans/curved-cut-volume",
            "3d/transforms/centre-of-mass",
            "3d/assembly/compound-volume",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    def test_critical_roundtrip_checks_pass(self):
        result = RESULTS["bench-ifc-roundtrip"]
        by_id = {c["id"]: c for c in result["checks"]}
        for critical in [
            "roundtrip/identity/domain-ids-preserved",
            "roundtrip/properties/values-preserved",
            "roundtrip/quantities/net-volume",
            "roundtrip/narrow-patch/unrelated-preserved",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    def test_critical_quantity_checks_pass(self):
        result = RESULTS["bench-quantities"]
        by_id = {c["id"]: c for c in result["checks"]}
        for critical in [
            "qty/brep/net-volume",
            "qty/sums/wall-net-volume",
            "qty/roundtrip/observed-equals-calculated",
            "qty/unknown/ghost-wall",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    def test_adapter_replacement_proof(self):
        result = RESULTS["bench-adapter-replacement"]
        by_id = {c["id"]: c for c in result["checks"]}
        self.assertEqual("pass", by_id["replacement/domain-results-identical"]["status"])
        self.assertEqual("pass", by_id["replacement/typed-unsupported-operation"]["status"])

    def test_construction_graph_mapping_proof(self):
        result = RESULTS["bench-cg-mapping"]
        by_id = {c["id"]: c for c in result["checks"]}
        for critical in [
            "cg/engine-ids/unstable-across-regeneration",
            "cg/domain-ids/stable-across-regeneration",
            "cg/domain-ids/roundtrip-preserved",
            "cg/diff/detects-added-element",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    def test_failure_modes_are_typed(self):
        result = RESULTS["bench-failure-modes"]
        by_id = {c["id"]: c for c in result["checks"]}
        for critical in [
            "failure/malformed-ifc/typed-error",
            "failure/invalid-geometry/zero-extent",
            "failure/lossy-conversion/disjoint-fuse-compound",
            "failure/ambiguous-quantity/unknown-not-zero",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    def test_fixture_analytics_are_exact(self):
        from offisos_cadbench import fixtures as fx

        self.assertAlmostEqual(
            fx.OPENINGS_EXPECTED["net_volume"], 4.23, places=12
        )
        self.assertAlmostEqual(
            fx.SMALL_EXPECTED["wall_net_volume_sum"], 21.69, places=12
        )
        self.assertEqual(fx.MEDIUM_EXPECTED["wall_count"], 100)
        self.assertEqual(
            sum(len(w.openings) for w in fx.medium_walls()), 50
        )


if __name__ == "__main__":
    unittest.main()
