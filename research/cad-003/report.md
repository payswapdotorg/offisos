# RESEARCH-CAD-003 — Findings Report

**Work item:** RESEARCH-CAD-003 (GitHub issue #3)
**Architecture version:** 1.0 (FROZEN)
**Evidence run:** `evidence/run-001/` (64 pass / 0 fail / 0 unknown)
**Toolchain:** ifcopenshell 0.8.5 (IFC4), IfcTester 0.8.5 (IDS), bcf-client
0.8.5 (BCF-XML v3, provided through the IfcTester dependency chain),
Python 3.12.13, Linux x86_64
(see `evidence/run-001/environment.json`)

This report separates measured results from inferred conclusions. It does
not decide the final BIM engine and does not make IFC the ConstructionOS
internal representation. The recommendation at the end is subject to
Architect review.

---

## 1. Fixture corpus (scope 1)

Deterministic architectural model: 6 walls (2 with openings), 4 openings,
2 doors, 2 windows, 1 slab, 2 spaces; Pset_WallCommon (typed
label/boolean/real values), custom project property set
(Pset_OffisosProject), full Qto sets, METRE units pinned, non-trivial
placements. All asserted exact against analytic expectations
(`bench-fixture`, 12 checks):
- entity counts by class exact; relationship counts exact (voids=4,
  fills=4, containment=1 grouped rel, aggregation=4);
- placements exact ((0,8,0) north, (10,0,0) east, spaces at fixture
  positions);
- property values with type fidelity; custom properties exact;
- wall gross/net volume sums exact (26.64 / 24.5925 m³), slab volume
  exact (20.0 m³), space areas exact;
- regeneration determinism: two independent builds are semantically
  identical (GlobalIds excluded — they are per-build by design; their
  instability is the non-canonicality proof in §5).

## 2. Semantic extraction (scope 2)

`bench-extraction`, 9 checks — deterministic, identity-mapped, provenance
recorded:
- extraction is deterministic (identical snapshot on re-extraction);
- **every** non-opening element carries an Offisos domain identity via
  `Pset_OffisosIdentity` (the stable mapping into the ConstructionOS
  model boundary), and the identity pset is consumed as metadata, never
  mixed into domain properties;
- each element records IFC class, name and engine GlobalId as
  **provenance** (engine ids are provenance, never canonical);
- property extraction covers the typed common pset + custom project pset;
  quantity extraction covers the full Qto_WallCommon set;
- relationship extraction exact; representation references reachable
  (SweptSolid items);
- GlobalIds stable across file write/read cycles of the same logical file
  (provenance continuity).

## 3. Controlled mutation (scope 3)

`bench-mutation`, 9 checks — every mutation is **surgical** with lineage:
- **Property change** (FireRating REI60→REI120 on wall-north): exactly one
  element, exactly the properties field; all other elements semantically
  unchanged; lineage records operation/domain/pset/property/before/after.
- **Placement change** (wall-east +(5,1)): exactly that element, exactly
  the placement field; (10,0,0)→(15,1,0) exact.
- **Create** (new wall with identity + properties): exactly one element
  added with identity, REI30 and placement (20,0,0).
- **Delete** (wall-interior-2): exactly that element removed; other
  relationships untouched.
- **All four mutations persist through export/re-import** with zero
  additional drift.

## 4. IFC round trip (scope 4)

`bench-roundtrip`, 13 checks — full pipeline import → extract → mutate →
export → re-import → compare:
- **zero semantic drift**: no added/removed elements, no changed fields;
- identities, IFC classes, GlobalIds, relationships, units (METRE),
  placements survive exactly;
- the pre-export mutation is visible after re-import (REI90 on
  wall-south with booleans/reals intact);
- every quantity value survives within 1e-9 across all elements;
- **geometry guarantees are explicit**: GUARANTEED — extrusion depth
  (3.0 m exact), opening/void semantics (4 openings), quantity values,
  placement translations; NOT GUARANTEED — tessellated mesh equivalence,
  face/edge ordering, BRep byte equality (engine-internal
  representations; asserted through semantic + quantity invariants
  instead);
- **lossiness classification from the measured diff: zero LOSSY fields**
  for the fixture corpus; geometry contents are OPAQUE-LINEAGE by design;
  UNSUPPORTED is schema-scoped (IFC4X3-only entities in IFC4); no
  INFERRED values are promoted to observed facts.

## 5. Construction Graph mapping proof (scope 5)

`bench-cg-mapping`, 8 checks:
- the graph revision has 13 canonical nodes (6 walls + slab + 2 spaces +
  2 doors + 2 windows) with the 4 openings recorded as void lineage of
  their hosts;
- every node records provenance (engine, GlobalId, IFC class, model
  revision, identity-resolution method);
- **engine-id non-canonicality directly observed**: two independent
  fixture builds produce DISJOINT GlobalId sets while canonical node ids
  are IDENTICAL — the Graph is independent of engine identity;
- the graph is structurally stable across export/re-import (no
  added/removed nodes) with provenance GlobalIds continuous;
- the graph diff detects exactly the created and deleted walls (tracks
  real semantic changes, not file bytes);
- field classification documented: PRESERVED / LOSSY / UNSUPPORTED /
  INFERRED / OPAQUE-LINEAGE (`cg_mapping.classify_fields`).

## 6. IDS/BCF interoperability (scope 6)

`bench-ids-bcf`, 9 checks — **both** interoperability pathways tested:

**IDS (IfcTester 0.8.5):**
- positive control: requiring FireRating on all walls passes (6/6);
- **value discrimination**: the REI60 requirement applies to 6 walls —
  exactly 2 pass (north, south) and 4 fail (REI90/REI30 walls); spec
  status False because a requirement must hold for EVERY applicable
  entity (correct per-entity validator semantics, recorded);
- negative controls: REI120 fails all 6; a missing property
  (AcousticRating) fails all 6 — the validator is not a rubber stamp;
- **mutation tracking**: wall-north moves from FAILED to PASSED on the
  REI120 requirement after the controlled REI60→REI120 mutation;
- the IDS specification itself round-trips through XML with identical
  validation results.

**BCF (bcf-client 0.8.5):**
- full issue/reference workflow: a BCF topic (title/type/status) with a
  viewpoint referencing **wall-north by IfcGuid** and an architect
  comment round-trips through the .bcf container exactly (topic metadata,
  comment, and the IFC element reference all survive; 1636 bytes);
- the referenced IfcGuid resolves back to the exact IFC element in the
  source model — the BCF↔IFC reference bridge is bidirectional.

### Toolchain findings (recorded as evidence)

1. The PyPI distribution **`ifcopenshell-ids` (0.8.0) is a broken partial
   mirror** of ifcopenshell 0.8.0 with no ids module; installing it
   corrupts a co-installed ifcopenshell 0.8.5 (observed: version reported
   0.0.0). NOT used; documented so nobody repeats the mistake.
2. The PyPI distribution **`bcf` (1.9.1) is unrelated firmware tooling**
   (ftdi/flasher modules). NOT used.
3. The correct toolchain is **IfcTester 0.8.5** (IDS) whose dependency
   chain provides **bcf-client 0.8.5** (BCF-XML v3) — the same 0.8.5 line
   as ifcopenshell itself.

## 7. Performance (single-environment observations)

| Measurement | Value |
|---|---|
| fixture build (17 elements, 5 pset families, full qtos) | 32.5 ms |
| semantic extraction | 7.6 ms |
| two controlled mutations | 2.2 ms |
| IFC export / re-import | 2.1 ms / 2.6 ms (26.4 KB) |
| snapshot compare + graph mapping | 7.0 ms / <0.1 ms |
| IDS validation | 4.8 ms |
| BCF issue round trip | (1636 bytes) |
| peak RSS | 187 MiB |

## 8. Limitations (explicit)

1. IFC4 only; IFC2x3/IFC4X3 schema variants not covered in this run.
2. Geometry round-trip guarantees are semantic/quantity-level only
   (tessellation/BRep bytes are not guaranteed — recorded explicitly).
3. BCF coverage: one issue/reference/comment workflow (BCF-XML v3);
   BCF-API (server protocol) and viewpoints with camera/visibility
   details are out of scope.
4. Performance numbers are single-environment observations; thresholds
   belong to RESEARCH-CAD-006.
5. This benchmark does not decide the final BIM engine and does not make
   IFC the ConstructionOS internal representation.

## 9. Recommendation (INFERRED — decision belongs to the Architect)

The measured evidence **supports IfcOpenShell 0.8.5 as the current IFC/BIM
semantic interoperability candidate behind the frozen adapter boundary**:
the full pipeline (import → extraction → controlled mutation → export →
re-import → semantic comparison → Construction Graph mapping) runs with
zero semantic drift, surgical mutations, exact identities/quantities/
units/placements, provenance-continuous Graph independence, and working
IDS + BCF interoperability through the same-version toolchain. All
recorded findings are toolchain/adapter-level, not architecture changes.
No Architecture Change Request is required by this evidence. Remaining
gates: performance thresholds (RESEARCH-CAD-006) and
licensing/composition (LICENSE-001).
