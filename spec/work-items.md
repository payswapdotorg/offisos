# ConstructionOS Implementation Backlog — Work Items

**Architecture version:** 1.0
**Ordering rule:** Dependency graph controls eligibility. The clone/compatibility feasibility gates are intentionally first because they are existential product risks.

## Work-item contract

Each work item contains:

- Objective
- Requirements covered
- Dependencies
- Acceptance criteria
- Required verification
- Architecture modules affected
- Expected repository areas
- Out of scope
- Evidence required
- Definition of done

An implementation agent may not expand scope by changing architecture or adding unapproved requirements.

# Phase 0 — Repository/process foundation

### LICENSE-001 — Open-source composition and licensing gate

Objective: Audit candidate upstream engines/libraries, their transitive licenses, trademarks and distribution/hosting constraints, and define approved composition boundaries.
Requirements: LICENSE-001, LICENSE-002, LICENSE-003, LICENSE-004
Dependencies: none
Acceptance criteria: every proposed upstream dependency is classified; incompatible composition paths are rejected; approved alternatives and NOTICE/source-obligation requirements are recorded.
Verification: license inventory + legal/architect review.
Out of scope: product implementation.
Evidence: dependency/license matrix and approval record.
Definition of done: downstream compatibility work has an approved legal/composition boundary.

### ARCH-WF-001 — Initialize repository and spec discipline

Objective: Establish repo structure and adopt the WorkflowOS-derived spec/change-control conventions.
Requirements: PLAT-001, FLOW-001, FLOW-004
Dependencies: none
Acceptance criteria: spec files are present; architecture version is explicit; work-item and verification conventions are executable/documented.
Verification: repository structure check; markdown/link validation; architecture consistency check.
Affected areas: repository root, spec, CI.
Out of scope: product feature implementation.
Evidence: CI artifact showing checks passed.
Definition of done: repo is ready to accept implementation PRs against Architecture v1.0.

### ARCH-WF-002 — Establish CI verification baseline

Objective: Create baseline lint/typecheck/unit/integration/e2e execution and artifact collection.
Requirements: PLAT-003, FLOW-002
Dependencies: ARCH-WF-001
Acceptance criteria: CI runs reproducibly; failures are attributable; evidence artifacts are retained.
Verification: intentionally failing test and recovery test.
Out of scope: domain-specific benchmarks.
Definition of done: verification pipeline is trusted enough to gate PRs.

# Phase 1 — CAD/BIM feasibility and compatibility gates

### RESEARCH-CAD-001 — Evaluate CAD/BIM engine candidates

Objective: Evaluate FreeCAD/OpenCascade/IfcOpenShell and other candidate engines against required 2D/3D/BIM workflows.
Requirements: CAD-001, CAD-002, BIM-001, BIM-002
Dependencies: ARCH-WF-001
Acceptance criteria: benchmark results for geometry, parametrics, BIM elements, performance, licensing and embeddability.
Verification: benchmark suite; source/license audit.
Out of scope: production CAD UI.
Evidence: reproducible benchmark report.
Definition of done: candidate decision or explicit architecture-change recommendation.

### RESEARCH-CAD-002 — IFC/openBIM fidelity benchmark

Objective: Establish measurable IFC import/export/round-trip thresholds.
Requirements: IFC-001, IFC-002
Dependencies: RESEARCH-CAD-001
Acceptance criteria: representative model round-trip preserves required semantics and key quantities within defined thresholds.
Verification: automated semantic diff plus expert spot review.
Out of scope: arbitrary DWG fidelity.
Definition of done: IFC compatibility contract documented.

### RESEARCH-CAD-003 — CAD-to-Construction-Graph prototype

Objective: Prove that editor elements can map deterministically to canonical BIM/Construction Graph objects.
Requirements: BIM-002, GRAPH-001, GRAPH-002
Dependencies: RESEARCH-CAD-001
Acceptance criteria: test model maps to stable element IDs and domain properties.
Verification: round-trip object identity tests.
Out of scope: full application UX.
Definition of done: mapping contract is validated.

