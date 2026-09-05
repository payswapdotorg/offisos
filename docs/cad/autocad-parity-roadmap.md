# Offisos AutoCAD Product Roadmap — Authoritative CAD Parity Program

**Status:** ACTIVE  
**Architecture:** ConstructionOS Architecture v1.1 — FROZEN  
**Latest verified product main:** `9232c90e4340475bcf5c6818a30d9748ea04330a` (COMPAT-CAD-007; verified after terminal post-merge workflow fan-out)  
**Latest verified infrastructure foundation:** **INFRA-002** — merge `f3d8a02f7c739c77ddfaa5aea93466aab3230fc0`, verified by Architect at `d436fa72080782e6506715e656757e09acfd2348`  
**Current product benchmark baseline:** CAD-BENCH-RW-001 — **18/100** at product revision `f4a1a735dfbfa58d9b24197ffc1808d4cdf84db6`  
**Current active execution:** **COMPAT-CAD-008** — GitHub Issue **#5**, governance state **ASSIGNED**  
**Current successor preparation:** **COMPAT-CAD-009** — **PLANNED**  
**Verification instrument:** independent browser-agent black-box testing against an exact-head deployment  
**Autonomous return protocol:** `docs/governance/architect-return-protocol.md`

> This document is the authoritative roadmap for the AutoCAD-class product improvement program. Chat discussion is not authoritative.

## 1. Purpose and certification target

A phase is complete only when the intended user workflows work end-to-end and survive deterministic and independent black-box verification. The final program target is **100/100** across the benchmark capability set, with the 25-project corpus, Golden 10, persistence/interoperability round-trips, Web/Electron parity, long-session reliability and no known critical regression.

The observed benchmark baseline remains **18/100**. No score increase is claimed from implementation coverage alone; score changes require an observed benchmark rerun.

## 2. Non-negotiable execution loop

```text
FROZEN SCOPE
  → IMPLEMENTATION WORKER
  → DETERMINISTIC TESTS + CI
  → PR_OPEN / VERIFYING
  → AUTONOMOUS ARCHITECT RETURN PROTOCOL
  → ARCHITECT REVIEW
  → APPROVED → MERGED
  → POST-MERGE CI + EXACT REVISION CHECK
  → EXACT-HEAD DEPLOYMENT
  → INDEPENDENT BROWSER-AGENT BLACK-BOX REGRESSION
  → COMPARE AGAINST BASELINE
  → VERIFIED
  → ROADMAP + GOVERNANCE UPDATE
  → NEXT WORK ITEM + REPOSITORY IMPLEMENTATION PROMPT
  → NEXT WORKER
```

Failures follow the same loop through an exact finding, legal remediation transition and repository-backed prompt. The Architect does not pause between routine gates for `next`, `go`, `continue`, or equivalent input.

## 3. Evidence rule

Every work item must contain revision-bound evidence sufficient for a fresh Architect to determine implementation revision, CI, deployment, browser workflows, expected/observed behavior, regressions, score impact, newly discovered defects and successor readiness. Screenshots or narrative claims alone do not establish `VERIFIED`.

## 4. Permanent benchmark assets

| ID | Workflow | Primary capabilities | Defects |
|---|---|---|---|
| G1 | Single-family floor plan | layers, geometry, offset, dimensions, text, save | DEF-001/002/003/004/010 |
| G2 | Real-scale site plan | large extents, navigation, polylines, dimensions | DEF-004/005 |
| G3 | Parking layout | arrays, repetition, dimensions | DEF-015 |
| G4 | Precision quadrilateral exercise | relative/polar coordinates, trim, closure | DEF-006 |
| G5 | RCP with fixture blocks | blocks, inserts, attributes, arrays | DEF-013/006 |
| G6 | Wall section detail | hatch, layers, linetypes, detail dimensions | DEF-023/001 |
| G7 | HVAC/BIM workflow | story, walls, host selection, BIM editing | DEF-016/017/003 |
| G8 | Title-block sheet with viewports | layouts, title blocks, viewports, export | DEF-018 |
| G9 | Save/reload/DXF round-trip | persistence, interoperability, integrity | DEF-009/010/011/012 |
| G10 | Long-session + undo/redo | history, cancellation, stability | DEF-014/019/024/026 |

The full 25-project CAD-BENCH-RW-001 corpus remains mandatory and may not be silently reduced.

## 5. Authoritative work-item sequence

