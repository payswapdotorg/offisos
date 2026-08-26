# RESEARCH-CAD-007 — Final CAD/BIM feasibility: adapter replacement + end-to-end workflow

**Work item:** RESEARCH-CAD-007 (Issue #32; execution directive comment `5429094699`, 2026-08-26T17:58:56Z)
**Base:** `main` @ `74f95529f20a0840f6e1189a37e3b9a3d9c8c34f` (RESEARCH-CAD-006 merged)
**Architecture:** v1.1, FROZEN — no architecture change, no protected-path edits
**Status:** research/evidence only. Implementation does not claim APPROVED or VERIFIED.

## 1. The proposition under test

```
OCCT adapter
      │
      ├──────────────┐
      │              │
Reference adapter   same canonical contracts
      │              │
      └──────┬───────┘
             ↓
      Construction Graph
             ↓
         Quantities
             ↓
          Estimate
             ↓
       Affected RFQ
             ↓
    Commercial impact
```

The critical proof is not merely that a second engine works. It is that
**replacing the engine does not change canonical ConstructionOS semantics**:
identities, document content, graph events and downstream structure stay
identical; measured values agree within declared tolerances; every engine
footprint is provenance.

## 2. What was built (additive, behind the frozen boundary)

| Piece | Path | Role |
| --- | --- | --- |
| Reference geometry engine | `app/src/adapters/reference/reference-geometry-adapter.ts` | Second, fully independent implementation of the byte-unchanged `GeometryEngineAdapter` contract — pure TypeScript analytic solid geometry. No FreeCAD/OCCT/IfcOpenShell anywhere in its dependency graph. Deterministic `ref:` meshTokens (SHA-256 over the canonical mesh encoding). |
| Reference bundle | `app/src/adapters/reference/reference-adapter.ts` | geometry + bim (pass-through, honest scope) + file (canonical Offisos JSON). Wired at the same single `AppApiHandler.create({ adapterBundle })` point (LOCK-003). |
| Downstream contracts | `app/src/contracts/impact.ts` | Canonical, engine-free Quantity/Estimate/RFQ/CommercialImpact + the event-model.md §3 cascade events (`quantity.recalculate.requested`, `quantity.changed`, `estimate.recalculated`, `rfq.scope.impact.detected`). |
| Impact cascade core | `app/src/impact/cascade.ts` | Deterministic cascade for one model transition: quantities through the engine boundary (metadata capability; labelled analytic fallback), version-free cost-item identities, category-scoped RFQ packages, aggregate commercial impact. Causation chain rooted at the `model.version.created` graph event. |
| App API query | `impact.cascade` | Additive (api-contract.md §8), non-mutating, same surface on both hosts. |
| LOCK-018 scan | `app/test/no-forbidden-imports.test.ts` | Extended: `src/impact` joins the protected core scan; new boundary-direction check asserts the reference adapter imports no engine/host module. |
| Web panel | `apps/web/src/app/page.tsx` + client | "Impact" panel: quantity deltas, estimate before/after, affected RFQ packages, commercial impact, events_hash. |
| Electron smoke | `apps/electron` `--smoke-impact` + `npm run smoke:impact` | Real-BrowserWindow proof of the full chain with the REFERENCE engine bound in the desktop host (engine-free, any toolchain). |

## 3. Exactness classes of the reference engine (LOCK-007)

The reference engine computes exactly and declines typed (`engine_error`,
not retryable) outside its classes — it never guesses:

| Descriptor | Exact treatment |
| --- | --- |
| `box` | volume `w·d·h`; bbox `[0,0,0,w,d,h]`; 8-vertex/12-triangle mesh. |
| `cylinder` (+origin/direction) | volume `πr²h`; **exact world bbox** `h·|dᵢ| + 2·r·√(1−dᵢ²)` per axis (gp_Ax2 base-center semantics, matching the OCCT adapter); fixed 32-segment tessellation in a deterministic orthonormal frame. |
| `transform` | boxes/cell-sets: any affine (parallelepiped corners, volume × \|det L\|); cylinders: rigid or uniform-scale only — a non-uniform affine image of a cylinder is not a cylinder and is declined. |
| `fuse` | exact when the operands' world AABBs are disjoint (touching allowed, measure-zero boundary): volume = sum, mesh = concatenation; overlapping AABBs declined. |
| `cut` | exact when both operands reduce to axis-aligned box cell sets: plane-split cell decomposition (up to 3×3×3 per operand pair), exact volumes/bbox, per-cell meshes in canonical order; anything else declined. |

Validation mirrors the OCCT adapter's `engine_malformed_input` codes and
messages, so the contract's **error surface is engine-independent too**.

## 4. Measured results (committed evidence `evidence/run-001/`)

Environment: node v24.18.0 (local run), `reference@1.0.0`, OCCT `7.8.1.1.post1`
(cadquery-ocp); CI reproduces on node 22 + Python 3.12.

| Fact | Measured | Declared |
| --- | --- | --- |
| Cross-engine volume agreement (full corpus) | max rel err **4.162e-9** | 1e-6 relative |
| Cross-engine bbox agreement (full corpus) | max abs diff **3.647e-4** | 0.02 absolute (OCCT tolerance-inclusive Bnd_Box) |
| Engine swap, document content hash | **identical** | must be identical |
| Engine swap, graph events (`model.getGraphEvents`) | **byte-identical stream + events_hash** | must be identical |
| Engine swap, downstream identities (quantity/cost-item/package/estimate ids) | **identical** | must be identical |
| Engine swap, estimate totals | agree within 1.128e-7 GHS on a ~4.5k GHS estimate | 1e-6 relative |
| Cascade determinism (rerun, save→open) | **identical events_hash**, identical content hash | must be identical |
| Web↔Electron cascade parity (reference + OCCT) | **byte-identical cascades** on both hosts | must be identical |

Existential chain (revision 6 → 7, column grows 3.0 → 3.5):

```
model.version.created (r7)                    ← cause (graph bridge)
  → quantity.recalculate.requested            affected: el-column-a
  → quantity.changed                          ΔV = +0.08 model-unit³ (exact)
  → estimate.recalculated                    Δtotal = +33.60 GHS (demo rate 420 GHS/unit³)
  → rfq.scope.impact.detected                concrete package affected (+33.60 GHS); steel unaffected
  → commercial impact                         +33.60 GHS, 1 affected package
```

Full artifact: `evidence/run-001/evidence.json` (equivalence matrix per
element, swap skeleton, cascade snapshot, determinism flags) +
`summary.txt`. The deterministic gate is the app test suite itself.

## 5. Engine-independence of identity (LOCK-019 evidence)

- `graphNodeId(entity, element)` is a pure function of canonical inputs;
  engine GlobalIds appear only in `GraphElementProjection.engineId`
  (provenance) and the epistemic `uncertainty` labels.
- With three provenance variants (`occt:…`, `reference:…`, none) on the same
  edits, the graph identity mapping (element ↔ node id, per revision) is
  **identical**, as are the event-type sequences and element projections.
- Version-scoped ids (quantity ids, version ids) legitimately track the
  document **content** — and the element's recorded engine provenance IS
  document content; this is recorded honestly in
  `graph-identity-stability.test.ts`, not silently normalized away.
- Version-FREE downstream identities (cost items, RFQ packages) are identical
  across provenance variants AND across engines.

## 6. Honest boundaries

- The demo rate table (`demo-rates-2026-08`, GHS, source `demo-fixture`) is a
  deterministic FIXTURE for the existential contract test — not market data;
  production rate binding is out of scope (LOCK-007 provenance recorded).
- The reference engine's boolean coverage is the declared exactness class, not
  general CSG. Outside it, it fails typed; the cascade records such elements
  as `adapter-declined` UNKNOWN skips, never guesses.
- The analytic fallback (for adapters without the metadata capability, e.g.
  the dummy double) covers box/cylinder/transform exactly and declines
  booleans — labelled `analytic-descriptor`, distinct from
  `engine-geometry-adapter`.
- Tessellation counts (`metadata.vertices/triangles`) and `meshToken` values
  are engine-local viewport data, never canonical values — the corpus tests
  assert they differ across engines by design.
- Web/Electron UI parity is proven at the App API/transport level
  (byte-identical cascades); the Electron smoke proves the desktop chain
  through a real BrowserWindow; no UI pixel-parity claim is made.

## 7. Reproduce

```bash
# full deterministic gate (engine-gated tests include the real OCCT legs)
cd app && npm test            # 139/139 with python3 + cadquery-ocp present
node --import tsx research/cad-007/run-evidence.mjs   # evidence/run-001/*
cd apps/electron && npm run smoke:impact              # desktop chain (engine-free)
cd apps/web && npm run dev   # Impact panel in the workbench sidebar
```

CI: `.github/workflows/research-cad-007.yml` (impact-shell with the pinned
OCCT toolchain + web host cascade smoke + electron impact smoke); the
existing CAD-IMPLEMENT-001/002/003 workflows run unchanged as regression
gates on the same PR.
