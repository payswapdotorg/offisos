# ConstructionOS Architecture

**Version:** 1.0
**Status:** FROZEN
**Effective date:** 2026-08-24
**Scope:** Product/platform architecture for the ConstructionOS platform.

## 1. Purpose

ConstructionOS is a multi-tenant Construction Operating System that combines professional work applications, construction intelligence, project/asset data, collaboration, APIs and extensions into one coherent system.

The architecture must support the full construction lifecycle:

`brief → site/context → design → engineering → estimating → tender → subcontractor procurement → construction → inspection → commissioning → maintenance → lifecycle learning`

The platform must also preserve a continuous learning loop:

`prediction → decision → outcome → evaluation → model/data improvement`

## 2. Architectural principles

### 2.1 Construction Graph is the domain system of record

Authoritative project and asset state is represented by the Construction Graph and persisted through the platform's domain services. Individual applications are editors/views over shared domain objects and must not create competing canonical copies.

### 2.2 Evidence over claims

Implementation, engineering recommendations and model outputs require evidence appropriate to their consequence. An assertion that something works is not completion evidence.

### 2.3 Frozen architecture

This architecture is immutable once frozen. Architectural changes require an Architecture Change Request, an impact assessment, approval by the Product Owner, and a new immutable architecture version.

### 2.4 Provider independence

No domain component may directly depend on a specific AI provider, CAD engine, scheduling engine, cloud provider, or external application. External systems are accessed through explicit adapters/contracts.

### 2.5 Modular monolith first

The core application starts as a TypeScript modular monolith plus background/native workers. Module boundaries must be explicit so selected modules can later be extracted without redesigning domain contracts.

### 2.6 Human authority for high-consequence decisions

AI can reason, calculate through approved tools, recommend, critique and generate artifacts. It must not silently certify regulated engineering work, alter authoritative project state without authorization, or make irreversible commercial decisions without the required human authorization.

### 2.7 Uncertainty is first-class

The system distinguishes OBSERVED, CALCULATED, INFERRED, EXTRAPOLATED, GUESSED and UNKNOWN states. Missing information should produce explicit uncertainty and, where useful, recommendations for the best next information-gathering action.

### 2.8 Time is a first-class dimension

Historical facts, prices, model versions, predictions and outcomes retain temporal provenance. Historical replay must never use information that would not have been available at the replay time.

### 2.9 Open standards first

Use IFC, bSDD, IDS, BCF and related openBIM concepts when appropriate. Use standard document formats and preserve source artifacts.

### 2.10 Compatibility means professional workflow fidelity

For Office, CAD/BIM and Project applications, compatibility is not defined by visual similarity alone. It requires representative workflow completion, file round-trip integrity, semantic fidelity and measurable performance.

## 3. System context

External parties/systems include:

- users and organizations;
- external consultants, subcontractors, suppliers and laboratories;
- AI/model providers;
- OpenRouter or equivalent model-routing providers;
- CAD/BIM/openBIM engines;
- office/document engines;
- project/scheduling engines;
- storage/cloud infrastructure;
- external pricing/market/reference-data providers;
- Git repositories/CI/CD tooling;
- third-party extensions.

## 4. High-level architecture

