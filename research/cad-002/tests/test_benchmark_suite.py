"""Deterministic CI tests for the RESEARCH-CAD-002 benchmark suite.

Runs the complete benchmark in-process and asserts:
- zero failed checks and zero unknowns (FreeCAD is required);
- critical capability checks pass for each scope area;
- representative end-to-end workflows (2D drafting, 3D parametric
  modeling) are covered by the asserted checks.
"""
from __future__ import annotations

import unittest
from pathlib import Path

import sys

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from offisos_cadbench2.benchmarks.run_all import BENCHMARKS  # noqa: E402
from offisos_cadbench2.freecad_runner import find_freecadcmd  # noqa: E402

FREECAD_AVAILABLE = find_freecadcmd() is not None


def _run_all_checks() -> dict[str, dict]:
    from offisos_cadbench2.harness import BenchmarkResult

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
            failed = [c["id"] for c in result["checks"] if c["status"] == "fail"]
            if failed:
                failures[benchmark_id] = failed
        self.assertEqual({}, failures, f"failed checks: {failures}")

    def test_no_unknowns_when_freecad_available(self):
        if not FREECAD_AVAILABLE:
            self.skipTest("FreeCAD not installed in this environment")
        unknowns = []
        for benchmark_id, result in RESULTS.items():
            for check in result["checks"]:
                if check["status"] == "unknown":
                    unknowns.append(f"{benchmark_id}:{check['id']}")
        self.assertEqual([], unknowns,
                         "FreeCAD is available: no unknown checks are permitted")

    # -- scope 1: 2D drafting end-to-end -------------------------------

    def test_2d_drafting_end_to_end(self):
        result = RESULTS["bench-2d-drafting"]
        by_id = {c["id"]: c for c in result["checks"]}
        for critical in [
            "cad2-2d/coordinate-entry-precision",
            "cad2-2d/circle-precision",
            "cad2-2d/layer-membership",
            "cad2-2d/layer-visibility-toggle",
            "cad2-2d/linear-dimensions-exact",
            "cad2-2d/text-annotation",
            "cad2-2d/edit-recompute",
            "cad2-2d/persistence-reopen",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    def test_snapping_surface(self):
        result = RESULTS["bench-snapping"]
        by_id = {c["id"]: c for c in result["checks"]}
        for critical in [
            "cad2-snap/parameter-system",
            "cad2-snap/native-nearest-distance",
            "cad2-snap/native-nearest-point",
            "cad2-snap/adapter-endpoint-snap",
            "cad2-snap/adapter-midpoint-snap",
            "cad2-snap/adapter-intersection-snap",
            "cad2-snap/adapter-grid-snap",
            "cad2-snap/gui-boundary",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    def test_constraints(self):
        result = RESULTS["bench-constraints"]
        by_id = {c["id"]: c for c in result["checks"]}
        for critical in [
            "cad2-constraints/rectangle-full-constraint",
            "cad2-constraints/datum-edit-propagation",
            "cad2-constraints/corner-follows-edit",
            "cad2-constraints/tangent-line-circle",
            "cad2-constraints/perpendicular-corner-exact",
            "cad2-constraints/equal-length-propagation",
            "cad2-constraints/conflict-detection",
            "cad2-constraints/invalid-datum-typed-rejection",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    # -- scope 2+3: 3D parametric end-to-end ---------------------------

    def test_3d_parametric_end_to_end(self):
        result = RESULTS["bench-parametric-3d"]
        by_id = {c["id"]: c for c in result["checks"]}
        for critical in [
            "cad2-p3d/primitive-parametric-edit",
            "cad2-p3d/partdesign-pad",
            "cad2-p3d/dimension-propagation-through-chain",
            "cad2-p3d/pad-length-edit",
            "cad2-p3d/pocket-subtraction",
            "cad2-p3d/pocket-edit-propagation",
            "cad2-p3d/dependency-recompute-states",
            "cad2-p3d/recompute-result-exact",
            "cad2-p3d/failure-invalid-parameter",
            "cad2-p3d/failure-recovery",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    def test_booleans_and_transforms(self):
        result = RESULTS["bench-booleans"]
        by_id = {c["id"]: c for c in result["checks"]}
        for critical in [
            "cad2-bool/scripted-fuse",
            "cad2-bool/scripted-cut",
            "cad2-bool/scripted-common",
            "cad2-bool/scripted-curved-cut",
            "cad2-bool/disjoint-fuse-topology",
            "cad2-bool/parametric-cut-object",
            "cad2-bool/parametric-propagation",
            "cad2-bool/parametric-tool-propagation",
            "cad2-bool/placement-rotation-vertex-exact",
            "cad2-bool/placement-rotated-extents",
            "cad2-bool/matrix-transform-extents",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    def test_assemblies(self):
        result = RESULTS["bench-assemblies"]
        by_id = {c["id"]: c for c in result["checks"]}
        for critical in [
            "cad2-asm/link-volume-exact",
            "cad2-asm/link-placement-honored",
            "cad2-asm/source-edit-propagation",
            "cad2-asm/link-array",
            "cad2-asm/medium-assembly-robustness",
            "cad2-asm/instance-placement-exact",
            "cad2-asm/assembly-wide-propagation",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    # -- scope 4: automation/API ---------------------------------------

    def test_automation_determinism(self):
        result = RESULTS["bench-automation"]
        by_id = {c["id"]: c for c in result["checks"]}
        for critical in [
            "cad2-auto/adapter-engine-identity",
            "cad2-auto/adapter-workflow-determinism",
            "cad2-auto/adapter-workflow-correctness",
            "cad2-auto/inprocess-build-determinism",
            "cad2-auto/step-byte-determinism-finding",
            "cad2-auto/step-semantic-determinism",
            "cad2-auto/fcstd-byte-determinism-finding",
            "cad2-auto/adapter-typed-failure",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    def test_performance_measurements(self):
        result = RESULTS["bench-performance"]
        by_id = {c["id"]: c for c in result["checks"]}
        for critical in [
            "cad2-perf/feature-document",
            "cad2-perf/incremental-recompute",
            "cad2-perf/partdesign-chain-recompute",
            "cad2-perf/step-io",
            "cad2-perf/fcstd-save",
            "cad2-perf/peak-memory",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)
        # quantitative measurements recorded
        self.assertIn("perf_100_features_creation_s", result["measurements"])
        self.assertIn("perf_100_features_full_recompute_s", result["measurements"])
        self.assertIn("perf_step_bytes", result["measurements"])
        self.assertIn("perf_peak_rss_mib", result["measurements"])


if __name__ == "__main__":
    unittest.main()