### RESEARCH-CAD-004 — CAD-to-quantity prototype

Objective: Prove model revision → quantity revision behavior.
Requirements: QTY-001, QTY-002, CAD-INT-001
Dependencies: RESEARCH-CAD-003
Acceptance criteria: benchmark changes produce deterministic quantity deltas.
Verification: golden-model tests.
Out of scope: commercial estimating.
Definition of done: quantity service contract validated.

### RESEARCH-CAD-005 — Quantity-to-RFQ propagation prototype

Objective: Prove model → quantity → estimate → impacted RFQ propagation.
Requirements: CAD-INT-002, RFQ-001
Dependencies: RESEARCH-CAD-004
Acceptance criteria: model revision identifies affected scopes and RFQs without manual re-entry.
Verification: end-to-end test.
Out of scope: subcontractor network.
Definition of done: first killer workflow passes.

### RESEARCH-CAD-006 — CAD/BIM performance and file-size gate

Objective: Measure performance on realistic building models.
Requirements: CAD-001, BIM-001, IFC-001
Dependencies: RESEARCH-CAD-001
Acceptance criteria: thresholds are set and candidate meets minimum thresholds for pilot project size.
Verification: benchmark runs and resource telemetry.
Out of scope: global mega-model optimization.
Definition of done: candidate accepted or rejected with evidence.

### RESEARCH-CAD-007 — CAD/BIM compatibility architecture decision

Objective: Select/authorize the production foundation based on evidence and licensing audit.
Requirements: CAD-001..CAD-INT-002
Dependencies: RESEARCH-CAD-002, RESEARCH-CAD-005, RESEARCH-CAD-006, LICENSE-001
Acceptance criteria: ADR records selected foundation, adapter boundary, fallback plan and rejected alternatives.
Verification: architecture review.
Out of scope: production feature polish.
Definition of done: CAD/BIM foundation locked behind adapter contract.

### COMPAT-CAD-001 — Build core 2D drafting workflow

Objective: Implement benchmarked 2D CAD workflows.
Requirements: CAD-001
Dependencies: RESEARCH-CAD-007
Acceptance criteria: benchmark tasks meet defined completion/time/accuracy thresholds.
Verification: automated and expert benchmark.
Out of scope: advanced proprietary features not in benchmark.
Definition of done: CAD baseline passes gate.

### COMPAT-BIM-001 — Build core parametric BIM workflow

Objective: Implement benchmarked BIM element authoring/editing.
Requirements: BIM-001, BIM-002
Dependencies: RESEARCH-CAD-007, COMPAT-CAD-001
Acceptance criteria: benchmark building can be authored and edited with stable semantic identities.
Verification: golden model tests.
Out of scope: full discipline-specific design suites.
Definition of done: BIM baseline passes gate.

### COMPAT-IFC-001 — Production IFC/openBIM boundary

Objective: Implement import/export/validation contract.
Requirements: IFC-001, IFC-002
Dependencies: COMPAT-BIM-001
Acceptance criteria: defined IFC benchmark passes.
Verification: automated round-trip and semantic diff.
Out of scope: unsupported vendor-specific proprietary semantics.
Definition of done: IFC compatibility becomes a release gate.

# Phase 2 — Project/scheduling feasibility

### RESEARCH-PM-001 — Evaluate project engine candidates

Objective: Compare OpenProject and alternative scheduling engines against construction workflows and licensing/composition constraints.
Requirements: PM-001..PM-005
Dependencies: ARCH-WF-001, LICENSE-001
Acceptance criteria: feature matrix, benchmark results and licensing composition analysis.
Verification: benchmark + legal review.
Out of scope: final UI polish.
Definition of done: candidate decision recorded.

### RESEARCH-PM-002 — Scheduling/graph integration prototype

Objective: Map schedule entities to the Construction Graph and cost/project domains.
Requirements: PM-005, GRAPH-004
Dependencies: RESEARCH-PM-001
Acceptance criteria: task dependencies and milestones remain consistent across UI/API/domain services.
Verification: integration tests.
Definition of done: scheduling contract approved.

