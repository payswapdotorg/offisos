# RESEARCH-CAD-004 — Findings Report

**Work item:** RESEARCH-CAD-004 (GitHub issue #4)
**Architecture version:** 1.1 (FROZEN) — this work item was created after v1.1 became active
**Evidence run:** `evidence/run-001/` (46 pass / 0 fail / 0 unknown)
**Toolchain:** ifcopenshell 0.8.5 + OCCT 7.8.1 (via cadquery-ocp 7.8.1.1.post1)
for the engine path; pure-Python analytic reference; Python 3.12.13
(see `evidence/run-001/environment.json`)

Evidence target: `CAD/BIM Model Version → Quantity Records → Construction
Graph → Downstream Estimate/RFQ Contracts`. Research evidence only — no
production quantity engine, no production estimate/RFQ implementation.

---

## 1. Quantity fixture corpus (scope 1)

Three controlled model versions + a mixed-unit variant, all deterministic:
**v1** base (4 walls, ghost wall, slab, space, door, 2 windows); **v2** =
v1 + wall-north Height 3.0→3.5; **v3** = v2 + south-window width 1.2→1.5 +
wall-east FireRating REI90→REI120 (property-only negative control);
**v1-mm** = v1 authored with MILLIMETRE project units.

- **≥5 measurement classes** demonstrated: length, area, volume, mass
  (weight via a recorded density parameter), count — 14 distinct quantity
  names across 63 records per version. [cad4-fixture/quantity-classes]
- Instanced/repeated elements: per-instance quantity records for the two
  window instances. [cad4-fixture/instanced-elements]
- Every stored quantity matches the analytic fixture expectation within
  1e-9; analytic-only quantities (not stored in the fixture qtos) are
  enumerated, not silently ignored. [cad4-fixture/stored-quantities-exact]

## 2. Quantity extraction (scope 2)

- **Determinism:** re-extraction of the same file is identical;
  independent rebuilds of the same version are semantically identical
  (engine GlobalIds excluded — provenance only). [cad4-extract/*]
- **Dual-path engine independence:** quantities computed from the file's
  ACTUAL geometry through OCCT BRep (profile/placement/extents read from
  the file, boolean-cut openings, exact mass properties) equal the
  pure-Python analytic reference within 1e-6 for every wall. [cad4-extract/dual-path-agreement]
- **Epistemic states:** OBSERVED (stored qtos + filling attributes),
  CALCULATED (BRep + weight + filling area) and UNKNOWN (ghost wall) all
  present and distinguished, with method + parameters in provenance.
  [cad4-extract/epistemic-states, provenance-method-distinction]
- **Mixed units with explicit conversion:** the MILLIMETRE-authored
  fixture produces BRep records IDENTICAL to the METRE fixture after
  explicit conversion — geometry values, extrusion depths AND placement
  translations scaled by 0.001, with the factor recorded in every
  record's provenance. Raw file values verified genuinely in mm
  (depth 3000). [cad4-extract/mixed-unit-*]

### Toolchain finding (recorded, not worked around)

**FINDING:** ifcopenshell 0.8.5's `ShapeBuilder` helpers
(`rectangle`/`extrude`/`polyline`) store RAW values without converting
API metres to the project unit — unlike `geometry.add_wall_representation`,
`add_slab_representation` and `edit_object_placement`, which convert.
Authoring a MILLIMETRE-unit file through the builder therefore requires
pre-scaling builder inputs (done in the fixture, documented here), or the
file is internally inconsistent (openings in metres against walls in mm).

## 3. Provenance and versioning (scope 3)

- Every record carries model version, element domain identity, engine
  GlobalId (engine path) or analytic-reference marker, extraction method,
  engine version; CALCULATED records add parameters (density, unit scale,
  profile extents). [cad4-prov/provenance-completeness]
- **Revisions create NEW states, never mutate history:** extracting v2
  leaves the v1 snapshot byte-identical; all three version snapshots
  coexist with version-stamped record ids (`<element>#<quantity>@<version>`).
- **Reproducible re-extraction:** write → reopen → extract reproduces the
  snapshot exactly (GlobalIds included — stable within a file); the v1
  state remains fully replayable after v2/v3 exist.
- Provenance engine ids resolve to the exact source elements (GlobalId
  match) — every quantity is traceable to its source.

## 4. Construction Graph mapping (scope 4)

- Graph nodes keyed by **canonical domain ids only** (10 nodes; no
  engine GlobalId as key). [cad4-graph/domain-id-keyed]
- **Provenance refs and uncertainty survive the mapping:** every graph
  quantity carries its record-id provenance reference; the ghost wall's
  UNKNOWN state (value None) is visible in the graph; an uncertainty
  summary counts OBSERVED/CALCULATED/UNKNOWN at the Graph boundary.
- **Engine-id non-canonicality (quantity context):** two independent
  builds of v1 produce DISJOINT GlobalId sets in quantity provenance
  while the domain-id-keyed quantity graphs are IDENTICAL.
- **Consumer API:** quantities are read from the graph (value, unit,
  state, tolerance) with no engine imports, engine ids or file access —
  applications consume Graph quantities, not engine internals.
- Graph diffs across revisions detect exactly the touched elements
  (v1→v2: wall-north; v2→v3: window + host wall; property-only
  wall-east unchanged).
- The graph built from the engine-path extraction agrees with the graph
  built from the analytic snapshot — **the Graph mapping is
  engine-independent.**

## 5. Change propagation (scope 5)

- **Exact, explainable deltas:** v1→v2 (height 3.0→3.5) produces the
  exact analytic deltas on every wall-north measure (volume +1.5 m³ =
  10×0.3×0.5; side areas +5.0 m²; weight +3600 kg) across OBSERVED and
  BRep paths. v2→v3 (window 1.2→1.5) produces window area +0.45 m², host
  net volume −0.135 m³, net side area −0.45 m², weight −324 kg.
- **Unchanged-element identity:** all 9 untouched elements (including the
  ghost wall with its UNKNOWN state) retain canonical identity and their
  full quantity state (same quantity surface, values, units, states).
- **Negative control:** the property-only FireRating change produces NO
  quantity delta — quantity records respond to geometry, not unrelated
  properties.
- **Change records** (the domain-event equivalent) are emitted
  deterministically per revision: event type, versions, changed elements
  and quantity refs, untouched element count.

## 6. Downstream estimate/RFQ readiness (scope 6 — contract-level only)

- Deterministic estimate line items with **stable identity**
  (`EST:<element>#<quantity>@<version>`), exact amounts (quantity × rate),
  and provenance references carried into every line.
- RFQ scope grouping deterministic (structural / fenestration / fit-out)
  with exact totals.
- **Model revision → exact RFQ impact:** v1→v2 (wall geometry) impacts
  exactly RFQ-STRUCTURAL; v2→v3 (window + host wall) impacts exactly
  RFQ-FENESTRATION + RFQ-STRUCTURAL; fit-out untouched both times; the
  window glazing line moves by exactly +144.00 EUR ((1.5−1.2)×1.5×320).
- **UNKNOWN never priced:** the ghost wall produces no estimate line —
  no price is ever derived from a value the system does not have.

## 7. Performance (single-environment observations)

| Measurement | Value |
|---|---|
| model build (v1) | 17 ms |
| quantity extraction (v1, OBSERVED + BRep) | 25 ms |
| graph mapping / downstream derivation | 0.1 ms / 0.2 ms |
| build+extract v2+v3 | 82 ms |
| mixed-unit extraction | 41 ms |
| fixture size | 16.7 KB; 63 records; 10 graph nodes; 13 line items; 3 RFQ scopes |
| peak RSS | 435 MiB |

## 8. Limitations (explicit)

1. The estimate/RFQ layer is contract-level evidence with a deterministic
   rate-table fixture — NOT a pricing engine (issue non-goal).
2. The BRep path exercises walls (the fixture's geometry-bearing
   elements with openings); slabs/spaces contribute OBSERVED quantities
   and the analytic reference path.
3. Quantity records carry version stamps instead of wall-clock
   timestamps by design (determinism); time metadata lives in evidence
   runs, not in records.
4. Performance numbers are single-environment observations; thresholds
   belong to RESEARCH-CAD-006.
5. Uncertainty coverage: UNKNOWN for basis-less elements; INFERRED/
   EXTRAPOLATED states are not exercised by this corpus (no inference
   performed — deliberately).

## 9. Recommendation (INFERRED — decision belongs to the Architect)

The measured evidence **supports the candidate quantity/Construction
Graph integration under the frozen architecture**: the full chain
(model version → deterministic, provenance-preserving quantity records
→ domain-id-keyed Graph with a consumer API → contract-ready downstream
estimate/RFQ derivations) runs with exact numerical assertions, surgical
controlled deltas, unchanged-element identity, engine-independent dual
paths and explicit mixed-unit conversion. The recorded ShapeBuilder
unit-conversion finding is an adapter-construction obligation, not an
architecture change. No ACR is required by this evidence.
