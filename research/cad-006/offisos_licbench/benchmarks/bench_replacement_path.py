"""Benchmark: adapter boundary as the LGPL-compliance mechanism (RESEARCH-CAD-006 item 6).

The frozen adapter boundary (Architecture v1.1) is the architectural
mechanism that makes LGPL composition tractable in both deployment models:
it isolates the LGPL-licensed CAD/BIM components (OCCT, IfcOpenShell,
FreeCAD) behind a process/adapter contract so that they remain
user-replaceable without exposing proprietary adapter code. The
replacement contract was proven by RESEARCH-CAD-001 item 9 (the identical
domain-level suite passes through both the IfcOpenShell+OCCT adapter and a
pure-Python reference adapter with no CAD engine).
"""
from __future__ import annotations


def run(result) -> None:
    from ..inventory import ADAPTER_BOUNDARY, COPYLEFT_COMPONENTS

    # ------------------------------------------------------------------
    # 1. The adapter boundary is frozen at Architecture v1.1.
    # ------------------------------------------------------------------
    result.observe(
        "replacement/adapter-boundary-v1.1-frozen",
        "The adapter boundary is frozen at Architecture v1.1 (FROZEN in "
        "governance/architecture-versions.json), defined by spec/architecture.md, "
        "spec/architecture-lock.md and ACR-002 (the CAD/BIM web+desktop client "
        "topology change request).",
        ADAPTER_BOUNDARY["version"] == "1.1" and ADAPTER_BOUNDARY["status"] == "FROZEN",
        details={
            "version": ADAPTER_BOUNDARY["version"],
            "status": ADAPTER_BOUNDARY["status"],
            "defined_by": ADAPTER_BOUNDARY["defined_by"],
        },
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 2. The adapter-replacement proof is referenced (RESEARCH-CAD-001 item
    #    9: domain-level suite imports no engine modules; engines confined
    #    to engines/; swapping requires implementing the CadBimAdapter
    #    contract only; unsupported operations raise typed errors).
    # ------------------------------------------------------------------
    result.observe(
        "replacement/adapter-replacement-proof-referenced",
        "The adapter-replacement proof (RESEARCH-CAD-001 item 9) is "
        "referenced as the basis: the identical domain-level test suite "
        "(which imports no engine modules) produces identical results through "
        "the IfcOpenShell+OCCT adapter and a pure-Python reference adapter "
        "with no CAD engine (within 1e-9); unsupported operations raise the "
        "typed UnsupportedOperationError (no silent fallback); engine "
        "imports are confined to offisos_cadbench/engines/.",
        True,
        details={
            "proof_reference": ADAPTER_BOUNDARY["proof_reference"],
            "findings": [
                "domain-results-identical through both adapters (within 1e-9)",
                "per-element-quantities-identical",
                "typed-unsupported-operation (UnsupportedOperationError, no silent fallback)",
                "engine imports confined to offisos_cadbench/engines/",
                "swapping the engine requires implementing the CadBimAdapter contract only",
            ],
        },
        epistemic="INFERRED",
    )

    # ------------------------------------------------------------------
    # 3. The adapter boundary preserves the LGPL user-replacement right for
    #    every copyleft component in the tested stack (the central fact).
    # ------------------------------------------------------------------
    lgpl_components = list(COPYLEFT_COMPONENTS.keys())
    result.observe(
        "replacement/lgpl-user-replaceability-preserved",
        "The frozen adapter/process boundary preserves the LGPL user-"
        "replacement right for every copyleft component in the tested stack: "
        "OCCT, IfcOpenShell and FreeCAD run behind a process/adapter "
        "boundary, so a user can replace any of them (with a compatible "
        "implementation of the CadBimAdapter contract) without touching "
        "proprietary adapter code.",
        len(lgpl_components) >= 3,
        details={
            "lgpl_components_isolated": lgpl_components,
            "mechanism": ADAPTER_BOUNDARY["lgpl_significance"],
            "satisfies": "LGPL user-replacement right (OCCT exception preserved under dynamic/separate-process linking; IfcOpenShell LGPL-3 Section 4 satisfied by separability for desktop distribution; FreeCAD AppImage is a swap-as-a-unit replaceable bundle)",
        },
        epistemic="INFERRED",
        evidence_refs=[
            "replacement/adapter-boundary-v1.1-frozen",
            "replacement/adapter-replacement-proof-referenced",
        ],
    )

    # ------------------------------------------------------------------
    # 4. The replacement path is forward-compatible: CAD-007 (the final
    #    CAD/BIM feasibility gate) will prove the adapter boundary,
    #    replacement path and existential end-to-end workflow. This gate's
    #    scope is licensing/composition evidence only; the replacement-path
    #    PROOF is CAD-007's (per the Issue #6 directive).
    # ------------------------------------------------------------------
    result.observe(
        "replacement/final-proof-deferred-to-cad-007",
        "The final adapter-boundary + replacement-path + end-to-end-workflow "
        "proof is deferred to RESEARCH-CAD-007 (the final CAD/BIM feasibility "
        "gate, per the Issue #6 directive). This gate (CAD-006) covers "
        "licensing/composition evidence only; it references CAD-001's existing "
        "replacement proof as the basis for the LGPL-compliance analysis, it "
        "does not re-prove the replacement path end-to-end.",
        True,
        details={
            "this_gate_scope": "exact-version licensing/composition evidence (web + Electron/desktop)",
            "cad_007_scope": "adapter boundary + replacement path + existential end-to-end workflow (final CAD/BIM feasibility gate)",
            "directive_source": "Issue #6 execution directive",
        },
        epistemic="INFERRED",
        evidence_refs=["replacement/adapter-replacement-proof-referenced"],
    )

    # ------------------------------------------------------------------
    # 5. No weakening of the LGPL user-replacement right is proposed: the
    #    composition flags recommend dynamic/separate-process composition
    #    (not static linking), which is the LGPL-compliant posture.
    # ------------------------------------------------------------------
    result.observe(
        "replacement/no-lgpl-right-weakening-proposed",
        "No weakening of the LGPL user-replacement right is proposed by this "
        "gate. The composition flags recommend dynamic/separate-process "
        "composition (the LGPL-compliant posture), and explicitly flag "
        "static linking of LGPL into closed-source code as review-required "
        "(object files / relinking capability would then be mandatory).",
        True,
        details={
            "recommended_posture": "dynamic / separate-process composition behind the frozen adapter boundary",
            "flagged_avoid": "static linking of LGPL into closed-source code",
        },
        epistemic="INFERRED",
        evidence_refs=[
            "replacement/lgpl-user-replaceability-preserved",
            "deployment/desktop/no-static-linking-of-lgpl-into-closed-source",
        ],
    )
