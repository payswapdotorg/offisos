# ConstructionOS Requirements

**Architecture version:** 1.0
**Status:** FROZEN

Each requirement has: ID, title, description, owner/module, dependencies, acceptance criteria and required verification. A requirement is not considered complete from an implementation claim alone.

## Platform

| ID | Requirement | Module | Dependencies |
|---|---|---|---|
| PLAT-001 | Provide a TypeScript modular-monolith runtime with explicit module boundaries and background workers. | platform | — |
| PLAT-002 | Provide stable internal domain/service interfaces independent of UI implementations. | platform | PLAT-001 |
| PLAT-003 | Provide structured logs, metrics, traces and execution IDs. | platform | PLAT-001 |
| PLAT-004 | Provide durable job execution for long-running native/AI/BIM workloads. | workers | PLAT-001 |
| PLAT-005 | Preserve reproducible build/test environments. | platform | PLAT-001 |

## Identity, tenancy and permissions

| ID | Requirement | Module | Dependencies |
|---|---|---|---|
| AUTH-001 | Authenticate users and maintain persistent identities. | auth/users | PLAT-001 |
| AUTH-002 | Support tenant, organization, team and project membership. | organizations/projects | AUTH-001 |
| AUTH-003 | Enforce server-side tenant isolation on every protected resource. | auth/projects | AUTH-002 |
| AUTH-004 | Support role and resource-level permissions. | auth | AUTH-002 |
| AUTH-005 | Support external scoped users/sessions for subcontractors, suppliers and collaborators. | auth | AUTH-004 |
| AUTH-006 | Keep secrets outside ordinary domain data and redact them from logs/prompts. | security | PLAT-001 |

## Persistence and artifacts

| ID | Requirement | Module | Dependencies |
|---|---|---|---|
| DATA-001 | PostgreSQL is authoritative for structured domain state. | data | PLAT-001 |
| DATA-002 | Object storage holds large source/derived artifacts with durable references. | data | PLAT-001 |
| DATA-003 | Queues/locks/cache are non-authoritative support infrastructure. | data/workers | PLAT-001 |
| DATA-004 | Every authoritative object is versionable and traceable to its inputs. | data | DATA-001 |
| DATA-005 | Original source artifacts are retained with provenance. | data | DATA-002 |

## Construction Graph

| ID | Requirement | Module | Dependencies |
|---|---|---|---|
| GRAPH-001 | Provide canonical project/building/asset/entity relationships. | construction-graph | DATA-001 |
| GRAPH-002 | Support BIM elements, quantities, cost items, RFQs, bids, schedules, inspections and maintenance as linked domain objects. | construction-graph | GRAPH-001 |
| GRAPH-003 | Support provenance, version and temporal metadata on relevant objects. | construction-graph | GRAPH-001, DATA-004 |
| GRAPH-004 | Expose graph/domain capabilities through stable APIs. | construction-graph | GRAPH-002 |
| GRAPH-005 | Prevent application-local canonical copies of shared objects. | platform/graph | GRAPH-001 |

## Workspace and collaboration

| ID | Requirement | Module | Dependencies |
|---|---|---|---|
| WORKSPACE-001 | Provide a unified application shell. | workspace | PLAT-002 |
| WORKSPACE-002 | Support Docs, Sheets, Slides, PDF, CAD, BIM and Project application surfaces. | workspace/apps | WORKSPACE-001 |
| COLLAB-001 | Support project-wide presence, comments and activity streams. | collaboration | AUTH-004, GRAPH-004 |
| COLLAB-002 | Support real-time collaborative editing for document/cell/presence use cases. | collaboration | COLLAB-001 |
| COLLAB-003 | Support versioned transactional collaboration for BIM, estimates, RFQs, bids and schedules. | collaboration | DATA-004 |
| COLLAB-004 | Record conflict resolution/merge lineage. | collaboration | COLLAB-002, COLLAB-003 |

## Office compatibility

