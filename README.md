# Offisos — Construction Operating System

> One shared construction reality model, exposed through familiar professional tools and intelligent workflows.

- **Architecture:** v1.1, FROZEN — see [`spec/architecture.md`](spec/architecture.md) and [`spec/architecture-lock.md`](spec/architecture-lock.md).
- **Current implementation roadmap:** [`spec/roadmap-v1.1.md`](spec/roadmap-v1.1.md).
- **Historical v1.0 backlog:** [`spec/work-items.md`](spec/work-items.md) — retained for historical traceability while the current v1.1 roadmap is maintained separately.
- **Specification package:** [`spec/00-readme.md`](spec/00-readme.md) — architecture, requirements, work items, dependency graph, research plan.
- **Development governance:** [`governance/README.md`](governance/README.md) — the executable work-item lifecycle (state machine, evidence policy, Architect review), enforced by `tools/governance` on every pull request.

## Current product direction

The CAD/BIM product is being completed to a defined first-phase **complete-enough** boundary before broader ConstructionOS platform work proceeds. The full-parity program ([`spec/cad-bim/roadmap.md`](spec/cad-bim/roadmap.md), product architecture v1.0 FROZEN under ConstructionOS v1.1) drives toward AutoCAD-class drafting and Archicad-class BIM workflow parity.

**CAD-PARITY-002 (in progress)** delivers the professional workspace foundation: a command-first shell (application menu, contextual ribbon, tool palettes, command line with prompt state, command search/aliases/shortcuts, status bar with drafting-aid toggles), a command-driven Model viewport (crosshair, coordinate readout, snapping, ortho/polar/tracking feedback, window/crossing selection, cycling, grips, contextual mini-toolbar) and the shared command/selection/input core that makes Web and Electron produce equivalent semantic command streams — proven in CI against a pinned parity fixture. Later parity items extend the registry additively (2D primitives/modify, layers/styles, annotation, blocks, constraints, 3D, BIM expansion, documentation, interoperability).

Project/scheduling and Sheets/Office are independent implementation tracks and may proceed in parallel on separate branches. They integrate through the same Architecture v1.1 domain, application, event, persistence, and Construction Graph contracts.

## Quick start (governance tooling)

```bash
npm ci
npm test                                    # deterministic governance test suite
npm run governance -- validate              # validate all work-item records
npm run governance -- check-protected --base main
```

Node.js ≥ 20 is required.
