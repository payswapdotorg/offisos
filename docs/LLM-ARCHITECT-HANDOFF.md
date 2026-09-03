# LLM Architect Handoff — ConstructionOS / Offisos

## Purpose

A fresh Architect must be able to take over this repository without access to prior chat. This document records the current state, the evidence trail, the unresolved lifecycle gate, and the exact next actions.

## Current state at handoff

**Repository:** `pectoraux/offisos`

**Architecture:** ConstructionOS Architecture v1.1 — frozen.

**Main:** `3edd5506d972dc309b22c21baad7643f021f27d4`

**Latest completed product milestone:** CAD-PARITY-018 merged.

**P018 Issue:** #118

**P018 PR:** #120 (merged)

**P018 merge commit:** `3edd5506d972dc309b22c21baad7643f021f27d4`

**P018 final reviewed implementation head before merge:** `714a34e5712abf8b4a1dd015b806958ff9568ec2`

**P018 governance state at the moment of this handoff:** the last recorded lifecycle transition before merge is `ARCHITECT_REVIEW → APPROVED` (DEC-001). The merge itself has happened, so the next Architect must record `APPROVED → MERGED` against the exact merge commit and then complete the post-merge verification gate. Do not mark VERIFIED merely because the PR is merged.

## P018 scope

P018 adds bounded specialized professional toolsets on top of the verified CAD/BIM core.

### Architecture

- profile/wall runs, including junction-opening composition;
- hosted door/window openings using verified P011 host bindings;
- bounded roofs;
- stair runs and side railings;
- rooms/spaces grids;
- dimension chains;
- deterministic component placement/arrays.

### MEP

- bounded duct/pipe/conduit run records;
- connectors/endpoints and in-record connections;
- deterministic routing grammar;
- deterministic clash/clearance diagnostics over canonical geometry records.

### Mechanical

- bounded equipment records;
- ordinal ports and connector metadata;
- deterministic rectangular arrays/patterns.

### Raster / underlay

- canonical raster source/reference records;
- identity, digest, transform, clipping and visibility;
- fresh OK/STALE/MISSING derivation;
- typed non-authoritative trace;
- explicit commit-to-canonical path with lineage.

### Shared API/UI

- versioned typed App API surface;
- one shared command registry;
- Toolsets workbench in Web host;
- Web/Electron semantic parity through the shared application surface.

### Interoperability

The corrective P018 revision added dedicated IFC/BCF/IDS compatibility coverage for the bounded specialized semantics. The original review blocker was therefore resolved before approval and merge.

## Architecture invariants

These are not optional implementation preferences:

1. Construction Graph is canonical system of record.
2. CADDocument is editor/working representation.
3. Native engines remain behind EngineAdapterBundle/worker boundaries.
4. Renderer/application code cannot import engine internals.
5. Engine/vendor GlobalIds are provenance only.
6. Canonical identities are deterministic and document/domain-owned.
7. Unsupported operations return typed explicit failures.
8. No fabricated geometry, semantics, or hidden authority.
9. Web/Electron share semantic application contracts.
10. Architecture v1.1 remains frozen; protected-path changes require ACR.

## P018 evidence already produced

The repository and PR contain these evidence classes:

### Core deterministic suite

The P018 implementation added deterministic tests covering capability discovery, architecture workflows, MEP routing/diagnostics/connections, mechanical equipment/arrays, raster/reference/trace/commit behavior, identities, replay, undo/redo, persistence, and typed declines.

### Host parity

`app/test/toolsets-p018-host-parity.test.ts` proves the same semantic stream through WebHost/WebSocketTransport and ElectronHost/IpcTransport converges to equivalent persisted results and canonical content hash.

### Pinned smoke / fixture

`apps/web/test/toolsets-p018-smoke.mjs`

`app/test/fixtures/cad-parity-018-toolsets.json`

The smoke was run repeatedly and was byte-identical against the pinned fixture.

### Exact-head CI

The final evidence package recorded:

- 28/28 exact-head workflow runs terminal-success;
- 82/82 check-runs success;
- dedicated P018 pull-request run `33686398965` success;
- dedicated P018 workflow-dispatch run `33688206864` success;
- dedicated P018 workflow had 3/3 jobs and 62/62 steps successful.