| ID | Requirement | Module | Dependencies |
|---|---|---|---|
| OFFICE-001 | Provide a Sheets-compatible editor with XLSX import/export preservation goals. | spreadsheets | WORKSPACE-002 |
| OFFICE-002 | Provide a Docs-compatible editor with DOCX import/export preservation goals. | documents | WORKSPACE-002 |
| OFFICE-003 | Provide Slides/PDF compatibility surfaces. | documents | WORKSPACE-002 |
| OFFICE-004 | Support source-preserving round trips and narrow/controlled patches where feasible. | documents/spreadsheets | OFFICE-001, OFFICE-002 |
| OFFICE-005 | Construction-aware spreadsheet functions can call shared domain services. | spreadsheets | GRAPH-004 |

## CAD/BIM compatibility

| ID | Requirement | Module | Dependencies |
|---|---|---|---|
| CAD-001 | Provide professional-grade 2D drafting primitives and workflows sufficient for benchmark tasks. | cad | WORKSPACE-002 |
| CAD-002 | Provide 3D geometry workflows sufficient for benchmark tasks. | cad | CAD-001 |
| BIM-001 | Provide parametric building elements sufficient for benchmark tasks. | bim | CAD-002 |
| BIM-002 | Represent BIM semantics independently of editor implementation. | bim/graph | GRAPH-001 |
| IFC-001 | Import/export IFC through an adapter and meet defined semantic fidelity thresholds. | bim | BIM-002 |
| IFC-002 | Support IDS/BCF/openBIM interoperability pathways where applicable. | bim | IFC-001 |
| QTY-001 | Derive quantities from canonical model elements. | quantities | GRAPH-002, BIM-001 |
| QTY-002 | Recalculate quantities deterministically for model revisions. | quantities | QTY-001 |
| CAD-INT-001 | CAD/BIM changes propagate to affected quantities. | cad/bim/quantities | QTY-002 |
| CAD-INT-002 | Quantity changes identify affected estimates/RFQs/bids. | quantities/cost/rfq | CAD-INT-001 |

## Project/scheduling compatibility

| ID | Requirement | Module | Dependencies |
|---|---|---|---|
| PM-001 | Support WBS, activities, calendars and dependencies. | project-management | WORKSPACE-002 |
| PM-002 | Support critical path and baseline comparisons. | project-management | PM-001 |
| PM-003 | Support resources, resource loading and construction-relevant scheduling. | project-management | PM-001 |
| PM-004 | Support progress updates, delay analysis and change impact. | project-management | PM-002 |
| PM-005 | Share schedule objects with cost/RFQ/project graph. | schedule/graph | GRAPH-004, PM-001 |

## AI gateway and multi-model agents

| ID | Requirement | Module | Dependencies |
|---|---|---|---|
| AI-001 | Provide provider-independent AI Gateway. | ai | PLAT-002 |
| AI-002 | Integrate OpenRouter as an initial routing/provider adapter. | ai | AI-001 |
| AI-003 | Support direct model/provider adapters independent of OpenRouter. | ai | AI-001 |
| AI-004 | Support task-specific model and provider routing policies. | ai | AI-001 |
| AI-005 | Support fallbacks, retries and provider/model health policies. | ai | AI-004 |
| AI-006 | Record model/provider/routing/evidence/cost/latency metadata. | ai/evidence | AI-001 |
| AI-007 | Support multi-agent workflows using tool contracts. | agents | AI-001, TOOL-001 |
| AI-008 | Support independent model adjudication for high-consequence tasks. | agents | AI-007 |
| AI-009 | Never treat raw LLM output as authoritative state. | ai/graph | GRAPH-005 |

## Tool and capability intelligence

| ID | Requirement | Module | Dependencies |
|---|---|---|---|
| TOOL-001 | Provide a universal capability registry. | tool-intelligence | GRAPH-004 |
| TOOL-002 | Register inputs/outputs, permissions, quality, jurisdiction and cost metadata for capabilities. | tool-intelligence | TOOL-001 |
| TOOL-003 | Select eligible tools/extensions/providers for a requested task. | tool-intelligence | TOOL-002, AI-004 |
| TOOL-004 | Explain why a capability was selected. | tool-intelligence | TOOL-003 |

