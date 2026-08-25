"""Benchmark: downstream estimate/RFQ contract readiness (scope 6).

CONTRACT-LEVEL EVIDENCE ONLY (non-goal: no production estimate/RFQ
implementation). Proves that quantity outputs have sufficient stable
identity and semantics to feed the frozen interfaces:

- deterministic estimate line items with stable line ids across
  re-derivations;
- amounts exact (quantity x rate, provenance refs carried);
- RFQ scope grouping deterministic;
- model revision impacts EXACTLY the scopes containing changed line
  items (structural change -> structural RFQ; window change ->
  fenestration RFQ; fit-out untouched);
- UNKNOWN quantities are never priced (epistemic honesty downstream).
"""
from __future__ import annotations


def run(result) -> None:
    from ..downstream import (
        RATE_TABLE,
        derive_estimate,
        group_rfq_scopes,
        rfq_impact,
    )
    from ..fixtures import build_model
    from ..quantity_records import extract_snapshot

    snaps = {v: extract_snapshot(build_model(v), v) for v in ("v1", "v2", "v3")}
    estimates = {v: derive_estimate(snaps[v]) for v in snaps}
    scopes = {v: group_rfq_scopes(estimates[v]) for v in snaps}

    # ------------------------------------------------------------------
    # 1. Deterministic derivation with stable line ids
    # ------------------------------------------------------------------
    est_again = derive_estimate(snaps["v1"])
    result.observe(
        "cad4-down/deterministic-derivation",
        "Deriving the estimate from the same snapshot twice produces "
        "IDENTICAL line items (stable line ids of the form "
        "EST:<domain_id>#<quantity>@<version> — identity survives "
        "re-derivation).",
        [i.line_id for i in estimates["v1"]] == [i.line_id for i in est_again]
        and all(
            a.amount == b.amount and a.provenance_ref == b.provenance_ref
            for a, b in zip(estimates["v1"], est_again)
        ),
        details={"line_count": len(estimates["v1"])},
        epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 2. Amounts exact: quantity x rate with provenance carried
    # ------------------------------------------------------------------
    amounts_ok = all(
        abs(item.amount - round(item.quantity_value * item.unit_rate, 6)) <= 1e-6
        for item in estimates["v1"]
    )
    provenance_ok = all(
        item.provenance_ref
        == f"{item.element_domain_id}#{item.quantity_name}@{item.model_version}"
        for item in estimates["v1"]
    )
    result.observe(
        "cad4-down/amounts-and-provenance",
        "Every line item amount is exactly quantity x unit rate, and "
        "every line item carries its quantity-record provenance "
        "reference (traceable to model version + element + extraction "
        "method).",
        amounts_ok and provenance_ok,
        details={"rate_table_entries": len(RATE_TABLE),
                 "sample": {
                     i.line_id: (i.quantity_value, i.unit_rate, i.amount)
                     for i in estimates["v1"][:3]
                 }},
        epistemic="ADAPTER",
    )

    # spot-check an exact amount: wall-north net volume 8.46 x 650 EUR
    north = next(
        i for i in estimates["v1"]
        if i.element_domain_id == "off:cad4:wall:north"
        and i.quantity_name == "BRepNetVolume"
    )
    result.observe(
        "cad4-down/exact-amount-spot-check",
        "Spot check: wall-north BRepNetVolume (8.46 m^3) x 650 EUR/m^3 = "
        "5499.00 EUR exactly.",
        abs(north.amount - 5499.0) <= 1e-6,
        details={"line": north.line_id, "amount": north.amount},
        epistemic="CALCULATED",
    )

    # ------------------------------------------------------------------
    # 3. UNKNOWN quantities never priced
    # ------------------------------------------------------------------
    ghost_lines = [
        i for i in estimates["v1"]
        if i.element_domain_id == "off:cad4:wall:ghost"
    ]
    result.observe(
        "cad4-down/unknown-never-priced",
        "EPISTEMIC HONESTY DOWNSTREAM: the ghost wall's UNKNOWN quantity "
        "produces NO estimate line item — no price is ever derived from "
        "a value the system does not have.",
        not ghost_lines,
        details={"ghost_lines": ghost_lines}, epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 4. RFQ scope grouping deterministic with exact totals
    # ------------------------------------------------------------------
    v1_scopes = {s.scope_id: s for s in scopes["v1"]}
    result.observe(
        "cad4-down/rfq-scope-grouping",
        "Line items group into deterministic RFQ scopes (structural / "
        "fenestration / fit-out) with exact totals; regrouping is "
        "reproducible.",
        set(v1_scopes.keys())
        == {"RFQ-STRUCTURAL", "RFQ-FENESTRATION", "RFQ-FITOUT"}
        and group_rfq_scopes(estimates["v1"]) == scopes["v1"],
        details={sid: {"lines": len(s.line_item_ids), "total": s.total_amount}
                 for sid, s in v1_scopes.items()},
        epistemic="ADAPTER",
    )
    structural_total = sum(
        i.amount for i in estimates["v1"] if i.rfq_scope == "RFQ-STRUCTURAL"
    )
    result.observe(
        "cad4-down/scope-total-exact",
        "Scope totals are exact sums of their line items "
        "(RFQ-STRUCTURAL v1 total verified).",
        abs(v1_scopes["RFQ-STRUCTURAL"].total_amount
            - round(structural_total, 6)) <= 1e-6,
        details={"structural_total": v1_scopes["RFQ-STRUCTURAL"].total_amount},
        epistemic="CALCULATED",
    )

    # ------------------------------------------------------------------
    # 5. Model revision -> exact RFQ scope impact
    # ------------------------------------------------------------------
    impact12 = rfq_impact(estimates["v1"], estimates["v2"])
    result.observe(
        "cad4-down/rfq-impact-v1-v2",
        "v1 -> v2 (wall-north geometry change) impacts EXACTLY "
        "RFQ-STRUCTURAL: the changed line items are wall-north's volume "
        "and weight lines; fenestration and fit-out scopes are "
        "unimpacted.",
        impact12["impacted_scopes"] == ["RFQ-STRUCTURAL"]
        and impact12["unimpacted_scopes"]
        == ["RFQ-FENESTRATION", "RFQ-FITOUT"]
        and all("wall:north" in lid for lid in impact12["changed_line_items"]),
        details={"impacted": impact12["impacted_scopes"],
                 "unimpacted": impact12["unimpacted_scopes"],
                 "changed_lines": impact12["changed_line_items"]},
        epistemic="ADAPTER",
    )

    impact23 = rfq_impact(estimates["v2"], estimates["v3"])
    result.observe(
        "cad4-down/rfq-impact-v2-v3",
        "v2 -> v3 (window widening + host-wall volume change) impacts "
        "EXACTLY RFQ-FENESTRATION and RFQ-STRUCTURAL (window area line "
        "+ host wall volume/weight lines); fit-out remains unimpacted; "
        "the property-only wall-east change produces no line change.",
        sorted(impact23["impacted_scopes"])
        == ["RFQ-FENESTRATION", "RFQ-STRUCTURAL"]
        and impact23["unimpacted_scopes"] == ["RFQ-FITOUT"]
        and not any("wall:east" in lid for lid in impact23["changed_line_items"]),
        details={"impacted": impact23["impacted_scopes"],
                 "changed_lines": impact23["changed_line_items"]},
        epistemic="ADAPTER",
    )

    # amount delta on the window line is exact
    win_before = next(
        i for i in estimates["v2"]
        if i.element_domain_id == "off:cad4:wall:south:window-2"
    )
    win_after = next(
        i for i in estimates["v3"]
        if i.element_domain_id == "off:cad4:wall:south:window-2"
    )
    result.observe(
        "cad4-down/window-line-delta-exact",
        "The window glazing line moves by exactly the quantity delta x "
        "rate: (1.5 - 1.2) x 1.5 m^2 x 320 EUR/m^2 = +144.00 EUR.",
        abs((win_after.amount - win_before.amount) - 144.0) <= 1e-6,
        details={"before": win_before.amount, "after": win_after.amount,
                 "delta": round(win_after.amount - win_before.amount, 6)},
        epistemic="CALCULATED",
    )
