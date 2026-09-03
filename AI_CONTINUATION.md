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

P016 is VERIFIED. P017 is VERIFIED. P018 has now been **MERGED** but is intentionally **not yet VERIFIED** on main.

P018 GitHub Issue: **#118**
P018 PR: **#120**
P018 merge commit: **3edd5506d972dc309b22c21baad7643f021f27d4**
P018 reviewed corrective implementation head before merge: **714a34e5712abf8b4a1dd015b806958ff9568ec2**
P018 implementation evidence head referenced by the original evidence package: **3a124946a4713ebdf1b43c37d96166f76adac9fd**
P018 approval decision: **DEC-001**
Architect review that triggered the interoperability correction: **5096872026**

### Important P018 review history

The first P018 review identified a substantive evidence gap: the original implementation proved regression compatibility with the existing IFC/BCF/IDS stack, but did not itself provide specialized-toolset interoperability coverage.

Before merge, that gap was addressed on the corrective P018 head by adding the dedicated specialized IFC/BCF/IDS implementation and tests, including:

- `app/src/ifc/toolsetmap.ts`
- `app/src/interop/toolsets.ts`
- `app/test/toolsets-p018-interop.test.ts`
- the corresponding pinned fixture / corrective smoke coverage

The governance record on the corrective head records EV-003 for this interoperability package and EV-004 for deployment/browser evidence. The Architect then recorded `VERIFYING → ARCHITECT_REVIEW → APPROVED` with DEC-001 before the merge.

## P018 scope

Architecture: bounded profile/wall, hosted door/window, roof, stair, railing, rooms/spaces, dimensioning, component placement/editing over verified BIM primitives.

MEP: bounded duct/pipe/conduit routing, connectors/endpoints, route validation, deterministic clash/clearance diagnostics.

Mechanical: bounded equipment layout, ordinal ports, deterministic rectangular arrays/patterns.

Raster/underlay: canonical raster source/reference records, transforms, clipping, visibility, persistence, stale/missing status, typed non-authoritative trace, explicit commit-to-canonical path.

Shared API/UI: versioned typed App API, one shared command registry, Toolsets workbench, Web/Electron semantic parity.

Interoperability: IFC/BCF/IDS support for the bounded specialized semantics, with explicit LOSSY/UNSUPPORTED outcomes outside the supported model.

Non-goals include full AutoCAD Architecture/MEP/Mechanical parity, full Revit MEP solving, general mechanical feature/history modeling, full raster reconstruction/OCR authoring, unrestricted plugin execution, replacement of canonical boundaries, or architecture changes without an ACR.

## P018 verification status after merge

Do **not** infer VERIFIED from the green pre-merge evidence. The final governance gate is still required.

The next Architect must:

1. Verify that main is actually at `3edd5506d972dc309b22c21baad7643f021f27d4`.
2. Confirm the merged PR #120 corresponds to the reviewed corrective head and contains the interoperability correction.
3. Reconcile the governance record from `APPROVED` to `MERGED` using the exact merge commit `3edd5506...` and the repository's legal transition schema.
4. Poll the post-merge Actions matrix to terminal and require zero failures/cancellations.
5. Re-check the dedicated P018 workflow and the corrective IFC/BCF/IDS evidence against the merged tree.
6. Re-check the exact-head deployment evidence bound to the corrective head / deployment record and verify that the production alias was not implicitly changed by the preview deployment process.
7. Verify the real-browser evidence and the documented serverless/session boundary honestly.
8. Only after all evidence is revision-bound to the merged implementation and post-merge tree, record `MERGED → VERIFIED` with an approved Architect decision and qualifying evidence IDs.
9. Run the governance validator on the resulting mainline tree and require it to succeed.

Until those steps succeed, the truthful state is **P018 MERGED / pending post-merge Architect verification**.

## P019 / successor rule

No successor work item should be released merely because P018 is merged. The dependency gate is P018 **VERIFIED**, not merely MERGED. The next Architect should inspect the frozen roadmap and only release the next work item after the P018 verification gate closes.

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
