# Offisos — Construction Operating System

> One shared construction reality model, exposed through familiar professional tools and intelligent workflows.

- **Architecture:** v1.0, FROZEN — see [`spec/architecture.md`](spec/architecture.md) and [`spec/architecture-lock.md`](spec/architecture-lock.md).
- **Specification package:** [`spec/00-readme.md`](spec/00-readme.md) — architecture, requirements, work items, dependency graph, research plan.
- **Development governance:** [`governance/README.md`](governance/README.md) — the executable work-item lifecycle (state machine, evidence policy, Architect review), enforced by `tools/governance` on every pull request.

## Quick start (governance tooling)

```bash
npm ci
npm test                                    # deterministic governance test suite
npm run governance -- validate              # validate all work-item records
npm run governance -- check-protected --base main
```

Node.js ≥ 20 is required.
