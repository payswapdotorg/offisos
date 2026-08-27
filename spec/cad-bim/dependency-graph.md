# CAD/BIM Parity Dependency Graph v1.0

```text
CAD-P-001/002/003/004
        │
        ├──────────────┐
        ▼              ▼
   CAD-2D core     CAD-BIM core
        │              │
        ├──────┬───────┘
        ▼      ▼
   CAD constraints / associative model
        │
        ▼
  blocks + references + modify system
        │
        ▼
  3D geometry / parametric modeling
        │
        ├──────────────┐
        ▼              ▼
 documentation    BIM coordination
        │              │
        └──────┬───────┘
               ▼
         IFC/openBIM
               │
               ▼
      schedules / quantities
               │
               ▼
     Construction Graph
               │
       ┌───────┼────────┐
       ▼       ▼        ▼
     Cost    Project    RFQ
```

## Work-item DAG

| ID | Work item | Depends on |
|---|---|---|
| CAD-PARITY-001 | Product architecture + UI freeze | Architecture v1.1, verified CAD/BIM foundation |
| CAD-PARITY-002 | Command/selection/input foundation | 001 |
| CAD-PARITY-003 | Professional 2D primitives + modify system | 002 |
| CAD-PARITY-004 | Layers/styles/properties/palettes | 002, 003 |
| CAD-PARITY-005 | Annotation/dimension/hatch system | 003, 004 |
| CAD-PARITY-006 | Blocks/attributes/dynamic blocks/xrefs | 003, 004, 005 |
| CAD-PARITY-007 | Constraint/associativity engine | 003, 005, 006 |
| CAD-PARITY-008 | Layout/plot/publishing system | 005, 006 |
| CAD-PARITY-009 | 3D navigation/UCS/modeling | 003, 007 |
| CAD-PARITY-010 | Surface/solid/boolean/section toolset | 009 |
| CAD-PARITY-011 | BIM authoring expansion | 009, 010 |
| CAD-PARITY-012 | Components/materials/coordination expansion | 011 |
| CAD-PARITY-013 | Documentation/view/sheet parity expansion | 005, 008, 011, 012 |
| CAD-PARITY-014 | IFC/BCF/IDS production interoperability | 011, 012, 013 |
| CAD-PARITY-015 | schedules/quantity/property/index workflows | 011, 013, 014 |
| CAD-PARITY-016 | collaboration/recovery/large-model UX | 002-015 incrementally |
| CAD-PARITY-017 | automation/extensions/API | 002-016 |
| CAD-PARITY-018 | specialized Architecture/MEP/Mechanical/Raster toolsets | 003-017 as applicable |
| CAD-PARITY-019 | AutoCAD workflow parity certification | 002-018 |
| CAD-PARITY-020 | Archicad workflow parity certification | 011-018 |

Nothing depends on Project, Sheets, Cost or RFQ implementation to complete core CAD/BIM parity. Those systems consume the canonical Graph/domain outputs after the relevant CAD/BIM contracts stabilize.