| Seq. | Work item | Outcome | Browser gate | Status |
|---:|---|---|---|---|
| 0 | CAD-BENCH-RW-001 | Empirical baseline | Full corpus | **BASELINED — 18/100** |
| 1 | COMPAT-CAD-005 | Canonical drafting state | G1/G3/G5/G7/G8/G9/G10 | **VERIFIED** |
| 2 | COMPAT-CAD-006 | Viewport clipping, zoom, pan, regen, transforms | G1/G2/G3 | **VERIFIED** |
| 3 | **COMPAT-CAD-007** | Core editing and deterministic object selection | G1/G2/G4/G10 | **VERIFIED** |
| 4 | **COMPAT-CAD-008** | Arrays/materialization/render/selectability | G3/G5/G6/G7 | **ASSIGNED — IMPLEMENTATION AUTHORIZED** |
| 5 | COMPAT-CAD-009 | Blocks/inserts/attributes/symbols | G5/G7/G8 | **PLANNED** |
| 6 | COMPAT-CAD-010 | Hatch/annotation/dimension/inspection | G1/G4/G6/G8 | **PLANNED** |
| 7 | COMPAT-CAD-011 | Durable SAVE/OPEN/reload | G9 + restart/recovery | **PLANNED** |
| 8 | COMPAT-CAD-012 | DXF import/export | G9 | **PLANNED** |
| 9 | COMPAT-CAD-013 | Layout identity/MVIEW/sheets/plot | G8 | **PLANNED** |
| 10 | COMPAT-CAD-014 | Command language/options/aliases/help | G1–G10 | **PLANNED** |
| 11 | COMPAT-CAD-015 | Undo/redo/cancellation/long-session | G10 | **PLANNED** |
| 12 | COMPAT-CAD-016 | BIM completion | G7 | **PLANNED** |
| 13 | COMPAT-CAD-017 | Schedules/tables/quantities/docs | G5/G7/G8 | **PLANNED** |
| 14 | COMPAT-CAD-018 | OSNAP/OTRACK/tracking/measurement | G1/G2/G4/G6 | **PLANNED** |
| 15 | COMPAT-CAD-019 | Scale/performance/robustness | stress corpus + G10 | **PLANNED** |
| 16 | COMPAT-CAD-020 | DXF/IFC/DWG interop matrix | external corpus | **PLANNED** |
| 17 | COMPAT-CAD-021 | Professional UI/workspace completion | Golden 10 UI-only | **PLANNED** |
| 18 | CAD-CERT-001 | Independent parity certification | P01–P25 + Golden 10 | **PLANNED** |

Logical dependencies remain: `005 → 006 → 007 → 008 → 009`, with `007 → 010`; the persistence and layout/command/history tracks remain separately sequenced as shown above. Exact legal release state comes from `governance/work-items/`.

## 6. Phase completion contract

A phase is not complete until scope, deterministic tests, exact-head CI, affected regressions, exact deployment, independent browser verification, golden workflows, prior-defect preservation and defect disposition all pass and the Architect verifies the governance record. The roadmap and next handoff are then updated on mainline.

## 7. Browser-agent protocol

The browser agent behaves as a real user through visible UI, command line, ribbon, palettes and canvas. It uses an exact-head deployment, avoids hidden APIs for the behavior under test, records exact actions/outputs/visual state, includes negative/error paths, and produces machine-readable plus auditable evidence.

## 8. Scoring and anti-gaming

The benchmark scale remains 0–5 per capability. The normalized program target remains 100/100. No rubric changes are allowed after failures. Tests alone do not increase the benchmark score.

**Current permanent score: 18/100.**

## 9. Successor-selection rule

After every verified work item the Architect records: exact verified revision/evidence, measured score/category changes, retired/new defects, next authorized work item, dependency/scope changes, next browser gate, and the repository-backed implementation prompt. No successor is authorized solely by chat.

## 10. Completed phase — COMPAT-CAD-006

**Issue:** #138  
**Merge:** `eb3406340df08d1ab39e771c40681d6248840d2e`  
**Implementation revision:** `6a93a71c7d6ec144f3c9ab8b9db7c131117ef98e`  
**Governance finalization:** main `695f04f98fe88604a8f113ba72ae69efcc4857ac`  
**Result:** **VERIFIED**

Delivered and verified: deterministic partial clipping; stable ZOOM/window-zoom; deterministic PAN; REGEN without CADDocument mutation; the single shared Web/Electron screen↔world transform module; preservation of COMPAT-CAD-005 canonical layer/selection/commit-authority behavior; G1/G2/G3 browser evidence; deterministic negative no-mutation probes; Web/Electron parity.

Evidence included 34 targeted deterministic tests, a full app suite of 1426 tests with 0 failures and 56 OCCT-gated skips, Electron 12/12 real-UI navigation smoke, Web/regression smokes, and exact-head Vercel preview/browser verification. The known deployed serverless multi-instance/session divergence remains explicitly deferred to COMPAT-CAD-011 and is not claimed fixed.

**Retired by this phase:** DEF-004 and DEF-005 are accepted as resolved for the targeted clipping/navigation behavior based on the phase evidence. The permanent benchmark score remains 18/100 pending the complete corpus rerun.

## 11. Completed phase — COMPAT-CAD-007

