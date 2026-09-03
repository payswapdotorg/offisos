# ConstructionOS Current Roadmap — Architecture v1.1

**Architecture:** 1.1  
**Status:** Current roadmap for implementation; Architecture v1.1 itself remains FROZEN.  
**Authority:** Architecture rules are defined by `spec/architecture.md` and `spec/architecture-lock.md`. This document is the current implementation roadmap; `spec/work-items.md` is retained as the historical v1.0 backlog until a full administrative reconciliation is completed.

## Roadmap policy

The roadmap may evolve by adding explicit work items, but implementation must remain inside Architecture v1.1. Any change to frozen architecture requires an Architecture Change Request and a new architecture version.

Parallel implementation is explicitly supported. Independent product tracks may be developed on separate branches and merged through the normal governed lifecycle. Shared domain contracts, Construction Graph authority, versioning, worker isolation, and public APIs remain common integration boundaries.

Project/scheduling and Office work may proceed in parallel with the CAD/BIM track once their own dependency gates are satisfied. Parallel branches do not bypass dependency verification and are not merged directly into one another outside normal pull requests.

## 1. CAD/BIM product track

### Feasibility gates — complete

- RESEARCH-CAD-001 — engine candidate evaluation — **VERIFIED**
- RESEARCH-CAD-002 — deep CAD/BIM capability benchmark — **VERIFIED**
- RESEARCH-CAD-003 — IFC/BIM semantic interoperability — **VERIFIED**
- RESEARCH-CAD-004 — model → quantity prototype — **VERIFIED**
- RESEARCH-CAD-005 — performance/robustness gate — **VERIFIED**
- RESEARCH-CAD-006 — licensing/composition evidence — **VERIFIED**
- RESEARCH-CAD-007 — final adapter/replacement/existential feasibility — **VERIFIED**

### Production foundation — complete

- CAD-IMPLEMENT-001 — shared Web + Electron CAD/BIM shell — **VERIFIED**
- CAD-IMPLEMENT-002 — real OCCT geometry engine — **VERIFIED**
- CAD-IMPLEMENT-003 — revision / Graph integration foundation — **VERIFIED**

### Compatibility/product milestones — complete enough baseline

- COMPAT-CAD-001 — 2D drafting — **VERIFIED**
- COMPAT-CAD-002 — 3D/BIM authoring — **VERIFIED**
- COMPAT-CAD-003 — construction documentation — **VERIFIED**
- COMPAT-IFC-001 — production IFC/openBIM — **VERIFIED**
- COMPAT-BIM-003 — reusable parametric components/materials/coordination — **VERIFIED**

### P018 — specialized professional toolsets — complete

- CAD-PARITY-018 / **P018** — specialized Architecture, MEP, Mechanical & Raster toolsets — **VERIFIED**

P018 is the specialized-toolset expansion milestone. It adds bounded professional Architecture, MEP, Mechanical and Raster/underlay capabilities without changing ConstructionOS Architecture v1.1 or the established CAD/BIM product architecture. Specialized capabilities remain modular and must not distort the core architecture. fileciteturn120file0

### Pre-certification product hardening — active

- COMPAT-CAD-004 — bounded parametric constraints, associative drafting, reusable 2D symbols/blocks, and deterministic mirror/array/pattern operations.

`COMPAT-CAD-004` is treated as a bounded product-hardening slice between the VERIFIED P018 specialized-toolset baseline and the parity-certification program. It is not itself a parity certification and does not authorize an architecture change.

### P019 — AutoCAD parity certification

- **P019 / CAD-PARITY-019** — AutoCAD parity certification.

P019 is **not another feature sprint**. It is a certification program against a representative professional workflow corpus. Certification must evaluate integrated workflows across:

- semantics and behavioral fidelity;
- persistence and round-trip durability;
- real UI task completion;
- interoperability and explicit EXACT/LOSSY/UNSUPPORTED behavior; and
- performance/robustness.

Feature checklists alone do not constitute parity certification. The certification result must be evidence-backed, revision-bound and reproducible under the governance lifecycle.

P019 depends on the VERIFIED P018 baseline and completion/verification of the bounded pre-certification hardening needed to exercise the representative AutoCAD workflow corpus.

### P020 — Archicad parity certification

- **P020 / CAD-PARITY-020** — Archicad parity certification.

P020 uses the same certification principle against an Archicad-class BIM/documentation workflow corpus. The goal is to prove an integrated professional BIM/documentation workflow rather than merely verify that individual commands exist.

Certification must cover, at minimum:

- BIM/document semantics and behavioral fidelity;
- persistence and document round-trip durability;
- real UI workflow completion;
- interoperability and explicit EXACT/LOSSY/UNSUPPORTED behavior; and
- performance/robustness across representative workflows.

P020 depends on the certified P019 baseline where shared CAD workflow infrastructure is involved and must preserve Architecture v1.1 and the Construction Graph / CADDocument / engine-worker boundaries.

### CAD/BIM professional boundary

After **P020 is VERIFIED**, the initial CAD/BIM professional-complete milestone is established. CAD/BIM feature expansion then pauses as a primary product-program focus while the broader ConstructionOS platform is built.