```text
                          ┌─────────────────────────────┐
                          │       UNIFIED WORKSPACE      │
                          │ Docs │ Sheets │ CAD │ BIM   │
                          │ PM   │ RFQ   │ Cost │ QA   │
                          └──────────────┬──────────────┘
                                         │
                              ┌──────────▼──────────┐
                              │ APPLICATION API     │
                              └──────────┬──────────┘
                                         │
               ┌─────────────────────────┼────────────────────────┐
               │                         │                        │
      ┌────────▼────────┐      ┌────────▼────────┐      ┌────────▼────────┐
      │ CONSTRUCTION    │      │ WORKFLOW /      │      │ COLLABORATION / │
      │ GRAPH + DOMAIN  │      │ VERSIONING      │      │ EVENTS          │
      │ SERVICES        │      │                 │      │                 │
      └────────┬────────┘      └─────────────────┘      └─────────────────┘
               │
      ┌────────┼───────────────┬────────────────┬─────────────────┐
      │        │               │                │                 │
   Design   Cost/Bid      Procurement       Asset            Schedule
   Brain     Brain       / Subcontractor   Intelligence        Brain
      │        │               │                │                 │
      └────────┴───────────────┴────────────────┴─────────────────┘
                               │
                       ┌───────▼────────┐
                       │ INTELLIGENCE   │
                       │ ORCHESTRATION  │
                       └───────┬────────┘
                               │
              ┌────────────────┼─────────────────┐
              │                │                 │
        ┌─────▼─────┐   ┌──────▼──────┐   ┌──────▼──────┐
        │ AI GATEWAY│   │ TOOL/       │   │ KNOWLEDGE   │
        │ + ROUTER  │   │ CAPABILITY  │   │ + EVIDENCE  │
        │            │   │ REGISTRY    │   │ ENGINE      │
        └─────┬─────┘   └─────────────┘   └─────────────┘
              │
      ┌───────┼─────────────────────────────┐
      │       │          │        │         │
 OpenRouter Direct     Local    Vision   Specialist
 providers  providers  models   models    providers

                               │
                       ┌───────▼────────┐
                       │ CONSTRUCTION   │
                       │ LAB            │
                       │ Time Machine   │
                       │ Scenarios      │
                       │ Calibration    │
                       └───────┬────────┘
                               │
                         Learning Loop
                               │
                         Public/Internal API
```

## 5. Runtime topology

The initial runtime is a modular monolith with background workers.

### Core application

Owns:

- authentication and organizations;
- projects and permissions;
- domain APIs;
- Construction Graph domain services;
- workflows;
- versioning/audit;
- AI orchestration contracts;
- extension registry;
- API gateway.

### Worker classes

Native or isolated workers handle:

- document conversions;
- spreadsheet patching/round trips;
- BIM/CAD processing;
- quantity extraction;
- engineering calculations;
- simulation;
- large file analysis;
- AI execution;
- historical replay;
- scheduled analytics.

Heavy native engines must communicate with the core through stable worker contracts.

## 6. Storage

### PostgreSQL

Authoritative structured domain state, workflow state, permissions, references, metadata, version records, evidence metadata, events and audit records.

### Object storage

Large files and immutable artifacts: models, drawings, office documents, PDFs, images, videos, point clouds, reports and datasets.

### Redis/queue layer

Transient coordination, job queues, caching and locks where appropriate. Redis is never authoritative.

### Search/index layer

Search/index technology may be selected independently, provided it never becomes the authoritative source of truth.

## 7. Major product domains

1. **Workspace:** unified shell and navigation.
2. **Compatibility Apps:** Docs, Sheets, Slides, PDF, CAD, BIM, Project.
3. **Project Graph:** canonical project/asset data.
4. **Design Intelligence:** architecture/engineering assistance.
5. **Construction Intelligence:** methods, QA/QC, planning, site intelligence.
6. **Cost Intelligence:** quantities, estimates, rates, productivity, uncertainty.
7. **Bid Intelligence:** tender analysis, win probability, optimization.
8. **Subcontractor/Supplier Intelligence:** RFQ, quote normalization, bid leveling and performance.
9. **Asset Intelligence:** inspection, diagnosis, service-life and maintenance.
10. **Tool Intelligence:** capability discovery, tool/extension/model selection.
11. **Knowledge/Evidence:** standards, regulations, project knowledge, sources, provenance.
12. **Construction Lab:** Time Machine, scenarios, calibration and learning.
13. **Extensions:** third-party capabilities.
14. **Public API:** domain capabilities for external applications.

## 8. Compatibility application architecture

Each compatible application follows the same conceptual pipeline where applicable:

`source artifact → parser/reader → normalized editing model → editor → validated command/patch model → source-format writer → round-trip verification`

The platform preserves the original/source artifact and lineage. A successful file open is not sufficient compatibility evidence.

### Sheets

