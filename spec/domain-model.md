# ConstructionOS Domain Model

**Architecture version:** 1.0

## 1. Core hierarchy

```text
Tenant
└── Organization
    ├── Team
    ├── User Memberships
    └── Project
        ├── Site
        ├── Building / Asset
        │   ├── Model
        │   │   ├── ModelVersion
        │   │   └── Element
        │   ├── Spaces
        │   ├── Systems
        │   └── Asset Components
        ├── Documents / Drawings / Specifications
        ├── Quantities
        ├── Estimates / Cost Items
        ├── RFQs
        │   ├── Scope Packages
        │   └── Subcontractor Bids
        ├── Schedule / Tasks / Resources
        ├── Inspections / Tests / Conditions / Defects
        ├── Maintenance Actions
        ├── Risks / Decisions / Assumptions
        ├── Scenarios
        └── Predictions / Outcomes
```

## 2. Entity principles

Every authoritative entity supports:

- stable ID;
- tenant/project ownership;
- version/lineage;
- lifecycle state;
- provenance where relevant;
- permissions;
- created/updated timestamps;
- links to source inputs and derived outputs where relevant.

## 3. Model and BIM entities

`Model` represents an authored/managed model source.

`ModelVersion` is an immutable version/snapshot.

`Element` is a canonical construction/BIM object independent of editor implementation.

Elements may include:

- wall;
- slab;
- floor;
- roof;
- door;
- window;
- column;
- beam;
- foundation;
- pipe;
- duct;
- equipment;
- space;
- site object.

The element carries semantic properties; geometry can be delegated to CAD/BIM engines.

## 4. Quantity entities

A `Quantity` records a measurable property derived from one or more model elements under an explicit calculation method and engine version.

A quantity must be traceable to:

- model version;
- element IDs;
- measurement rule;
- units;
- calculation engine/version;
- assumptions.

## 5. Estimate entities

An `Estimate` contains versioned `CostItem` objects. Each item may have:

- quantity source;
- rate source;
- labor/material/equipment components;
- productivity assumptions;
- uncertainty distribution;
- supplier/subcontractor quotes;
- provenance.

## 6. RFQ entities

An `RFQ` contains one or more scoped packages. A package may be sent to many recipients.

A `SubcontractorBid` is a structured bid independent of the original submission format.

The source PDF/XLSX/native submission remains an artifact linked to the structured bid.

## 7. Schedule entities

A `Schedule` contains:

- WBS nodes;
- tasks;
- calendars;
- dependencies;
- resources;
- baselines;
- progress snapshots.

## 8. Inspection/asset entities

`Inspection` → `Test` → `Finding` → `ConditionAssessment` → `Defect` → `Recommendation` → `MaintenanceAction`.

Each assessment carries evidence and uncertainty metadata.

## 9. Decision/evidence entities

`Decision` stores:

- question/objective;
- alternatives;
- selected option;
- rationale;
- evidence;
- assumptions;
- confidence/uncertainty;
- approver(s).

`Evidence` stores source/provenance information and may point to documents, test results, calculations, historical cases, models or expert observations.

## 10. Prediction entities

`Prediction` is immutable once issued. A later `PredictionOutcome` resolves it.

This is required for calibration and Time Machine integrity.

## 11. Scenario entities

`Scenario` contains a baseline plus controlled changes such as price changes, schedule delays, design alternatives, supplier changes or climate assumptions.

## 12. Extension entities

An `Extension` registers capabilities, permissions, version, compatibility and security metadata.

Extensions interact through domain APIs and events.
