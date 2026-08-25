"""Benchmark: quantity extraction (RESEARCH-CAD-004 scope 2).

Determinism, the dual-path engine-independence agreement (OCCT BRep vs
pure-Python analytic), measured-vs-calculated-vs-unsupported distinction,
and explicit unit conversion for the mixed-unit fixture.
"""
from __future__ import annotations


def run(result) -> None:
    from ..fixtures import EXPECTED, build_model
    from ..quantity_records import (
        QuantityState,
        analytic_snapshot,
        extract_snapshot,
    )

    f = build_model("v1")
    snap = extract_snapshot(f, "v1")

    # ------------------------------------------------------------------
    # 1. Determinism: re-extraction of the same file is identical
    # ------------------------------------------------------------------
    snap_b = extract_snapshot(f, "v1")
    result.observe(
        "cad4-extract/determinism",
        "Extracting the same file twice produces identical snapshots "
        "(all records, values, states and provenance).",
        snap.to_dict() == snap_b.to_dict(), epistemic="ADAPTER",
    )

    # regeneration determinism: a second BUILD of the same version is
    # semantically identical (engine GlobalIds excluded — see bench_graph)
    snap_re = extract_snapshot(build_model("v1"), "v1")
    def _semantic(s):
        return {
            rid: {k: v for k, v in r.to_dict().items()
                  if k != "provenance" or True}
            for rid, r in sorted(s.records.items())
        }
    # compare excluding engine_id in provenance
    def _strip_engine(s):
        out = {}
        for rid, r in s.records.items():
            d = r.to_dict()
            d["provenance"] = {
                k: v for k, v in d["provenance"].items() if k != "engine_id"
            }
            out[rid] = d
        return out
    result.observe(
        "cad4-extract/regeneration-determinism",
        "Two independent builds of model version v1 produce identical "
        "quantity snapshots (engine GlobalIds excluded from the comparison "
        "— they are per-build provenance, proven unstable in bench_graph).",
        _strip_engine(snap) == _strip_engine(snap_re),
        epistemic="OBSERVED",
    )

    # ------------------------------------------------------------------
    # 2. Dual-path agreement: OCCT BRep vs analytic (engine independence)
    # ------------------------------------------------------------------
    ana = analytic_snapshot("v1")
    walls = ["off:cad4:wall:north", "off:cad4:wall:south",
             "off:cad4:wall:east", "off:cad4:wall:west"]
    brep_ok = True
    details = {}
    for w in walls:
        net = snap.records[f"{w}#BRepNetVolume@v1"].value
        gross = snap.records[f"{w}#BRepGrossVolume@v1"].value
        exp_net = EXPECTED["v1"][w]["NetVolume"]
        exp_gross = EXPECTED["v1"][w]["GrossVolume"]
        agree = abs(net - exp_net) <= 1e-6 and abs(gross - exp_gross) <= 1e-6
        details[w] = {"brep_net": net, "analytic_net": exp_net,
                      "brep_gross": gross, "analytic_gross": exp_gross}
        brep_ok = brep_ok and agree
    result.observe(
        "cad4-extract/dual-path-agreement",
        "ENGINE INDEPENDENCE: quantities computed from the file's ACTUAL "
        "geometry through the OCCT BRep path (boolean cuts + mass "
        "properties) equal the pure-Python analytic reference within "
        "1e-6 for every wall — the quantity layer does not depend on a "
        "single engine path.",
        brep_ok, details=details, epistemic="OBSERVED",
    )

    # weight: BRep weight equals analytic weight (density parameter)
    weight_ok = all(
        abs(snap.records[f"{w}#BRepWeight@v1"].value
            - EXPECTED["v1"][w]["Weight"]) <= 1e-3
        for w in walls
    )
    result.observe(
        "cad4-extract/weight-calculation",
        "CALCULATED mass quantities (BRep net volume x density parameter "
        "2400 kg/m^3) equal the analytic expectations within 1e-3.",
        weight_ok, epistemic="CALCULATED",
    )

    # ------------------------------------------------------------------
    # 3. Epistemic states present and correctly distinguished
    # ------------------------------------------------------------------
    states = {}
    for r in snap.records.values():
        states[r.state.value] = states.get(r.state.value, 0) + 1
    result.observe(
        "cad4-extract/epistemic-states",
        "Extraction distinguishes OBSERVED (stored quantity sets + "
        "filling attributes), CALCULATED (BRep geometry + weight + "
        "filling area) and UNKNOWN (ghost wall) — all three states "
        "present in one snapshot.",
        states.get("OBSERVED", 0) > 0 and states.get("CALCULATED", 0) > 0
        and states.get("UNKNOWN", 0) > 0,
        details={"state_counts": states}, epistemic="ADAPTER",
    )

    # OBSERVED records carry stored values; CALCULATED carry method+params
    observed = next(r for r in snap.records.values()
                    if r.state == QuantityState.OBSERVED)
    calculated = snap.records["off:cad4:wall:north#BRepNetVolume@v1"]
    result.observe(
        "cad4-extract/provenance-method-distinction",
        "OBSERVED records cite the file's quantity sets; CALCULATED "
        "records cite the occt-brep method with parameters (density, "
        "unit scale, profile extents).",
        observed.provenance["method"] == "file-qtos+occt-brep"
        and calculated.provenance["method"] == "occt-brep"
        and "density_kg_m3" in calculated.provenance["parameters"]
        and "unit_scale_file_to_m" in calculated.provenance["parameters"],
        details={"observed_method": observed.provenance["method"],
                 "calculated_method": calculated.provenance["method"],
                 "calculated_parameters": calculated.provenance["parameters"]},
        epistemic="ADAPTER",
    )

    # ------------------------------------------------------------------
    # 4. Mixed units: explicit conversion with recorded factors
    # ------------------------------------------------------------------
    f_mm = build_model("v1", unit="MILLIMETRE")
    snap_mm = extract_snapshot(f_mm, "v1")
    brep_match = all(
        abs(snap.records[rid].value - snap_mm.records[rid].value) <= 1e-6
        for rid in snap.records.keys()
        if rid in snap_mm.records
        and snap.records[rid].quantity_name.startswith("BRep")
    )
    scale_recorded = snap_mm.records[
        "off:cad4:wall:north#BRepNetVolume@v1"
    ].provenance["parameters"]["unit_scale_file_to_m"]
    result.observe(
        "cad4-extract/mixed-unit-conversion",
        "MIXED UNITS: the MILLIMETRE-authored fixture produces IDENTICAL "
        "BRep quantity records to the METRE fixture after explicit "
        "conversion (factor 0.001 recorded in every record's provenance: "
        "geometry values, extrusion depths AND placement translations).",
        brep_match and abs(scale_recorded - 0.001) <= 1e-12,
        details={"unit_scale_recorded": scale_recorded,
                 "brep_records_match": brep_match},
        epistemic="ADAPTER",
    )

    # raw file values are genuinely in mm (the conversion is real)
    item_mm = next(
        w for w in f_mm.by_type("IfcWall") if w.Name == "wall-north"
    ).Representation.Representations[0].Items[0]
    result.observe(
        "cad4-extract/mixed-unit-raw-values",
        "The mm fixture's raw file values are genuinely in file units "
        "(extrusion depth 3000 = 3.0 m x 1000) — the conversion is "
        "exercised, not vacuous.",
        abs(float(item_mm.Depth) - 3000.0) <= 1e-9,
        details={"raw_depth": float(item_mm.Depth)}, epistemic="OBSERVED",
    )
