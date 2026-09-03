# ConstructionOS / Offisos — AI Continuation

This file is the first stop for any new LLM Architect, reviewer, or implementation agent taking over without prior conversation context.

## Current authoritative state

- Repository: `pectoraux/offisos`
- Architecture: ConstructionOS Architecture **v1.1 — FROZEN**
- Canonical system of record: **Construction Graph**
- Editor/working representation: **CADDocument**
- Native CAD/BIM engines: only behind the established **EngineAdapterBundle / worker** boundary
- Web/Electron: shared semantic contracts and application behavior
- Engine GlobalIds: provenance only, never canonical identity
- Unsupported capability: explicit typed failure, never fabricated semantics
- Governance lifecycle: `DRAFT → READY → ASSIGNED → IMPLEMENTING → PR_OPEN → VERIFYING → ARCHITECT_REVIEW → APPROVED → MERGED → VERIFIED`
- Architect owns `ARCHITECT_REVIEW → APPROVED → VERIFIED`.
- Implementation agents stop at `PR_OPEN/VERIFYING`.

## Milestones

P016 is VERIFIED. P017 is VERIFIED. **P018 is VERIFIED.**

P018 GitHub Issue: **#118**
P018 PR: **#120**
P018 merge commit: **3edd5506d972dc309b22c21baad7643f021f27d4**
P018 reviewed corrective implementation head before merge: **714a34e5712abf8b4a1dd015b806958ff9568ec2**
P018 corrective interop implementation: **ea76d4b9d1a12a21bdadfdeae5939c4045509b9c**
P018 approval decision: **DEC-001**
P018 post-merge verification decision: **DEC-002**
Architect review that triggered the interoperability correction: **5096872026**

## P018 verification closure

The original substantive P018 blocker was dedicated IFC/BCF/IDS interoperability coverage for the new specialized semantics. The corrective revision added the specialized IFC carrier, typed EXACT/LOSSY/UNSUPPORTED classification, deterministic interop tests and pinned smoke coverage without changing Architecture v1.1 or the engine/worker boundary.

Post-merge verification then bound the actual merge commit to the governance ledger and checked the merge-head Actions matrix. The merge-head matrix was terminal with no failure or cancellation entries; the post-merge governance run succeeded. The final governance transition is `MERGED → VERIFIED` with DEC-002.

## Verified P018 scope

Architecture: bounded profile/wall, hosted door/window, roof, stair, railing, rooms/spaces, dimensioning, component placement/editing over verified BIM primitives.

MEP: bounded duct/pipe/conduit routing, connectors/endpoints, route validation, deterministic clash/clearance diagnostics.

Mechanical: bounded equipment layout, ordinal ports, deterministic rectangular arrays/patterns.

Raster/underlay: canonical raster source/reference records, transforms, clipping, visibility, persistence, stale/missing status, typed non-authoritative trace, explicit commit-to-canonical path.

Shared API/UI: versioned typed App API, one shared command registry, Toolsets workbench, Web/Electron semantic parity.

Interoperability: IFC/BCF/IDS support for the bounded specialized semantics, with explicit LOSSY/UNSUPPORTED outcomes outside the supported model.

## Current successor

`COMPAT-CAD-004` is the next governed work item and is now **ASSIGNED**.

- GitHub Issue: **#121**
- Governance record: `governance/work-items/COMPAT-CAD-004.json`
- State: `ASSIGNED`
- Dependency: P018 VERIFIED at `3edd5506d972dc309b22c21baad7643f021f27d4`
- Scope: bounded parametric constraints, associative drafting, reusable 2D symbols/blocks, deterministic mirror/array/pattern operations, shared App API/command registry, and bounded interoperability.
- Implementer stop gate: `PR_OPEN/VERIFYING`.

This is the planned **complete-enough CAD/BIM boundary** in `spec/roadmap-v1.1.md`. After this work item is VERIFIED, CAD/BIM feature expansion pauses while broader ConstructionOS platform work proceeds.

## Primary repository authorities

Read these before making architectural decisions:

- `spec/architecture-lock.md`
- `spec/architecture.md`
- `spec/development-workflow.md`
- `spec/roadmap-v1.1.md`
- `spec/requirements.md`
- `governance/workflow-states.json`
- `governance/schemas/work-item.schema.json`
- `governance/protected-paths.json`
- `governance/work-items/CAD-PARITY-017.json`
- `governance/work-items/CAD-PARITY-018.json`
- `governance/work-items/COMPAT-CAD-004.json`
- `docs/LLM-ARCHITECT-HANDOFF.md`
- `IMPLEMENTATION.md`
- `AGENTS.md`

## Essential commands

```bash
npm install
npm run governance -- validate
npm run governance -- check-protected --base main
npm run governance -- check-verified-revisions
npm test
```

For CAD/BIM work, also install the pinned toolchains specified by the relevant workflow before interpreting environment-gated evidence.

## Evidence rule

Evidence is only qualifying for VERIFIED when it is accepted by the governance evidence policy, reproducible, revision-bound, and cited by the verifying transition. Screenshots and narrative claims alone are never sufficient.

## Security

Never commit PATs, Vercel tokens, credentials, or environment secrets to the repository or documentation. Use environment-backed credentials only.
