# ConstructionOS Dependency Graph

**Architecture version:** 1.0

The graph is intentionally clone-first. Downstream intelligence work depends on the professional application and shared-data foundation proving viable.

**Authoritative source:** the `Dependencies:` field of each work item in `work-items.md`. This file is a human-readable execution graph and wave plan derived from those fields. A dependency change must be made in `work-items.md` first and then reflected here.

## 1. Graph invariants

- Every work item in `work-items.md` appears in the node index below.
- Every declared work-item dependency resolves to another work item.
- The dependency graph must remain acyclic.
- Downstream implementation cannot begin until all dependencies are `VERIFIED`.
- Requirement IDs such as `RFQ-005` or `TIME-004` are **not** dependency nodes unless they also exist as work items.

## 2. Dependency adjacency list

- `LICENSE-001` — Open-source composition and licensing gate — depends on: none
- `ARCH-WF-001` — Initialize repository and spec discipline — depends on: none
- `ARCH-WF-002` — Establish CI verification baseline — depends on: ARCH-WF-001
- `RESEARCH-CAD-001` — Evaluate CAD/BIM engine candidates — depends on: ARCH-WF-001
- `RESEARCH-CAD-002` — IFC/openBIM fidelity benchmark — depends on: RESEARCH-CAD-001
- `RESEARCH-CAD-003` — CAD-to-Construction-Graph prototype — depends on: RESEARCH-CAD-001
- `RESEARCH-CAD-004` — CAD-to-quantity prototype — depends on: RESEARCH-CAD-003
- `RESEARCH-CAD-005` — Quantity-to-RFQ propagation prototype — depends on: RESEARCH-CAD-004
- `RESEARCH-CAD-006` — CAD/BIM performance and file-size gate — depends on: RESEARCH-CAD-001
- `RESEARCH-CAD-007` — CAD/BIM compatibility architecture decision — depends on: RESEARCH-CAD-002, RESEARCH-CAD-005, RESEARCH-CAD-006, LICENSE-001
- `COMPAT-CAD-001` — Build core 2D drafting workflow — depends on: RESEARCH-CAD-007
- `COMPAT-BIM-001` — Build core parametric BIM workflow — depends on: RESEARCH-CAD-007, COMPAT-CAD-001
- `COMPAT-IFC-001` — Production IFC/openBIM boundary — depends on: COMPAT-BIM-001
- `RESEARCH-PM-001` — Evaluate project engine candidates — depends on: ARCH-WF-001, LICENSE-001
- `RESEARCH-PM-002` — Scheduling/graph integration prototype — depends on: RESEARCH-PM-001
- `COMPAT-PM-001` — Implement construction project baseline — depends on: RESEARCH-PM-002
- `COMPAT-PM-002` — Resource and progress workflows — depends on: COMPAT-PM-001
- `RESEARCH-OFFICE-001` — Extract GenOffice compatibility patterns — depends on: LICENSE-001
- `COMPAT-SHEET-001` — Sheets baseline — depends on: RESEARCH-OFFICE-001, GRAPH-001
- `COMPAT-DOC-001` — Docs baseline — depends on: RESEARCH-OFFICE-001
- `COMPAT-OFFICE-001` — Slides/PDF baseline — depends on: RESEARCH-OFFICE-001
- `PLATFORM-001` — Core modular-monolith foundation — depends on: ARCH-WF-002, RESEARCH-CAD-007, RESEARCH-PM-001
- `PLATFORM-002` — Identity and tenant isolation — depends on: PLATFORM-001
- `PLATFORM-003` — Persistence and artifact storage — depends on: PLATFORM-001
- `PLATFORM-004` — Versioning, lineage and audit — depends on: PLATFORM-003
- `PLATFORM-005` — Event bus and domain event contracts — depends on: PLATFORM-004
- `PLATFORM-006` — Unified application shell — depends on: PLATFORM-002, COMPAT-SHEET-001, COMPAT-DOC-001, COMPAT-CAD-001, COMPAT-PM-001
- `GRAPH-001` — Canonical domain model — depends on: PLATFORM-004
- `COLLAB-001` — Collaboration foundation — depends on: PLATFORM-005, PLATFORM-002
- `COLLAB-002` — Collaborative Docs/Sheets editing — depends on: COLLAB-001, COMPAT-SHEET-001, COMPAT-DOC-001
- `COLLAB-003` — Transactional BIM/Estimate/RFQ collaboration — depends on: GRAPH-001, COLLAB-001
- `AI-001` — AI Gateway — depends on: PLATFORM-001, PLATFORM-002
- `AI-002` — OpenRouter adapter and routing — depends on: AI-001
- `AI-003` — Direct provider adapters and local model interface — depends on: AI-001
- `AI-004` — Agent runtime and tool contracts — depends on: AI-001, PLATFORM-005
- `AI-005` — Model evaluation ledger — depends on: AI-002, AI-003, KNOW-001
- `TOOL-001` — Universal capability registry — depends on: AI-004, EXT-001
- `KNOW-001` — Knowledge/evidence foundation — depends on: PLATFORM-004
- `UNKNOWN-001` — Unknown Resolution Engine — depends on: KNOW-001, AI-004
- `UNKNOWN-002` — Value-of-information recommendations — depends on: UNKNOWN-001, LAB-001
- `COST-001` — Quantity and estimate service — depends on: GRAPH-001, RESEARCH-CAD-004, COMPAT-SHEET-001
- `COST-002` — Probabilistic cost/risk engine — depends on: COST-001, UNKNOWN-001
- `RFQ-001` — RFQ scope engine — depends on: COST-001, PLATFORM-005
- `RFQ-002` — External subcontractor participation — depends on: PLATFORM-002, RFQ-001, COMPAT-SHEET-001
- `RFQ-003` — Bid normalization/leveling — depends on: RFQ-002, AI-004
- `RFQ-004` — Subcontractor performance intelligence — depends on: RFQ-003, LAB-002
- `BID-001` — Tender mechanism analyzer — depends on: KNOW-001, COST-002
- `BID-002` — Win probability model — depends on: BID-001, TIME-002
- `BID-003` — Risk-adjusted bid optimizer — depends on: BID-002, COST-002
- `TIME-001` — Temporal data store and historical replay — depends on: PLATFORM-004, KNOW-001
- `TIME-002` — Walk-forward/backtest engine — depends on: TIME-001
- `LAB-001` — Construction Lab foundation — depends on: TIME-002, AI-005, COST-002, BID-002
- `LAB-002` — Prediction ledger and calibration — depends on: LAB-001
- `INTEL-001` — Junior Professional Mode — depends on: UNKNOWN-002, RFQ-001, AI-004
- `INTEL-002` — Design alternative analysis — depends on: COST-002, TOOL-001
- `INTEL-003` — Construction copilot — depends on: COMPAT-PM-002, KNOW-001, AI-004
- `INTEL-004` — Condition assessment — depends on: GRAPH-001, UNKNOWN-001, TOOL-001
- `INTEL-005` — Lifecycle maintenance optimization — depends on: INTEL-004, COST-002, LAB-002
- `EXT-001` — Extension SDK — depends on: GRAPH-001, PLATFORM-002
- `EXT-002` — Extension sandbox/security — depends on: EXT-001, PLATFORM-002
- `API-001` — Public domain API — depends on: GRAPH-001, PLATFORM-002
- `API-002` — Webhooks, async jobs and SDKs — depends on: API-001, PLATFORM-005
- `BENCH-001` — End-to-end tender benchmark — depends on: COMPAT-IFC-001, COST-002, RFQ-004, BID-003
- `BENCH-002` — End-to-end building diagnosis benchmark — depends on: INTEL-005, LAB-002

