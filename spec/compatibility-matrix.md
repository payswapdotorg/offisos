# ConstructionOS Compatibility Matrix

**Architecture version:** 1.0

Compatibility is judged by measurable workflows, not UI resemblance alone.

## 1. Office

| App | Candidate foundation | Initial status | Gate |
|---|---|---|---|
| Sheets | GenOffice/Univer-derived approach | Candidate | XLSX round-trip + construction-sheet benchmark |
| Docs | GenOffice-compatible approach | Candidate | DOCX round-trip benchmark |
| Slides | GenOffice-compatible approach | Candidate | PPTX benchmark |
| PDF | Open-source PDF engine + controlled patching | Candidate | render/edit benchmark |

## 2. Project

| Area | Candidate | Status | Gate |
|---|---|---|---|
| Scheduling | OpenProject or alternative | Research | PM benchmark + license composition |
| Gantt | Candidate engine | Research | workflow benchmark |
| Dependencies | Candidate engine | Research | deterministic schedule benchmark |
| Resource planning | Candidate engine | Research | construction resource benchmark |
| Cost integration | ConstructionOS domain | Frozen interface | graph/event integration |

OpenProject is currently GPLv3, so it is a technical/reference candidate pending legal/composition review.

## 3. CAD/BIM

| Area | Candidate | Status | Gate |
|---|---|---|---|
| CAD geometry | FreeCAD/OpenCascade or alternative | Research | CAD benchmark |
| BIM semantics | IfcOpenShell/IFC + platform BIM layer | Candidate | IFC benchmark |
| IFC I/O | IfcOpenShell | Candidate | semantic round-trip |
| IDS/BCF | IfcOpenShell/openBIM ecosystem | Candidate | interoperability benchmark |
| Quantity extraction | ConstructionOS quantity engine | Frozen interface | model→quantity benchmark |

## 4. Collaboration

| Capability | Candidate | Status | Gate |
|---|---|---|---|
| Docs/cells/presence | CRDT technology such as Yjs or equivalent | Candidate | convergence test |
| BIM object collaboration | versioned transactions | Frozen interface | conflict/lineage benchmark |
| Financial/procurement state | transactional approvals | Frozen interface | authorization/audit tests |

## 5. AI

| Layer | Candidate | Status |
|---|---|---|
| Routing provider | OpenRouter | Initial adapter |
| Direct models | OpenAI/Anthropic/Google/Z.ai | Adapters |
| Local inference | configurable | Adapter |
| Routing intelligence | ConstructionOS AI Router | Frozen architecture |

## 6. Compatibility acceptance standard

A candidate must satisfy:

1. representative workflow completion;
2. input/output file integrity;
3. semantic preservation;
4. performance thresholds;
5. security boundary;
6. license/composition approval;
7. maintainability and replacement path.
