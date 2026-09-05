# Offisos AutoCAD Product Roadmap — Authoritative CAD Parity Program

**Status:** ACTIVE  
**Architecture:** ConstructionOS Architecture v1.1 — FROZEN  
**Latest verified product main:** `74d1b39578916f1915674e20d215bde79d1c10cd` (COMPAT-CAD-005 merge)  
**Current product benchmark baseline:** CAD-BENCH-RW-001 — 18/100 at product revision `f4a1a735dfbfa58d9b24197ffc1808d4cdf84db6`  
**Current active work item:** `COMPAT-CAD-006` — GitHub Issue #138  
**Current implementation status:** `ASSIGNED`  
**Current implementation stop gate:** `PR_OPEN / VERIFYING`  
**Primary verification instrument:** independent browser-agent black-box testing against the deployed application  
**Autonomous return protocol:** `docs/governance/architect-return-protocol.md`

> This document is the authoritative roadmap for the AutoCAD-class product improvement program. It is the repository source of truth for CAD parity sequencing, phase gates, score tracking, and successor selection. Chat discussion is not authoritative.

## 1. Purpose and certification target

The product target is not a command-count target. A phase is complete only when the intended user workflows work end-to-end and the result survives independent black-box browser testing.

The final target is **100/100**, meaning:

1. all 14 benchmark capability categories reach production-grade behavior;
2. the 25-project benchmark corpus is completable to a usable professional result;
3. the permanent Golden 10 regression set is at least 4/5 in every workflow, with 5/5 as the target;
4. no known BLOCKER or MAJOR workflow defect remains;
5. save/reload and supported interoperability round-trips are proven;
6. Web/Electron semantic parity is proven where applicable;
7. long-session reliability is proven;
8. the independent browser-agent benchmark reproduces no known critical regression.

Current observed baseline is **18/100**, with 27 root defects from CAD-BENCH-RW-001. See `docs/cad/autocad-real-world-benchmark.md` and `docs/cad/autocad-benchmark-corpus.json`.

## 2. Non-negotiable execution loop

Every roadmap work item follows this loop. There are no exceptions for apparently small fixes.

```text
FROZEN SCOPE
    ↓
IMPLEMENTATION WORKER
    ↓
DETERMINISTIC TESTS + CI
    ↓
WORKER RETURNS PR_OPEN / VERIFYING
    ↓
AUTONOMOUS ARCHITECT RETURN PROTOCOL
    ↓
ARCHITECT REVIEW
    ↓
APPROVED → MERGED
    ↓
POST-MERGE CI + EXACT REVISION CHECK
    ↓
EXACT-HEAD DEPLOYMENT
    ↓
INDEPENDENT BROWSER-AGENT BLACK-BOX REGRESSION
    ↓
COMPARE AGAINST PREVIOUS BASELINE
    ↓
VERIFIED
    ↓
ROADMAP + GOVERNANCE UPDATE
    ↓
NEXT WORK ITEM + REPOSITORY IMPLEMENTATION PROMPT
    ↓
NEXT WORKER
```

A failure follows the same autonomous path until the Architect reaches a terminal handoff:

```text
BROWSER / REVIEW FAILURE
    ↓
EXACT FINDING + EVIDENCE
    ↓
LEGAL REMEDIATION TRANSITION
    ↓
REPOSITORY-BACKED REMEDIATION PROMPT
    ↓
WORKER
```

The browser test is a release gate, not merely a final certification activity. The Architect does not stop between routine gates to request `next`, `go`, `continue`, or equivalent user input. See `docs/governance/architect-return-protocol.md`.

## 3. Evidence rule

For each work item, the repository must contain enough revision-bound evidence for a fresh Architect to determine:

- exact implementation revision and deployment;
- exact browser-agent workflows executed;
- expected behavior;
- observed behavior;
- pass/fail result for each affected golden workflow;
- regression result for previously fixed defects;
- score before and after;
- any newly discovered defects;
- whether the successor phase may legally be released.

Narrative claims or screenshots alone do not establish `VERIFIED`. Browser screenshots may be supporting evidence, but qualifying verification also requires reproducible automated/revision-bound evidence under the governance evidence policy.

## 4. Permanent benchmark assets

### Golden benchmark set