### COMPAT-PM-001 — Implement construction project baseline

Objective: Deliver WBS, activities, calendars, dependencies, critical path and baseline workflow.
Requirements: PM-001, PM-002
Dependencies: RESEARCH-PM-002
Acceptance criteria: benchmark schedule can be created, recalculated and compared against baseline.
Verification: deterministic schedule tests + e2e.
Out of scope: portfolio management.
Definition of done: Project compatibility gate passes.

### COMPAT-PM-002 — Resource and progress workflows

Objective: Add resource loading, progress updates and delay/change impacts.
Requirements: PM-003, PM-004, PM-005
Dependencies: COMPAT-PM-001
Acceptance criteria: progress updates modify schedule forecasts and affected graph objects.
Verification: scenario/e2e tests.
Out of scope: advanced enterprise resource planning.
Definition of done: construction scheduling baseline is operational.

# Phase 3 — Office compatibility

### RESEARCH-OFFICE-001 — Extract GenOffice compatibility patterns

Objective: Document reusable compatibility patterns for Docs/Sheets/Slides/PDF and identify components suitable for use subject to license audit.
Requirements: OFFICE-001..OFFICE-004
Dependencies: LICENSE-001
Acceptance criteria: architecture dossier, component inventory, source preservation strategy and compatibility tests.
Verification: architect review.
Out of scope: copying protected branding/assets.
Definition of done: implementation boundaries approved.

### COMPAT-SHEET-001 — Sheets baseline

Objective: Deliver XLSX editing workflow suitable for construction estimating.
Requirements: OFFICE-001, OFFICE-004, OFFICE-005
Dependencies: RESEARCH-OFFICE-001, GRAPH-001
Acceptance criteria: representative XLSX files round-trip; construction functions operate through shared domain APIs.
Verification: file-format round-trip suite + e2e.
Out of scope: full parity with every spreadsheet feature.
Definition of done: estimating spreadsheet baseline passes.

### COMPAT-DOC-001 — Docs baseline

Objective: Deliver DOCX-compatible project/specification workflow.
Requirements: OFFICE-002, OFFICE-004
Dependencies: RESEARCH-OFFICE-001
Acceptance criteria: representative DOCX files round-trip with defined preservation threshold.
Verification: structural diff + visual review.
Out of scope: desktop-publishing perfection.
Definition of done: document workflow baseline passes.

### COMPAT-OFFICE-001 — Slides/PDF baseline

Objective: Deliver required presentation/PDF workflows.
Requirements: OFFICE-003, OFFICE-004
Dependencies: RESEARCH-OFFICE-001
Acceptance criteria: pilot workflows pass import/export/render checks.
Verification: automated checks + visual review.
Out of scope: advanced authoring parity.
Definition of done: baseline office suite integrated.

# Phase 4 — Core platform

### PLATFORM-001 — Core modular-monolith foundation

Objective: Implement module conventions, application services, workers, interfaces and observability.
Requirements: PLAT-001..PLAT-005
Dependencies: ARCH-WF-002, RESEARCH-CAD-007, RESEARCH-PM-001
Acceptance criteria: frozen module boundaries are enforced; background workers execute jobs; tracing exists.
Verification: unit/integration/static architecture tests.
Out of scope: domain-specific feature logic.
Definition of done: platform foundation verified.

### PLATFORM-002 — Identity and tenant isolation

Objective: Implement authentication, organizations, roles, project membership and server-side tenant isolation.
Requirements: AUTH-001..AUTH-006
Dependencies: PLATFORM-001
Acceptance criteria: cross-tenant access tests fail closed; external scoped sessions work.
Verification: security/integration tests.
Out of scope: customer-facing billing.
Definition of done: tenant boundary is proven.

### PLATFORM-003 — Persistence and artifact storage

Objective: Implement PostgreSQL/object storage/queue abstractions.
Requirements: DATA-001..DATA-005
Dependencies: PLATFORM-001
Acceptance criteria: storage boundaries are stable and recoverable.
Verification: migration, backup/restore, artifact integrity tests.
Out of scope: advanced analytics warehouse.
Definition of done: persistence layer verified.