Later CAD/BIM expansion remains a separate, non-blocking program. Deeper AutoCAD or Archicad-class feature work after P020 must be justified by benchmark-defined gaps and measurable fidelity/performance targets, and must not block Project, Office, platform, Graph, collaboration, AI or intelligence development.

## 2. Project / scheduling track

### Feasibility

- RESEARCH-PM-001 — evaluate project/scheduling engines and licensing/composition — **parallel track**
- RESEARCH-PM-002 — schedule/Construction Graph integration prototype

### Product

- COMPAT-PM-001 — construction project baseline (WBS, activities, calendars, dependencies, critical path, baseline)
- COMPAT-PM-002 — resources, progress, delay/change impacts

The Project product is implemented on its own branch but integrates into the same Architecture v1.1 shared application/domain topology. The existing `work/research-pm-001-project-engine` branch is treated as legacy/stale research infrastructure unless its actual implementation work is independently verified; local-only Project work must be imported through a governed work item before merge.

## 3. Office / Sheets track

### Feasibility

- RESEARCH-OFFICE-001 — compatibility patterns and source-preservation analysis

### Product

- COMPAT-SHEET-001 — construction-ready spreadsheet baseline
- COMPAT-DOC-001 — DOCX project/specification baseline
- COMPAT-OFFICE-001 — Slides/PDF baseline

The Sheets implementation may proceed in parallel with CAD/BIM and Project on its own branch. It must consume shared domain contracts for construction-aware behavior rather than creating a separate domain store.

## 4. Core platform

Once the first Project/Sheets baselines are independently verified enough to exercise shared services, implement the cross-application platform in dependency order:

1. PLATFORM-001 — modular-monolith foundation, workers and observability
2. PLATFORM-002 — identity and tenant isolation
3. PLATFORM-003 — persistence and artifact storage
4. PLATFORM-004 — versioning, lineage and audit
5. PLATFORM-005 — durable domain events
6. PLATFORM-006 — unified application shell

The CAD/BIM Web/Electron topology remains a specialized client topology inside this shared platform; it does not become a separate product architecture.

## 5. Construction Graph and collaboration

- GRAPH-001 — canonical domain model
- COLLAB-001 — collaboration foundation
- COLLAB-002 — collaborative Docs/Sheets editing
- COLLAB-003 — transactional BIM/Estimate/RFQ collaboration

The Construction Graph remains the authoritative project/asset model. CADDocument, Project documents, spreadsheets and other application documents remain working/editor representations mapped through explicit domain contracts/events.

## 6. AI and Tool Intelligence

After platform foundations are operational:

- AI-001 — provider-independent AI Gateway
- AI-002 — OpenRouter routing
- AI-003 — direct/local model adapters
- AI-004 — governed agent runtime/tool contracts
- AI-005 — model evaluation ledger
- TOOL-001 — universal capability registry

Domain agents must use the same domain APIs as users and external applications and must never bypass authorization/versioning/evidence boundaries.

## 7. Knowledge, uncertainty and learning

- KNOW-001 — knowledge/evidence foundation
- UNKNOWN-001 — Unknown Resolution Engine
- UNKNOWN-002 — value-of-information recommendations
- TIME-001 — temporal store and historical replay
- TIME-002 — walk-forward/backtest engine
- LAB-001 — Construction Lab
- LAB-002 — Prediction Ledger/calibration

## 8. Cost, procurement and commercial intelligence

- COST-001 — quantities/estimate service
- COST-002 — probabilistic cost/risk
- RFQ-001 — RFQ scope engine
- RFQ-002 — external subcontractor participation
- RFQ-003 — bid normalization/leveling
- RFQ-004 — subcontractor performance intelligence
- BID-001..003 — tender analysis, win probability, risk-adjusted optimization

These consume model/quantity/project data through the Construction Graph and event contracts rather than through CAD-specific internal APIs.

## 9. Construction and maintenance intelligence

- INTEL-001 — Junior Professional Mode
- INTEL-002 — design alternative analysis
- INTEL-003 — construction copilot
- INTEL-004 — condition assessment
- INTEL-005 — lifecycle maintenance optimization

## 10. Extensions and Public API

- EXT-001 — Extension SDK
- EXT-002 — extension sandbox/security
- API-001 — public domain API
- API-002 — webhooks, async jobs and SDKs

## 11. Full-system benchmarks

- BENCH-001 — model → quantity → estimate → RFQ → bids → optimized tender
- BENCH-002 — inspection → diagnosis → maintenance → lifecycle → learning

## Integration rules for parallel development

1. Separate feature branches are allowed and encouraged for genuinely independent tracks.
2. A branch must merge only through its own governed work item and PR.
3. Shared code is integrated through stable domain/application contracts, not branch-to-branch coupling.
4. A dependent work item cannot enter execution until its declared dependencies are `VERIFIED`.
5. Architecture v1.1 remains frozen throughout this roadmap.
6. CAD/BIM professional completeness is established by the P018 specialized-toolset milestone plus the P019 and P020 certification gates; it is a product milestone, not an architectural boundary.
7. Later AutoCAD/Archicad parity expansion after P020 is separate and non-blocking; it does not replace or delay the broader ConstructionOS roadmap.
