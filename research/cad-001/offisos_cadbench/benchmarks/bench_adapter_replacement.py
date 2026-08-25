"""Benchmark: adapter boundary and replacement proof (RESEARCH-CAD-001 item 9).

Runs the identical domain-level test suite through two different adapter
implementations:

- IfcOpenShellAdapter (the real candidate engine stack);
- ReferenceAdapter (a pure-Python reference implementation with no CAD
  engine at all).

If both produce identical domain-level results, the domain layer is
demonstrably engine-independent: swapping engines means writing a new
adapter, not changing domain code. Also demonstrates the typed
UnsupportedOperationError contract for capabilities an engine lacks.
"""
from __future__ import annotations

from ..fixtures import SMALL_EXPECTED


def domain_test_suite(adapter) -> dict:
    """Domain-level test suite — uses ONLY the adapter contract.

    This function must not import any engine module. It builds the standard
    small building through the contract and reports all quantities.
    """
    from .bench_bim_semantics import build_small_model

    model = build_small_model(adapter, "replacement-test")
    walls = [e for e in model.elements if e.kind == "wall"]
    slabs = [e for e in model.elements if e.kind == "slab"]
    spaces = [e for e in model.elements if e.kind == "space"]
    fillings = [e for e in model.elements if e.kind in ("door", "window")]
    report = {
        "wall_count": len(walls),
        "slab_count": len(slabs),
        "space_count": len(spaces),
        "filling_count": len(fillings),
        "voids_relationships": sum(
            1 for r in model.relationships if r["type"] == "voids"
        ),
        "fills_relationships": sum(
            1 for r in model.relationships if r["type"] == "fills"
        ),
        "wall_gross_volume_sum": sum(
            e.domain_quantities["GrossVolume"].value for e in walls
        ),
        "wall_net_volume_sum": sum(
            e.domain_quantities["NetVolume"].value for e in walls
        ),
        "slab_volume": slabs[0].domain_quantities["GrossVolume"].value,
        "space_area": spaces[0].domain_quantities["GrossFloorArea"].value,
        "per_wall_net_volumes": sorted(
            round(e.domain_quantities["NetVolume"].value, 9)
            for e in walls
        ),
    }
    return report


def run(result) -> None:
    from ..engines.ifc_adapter import IfcOpenShellAdapter
    from ..engines.reference_adapter import ReferenceAdapter
    from ..adapter import UnsupportedOperationError

    # ------------------------------------------------------------------
    # 1. Identical domain results through both adapters
    # ------------------------------------------------------------------
    ifc_report = domain_test_suite(IfcOpenShellAdapter())
    ref_report = domain_test_suite(ReferenceAdapter())

    scalar_fields = [
        "wall_count", "slab_count", "space_count", "filling_count",
        "voids_relationships", "fills_relationships",
        "wall_gross_volume_sum", "wall_net_volume_sum",
        "slab_volume", "space_area",
    ]
    mismatches = [
        f for f in scalar_fields
        if abs(ifc_report[f] - ref_report[f]) > 1e-9
    ]
    result.observe(
        "replacement/domain-results-identical",
        "The identical domain-level test suite produces identical results "
        "through the IfcOpenShell+OCCT adapter and the pure-Python reference "
        "adapter (within 1e-9): the domain layer does not depend on the engine.",
        not mismatches,
        details={
            "ifc": {k: ifc_report[k] for k in scalar_fields},
            "reference": {k: ref_report[k] for k in scalar_fields},
            "mismatches": mismatches,
        },
        epistemic="OBSERVED",
    )

    per_wall_ok = ifc_report["per_wall_net_volumes"] == ref_report["per_wall_net_volumes"]
    result.observe(
        "replacement/per-element-quantities-identical",
        "Per-wall net volumes are identical through both adapters.",
        per_wall_ok,
        details={
            "ifc": ifc_report["per_wall_net_volumes"],
            "reference": ref_report["per_wall_net_volumes"],
        },
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 2. Expected values (independent of either adapter)
    # ------------------------------------------------------------------
    result.assert_close(
        "replacement/wall-count-expected",
        "Both adapters report the fixture wall count (4).",
        ifc_report["wall_count"], SMALL_EXPECTED["wall_count"], 0,
        epistemic="CALCULATED",
    )
    result.assert_close(
        "replacement/wall-net-volume-expected",
        "Both adapters report the analytic wall net volume sum (21.69 m^3).",
        ifc_report["wall_net_volume_sum"], SMALL_EXPECTED["wall_net_volume_sum"], 1e-9,
        epistemic="CALCULATED",
    )

    # ------------------------------------------------------------------
    # 3. Typed failure for unsupported capability
    # ------------------------------------------------------------------
    ref = ReferenceAdapter()
    model = ref.create_model("unsupported")
    try:
        ref.export_ifc(model, "/tmp/should-not-exist.ifc")
        typed_failure = False
    except UnsupportedOperationError:
        typed_failure = True
    except Exception:
        typed_failure = False
    result.observe(
        "replacement/typed-unsupported-operation",
        "A reference adapter without IFC capability raises the typed "
        "UnsupportedOperationError instead of silently writing a non-IFC file.",
        typed_failure,
        details={"contract": "UnsupportedOperationError"},
        epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 4. What would have to change to swap the engine (documentation-as-code)
    # ------------------------------------------------------------------
    result.observe(
        "replacement/swap-scope",
        "Swapping the engine requires implementing the CadBimAdapter contract "
        "(create_model/add_wall/add_slab/add_space/export_ifc/import_ifc/"
        "extract_quantities); the domain test suite (domain_test_suite above) "
        "runs unchanged against any implementation.",
        True,
        details={
            "adapter_contract_methods": [
                "create_model", "add_wall", "add_slab", "add_space",
                "export_ifc", "import_ifc", "extract_quantities",
            ],
            "engine_imports_confined_to": "offisos_cadbench/engines/",
            "note": "engine modules are imported only inside adapter "
            "implementations; the domain suite imports none",
        },
        epistemic="ADAPTER",
    )

    result.measure("ifc_engine", "ifcopenshell+occt")
    result.measure("reference_engine", "reference-python")