## Knowledge/evidence/uncertainty

| ID | Requirement | Module | Dependencies |
|---|---|---|---|
| KNOW-001 | Store authoritative/technical/reference knowledge with provenance and edition metadata. | knowledge | DATA-001, DATA-005 |
| KNOW-002 | Distinguish law/regulation/standard/engineering science/empirical/project/expert evidence. | knowledge | KNOW-001 |
| EVID-001 | Persist evidence objects linked to decisions/predictions/requirements. | evidence | DATA-001 |
| EVID-002 | Support source, timestamp, jurisdiction, edition, applicability and confidence metadata. | evidence | EVID-001 |
| UNKNOWN-001 | Label outputs OBSERVED/CALCULATED/INFERRED/EXTRAPOLATED/GUESSED/UNKNOWN. | unknown-resolution | EVID-001 |
| UNKNOWN-002 | Choose an estimation strategy for missing information based on available evidence. | unknown-resolution | UNKNOWN-001 |
| UNKNOWN-003 | Recommend highest-value next information-gathering actions where useful. | unknown-resolution | UNKNOWN-002 |

## Cost, estimating and market intelligence

| ID | Requirement | Module | Dependencies |
|---|---|---|---|
| COST-001 | Provide estimate methods appropriate to project maturity. | cost | QTY-001 |
| COST-002 | Provide deterministic quantity × rate estimating. | cost | QTY-001 |
| COST-003 | Support probabilistic cost ranges and contingency/risk analysis. | cost/risk | COST-001 |
| COST-004 | Support local/regional/global price sources with provenance. | cost/knowledge | KNOW-001 |
| COST-005 | Model labor/equipment/material productivity and uncertainty. | cost/lab | COST-001 |
| COST-006 | Provide price sensitivity and scenario analysis. | cost/lab | COST-003 |

## RFQ/subcontractor/supplier

| ID | Requirement | Module | Dependencies |
|---|---|---|---|
| RFQ-001 | Create RFQs from estimate/quantity scopes. | rfq | COST-002 |
| RFQ-002 | Allow partial-scope RFQs to one or more subcontractors. | rfq/subcontractors | RFQ-001 |
| RFQ-003 | Support platform and off-platform subcontractors. | rfq/auth | AUTH-005, RFQ-002 |
| RFQ-004 | Accept XLSX/PDF/native/API quote submissions. | rfq | OFFICE-001, OFFICE-003 |
| RFQ-005 | Normalize and level subcontractor bids. | subcontractors | RFQ-004 |
| RFQ-006 | Identify exclusions, assumptions, anomalies and non-comparable scope. | subcontractors/intelligence | RFQ-005 |
| RFQ-007 | Track subcontractor actual performance against quote. | subcontractors/lab | RFQ-005 |
| RFQ-008 | Maintain supplier/subcontractor performance profiles. | suppliers/subcontractors | RFQ-007 |

## Bid intelligence

| ID | Requirement | Module | Dependencies |
|---|---|---|---|
| BID-001 | Model tender scoring/procurement mechanism. | bid | COST-003 |
| BID-002 | Estimate win probability under observed tender conditions. | bid | BID-001 |
| BID-003 | Optimize bid price for risk-adjusted expected value rather than raw margin alone. | bid | BID-002 |
| BID-004 | Support strategy profiles (aggressive, balanced, margin-first, capacity-fill, etc.). | bid | BID-003 |
| BID-005 | Track predicted vs actual bid outcomes. | bid/lab | BID-002 |
| BID-006 | Perform competitor/reference-class analysis where data exists. | bid/lab | BID-005 |

## Time Machine and Construction Lab

