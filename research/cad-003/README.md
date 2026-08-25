# RESEARCH-CAD-003 — IFC/BIM Semantic Interoperability Benchmark

**Work item:** RESEARCH-CAD-003 (GitHub issue #3)
**Architecture version:** 1.0 (FROZEN) — research evidence; no production
BIM editor, no final engine-selection decision, IFC is NOT made the
Construction Graph
**Status:** evidence package for Architect review; VERIFIED is not claimed

Reproducible benchmark of the BIM semantic layer on **ifcopenshell 0.8.5**
with **IfcTester 0.8.5** (IDS) and **bcf-client 0.8.5** (BCF-XML v3):

```
IFC fixture → extraction → controlled mutation → export → re-import
           → semantic comparison → Construction Graph mapping
```

## Reproduce

```bash
cd research/cad-003
python3 -m pip install -r requirements.txt   # exact pinned versions

make test   # deterministic CI gate: full suite, zero failures/unknowns (~2 s)
make bench  # produce evidence/<run-id>/ (~5 s)
```

No FreeCAD/AppImage needed — the whole toolchain is pip-installable.
The committed reference evidence is `evidence/run-001/`
(64 pass / 0 fail / 0 unknown).

## What is measured (issue #3 scope)

| Benchmark | Scope |
|---|---|
| `bench-fixture` | 1. fixture corpus: entity/relationship counts, units, placements, typed + custom properties, quantities (all exact) |
| `bench-extraction` | 2. deterministic extraction: identity/class/psets/qtos/relationships/placements/representation refs; identity mapping into the ConstructionOS boundary |
| `bench-mutation` | 3. surgical property/placement/create/delete mutations with lineage; narrow-patch preservation; persistence through export |
| `bench-roundtrip` | 4. zero-drift round trip: identity/class/GlobalId/relationship/unit/placement/quantity survival; explicit geometry guarantees; lossiness classification |
| `bench-cg-mapping` | 5. Construction Graph mapping: canonical node ids vs unstable engine GlobalIds (directly observed), provenance, structural diff, field classification |
| `bench-ids-bcf` | 6. IDS validation (positive/negative controls, per-entity discrimination, mutation tracking, XML round-trip) + full BCF issue/reference/comment workflow with IfcGuid resolution |
| `bench-performance` | timings, output sizes, peak memory |

## Key findings (see report.md)

- Zero semantic drift across the full round-trip pipeline; every mutation
  is surgical (exactly the intended element/field) with lineage recorded.
- Engine GlobalIds are **disjoint across regeneration** while canonical
  domain ids are identical — the Graph-independence proof.
- IDS validation discriminates per-entity (REI60: 2 pass / 4 fail of 6
  walls) and tracks controlled mutations (FAILED → PASSED).
- BCF issue/reference workflow works end-to-end: IfcGuid reference
  survives the .bcf container round trip and resolves back to the exact
  IFC element.
- **Toolchain findings:** the PyPI `ifcopenshell-ids` 0.8.0 distribution
  is a broken mirror that corrupts ifcopenshell 0.8.5 (do not install);
  the PyPI `bcf` 1.9.1 distribution is unrelated firmware tooling (do not
  use); the correct toolchain is IfcTester 0.8.5 + its bcf-client
  dependency.

## Epistemic classes

Every check carries NATIVE (engine/library), ADAPTER (Offisos code),
OBSERVED (direct observation incl. findings) or CALCULATED (analytic with
stated tolerance). See `offisos_ifcbench/harness.py`.
