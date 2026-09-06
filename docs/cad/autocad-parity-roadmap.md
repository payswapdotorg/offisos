# Offisos AutoCAD Product Roadmap — Authoritative CAD Parity Program

**Status:** ACTIVE  
**Architecture:** ConstructionOS Architecture v1.1 — FROZEN  
**Latest fully verified product main:** `3854f5391fe58475b50bec9b33e695c33dabc467` (COMPAT-CAD-008; browser-verified after terminal post-merge CI)  
**Current product merge under post-merge verification:** `066be5fc098443e21263ed57d21788849a875195` (COMPAT-CAD-009)  
**Latest governance bookkeeping commit:** `28c3acabd3f47d6a9e233e8dc6f3348c97caabd6`  
**Latest verified infrastructure foundation:** **INFRA-002** — merge `f3d8a02f7c739c77ddfaa5aea93466aab3230fc0`, verified by Architect at `d436fa72080782e6506715e656757e09acfd2348`  
**Current product benchmark baseline:** CAD-BENCH-RW-001 — **18/100** at product revision `f4a1a735dfbfa58d9b24197ffc1808d4cdf84db6`  
**Current active execution:** **COMPAT-CAD-009** — **MERGED; post-merge verification pending**  
**Current successor preparation:** **COMPAT-CAD-010** — **PLANNED; not legally released**  
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
| 4 | **COMPAT-CAD-008** | Arrays/materialization/render/selectability | G3/G5/G6/G7 | **VERIFIED — merge 3854f539** |
| 5 | COMPAT-CAD-009 | Blocks/inserts/attributes/symbols | G5/G7/G8 | **MERGED — post-merge verification pending** |
| 6 | COMPAT-CAD-010 | Hatch/annotation/dimension/inspection | G1/G4/G6/G8 | **PLANNED — successor not released** |
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

The known deployed serverless multi-instance/session divergence remains explicitly deferred to COMPAT-CAD-011 and is not claimed fixed. The permanent benchmark score remains 18/100 pending the complete corpus rerun.

## 11. Completed phase — COMPAT-CAD-007

**GitHub Issue:** #1  
**Pull request:** #3  
**Merge:** `9232c90e4340475bcf5c6818a30d9748ea04330a`  
**Governance record:** `governance/work-items/COMPAT-CAD-007.json`  
**Result:** **VERIFIED**

CC007 delivered deterministic core editing and object-selection workflows over the verified viewport foundation. The permanent benchmark score remained **18/100** because no full benchmark rerun was performed.

## 12. Completed phase — COMPAT-CAD-008

**GitHub Issue:** #5  
**Pull request:** #11  
**Implementation merge:** `3854f5391fe58475b50bec9b33e695c33dabc467`  
**Browser-gate remediation PR:** #12  
**Browser-gate tooling merge:** `c2ef91811cfc7d9369c639dd9233b50bc0b49c11`  
**Governance record:** `governance/work-items/COMPAT-CAD-008.json`  
**Result:** **VERIFIED**

CC008 delivered bounded deterministic ARRAY behavior within frozen Architecture v1.1, including rectangular/polar semantics, canonical materialized members with provenance, deterministic identities/order, source/member deletion policy, undo/redo, rendering/selectability, typed unsupported Path behavior, and Web/Electron shared semantic execution.

Post-merge certification evidence includes exact post-merge CI run `34009858133` at product merge `3854f539`, independent exact-target browser gate run `34017125800` with artifact `9984273561`, and governance validation run `34017125782` at governance main `c2ef918` with 588/588 validation and verified-revision drift checks. The browser evidence exercised G3/G5/G6/G7, DEF-015 one-by-one no-op, typed unsupported Path handling and visible undo/redo; the agent used only the visible workspace and made no `/api/cad` calls.

The product benchmark score remains **18/100** because no full CAD-BENCH-RW-001 rerun was performed. No benchmark score increase is claimed.

## 13. Active phase — COMPAT-CAD-009

**GitHub Issue:** #13  
**Pull request:** #14  
**Predecessor:** COMPAT-CAD-008  
**Implementation revision approved before merge:** `463344ba095bd700fb96f46f4164f333977a85cc`  
**Physical product merge:** `066be5fc098443e21263ed57d21788849a875195`  
**Status:** **MERGED — POST-MERGE VERIFICATION PENDING**  
**Governance record:** `governance/work-items/COMPAT-CAD-009.json`  
**Implementation prompt:** `docs/work-items/COMPAT-CAD-009-ZAI-PROMPT.md`

CC009 owns the next bounded AutoCAD-class capability: **blocks, inserts, attributes and symbols**, with canonical identity/provenance, materialization/ownership policy, selection/render integration, deterministic serialization/order, undo/redo, command semantics, and Web/Electron parity. The implementation closed DEC-001 remediation requirements and was approved at exact PR head `463344ba` after exact-head CI and independent G5/G7/G8 browser evidence passed.

The authoritative merge is `066be5fc`. The required post-merge exact-revision CI and browser-gate workflows are still queued/in progress. Therefore the Architect has intentionally **not** advanced CC009 to `VERIFIED` and has not released CC010. The benchmark remains 18/100.

## 14. Defect retirement matrix

| Defects | Primary phase |
|---|---|
| DEF-001/002/003/008/014/027 | COMPAT-CAD-005 |
| DEF-004/005 | COMPAT-CAD-006 — targeted behavior VERIFIED |
| DEF-006/007/021 | COMPAT-CAD-007 / 014 |
| **DEF-015** | **COMPAT-CAD-008 — verified** |
| DEF-013/016 | COMPAT-CAD-009 / 016 |
| DEF-023/022 | COMPAT-CAD-010 |
| DEF-009/010 | COMPAT-CAD-011 |
| DEF-011/012 | COMPAT-CAD-012 |
| DEF-018 | COMPAT-CAD-013 |
| DEF-019/026 | COMPAT-CAD-015 / 019 |
| DEF-017 | COMPAT-CAD-016 / 020 |
| DEF-020 | COMPAT-CAD-014 / 021 |
| DEF-025 | COMPAT-CAD-016 |

## 15. Relationship to the broader ConstructionOS roadmap

The CAD parity program remains a bounded product track within frozen ConstructionOS Architecture v1.1. Infrastructure work may proceed on its separate dependency graph; it does not silently alter CAD sequencing. The serverless persistence/session problem remains explicitly owned by the infrastructure/persistence workstream and COMPAT-CAD-011.

## 16. Verified infrastructure milestone — INFRA-002

**GitHub Issue:** #2  
**Pull request:** #4  
**Merge:** `f3d8a02f7c739c77ddfaa5aea93466aab3230fc0`  
**Architect verification finalization:** `d436fa72080782e6506715e656757e09acfd2348`  
**Result:** **VERIFIED**

INFRA-002 is infrastructure-track completion and does **not** change the CAD benchmark score or the legal dependency sequence for COMPAT-CAD-009.