| ID | Requirement | Module | Dependencies |
|---|---|---|---|
| TIME-001 | Store time-valid data snapshots and provenance. | temporal | DATA-004, EVID-002 |
| TIME-002 | Reconstruct an information state as-of historical timestamp T. | temporal | TIME-001 |
| TIME-003 | Prevent future leakage in historical replay. | temporal | TIME-002 |
| TIME-004 | Run walk-forward/backtest experiments. | lab | TIME-003 |
| TIME-005 | Support counterfactual scenarios. | lab | TIME-004 |
| TIME-006 | Maintain a prediction ledger and outcome resolution loop. | lab | EVID-001 |
| LAB-001 | Provide Cost/Bid/Productivity/Failure/Maintenance/Scenario/Model-evaluation labs. | lab | TIME-004 |
| LAB-002 | Calibrate predictions against actual outcomes. | lab | TIME-006 |

## Design, construction and maintenance intelligence

| ID | Requirement | Module | Dependencies |
|---|---|---|---|
| DESIGN-001 | Review design against project context, applicable rules and evidence. | design-intelligence | KNOW-001, GRAPH-004 |
| DESIGN-002 | Identify missing information and offer artifact creation/procurement workflows. | design-intelligence | UNKNOWN-003, RFQ-001 |
| DESIGN-003 | Compare design alternatives on cost, schedule, risk and lifecycle dimensions. | design-intelligence | COST-006, TOOL-003 |
| CONST-001 | Assist with construction methods, QA/QC, sequencing, logistics and progress. | construction-intelligence | PM-004, KNOW-001 |
| MAINT-001 | Assess condition using documents, images, tests and sensors where available. | maintenance | EVID-001 |
| MAINT-002 | Diagnose likely failure mechanisms with explicit uncertainty. | maintenance | UNKNOWN-001 |
| MAINT-003 | Recommend repair/replace/monitor strategies with lifecycle economics. | maintenance | COST-003, MAINT-002 |
| MAINT-004 | Track actual intervention outcomes into the learning loop. | maintenance/lab | MAINT-003, LAB-002 |

## Extensions

| ID | Requirement | Module | Dependencies |
|---|---|---|---|
| EXT-001 | Provide extension manifests and versioned capability declarations. | extensions | TOOL-001 |
| EXT-002 | Enforce scoped permissions and sandbox/security boundaries. | extensions/security | AUTH-004, TOOL-002 |
| EXT-003 | Allow extensions to read/write canonical domain objects through APIs. | extensions | GRAPH-004 |
| EXT-004 | Provide extension lifecycle, compatibility and versioning management. | extensions | EXT-001 |
| EXT-005 | Provide an extension marketplace/catalog model. | extensions | EXT-004 |

## Public API

| ID | Requirement | Module | Dependencies |
|---|---|---|---|
| API-001 | Expose domain capabilities through versioned public APIs. | api | GRAPH-004 |
| API-002 | Support OAuth/API keys, scopes, idempotency and rate limits. | api/security | AUTH-004 |
| API-003 | Support asynchronous jobs and webhooks/events. | api | API-001, EVENT-001 |
| API-004 | Provide SDKs and developer documentation. | api | API-001 |
| API-005 | Native apps and external API clients share domain contracts. | api/platform | GRAPH-004 |

## Workflow and verification

| ID | Requirement | Module | Dependencies |
|---|---|---|---|
| FLOW-001 | Implement deterministic development workflow states and transitions. | workflows | PLAT-001 |
| FLOW-002 | Maintain evidence-backed verification state. | verification | FLOW-001, EVID-001 |
| FLOW-003 | Support independent architect review and targeted correction findings. | reviews | FLOW-002 |
| FLOW-004 | Prevent implementation agents from mutating frozen architecture. | workflows/architecture | FLOW-001 |
| FLOW-005 | Support architecture change requests and new architecture versions. | architecture | FLOW-004 |

## Core acceptance-criterion convention

Every requirement receives one or more AC records in the implementation backlog. Acceptance criterion states are `PENDING`, `PASS`, `FAIL`, or `BLOCKED`.

For high-risk compatibility and engineering capabilities, automated tests are mandatory wherever feasible; manual expert evaluation is an additional evidence source, never a substitute for deterministic tests where deterministic tests are possible.