## 3. Development waves

### Wave 0 — Repository/process foundation

`ARCH-WF-001, ARCH-WF-002, LICENSE-001`

### Wave 1 — Existential clone gates

`RESEARCH-CAD-001, RESEARCH-PM-001, RESEARCH-OFFICE-001`

### Wave 2 — Deep compatibility proof

`RESEARCH-CAD-002, RESEARCH-CAD-003, RESEARCH-CAD-004, RESEARCH-CAD-005, RESEARCH-CAD-006, RESEARCH-CAD-007, RESEARCH-PM-002`

### Wave 3 — First application implementations

`COMPAT-CAD-001, COMPAT-BIM-001, COMPAT-IFC-001, COMPAT-PM-001, COMPAT-PM-002, COMPAT-SHEET-001, COMPAT-DOC-001, COMPAT-OFFICE-001`

### Wave 4 — Platform and shared-data foundation

`PLATFORM-001, PLATFORM-002, PLATFORM-003, PLATFORM-004, PLATFORM-005, PLATFORM-006, GRAPH-001, COLLAB-001, COLLAB-002, COLLAB-003`

### Wave 5 — Intelligence substrate

`AI-001, AI-002, AI-003, AI-004, AI-005, EXT-001, EXT-002, TOOL-001, KNOW-001, UNKNOWN-001, UNKNOWN-002, TIME-001, TIME-002`

### Wave 6 — Commercial intelligence

`COST-001, COST-002, RFQ-001, RFQ-002, RFQ-003, RFQ-004, BID-001, BID-002, BID-003, LAB-001, LAB-002`

### Wave 7 — Domain intelligence

`INTEL-001, INTEL-002, INTEL-003, INTEL-004, INTEL-005`

### Wave 8 — Public platform and final benchmarks

`API-001, API-002, BENCH-001, BENCH-002`

## 4. Parallelism rules

Independent research/compatibility work may proceed in parallel only if it shares no mutable implementation boundary and does not assume an unresolved architecture decision.

CAD/BIM and Project research may proceed in parallel.

Office compatibility may proceed in parallel with CAD research after `LICENSE-001` is verified.

Cost/RFQ implementation must not begin before the canonical graph and quantity contracts are accepted.

Bid intelligence must not begin before cost and temporal replay foundations are accepted.

## 5. Blocking conditions

A downstream work item is blocked if:

- its required architecture contract is unresolved;
- a dependency is not `VERIFIED`;
- a required compatibility gate failed;
- security/licensing review is unresolved where relevant;
- required acceptance criteria are ambiguous.