### PLATFORM-004 — Versioning, lineage and audit

Objective: Implement canonical versioning/provenance/audit for authoritative objects.
Requirements: GRAPH-003, DATA-004, DATA-005
Dependencies: PLATFORM-003
Acceptance criteria: object lineage is reconstructable.
Verification: version graph tests.
Out of scope: historical replay engine.
Definition of done: domain history is trustworthy.

### PLATFORM-005 — Event bus and domain event contracts

Objective: Implement durable typed events.
Requirements: COLLAB-003, API-003, FLOW-001
Dependencies: PLATFORM-004
Acceptance criteria: events are versioned, traceable and idempotently consumable.
Verification: contract/idempotency tests.
Out of scope: arbitrary external event streaming.
Definition of done: cross-domain integration bus is live.

### PLATFORM-006 — Unified application shell

Objective: Host first-party apps in one coherent workspace.
Requirements: WORKSPACE-001, WORKSPACE-002
Dependencies: PLATFORM-002, COMPAT-SHEET-001, COMPAT-DOC-001, COMPAT-CAD-001, COMPAT-PM-001
Acceptance criteria: a user can move among apps in one project without losing context.
Verification: e2e navigation/project context tests.
Out of scope: final visual brand system.
Definition of done: unified workspace baseline passes.

# Phase 5 — Construction Graph and collaboration

### GRAPH-001 — Canonical domain model

Objective: Implement core Construction Graph entities and relationships.
Requirements: GRAPH-001..GRAPH-005
Dependencies: PLATFORM-004
Acceptance criteria: entities/relationships support CAD/BIM, cost, RFQ, bids, schedule, inspection and maintenance.
Verification: schema + integration tests.
Out of scope: advanced knowledge graph analytics.
Definition of done: canonical graph is stable.

### COLLAB-001 — Collaboration foundation

Objective: Implement project presence, comments, activity and collaborative session infrastructure.
Requirements: COLLAB-001
Dependencies: PLATFORM-005, PLATFORM-002
Acceptance criteria: authorized users see coherent project activity.
Verification: e2e collaboration tests.
Out of scope: CRDT-specific editor implementation.
Definition of done: collaboration foundation operational.

### COLLAB-002 — Collaborative Docs/Sheets editing

Objective: Add real-time collaborative editing to office apps.
Requirements: COLLAB-002, COLLAB-004
Dependencies: COLLAB-001, COMPAT-SHEET-001, COMPAT-DOC-001
Acceptance criteria: concurrent edits converge and preserve audit/history.
Verification: deterministic concurrency tests.
Out of scope: BIM object collaboration.
Definition of done: office collaboration baseline passes.

### COLLAB-003 — Transactional BIM/Estimate/RFQ collaboration

Objective: Implement versioned multi-user transactions for high-value domain objects.
Requirements: COLLAB-003, COLLAB-004
Dependencies: GRAPH-001, COLLAB-001
Acceptance criteria: conflicting edits resolve according to defined semantics and preserve lineage.
Verification: conflict tests.
Out of scope: fully lock-free BIM geometry collaboration.
Definition of done: transactional collaboration passes.

# Phase 6 — AI and tool intelligence

### AI-001 — AI Gateway

Objective: Implement provider-independent AI Gateway.
Requirements: AI-001, AI-003, AI-006
Dependencies: PLATFORM-001, PLATFORM-002
Acceptance criteria: multiple providers/models can be invoked through one contract with traceable metadata.
Verification: provider contract tests.
Out of scope: domain agents.
Definition of done: provider-independent gateway passes.

### AI-002 — OpenRouter adapter and routing

Objective: Add OpenRouter provider adapter and policy-based routing/fallbacks.
Requirements: AI-002, AI-004, AI-005
Dependencies: AI-001
Acceptance criteria: router can select model/provider and fail over under test conditions.
Verification: routing simulation + integration tests.
Out of scope: training proprietary routing model.
Definition of done: first multi-model route works.

### AI-003 — Direct provider adapters and local model interface

