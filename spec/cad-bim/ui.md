# CAD/BIM Professional UI Specification v1.0

## Workspace anatomy

The default desktop and Web workspace uses the same semantic information architecture:

```text
┌ Menu / File / Edit / View / Insert / Annotate / Manage / BIM / Document / Help ┐
├ Ribbon / Toolbars / Command Search / Workspace Presets                         ┤
│ ┌───────┐ ┌──────────────────────── Canvas / Model / Layout Tabs ────────────┐ │
│ │ Tools │ │                                                                    │ │
│ │Palette│ │       2D drafting / 3D model / sheet / schedule workspace          │ │
│ │       │ │                                                                    │ │
│ └───────┘ └────────────────────────────────────────────────────────────────────┘ │
│                 ┌ Properties / Layers / Navigator / Components ┐                 │
├ Command Line / Prompt / Selection / Constraint / Warning Area ─────────────────┤
├ Coordinates | UCS | Snap | Grid | Ortho | Polar | Units | Scale | LWT | Status ┤
└──────────────────────────────────────────────────────────────────────────────────┘
```

Web may compress panels responsively; Electron may expose richer OS menus and multi-window behavior. Semantic commands, selection, editing and file state remain shared.

## Interaction principles

1. Every core operation is available from visible UI and command search.
2. Core operations expose keyboard shortcuts and aliases.
3. Selected objects expose grips/handles and context actions.
4. Properties can be edited directly with explicit validation.
5. Tool activation shows prompts, required inputs and cancellation behavior.
6. Snapping and coordinate feedback are visible while drawing.
7. Modal dialogs are minimized; palettes/context panels handle repeated workflows.
8. Long operations expose progress and cancellation through worker termination where needed.
9. Errors are actionable and never silently converted into approximations.
10. The UI remembers workspace preferences without making them authoritative project state.

## AutoCAD familiarity targets

The command-line interaction model, ribbon/palette organization, Properties-style object inspection, layer workflow, blocks palette, xref management, model/paper-space concepts, layouts and plotting are deliberate familiarity targets. AutoCAD's official foundations describe command line/dynamic input, basic precision drawing, properties/layers, annotations, blocks and layouts as core workflows. citeturn392667search5

## Archicad familiarity targets

The Navigator/Project Map, Story/Level navigation, viewpoint tabs, 3D window, Layout Book and Publisher concepts form the BIM/documentation side of the workspace. Archicad's current documentation identifies Navigator, Stories, Sections/Elevations/Details/3D, Schedules and Project Indexes as integrated navigation structures. citeturn328058search8turn328058search9

## Accessibility

Keyboard navigation, focus indicators, readable command feedback, scalable UI density and accessible names are required. Accessibility must not disable expert command-driven workflows.

## Responsive behavior

The Web client must remain usable at laptop and tablet widths. Narrow screens collapse secondary palettes behind drawers but retain command search, active tool, canvas, properties and essential status information.

## UI acceptance evidence

Every parity work item includes a browser/desktop task script that measures:

- task success;
- command discoverability;
- number of interaction steps;
- coordinate/geometry correctness;
- undo/recovery;
- semantic result equality;
- runtime/console errors;
- viewport/render stability.
