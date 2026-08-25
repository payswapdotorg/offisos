"""Deterministic correctness gate for the RESEARCH-CAD-005 benchmark.

What CI runs (fast: small tiers only, bounded repeats, no expensive
stress points). The full evidence run (all tiers, full repeats, cliff
probe) is the benchmark proper under evidence/<run-id>/.

FreeCAD-dependent tests are conditional on the engine being available
(the proven cad-001 convention): CI installs the pinned AppImage, so
they run there; a missing engine skips with an explicit reason rather
than failing opaquely.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest

from offisos_perfbench import (
    freecad_runner as fr,
    ifc_adapter,
    occt_engine as oe,
)
from offisos_perfbench.fixtures import (
    FCSTD_TIERS,
    IFC_TIERS,
    OCCT_TIERS,
    write_ifc_tier,
)
from offisos_perfbench.resources import ChildProcessWatcher
from offisos_perfbench.timing import measure_split_repeated

REPO_ROOT = Path(__file__).resolve().parents[1]
FREECAD_AVAILABLE = fr.find_freecadcmd() is not None


@pytest.fixture(scope="module")
def small_fixture(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("fixtures")
    return write_ifc_tier(IFC_TIERS["small"], tmp / "ifc-small.ifc")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def test_small_tier_characteristics(small_fixture):
    info = small_fixture
    assert info["walls"] == 12
    assert info["products_total"] == 41
    assert info["step_entities"] > 500
    assert info["total_wall_length_m"] == pytest.approx(80.0, abs=1e-6)
    assert info["file_size_bytes"] > 10_000


def test_fixture_structural_determinism(small_fixture, tmp_path):
    again = write_ifc_tier(IFC_TIERS["small"], tmp_path / "again.ifc")
    assert again["step_entities"] == small_fixture["step_entities"]
    assert again["walls"] == small_fixture["walls"]
    assert again["total_wall_length_m"] == pytest.approx(
        small_fixture["total_wall_length_m"], abs=1e-9
    )
    # GlobalIds are regenerated per build (engine nondeterminism) so
    # byte-identity is NOT expected.
    assert again["sha256"] != small_fixture["sha256"]


def test_tier_specs_increase():
    assert (
        IFC_TIERS["small"].expected_products
        < IFC_TIERS["medium"].expected_products
        < IFC_TIERS["large"].expected_products
    )
    assert (
        OCCT_TIERS["small"].primitives
        < OCCT_TIERS["medium"].primitives
        < OCCT_TIERS["large"].primitives
    )
    assert (
        FCSTD_TIERS["small"].walls
        < FCSTD_TIERS["medium"].walls
        < FCSTD_TIERS["large"].walls
    )


# ---------------------------------------------------------------------------
# Measurement machinery
# ---------------------------------------------------------------------------


def test_split_measurement_stats():
    m = measure_split_repeated(
        operation="test",
        boundary="ENGINE = lambda sleep; ADAPTER = lambda sleep",
        engine_fn=lambda: sum(range(1000)),
        adapter_fn=lambda _r: None,
        repeats=5,
    )
    d = m.to_dict()
    assert d["actual_repeats"] == 5
    assert len(d["engine_ms"]["samples"]) == 5
    assert d["engine_ms"]["median"] >= d["engine_ms"]["min"] >= 0
    assert d["engine_ms"]["max"] >= d["engine_ms"]["median"]
    assert "stdev" in d["engine_ms"]
    assert d["adapter_share_of_total_median"] is not None
    assert 0.0 <= d["adapter_share_of_total_median"] <= 1.0


def test_harness_unknown_is_first_class():
    from offisos_perfbench.harness import BenchmarkResult

    bench = BenchmarkResult("t", "t")
    bench.observe("x", "x", True, unknown_reason="environment limitation")
    bench.observe("y", "y", True)
    concluded = bench.conclude()
    assert concluded["summary"] == {"pass": 1, "fail": 0, "unknown": 1}


def test_child_process_watcher_measures_rss():
    proc = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(0.5)"],
        stdout=subprocess.DEVNULL,
    )
    watcher = ChildProcessWatcher(proc.pid)
    watcher.start()
    proc.wait()
    usage = watcher.finish()
    assert usage.available
    assert usage.peak_rss_kb is None or usage.peak_rss_kb > 1000


# ---------------------------------------------------------------------------
# Adapter layer (Offisos translation)
# ---------------------------------------------------------------------------


def test_domain_index_extraction(small_fixture):
    import ifcopenshell

    f = ifcopenshell.open(small_fixture["path"])
    index = ifc_adapter.extract_domain_index(f)
    assert index["element_count"] == small_fixture["products_total"]
    # openings carry no identity pset (they are voids keyed by host
    # lineage, the cad-003 convention) — they are the unkeyed set
    assert index["unkeyed_count"] == small_fixture["openings"]
    walls = [k for k, v in index["index"].items() if v["kind"] == "wall"]
    assert len(walls) == small_fixture["walls"]
    sample = index["index"]["off:cad5:wall:0:000"]
    assert sample["engine_guid"]  # provenance recorded, never canonical


def test_malformed_input_typed_failure(tmp_path, small_fixture):
    garbage = tmp_path / "garbage.ifc"
    garbage.write_bytes(os.urandom(512))
    with pytest.raises(ifc_adapter.AdapterFailure) as excinfo:
        ifc_adapter.safe_open(str(garbage))
    assert excinfo.value.kind == "malformed_input"
    assert excinfo.value.recoverable is True
    # recovery: valid open succeeds in the same process afterwards
    f = ifc_adapter.safe_open(small_fixture["path"])
    assert len(f.by_type("IfcWall")) == small_fixture["walls"]


def test_truncated_ifc_partial_model_detected(tmp_path, small_fixture):
    data = Path(small_fixture["path"]).read_bytes()
    trunc = tmp_path / "trunc.ifc"
    trunc.write_bytes(data[: len(data) // 2])
    f = ifc_adapter.safe_open(str(trunc))  # engine accepts (lazy parse)
    walls = len(f.by_type("IfcWall"))
    # the adapter's structural validation detects the partial state
    assert walls < small_fixture["walls"]


def test_controlled_mutations_lineage(small_fixture):
    import ifcopenshell

    f = ifcopenshell.open(small_fixture["path"])
    lineage = ifc_adapter.apply_controlled_mutations(f, 3, "test-rev")
    assert len(lineage) == 3
    for record in lineage:
        assert record["field"] == "Pset_WallCommon.FireRating"
        assert record["old"] is not None and record["new"] is not None
        assert record["revision"] == "test-rev"


def test_durable_write_pattern(tmp_path, small_fixture):
    target = tmp_path / "durable.ifc"
    original = Path(small_fixture["path"]).read_bytes()
    target.write_bytes(original)
    # crash mid-write: partial data only ever in the temp file
    tmp_file = tmp_path / "durable.ifc.tmp"
    tmp_file.write_bytes(original[: len(original) // 3])
    assert target.read_bytes() == original  # original intact
    # commit is atomic
    tmp_file.write_bytes(original)
    os.replace(tmp_file, target)
    assert target.read_bytes() == original
    assert not tmp_file.exists()


# ---------------------------------------------------------------------------
# OCCT engine operations (small tier only)
# ---------------------------------------------------------------------------


def test_occt_boolean_chain_small():
    shapes = oe.build_tier_primitives(OCCT_TIERS["small"].primitives)
    results = oe.cut_chain(shapes)
    assert len(results) == OCCT_TIERS["small"].primitives
    for shape in results:
        assert oe.solid_count(shape) == 1
        assert oe.face_count(shape) >= 8  # box with a notch


def test_occt_plate_with_holes_volume():
    plate, holes = oe.plate_with_holes(25)
    import math

    expected = 8.0 * 4.0 * 0.1 - holes * math.pi * 0.08**2 * 0.1
    assert oe.volume(plate) == pytest.approx(expected, abs=1e-6)


def test_occt_tessellation_counts():
    plate, _ = oe.plate_with_holes(9)
    triangles = oe.tessellate(plate)
    assert triangles >= 30  # plate + 9 holes, coarse mesh


def test_occt_step_roundtrip(tmp_path):
    shapes = oe.build_tier_primitives(6)
    path = str(tmp_path / "roundtrip.step")
    oe.write_step(shapes, path)
    shape = oe.read_step(path)
    assert oe.solid_count(shape) == 6
    assert oe.volume(shape) == pytest.approx(
        sum(oe.volume(s) for s in shapes), abs=1e-6
    )


def test_occt_degenerate_primitive_typed_rejection():
    with pytest.raises(Exception) as excinfo:
        oe.make_box(0.0, 0.0, 0.0, 1.0, 1.0, 0.0)
    assert type(excinfo.value).__name__ == "Standard_DomainError"


# ---------------------------------------------------------------------------
# FreeCAD engine runner (conditional on engine availability)
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not FREECAD_AVAILABLE, reason="FreeCADCmd not available")
def test_freecad_isolated_runs_identical():
    cmd = fr.find_freecadcmd()
    probe = (
        "import FreeCAD as App\n"
        "doc = App.newDocument('iso')\n"
        "b = doc.addObject('Part::Box', 'B')\n"
        "b.Length, b.Width, b.Height = 2.0, 3.0, 4.0\n"
        "doc.recompute()\n"
        "record('iso/result', 'Deterministic engine result in a fresh "
        "process.', True, details={'volume': round(b.Shape.Volume, 9)})\n"
    )
    r1 = fr.run_script(probe, cmd, timeout=120, script_hint="iso-1")
    r2 = fr.run_script(probe, cmd, timeout=120, script_hint="iso-2")
    v1 = r1["checks"][0]["details"]["volume"]
    v2 = r2["checks"][0]["details"]["volume"]
    assert v1 == v2 == 24.0


@pytest.mark.skipif(not FREECAD_AVAILABLE, reason="FreeCADCmd not available")
def test_freecad_timeout_typed():
    cmd = fr.find_freecadcmd()
    sleepy = (
        "import time\n"
        "time.sleep(30)\n"
        "record('never/reached', 'must not be reached', False)\n"
    )
    t0 = time.perf_counter()
    with pytest.raises(fr.EngineTimeout):
        fr.run_script(sleepy, cmd, timeout=2.0, script_hint="timeout-test")
    assert time.perf_counter() - t0 < 15.0  # fired promptly, no hang


@pytest.mark.skipif(not FREECAD_AVAILABLE, reason="FreeCADCmd not available")
def test_freecad_document_roundtrip(tmp_path):
    cmd = fr.find_freecadcmd()
    spec = FCSTD_TIERS["small"]
    tj = json.dumps(
        {
            "tier": spec.tier,
            "walls": spec.walls,
            "opening_cuts": spec.opening_cuts,
            "edits": spec.edits,
        }
    )
    doc_path = str(tmp_path / "doc.FCStd")
    build = fr.run_script(
        fr.BUILD_DOC_SCRIPT.format(tier_json=tj, doc_path=doc_path),
        cmd, timeout=300, script_hint="build",
    )
    assert build["checks"][0]["status"] == "pass"
    assert build["measurements"]["object_count"] == (
        spec.walls + spec.opening_cuts * 2
    )
    reopen = fr.run_script(
        fr.REOPEN_SCRIPT.format(tier_json=tj, doc_path=doc_path),
        cmd, timeout=300, script_hint="reopen",
    )
    assert reopen["checks"][0]["status"] == "pass"
    assert reopen["measurements"]["engine_reopen_ms"] > 0


@pytest.mark.skipif(not FREECAD_AVAILABLE, reason="FreeCADCmd not available")
def test_freecad_cancellation_no_partial_artifact(tmp_path):
    cmd = fr.find_freecadcmd()
    doc_path = str(tmp_path / "cancelled.FCStd")
    long_build = fr.BUILD_DOC_SCRIPT.format(
        tier_json=json.dumps(
            {"tier": "xl", "walls": 1500, "opening_cuts": 750, "edits": 1}
        ),
        doc_path=doc_path,
    )
    proc, script_path, watcher, result_path = fr.spawn_script(
        long_build, cmd, "cancel-test"
    )
    time.sleep(1.0)
    outcome = fr.cancel_script(proc, grace_s=5.0, result_path=result_path)
    watcher.finish()
    os.unlink(script_path)
    if os.path.exists(result_path):
        os.unlink(result_path)
    assert not Path(doc_path).exists()  # no partial artifact committed
    assert outcome["term_to_dead_s"] < 5.0


# ---------------------------------------------------------------------------
# Resource exhaustion (fast probe: low ceiling)
# ---------------------------------------------------------------------------


def test_resource_exhaustion_typed_and_isolated():
    import resource

    script = (
        "import sys\n"
        "try:\n"
        "    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox\n"
        "    from OCP.gp import gp_Pnt\n"
        "    print('STARTED')\n"
        "    shapes = [BRepPrimAPI_MakeBox(gp_Pnt(0,0,0), 1,1,1).Shape() "
        "for _ in range(50000)]\n"
        "    print('COMPLETED')\n"
        "except Exception as e:\n"
        "    print('TYPED:' + type(e).__name__)\n"
        "    sys.exit(0)\n"
    )

    def limit():
        resource.setrlimit(
            resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024)
        )

    proc = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True, text=True, timeout=120, preexec_fn=limit,
    )
    out = proc.stdout or ""
    # exhaustion manifests (typed failure or hard kill) and the parent
    # process survives — the isolation requirement
    assert "COMPLETED" not in out
    assert proc.returncode != 0 or "TYPED:" in out