Objective: Add direct providers and local inference interface behind same contract.
Requirements: AI-003
Dependencies: AI-001
Acceptance criteria: provider can be swapped without domain-layer changes.
Verification: adapter compatibility tests.
Out of scope: operating all possible providers.
Definition of done: provider independence proven.

### AI-004 — Agent runtime and tool contracts

Objective: Implement agent execution, structured outputs, tool calling and authorization.
Requirements: AI-007, AI-009, TOOL-001..TOOL-003
Dependencies: AI-001, PLATFORM-005
Acceptance criteria: agents invoke tools through typed capability contracts; raw model output cannot directly mutate authoritative state.
Verification: security + contract tests.
Out of scope: domain-specific agents.
Definition of done: agent runtime is governed.

### AI-005 — Model evaluation ledger

Objective: Record model/task/provider outcomes for routing and quality evaluation.
Requirements: AI-006
Dependencies: AI-002, AI-003, KNOW-001
Acceptance criteria: model executions are benchmarkable by task/cost/latency/quality.
Verification: telemetry and evaluation tests.
Definition of done: model selection can be evidence-driven.

### TOOL-001 — Universal capability registry

Objective: Register native tools, engines and extensions with typed contracts and metadata.
Requirements: TOOL-001..TOOL-004
Dependencies: AI-004, EXT-001
Acceptance criteria: capability discovery and selection return only authorized/eligible capabilities.
Verification: registry/security tests.
Definition of done: Tool Intelligence baseline is live.

# Phase 7 — Knowledge, evidence and uncertainty

### KNOW-001 — Knowledge/evidence foundation

Objective: Implement source-aware knowledge/evidence objects.
Requirements: KNOW-001, KNOW-002, EVID-001, EVID-002
Dependencies: PLATFORM-004
Acceptance criteria: every source has provenance/edition/applicability metadata.
Verification: schema tests + source lineage tests.
Out of scope: full web crawling.
Definition of done: evidence system is operational.

### UNKNOWN-001 — Unknown Resolution Engine

Objective: Implement epistemic state classification and estimation strategy selection.
Requirements: UNKNOWN-001, UNKNOWN-002
Dependencies: KNOW-001, AI-004
Acceptance criteria: outputs never lose epistemic status; strategy choice is explainable.
Verification: golden cases.
Definition of done: unknowns can be represented and resolved explicitly.

### UNKNOWN-002 — Value-of-information recommendations

Objective: Recommend information-gathering actions by expected uncertainty reduction/value.
Requirements: UNKNOWN-003
Dependencies: UNKNOWN-001, LAB-001
Acceptance criteria: benchmark cases rank sensible tests/investigations.
Verification: expert benchmark.
Definition of done: information-gain loop works.

# Phase 8 — Quantities, cost, RFQ and subcontractors

### COST-001 — Quantity and estimate service

Objective: Implement quantity-driven deterministic estimating.
Requirements: QTY-001, QTY-002, COST-001, COST-002
Dependencies: GRAPH-001, RESEARCH-CAD-004, COMPAT-SHEET-001
Acceptance criteria: benchmark building produces reproducible estimate values and deltas.
Verification: golden project tests.
Definition of done: quantity→estimate flow is operational.

### COST-002 — Probabilistic cost/risk engine

Objective: Add distributions, uncertainty, contingencies and sensitivity.
Requirements: COST-003, COST-005, COST-006
Dependencies: COST-001, UNKNOWN-001
Acceptance criteria: P50/P80/P90 and sensitivity outputs are reproducible.
Verification: statistical/unit tests.
Out of scope: autonomous financial approval.
Definition of done: probabilistic estimating baseline passes.

### RFQ-001 — RFQ scope engine

Objective: Generate/maintain RFQ packages from estimate/quantities.
Requirements: RFQ-001, RFQ-002
Dependencies: COST-001, PLATFORM-005
Acceptance criteria: partial scope can be selected and independently versioned.
Verification: e2e tests.
Definition of done: RFQ package generation works.

### RFQ-002 — External subcontractor participation