The workflow includes workspace tests, real PostgreSQL web smokes, prior P016/P017 restart proofs, Electron build/regression surface, boundary scans, and pinned toolchain checks.

### Browser / deployment evidence

The exact-head deployment evidence package bound the reviewed corrective tree to a Vercel preview deployment and exercised the real browser surface. The observed deployed smoke used the real blob persistence backend and matched the pinned fixture. Browser checkpoints showed zero console messages and zero page errors.

The browser record explicitly documents the expected Vercel serverless limitation: a CADDocument held in a single serverless instance is not session-affine. Cross-instance calls can therefore yield honest typed `toolset_not_found` results. The rapid single-sequence smoke and workflow replay are the authoritative coherence evidence; this is not to be “fixed” by introducing hidden mutable server authority without an architecture review.

## Corrective review history

Architect review `5096872026` initially rejected approval at the comment/review level because P018 did not yet demonstrate specialized IFC/BCF/IDS behavior.

The implementation agent subsequently added the dedicated specialized-toolset interop implementation/tests and updated the evidence package. The governance record then recorded:

- `VERIFYING → ARCHITECT_REVIEW`
- `ARCHITECT_REVIEW → APPROVED`
- decision `DEC-001`

at corrective implementation head `5fceaccd...` / final merged PR head lineage culminating in `714a34e...`.

The exact governance record is authoritative; this document is a navigation aid and must not supersede it.

## Immediate next Architect actions

### 1. Reconcile merge state

Open `governance/work-items/CAD-PARITY-018.json` and record the legal `APPROVED → MERGED` transition with:

- issue `118`;
- PR `120`;
- exact merge commit `3edd5506d972dc309b22c21baad7643f021f27d4`.

The transition must satisfy the current workflow-state schema.

### 2. Validate mainline

Run:

```bash
npm install
npm run governance -- validate
npm run governance -- check-protected --base main
npm run governance -- check-verified-revisions
npm test
```

Then poll the Actions runs for the merge commit until terminal. Require zero failures and zero cancellations.

### 3. Verify merged-tree evidence

Confirm the merged tree still contains the corrective IFC/BCF/IDS work and the exact P018 evidence artifacts. Do not cite only the obsolete `3a124946` pre-correction evidence when a later corrective head exists.

### 4. Complete `MERGED → VERIFIED`

Only after the above passes:

- record an Architect decision approving post-merge verification;
- cite qualifying evidence IDs;
- bind verification to the exact merged revision or qualifying evidence revision according to the governance schema;
- record `MERGED → VERIFIED`.

Then rerun the governance validator on the resulting commit and require success.

## Success criterion

P018 is complete only when the repository's governance record, mainline merge state, evidence, and validator all agree on `VERIFIED`.

Until then, report the state as:

**CAD-PARITY-018 — MERGED, pending post-merge Architect verification.**

## Successor gate

Do not release a successor work item until P018 is VERIFIED. A merged predecessor is not a satisfied VERIFIED dependency.

## Useful repository locations

- `governance/work-items/CAD-PARITY-018.json` — canonical P018 lifecycle/evidence record
- `governance/work-items/CAD-PARITY-017.json` — VERIFIED predecessor example
- `spec/architecture-lock.md` — architecture authority
- `spec/development-workflow.md` — workflow authority
- `spec/roadmap-v1.1.md` — roadmap authority
- `spec/requirements.md` — requirement authority
- `governance/workflow-states.json` — lifecycle authority
- `governance/schemas/work-item.schema.json` — record schema
- `app/src/toolsets/` — specialized semantic core
- `app/src/ifc/toolsetmap.ts` — P018 specialized IFC mapping
- `app/src/interop/toolsets.ts` — P018 specialized interoperability layer
- `app/test/toolsets-p018.test.ts` — core P018 test suite
- `app/test/toolsets-p018-host-parity.test.ts` — host parity
- `app/test/toolsets-p018-interop.test.ts` — IFC/BCF/IDS specialized compatibility
- `app/test/fixtures/cad-parity-018-toolsets.json` — pinned fixture
- `apps/web/test/toolsets-p018-smoke.mjs` — reproducible P018 smoke
- `.github/workflows/cad-parity-018.yml` — dedicated P018 CI

## Security

Credentials used in previous deployment/merge operations are intentionally not recorded here. A fresh operator must supply credentials through the runtime environment, never by committing secrets to this repository.
