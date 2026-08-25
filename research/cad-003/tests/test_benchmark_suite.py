"""Deterministic CI tests for the RESEARCH-CAD-003 benchmark suite.

Runs the complete benchmark in-process and asserts zero failures and
zero unknowns (IfcOpenShell + IfcTester + bcf-client are pip-installable,
so everything is testable), plus critical capability checks per scope
area of issue #3.
"""
from __future__ import annotations

import unittest
from pathlib import Path

import sys

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from offisos_ifcbench.benchmarks.run_all import BENCHMARKS  # noqa: E402


def _run_all_checks() -> dict[str, dict]:
    from offisos_ifcbench.harness import BenchmarkResult

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

    def test_no_unknowns(self):
        unknowns = []
        for benchmark_id, result in RESULTS.items():
            for check in result["checks"]:
                if check["status"] == "unknown":
                    unknowns.append(f"{benchmark_id}:{check['id']}")
        self.assertEqual([], unknowns,
                         "all toolchains are pip-installable: no unknowns permitted")

    # -- scope 1: fixture corpus ----------------------------------------

    def test_fixture_corpus(self):
        result = RESULTS["bench-fixture"]
        by_id = {c["id"]: c for c in result["checks"]}
        for critical in [
            "cad3-fixture/entity-counts",
            "cad3-fixture/relationship-counts",
            "cad3-fixture/units-metre",
            "cad3-fixture/placements-exact",
            "cad3-fixture/property-values",
            "cad3-fixture/custom-project-properties",
            "cad3-fixture/wall-gross-volume-sum",
            "cad3-fixture/wall-net-volume-sum",
            "cad3-fixture/filling-dimensions",
            "cad3-fixture/regeneration-determinism",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    # -- scope 2: semantic extraction -----------------------------------

    def test_extraction(self):
        result = RESULTS["bench-extraction"]
        by_id = {c["id"]: c for c in result["checks"]}
        for critical in [
            "cad3-extract/determinism",
            "cad3-extract/identity-coverage",
            "cad3-extract/identity-not-in-properties",
            "cad3-extract/class-name-provenance",
            "cad3-extract/property-coverage",
            "cad3-extract/quantity-coverage",
            "cad3-extract/relationships",
            "cad3-extract/representation-reference",
            "cad3-extract/globalid-stable-in-file",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    # -- scope 3: controlled mutation -----------------------------------

    def test_mutation(self):
        result = RESULTS["bench-mutation"]
        by_id = {c["id"]: c for c in result["checks"]}
        for critical in [
            "cad3-mutate/property-surgical",
            "cad3-mutate/property-lineage",
            "cad3-mutate/placement-surgical",
            "cad3-mutate/placement-value-exact",
            "cad3-mutate/create-surgical",
            "cad3-mutate/create-identity-and-props",
            "cad3-mutate/delete-surgical",
            "cad3-mutate/delete-relationship-cleanup",
            "cad3-mutate/persist-through-export",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    # -- scope 4: round trip ---------------------------------------------

    def test_roundtrip(self):
        result = RESULTS["bench-roundtrip"]
        by_id = {c["id"]: c for c in result["checks"]}
        for critical in [
            "cad3-roundtrip/semantic-zero-drift",
            "cad3-roundtrip/identity-survival",
            "cad3-roundtrip/class-survival",
            "cad3-roundtrip/globalid-survival",
            "cad3-roundtrip/relationships-survival",
            "cad3-roundtrip/units-survival",
            "cad3-roundtrip/placement-survival",
            "cad3-roundtrip/mutation-visible",
            "cad3-roundtrip/quantity-survival",
            "cad3-roundtrip/geometry-extrusion-depth",
            "cad3-roundtrip/geometry-opening-count",
            "cad3-roundtrip/geometry-not-guaranteed",
            "cad3-roundtrip/lossiness-classification",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    # -- scope 5: Construction Graph mapping ----------------------------

    def test_cg_mapping(self):
        result = RESULTS["bench-cg-mapping"]
        by_id = {c["id"]: c for c in result["checks"]}
        for critical in [
            "cad3-graph/node-coverage",
            "cad3-graph/provenance-per-node",
            "cad3-graph/engine-ids-unstable-across-regeneration",
            "cad3-graph/canonical-ids-stable-across-regeneration",
            "cad3-graph/stable-across-roundtrip",
            "cad3-graph/provenance-continuous-across-roundtrip",
            "cad3-graph/diff-detects-exact-changes",
            "cad3-graph/field-classification",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    # -- scope 6: IDS/BCF -------------------------------------------------

    def test_ids_bcf(self):
        result = RESULTS["bench-ids-bcf"]
        by_id = {c["id"]: c for c in result["checks"]}
        for critical in [
            "cad3-ids/required-property-exists",
            "cad3-ids/value-discrimination",
            "cad3-ids/negative-control-value",
            "cad3-ids/negative-control-missing",
            "cad3-ids/mutation-tracking",
            "cad3-ids/specification-xml-roundtrip",
            "cad3-bcf/issue-reference-workflow",
            "cad3-bcf/reference-resolves-to-ifc",
            "cad3-ids-bcf/toolchain-provenance",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    # -- evidence requirements: measurements ------------------------------

    def test_performance_measurements(self):
        result = RESULTS["bench-performance"]
        for key in [
            "fixture_build_s", "extraction_s", "export_s", "reimport_s",
            "ifc_bytes", "ids_validation_s", "peak_rss_mib",
        ]:
            self.assertIn(key, result["measurements"], key)


if __name__ == "__main__":
    unittest.main()
