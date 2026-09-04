# LLM Architect Handoff — ConstructionOS / Offisos

## Current state

**Repository:** `pectoraux/offisos`

**Architecture:** ConstructionOS Architecture v1.1 — FROZEN.

**Latest verified CAD/BIM milestone:** CAD-PARITY-020 / P020 — Archicad parity certification.

**P020 issue:** #123

**P020 PR:** #126

**P020 merge commit:** `e47a9593fad6251a4ce8e621fdcc7aea07df585d`

**P020 verified evidence revision:** `3fbe45aa2b3bb0a33fe4dffb144224448bf261e2`

**P020 governance evidence:** run `33809662483` succeeded with every governance step successful. GitHub Actions subsequently exhibited a queue/scheduler blockage for push-triggered post-merge runs; those queued runs are explicitly not represented as successful evidence. P020 was nevertheless lawfully verified from the successful exact-head governance result plus direct revision comparison, recorded in `governance/work-items/CAD-PARITY-020.json`.

## P020 certification result

P020 certified eight representative Archicad-class BIM/documentation workflows against a version-pinned Archicad 27 corpus.

Recorded result:
- 52 expectations: 50 EXACT, 0 lossy, 2 unsupported;
- 14 interoperability probes: 9 EXACT, 1 LOSSY, 4 UNSUPPORTED;
- deterministic persistence/round-trip and robustness evidence;
- real Web/Electron transport parity and browser evidence;
- P019 baseline remained stable;
- frozen Architecture v1.1 and Construction Graph/CADDocument/engine-worker boundaries were preserved.

## Governing architecture invariants

1. Construction Graph is the canonical system of record.
2. CADDocument is the editor/working representation.
3. Native engines remain behind EngineAdapterBundle/worker boundaries.
4. Renderer/application code does not import engine internals.
5. Engine/vendor GlobalIds are provenance only.
6. Canonical identities are deterministic and domain/document owned.
7. Unsupported operations return explicit typed failures.
8. No fabricated geometry, semantics, or hidden authority.
9. Web/Electron share semantic application contracts.
10. Architecture v1.1 remains frozen; protected-path changes require an ACR.

## Next authorized work

The CAD/BIM roadmap explicitly treats P020 as the professional-complete milestone. Deeper CAD parity is now non-blocking and must not delay the broader ConstructionOS platform.

The next released feasibility gate is **RESEARCH-PM-001 — Evaluate Project/scheduling engine candidates**, canonical Issue **#36**.

Issue #36 was reopened and released after P020 verification. Its scope requires exact-version candidate evaluation, deterministic construction-schedule fixtures, WBS/activity/calendar/dependency/critical-path evidence, baseline/progress evidence, delay and scenario analysis, resource/capacity assessment, API/adapter and Construction Graph lineage analysis, replay evidence, and exact-version licensing/composition evidence.

The canonical governance record is:

`governance/work-items/RESEARCH-PM-001.json`

Current lifecycle state: **ASSIGNED** to logical implementation/research agent `z-ai-implementation-agent`.

Implementation/research must stop at **PR_OPEN / VERIFYING**. The agent must not claim APPROVED or VERIFIED.

## Execution constraints for RESEARCH-PM-001

- Start from the verified `main` baseline.
- ConstructionOS Architecture v1.1 remains frozen.
- No production Project implementation is authorized by this research gate.
- Construction Graph remains canonical.
- Engine-native identifiers remain provenance only.
- Separate factual compatibility evidence from legal interpretation; do not claim legal approval without proper authority.
- Candidate evaluation must end in an explicit recommendation: proceed behind adapter, proceed with constraints, reject/evaluate alternative, or require ACR/legal review.

## Governance protocol

Canonical lifecycle:
`DRAFT → READY → ASSIGNED → IMPLEMENTING → PR_OPEN → VERIFYING → ARCHITECT_REVIEW → APPROVED → MERGED → VERIFIED`

Architect owns `ARCHITECT_REVIEW → APPROVED → VERIFIED`.

Implementation agents stop at `PR_OPEN / VERIFYING`.

Verification is revision-bound and must never be inferred merely from a successful merge.

## Repository authority locations

- `spec/architecture.md`
- `spec/architecture-lock.md`
- `spec/requirements.md`
- `spec/roadmap-v1.1.md`
- `spec/development-workflow.md`
- `governance/workflow-states.json`
- `governance/schemas/work-item.schema.json`
- `governance/work-items/`

This document is a navigation aid. Canonical work-item governance records and frozen architecture specifications remain authoritative.
