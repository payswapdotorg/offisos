"""Deterministic correctness gate for the RESEARCH-CAD-006 benchmark.

Runs the full licensing/composition inventory in-process and asserts:
  - zero failures (and the no-approval invariant holds);
  - exact versions recorded for every tested component;
  - licenses identified and SPDX-classified for every component;
  - composition flags raised for every component (matrix complete);
  - both deployment models (web + Electron/desktop) covered;
  - the adapter boundary is frozen at v1.1 and the LGPL user-replacement
    right is preserved (the central composition fact);
  - no GPL (strong-copyleft) component in the tested stack.

This mirrors the RESEARCH-CAD-001 deterministic gate contract.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make the package importable when run via `python3 -m pytest tests/`.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from offisos_licbench.benchmarks import run_all  # noqa: E402
from offisos_licbench.harness import environment_snapshot  # noqa: E402
from offisos_licbench.inventory import (  # noqa: E402
    ADAPTER_BOUNDARY,
    COPYLEFT_COMPONENTS,
    DEPLOYMENT_MODELS,
    TESTED_COMPONENTS,
)

OUT = ROOT / "evidence" / "ci-run"


def _run_in_process():
    """Run the full benchmark in-process and return the results list."""
    OUT.mkdir(parents=True, exist_ok=True)
    # run_all writes evidence and returns the exit code; we want the results.
    # Re-implement the loop inline to capture results without file I/O for
    # the deterministic assertion path.
    from offisos_licbench.benchmarks import (
        bench_composition,
        bench_deployment_desktop,
        bench_deployment_web,
        bench_licenses,
        bench_replacement_path,
        bench_versions,
    )
    from offisos_licbench.harness import BenchmarkResult

    modules = [
        ("bench-versions", bench_versions),
        ("bench-licenses", bench_licenses),
        ("bench-composition", bench_composition),
        ("bench-deployment-web", bench_deployment_web),
        ("bench-deployment-desktop", bench_deployment_desktop),
        ("bench-replacement-path", bench_replacement_path),
    ]
    results = []
    for bid, mod in modules:
        bench = BenchmarkResult(bid, (mod.__doc__ or "").strip().split("\n")[0])
        mod.run(bench)
        results.append(bench.conclude())
    return results


def test_zero_failures():
    results = _run_in_process()
    total_fail = sum(r["summary"]["fail"] for r in results)
    total_unknown = sum(r["summary"]["unknown"] for r in results)
    assert total_fail == 0, f"{total_fail} checks failed: {[(r['benchmark'], [c['id'] for c in r['checks'] if c['status']=='fail']) for r in results]}"
    # unknowns are first-class; this gate expects zero unknowns because every
    # fact is recorded from the authoritative pinned sources.
    assert total_unknown == 0, f"{total_unknown} unknown checks: {[(r['benchmark'], [c['id'] for c in r['checks'] if c['status']=='unknown']) for r in results]}"


def test_exact_versions_recorded():
    _run_in_process()  # ensure modules execute without error
    for component, facts in TESTED_COMPONENTS.items():
        assert facts["version"], f"missing version for {component}"


def test_licenses_identified_and_classified():
    for component, facts in TESTED_COMPONENTS.items():
        assert facts["license"], f"missing license for {component}"
        assert facts["upstream"], f"missing upstream for {component}"
        assert facts["composition_flag"], f"missing composition flag for {component}"
        assert facts["flag_severity"], f"missing flag severity for {component}"


def test_composition_matrix_complete():
    assert len(TESTED_COMPONENTS) >= 8  # ifcopenshell, occt, cadquery-ocp, cadquery, ezdxf, numpy, freecad, python
    assert len(COPYLEFT_COMPONENTS) >= 3  # ifcopenshell, occt, freecad


def test_no_strong_gpl_in_tested_stack():
    pure_gpl = [
        name for name, facts in TESTED_COMPONENTS.items()
        if facts["license"].startswith("GPL-")
    ]
    assert pure_gpl == [], f"unexpected GPL components in tested stack: {pure_gpl}"


def test_both_deployment_models_covered():
    assert set(DEPLOYMENT_MODELS.keys()) == {"web", "desktop"}
    for model, facts in DEPLOYMENT_MODELS.items():
        assert facts["tested_path"], f"missing tested_path for {model}"
        assert facts["lgpl_posture"], f"missing lgpl_posture for {model}"
        assert facts["flag"], f"missing flag for {model}"


def test_adapter_boundary_frozen_at_v1_1():
    assert ADAPTER_BOUNDARY["version"] == "1.1"
    assert ADAPTER_BOUNDARY["status"] == "FROZEN"
    assert "ACR-002" in " ".join(ADAPTER_BOUNDARY["defined_by"])


def test_no_approval_invariant():
    """The benchmark must not approve any composition — LICENSE-001 decides."""
    results = _run_in_process()
    comp = next(r for r in results if r["benchmark"] == "bench-composition")
    no_approval = next(
        c for c in comp["checks"] if c["id"] == "composition/no-approval-recorded"
    )
    assert no_approval["status"] == "pass"
    assert no_approval["details"]["decision_owner"] == "LICENSE-001 (not this gate)"


def test_freecad_appimage_sha256_integrity():
    results = _run_in_process()
    ver = next(r for r in results if r["benchmark"] == "bench-versions")
    sha_check = next(
        c for c in ver["checks"] if c["id"] == "versions/freecad-appimage-hash"
    )
    assert sha_check["status"] == "pass"
    assert (
        sha_check["details"]["expected_sha256"]
        == "3a853eb69ee595f779f2255dbf80a765926981d8ff68903cefee4dfb03a8f5ef"
    )


def test_environment_snapshot_has_provenance_sources():
    env = environment_snapshot()
    assert "cad001_requirements_pins" in env
    # direct pins in CAD-001 requirements.txt
    assert env["cad001_requirements_pins"].get("ifcopenshell") == "0.8.5"
    assert env["cad001_requirements_pins"].get("cadquery") == "2.6.1"
    assert env["cad001_requirements_pins"].get("ezdxf") == "1.4.3"
    assert env["cad001_requirements_pins"].get("numpy") == "2.1.3"
    assert "snapshot_cross_reference" in env
    # every CAD-001..005 snapshot must be referenced
    for gate in ["cad-001", "cad-002", "cad-003", "cad-004", "cad-005"]:
        assert gate in env["snapshot_cross_reference"]
    assert env.get("freecad_appimage_manifest") is not None
    # cadquery-ocp is a transitive dep (not a direct pin); its version comes
    # from the committed environment snapshots (occt_version field).
    assert env.get("occt_runtime_version") == "7.8.1.1.post1"


def test_run_all_orchestrator_exit_zero():
    """The full orchestrator (file-writing path) must exit 0."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        rc = run_all.run_all(Path(tmp))
    assert rc == 0
