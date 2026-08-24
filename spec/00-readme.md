# ConstructionOS — Specification Package

**Architecture Version:** 1.0
**Status:** FROZEN
**Working product codename:** ConstructionOS
**Purpose:** Authoritative architecture, requirements, implementation work plan, dependency graph, and development governance for the Construction Operating System.

## What this folder is

This folder is the implementation contract. It intentionally follows the development discipline used by WorkflowOS: architecture is frozen before implementation; requirements and work items trace back to that architecture; dependencies determine eligibility; verification requires evidence; and architecture changes require an explicit change request and a new architecture version.

WorkflowOS itself describes this pattern as: frozen architecture → requirements/work items → agent implementation → automated verification → independent architect review → merge. It also requires evidence rather than implementation claims and provider-independent LLM/agent gateways. See the WorkflowOS sources listed in `sources.md`.

## What is frozen now

The architecture freezes the **interfaces, domain boundaries, invariants, and external-engine abstraction strategy**. It does not freeze a specific CAD kernel, project-management engine, AI provider, collaboration implementation, cloud vendor, or graph database when those choices remain behind an explicit adapter contract.

This is deliberate. The project can start development while high-risk compatibility candidates are still being proven through bounded feasibility work items.

## Product mission

Build a globally adaptable Construction Operating System that gives construction professionals the tools, knowledge, intelligence, collaboration infrastructure and APIs required to design, estimate, tender, procure, build, inspect, maintain and continuously improve buildings and construction projects.

## Architectural thesis

> One shared construction reality model, exposed through familiar professional applications and intelligent workflows.

The system is not a collection of disconnected applications. CAD/BIM, Sheets, Docs, Project, RFQ, Cost, Inspection, Maintenance and Intelligence all operate on shared versioned domain objects and communicate through explicit APIs/events.

## First implementation priority

1. CAD/BIM feasibility and compatibility foundation.
2. Project/scheduling feasibility and compatibility foundation.
3. Office compatibility foundation (Sheets/Docs first).
4. Unified application shell and shared project graph.
5. Platform foundations: tenancy, permissions, versioning, eventing, storage.
6. AI Gateway and multi-model routing.
7. Construction intelligence: quantities, cost, RFQ/subcontractor, bid.
8. Construction Lab and Time Machine.
9. Engineering/construction/maintenance intelligence.
10. Extension ecosystem and public API maturation.

## Development roles

**Project Architect / Reviewer:** ChatGPT. Owns architecture, requirements, work-item decomposition, architecture review, acceptance evidence review, and architecture-change control.

**Implementer:** Z.ai. Implements only assigned work items against the frozen architecture and returns objective evidence.

**Product Owner / Final Authority:** User. Owns product direction, business priorities, major trade-offs and approval of architecture changes.

## Do not bypass

No implementation should begin for a domain whose prerequisite architecture contract or feasibility gate is unresolved. No implementation agent may change `architecture.md` or `architecture-lock.md` directly.

## Core files

- `architecture.md` — frozen system architecture.
- `architecture-lock.md` — immutable architectural rules and invariants.
- `requirements.md` — traceable product/technical requirements and acceptance criteria.
- `work-items.md` — bounded implementation/research backlog.
- `dependency-graph.md` — implementation eligibility and sequencing.
- `domain-model.md` — canonical domain entities and relationships.
- `data-model.md` — persistence and versioning rules.
- `event-model.md` — domain event contracts.
- `ai-routing.md` — provider-independent AI architecture.
- `api-contract.md` — public/internal domain API boundary.
- `extension-sdk.md` — extension model and security contract.
- `compatibility-matrix.md` — compatibility applications and engine candidates.
- `security-tenancy.md` — tenancy, permissions and data isolation.
- `temporal-model.md` — Time Machine and historical replay.
- `research-plan.md` — feasibility gates and evidence plans.
- `development-workflow.md` — the WorkflowOS-derived implementation/review process.
- `adr/` — architecture decision records.

## Definition of “ready to implement”

A work item is ready when:

- all dependencies are satisfied;
- the required architecture version is identified;
- acceptance criteria are explicit;
- verification method is explicit;
- expected evidence is explicit;
- out-of-scope behavior is explicit;
- no unresolved architecture ambiguity blocks implementation.
