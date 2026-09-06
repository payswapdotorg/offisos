# ConstructionOS / Offisos — AI Continuation

This is the first stop for a new LLM Architect, reviewer, or implementation agent taking over without chat history. Chat history is non-authoritative.

## Current authoritative state

- Repository: `payswapdotorg/offisos`
- Architecture: ConstructionOS Architecture **v1.1 — FROZEN**
- Canonical system of record: **Construction Graph**
- Editor/working representation: **CADDocument**
- Native CAD/BIM engines: only behind the established **EngineAdapterBundle / worker** boundary
- Web/Electron: shared semantic contracts and application behavior
- Engine GlobalIds: provenance only, never canonical identity
- Unsupported capability: explicit typed failure, never fabricated semantics
- Governance lifecycle: `DRAFT → READY → ASSIGNED → IMPLEMENTING → PR_OPEN → VERIFYING → ARCHITECT_REVIEW → APPROVED → MERGED → VERIFIED`

## Current CAD execution

- Latest verified CAD product revision: `9232c90e4340475bcf5c6818a30d9748ea04330a`
- Verified work item: **COMPAT-CAD-007** — Issue **#1** — VERIFIED.
- Permanent benchmark baseline: **18/100**. No score increase is authoritative without a full benchmark rerun.
- Active work item: **COMPAT-CAD-008** — Arrays/materialization/render/selectability — Issue **#5**.
- Physical merge: **PR #11 merged at `3854f5391fe58475b50bec9b33e695c33dabc467`**.
- Post-merge CI: **terminal-success** — `cad-parity-018` run `34009858133`; workspace `101423661661`, Electron `101423661726`, Web `101423661768`.
- Current legal state: **MERGED — VERIFIED BLOCKED**.
- Required remaining gates: exact deployed revision plus independent visible browser-agent G3/G5/G6/G7 and targeted DEF-015, invalid/unsupported, undo/redo, source-delete/orphan, no-phantom-member and regression probes.
- CC009 must not be released until CC008 is VERIFIED.

## Verification blocker

The post-merge CI is green, but the mandatory CAD browser gate cannot currently be completed from the available execution boundary. No Vercel project linked to `payswapdotorg/offisos` was found in the available Vercel account, no repository deployment URL/reference was found, and the required `agent-browser` executable is unavailable in the current environment.

A durable blocker record is stored at `docs/cad/verification/CC008-POST-MERGE-BLOCKER.md`.

## Broader roadmap

`CAD-BENCH-RW-001 → COMPAT-CAD-005 → COMPAT-CAD-006 → COMPAT-CAD-007 → COMPAT-CAD-008 → COMPAT-CAD-009 → COMPAT-CAD-010 → COMPAT-CAD-011 → COMPAT-CAD-012 → COMPAT-CAD-013 → COMPAT-CAD-014 → COMPAT-CAD-015 → COMPAT-CAD-016 → COMPAT-CAD-017 → COMPAT-CAD-018 → COMPAT-CAD-019 → COMPAT-CAD-020 → COMPAT-CAD-021 → CAD-CERT-001`

Successor selection remains governed by `docs/cad/autocad-parity-roadmap.md`. CC009 is planned but blocked until CC008 is independently verified.

## Required handoff

Before marking CC008 VERIFIED, bind the exact deployed revision and browser evidence to the physical merge `3854f5391fe58475b50bec9b33e695c33dabc467`. Only then update the canonical governance record, authoritative roadmap and successor implementation prompt.

Architecture v1.1 remains frozen. No implementation work may bypass the ACR boundary.