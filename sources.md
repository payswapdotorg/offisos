# ConstructionOS Specification Sources

The specification was informed by current public documentation/source material reviewed on 2026-08-24. URLs are recorded for traceability; implementation decisions must re-check licenses and current versions before dependency adoption.

## Development workflow

- WorkflowOS architecture: https://github.com/pectoraux/workflowos/blob/main/spec/architecture.md
- WorkflowOS requirements: https://github.com/pectoraux/workflowos/blob/main/spec/requirements.md
- WorkflowOS work items: https://github.com/pectoraux/workflowos/blob/main/spec/work-items.md
- WorkflowOS dependency graph: https://github.com/pectoraux/workflowos/blob/main/spec/dependency-graph.md
- WorkflowOS architecture lock: https://github.com/pectoraux/workflowos/blob/main/spec/architecture-lock.md

## GenOffice / office compatibility

- GenOffice repository: https://github.com/genspark-ai/genoffice
- GenOffice Sheets architecture: https://github.com/genspark-ai/genoffice/blob/main/apps/sheets/docs/architecture.md
- GenOffice Sheets compatibility: https://github.com/genspark-ai/genoffice/blob/main/apps/sheets/docs/compatibility.md
- Univer: https://github.com/dream-num/univer

## CAD/BIM/openBIM

- FreeCAD repository: https://github.com/FreeCAD/FreeCAD
- FreeCAD IFC/BIM documentation: https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Arch_IFC.md
- FreeCAD license: https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/License.md
- IfcOpenShell: https://github.com/IfcOpenShell/IfcOpenShell
- IfcOpenShell documentation: https://docs.ifcopenshell.org/
- buildingSMART standards overview: https://www.buildingsmart.org/standards/bsi-standards/

## Project/scheduling candidates

- OpenProject repository: https://github.com/opf/openproject
- OpenProject documentation: https://www.openproject.org/docs/user-guide/gantt-chart/

## Collaboration

- Yjs: https://github.com/yjs/yjs

## AI routing

- OpenRouter: https://openrouter.ai/
- OpenRouter provider routing: https://openrouter.ai/docs/guides/routing/provider-selection

## Important note

These links are research sources, not automatic dependency approvals. Before production use, perform license/version/security review for every dependency. In particular, GenOffice contains a distinct `ee/` licensing boundary; OpenProject is GPLv3; IfcOpenShell is LGPL-3.0-or-later while some surrounding IFC ecosystem components are GPL. The architecture deliberately uses adapters so we can avoid unwanted dependency lock-in.
