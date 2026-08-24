# ConstructionOS Research and Feasibility Plan

**Architecture version:** 1.0

The architecture is frozen around interfaces and invariants. This document identifies research questions that must be resolved through evidence without forcing a redesign unless a true architecture change is required.

## Gate R1 — CAD/BIM foundation

Question: Can FreeCAD/OpenCascade/IfcOpenShell or another candidate support the required professional CAD/BIM workflows and interoperability?

Evidence:

- 2D drafting benchmark;
- 3D geometry benchmark;
- parametric BIM benchmark;
- IFC import/export/round-trip;
- quantity extraction;
- model performance;
- licensing/composition analysis.

Pass condition: minimum thresholds in `compatibility-matrix.md` are met and the engine can live behind the frozen adapter boundary.

## Gate R2 — Project engine

Question: Can an open-source or native scheduling foundation provide the required construction scheduling workflows without unacceptable license/composition constraints?

Evidence:

- WBS;
- calendars;
- dependencies;
- critical path;
- baselines;
- resources;
- progress;
- delays;
- cost links;
- API/embedding model;
- license review.

## Gate R3 — Office compatibility

Question: Can we preserve enough real-world XLSX/DOCX/PPTX/PDF fidelity for the ICP's daily workflows?

Evidence:

- representative fixture corpus;
- round-trip structural comparisons;
- visual comparisons;
- large-file tests;
- formula preservation;
- macros/unsupported feature behavior defined.

## Gate R4 — Collaboration

Question: Can one project support concurrent work across heterogeneous applications without destructive conflicts?

Evidence:

- Docs/Sheets concurrency;
- BIM object conflicts;
- estimate/RFQ concurrency;
- offline/reconnect behavior;
- audit/lineage tests.

## Gate R5 — AI routing

Question: Can provider-independent routing improve quality/cost/latency while remaining observable and policy-compliant?

Evidence:

- multi-provider benchmark;
- cost/latency dashboard;
- fallback tests;
- privacy policy enforcement;
- model-quality calibration.

## Gate R6 — Time Machine

Question: Can historical replay prevent future leakage and reproduce past model decisions?

Evidence:

- adversarial leakage suite;
- walk-forward replay;
- prediction ledger;
- reproducibility test.

## Gate R7 — Extension sandbox

Question: Can third-party capabilities extend domain functionality without weakening tenant/security boundaries?

Evidence:

- capability registration;
- permission tests;
- network isolation;
- revocation;
- version compatibility.

## Gate R8 — Public API

Question: Can external developers use domain capabilities without knowing our internal implementation?

Evidence:

- SDK examples;
- asynchronous jobs;
- webhooks;
- idempotency;
- error semantics;
- cross-app consistency.

## Research outcome rule

A failed feasibility gate does not imply project failure. It must produce one of:

1. candidate rejected and next candidate selected behind same adapter;
2. scope reduced without architecture change;
3. architecture change request;
4. requirement explicitly deferred.
