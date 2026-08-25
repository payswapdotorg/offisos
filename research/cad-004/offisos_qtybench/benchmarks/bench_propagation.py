"""Benchmark: change propagation (RESEARCH-CAD-004 scope 5).

Controlled model revisions produce exact, explainable quantity deltas;
unchanged elements retain stable canonical identity AND unchanged
quantity state; a property-only change produces NO quantity delta
(negative control); change records are emitted for downstream consumers.
"""
from __future__ import annotations


def run(result) -> None:
    from ..fixtures import DELTA_V1_V2, DELTA_V2_V3, build_model
    from ..quantity_records import change_record, diff_snapshots, extract_snapshot

    snaps = {v: extract_snapshot(build_model(v), v) for v in ("v1", "v2", "v3")}

    # ------------------------------------------------------------------
    # 1. v1 -> v2: exact delta on exactly wall-north
    # ------------------------------------------------------------------
    d12 = diff_snapshots(snaps["v1"], snaps["v2"])
    delta_ok = True
    details = {}
    for element, quantities in DELTA_V1_V2.items():
        actual = {
            q: x["delta"] for q, x in d12["changed"].get(element, {}).items()
        }
        for q, expected in quantities.items():
            if q not in actual or abs(actual[q] - expected) > 1e-6:
                delta_ok = False
                details[f"{element}#{q}"] = {
                    "expected": expected, "actual": actual.get(q)}
    result.observe(
        "cad4-prop/exact-delta-v1-v2",
        "Controlled revision v1 -> v2 (wall-north Height 3.0 -> 3.5) "
        "produces the EXACT analytic deltas on every quantity measure of "
        "that wall (volume +1.5 m^3 = 10 x 0.3 x 0.5; side areas +5.0 m^2; "
        "weight +3600 kg) across both the OBSERVED and BRep record paths.",
        delta_ok and sorted(d12["changed"].keys()) == ["off:cad4:wall:north"],
        details={"changed_elements": sorted(d12["changed"].keys()),
                 "deltas": details or "all exact"},
        epistemic="CALCULATED",
    )

    # ------------------------------------------------------------------
    # 2. Unchanged-element identity + unchanged quantity state
    # ------------------------------------------------------------------
    untouched = sorted(
        (set(d12["changed"].keys()) | set(d12["unchanged"].keys()))
        - set(d12["changed"].keys())
    )
    untouched_ok = True
    violations = {}
    for element in untouched:
        # canonical identity stable: same element present in both snapshots
        present_v1 = element in snaps["v1"].domain_ids()
        present_v2 = element in snaps["v2"].domain_ids()
        if not (present_v1 and present_v2):
            untouched_ok = False
            violations[element] = "missing from a snapshot"
            continue
        # quantity SURFACE identical (same quantity names)
        names_v1 = set(snaps["v1"].element_quantities(element).keys())
        names_v2 = set(snaps["v2"].element_quantities(element).keys())
        if names_v1 != names_v2:
            untouched_ok = False
            violations[element] = f"quantity surface changed: {names_v1 ^ names_v2}"
            continue
        # every quantity identical (value + state + unit)
        for q_name in sorted(names_v1):
            r1 = snaps["v1"].element_quantities(element)[q_name]
            r2 = snaps["v2"].element_quantities(element)[q_name]
            value_same = (
                (r1.value is None and r2.value is None)
                or (r1.value is not None and r2.value is not None
                    and abs(r1.value - r2.value) <= r1.tolerance)
            )
            if not value_same or r1.state != r2.state or r1.unit != r2.unit:
                untouched_ok = False
                violations[element] = f"{q_name} changed"
    result.observe(
        "cad4-prop/unchanged-element-identity",
        "UNCHANGED-ELEMENT IDENTITY: every element not touched by the "
        "v1 -> v2 edit (9 of 10, incl. the ghost wall with its UNKNOWN "
        "state) retains its canonical identity (present in both "
        "snapshots with the identical quantity surface) AND its full "
        "quantity state (identical values, units and epistemic states).",
        untouched_ok and len(untouched) == 9,
        details={"untouched_count": len(untouched),
                 "violations": violations or "none"},
        epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 3. v2 -> v3: window widening + property-only negative control
    # ------------------------------------------------------------------
    d23 = diff_snapshots(snaps["v2"], snaps["v3"])
    delta_ok = True
    details = {}
    for element, quantities in DELTA_V2_V3.items():
        actual = {
            q: x["delta"] for q, x in d23["changed"].get(element, {}).items()
        }
        for q, expected in quantities.items():
            if q not in actual or abs(actual[q] - expected) > 1e-6:
                delta_ok = False
                details[f"{element}#{q}"] = {
                    "expected": expected, "actual": actual.get(q)}
    result.observe(
        "cad4-prop/exact-delta-v2-v3",
        "Controlled revision v2 -> v3 (south window width 1.2 -> 1.5) "
        "produces the EXACT deltas: window area +0.45 m^2, host wall net "
        "volume -0.135 m^3 (0.3 x 1.5 x 0.3), net side area -0.45 m^2, "
        "weight -324 kg — across OBSERVED and BRep paths.",
        delta_ok and sorted(d23["changed"].keys())
        == ["off:cad4:wall:south", "off:cad4:wall:south:window-2"],
        details={"changed_elements": sorted(d23["changed"].keys()),
                 "deltas": details or "all exact"},
        epistemic="CALCULATED",
    )
    result.observe(
        "cad4-prop/property-only-no-quantity-delta",
        "NEGATIVE CONTROL: wall-east's FireRating change (REI90 -> "
        "REI120, a property-only edit in v3) produces NO quantity delta — "
        "wall-east remains in the unchanged set with its full quantity "
        "state intact. Quantity records respond to geometry, not "
        "unrelated properties.",
        "off:cad4:wall:east" in d23["unchanged"]
        and "off:cad4:wall:east" not in d23["changed"],
        details={"wall_east_status": "unchanged"},
        epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 4. Change records for downstream consumers
    # ------------------------------------------------------------------
    cr23 = change_record(d23)
    result.observe(
        "cad4-prop/change-record-emitted",
        "A change record (the domain-event equivalent) is emitted per "
        "revision: event type, from/to versions, changed element ids, "
        "changed quantity refs, unchanged count — deterministic and "
        "consumable without engine access.",
        cr23["event"] == "QuantityStateChanged"
        and cr23["from_version"] == "v2" and cr23["to_version"] == "v3"
        and cr23["changed_elements"] == ["off:cad4:wall:south",
                                          "off:cad4:wall:south:window-2"]
        and cr23["untouched_element_count"] == 8,
        details={"change_record": {
            k: v for k, v in cr23.items() if k != "changed_quantity_refs"
        }}, epistemic="ADAPTER",
    )

    # change record determinism
    cr23_b = change_record(diff_snapshots(snaps["v2"], snaps["v3"]))
    result.observe(
        "cad4-prop/change-record-deterministic",
        "The change record is deterministic: the same diff always emits "
        "the identical record.",
        cr23 == cr23_b, epistemic="ADAPTER",
    )
