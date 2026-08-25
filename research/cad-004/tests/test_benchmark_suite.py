"""Deterministic CI tests for the RESEARCH-CAD-004 benchmark suite.

Runs the complete benchmark in-process and asserts zero failures and
zero unknowns, plus critical capability checks per issue-#4 scope area.
"""
from __future__ import annotations

import unittest
from pathlib import Path

import sys

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from offisos_qtybench.benchmarks.run_all import BENCHMARKS  # noqa: E402


def _run_all_checks() -> dict[str, dict]:
    from offisos_qtybench.harness import BenchmarkResult

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
        self.assertEqual([], unknowns, "no unknowns permitted (pip toolchain)")

    def test_fixture_corpus(self):
        by_id = {c["id"]: c for c in RESULTS["bench-fixture"]["checks"]}
        for critical in [
            "cad4-fixture/element-corpus",
            "cad4-fixture/quantity-classes",
            "cad4-fixture/instanced-elements",
            "cad4-fixture/mixed-unit-variant",
            "cad4-fixture/stored-quantities-exact",
            "cad4-fixture/ghost-unknown",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    def test_extraction(self):
        by_id = {c["id"]: c for c in RESULTS["bench-extraction"]["checks"]}
        for critical in [
            "cad4-extract/determinism",
            "cad4-extract/regeneration-determinism",
            "cad4-extract/dual-path-agreement",
            "cad4-extract/weight-calculation",
            "cad4-extract/epistemic-states",
            "cad4-extract/provenance-method-distinction",
            "cad4-extract/mixed-unit-conversion",
            "cad4-extract/mixed-unit-raw-values",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    def test_provenance_versioning(self):
        by_id = {c["id"]: c for c in RESULTS["bench-provenance"]["checks"]}
        for critical in [
            "cad4-prov/provenance-completeness",
            "cad4-prov/engine-version-recorded",
            "cad4-prov/revision-new-state-not-mutation",
            "cad4-prov/version-history-coexists",
            "cad4-prov/reproducible-re-extraction",
            "cad4-prov/historical-replay",
            "cad4-prov/element-identity-link",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    def test_propagation(self):
        by_id = {c["id"]: c for c in RESULTS["bench-propagation"]["checks"]}
        for critical in [
            "cad4-prop/exact-delta-v1-v2",
            "cad4-prop/unchanged-element-identity",
            "cad4-prop/exact-delta-v2-v3",
            "cad4-prop/property-only-no-quantity-delta",
            "cad4-prop/change-record-emitted",
            "cad4-prop/change-record-deterministic",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    def test_graph_mapping(self):
        by_id = {c["id"]: c for c in RESULTS["bench-graph"]["checks"]}
        for critical in [
            "cad4-graph/domain-id-keyed",
            "cad4-graph/provenance-and-uncertainty-survive",
            "cad4-graph/uncertainty-summary",
            "cad4-graph/engine-id-non-canonicality",
            "cad4-graph/consumer-api",
            "cad4-graph/diff-v1-v2",
            "cad4-graph/diff-v2-v3",
            "cad4-graph/dual-path-graph-agreement",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    def test_downstream_contracts(self):
        by_id = {c["id"]: c for c in RESULTS["bench-downstream"]["checks"]}
        for critical in [
            "cad4-down/deterministic-derivation",
            "cad4-down/amounts-and-provenance",
            "cad4-down/exact-amount-spot-check",
            "cad4-down/unknown-never-priced",
            "cad4-down/rfq-scope-grouping",
            "cad4-down/scope-total-exact",
            "cad4-down/rfq-impact-v1-v2",
            "cad4-down/rfq-impact-v2-v3",
            "cad4-down/window-line-delta-exact",
        ]:
            self.assertEqual("pass", by_id[critical]["status"], critical)

    def test_performance_measurements(self):
        m = RESULTS["bench-performance"]["measurements"]
        for key in [
            "model_build_v1_s", "extraction_v1_s", "graph_mapping_s",
            "downstream_derivation_s", "ifc_bytes_v1", "quantity_records_v1",
            "graph_nodes_v1", "estimate_line_items_v1", "peak_rss_mib",
        ]:
            self.assertIn(key, m, key)


if __name__ == "__main__":
    unittest.main()