Objective: Allow off-platform recipients to securely submit quotes.
Requirements: RFQ-003, RFQ-004
Dependencies: PLATFORM-002, RFQ-001, COMPAT-SHEET-001
Acceptance criteria: recipient sees only authorized scope and submits quote without tenant access.
Verification: security/e2e tests.
Definition of done: external quote flow works.

### RFQ-003 — Bid normalization/leveling

Objective: Normalize supplier/subcontractor quotes and expose exclusions/assumptions/anomalies.
Requirements: RFQ-005, RFQ-006
Dependencies: RFQ-002, AI-004
Acceptance criteria: known benchmark quotes normalize correctly.
Verification: gold-standard quote set.
Definition of done: bid leveling baseline passes.

### RFQ-004 — Subcontractor performance intelligence

Objective: Compare quoted versus actual outcomes and maintain profiles.
Requirements: RFQ-007, RFQ-008
Dependencies: RFQ-003, LAB-002
Acceptance criteria: variance history is recorded and queryable.
Verification: historical case tests.
Definition of done: subcontractor learning loop works.

# Phase 9 — Bid intelligence and Construction Lab

### BID-001 — Tender mechanism analyzer

Objective: Parse/model procurement scoring rules and constraints.
Requirements: BID-001
Dependencies: KNOW-001, COST-002
Acceptance criteria: benchmark tender mechanisms reproduce known ranking/outcome logic.
Verification: historical tender replay.
Definition of done: tender mechanism engine is trusted.

### BID-002 — Win probability model

Objective: Estimate win probability conditioned on project/tender/market/bidder context.
Requirements: BID-002, BID-006
Dependencies: BID-001, TIME-002
Acceptance criteria: historical backtest reports calibration metrics.
Verification: leakage-free time-series backtest.
Definition of done: model meets defined calibration threshold.

### BID-003 — Risk-adjusted bid optimizer

Objective: Optimize bid price against win probability, expected profit and risk/capacity constraints.
Requirements: BID-003, BID-004
Dependencies: BID-002, COST-002
Acceptance criteria: optimizer produces reproducible strategy curves and does not systematically select negative expected-value bids unless explicitly configured.
Verification: historical and synthetic benchmark.
Definition of done: bid optimizer passes lab gate.

### TIME-001 — Temporal data store and historical replay

Objective: Implement temporal snapshots and future-leakage controls.
Requirements: TIME-001..TIME-003
Dependencies: PLATFORM-004, KNOW-001
Acceptance criteria: replay at T excludes data first available after T.
Verification: adversarial leakage tests.
Definition of done: Time Machine base is trusted.

### TIME-002 — Walk-forward/backtest engine

Objective: Execute historical training/evaluation windows and record outcomes.
Requirements: TIME-004
Dependencies: TIME-001
Acceptance criteria: experiments are reproducible and auditable.
Verification: benchmark replay.
Definition of done: historical ML evaluation is operational.

### LAB-001 — Construction Lab foundation

Objective: Build Cost/Bid/Productivity/Failure/Maintenance/Scenario/Model Evaluation workspaces.
Requirements: LAB-001, TIME-005, TIME-006
Dependencies: TIME-002, AI-005, COST-002, BID-002
Acceptance criteria: experiment definitions, runs, outputs and outcomes are versioned.
Verification: lab e2e tests.
Definition of done: Construction Lab baseline operational.

### LAB-002 — Prediction ledger and calibration

Objective: Store predictions before outcomes and resolve them against actuals.
Requirements: TIME-006, LAB-002
Dependencies: LAB-001
Acceptance criteria: calibration/bias reports are generated without rewriting historical predictions.
Verification: synthetic and real historical cases.
Definition of done: learning loop baseline passes.

# Phase 10 — Design/construction/maintenance intelligence

### INTEL-001 — Junior Professional Mode

Objective: Turn missing requirements into actionable create/procure/validate workflows.
Requirements: DESIGN-001, DESIGN-002
Dependencies: UNKNOWN-002, RFQ-001, AI-004
Acceptance criteria: benchmark project identifies missing artifacts and offers executable workflows.
Verification: e2e agent/tool tests.
Definition of done: junior mode completes representative artifact chain.