**GitHub Issue:** #1  
**Pull request:** #3  
**Merge:** `9232c90e4340475bcf5c6818a30d9748ea04330a`  
**Governance record:** `governance/work-items/COMPAT-CAD-007.json`  
**Result:** **VERIFIED**

CC007 delivered deterministic core editing and object-selection workflows over the verified viewport foundation. Exact implementation-head evidence included 1459 tests with 1414 pass, 0 fail and 45 skipped; Web/Electron host smokes; exact-head deployment; and independent browser G1/G2/G4/G10 plus DEF-006/007/021 probes with zero console errors. At physical merge head `9232c90`, all 30 post-merge workflow runs were terminal, with 29 success and one governance-only failure caused by the historical malformed CC007 governance record; the record was subsequently repaired without any product implementation delta.

Root governance is now green after migration-safe record normalization and a verified-revision audit correction: the latest deterministic governance run passed all governance checks, including work-item schema/state validation, issue migration uniqueness, and verified-revision drift validation. The historical issue-number collisions introduced by fork migration are represented explicitly in `governance/issue-migrations.json` rather than weakening the uniqueness invariant.

**Result:** CC007 is VERIFIED. Issue #1 is closed as completed. The permanent benchmark score remains **18/100** because no full benchmark rerun has been performed.

## 12. Active phase — COMPAT-CAD-008

**Issue:** #5  
**Predecessor:** COMPAT-CAD-007  
**Status:** **ASSIGNED — IMPLEMENTATION AUTHORIZED**  
**Governance record:** `governance/work-items/COMPAT-CAD-008.json`  
**Implementation prompt:** `docs/work-items/COMPAT-CAD-008-ZAI-PROMPT.md`

CC008 owns **DEF-015** and the bounded ARRAY capability: deterministic rectangular/polar array semantics, materialized canonical members, rendering/selectability, stable identities and ordering, undo/redo, invalid/unsupported behavior, and Web/Electron parity. Supported modes and their negative/unsupported boundaries must remain explicit; no feature outside the frozen work item may be opportunistically added.

The preparation-only constraint has now been lifted because COMPAT-CAD-007 is VERIFIED. `z-ai-implementation-agent` is authorized to convert the existing preparation branch/work into the frozen implementation, with the mandatory stop at PR_OPEN/VERIFYING. No PR, merge or verification is implied by this authorization.

## 13. Defect retirement matrix

| Defects | Primary phase |
|---|---|
| DEF-001/002/003/008/014/027 | COMPAT-CAD-005 |
| **DEF-004/005** | **COMPAT-CAD-006 — targeted behavior VERIFIED** |
| DEF-006/007/021 | COMPAT-CAD-007 / 014 |
| DEF-015 | COMPAT-CAD-008 |
| DEF-013/016 | COMPAT-CAD-009 / 016 |
| DEF-023/022 | COMPAT-CAD-010 |
| DEF-009/010 | COMPAT-CAD-011 |
| DEF-011/012 | COMPAT-CAD-012 |
| DEF-018 | COMPAT-CAD-013 |
| DEF-019/026 | COMPAT-CAD-015 / 019 |
| DEF-017 | COMPAT-CAD-016 / 020 |
| DEF-020 | COMPAT-CAD-014 / 021 |
| DEF-025 | COMPAT-CAD-016 |

Historical governance migration debt repaired: source issue-number reuse is now represented by explicit migrations in `governance/issue-migrations.json`, while current fork issue ownership remains unique. The earlier CAD-PARITY-020 missing-dependencies defect is also repaired and schema-valid.

## 14. Relationship to the broader ConstructionOS roadmap

The CAD parity program remains a bounded product track within frozen ConstructionOS Architecture v1.1. Infrastructure work may proceed on its separate dependency graph; it does not silently alter CAD sequencing. The serverless persistence/session problem remains explicitly owned by the infrastructure/persistence workstream and COMPAT-CAD-011.

## 15. Verified infrastructure milestone — INFRA-002

**GitHub Issue:** #2  
**Pull request:** #4  
**Merge:** `f3d8a02f7c739c77ddfaa5aea93466aab3230fc0`  
**Architect verification finalization:** `d436fa72080782e6506715e656757e09acfd2348`  
**Result:** **VERIFIED**

INFRA-002 delivered the authoritative Neon/PostgreSQL DocumentStore foundation with deterministic memory and PostgreSQL backends, cross-backend byte-identity fixtures, deterministic CAS/idempotency behavior, fail-closed corruption handling, and real-PostgreSQL CI. The final exact-head `infra-002` workflow run `33974833492` completed successfully for both workspace and real-PostgreSQL jobs. The governance record is now schema-normalized, and the root governance migration work isolates historical record debt from INFRA-002 implementation validity.

INFRA-002 is infrastructure-track completion and does **not** change the CAD benchmark score or the legal dependency sequence for COMPAT-CAD-007/008.
