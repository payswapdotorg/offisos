# Offisos — Construction Operating System

> One shared construction reality model, exposed through familiar professional tools and intelligent workflows.

- **Architecture:** v1.1, FROZEN — see [`spec/architecture.md`](spec/architecture.md) and [`spec/architecture-lock.md`](spec/architecture-lock.md).
- **Current implementation roadmap:** [`spec/roadmap-v1.1.md`](spec/roadmap-v1.1.md).
- **Historical v1.0 backlog:** [`spec/work-items.md`](spec/work-items.md) — retained for historical traceability while the current v1.1 roadmap is maintained separately.
- **Specification package:** [`spec/00-readme.md`](spec/00-readme.md) — architecture, requirements, work items, dependency graph, research plan.
- **Development governance:** [`governance/README.md`](governance/README.md) — the executable work-item lifecycle (state machine, evidence policy, Architect review), enforced by `tools/governance` on every pull request.

## Current product direction

The CAD/BIM product is being completed to a defined first-phase **complete-enough** boundary before broader ConstructionOS platform work proceeds. A later, separate program may pursue deeper AutoCAD and Archicad-class feature parity without blocking Project, Office, platform, Graph, collaboration, AI, or intelligence development.

Project/scheduling and Sheets/Office are independent implementation tracks and may proceed in parallel on separate branches. They integrate through the same Architecture v1.1 domain, application, event, persistence, and Construction Graph contracts.

## Quick start (governance tooling)

```bash
npm ci
npm test                                    # deterministic governance test suite
npm run governance -- validate              # validate all work-item records
npm run governance -- check-protected --base main
```

Node.js ≥ 20 is required.
