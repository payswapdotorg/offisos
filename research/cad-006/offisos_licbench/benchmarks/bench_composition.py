"""Benchmark: composition flags for LICENSE-001 (RESEARCH-CAD-006 item 3).

Raises explicit composition flags for the LICENSE-001 licensing gate. This
benchmark APPROVES NO COMPOSITION — it records facts (copyleft components,
permissive components, the no-GPL fact, the deployment-model-specific
constraints) for LICENSE-001's legal/architect review. The decision is
LICENSE-001's, not this gate's.
"""
from __future__ import annotations


def run(result) -> None:
    from ..inventory import (
        COPYLEFT_COMPONENTS,
        PERMISSIVE_COMPONENTS,
        TESTED_COMPONENTS,
    )

    # ------------------------------------------------------------------
    # 1. All copyleft (LGPL) components are flagged for LICENSE-001 review.
    # ------------------------------------------------------------------
    copyleft_flags = []
    for name, facts in COPYLEFT_COMPONENTS.items():
        copyleft_flags.append({
            "component": name,
            "version": facts["version"],
            "license": facts["license"],
            "flag": facts["composition_flag"],
            "severity": facts["flag_severity"],
        })
    result.observe(
        "composition/copyleft-components-flagged",
        "Every copyleft (LGPL) component in the tested stack is flagged with "
        "its composition constraint for the LICENSE-001 review.",
        len(copyleft_flags) >= 3,  # ifcopenshell + occt + freecad
        details={"copyleft_flags": copyleft_flags},
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 2. All permissive components are identified (no copyleft concern).
    # ------------------------------------------------------------------
    permissive_flags = []
    for name, facts in PERMISSIVE_COMPONENTS.items():
        permissive_flags.append({
            "component": name,
            "version": facts["version"],
            "license": facts["license"],
            "flag": facts["composition_flag"],
            "severity": facts["flag_severity"],
        })
    result.observe(
        "composition/permissive-components-identified",
        "Every permissive-license component is identified (no copyleft concern "
        "from these components).",
        len(permissive_flags) >= 4,  # cadquery-ocp + cadquery + ezdxf + numpy + python
        details={"permissive_flags": permissive_flags},
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 3. Composition flag matrix is complete (every component has a flag +
    #    severity). The matrix is the deliverable to LICENSE-001.
    # ------------------------------------------------------------------
    matrix = []
    complete = True
    for name, facts in TESTED_COMPONENTS.items():
        entry = {
            "component": name,
            "version": facts["version"],
            "license": facts["license"],
            "flag": facts.get("composition_flag", ""),
            "severity": facts.get("flag_severity", ""),
        }
        matrix.append(entry)
        if not entry["flag"] or not entry["severity"]:
            complete = False
    result.observe(
        "composition/flag-matrix-complete",
        "The composition flag matrix is complete: every component carries an "
        "explicit flag and severity for the LICENSE-001 review.",
        complete,
        details={"matrix": matrix},
        epistemic="OBSERVED",
    )
    result.measure("composition_matrix_entries", len(matrix))

    # ------------------------------------------------------------------
    # 4. Explicit non-approval: this gate approves no composition. The
    #    decision owner is recorded as LICENSE-001 (INFERRED from the gate's
    #    scope statement, with the supporting checks above).
    # ------------------------------------------------------------------
    result.observe(
        "composition/no-approval-recorded",
        "This gate approves NO composition. The composition decision owner is "
        "LICENSE-001 (the open-source composition and licensing gate), per "
        "spec/work-items.md. This benchmark produces the inventory and flags "
        "FOR that gate; it does not decide.",
        True,
        details={
            "decision_owner": "LICENSE-001 (not this gate)",
            "scope_per_issue_6": "exact-version licensing/composition EVIDENCE only; no legal approval or production packaging change implied",
        },
        epistemic="INFERRED",
        evidence_refs=[
            "composition/copyleft-components-flagged",
            "composition/permissive-components-identified",
            "composition/flag-matrix-complete",
        ],
    )

    # ------------------------------------------------------------------
    # 5. Cross-cutting invariant: no GPL contamination path exists from the
    #    tested CAD/BIM stack into a closed-source composition (all copyleft
    #    present is LGPL, which is user-replaceable behind the adapter
    #    boundary). This is the central composition fact for LICENSE-001.
    # ------------------------------------------------------------------
    pure_gpl = [
        name for name, facts in TESTED_COMPONENTS.items()
        if facts["license"].startswith("GPL-")
    ]
    result.observe(
        "composition/no-gpl-contamination-path",
        "No GPL (strong-copyleft) component is present in the tested stack, so "
        "no GPL-contamination path exists from the CAD/BIM stack into a "
        "closed-source composition. All copyleft present is LGPL (weak, "
        "user-replaceable behind the frozen adapter boundary).",
        len(pure_gpl) == 0,
        details={
            "pure_gpl": pure_gpl,
            "lgpl_components": list(COPYLEFT_COMPONENTS.keys()),
            "mechanism": "the frozen adapter/process boundary (Architecture v1.1) isolates the LGPL components, preserving user-replaceability — see bench_replacement_path.",
        },
        epistemic="INFERRED",
        evidence_refs=[
            "composition/copyleft-components-flagged",
            "composition/no-approval-recorded",
        ],
    )
