# RESEARCH-CAD-001 — Findings Report

**Work item:** RESEARCH-CAD-001 (GitHub issue #1)
**Architecture version:** 1.0 (FROZEN)
**Evidence run:** `evidence/run-001/` (108 pass / 0 fail / 1 unknown)
**Environment:** Linux x86_64, Python 3.12.13, ifcopenshell 0.8.5,
cadquery-ocp 7.8.1.1.post1 (OCCT 7.8.1), ezdxf 1.4.3, numpy 2.1.3
(see `evidence/run-001/environment.json`)

This report separates **measured results** from **inferred conclusions**.
Everything marked OBSERVED/CALCULATED/NATIVE/ADAPTER is backed by a check
in the evidence run; inferred statements cite their supporting checks.
The final decision (proceed / proceed with constraints / reject / ACR)
belongs to the Architect — this report recommends, it does not decide.

---

## 1. Candidate coverage and honesty statement

| Candidate | Version tested | Coverage |
|---|---|---|
| IfcOpenShell | 0.8.5 | fully tested (BIM semantics, IFC round-trip, quantities) |
| OCCT (via OCP) | 7.8.1 | fully tested (2D/3D geometry, booleans, transforms, parametric regeneration, failure behavior, performance) |
| ezdxf | 1.4.3 | gap-filling evaluation only (2D drafting representation: layers + dimensions), justified by the observed OCCT gap |
| FreeCAD 1.1.x | **not tested** | not installable in the benchmark sandbox (no sudo/apt; conda-forge CDN unreachable). Sketcher constraint solving, Draft and TechDraw remain untested — an explicit environment limitation, recorded as `unknown`, **not** as an engine failure. Follow-up required in a suitable environment. |

## 2. Findings by evidence item

### Item 1 — 2D drafting (11 checks, all pass)

- **NATIVE (OCCT):** modeler precision is explicit (`Precision::Confusion`
  = 1e-7); point-to-curve projection and circle parametrization are exact
  to 1e-12; curve evaluation returns exact radii. [2d/precision/*]
- **NATIVE GAP (OCCT):** no layer model, no dimension/annotation entities,
  no 2D constraint solver in the geometry API (observed by introspection).
  OCCT is a geometry kernel, not a drafting application. [2d/layers/occt-native-gap]
- **ADAPTER:** grid snapping (0.5 m) and endpoint snapping within OCCT
  tolerance are implemented from OCCT primitives — snapping is drafting
  domain logic, not a kernel feature. [2d/snapping/*]
- **Gap evaluation (ezdxf, NATIVE):** DXF layer table round-trips with all
  fixture layers; segments keep exact coordinates; aligned dimension
  entities round-trip and measure fixture lengths exactly (1e-9). [2d/layers/dxf-*, 2d/dimensions/*]

### Item 2 — 3D geometry (18 checks, all pass)

- Primitives exact: box, cylinder, sphere, torus volumes match closed-form
  values (1e-6..1e-9). [3d/primitives/*]
- Booleans exact: fuse/cut/common on boxes (14/6/2 m³) and the curved
  napkin-ring cut (sphere minus coaxial cylinder = πh³/6) — all at
  1e-6..1e-9. [3d/booleans/*]
- Transforms exact: rotation preserves volume and moves the centre of mass
  exactly; translation likewise. [3d/transforms/*]
- Assemblies: 1000-solid compound builds in 34 ms, volume exact (6 m³),
  validity check passes. [3d/assembly/*, 3d/validity/*]

### Item 3 — Parametric behavior (6 pass, 1 unknown)

- **NATIVE (OCCT):** parametric regeneration is deterministic; editing a
  height parameter 3.0 → 3.5 m changes net volume by exactly +0.9 m³;
  regeneration of identical parameters yields identical results.
  [parametric/baseline-regeneration, edit-height-delta, regeneration-determinism]
- **Failure behavior:** zero-extent input raises OCCT `Standard_DomainError`
  (typed); an oversized opening produces an empty result (detected, no fake
  volume). [parametric/failure-*]
- **FINDING (OBSERVED):** OCCT accepts NaN coordinates without error and
  returns a 0-volume shape — input finiteness validation is an **adapter
  obligation**. [parametric/failure-nan-coordinate-finding]
- **UNKNOWN:** FreeCAD Sketcher constraint solving not tested (environment
  limitation above). OCCT itself provides no constraint solver.

### Item 4 — BIM semantics (16 checks, all pass)

- Wall/slab/space/door/window creation with correct IFC4 semantics:
  spaces aggregate into storeys via IfcRelAggregates; walls/slabs/doors/
  windows are contained via IfcRelContainedInSpatialStructure; openings
  void walls via IfcRelVoidsElement; doors/windows fill openings via
  IfcRelFillsElement. Exact counts asserted (4/1/1/1/2 + 3 openings).
- Typed properties round-trip with value AND type fidelity (IfcLabel,
  IfcBoolean incl. False-vs-True discrimination).
- Placements read back exactly; IfcDoor/IfcWindow OverallWidth/OverallHeight
  native attributes exact.
- **FINDING (OBSERVED):** ifcopenshell's default project length unit is
  MILLIMETRE while its geometry/placement APIs take metres. The adapter
  pins METRE explicitly; unpinned use would silently produce 1000x-scaled
  files. [bim/units/*]

### Item 5 — IFC round-trip (14 checks, all pass)

- Offisos domain ids preserved via `Pset_OffisosIdentity`; IFC classes,
  typed properties, quantities (1e-9), voids/fills relationships all
  preserved. GlobalIds stable within a file across write cycles.
- **Narrow-patch preservation:** patching one property (FireRating
  REI60 → REI90) leaves slab/space psets and wall qtos byte-identical.
- No semantic loss observed for the tested property types, quantities or
  relationships. [roundtrip/losses/none-observed]

### Item 6 — Quantity extraction (11 checks, all pass)

- OCCT BRep quantities match analytic fixture values exactly (gross 5.4,
  net 4.23, openings 1.17 m³; net side area 14.1 m²; sums over the small
  building 23.4 gross / 21.69 net).
- Deterministic across reruns; OBSERVED (round-tripped) equals CALCULATED
  (BRep) exactly.
- A wall with no geometry and no quantity set yields **UNKNOWN** with
  value None — never a fabricated zero (LOCK-007). [qty/unknown/ghost-wall]

### Item 7 — Performance (5 checks, all pass; timings OBSERVED, environment-specific)

| Measurement | Small (4 walls + 3 openings + slab + space) | Medium (100 walls + 50 openings + 5 spaces) |
|---|---|---|
| model creation | 42 ms (median) | 647 ms |
| IFC write | 1.3 ms | 16.5 ms |
| IFC file size | 16.9 KB | 269 KB |
| IFC parse | 3.7 ms | 41 ms |
| OCCT boolean cuts | — | 7.9 ms/op (100 ops, 0.79 s) |
| 1000-solid compound | — | build 34 ms, volume 119 ms |
| peak RSS (process) | 554 MiB (whole benchmark process incl. imports) | |

Scaling is near-linear in element count at these sizes. These are
single-environment observations, not thresholds; threshold-setting is
RESEARCH-CAD-006's scope.

### Item 8 — Construction Graph mapping (9 checks, all pass)

- **Engine ids are NOT canonical — directly observed:** two builds of the
  same fixture produce disjoint sets of GlobalIds. [cg/engine-ids/unstable-across-regeneration]
- Offisos domain ids are stable across regeneration and survive IFC round
  trips via the identity property set. [cg/domain-ids/*]
- Every graph node records provenance (source engine, engine id, engine
  class, identity-resolution method). Openings are recorded as voids in
  lineage, not canonical elements.
- Structural diff detects exactly the one added wall between revisions and
  reports no change across a round trip. [cg/diff/*]

### Item 9 — Adapter boundary and replacement proof (6 checks, all pass)

- The identical domain-level test suite (which imports no engine modules)
  produces identical results through the IfcOpenShell+OCCT adapter and a
  pure-Python reference adapter with no CAD engine (within 1e-9).
  [replacement/domain-results-identical, per-element-quantities-identical]
- Unsupported capability raises the typed `UnsupportedOperationError` —
  no silent fallback. [replacement/typed-unsupported-operation]
- Swapping the engine requires implementing the `CadBimAdapter` contract
  only; engine imports are confined to `offisos_cadbench/engines/`.

### Item 10 — Licensing/composition inventory (4 checks, all pass)

Exact tested components and licenses: IfcOpenShell 0.8.5 (LGPL-3.0-or-later),
OCCT 7.8.1 via cadquery-ocp 7.8.1.1.post1 (OCCT LGPL-2.1-with-exception,
bindings Apache-2.0), ezdxf 1.4.3 (MIT), numpy 2.1.3 (BSD-3-Clause).
FreeCAD (LGPL-2.1-or-later) recorded but not tested. Composition flags
raised for LICENSE-001 (LGPL-3 section-4 review; dynamic-linking posture
for OCCT). **No composition is approved by this benchmark.**

## 3. Failure modes verified (8 checks, all pass)

Malformed/truncated/empty IFC → typed `InvalidInputError`; missing file →
typed error; zero-extent geometry → `Standard_DomainError`; self-intersecting
bowtie profile → BRepCheck flags invalid; disjoint fuse → measurable
2-solid compound (topology loss detected, not silent); ghost wall quantity
→ UNKNOWN; unsupported operation → `UnsupportedOperationError`.

## 4. Limitations and unknowns (explicit)

1. **FreeCAD untested** (environment) — Sketcher constraints, Draft,
   TechDraw, and the 1.1.x release line require a follow-up run in an
   environment that can install FreeCAD.
2. Performance numbers are single-environment observations on a 4 GiB
   sandbox; not thresholds.
3. ezdxf was evaluated as a 2D representation gap-filler only; DWG was not
   tested (out of scope per issue #1).
4. Geometry round-trip fidelity of *tessellated* representations (viewer
   meshes) was not measured; only semantic/BRep quantities were asserted.
5. IFC4 only; IFC2x3/IFC4X3 schema variants not covered in this run.
6. The reference adapter proves the replacement *contract*, not that any
   specific alternative engine meets professional CAD/BIM capability.

## 5. Recommendation (INFERRED from the above; decision belongs to the Architect)

**(a) proceed with the candidate stack behind the frozen adapter boundary,
subject to constraints**, specifically:

- OCCT 7.8.1 as the geometry kernel behind the adapter (exact where
  tested; NaN-input validation is an adapter obligation);
- IfcOpenShell 0.8.5 for IFC semantics/round-trip (pinned METRE unit);
- 2D drafting representation and interactive constraint solving are NOT
  provided by OCCT — either FreeCAD must be evaluated in a follow-up
  environment (item 3 above) or the 2D layer must come from IFC/DXF +
  domain logic; this is a scope constraint, not an architecture change;
- composition approval is pending LICENSE-001;
- thresholds are pending RESEARCH-CAD-006.

No architecture change is required by this evidence: all capabilities were
exercised through the adapter contract, and the Construction Graph mapping
proof keeps engine ids non-canonical (LOCK-001/LOCK-003 satisfied).
