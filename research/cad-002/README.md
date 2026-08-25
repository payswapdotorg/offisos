# RESEARCH-CAD-002 — FreeCAD/OpenCascade 2D and 3D CAD Benchmark

**Work item:** RESEARCH-CAD-002 (GitHub issue #2)
**Architecture version:** 1.0 (FROZEN) — research evidence, not production CAD;
this work item does **not** decide the final CAD engine
**Status:** evidence package for Architect review; VERIFIED is not claimed

Reproducible benchmark of the core CAD capability layer on the current
candidate: **FreeCAD 1.1.3** (official pinned AppImage, SHA256-verified)
with its bundled **OpenCascade** kernel — covering professional 2D drafting
workflows, snapping/object inference, geometric constraints, 3D solids and
booleans, parametric editing and recompute, assemblies (App::Link),
automation/API determinism, and quantitative precision/performance.

## Reproduce

```bash
cd research/cad-002
python3 -m pip install -r requirements.txt

# FreeCAD 1.1.3 (pinned AppImage, no sudo — URL + SHA256 in requirements.txt):
mkdir -p .freecad && cd .freecad
curl -sL -o freecad.AppImage "https://github.com/FreeCAD/FreeCAD/releases/download/1.1.3/FreeCAD_1.1.3-Linux-x86_64-py311.AppImage"
echo "3a853eb69ee595f779f2255dbf80a765926981d8ff68903cefee4dfb03a8f5ef  freecad.AppImage" | sha256sum -c -
chmod +x freecad.AppImage && ./freecad.AppImage --appimage-extract && rm freecad.AppImage
cd ..

make test   # deterministic CI gate: full suite, zero failures/unknowns (~5 s)
make bench  # produce evidence/<run-id>/ (~25 s)
```

The runner also honors `FREECADCMD=/path/to/freecadcmd` and discovers an
existing `research/cad-001/.freecad/` extraction (same pinned version).
The committed reference evidence is `evidence/run-001/`.

## What is measured (issue #2 scope)

| Benchmark | Scope |
|---|---|
| `bench-2d-drafting` | 1. precision/coordinate entry (12-decimal), circles/arcs, layers + visibility, linear dimensions, text annotations, edit/recompute, persistence |
| `bench-snapping` | 1. Draft snap parameter system; native object inference (distToShape nearest point); adapter endpoint/midpoint/intersection/grid snapping; GUI boundary finding |
| `bench-constraints` | 1/3. full constraint (DoF 0), datum edit propagation with before/after, tangent (fully constrained), perpendicular, equal-length propagation, redundancy/conflict detection, typed invalid-datum rejection |
| `bench-parametric-3d` | 2/3. Part primitives, PartDesign Body/Sketch/Pad/Pocket chains, dimension propagation through chains, dependency/recompute states, failure (Invalid state) + recovery |
| `bench-booleans` | 2. scripted fuse/cut/common with exact volumes, curved cuts, honest disjoint-fuse topology, parametric Part::Cut with propagation, placements/rotations/matrix transforms with exact vertex assertions |
| `bench-assemblies` | 2. App::Link instances, source-edit propagation, link arrays, 100-instance medium assembly with timings and robustness |
| `bench-automation` | 4. process-isolated CAD adapter (stable contract, no application-global state), identical-workflow determinism, in-process determinism, STEP semantic round-trip, byte-determinism findings |
| `bench-performance` | timings, object counts, recompute times, file sizes, peak memory |

## Epistemic classes

Every check is labelled NATIVE (engine), ADAPTER (Offisos code), OBSERVED
(direct observation incl. negative findings), or CALCULATED (analytic with
stated tolerance). Findings — including solver and API limitations — are
recorded as first-class evidence, never silently worked around. See
`offisos_cadbench2/harness.py` and `report.md`.

## Key findings (see report.md)

- Geometry precision is exact at 1e-12 across drafting, constraints,
  parametric chains, booleans, transforms and assemblies.
- **FINDING:** `sketch.solve()` returns a solver return code, NOT the DoF;
  `FullyConstrained` is the actual DoF-0 indicator. Adapter code must not
  conflate them.
- **FINDING:** an underconstrained tangent sketch can converge (rc 0)
  without geometric tangency — constraints must be completed before
  relying on tangency; adapters must assert geometry separately from
  solver success.
- **FINDING:** Coincident-to-origin on a circle anchors its CENTER — a
  constraint-semantics trap that silently moved a pocket hole to the pad
  corner (caught by exact volume assertions).
- **FINDING:** STEP/FCStd exports are NOT byte-deterministic (embedded
  timestamps); semantic determinism is exact. Change detection must be
  semantic, not file-byte based.
- **FINDING:** invalid parameters leave objects in the detectable
  `Invalid` state (no crash, no fake geometry); recovery works.
- Interactive snapping UI and TechDraw SVG/PDF export remain GUI-only
  (console DXF export and all geometry queries are console-capable).
