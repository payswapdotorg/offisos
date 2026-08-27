# CAD/BIM Product Architecture v1.0 — Lock

**Status: FROZEN**  
**Parent:** ConstructionOS Architecture v1.1 (FROZEN)  
**Scope:** CAD/BIM product internals and user experience; subordinate to the platform architecture.

## Invariants

1. **Construction Graph authority.** CADDocument is an editor representation, never the project/asset system of record.
2. **Engine independence.** Renderer, CADDocument, App API and engine-free domain code must not import OCCT, FreeCAD, IfcOpenShell or file-format internals.
3. **Adapter boundary.** Native geometry/BIM/file capabilities are accessed only through explicit contracts and workers.
4. **Web/Electron semantic parity.** The same command/query contracts and canonical state produce equivalent semantic results in both hosts.
5. **Deterministic identity.** Canonical IDs are stable and never derived from engine IDs, memory addresses or rendering order.
6. **Deterministic regeneration.** Derived geometry, constraints, documentation and analysis outputs are reproducible from canonical inputs.
7. **Versioned editing.** User-visible semantic mutations flow through the existing immutable revision/history model.
8. **Explicit uncertainty.** Unsupported, ambiguous, over-constrained, unsatisfied and lossy operations are typed and surfaced; no silent approximation.
9. **Professional workspace.** The Web/Electron UI must support command search, keyboard shortcuts, contextual tools, palettes/inspectors, multi-view workflows and high-density drafting interactions.
10. **Progressive disclosure.** Beginner affordances may simplify access, but expert workflows must remain directly reachable.
11. **Open interoperability.** IFC/BCF/IDS/DXF/PDF and other appropriate open standards are first-class boundaries; proprietary formats use adapters.
12. **No parity by cloning.** Feature parity means equivalent user outcomes and interoperability, never copied source code, private APIs, proprietary algorithms or protected assets.
13. **Capability gating.** A feature is only marked supported after a deterministic acceptance test exists for the declared scope.
14. **Performance budgets.** Each high-cost operation has measurable latency, memory and cancellation behavior and may be moved to an isolated worker without changing domain contracts.
15. **Host-local state is non-authoritative.** UI selection, camera, hover, transient tool state and caches must never become project truth.
16. **Backward compatibility.** Existing CAD/BIM/documentation/IFC histories and snapshots remain readable unless a migration is explicitly versioned and tested.
17. **Scope containment.** CAD parity work may expand the product feature set, but may not alter the parent ConstructionOS architecture without an ACR.
18. **UI is product surface.** A feature is incomplete for parity purposes until both its semantic behavior and its primary user interaction are implemented and tested on the Web host; equivalent Electron behavior is required for desktop-scoped features.

## Freeze procedure

A change to this lock requires a new CAD/BIM product architecture version and an architectural decision recorded against the parent ConstructionOS governance process. Feature additions that satisfy this lock do not change the architecture version.