| ID | Workflow | Primary capabilities | Existing defect coverage |
|---|---|---|---|
| G1 | Single-family floor plan | layers, wall/line geometry, offset, dimensions, text, save | DEF-001/002/003/004/010 |
| G2 | Real-scale site plan | large extents, navigation, polylines, dimensions | DEF-004/005 |
| G3 | Parking layout | arrays, repetition, dimensions | DEF-015 |
| G4 | Precision quadrilateral exercise | relative/polar coordinates, trim, closure | DEF-006 |
| G5 | RCP with fixture blocks | block, insert, attributes, arrays | DEF-013/006 |
| G6 | Wall section detail | hatch, layers, linetypes, detail dimensions | DEF-023/001 |
| G7 | HVAC/BIM workflow | story, walls, host selection, BIM editing | DEF-016/017/003 |
| G8 | Title-block sheet with viewports | layouts, viewports, title blocks, sheet export | DEF-018 |
| G9 | Save/reload/DXF round-trip | persistence, import/export, state integrity | DEF-009/010/011/012 |
| G10 | Long-session + undo/redo | history, cancellation, stability, state integrity | DEF-014/019/024/026 |

### Full corpus

The 25-project corpus in `CAD-BENCH-RW-001` remains the broader release benchmark. Work items may add new projects or probes, but may not silently remove existing benchmark coverage.

## 5. Authoritative work-item sequence

This sequence is dependency-ordered. A successor work item must not be released until its predecessor has been `VERIFIED`, unless an explicit Architect decision records a dependency change.

| Sequence | Work item | Phase outcome | Browser gate | Status |
|---:|---|---|---|---|
| 0 | CAD-BENCH-RW-001 | Establish empirical baseline | Full 25-project benchmark | **BASELINED — 18/100** |
| 1 | **COMPAT-CAD-005** | Canonical drafting state: layers, active layer, NEW/reset, unified selection, screen-space picking, authoritative feedback | G1/G3/G5/G7/G8/G9/G10 + targeted probes | **VERIFIED** |
| 2 | **COMPAT-CAD-006** | Viewport clipping, zoom, pan, regen, stable coordinate transforms | G1/G2/G3 + targeted navigation probes | **ASSIGNED** |
| 3 | COMPAT-CAD-007 | Core editing and deterministic object-selection workflows | G1/G2/G4/G10 | **PLANNED** |
| 4 | COMPAT-CAD-008 | Arrays and repeated geometry materialization/render/selectability | G3/G5/G6/G7 | **PLANNED** |
| 5 | COMPAT-CAD-009 | Blocks, inserts, attributes and reusable symbols | G5/G7/G8 | **PLANNED** |
| 6 | COMPAT-CAD-010 | Hatch, annotation scaling, dimension styles, leaders, inspection | G1/G4/G6/G8 | **PLANNED** |
| 7 | COMPAT-CAD-011 | Durable SAVE/OPEN/reload-safe document persistence | G9 + restart/recovery probes | **PLANNED** |
| 8 | COMPAT-CAD-012 | DXF import/export and safe failure isolation | G9 + round-trip corpus | **PLANNED** |
| 9 | COMPAT-CAD-013 | Layout identity, MVIEW, viewport scales, sheets and plot/export | G8 | **PLANNED** |
| 10 | COMPAT-CAD-014 | Command language, options, aliases, command search/help | G1–G10 command-driven paths | **PLANNED** |
| 11 | COMPAT-CAD-015 | Undo/redo, cancellation, revision integrity, long-session state machine | G10 + destructive/recovery probes | **PLANNED** |
| 12 | COMPAT-CAD-016 | BIM completion: host relationships, doors/windows and robust editing | G7 | **PLANNED** |
| 13 | COMPAT-CAD-017 | Schedules, tables, property extraction and documentation flows | G5/G7/G8 | **PLANNED** |
| 14 | COMPAT-CAD-018 | Professional precision: OSNAP, OTRACK, tracking and measurement | G1/G2/G4/G6 | **PLANNED** |
| 15 | COMPAT-CAD-019 | Large drawing scale, performance and long-session robustness | expanded stress corpus + G10 | **PLANNED** |
| 16 | COMPAT-CAD-020 | Full supported interop matrix: DXF/IFC/DWG boundary behavior | expanded external-file corpus | **PLANNED** |
| 17 | COMPAT-CAD-021 | Professional UI/discoverability/workspace completion | full Golden 10 UI-only | **PLANNED** |
| 18 | CAD-CERT-001 | Independent 25-project parity certification | P01–P25 + Golden 10 | **PLANNED** |