### INTEL-002 — Design alternative analysis

Objective: Compare alternatives on cost/schedule/risk/lifecycle factors.
Requirements: DESIGN-003
Dependencies: COST-002, TOOL-001
Acceptance criteria: alternatives are traceable to assumptions/evidence.
Verification: benchmark scenario tests.
Definition of done: option comparison works.

### INTEL-003 — Construction copilot

Objective: Assist methods, sequencing, QA/QC, progress and constructability.
Requirements: CONST-001
Dependencies: COMPAT-PM-002, KNOW-001, AI-004
Acceptance criteria: representative construction workflows complete with evidence.
Verification: e2e + expert review.
Definition of done: construction intelligence baseline passes.

### INTEL-004 — Condition assessment

Objective: Combine history, BIM, images, tests and sensor data for condition assessment.
Requirements: MAINT-001, MAINT-002
Dependencies: GRAPH-001, UNKNOWN-001, TOOL-001
Acceptance criteria: benchmark defects yield ranked diagnoses with explicit uncertainty.
Verification: labeled defect benchmark + expert review.
Definition of done: condition assessment gate passes.

### INTEL-005 — Lifecycle maintenance optimization

Objective: Compare repair/replace/monitor strategies using lifecycle economics and risk.
Requirements: MAINT-003, MAINT-004
Dependencies: INTEL-004, COST-002, LAB-002
Acceptance criteria: benchmark asset cases produce traceable interventions and update with actual outcomes.
Verification: lifecycle scenario suite.
Definition of done: maintenance intelligence baseline passes.

# Phase 11 — Extensions and public API

### EXT-001 — Extension SDK

Objective: Publish manifest, capability, permission and versioning contracts.
Requirements: EXT-001, EXT-003, EXT-004
Dependencies: GRAPH-001, PLATFORM-002
Acceptance criteria: sample extension can register and call allowed capabilities.
Verification: SDK integration tests.
Definition of done: extension developer baseline passes.

### EXT-002 — Extension sandbox/security

Objective: Enforce runtime permissions, isolation and revocation.
Requirements: EXT-002
Dependencies: EXT-001, PLATFORM-002
Acceptance criteria: unauthorized data/network operations are blocked and audited.
Verification: security tests.
Definition of done: extension security gate passes.

### API-001 — Public domain API

Objective: Publish stable, versioned domain APIs.
Requirements: API-001, API-002, API-005
Dependencies: GRAPH-001, PLATFORM-002
Acceptance criteria: external client can complete representative project/RFQ query/mutation flows using same domain services as native apps.
Verification: contract/e2e tests.
Definition of done: public API v1 passes.

### API-002 — Webhooks, async jobs and SDKs

Objective: Add event callbacks, long-running job APIs and developer SDKs.
Requirements: API-003, API-004
Dependencies: API-001, PLATFORM-005
Acceptance criteria: async workflows are observable and idempotent.
Verification: contract/e2e tests.
Definition of done: developer integration baseline passes.

# Phase 12 — Full-system benchmark

### BENCH-001 — End-to-end tender benchmark

Objective: Prove the killer workflow from model change through quantity/estimate/RFQ/subcontractor bids to optimized tender.
Requirements: CAD-INT-002, COST-001..006, RFQ-001..008, BID-001..006
Dependencies: COMPAT-IFC-001, COST-002, RFQ-004, BID-003
Acceptance criteria: workflow completes without manual re-keying of canonical quantities and all outputs have traceable provenance.
Verification: deterministic golden-project run + expert review.
Definition of done: full tender benchmark passes.

### BENCH-002 — End-to-end building diagnosis benchmark

Objective: Prove inspection → diagnosis → maintenance → lifecycle → learning loop.
Requirements: MAINT-001..004, LAB-002
Dependencies: INTEL-005, LAB-002
Acceptance criteria: representative defect case produces actionable, uncertainty-aware intervention and records outcome.
Verification: expert benchmark.
Definition of done: full lifecycle benchmark passes.
