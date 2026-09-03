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

P016 is VERIFIED. P017 is VERIFIED. **P018 is VERIFIED.** **COMPAT-CAD-004 is VERIFIED.**

P018 GitHub Issue: **#118**
P018 PR: **#120**
P018 merge commit: **3edd5506d972dc309b22c21baad7643f021f27d4**
P018 reviewed corrective implementation head before merge: **714a34e5712abf8b4a1dd015b806958ff9568ec2**
P018 corrective interop implementation: **ea76d4b9d1a12a21bdadfdeae5939c4045509b9c**
P018 approval decision: **DEC-001**
P018 post-merge verification decision: **DEC-002**
Architect review that triggered the interoperability correction: **5096872026**

COMPAT-CAD-004 GitHub Issue: **#121**
COMPAT-CAD-004 PR: **#124**
COMPAT-CAD-004 final implementation head: **d67475f28619297090fc6822798856feeceb39a4**
COMPAT-CAD-004 merge commit: **3844bff4a1141b5536d432e7f4653b78a182d821**
COMPAT-CAD-004 post-merge governance run: **33744735354**
COMPAT-CAD-004 dedicated post-merge run: **33744735415**
COMPAT-CAD-004 exact-head deployment: **dpl_BGjdkQ8zo51PmaSNhwqfaRmmPEQn**
COMPAT-CAD-004 governance record: `governance/work-items/COMPAT-CAD-004.json` — **VERIFIED**

## P018 verification closure

The original substantive P018 blocker was dedicated IFC/BCF/IDS interoperability coverage for the new specialized semantics. The corrective revision added the specialized IFC carrier, typed EXACT/LOSSY/UNSUPPORTED classification, deterministic interop tests and pinned smoke coverage without changing Architecture v1.1 or the engine/worker boundary.

Post-merge verification then bound the actual merge commit to the governance ledger and checked the merge-head Actions matrix. The merge-head matrix was terminal with no failure or cancellation entries; the post-merge governance run succeeded. The final governance transition is `MERGED → VERIFIED` with DEC-002.

## COMPAT-CAD-004 verification closure

COMPAT-CAD-004 completed the bounded pre-certification CAD/BIM hardening slice under frozen Architecture v1.1. The delivered surface includes the versioned typed capability registry, bounded deterministic parametric/associative/pattern semantics, reflected block-instance placement, one-revision associative refresh, shared App API/command registry surfaces, the Parametrics Web workbench, Web/Electron semantic parity, persistence/replay/undo evidence and explicit typed declines outside the supported vocabulary.

The final implementation head `d67475f28619297090fc6822798856feeceb39a4` had the full app suite at **1372/1372 pass, 0 fail, 0 skipped**, exact-head deployment/browser evidence, and dedicated CI evidence. After merge at `3844bff4a1141b5536d432e7f4653b78a182d821`, **27/27 workflow runs completed** with no queued, in-progress, failed, or cancelled workflow runs. The dedicated COMPAT-CAD-004 post-merge workflow and post-merge governance workflow both completed successfully.

The authoritative governance lifecycle for COMPAT-CAD-004 is recorded as `DRAFT → READY → ASSIGNED → IMPLEMENTING → PR_OPEN → VERIFYING → ARCHITECT_REVIEW → APPROVED → MERGED → VERIFIED`. Issue #121 is closed as completed.

## Verified P018 scope

Architecture: bounded profile/wall, hosted door/window, roof, stair, railing, rooms/spaces, dimensioning, component placement/editing over verified BIM primitives.

MEP: bounded duct/pipe/conduit routing, connectors/endpoints, route validation, deterministic clash/clearance diagnostics.

Mechanical: bounded equipment layout, ordinal ports, deterministic rectangular arrays/patterns.

Raster/underlay: canonical raster source/reference records, transforms, clipping, visibility, persistence, stale/missing status, typed non-authoritative trace, explicit commit-to-canonical path.

Shared API/UI: versioned typed App API, one shared command registry, Toolsets workbench, Web/Electron semantic parity.

Interoperability: IFC/BCF/IDS support for the bounded specialized semantics, with explicit LOSSY/UNSUPPORTED outcomes outside the supported model.

## CAD/BIM successor sequence

P018 is the VERIFIED specialized-toolset milestone and COMPAT-CAD-004 is now the VERIFIED pre-certification hardening milestone. The intended successor sequence is:

1. `COMPAT-CAD-004` — **VERIFIED** under Issue **#121**; governance record `governance/work-items/COMPAT-CAD-004.json`. This is the completed bounded pre-certification hardening slice. It must remain verified before P019 execution.
2. **P019 / CAD-PARITY-019** — **AutoCAD parity certification**. GitHub Issue **#122**; governance record `governance/work-items/CAD-PARITY-019.json`; currently **DRAFT**. This is a certification program, not another feature sprint. It evaluates a representative professional workflow corpus across semantics, persistence, real UI task completion, interoperability, and performance/robustness. Feature checklists alone do not certify parity.
3. **P020 / CAD-PARITY-020** — **Archicad parity certification**. GitHub Issue **#123**; governance record `governance/work-items/CAD-PARITY-020.json`; currently **DRAFT** and depends on P019 VERIFIED. This uses the same certification principle against Archicad-class BIM/documentation workflows, proving integrated professional workflows rather than merely the existence of individual commands.

The authoritative roadmap therefore reads **P018 → COMPAT-CAD-004 → P019 → P020 → broader ConstructionOS platform build**.

P019 and P020 are distinct governed milestones and must not be collapsed into COMPAT-CAD-004 or treated as ordinary feature implementation sprints. Their acceptance must be evidence-backed, revision-bound and reproducible under the normal governance lifecycle.

After P020 is VERIFIED, CAD/BIM feature expansion becomes a separate, non-blocking compatibility program. The broader ConstructionOS platform continues under Architecture v1.1.

## Parallel tracks

Project/scheduling and Office/Sheets may proceed independently once their own dependency gates are satisfied:

- Project: `RESEARCH-PM-001 → RESEARCH-PM-002 → COMPAT-PM-001 → COMPAT-PM-002`
- Office: `RESEARCH-OFFICE-001 → COMPAT-SHEET-001 / COMPAT-DOC-001 / COMPAT-OFFICE-001`

These tracks converge on the shared platform rather than creating separate architectures.

## Platform sequence

Once the first Project/Sheets baselines can exercise shared services, the common platform proceeds:

`PLATFORM-001 → PLATFORM-002 → PLATFORM-003 → PLATFORM-004 → PLATFORM-005 → PLATFORM-006`

Then the Construction Graph, collaboration, AI/tool intelligence, knowledge/uncertainty, cost/procurement, construction intelligence, extensions/public API and full-system benchmarks proceed according to their governed dependencies.

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
- `governance/work-items/CAD-PARITY-019.json`
- `governance/work-items/CAD-PARITY-020.json`
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
