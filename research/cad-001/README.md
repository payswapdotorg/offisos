# RESEARCH-CAD-001 — CAD/BIM Candidate Engine Benchmark

**Work item:** RESEARCH-CAD-001 (GitHub issue #1)
**Architecture version:** 1.0 (FROZEN) — this is research evidence, not production CAD
**Status:** evidence package for Architect review; VERIFIED is not claimed

Reproducible feasibility benchmark for the CAD/BIM candidate foundation:
**IfcOpenShell 0.8.5** (IFC authoring/parsing/round-trip) and **OpenCascade
Technology 7.8.1 via cadquery-ocp 7.8.1.1.post1** (exact BRep geometry), with
**ezdxf 1.4.3** evaluated for the observed 2D drafting representation gap.
FreeCAD could not be installed in the benchmark sandbox (no sudo/apt;
conda-forge CDN unreachable) — recorded as an explicit environment
limitation, not an engine failure.

## Reproduce

```bash
cd research/cad-001
python3 -m pip install -r requirements.txt   # exact pinned versions

make test          # deterministic CI gate: full suite, zero failures required
make bench         # produce evidence/<run-id>/ (RUN_ID=run-002 to override)
```

The full suite runs in ~6 s. The committed reference evidence is
`evidence/run-001/` (environment snapshot, per-benchmark JSON results,
summary).

## What is measured

| Benchmark | Evidence item (issue #1) |
|---|---|
| `bench-2d-drafting` | 1. precision, snapping (adapter), layers/dimensions (OCCT gap + DXF), constraints (gap) |
| `bench-3d-geometry` | 2. solids, booleans, transforms, assemblies, validity |
| `bench-parametric` | 3. parametric edit/regeneration, failure behavior; FreeCAD Sketcher (not installable here) |
| `bench-bim-semantics` | 4. IFC elements, relationships, psets/qtos, placements, native attributes |
| `bench-ifc-roundtrip` | 5. identity/class/property/quantity/relationship round-trip; narrow-patch preservation |
| `bench-quantities` | 6. deterministic quantities with numeric assertions; UNKNOWN for missing basis |
| `bench-performance` | 7. timings, file sizes, peak RSS on small + medium fixtures |
| `bench-cg-mapping` | 8. Construction Graph mapping proof (engine ids non-canonical) |
| `bench-adapter-replacement` | 9. adapter boundary + replacement proof (two adapters, identical domain results) |
| `bench-failure-modes` | typed failures: malformed input, invalid geometry, lossy conversion, ambiguous quantity |
| `bench-licensing` | 10. exact versions + license inventory (composition approval belongs to LICENSE-001) |

## Epistemic classes

Every check is labelled `NATIVE` (engine capability measured directly),
`ADAPTER` (capability provided by Offisos adapter code), `OBSERVED`
(direct observation, including negative findings), `CALCULATED`
(analytic/derived with stated tolerance) or `INFERRED` (conclusion, always
with supporting evidence). See `offisos_cadbench/harness.py`.

## Key findings (see report.md for the full list)

- OCCT geometry is exact where tested (boolean volumes, napkin-ring curved
  cut, transforms) — pass at 1e-9..1e-6 tolerance.
- OCCT has **no layer model, no dimension/annotation entities, no 2D
  constraint solver** — 2D drafting representation must come from the
  IFC/DXF layer or FreeCAD; ezdxf round-trips layers + dimension entities
  exactly.
- **FINDING:** OCCT silently accepts NaN coordinates (0-volume shape);
  input validation is an adapter obligation.
- **FINDING:** ifcopenshell's default project length unit is MILLIMETRE
  while its geometry/placement APIs take metres; the adapter pins METRE
  explicitly.
- IFC semantic round-trip preserves identity (via `Pset_OffisosIdentity`),
  classes, typed properties, quantities (1e-9) and relationships; a
  one-property patch leaves all unrelated elements byte-identical.
- Engine GlobalIds are **unstable across model regeneration** while Offisos
  domain ids are stable — direct proof that engine ids must not be canonical.
- The identical domain test suite passes through the IfcOpenShell+OCCT
  adapter and a pure-Python reference adapter with identical results —
  the replacement path is proven at the contract level.

## Findings report

See [`report.md`](report.md) for the full findings, failures, limitations
and recommendation options for the Architect.
