# RESEARCH-CAD-004 — Model-to-Quantity and Construction Graph Mapping Benchmark

**Work item:** RESEARCH-CAD-004 (GitHub issue #4)
**Architecture version:** 1.1 (FROZEN) — research evidence; no production
quantity engine, no production estimate/RFQ implementation
**Status:** evidence package for Architect review; VERIFIED is not claimed

Reproducible benchmark of the evidence target:

```
CAD/BIM Model Version → Quantity Records → Construction Graph → Downstream Estimate/RFQ Contracts
```

on **ifcopenshell 0.8.5 + OCCT 7.8.1** (engine path) with a pure-Python
analytic reference path (dual-path engine-independence proof).

## Reproduce

```bash
cd research/cad-004
python3 -m pip install -r requirements.txt   # exact pinned versions

make test   # deterministic CI gate: full suite, zero failures/unknowns (~3 s)
make bench  # produce evidence/<run-id>/ (~15 s)
```

The committed reference evidence is `evidence/run-001/`
(46 pass / 0 fail / 0 unknown).

## What is measured (issue #4 scope)

| Benchmark | Scope |
|---|---|
| `bench-fixture` | 1. corpus: 3 controlled versions + mixed-unit variant; ≥5 measurement classes; instanced elements; exact analytic expectations |
| `bench-extraction` | 2. determinism; dual-path (OCCT BRep vs analytic) agreement; OBSERVED/CALCULATED/UNKNOWN distinction; explicit mixed-unit conversion with recorded factors |
| `bench-provenance` | 3. provenance completeness (version, identity, engine id, method, engine version, parameters); revisions create new states (history immutable); reproducible re-extraction; historical replay |
| `bench-propagation` | 5. exact explainable deltas; unchanged-element identity; property-only negative control; deterministic change records |
| `bench-graph` | 4. domain-id-keyed graph; provenance + uncertainty survive; engine-id non-canonicity; consumer API (no engine access); graph diffs; dual-path graph agreement |
| `bench-downstream` | 6. contract-level estimate line items (stable ids, exact amounts, provenance carried); RFQ scope grouping; exact revision→scope impact; UNKNOWN never priced |
| `bench-performance` | timings, fixture characteristics, peak memory |

## Key findings (see report.md)

- Dual-path agreement: OCCT BRep (reading the file's actual geometry,
  boolean-cutting openings) equals the analytic reference within 1e-6 —
  the quantity layer is engine-independent.
- Engine GlobalIds are **disjoint across regeneration** while the
  domain-id-keyed quantity graphs are identical.
- Mixed units: MILLIMETRE-authored fixture yields identical records after
  explicit conversion (factor 0.001 recorded in provenance).
- **FINDING:** ifcopenshell 0.8.5 `ShapeBuilder` helpers do not convert
  API metres to the project unit (unlike the official geometry APIs) —
  mm-file authoring must pre-scale builder inputs.
- Controlled deltas are surgical and exact; property-only changes
  produce no quantity delta; UNKNOWN is never priced downstream.

## Epistemic classes

Every check carries NATIVE / ADAPTER / OBSERVED / CALCULATED labels;
quantity records carry OBSERVED / CALCULATED / UNKNOWN states with
provenance (see `offisos_qtybench/harness.py` and
`offisos_qtybench/quantity_records.py`).
