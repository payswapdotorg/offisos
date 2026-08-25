"""Benchmark: quantity fixture corpus (RESEARCH-CAD-004 scope 1).

Asserts the corpus itself: element counts, the >=5 quantity/
measurement classes, instanced (repeated) elements, the mixed-unit
variant, and exact analytic expectations for every stored quantity.
"""
from __future__ import annotations


def run(result) -> None:
    from ..fixtures import EXPECTED, build_model
    from ..quantity_records import QuantityState, extract_snapshot

    f = build_model("v1")
    snap = extract_snapshot(f, "v1")

    # ------------------------------------------------------------------
    # 1. Corpus shape: walls/slab/spaces/doors/windows/openings/ghost
    # ------------------------------------------------------------------
    ids = snap.domain_ids()
    result.observe(
        "cad4-fixture/element-corpus",
        "Corpus contains 4 real walls + 1 ghost wall + slab + 1 space + "
        "1 door + 2 windows (10 canonical element identities).",
        len([i for i in ids if i.startswith("off:cad4:wall:")
             and ":door-" not in i and ":window-" not in i]) == 5
        and "off:cad4:slab:ground" in ids
        and "off:cad4:space:living" in ids
        and len([i for i in ids if ":door-" in i]) == 1
        and len([i for i in ids if ":window-" in i]) == 2,
        details={"domain_ids": sorted(ids)}, epistemic="CALCULATED",
    )

    # ------------------------------------------------------------------
    # 2. At least five quantity/measurement classes
    # ------------------------------------------------------------------
    classes = {
        "length": {"Length", "Height", "Width", "OverallWidth", "OverallHeight", "Perimeter"},
        "area": {"GrossSideArea", "NetSideArea", "OverallArea", "GrossFloorArea"},
        "volume": {"GrossVolume", "NetVolume", "OpeningsVolume", "BRepNetVolume", "BRepGrossVolume"},
        "mass": {"Weight", "BRepWeight"},
        "count": {"OpeningCount"},
    }
    present_names = {r.quantity_name for r in snap.records.values()}
    present_classes = sorted(
        c for c, names in classes.items() if names & present_names
    )
    result.observe(
        "cad4-fixture/quantity-classes",
        "At least five measurement classes are demonstrated "
        f"(present: {', '.join(present_classes)}).",
        len(present_classes) >= 5,
        details={"present_classes": present_classes,
                 "distinct_quantity_names": sorted(present_names)},
        epistemic="CALCULATED",
    )

    # ------------------------------------------------------------------
    # 3. Instanced/repeated elements: two identical-format windows
    # ------------------------------------------------------------------
    w1 = snap.records.get("off:cad4:wall:north:window-1#OverallArea@v1")
    w2 = snap.records.get("off:cad4:wall:south:window-2#OverallArea@v1")
    result.observe(
        "cad4-fixture/instanced-elements",
        "Repeated/instanced elements: two window instances carry "
        "per-instance quantity records (OverallArea present for each).",
        w1 is not None and w2 is not None,
        details={"window_1_area": w1.value if w1 else None,
                 "window_2_area": w2.value if w2 else None},
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 4. Mixed-unit variant: MILLIMETRE project unit authored
    # ------------------------------------------------------------------
    import ifcopenshell

    f_mm = build_model("v1", unit="MILLIMETRE")
    length_units = [
        u for u in f_mm.by_type("IfcUnitAssignment")[0].Units
        if u.is_a("IfcSIUnit") and u.UnitType == "LENGTHUNIT"
    ]
    result.observe(
        "cad4-fixture/mixed-unit-variant",
        "The mixed-unit variant is authored with MILLIMETRE project units "
        "(ifcopenshell default) while the base corpus uses METRE — the "
        "explicit-conversion demonstration fixture.",
        len(length_units) == 1 and length_units[0].Name == "METRE"
        and length_units[0].Prefix == "MILLI",
        details={"length_unit": str(length_units[0]) if length_units else None},
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 5. Stored quantities match analytic expectations exactly
    # ------------------------------------------------------------------
    mismatches = []
    checked = 0
    missing_from_stored = []
    for domain_id, quantities in EXPECTED["v1"].items():
        for q_name, expected in quantities.items():
            record = snap.records.get(f"{domain_id}#{q_name}@v1")
            if record is None:
                # not part of the stored (OBSERVED) surface — e.g.
                # OpeningsVolume/OpeningCount/Weight are analytic-only
                # quantities in this corpus
                missing_from_stored.append(f"{domain_id}#{q_name}")
                continue
            checked += 1
            if abs(record.value - expected) > 1e-9:
                mismatches.append(
                    f"{domain_id}#{q_name}: {record.value} != {expected}"
                )
    result.observe(
        "cad4-fixture/stored-quantities-exact",
        "Every stored (OBSERVED) quantity matches the analytic fixture "
        "expectation within 1e-9. Quantities that exist only in the "
        "analytic surface (OpeningsVolume/OpeningCount/Weight are not "
        "stored in the fixture quantity sets) are enumerated, not "
        "silently ignored.",
        not mismatches,
        details={"checked": checked,
                 "analytic_only_not_stored": missing_from_stored,
                 "mismatches": mismatches[:6]},
        epistemic="CALCULATED",
    )

    # ------------------------------------------------------------------
    # 6. The ghost wall yields UNKNOWN (uncertainty in the corpus)
    # ------------------------------------------------------------------
    ghost = snap.element_quantities("off:cad4:wall:ghost")
    result.observe(
        "cad4-fixture/ghost-unknown",
        "The ghost wall (identity, no geometry, no quantity set) yields "
        "exactly one UNKNOWN record with value None — never a fabricated 0.",
        len(ghost) == 1
        and ghost["NetVolume"].state == QuantityState.UNKNOWN
        and ghost["NetVolume"].value is None,
        details={"ghost_quantities": {
            k: (v.value, v.state.value) for k, v in ghost.items()
        }}, epistemic="OBSERVED",
    )
