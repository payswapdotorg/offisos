# ConstructionOS Dependency Graph

**Architecture version:** 1.0

The graph is intentionally clone-first. Downstream intelligence work depends on the professional application and shared-data foundation proving viable.

## 1. Primary graph

```text
ARCH-WF-001
  │
  ├── ARCH-WF-002
  │      │
  │      └── PLATFORM-001
  │              │
  │              ├── PLATFORM-002
  │              ├── PLATFORM-003
  │              └── PLATFORM-005
  │
  ├── RESEARCH-CAD-001
  │      │
  │      ├── RESEARCH-CAD-002
  │      ├── RESEARCH-CAD-003
  │      │      └── RESEARCH-CAD-004
  │      │             └── RESEARCH-CAD-005
  │      ├── RESEARCH-CAD-006
  │      └── RESEARCH-CAD-007
  │             ├── COMPAT-CAD-001
  │             │      └── COMPAT-BIM-001
  │             │             └── COMPAT-IFC-001
  │             └── COMPAT-BIM-001
  │
  ├── RESEARCH-PM-001
  │      └── RESEARCH-PM-002
  │             └── COMPAT-PM-001
  │                    └── COMPAT-PM-002
  │
  └── LICENSE-001
         └────────────┬───────────────────────────────┐
                      │                               │
              RESEARCH-OFFICE-001                RESEARCH-PM-001
                      │                               │
         ┌────────────┼─────────────┐                 │
         ▼            ▼             ▼                 │
 COMPAT-SHEET-001 COMPAT-DOC-001 COMPAT-OFFICE-001   │
         │            │             │                 │
         └────────────┴──────┬──────┘                 │
                             ▼                        │
                      PLATFORM-006 ◄─────────────────┘
                             │
                             ▼
                         GRAPH-001
                             │
                      ┌──────┴──────────────┐
                      ▼                     ▼
                 COLLAB-001             COST-001
                      │                     │
              ┌───────┴───────┐             ▼
              ▼               ▼         COST-002
          COLLAB-002      COLLAB-003       │
              │               │            ├───────────────┐
              ▼               ▼            ▼               ▼
          OFFICE APPS      DOMAIN      RFQ-001          BID-001
                                     │   │   │              │
                                     │   ▼   ▼              ▼
                                     │ RFQ-002 RFQ-003    BID-002
                                     │         │              │
                                     │         ▼              ▼
                                     │      RFQ-004        BID-003
                                     │         │              │
                                     │         ▼              ▼
                                     │      RFQ-005        LAB-001
                                     │         │              │
                                     │         ▼              ▼
                                     └────── RFQ-007       LAB-002

AI-001 → AI-002 → AI-003
   │        │
   └──────→ AI-004 → TOOL-001
                         │
                         └────────→ extensions

KNOW-001 → UNKNOWN-001 → UNKNOWN-002
   │                         │
   └──────────────→ TIME-001 ┴→ TIME-002 → TIME-004 → LAB-001

COST-002 + BID-003 + COMPAT-IFC-001 + RFQ-004 → BENCH-001
INTEL-005 + LAB-002 → BENCH-002
```

## 2. Development waves

### Wave 0

`ARCH-WF-001, ARCH-WF-002, LICENSE-001`

### Wave 1 — Existential clone gates

`RESEARCH-CAD-001, RESEARCH-PM-001, RESEARCH-OFFICE-001`

### Wave 2 — Deep compatibility proof

`RESEARCH-CAD-002..006, RESEARCH-CAD-007, RESEARCH-PM-002`

### Wave 3 — First implementations

`COMPAT-CAD-001, COMPAT-BIM-001, COMPAT-IFC-001, COMPAT-PM-001, COMPAT-SHEET-001, COMPAT-DOC-001, COMPAT-OFFICE-001`

### Wave 4 — Platform

`PLATFORM-001..006, GRAPH-001, COLLAB-001..003`

### Wave 5 — Intelligence substrate

`AI-001..005, TOOL-001, KNOW-001, UNKNOWN-001..002, TIME-001`

### Wave 6 — Commercial intelligence

`COST-001..002, RFQ-001..004, BID-001..003, TIME-002, LAB-001..002`

### Wave 7 — Domain intelligence

`INTEL-001..005`

### Wave 8 — Ecosystem and final benchmarks

`EXT-001..002, API-001..002, BENCH-001..002`

## 3. Parallelism rules

Independent research/compatibility work may proceed in parallel only if it shares no mutable implementation boundary and does not assume an unresolved architecture decision.

CAD/BIM and Project research may proceed in parallel.

Office compatibility may proceed in parallel with CAD research after the licensing boundary is established.

Cost/RFQ implementation must not begin before the canonical graph and quantity contracts are accepted.

Bid intelligence must not begin before cost and temporal replay foundations are accepted.

## 4. Blocking conditions

A downstream work item is blocked if:

- its required architecture contract is unresolved;
- a dependency is not VERIFIED;
- a required compatibility gate failed;
- security/licensing review is unresolved where relevant;
- required acceptance criteria are ambiguous.