A spreadsheet engine may use Univer or an equivalent open engine, with an explicit source-format boundary and compatibility tests. Construction-aware spreadsheet functions integrate with the domain API rather than embedding domain truth inside the spreadsheet renderer.

### Docs/Slides/PDF

Use mature open-source foundations where license-compatible, with narrow-patch and round-trip preservation strategies.

### CAD/BIM

CAD geometry and BIM semantics are separated. The system may use FreeCAD/OpenCascade/IfcOpenShell or another compatible engine behind an adapter. IFC/openBIM semantics belong to the platform BIM layer and Construction Graph, not solely to the editor.

### Project

Scheduling is a domain capability exposed through an adapter to a compatible open-source or native engine. The final selected engine must pass construction-specific workflow benchmarks and licensing/composition review.

## 9. Construction Graph

The graph connects:

`Project → Site → Building → Model → Element → Quantity → Cost → RFQ → Bid → Contract → Schedule → Construction → Inspection → Condition → Maintenance → Outcome`

The same entities can be accessed by UI, API, agents and extensions.

## 10. Event-driven integration

Cross-domain interactions occur through versioned domain events. Example:

`model.version.created → quantities.recompute → estimate.recalculate → rfq.impact.detected → subcontractor.requote.requested → bid.comparison.updated`

Events are durable, typed and traceable to their source version.

## 11. AI architecture

Agents depend on the AI Gateway, not providers.

The AI Gateway provides:

- provider adapters;
- model registry;
- task classification;
- policy-driven routing;
- fallback chains;
- structured outputs;
- tool calling;
- execution tracing;
- cost/latency metrics;
- safety/policy checks.

OpenRouter is an initial provider-routing adapter. Direct providers and local inference are supported through the same contract.

## 12. Tool/capability registry

Every internal capability or extension exposes:

- capability ID/version;
- input/output schema;
- permissions;
- jurisdiction/format support;
- quality indicators;
- estimated cost/latency;
- required artifacts;
- security class.

Tool Intelligence selects among eligible capabilities.

## 13. Unknown Resolution and Value of Information

The Unknown Engine selects the strongest available way to resolve missing information and labels its output. It may recommend tests/procurement/investigations based on expected information gain and decision consequence.

## 14. Time Machine

Historical replay reconstructs the information state available at time T and evaluates predictions without future leakage. It supports walk-forward validation, counterfactual scenarios and model calibration.

## 15. Collaboration

Collaboration is project-wide. Real-time collaborative editing may use CRDT technology for text/cells/presence, while BIM, estimates, RFQs, bids and regulated/financial objects use versioned domain transactions and approvals.

## 16. Multi-tenancy and security

Tenant, organization, project, role and resource boundaries are enforced server-side. Commercial data such as internal estimates and competitor bids is subject to stronger confidentiality controls than ordinary project data. External subcontractors use scoped external sessions when needed.

## 17. Extension architecture

Extensions are sandboxed and capability-scoped. They can read/write only allowed domain objects through stable APIs. Extension code may not directly mutate database internals.

## 18. Public API

The public API exposes domain capabilities rather than internal implementation details. Native apps use the same domain services.

Supported patterns include:

- OAuth and API keys;
- idempotent requests;
- asynchronous jobs;
- webhooks/events;
- versioned contracts;
- usage metering;
- SDKs.

## 19. Development workflow authority

The development workflow is derived from WorkflowOS:

`DRAFT → READY → ASSIGNED → IMPLEMENTING → PR_OPEN → VERIFYING → ARCHITECT_REVIEW → APPROVED → MERGED → VERIFIED`

A failed verification or requested change returns the work item to implementation. Architecture-changing findings require an Architecture Change Request.

## 20. Architectural non-goals

This version does not freeze:

- a specific cloud vendor;
- a specific CAD kernel implementation;
- a specific project engine;
- a specific graph database;
- a single AI provider/model;
- a specific CRDT implementation;
- a specific search engine;
- a specific deployment topology beyond the modular-monolith-first constraint.

Those choices remain adapter-level decisions unless later promoted into the architecture by ADR and architecture version change.