### Dependency graph

```text
COMPAT-CAD-005
      │
      ├──→ COMPAT-CAD-006 ──→ COMPAT-CAD-007 ──┬──→ COMPAT-CAD-008 ──→ COMPAT-CAD-009
      │                                         │                       │
      │                                         └──→ COMPAT-CAD-010 ←────┘
      │
      ├──→ COMPAT-CAD-011 ──→ COMPAT-CAD-012
      ├──→ COMPAT-CAD-013
      ├──→ COMPAT-CAD-014
      └──→ COMPAT-CAD-015

COMPAT-CAD-007 + 009 + 010
              ↓
       COMPAT-CAD-016
              ↓
       COMPAT-CAD-017

006 + 007 + 010
      ↓
COMPAT-CAD-018

007 + 011 + 012 + 013 + 015
      ↓
COMPAT-CAD-019
      ↓
COMPAT-CAD-020
      ↓
COMPAT-CAD-021
      ↓
CAD-CERT-001
      ↓
100/100
```

The graph expresses logical readiness. The exact legal release state is always determined from the governance records under `governance/work-items/`.

## 6. Phase completion contract

A work item is not complete when its code exists. It is complete when all of the following are true:

```text
[A] Scope implemented
[B] Deterministic automated tests pass
[C] Required CI is green at exact head
[D] Existing affected regressions pass
[E] Exact revision is deployed
[F] Independent browser agent executes the declared gate
[G] Golden workflows affected by the phase pass
[H] Previously fixed defects remain fixed
[I] New defects are recorded, triaged and dispositioned
[J] Architect verifies the evidence and governance record
[K] Roadmap is updated on mainline
[L] Next work-item/prompt handoff is persisted when the phase passes
```

Any item A–I may block `VERIFIED`. Item L is required before the Architect reports a successful phase as fully handed off.

## 7. Browser-agent protocol

The browser agent must behave as a real user for acceptance testing:

- interact through the visible application UI, command line, ribbon, palettes and canvas;
- use the production deployment or an exact-head deployment;
- do not use hidden application APIs to accomplish the task under test;
- may inspect browser/network/runtime diagnostics only as supporting evidence;
- record exact commands, clicks, inputs, outputs and observed visual state;
- use pixel/render evidence where visual correctness matters;
- explicitly test negative/error paths for changed behavior;
- repeat critical flows after reload and after state-reset boundaries when relevant.

Each gate should produce a machine-readable result plus human-auditable artifacts. The benchmark score must be recalculated from observed behavior, not inferred from implementation coverage.

The Architect continues immediately after the browser agent returns. A successful gate leads directly into governance closure and successor release; a failed gate leads directly into repository-backed remediation. No intermediate user prompt is required.

## 8. Scoring and anti-gaming rule

The original benchmark uses a 0–5 capability scale:

- 5 = Production parity
- 4 = Strong
- 3 = Partial
- 2 = Weak
- 1 = Token capability
- 0 = Unsupported

The roadmap's `100/100` is a product-program normalization across the benchmark categories and project workflows. It must never be achieved by changing the scoring rubric after a failure.

A work item may improve the score only when the corresponding browser evidence demonstrates user-visible improvement. Adding tests without fixing runtime behavior does not increase the score.

**Scoring note after COMPAT-CAD-005:** the targeted first-slice defects were demonstrably repaired, including layer identity/activation, NEW reset, screen-space picking, canonical selection pruning/count integrity and commit-authoritative feedback. The permanent program score remains **18/100** until the full benchmark is re-run and category scores are recalculated from observed behavior; no score increase is claimed merely from implementation coverage.

## 9. Successor-selection rule

After every verified work item, the Architect updates this file on the repository's mainline with:

1. the verified work item's state and exact revision/evidence reference;
2. the measured score and category changes;
3. defects retired;
4. defects newly discovered;
5. the next authorized work item;
6. any dependency or scope changes;
7. the next browser gate;
8. the next repository-backed implementation prompt.

No successor is authorized solely by chat agreement.

## 10. Current phase — COMPAT-CAD-006

**Issue:** #138  
**Predecessor:** COMPAT-CAD-005 — VERIFIED at merge `74d1b39578916f1915674e20d215bde79d1c10cd`  
**Objective:** restore deterministic viewport/navigation behavior exposed by CAD-BENCH-RW-001 without changing Architecture v1.1.

**Scope:**

- deterministic partial viewport clipping;
- stable ZOOM/window-zoom semantics;
- deterministic PAN semantics;
- REGEN/redraw without CADDocument mutation;
- one shared screen↔world transform contract across Web/Electron;
- preservation of COMPAT-CAD-005 canonical layer/selection/commit-authority behavior.

**Deferred to successors:** ARRAY materialization/render/selectability remains COMPAT-CAD-008; durable SAVE/OPEN/session persistence remains COMPAT-CAD-011; DXF remains COMPAT-CAD-012; layout identity remains COMPAT-CAD-013.

**Required browser gate:** G1, G2 and G3 plus targeted probes for off-viewport geometry, zoom/window-zoom, pan, regen and navigation-state non-mutation.

**Implementation stop:** `PR_OPEN/VERIFYING`.

**Authorized implementation prompt:** `docs/work-items/COMPAT-CAD-006-ZAI-PROMPT.md`.

**Assigned implementation role:** `z-ai-implementation-agent` (virtual governance role; GitHub issue assignee remains unset because that role is not a GitHub user account).

**Architect continuation:** once the worker returns this PR, follow `docs/governance/architect-return-protocol.md` without awaiting a user `next/go` message.

## 11. Defect retirement matrix

The 27 benchmark defects remain individually traceable. Primary ownership by roadmap phase:

| Defects | Primary phase |
|---|---|
| DEF-001/002/003/008/014/024/027 | COMPAT-CAD-005 |
| DEF-004/005 | COMPAT-CAD-006 |
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

### COMPAT-CAD-005 retirement finding

The Architect accepts the following targeted benchmark defects as resolved by the verified first slice based on deterministic and browser evidence: **DEF-001, DEF-002, DEF-003, DEF-006, DEF-008, DEF-014 and DEF-027**. DEF-024 was not independently re-scored and remains in the broader ownership matrix. No other defect is retired by this phase merely because a related prerequisite became usable.

A defect may be retired earlier if a predecessor phase legitimately resolves its root cause, but the change must be recorded in the relevant work-item evidence.

## 12. Relationship to the broader ConstructionOS roadmap

This CAD program is a bounded product track inside Architecture v1.1. It does not supersede ConstructionOS platform, Project, Office, Graph, collaboration or AI work.

The CAD parity program may continue in parallel with broader product work subject to dependency and resource decisions, but no CAD work item may alter the frozen architecture or create an application-local canonical data authority.

## 13. Fresh-Architect takeover procedure

A new Architect can resume deterministically by reading, in this order:

1. `AGENTS.md`
2. `AI_CONTINUATION.md`
3. `spec/architecture-lock.md`
4. `spec/development-workflow.md`
5. `docs/governance/architect-return-protocol.md`
6. this file (`docs/cad/autocad-parity-roadmap.md`)
7. `docs/cad/browser-agent-phase-gate.md`
8. `docs/cad/autocad-real-world-benchmark.md`
9. `docs/cad/autocad-benchmark-corpus.json`
10. the current active governance record in `governance/work-items/`
11. the active work item's GitHub issue and PR
12. exact-head CI and browser evidence

The Architect should then verify that the roadmap status, governance state, main SHA, deployment SHA and evidence references agree. Any disagreement is a handoff defect and must be reconciled before approving new work.

## 14. Change control

This roadmap is authoritative for sequencing, not for architecture. Architecture remains governed by `spec/architecture-lock.md` and related architecture-controlled artifacts.

Changes to the roadmap itself are allowed only through normal repository review and must state:

- what changed;
- why the dependency or sequencing changed;
- what evidence justified the change;
- which work item is now authorized.

Changing the roadmap does not authorize an architecture change. Any architecture change requires the existing ACR process.
