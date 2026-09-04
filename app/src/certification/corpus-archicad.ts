/**
 * CAD-PARITY-020 (Issue #123) — the version-pinned Archicad-class
 * BIM/documentation workflow corpus + reference expectations. THE FIRST
 * P020 DELIVERABLE (the certification-first execution rule: this corpus
 * is defined and version-pinned BEFORE any certification evidence is
 * produced — every later certification claim is measured against THIS
 * artifact).
 *
 * Reference basis (learned from the P019 architect review — rev 2 of the
 * AutoCAD corpus — and applied HERE FROM THE START): the reference basis
 * is INDEPENDENTLY AUDITABLE — every workflow and every expectation is
 * bound to a version-pinned AUTHORITATIVE GRAPHISOFT SOURCE through the
 * reference manifest below (URL + document path + the specific
 * tool/topic scope, included in the corpus digest). Graphisoft documents
 * Archicad 27 as a TOOL+WORKFLOW application with NO command-line
 * interface: therefore every Offisos surface this corpus drives is
 * EXPLICITLY modeled as a semantic analog (the analog map below — bound
 * to the Graphisoft-documented tool/workflow it is the analog OF, never
 * presented as an Archicad command name; the closed partition is enforced
 * by the app-suite invariant test: every command-line name the
 * certification invokes must be an analog entry).
 *
 * What this module is:
 *  - a REPRESENTATIVE corpus of integrated Archicad-class BIM and
 *    documentation workflows (not a feature checklist — each workflow is
 *    a multi-phase task a BIM professional actually performs: the virtual
 *    building model, the zone program, the documentation model views, the
 *    layout book, the publisher, the interactive schedules, the IFC
 *    exchange, the teamwork/change workflow), composed from the VERIFIED
 *    P011..P018 + P019-baseline surfaces through the REAL command
 *    registry and the governed App API;
 *  - VERSION-PINNED against Graphisoft Archicad 27 (INT) — the declared
 *    reference behavior written out per workflow so the certification
 *    measures against DOCUMENTED expectations, never vibes;
 *  - executable: the P019 certification engine (engine.ts) compiles each
 *    phase's command-line script through the SHARED prompt-engine command
 *    registry, executes the emitted App API stream through a driver, and
 *    assesses the result against the declared expectations;
 *  - honest: every expectation carries an explicit expected outcome
 *    classification — "exact" (the Offisos semantics match the declared
 *    Archicad reference behavior within the supported boundary), "lossy"
 *    (a documented structural/semantic loss), or "unsupported" (a typed
 *    refusal — never a fabricated semantic). Feature-list presence alone
 *    is never sufficient (the P020 acceptance criteria);
 *  - consistent with the P019 baseline wherever shared CAD semantics and
 *    infrastructure are involved (the P020 acceptance criterion): the
 *    same engine, the same check vocabulary, the same interop probe
 *    vocabulary, the same honest-classification language.
 *
 * Determinism: the corpus is PURE DATA. Its canonical JSON encoding and
 * sha256 (below) are stable — the certification report pins the corpus
 * hash so every piece of certification evidence is bound to exactly this
 * corpus revision. Perf budgets are wall-clock ASSERTED, never pinned.
 *
 * Engine boundary (LOCK-018): type-only imports; no engine, no host, no
 * I/O. The corpus declares WHAT to certify; the engine executes it
 * against the governed App API surface only.
 */

import { createHash } from "node:crypto";
import { canonicalStringify } from "../caddocument/serialization.js";
import type {
  CorpusWorkflow,
  CorpusScriptStep,
  CorpusExpectation,
  CorpusInteropExpectation,
  CorpusPerfTarget,
  CorpusRobustness,
} from "./corpus.js";

// ---------------------------------------------------------------------------
// The version pin.
// ---------------------------------------------------------------------------

/**
 * The declared Archicad reference family this corpus is pinned against.
 *
 * Primary reference: Graphisoft Archicad 27 (the INT/English online help —
 * the toolset-and-workflow BIM authoring behavior: stories, the virtual
 * building elements (walls, hosted openings, slabs, roofs, stairs,
 * railings, zones), the model views, the layout book, the publisher, the
 * interactive schedules, the properties/classifications, the IFC
 * translator, the teamwork/change-tracking workflow, the renovation
 * filters and the design options). Graphisoft documents NO command-line
 * interface — the professional surface is tool + palette + menu driven.
 * The declared reference behavior is written out per workflow below; the
 * pin is the version, the declarations, the reference manifest, the
 * command-analog map and the corpus sha256 — all frozen in this module.
 */
export const ARCHICAD_CORPUS_REFERENCE = {
  corpusId: "archicad-p020-corpus",
  corpusVersion: "1",
  referenceProduct: "Graphisoft Archicad 27 (INT) — the declared Archicad-class BIM/documentation reference family",
  referenceBasis:
    "The version-pinned Graphisoft reference manifest (ARCHICAD_REFERENCE_MANIFEST below): every workflow and expectation cites its authoritative Graphisoft documentation source (URL + document path + the specific tool/topic). Graphisoft documents Archicad 27 with NO command-line interface — every Offisos surface this corpus drives is explicitly modeled as a semantic analog (ARCHICAD_COMMAND_ANALOGS below, the closed partition enforced by test)",
  pinnedAt: "2026-09-03",
  revisedAt: "2026-09-03",
  revisionNote:
    "Rev 1 — the first P020 corpus revision (the certification-first execution rule). All manifest locators verified live on 2026-09-03 against help.graphisoft.com/AC/27/INT (the Archicad 27 Help).",
  pinnedBy: "CAD-PARITY-020 first implementation deliverable (Issue #123, certification-first execution rule)",
} as const;

// ---------------------------------------------------------------------------
// The version-pinned Graphisoft reference manifest.
// ---------------------------------------------------------------------------

/**
 * One authoritative Graphisoft source in the version-pinned reference
 * manifest. Each entry is INDEPENDENTLY AUDITABLE: the locator is a
 * version-pinned (AC/27/INT) Graphisoft Help URL, the docId is the
 * document path within the help project, and the scope names the
 * specific tools/topics the corpus draws from it. Workflows,
 * expectations and command analogs cite these entries by id; the
 * manifest is part of the corpus digest.
 */
export interface ArchicadReferenceSource {
  /** The manifest key (cited by workflows, expectations and analogs). */
  readonly id: string;
  /** The Graphisoft product the source documents (version-pinned). */
  readonly product: string;
  /** The Graphisoft documentation page title. */
  readonly title: string;
  /** The version-pinned locator (URL) — the independently auditable reference. */
  readonly locator: string;
  /** The document path within the Archicad 27 Help project (the docId). */
  readonly docId: string;
  /** The specific tools/topics this source covers as used by the corpus. */
  readonly scope: string;
}

/** The version-pinned authoritative Graphisoft reference manifest. */
export const ARCHICAD_REFERENCE_MANIFEST: readonly ArchicadReferenceSource[] = [
  {
    id: "archicad-27-help",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Archicad 27 Help — the version-pinned help project (the pin anchor)",
    locator: "https://help.graphisoft.com/AC/27/INT/index.htm",
    docId: "AC/27/INT",
    scope:
      "The Archicad 27 (INT) online help project itself — the version pin anchor every other manifest entry resolves within (the RoboHelp project titled 'Archicad 27 Help'; the versioned root under which all topic pages below live).",
  },
  {
    id: "archicad-27-stories",
    product: "Graphisoft Archicad 27 (INT)",
    title: "About Stories (Views of the Virtual Building)",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/050_ViewsVB/050_ViewsVB-5.htm",
    docId: "_AC27_Help/050_ViewsVB/050_ViewsVB-5.htm",
    scope:
      "The story structure: the virtual building is organized into stories (levels) — each story is a horizontal cut of the building at a given elevation; elements are placed on the active story and the story settings define level/height; the navigator exposes the story structure.",
  },
  {
    id: "archicad-27-walls",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Walls (Construction Elements — the Wall Tool)",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/040_ElementsVB/040_ElementsVB-6.htm",
    docId: "_AC27_Help/040_ElementsVB/040_ElementsVB-6.htm",
    scope:
      "The Wall Tool documented behavior: place a straight wall from start point to end point on the active story (geometry method: start/end; the reference line; wall thickness/height from the tool settings), chains of walls, curved/polygon walls and wall modification.",
  },
  {
    id: "archicad-27-openings",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Openings (Construction Elements)",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/040_ElementsVB/040_ElementsVB-257.htm",
    docId: "_AC27_Help/040_ElementsVB/040_ElementsVB-257.htm",
    scope:
      "The hosted-opening behavior: openings are placed INTO a host wall at a position along the wall (the hole is carried by the host; the door/window fills it) — the placement position, width, height and sill of the opening.",
  },
  {
    id: "archicad-27-door-window-tools",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Dedicated Object Tools: Doors, Windows, Skylights, Wall Ends",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/040_ElementsVB/040_ElementsVB-303.htm",
    docId: "_AC27_Help/040_ElementsVB/040_ElementsVB-303.htm",
    scope:
      "The dedicated Door/Window tools: door and window objects are placed into host walls (hosted insertion — the tool places the opening + the fill object; only walls can host them).",
  },
  {
    id: "archicad-27-slabs",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Slabs (Construction Elements — the Slab Tool)",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/040_ElementsVB/040_ElementsVB-125.htm",
    docId: "_AC27_Help/040_ElementsVB/040_ElementsVB-125.htm",
    scope:
      "The Slab Tool documented behavior: create a slab on the active story from its polygonal outline (the rectangular geometry method: two corners), with thickness from the tool settings.",
  },
  {
    id: "archicad-27-roofs",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Roofs (Construction Elements — the Roof Tool)",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/040_ElementsVB/040_ElementsVB-59.htm",
    docId: "_AC27_Help/040_ElementsVB/040_ElementsVB-59.htm",
    scope:
      "The Roof Tool documented behavior: create a roof over a footprint with the ridge axis and the ridge height above the eaves base (the gable geometry).",
  },
  {
    id: "archicad-27-stairs",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Stairs (Construction Elements — the Stair Tool)",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/040_ElementsVB/040_ElementsVB-176.htm",
    docId: "_AC27_Help/040_ElementsVB/040_ElementsVB-176.htm",
    scope:
      "The Stair Tool documented behavior: create a stair run from a start point in a run direction, landing on a story above (the run's width/tread/riser count from the tool settings; the stair connects two stories).",
  },
  {
    id: "archicad-27-railings",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Railings (Construction Elements — the Railing Tool)",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/040_ElementsVB/040_ElementsVB-203.htm",
    docId: "_AC27_Help/040_ElementsVB/040_ElementsVB-203.htm",
    scope:
      "The Railing Tool documented behavior: create a railing associated with a host stair (side and handrail height from the tool settings; the railing follows the host run).",
  },
  {
    id: "archicad-27-zones",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Zones (Construction Elements — the Zone Tool)",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/040_ElementsVB/040_ElementsVB-136.htm",
    docId: "_AC27_Help/040_ElementsVB/040_ElementsVB-136.htm",
    scope:
      "The Zone Tool documented behavior: zones represent rooms/spaces — placed as bounded spaces with a name (zone stamp/category/numbering), grouped/summed into zone hierarchies; the zone belongs to a story.",
  },
  {
    id: "archicad-27-renovation",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Renovation Filters (Views of the Virtual Building)",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/050_ViewsVB/050_ViewsVB-123.htm",
    docId: "_AC27_Help/050_ViewsVB/050_ViewsVB-123.htm",
    scope:
      "The renovation status model: every element carries a renovation status (Existing / New / To Be Demolished); the renovation filters then control display by status — the documented three-status vocabulary.",
  },
  {
    id: "archicad-27-design-options",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Design Options",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/071_DesignOptions/071_DesignOptions-1.htm",
    docId: "_AC27_Help/071_DesignOptions/071_DesignOptions-1.htm",
    scope:
      "The design-option model: option groups collect alternative design variants (e.g. structural/material options), each element belongs to an option, one option is active per group and the model builds to the active option.",
  },
  {
    id: "archicad-27-properties",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Properties and Classification Systems",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/045_PropertiesClassifications/045_PropertiesClassifications-1.htm",
    docId: "_AC27_Help/045_PropertiesClassifications/045_PropertiesClassifications-1.htm",
    scope:
      "The custom property model: property definitions belong to property groups (property sets), are typed (text/number/boolean with optional units) and can be limited to selected element classifications (applies-to); elements carry the property values; classification systems classify elements.",
  },
  {
    id: "archicad-27-attributes",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Attributes (Building Materials and other project attributes)",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/025_Attributes/025_Attributes-1.htm",
    docId: "_AC27_Help/025_Attributes/025_Attributes-1.htm",
    scope:
      "The attribute model: project attributes (building materials with category/density, surfaces, etc.) are project-level definitions; building materials are assigned to structures (walls/slabs) and carry measurable properties.",
  },
  {
    id: "archicad-27-interactive-schedule",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Interactive Schedule",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/050_ViewsVB/050_ViewsVB-90.htm",
    docId: "_AC27_Help/050_ViewsVB/050_ViewsVB-90.htm",
    scope:
      "The Interactive Schedule: schedule schemes extract element/component data into tables (columns chosen from properties and quantities; criteria filter the source elements); schedules list/refresh from the live model and quantity takeoffs derive per-element quantities deterministically.",
  },
  {
    id: "archicad-27-views",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Views of the Virtual Building (the model-view documentation)",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/050_ViewsVB/050_ViewsVB-1.htm",
    docId: "_AC27_Help/050_ViewsVB/050_ViewsVB-1.htm",
    scope:
      "The model-view concept: plan, section, elevation and detail views of the virtual building are saved as view definitions (per story/direction/section axis/zoom region) — the documentation workflow draws from them.",
  },
  {
    id: "archicad-27-layout-book",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Navigator - Layout Book (Working with Layouts, Subsets)",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/070_Documentation/070_Documentation-84.htm",
    docId: "_AC27_Help/070_Documentation/070_Documentation-84.htm",
    scope:
      "The Layout Book: layouts are the sheets of the documentation set — organized into subsets with sheet-number prefixes, drawings placed on layouts, master layouts carry the repeated frame/title content. (Sibling pages: Working with Layouts 070_Documentation-85.htm, Master Layouts 070_Documentation-86.htm.)",
  },
  {
    id: "archicad-27-revision-management",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Revision Management (Documentation)",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/070_Documentation/070_Documentation-97.htm",
    docId: "_AC27_Help/070_Documentation/070_Documentation-97.htm",
    scope:
      "The revision workflow: document revisions record the issue history (unique code + description), apply to layouts and are tracked on the issued sheets.",
  },
  {
    id: "archicad-27-publishing",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Publishing (Documentation — the Publisher)",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/070_Documentation/070_Documentation-114.htm",
    docId: "_AC27_Help/070_Documentation/070_Documentation-114.htm",
    scope:
      "The Publisher: publisher sets collect the layout-book items (layouts/subsets) to publish (e.g. PDF) — publishing the set produces the deterministic output (one page per item; the same set publishes the same output).",
  },
  {
    id: "archicad-27-ifc",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Working with IFC (Interoperability)",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/121_IFC/121_IFC-1.htm",
    docId: "_AC27_Help/121_IFC/121_IFC-1.htm",
    scope:
      "The IFC translator: Archicad is the BIM authoring tool with the documented IFC exchange — export produces the IFC model of the virtual building (elements with classification/properties), import reconciles it back; the IFC exchange carries structured BIM semantics (the openBIM basis).",
  },
  {
    id: "archicad-27-teamwork",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Teamwork (Collaboration)",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/080_Collaboration/080_Collaboration-2.htm",
    docId: "_AC27_Help/080_Collaboration/080_Collaboration-2.htm",
    scope:
      "The Teamwork workflow: team members join the shared project (roles/reservations), collaborate over the shared model with presence/comments, and the shared state is versioned (the reservation-based collaboration model — the BIMcloud-backed workflow).",
  },
  {
    id: "archicad-27-change-tracking",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Change Tracking in Teamwork (Project Change Tracking)",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/083_ProjectChangeTracking/083_ProjectChangeTracking-1.htm",
    docId: "_AC27_Help/083_ProjectChangeTracking/083_ProjectChangeTracking-1.htm",
    scope:
      "The change-tracking workflow: changes over the shared model are tracked (who changed what, the versioned change history) and recovered — the durable checkpoint/recovery model is the documented workflow basis.",
  },
  {
    id: "archicad-27-interoperability",
    product: "Graphisoft Archicad 27 (INT)",
    title: "Interoperability (the external-format boundaries)",
    locator: "https://help.graphisoft.com/AC/27/INT/_AC27_Help/120_Interoperability/120_Interoperability-1.htm",
    docId: "_AC27_Help/120_Interoperability/120_Interoperability-1.htm",
    scope:
      "The external-format boundaries of the Archicad-class workflows: the 2D carrier (DXF/DWG) carries drawing linework (not the full BIM semantics — the documented translator boundary) while IFC carries the BIM semantics; the honest boundary classification vocabulary.",
  },
];

// ---------------------------------------------------------------------------
// The command-analog map: every Offisos surface this corpus drives,
// explicitly bound to its Graphisoft-documented Archicad 27 reference.
// ---------------------------------------------------------------------------

/**
 * One explicitly-modeled command analog: an Offisos surface the corpus
 * drives, bound to the AUTHORITATIVE Graphisoft-documented Archicad 27
 * tool/workflow it is a semantic analog OF. Archicad documents NO
 * command-line interface — so EVERY command-line name below is an analog
 * (the honest closed partition: the app-suite invariant test proves every
 * invoked command-line name is in this table, and nothing is ever
 * presented as an "Archicad command").
 */
export interface ArchicadCommandAnalog {
  /** The Offisos surface (the name the corpus drives). */
  readonly offisosSurface: string;
  /** Where the surface is driven: the command line or the App API. */
  readonly surface: "command-line" | "app-api";
  /** The Graphisoft-documented Archicad 27 tool/workflow this surface is the analog of. */
  readonly archicadReference: string;
  /** The manifest source binding the reference. */
  readonly source: string;
  /** What maps and what does not (the honest analog scope). */
  readonly scope: string;
}

/**
 * The explicit semantic-analog map. Every Offisos surface the corpus
 * drives — command-line AND App API — is listed here with its
 * authoritative Graphisoft Archicad 27 reference (Archicad documents no
 * command line; the Offisos command line is itself the analog surface).
 */
export const ARCHICAD_COMMAND_ANALOGS: readonly ArchicadCommandAnalog[] = [
  {
    offisosSurface: "STORY",
    surface: "command-line",
    archicadReference: "About Stories (Views of the Virtual Building) — Archicad 27",
    source: "archicad-27-stories",
    scope:
      "The Offisos STORY creates a building story (name, level, height) and makes it active — the analog of the Archicad story structure (a story is a horizontal cut of the building at a level; elements are placed on the active story). STORY is not an Archicad command name (Archicad documents no command-line interface); the story activation mirrors the shell's created-story activation.",
  },
  {
    offisosSurface: "WALL",
    surface: "command-line",
    archicadReference: "Walls (the Wall Tool) — Archicad 27",
    source: "archicad-27-walls",
    scope:
      "The Offisos WALL draws a straight wall from two points on the active story (width/height from the BIM defaults) — the analog of the Wall Tool's straight-wall geometry method. WALL is not an Archicad command name; it does not reproduce the Wall Tool's reference-line/styles interaction.",
  },
  {
    offisosSurface: "SLAB",
    surface: "command-line",
    archicadReference: "Slabs (the Slab Tool) — Archicad 27",
    source: "archicad-27-slabs",
    scope:
      "The Offisos SLAB creates a slab on the active story from two corners (thickness from the BIM defaults) — the analog of the Slab Tool's rectangular geometry method. SLAB is not an Archicad command name.",
  },
  {
    offisosSurface: "ROOF",
    surface: "command-line",
    archicadReference: "Roofs (the Roof Tool) — Archicad 27",
    source: "archicad-27-roofs",
    scope:
      "The Offisos ROOF creates a gable roof from two footprint corners + the ridge axis and ridge height — the analog of the Roof Tool's gable creation. ROOF is not an Archicad command name.",
  },
  {
    offisosSurface: "DOOR",
    surface: "command-line",
    archicadReference: "Dedicated Object Tools: Doors — Archicad 27",
    source: "archicad-27-door-window-tools",
    scope:
      "The Offisos DOOR places a door: pick the host wall, then the position on the wall — the analog of the Door tool's hosted insertion (only walls can host). The opening + door pair mirrors the Archicad opening-in-host model. DOOR is not an Archicad command name.",
  },
  {
    offisosSurface: "WINDOW",
    surface: "command-line",
    archicadReference: "Dedicated Object Tools: Windows — Archicad 27",
    source: "archicad-27-door-window-tools",
    scope:
      "The Offisos WINDOW places a window: pick the host wall, then the position on the wall — the analog of the Window tool's hosted insertion. WINDOW is not an Archicad command name.",
  },
  {
    offisosSurface: "STAIR",
    surface: "command-line",
    archicadReference: "Stairs (the Stair Tool) — Archicad 27",
    source: "archicad-27-stairs",
    scope:
      "The Offisos STAIR creates a stair run from a start point + run direction, landing on a picked top story (width/tread/risers from the BIM defaults) — the analog of the Stair Tool's run creation between stories. STAIR is not an Archicad command name.",
  },
  {
    offisosSurface: "RAILING",
    surface: "command-line",
    archicadReference: "Railings (the Railing Tool) — Archicad 27",
    source: "archicad-27-railings",
    scope:
      "The Offisos RAILING creates a railing on a host stair (side + handrail height from the BIM defaults) — the analog of the Railing Tool's host-associated railing. RAILING is not an Archicad command name.",
  },
  {
    offisosSurface: "ZONE",
    surface: "command-line",
    archicadReference: "Zones (the Zone Tool) — Archicad 27",
    source: "archicad-27-zones",
    scope:
      "The Offisos ZONE groups one or more spaces under a name — the analog of the Zone Tool's room/zone naming (the zone collects the bounded spaces). ZONE is not an Archicad command name.",
  },
  {
    offisosSurface: "SPACEGRID",
    surface: "command-line",
    archicadReference: "Zones (the Zone Tool) — Archicad 27",
    source: "archicad-27-zones",
    scope:
      "The Offisos SPACEGRID composes a bounded grid of spaces on a story — the analog of the Zone Tool's bounded space placement (a deterministic grid of rooms). SPACEGRID is not an Archicad command name.",
  },
  {
    offisosSurface: "RENOVATE",
    surface: "command-line",
    archicadReference: "Renovation Filters — Archicad 27",
    source: "archicad-27-renovation",
    scope:
      "The Offisos RENOVATE sets the renovation status (existing/new/to-be-demolished) of selected BIM elements — the analog of the Archicad renovation status model (the same three-status documented vocabulary). RENOVATE is not an Archicad command name; the Offisos model sets per-element statuses where Archicad also derives display filters from them.",
  },
  {
    offisosSurface: "OPTION",
    surface: "command-line",
    archicadReference: "Design Options — Archicad 27",
    source: "archicad-27-design-options",
    scope:
      "The Offisos OPTION creates a design-option group with its options and the active option — the analog of the Archicad design-option model (elements can join options; the model builds to the active option). OPTION is not an Archicad command name.",
  },
  {
    offisosSurface: "SCHEDULE",
    surface: "command-line",
    archicadReference: "Interactive Schedule — Archicad 27",
    source: "archicad-27-interactive-schedule",
    scope:
      "The Offisos SCHEDULE creates a schedule definition over one of the sources (elements/components/materials/views/layouts/sheets) with its column set and optional type filter — the analog of the Interactive Schedule's scheme (criteria + columns). SCHEDULE is not an Archicad command name.",
  },
  {
    offisosSurface: "SCHLIST",
    surface: "command-line",
    archicadReference: "Interactive Schedule — Archicad 27",
    source: "archicad-27-interactive-schedule",
    scope:
      "The Offisos SCHLIST lists the schedule definitions and runs the active one — the analog of opening/viewing a schedule in the Interactive Schedule palette. SCHLIST is not an Archicad command name.",
  },
  {
    offisosSurface: "QTO",
    surface: "command-line",
    archicadReference: "Interactive Schedule (the quantity fields) — Archicad 27",
    source: "archicad-27-interactive-schedule",
    scope:
      "The Offisos QTO runs the deterministic revision-bound quantity takeoff (elements/components/materials, grouped, optionally type-filtered) — the analog of the Interactive Schedule's element-quantity extraction. QTO is not an Archicad command name.",
  },
  {
    offisosSurface: "PROPDEF",
    surface: "command-line",
    archicadReference: "Properties and Classification Systems — Archicad 27",
    source: "archicad-27-properties",
    scope:
      "The Offisos PROPDEF declares a document-owned property definition (set, key, the closed type vocabulary, optional unit, optional applies-to) — the analog of the Archicad custom-property model (property groups, typed definitions, availability by element classification). PROPDEF is not an Archicad command name.",
  },
  {
    offisosSurface: "PROPLIST",
    surface: "command-line",
    archicadReference: "Properties and Classification Systems — Archicad 27",
    source: "archicad-27-properties",
    scope:
      "The Offisos PROPLIST lists the property definitions — the analog of the property-manager overview. PROPLIST is not an Archicad command name.",
  },
  {
    offisosSurface: "MATERIAL",
    surface: "command-line",
    archicadReference: "Attributes (Building Materials) — Archicad 27",
    source: "archicad-27-attributes",
    scope:
      "The Offisos MATERIAL creates a building material (category, density) — the analog of the Archicad building-material attribute (a project-level definition with measurable properties, assigned to structures). MATERIAL is not an Archicad command name.",
  },
  {
    offisosSurface: "LAYOUTNEW",
    surface: "command-line",
    archicadReference: "Working with Layouts (the Layout Book) — Archicad 27",
    source: "archicad-27-layout-book",
    scope:
      "The Offisos LAYOUTNEW creates a paper-space layout with the canonical default page setup (A3 landscape) and activates it — the analog of the Archicad Layout Book's new-layout creation. LAYOUTNEW is not an Archicad command name.",
  },
  {
    offisosSurface: "SUBSET",
    surface: "command-line",
    archicadReference: "Navigator - Layout Book (Subsets) — Archicad 27",
    source: "archicad-27-layout-book",
    scope:
      "The Offisos SUBSET creates a Layout Book subset (parent, sheet-number prefix, numbering) — the analog of the Archicad Layout Book subset. SUBSET is not an Archicad command name.",
  },
  {
    offisosSurface: "NAVASSIGN",
    surface: "command-line",
    archicadReference: "Navigator - Layout Book — Archicad 27",
    source: "archicad-27-layout-book",
    scope:
      "The Offisos NAVASSIGN files a layout into a Layout Book subset — the analog of the navigator's drag-to-subset filing. NAVASSIGN is not an Archicad command name.",
  },
  {
    offisosSurface: "TITLEBLOCK",
    surface: "command-line",
    archicadReference: "Master Layouts (the frame/title content) — Archicad 27",
    source: "archicad-27-layout-book",
    scope:
      "The Offisos TITLEBLOCK creates a reusable title block (project text + derived layout/sheet/revision rows) — the analog of the master-layout title content. TITLEBLOCK is not an Archicad command name.",
  },
  {
    offisosSurface: "TITLEPLACE",
    surface: "command-line",
    archicadReference: "Working with Layouts / Master Layouts — Archicad 27",
    source: "archicad-27-layout-book",
    scope:
      "The Offisos TITLEPLACE places a title block on a layout — the analog of placing the title/master content on the sheet. TITLEPLACE is not an Archicad command name.",
  },
  {
    offisosSurface: "REVISION",
    surface: "command-line",
    archicadReference: "Revision Management — Archicad 27",
    source: "archicad-27-revision-management",
    scope:
      "The Offisos REVISION records a document revision (unique code, description, the layouts it applies to) — the analog of the Archicad revision workflow. REVISION is not an Archicad command name.",
  },
  {
    offisosSurface: "REVLIST",
    surface: "command-line",
    archicadReference: "Revision Management — Archicad 27",
    source: "archicad-27-revision-management",
    scope:
      "The Offisos REVLIST lists the document revisions — the analog of the revision-issue-history overview. REVLIST is not an Archicad command name.",
  },
  {
    offisosSurface: "PUBSET",
    surface: "command-line",
    archicadReference: "Publishing (the Publisher) — Archicad 27",
    source: "archicad-27-publishing",
    scope:
      "The Offisos PUBSET creates a publisher set from subset/layout items — the analog of the Archicad Publisher set. PUBSET is not an Archicad command name.",
  },
  {
    offisosSurface: "PUBLISHBOOK",
    surface: "command-line",
    archicadReference: "Publishing (the Publisher) — Archicad 27",
    source: "archicad-27-publishing",
    scope:
      "The Offisos PUBLISHBOOK publishes a publisher set (subsets expand to their layouts in book order; the multi-page PDF is built deterministically) — the analog of the Archicad Publisher's publish action. PUBLISHBOOK is not an Archicad command name.",
  },
  {
    offisosSurface: "COLLABJOIN",
    surface: "command-line",
    archicadReference: "Teamwork — Archicad 27",
    source: "archicad-27-teamwork",
    scope:
      "The Offisos COLLABJOIN registers a project-scoped collaboration member with a closed role — the analog of the Teamwork member/role model (the reservation-based collaboration). COLLABJOIN is not an Archicad command name; the BIMcloud reservation model itself is NOT reproduced (an honest boundary — the Offisos model is presence/comment/transaction based).",
  },
  {
    offisosSurface: "PRESENCE",
    surface: "command-line",
    archicadReference: "Teamwork — Archicad 27",
    source: "archicad-27-teamwork",
    scope:
      "The Offisos PRESENCE records member presence (the shared roster with the version being viewed) — the analog of the Teamwork shared-project presence. PRESENCE is not an Archicad command name.",
  },
  {
    offisosSurface: "COMMENT",
    surface: "command-line",
    archicadReference: "Teamwork — Archicad 27",
    source: "archicad-27-teamwork",
    scope:
      "The Offisos COMMENT records a collaboration comment (author, body, canonical target) — the analog of the Teamwork communication/commenting workflow. COMMENT is not an Archicad command name.",
  },
  {
    offisosSurface: "TXN",
    surface: "command-line",
    archicadReference: "Teamwork (the versioned shared model) — Archicad 27",
    source: "archicad-27-teamwork",
    scope:
      "The Offisos TXN commits a versioned transactional change authored against a declared base version (with the explicit conflict record when the head moved) — the analog of the Teamwork versioned shared-model changes (the reservation/commit workflow; the Offisos model is version-merge based, not reservation based — an honest boundary). TXN is not an Archicad command name.",
  },
  {
    offisosSurface: "MERGE",
    surface: "command-line",
    archicadReference: "Teamwork (the versioned shared model) — Archicad 27",
    source: "archicad-27-teamwork",
    scope:
      "The Offisos MERGE resolves an open conflict (rebase/discard lineage) — the analog of the Teamwork conflict-resolution workflow. MERGE is not an Archicad command name.",
  },
  {
    offisosSurface: "CKPT",
    surface: "command-line",
    archicadReference: "Change Tracking in Teamwork (the durable recovery) — Archicad 27",
    source: "archicad-27-change-tracking",
    scope:
      "The Offisos CKPT captures a durable versioned checkpoint of the current canonical revision — the analog of the documented durable shared-state model (recovery from the recorded state). CKPT is not an Archicad command name.",
  },
  {
    offisosSurface: "RECOVER",
    surface: "command-line",
    archicadReference: "Change Tracking in Teamwork (the durable recovery) — Archicad 27",
    source: "archicad-27-change-tracking",
    scope:
      "The Offisos RECOVER deterministically restores the latest valid checkpoint (or a given one) — the analog of the documented recovery workflow. RECOVER is not an Archicad command name.",
  },
  {
    offisosSurface: "BUDGETS",
    surface: "command-line",
    archicadReference: "Teamwork (the collaboration service levels) — Archicad 27",
    source: "archicad-27-teamwork",
    scope:
      "The Offisos BUDGETS reports the collaboration performance budgets (the declared service levels of the shared workflow) — an internal operational analog; there is no documented Archicad equivalent surface (the honest disclosure). BUDGETS is not an Archicad command name.",
  },
  {
    offisosSurface: "bim.createElements",
    surface: "app-api",
    archicadReference: "The construction-element tools (Walls/Slabs/Stories/…) — Archicad 27",
    source: "archicad-27-walls",
    scope:
      "The Offisos App API batch element creation (stories, walls, hosted openings, slabs, spaces, …) — the analog of the element tools' placement surface (the batch API drives the same canonical primitives the command line drives; used for workflow seeding where the interactive tool flow is not the point being certified).",
  },
  {
    offisosSurface: "docs.createViews",
    surface: "app-api",
    archicadReference: "Views of the Virtual Building — Archicad 27",
    source: "archicad-27-views",
    scope:
      "The Offisos App API view creation (plan/section/elevation/detail views with story/direction/section axis/region) — the analog of the saved model-view definitions (the View Map).",
  },
  {
    offisosSurface: "docs.createSheets",
    surface: "app-api",
    archicadReference: "Working with Layouts (the Layout Book) — Archicad 27",
    source: "archicad-27-layout-book",
    scope:
      "The Offisos App API sheet creation (layouts with view placements + title block) — the analog of placing drawings on layouts in the Layout Book.",
  },
  {
    offisosSurface: "property.create",
    surface: "app-api",
    archicadReference: "Properties and Classification Systems — Archicad 27",
    source: "archicad-27-properties",
    scope:
      "The Offisos App API property-definition creation — the analog of the custom-property declaration model.",
  },
  {
    offisosSurface: "material.create / material.assign",
    surface: "app-api",
    archicadReference: "Attributes (Building Materials) — Archicad 27",
    source: "archicad-27-attributes",
    scope:
      "The Offisos App API material creation/assignment — the analog of the building-material attribute and its assignment to structures.",
  },
  {
    offisosSurface: "schedule.create / quantities.run",
    surface: "app-api",
    archicadReference: "Interactive Schedule — Archicad 27",
    source: "archicad-27-interactive-schedule",
    scope:
      "The Offisos App API schedule definition + the deterministic quantity takeoff — the analog of the Interactive Schedule scheme/run.",
  },
  {
    offisosSurface: "collab.* (join/presence/comment/commit/merge)",
    surface: "app-api",
    archicadReference: "Teamwork — Archicad 27",
    source: "archicad-27-teamwork",
    scope:
      "The Offisos collaboration App API surfaces (members, presence, comments, versioned transactions, merges) — the analog of the Teamwork shared-model workflow (BIMcloud reservations are NOT reproduced — an honest boundary).",
  },
  {
    offisosSurface: "recovery.* (checkpoint/restore/list)",
    surface: "app-api",
    archicadReference: "Change Tracking in Teamwork — Archicad 27",
    source: "archicad-27-change-tracking",
    scope:
      "The Offisos recovery App API surfaces (durable checkpoints, deterministic restore) — the analog of the documented durable shared-state recovery model.",
  },
  {
    offisosSurface: "bim.setRenovation / bim.setClassification / bim.setOptionMembership / bim.setActiveOption",
    surface: "app-api",
    archicadReference: "Renovation Filters / Properties & Classifications / Design Options — Archicad 27",
    source: "archicad-27-renovation",
    scope:
      "The Offisos lifecycle App API surfaces (per-element renovation statuses, classification assignments, option membership and activation) — the analogs of the documented renovation/classification/design-option element models.",
  },
  {
    offisosSurface: "ifc.export / ifc.import",
    surface: "app-api",
    archicadReference: "Working with IFC (the IFC translator) — Archicad 27",
    source: "archicad-27-ifc",
    scope:
      "The Offisos IFC App API surfaces — the analog of the Archicad IFC translator (the openBIM export/import carrying the structured BIM semantics).",
  },
];

// ---------------------------------------------------------------------------
// The corpus: the eight representative Archicad-class BIM/documentation
// workflows (composed from the VERIFIED P011..P018 surfaces + the P019
// baseline infrastructure).
// ---------------------------------------------------------------------------

export const ARCHICAD_WORKFLOWS: readonly CorpusWorkflow[] = [
  // -------------------------------------------------------------------------
  // WF-A1 — the virtual-building model composition (the Archicad-class
  // authoring workflow: stories → walls + hosted openings → slab + roof →
  // stair + railings, between two stories).
  // -------------------------------------------------------------------------
  {
    id: "wf-vb-authoring",
    title: "Virtual-building model composition (stories, walls, hosted openings, slabs, roofs, stairs, railings)",
    discipline: "bim",
    sources: ["archicad-27-stories", "archicad-27-walls", "archicad-27-openings", "archicad-27-door-window-tools", "archicad-27-slabs", "archicad-27-roofs", "archicad-27-stairs", "archicad-27-railings", "archicad-27-ifc"],
    referenceBehavior:
      "Archicad 27 documented virtual-building behavior (the tool-based authoring workflow, driven here through the Offisos semantic analogs — Archicad documents no command line): the building is organized into stories (a story is a horizontal cut at a level; elements are placed on the active story); the Wall Tool places straight walls from start/end on the active story; openings are hosted INTO walls (the Door/Window tools place the opening + fill at a position along the host); the Slab Tool creates a slab from its outline on the active story; the Roof Tool creates the gable roof over a footprint with ridge axis/height; the Stair Tool creates the run between two stories (landing on the story above); the Railing Tool creates railings associated with the host stair; the model exchanges through the IFC translator as the openBIM representation.",
    phases: [
      {
        id: "stories",
        title: "The two-story structure (the story levels — the elements are placed per story)",
        commands: [
          {
            name: "bim.createElements",
            payload: {
              entities: [
                { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
                { type: "bim.story", id: "story-1st", name: "First Floor", level: 3000, height: 3000 },
              ],
            },
            as: "stories",
          },
        ],
        expectations: [
          {
            id: "exp-stories",
            reference: "The virtual building is organized into stories — each story a horizontal cut at its level (0 and 3000).",
            source: "archicad-27-stories",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.story", equals: 2 },
          },
          {
            id: "exp-story-levels",
            reference: "The story structure declares the levels (the First Floor story sits at level 3000 above the Ground Floor).",
            source: "archicad-27-stories",
            outcome: "exact",
            check: { kind: "state", path: "elements.1.props.level", equals: 3000 },
          },
        ],
      },
      {
        id: "walls-openings",
        title: "Walls + hosted openings (WALL ×2 → DOOR + WINDOW into the hosts)",
        script: [
          { event: { type: "typed", text: "WALL" } },
          { event: { type: "typed", text: "0,0" } },
          { event: { type: "typed", text: "6000,0" } },
          { event: { type: "typed", text: "WALL" } },
          { event: { type: "typed", text: "0,0" } },
          { event: { type: "typed", text: "0,4000" } },
          { event: { type: "typed", text: "DOOR" } },
          { event: { type: "entity", entity: { by: "id", id: "story-gf" } } },
        ],
        expectations: [
          {
            id: "exp-wall-count",
            reference: "The Wall Tool places the straight walls from start/end on the active story.",
            source: "archicad-27-walls",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.wall", equals: 2 },
          },
        ],
      },
      {
        id: "slab-roof",
        title: "The slab + the gable roof (SLAB + ROOF on the active story)",
        script: [
          { event: { type: "typed", text: "SLAB" } },
          { event: { type: "typed", text: "0,0" } },
          { event: { type: "typed", text: "6000,4000" } },
          { event: { type: "typed", text: "ROOF" } },
          { event: { type: "typed", text: "0,0" } },
          { event: { type: "typed", text: "6000,4000" } },
          { event: { type: "typed", text: "y" } },
          { event: { type: "typed", text: "1500" } },
        ],
        expectations: [
          {
            id: "exp-slab",
            reference: "The Slab Tool creates the slab on the active story from the outline (thickness from the tool settings).",
            source: "archicad-27-slabs",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.slab", equals: 1 },
          },
          {
            id: "exp-roof",
            reference: "The Roof Tool creates the gable roof over the footprint with the ridge axis + ridge height.",
            source: "archicad-27-roofs",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.roof", equals: 1 },
          },
        ],
      },
      {
        id: "stair-railings",
        title: "The stair between the stories + its railings (STAIR → RAILING ×2)",
        script: [
          { event: { type: "typed", text: "STAIR" } },
          { event: { type: "typed", text: "2000,1000" } },
          { event: { type: "typed", text: "2000,5000" } },
          { event: { type: "entity", entity: { by: "id", id: "story-1st" } } },
          { event: { type: "typed", text: "RAILING" } },
          { event: { type: "entity", entity: { by: "nth", type: "bim.stair", nth: 0 } } },
          { event: { type: "typed", text: "left" } },
          { event: { type: "typed", text: "RAILING" } },
          { event: { type: "entity", entity: { by: "nth", type: "bim.stair", nth: 0 } } },
          { event: { type: "typed", text: "right" } },
        ],
        expectations: [
          {
            id: "exp-stair",
            reference: "The Stair Tool creates the run from the start point in the run direction, landing on the picked top story.",
            source: "archicad-27-stairs",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.stair", equals: 1 },
          },
          {
            id: "exp-railings",
            reference: "The Railing Tool creates the railings associated with the host stair (both sides).",
            source: "archicad-27-railings",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.railing", equals: 2 },
          },
        ],
      },
    ],
    interop: [
      {
        id: "io-vb-ifc",
        surface: "ifc",
        concept: "The virtual-building elements at the IFC boundary",
        reference: "The Archicad IFC translator exports the virtual building to IFC (the openBIM representation of the walls/slabs/spaces).",
        source: "archicad-27-ifc",
        expected: "exact",
        note: "the DRY IFC round-trip over the same state is zero-loss by design (COMPAT-IFC-001)",
        probe: { kind: "ifcAggregate" },
      },
      {
        id: "io-vb-dxf-boundary",
        surface: "dxf",
        concept: "The BIM elements at the 2D carrier boundary",
        reference: "The documented 2D carrier (DXF/DWG) carries drawing linework, not the full BIM semantics — the translator boundary.",
        source: "archicad-27-interoperability",
        expected: "unsupported",
        note: "the BIM elements are counted-and-skipped at the DXF boundary (never fabricated as 2D geometry)",
        probe: { kind: "dxfUnsupportedTypes", includes: ["bim"] },
      },
    ],
    perf: [{ label: "wf-vb-authoring total", budgetMs: 60000 }],
    robustness: { roundTrip: true, undoRedoSteps: 1, replayStable: true },
  },

  // -------------------------------------------------------------------------
  // WF-A2 — the zone program (spaces, zone naming, renovation statuses,
  // design options).
  // -------------------------------------------------------------------------
  {
    id: "wf-zone-program",
    title: "Zone program with renovation statuses and design options",
    discipline: "bim",
    sources: ["archicad-27-zones", "archicad-27-stories", "archicad-27-renovation", "archicad-27-design-options"],
    referenceBehavior:
      "Archicad 27 documented zone/renovation/design-option behavior: the Zone Tool represents rooms/spaces — bounded spaces placed per story, named (zone stamp/numbering) and grouped into zone collections; every element carries a renovation status (Existing / New / To Be Demolished — the documented three-status vocabulary) controlling the renovation display; design options collect alternative variants (elements join options; one option is active per group and the model builds to the active option).",
    phases: [
      {
        id: "story-seed",
        title: "The host story + the boundary walls (the zone context)",
        commands: [
          {
            name: "bim.createElements",
            payload: {
              entities: [
                { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
                { type: "bim.wall", id: "wall-a", storyId: "story-gf", start: [0, 0], end: [8000, 0], width: 240, height: 3000 },
                { type: "bim.wall", id: "wall-b", storyId: "story-gf", start: [0, 0], end: [0, 6000], width: 240, height: 3000 },
              ],
            },
            as: "seed",
          },
        ],
        expectations: [
          {
            id: "exp-zone-context",
            reference: "The zone program lives on the story structure (zones belong to a story).",
            source: "archicad-27-stories",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.story", equals: 1 },
          },
        ],
      },
      {
        id: "spaces",
        title: "The bounded spaces (SPACEGRID — the Zone Tool space placement analog)",
        script: [
          { event: { type: "typed", text: "SPACEGRID" } },
          { event: { type: "typed", text: "story-gf" } },
          { event: { type: "typed", text: "1000,1000" } },
          { event: { type: "typed", text: "2" } },
          { event: { type: "typed", text: "2" } },
          { event: { type: "typed", text: "3000" } },
          { event: { type: "typed", text: "2000" } },
          { event: { type: "typed", text: "ROOM" } },
        ],
        expectations: [
          {
            id: "exp-spaces",
            reference: "The Zone Tool places the bounded spaces (rooms) on the story.",
            source: "archicad-27-zones",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.space", equals: 4 },
          },
          {
            id: "exp-space-names",
            reference: "The spaces carry the deterministic zone naming (prefix-column-row).",
            source: "archicad-27-zones",
            outcome: "exact",
            check: { kind: "state", path: "elements.3.props.name", equals: "ROOM-1-1" },
          },
        ],
      },
      {
        id: "zone-grouping",
        title: "The zone collection (ZONE — the named zone grouping the spaces)",
        script: [
          { event: { type: "typed", text: "ZONE" } },
          { event: { type: "typed", text: "Apartment A" } },
          { event: { type: "entity", entity: { by: "nth", type: "bim.space", nth: 0 } } },
          { event: { type: "entity", entity: { by: "nth", type: "bim.space", nth: 1 } } },
          { event: { type: "enter" } },
        ],
        expectations: [
          {
            id: "exp-zone",
            reference: "The Zone Tool names the zone collecting its member spaces (the zone stamp naming).",
            source: "archicad-27-zones",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.zone", equals: 1 },
          },
        ],
      },
      {
        id: "renovation",
        title: "The renovation statuses (RENOVATE — the existing/new/demo vocabulary)",
        script: [
          { event: { type: "typed", text: "RENOVATE" } },
          { event: { type: "typed", text: "existing" } },
          { event: { type: "entity", entity: { by: "id", id: "wall-a" } } },
          { event: { type: "enter" } },
        ],
        queries: [{ name: "bim.getLifecycle", payload: { elementId: "wall-a" }, as: "lifecycle" }],
        expectations: [
          {
            id: "exp-renovation-status",
            reference: "The renovation status vocabulary: the element carries its status (Existing / New / To Be Demolished).",
            source: "archicad-27-renovation",
            outcome: "exact",
            check: { kind: "result", of: "lifecycle", path: "elements.0.renovationStatus", equals: "existing" },
          },
        ],
      },
      {
        id: "design-options",
        title: "The design-option group (OPTION — the variants + the active option)",
        script: [
          { event: { type: "typed", text: "OPTION" } },
          { event: { type: "typed", text: "Cladding" } },
          { event: { type: "typed", text: "Brick,Render" } },
          { event: { type: "typed", text: "Render" } },
        ],
        queries: [{ name: "bim.getOptions", payload: {}, as: "options" }],
        expectations: [
          {
            id: "exp-option-group",
            reference: "The design-option model: option groups collect the alternative variants with the active option.",
            source: "archicad-27-design-options",
            outcome: "exact",
            check: { kind: "result", of: "options", path: "groups.length", equals: 1 },
          },
          {
            id: "exp-option-active",
            reference: "One option is active per group (the model builds to the active option).",
            source: "archicad-27-design-options",
            outcome: "exact",
            check: { kind: "result", of: "options", path: "groups.0.activeOption", equals: "Render" },
          },
        ],
      },
    ],
    interop: [
      {
        id: "io-zone-ifc",
        surface: "ifc",
        concept: "The spaces/zones at the IFC boundary",
        reference: "The Archicad IFC translator exports spaces/zones as the IFC spatial structure.",
        source: "archicad-27-ifc",
        expected: "exact",
        note: "the DRY IFC round-trip over the same state is zero-loss by design (COMPAT-IFC-001)",
        probe: { kind: "ifcAggregate" },
      },
    ],
    perf: [{ label: "wf-zone-program total", budgetMs: 45000 }],
    robustness: { roundTrip: true, undoRedoSteps: 1, replayStable: true },
  },

  // -------------------------------------------------------------------------
  // WF-A3 — the documentation model views (the saved views of the virtual
  // building: plan/section/elevation/detail).
  // -------------------------------------------------------------------------
  {
    id: "wf-model-views",
    title: "Documentation model views (plan, section, elevation, detail)",
    discipline: "documentation",
    sources: ["archicad-27-views", "archicad-27-stories", "archicad-27-interoperability"],
    referenceBehavior:
      "Archicad 27 documented model-view behavior: plan, section, elevation and detail views of the virtual building are saved as view definitions (the View Map) — the plan view is per story, the section view cuts the model on a declared axis at an offset, the elevation looks from a declared direction, the detail zooms into a region of a source view; the documentation workflow draws from these saved views; the 2D carrier (DXF) carries the drawing linework of the plan view (the documented translator boundary — the drawing, not the full BIM semantics).",
    phases: [
      {
        id: "model-seed",
        title: "The seed model (the two-story building the views document)",
        commands: [
          {
            name: "bim.createElements",
            payload: {
              entities: [
                { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
                { type: "bim.wall", id: "wall-a", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 240, height: 3000 },
                { type: "bim.wall", id: "wall-b", storyId: "story-gf", start: [0, 0], end: [0, 4000], width: 240, height: 3000 },
                { type: "bim.slab", id: "slab-1", storyId: "story-gf", corner1: [0, 0], corner2: [6000, 4000], thickness: 200 },
              ],
            },
            as: "seed",
          },
        ],
        expectations: [
          {
            id: "exp-views-model",
            reference: "The model exists for the views to document (the walls/slab on the story).",
            source: "archicad-27-views",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.wall", equals: 2 },
          },
        ],
      },
      {
        id: "views-create",
        title: "The saved views (plan per story + section on the axis + elevation from the direction)",
        commands: [
          {
            name: "docs.createViews",
            payload: {
              views: [
                { kind: "plan", title: "Ground Floor Plan", storyId: "story-gf", scale: 100 },
                { kind: "section", title: "Section A-A", sectionAxis: "x", sectionOffset: 3000, scale: 100 },
                { kind: "elevation", title: "North Elevation", direction: "front", scale: 100 },
              ],
            },
            as: "views",
          },
          {
            name: "docs.createViews",
            payload: {
              views: [
                {
                  kind: "detail",
                  title: "Wall base detail",
                  sourceViewId: "vw-000001",
                  region: { x: 0, y: 0, w: 1500, h: 1200 },
                  detailScale: 10,
                },
              ],
            },
            as: "detail-view",
          },
        ],
        queries: [{ name: "docs.listViews", payload: {}, as: "viewlist" }],
        expectations: [
          {
            id: "exp-views-created",
            reference: "The View Map collects the saved views (plan/section/elevation/detail) with their deterministic identities.",
            source: "archicad-27-views",
            outcome: "exact",
            check: { kind: "result", of: "viewlist", path: "views.length", equals: 4 },
          },
          {
            id: "exp-view-kinds",
            reference: "The view kinds carry the documented view-type semantics (plan/section/elevation/detail).",
            source: "archicad-27-views",
            outcome: "exact",
            check: { kind: "result", of: "viewlist", path: "views.2.view.kind", equals: "elevation" },
          },
          {
            id: "exp-detail-source",
            reference: "The detail view zooms into a region of its source view (the saved-view derivation).",
            source: "archicad-27-views",
            outcome: "exact",
            check: { kind: "result", of: "viewlist", path: "views.3.view.sourceViewId", equals: "vw-000001" },
          },
        ],
      },
      {
        id: "view-refusal",
        title: "The typed view refusal (a view referencing a non-existent story is refused — never fabricated)",
        expectations: [
          {
            id: "exp-view-story-refusal",
            reference: "A plan view referencing a non-existent story is a typed refusal (docs_invalid) — never a fabricated view (the View Map discipline).",
            source: "archicad-27-views",
            outcome: "unsupported",
            rationale: "The typed refusal is the honest boundary: the view system never guesses a story.",
            check: {
              kind: "decline",
              command: "docs.createViews",
              payload: { views: [{ kind: "plan", title: "Ghost Plan", storyId: "story-none" }] },
              code: "docs_invalid",
              via: "command",
            },
          },
        ],
      },
      {
        id: "view-geometry",
        title: "The section geometry (the deterministic cut of the model)",
        queries: [
          { name: "docs.getViewGeometry", payload: { viewId: "vw-000002" }, as: "section-geom" },
          { name: "docs.getViewGeometry", payload: { viewId: "vw-000001" }, as: "plan-geom" },
        ],
        expectations: [
          {
            id: "exp-section-geometry",
            reference: "The section view cuts the model on the declared axis at the declared offset (the deterministic projection).",
            source: "archicad-27-views",
            outcome: "exact",
            check: { kind: "result", of: "section-geom", path: "primitiveCount", equals: 2 },
          },
          {
            id: "exp-plan-geometry",
            reference: "The plan view projects the story's elements (the plan drawing of the cut plane).",
            source: "archicad-27-views",
            outcome: "exact",
            check: { kind: "result", of: "plan-geom", path: "primitiveCount", equals: 5 },
          },
        ],
      },
    ],
    interop: [
      {
        id: "io-views-dxf",
        surface: "dxf",
        concept: "The plan-view linework at the 2D carrier boundary",
        reference: "The 2D carrier (DXF/DWG) carries the drawing linework of the plan view — the documented translator boundary (the drawing, not the full BIM semantics).",
        source: "archicad-27-interoperability",
        expected: "unsupported",
        note: "the BIM elements are counted-and-skipped at the DXF boundary (the 2D carrier is a derived surface beyond the bounded model — never fabricated)",
        probe: { kind: "dxfUnsupportedTypes", includes: ["bim"] },
      },
      {
        id: "io-views-ifc",
        surface: "ifc",
        concept: "The model behind the views at the IFC boundary",
        reference: "The IFC translator carries the model semantics the views document.",
        source: "archicad-27-ifc",
        expected: "exact",
        note: "the DRY IFC round-trip over the same state is zero-loss by design (COMPAT-IFC-001)",
        probe: { kind: "ifcAggregate" },
      },
    ],
    perf: [{ label: "wf-model-views total", budgetMs: 45000 }],
    robustness: { roundTrip: true, undoRedoSteps: 1, replayStable: true },
  },

  // -------------------------------------------------------------------------
  // WF-A4 — the Layout Book (layouts, subsets, master title blocks, the
  // documentation sheets with placed drawings).
  // -------------------------------------------------------------------------
  {
    id: "wf-layout-book",
    title: "Layout Book assembly (layouts, subsets, master title blocks, documentation sheets)",
    discipline: "documentation",
    sources: ["archicad-27-layout-book", "archicad-27-views"],
    referenceBehavior:
      "Archicad 27 documented Layout Book behavior: layouts are the sheets of the documentation set, organized into subsets (with sheet-number prefixes); the drawings from the saved views are placed on the sheets; the master-layout title content (the title block) frames the sheet; the Layout Book is the documentation set structure (the navigator's Layout Book panel).",
    phases: [
      {
        id: "story-views",
        title: "The saved view (the drawing source placed on the sheet)",
        commands: [
          {
            name: "bim.createElements",
            payload: {
              entities: [{ type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 }],
            },
            as: "story",
          },
          {
            name: "docs.createViews",
            payload: {
              views: [{ kind: "plan", title: "Ground Floor Plan", storyId: "story-gf", scale: 100 }],
            },
            as: "views",
          },
        ],
        expectations: [
          {
            id: "exp-book-views",
            reference: "The documentation set draws from the saved model views (the drawing source).",
            source: "archicad-27-views",
            outcome: "exact",
            check: { kind: "result", of: "views", path: "created.length", equals: 1 },
          },
        ],
      },
      {
        id: "layouts",
        title: "The layout + the title block (LAYOUTNEW + TITLEBLOCK + TITLEPLACE)",
        script: [
          { event: { type: "typed", text: "LAYOUTNEW" } },
          { event: { type: "typed", text: "A-101 Ground Floor Plan" } },
          { event: { type: "typed", text: "TITLEBLOCK" } },
          { event: { type: "typed", text: "Std A3" } },
          { event: { type: "typed", text: "P020 Certification" } },
          { event: { type: "enter" } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "TITLEPLACE" } },
          { event: { type: "typed", text: "A-101 Ground Floor Plan" } },
          { event: { type: "typed", text: "Std A3" } },
          { event: { type: "enter" } },
          { event: { type: "enter" } },
        ],
        expectations: [
          {
            id: "exp-layout-created",
            reference: "The layout is created with the declared name and the canonical default page setup (A3 landscape).",
            source: "archicad-27-layout-book",
            outcome: "exact",
            check: { kind: "state", path: "layouts.0.name", equals: "A-101 Ground Floor Plan" },
          },
          {
            id: "exp-layout-pagesetup",
            reference: "The layout carries the canonical sheet setup (A3 landscape).",
            source: "archicad-27-layout-book",
            outcome: "exact",
            check: { kind: "state", path: "layouts.0.pageSetup.paperSize", equals: "A3" },
          },
          {
            id: "exp-titleblock-placed",
            reference: "The title block is placed on the layout (the master title content frames the sheet).",
            source: "archicad-27-layout-book",
            outcome: "exact",
            check: { kind: "state", path: "layouts.0.titleBlockPlacement.titleBlockId", equals: "tb-000001" },
          },
        ],
      },
      {
        id: "documentation-sheets",
        title: "The documentation sheet with the placed drawing (docs.createSheets — the P013 sheet model)",
        commands: [
          {
            name: "docs.createSheets",
            payload: {
              sheets: [
                {
                  title: "A-101 Ground Floor Plan",
                  viewPlacements: [{ viewId: "vw-000001", x: 20, y: 20, w: 250, h: 180 }],
                  titleBlock: { projectName: "P020 Certification", sheetTitle: "A-101 Ground Floor Plan", sheetNumber: "A-101" },
                },
              ],
            },
            as: "sheets",
          },
        ],
        queries: [{ name: "docs.listSheets", payload: {}, as: "sheetlist" }],
        expectations: [
          {
            id: "exp-sheets",
            reference: "The layouts (sheets) carry the placed drawings from the saved views.",
            source: "archicad-27-layout-book",
            outcome: "exact",
            check: { kind: "result", of: "sheetlist", path: "sheets.length", equals: 1 },
          },
          {
            id: "exp-sheet-placements",
            reference: "The drawing placement on the sheet is recorded (the view → sheet placement at the declared region).",
            source: "archicad-27-layout-book",
            outcome: "exact",
            check: { kind: "result", of: "sheetlist", path: "sheets.0.viewPlacements.0.viewId", equals: "vw-000001" },
          },
        ],
      },
      {
        id: "book-organization",
        title: "The subset + the filing (SUBSET + NAVASSIGN — the book organization)",
        script: [
          { event: { type: "typed", text: "SUBSET" } },
          { event: { type: "typed", text: "A Series" } },
          { event: { type: "enter" } },
          { event: { type: "enter" } },
          { event: { type: "enter" } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "NAVASSIGN" } },
          { event: { type: "typed", text: "LAYOUT" } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "A-101 Ground Floor Plan" } },
          { event: { type: "typed", text: "A Series" } },
        ],
        expectations: [
          {
            id: "exp-subset",
            reference: "The Layout Book organizes the layouts into subsets (with the sheet-number prefix).",
            source: "archicad-27-layout-book",
            outcome: "exact",
            check: { kind: "echo", equals: "SUBSET: 'A Series' [A] numbering none." },
          },
          {
            id: "exp-subset-filing",
            reference: "The layout is filed into the subset (the navigator book organization).",
            source: "archicad-27-layout-book",
            outcome: "exact",
            check: { kind: "echo", equals: "NAVASSIGN: layout 'A-101 Ground Floor Plan' → 'A Series'." },
          },
        ],
      },
    ],
    interop: [
      {
        id: "io-book-sheet-pdf",
        surface: "sheet",
        concept: "The layout sheet export determinism",
        reference: "The layout output is deterministic (identical layout → identical output).",
        source: "archicad-27-layout-book",
        expected: "exact",
        note: "PDF export digest stable across repeated export",
        probe: { kind: "sheetExportDigestStable", format: "pdf" },
      },
      {
        id: "io-book-sheet-dwg",
        surface: "sheet",
        concept: "The DWG per-sheet export boundary",
        reference: "The 2D carrier (DWG/DXF) is the documented layout export family; formats outside the supported carrier decline typed.",
        source: "archicad-27-interoperability",
        expected: "unsupported",
        note: "the unsupported per-sheet format declines typed (never fabricated)",
        probe: { kind: "sheetExportDecline", format: "dwg" },
      },
    ],
    perf: [{ label: "wf-layout-book total", budgetMs: 45000 }],
    robustness: { roundTrip: true, undoRedoSteps: 1, replayStable: true },
  },

  // -------------------------------------------------------------------------
  // WF-A5 — the publisher + the revision workflow (the issue set).
  // -------------------------------------------------------------------------
  {
    id: "wf-publisher-revisions",
    title: "Publisher sets, revisions and the deterministic issue set",
    discipline: "documentation",
    sources: ["archicad-27-publishing", "archicad-27-revision-management", "archicad-27-layout-book"],
    referenceBehavior:
      "Archicad 27 documented publisher/revision behavior: the Publisher collects the layout-book items (layouts/subsets) into publisher sets and publishes the set (e.g. PDF — one page per item; the same set publishes the same output deterministically); revision management records the issue history (unique code + description), applies revisions to layouts and tracks them on the issued sheets.",
    phases: [
      {
        id: "layouts-seed",
        title: "The layouts being published (the publication units)",
        script: [
          { event: { type: "typed", text: "LAYOUTNEW" } },
          { event: { type: "typed", text: "A-101 Ground Floor Plan" } },
          { event: { type: "typed", text: "LAYOUTNEW" } },
          { event: { type: "typed", text: "A-102 First Floor Plan" } },
        ],
        expectations: [
          {
            id: "exp-pub-layouts",
            reference: "The layouts exist to be published (the publication units of the set).",
            source: "archicad-27-layout-book",
            outcome: "exact",
            check: { kind: "state", path: "layouts.length", equals: 2 },
          },
        ],
      },
      {
        id: "revision",
        title: "The revision record (REVISION → REVLIST — the issue history)",
        script: [
          { event: { type: "typed", text: "REVISION" } },
          { event: { type: "typed", text: "P01" } },
          { event: { type: "typed", text: "First issue for coordination" } },
          { event: { type: "typed", text: "A-101 Ground Floor Plan" } },
          { event: { type: "typed", text: "REVLIST" } },
        ],
        expectations: [
          {
            id: "exp-revision",
            reference: "The revision workflow records the issue history (unique code + description + the layouts it applies to).",
            source: "archicad-27-revision-management",
            outcome: "exact",
            check: { kind: "echo", equals: "REVISION: 'P01' — 1 layout(s)." },
          },
          {
            id: "exp-revision-record",
            reference: "The revision applies to the declared layout (the tracked issue).",
            source: "archicad-27-revision-management",
            outcome: "exact",
            check: { kind: "state", path: "revisions.0.layoutIds.0", equals: "lo-000001" },
          },
        ],
      },
      {
        id: "publisher",
        title: "The publisher set + the publication command (PUBSET → PUBLISHBOOK)",
        script: [
          { event: { type: "typed", text: "PUBSET" } },
          { event: { type: "typed", text: "Issue Set" } },
          { event: { type: "typed", text: "layout:A-101 Ground Floor Plan|layout:A-102 First Floor Plan" } },
          { event: { type: "typed", text: "PUBLISHBOOK" } },
          { event: { type: "typed", text: "Issue Set" } },
        ],
        expectations: [
          {
            id: "exp-pubset",
            reference: "The Publisher set collects the layout-book items to publish.",
            source: "archicad-27-publishing",
            outcome: "exact",
            check: { kind: "echo", equals: "PUBSET: 'Issue Set' — 2 item(s)." },
          },
          {
            id: "exp-publishbook",
            reference: "The PUBLISHBOOK command publishes the set (the Publisher action through the command line).",
            source: "archicad-27-publishing",
            outcome: "exact",
            check: { kind: "echo", equals: "PUBLISHBOOK: 'Issue Set'." },
          },
        ],
      },
      {
        id: "publication",
        title: "The publisher run (the deterministic publication output)",
        commands: [
          { name: "publisher.run", payload: { id: "pub-000001" }, as: "publish" },
        ],
        expectations: [
          {
            id: "exp-publish",
            reference: "Publishing the set produces the output (one page per item) — the same set publishes the same output deterministically.",
            source: "archicad-27-publishing",
            outcome: "exact",
            check: { kind: "result", of: "publish", path: "pages.length", equals: 2 },
          },
        ],
      },
    ],
    interop: [
      {
        id: "io-pub-pdf",
        surface: "sheet",
        concept: "The published PDF determinism",
        reference: "Publishing the same set produces the same output (the deterministic publication).",
        source: "archicad-27-publishing",
        expected: "exact",
        note: "PDF export digest stable across repeated export",
        probe: { kind: "sheetExportDigestStable", format: "pdf" },
      },
    ],
    perf: [{ label: "wf-publisher-revisions total", budgetMs: 45000 }],
    robustness: { roundTrip: true, undoRedoSteps: 1, replayStable: true },
  },


  // -------------------------------------------------------------------------
  // WF-A6 — the interactive schedules + the properties/materials feeding
  // them (the data-extraction workflow).
  // -------------------------------------------------------------------------
  {
    id: "wf-schedules-quantities",
    title: "Interactive schedules, properties and quantity takeoff",
    discipline: "bim",
    sources: ["archicad-27-interactive-schedule", "archicad-27-properties", "archicad-27-attributes"],
    referenceBehavior:
      "Archicad 27 documented schedule/property behavior: the Interactive Schedule extracts element/component data into tables (the scheme's criteria filter the source elements; the columns carry the properties and quantities); custom properties are declared as typed definitions in property groups, optionally limited to selected element types (applies-to), and carried by the elements; building materials are project attributes (category/density) assigned to structures; quantity takeoffs derive the per-element quantities from the model deterministically; the schedule refreshes from the live model.",
    phases: [
      {
        id: "model-seed",
        title: "The model the schedule extracts (walls + slab + spaces on the story)",
        commands: [
          {
            name: "bim.createElements",
            payload: {
              entities: [
                { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
                { type: "bim.wall", id: "wall-a", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 240, height: 3000 },
                { type: "bim.wall", id: "wall-b", storyId: "story-gf", start: [0, 0], end: [0, 4000], width: 240, height: 3000 },
                { type: "bim.slab", id: "slab-1", storyId: "story-gf", corner1: [0, 0], corner2: [6000, 4000], thickness: 200 },
                { type: "bim.space", id: "space-1", storyId: "story-gf", name: "Office", footprint: [[100, 100], [5900, 100], [5900, 3900], [100, 3900]], height: 3000 },
              ],
            },
            as: "seed",
          },
        ],
        expectations: [
          {
            id: "exp-schedule-model",
            reference: "The scheduled model exists (the walls/slab/space on the story).",
            source: "archicad-27-interactive-schedule",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.wall", equals: 2 },
          },
        ],
      },
      {
        id: "properties-materials",
        title: "The custom properties + the building material (PROPDEF + the material attribute + the assignment)",
        script: [
          { event: { type: "typed", text: "PROPDEF" } },
          { event: { type: "typed", text: "Fire rating" } },
          { event: { type: "typed", text: "PSet Safety" } },
          { event: { type: "typed", text: "FireRating" } },
          { event: { type: "typed", text: "NUM" } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "min" } },
          { event: { type: "typed", text: "bim.wall,bim.slab" } },
          { event: { type: "typed", text: "PROPLIST" } },
        ],
        commands: [
          { name: "material.create", payload: { name: "Concrete C30", category: "Concrete", density: 2400 }, as: "material" },
          { name: "material.assign", payload: { ids: ["wall-a", "wall-b"], materialId: "el-000001" }, as: "assign" },
        ],
        expectations: [
          {
            id: "exp-propdef",
            reference: "The custom property is declared as a typed definition in its property group (applies-to the wall/slab types — the property-manager overview lists it).",
            source: "archicad-27-properties",
            outcome: "exact",
            check: { kind: "echo", equals: "PROPLIST." },
          },
          {
            id: "exp-material-attribute",
            reference: "The building material is a project attribute (category/density — the document-unique exchange identity).",
            source: "archicad-27-attributes",
            outcome: "exact",
            check: { kind: "result", of: "material", path: "materialId", equals: "el-000001" },
          },
        ],
      },
      {
        id: "schedule-qto",
        title: "The schedule + the quantity takeoff (SCHEDULE → SCHLIST + QTO)",
        script: [
          { event: { type: "typed", text: "SCHEDULE" } },
          { event: { type: "typed", text: "Wall schedule" } },
          { event: { type: "typed", text: "EL" } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "bim.wall" } },
          { event: { type: "typed", text: "SCHLIST" } },
          { event: { type: "typed", text: "QTO" } },
          { event: { type: "typed", text: "EL" } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "TY" } },
          { event: { type: "enter" } },
          { event: { type: "enter" } },
        ],
        queries: [{ name: "quantities.run", payload: { source: "elements", groupBy: "type" }, as: "qto" }],
        expectations: [
          {
            id: "exp-schedule-scheme",
            reference: "The Interactive Schedule scheme extracts the filtered elements into the table (the criteria + the default column set).",
            source: "archicad-27-interactive-schedule",
            outcome: "exact",
            check: { kind: "echo", equals: "SCHEDULE: 'Wall schedule' (elements, type bim.wall) — 9 columns." },
          },
          {
            id: "exp-qto-rows",
            reference: "The quantity takeoff derives the per-element quantities from the model (the deterministic rows — one per element carrying a canonical quantity rule).",
            source: "archicad-27-interactive-schedule",
            outcome: "exact",
            check: { kind: "result", of: "qto", path: "rows.length", equals: 4 },
          },
          {
            id: "exp-qto-totals",
            reference: "The takeoff totals aggregate every measured row deterministically.",
            source: "archicad-27-interactive-schedule",
            outcome: "exact",
            check: { kind: "result", of: "qto", path: "totals.count", equals: 4 },
          },
        ],
      },
      {
        id: "material-refusal",
        title: "The typed material-assignment refusal (an unknown building material is refused — never fabricated)",
        expectations: [
          {
            id: "exp-material-assign-refusal",
            reference: "Assigning an unknown building material is a typed refusal (material_not_found) — never a fabricated assignment (the attribute discipline).",
            source: "archicad-27-attributes",
            outcome: "unsupported",
            rationale: "The typed refusal is the honest boundary: the attribute registry never guesses an id.",
            check: {
              kind: "decline",
              command: "material.assign",
              payload: { ids: ["wall-a"], materialId: "el-999999" },
              code: "material_not_found",
              via: "command",
            },
          },
        ],
      },
    ],
    interop: [
      {
        id: "io-schedules-ifc",
        surface: "ifc",
        concept: "The scheduled model at the IFC boundary",
        reference: "The IFC translator carries the model semantics the schedule extracts (the property/material basis).",
        source: "archicad-27-ifc",
        expected: "exact",
        note: "the DRY IFC round-trip over the same state is zero-loss by design (COMPAT-IFC-001)",
        probe: { kind: "ifcAggregate" },
      },
    ],
    perf: [{ label: "wf-schedules-quantities total", budgetMs: 45000 }],
    robustness: { roundTrip: true, undoRedoSteps: 1, replayStable: true },
  },

  // -------------------------------------------------------------------------
  // WF-A7 — the IFC exchange workflow (the openBIM boundary).
  // -------------------------------------------------------------------------
  {
    id: "wf-ifc-exchange",
    title: "The IFC exchange workflow (export, import, the classification basis)",
    discipline: "interop",
    sources: ["archicad-27-ifc", "archicad-27-properties", "archicad-27-interoperability"],
    referenceBehavior:
      "Archicad 27 documented IFC-translator behavior: the export produces the IFC model of the virtual building (the elements with their classification/properties — the openBIM representation); the import reconciles the IFC model back into the project; the exchange is the documented openBIM basis (the structured BIM semantics — walls/slabs/spaces as IfcWall/IfcSlab/IfcSpace with geometry); the 2D carrier (DXF/DWG) is the OTHER documented boundary carrying the drawing linework (not the BIM semantics); classification systems classify elements for the exchange.",
    phases: [
      {
        id: "model-seed",
        title: "The model being exchanged (the two-story building)",
        commands: [
          {
            name: "bim.createElements",
            payload: {
              entities: [
                { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
                { type: "bim.wall", id: "wall-a", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 240, height: 3000 },
                { type: "bim.slab", id: "slab-1", storyId: "story-gf", corner1: [0, 0], corner2: [6000, 4000], thickness: 200 },
                { type: "bim.space", id: "space-1", storyId: "story-gf", name: "Office", footprint: [[100, 100], [5900, 100], [5900, 3900], [100, 3900]], height: 3000 },
              ],
            },
            as: "seed",
          },
        ],
        expectations: [
          {
            id: "exp-ifc-model",
            reference: "The model exists for the exchange (the walls/slab/space).",
            source: "archicad-27-ifc",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.wall", equals: 1 },
          },
        ],
      },
      {
        id: "classification",
        title: "The element classification (the classification basis of the exchange)",
        commands: [
          {
            name: "bim.setClassification",
            payload: { elementId: "wall-a", classificationRef: "OFFISOS-ARCH-100" },
            as: "classification",
          },
        ],
        queries: [
          { name: "bim.getClassification", payload: {}, as: "classifications" },
          { name: "bim.getLifecycle", payload: { elementId: "wall-a" }, as: "lifecycle" },
        ],
        expectations: [
          {
            id: "exp-classification-vocabulary",
            reference: "Classification systems classify elements (the closed classification vocabulary available to the model — the exchange classification basis).",
            source: "archicad-27-properties",
            outcome: "exact",
            check: { kind: "result", of: "classifications", path: "codes.length", equals: 11 },
          },
          {
            id: "exp-classification",
            reference: "The element carries its classification reference (the wall classified in the system).",
            source: "archicad-27-properties",
            outcome: "exact",
            check: { kind: "result", of: "lifecycle", path: "elements.0.classificationRef", equals: "OFFISOS-ARCH-100" },
          },
        ],
      },
      {
        id: "export",
        title: "The translator export (the openBIM output of the model)",
        commands: [
          { name: "ifc.export", payload: { projectName: "P020 Certification" }, as: "ifc-export" },
        ],
        expectations: [
          {
            id: "exp-ifc-schema",
            reference: "The IFC translator exports the model in the IFC4 schema (the openBIM representation).",
            source: "archicad-27-ifc",
            outcome: "exact",
            check: { kind: "result", of: "ifc-export", path: "schema", equals: "IFC4" },
          },
          {
            id: "exp-ifc-counts",
            reference: "The export carries the model's elements (the walls/slabs/spaces of the exchanged model — the counted basis, the import loop is certified by the live interop probe).",
            source: "archicad-27-ifc",
            outcome: "exact",
            check: { kind: "result", of: "ifc-export", path: "counts.walls", equals: 1 },
          },
        ],
      },
    ],
    interop: [
      {
        id: "io-ifc-model",
        surface: "ifc",
        concept: "The BIM model at the IFC boundary (walls/slabs/spaces)",
        reference: "The Archicad IFC translator exports the model as the IFC representation of the virtual building.",
        source: "archicad-27-ifc",
        expected: "exact",
        note: "the DRY IFC round-trip over the same state is zero-loss by design (COMPAT-IFC-001)",
        probe: { kind: "ifcAggregate" },
      },
      {
        id: "io-ifc-toolsets-identity",
        surface: "ifc",
        concept: "The specialized record identity at the IFC boundary",
        reference: "The IFC exchange carries the structured semantics (identity + properties) of the shared model records.",
        source: "archicad-27-ifc",
        expected: "exact",
        note: "on one IfcGroup per record",
        probe: { kind: "toolsetsInterop", conceptId: "specialized-record-identity", surface: "ifc" },
      },
      {
        id: "io-ifc-toolsets-arrays",
        surface: "ifc",
        concept: "The structured arrays at the IFC boundary (the flattened carrier)",
        reference: "The IFC exchange carries the structured array semantics in the documented flattened joined-string carrier — the values round-trip byte-exactly, but the representation is not native IFC structure (the honest lossy boundary of the exchange).",
        source: "archicad-27-ifc",
        expected: "lossy",
        note: "ride the documented escaped joined-string carrier",
        probe: { kind: "toolsetsInterop", conceptId: "specialized-record-structured-arrays", surface: "ifc" },
      },
      {
        id: "io-dxf-2d-carrier",
        surface: "dxf",
        concept: "The 2D carrier boundary (the drawing, not the BIM semantics)",
        reference: "The 2D carrier (DXF/DWG) is the other documented boundary — it carries drawing linework, not the full BIM semantics.",
        source: "archicad-27-interoperability",
        expected: "unsupported",
        note: "the BIM elements are counted-and-skipped at the DXF boundary (never fabricated)",
        probe: { kind: "dxfUnsupportedTypes", includes: ["bim"] },
      },
    ],
    perf: [{ label: "wf-ifc-exchange total", budgetMs: 60000 }],
    robustness: { roundTrip: true, undoRedoSteps: 1, replayStable: true },
  },

  // -------------------------------------------------------------------------
  // WF-A8 — the teamwork / change-tracking workflow (the shared model).
  // -------------------------------------------------------------------------
  {
    id: "wf-teamwork-changes",
    title: "Teamwork: the shared model with presence, comments, transactions and recovery",
    discipline: "collab",
    sources: ["archicad-27-teamwork", "archicad-27-change-tracking", "archicad-27-stories"],
    referenceBehavior:
      "Archicad 27 documented teamwork/change behavior: team members join the shared project with roles; the shared model is collaborated on with presence and comments; changes over the shared model are versioned and tracked (who changed what); the shared state is durable — recovery from the recorded state is the documented workflow basis. The BIMcloud reservation model is NOT reproduced by the Offisos analog (the honest boundary: the Offisos model is presence/comment/versioned-transaction based — declared here, never claimed as reservation parity).",
    phases: [
      {
        id: "join",
        title: "The team joins the shared project (COLLABJOIN with the closed roles)",
        script: [
          { event: { type: "typed", text: "COLLABJOIN" } },
          { event: { type: "typed", text: "architect" } },
          { event: { type: "typed", text: "ED" } },
          { event: { type: "enter" } },
        ],
        expectations: [
          {
            id: "exp-join",
            reference: "Team members join the shared project (the member/role model).",
            source: "archicad-27-teamwork",
            outcome: "exact",
            check: { kind: "echo", equals: "COLLABJOIN: member 'architect' joined as editor." },
          },
        ],
      },
      {
        id: "presence-comment",
        title: "The presence + the comment (the shared-model communication)",
        script: [
          { event: { type: "typed", text: "PRESENCE" } },
          { event: { type: "typed", text: "architect" } },
          { event: { type: "typed", text: "COMMENT" } },
          { event: { type: "typed", text: "architect" } },
          { event: { type: "typed", text: "Zone program review at 10:00" } },
          { event: { type: "enter" } },
          { event: { type: "enter" } },
        ],
        queries: [{ name: "collab.state", payload: {}, as: "collabstate" }],
        expectations: [
          {
            id: "exp-presence",
            reference: "The shared roster records the collaborating member's presence (the heartbeat over the shared model).",
            source: "archicad-27-teamwork",
            outcome: "exact",
            check: { kind: "echo", equals: "PRESENCE: heartbeat for 'architect'." },
          },
          {
            id: "exp-comment",
            reference: "The comment is recorded on the shared model (the team communication).",
            source: "archicad-27-teamwork",
            outcome: "exact",
            check: { kind: "echo", equals: "COMMENT: 'architect' on document." },
          },
          {
            id: "exp-member-roster",
            reference: "The shared roster carries the joined member (the collaboration state).",
            source: "archicad-27-teamwork",
            outcome: "exact",
            check: { kind: "result", of: "collabstate", path: "members.length", equals: 1 },
          },
        ],
      },
      {
        id: "checkpoint-recover",
        title: "The durable checkpoint + the deterministic recovery (the change-tracking basis)",
        script: [
          { event: { type: "typed", text: "CKPT" } },
          { event: { type: "typed", text: "RECOVER" } },
          { event: { type: "enter" } },
        ],
        queries: [{ name: "recovery.list", payload: {}, as: "checkpoints" }],
        expectations: [
          {
            id: "exp-checkpoint",
            reference: "The shared state is durable — the checkpoint records the current state for recovery.",
            source: "archicad-27-change-tracking",
            outcome: "exact",
            check: { kind: "result", of: "checkpoints", path: "checkpoints.length", equals: 2 },
          },
        ],
      },
    ],
    interop: [
      {
        id: "io-bcf-references",
        surface: "bcf",
        concept: "The collaboration references to canonical elements",
        reference: "The BCF boundary carries the topic references to the shared model's canonical elements (the openBIM collaboration surface).",
        source: "archicad-27-interoperability",
        expected: "exact",
        note: "are canonical elements: BCF topic references resolve through ifcGuidFor(element id) exactly",
        probe: { kind: "toolsetsInterop", conceptId: "bcf-references-to-canonical-elements", surface: "bcf" },
      },
    ],
    perf: [{ label: "wf-teamwork-changes total", budgetMs: 45000 }],
    robustness: { roundTrip: true, undoRedoSteps: 1, replayStable: true },
  },
];

// ---------------------------------------------------------------------------
// The corpus digest (the version pin).
// ---------------------------------------------------------------------------

/**
 * The digest basis: the corpus data that defines the certification — the
 * reference pin, the manifest, the analog map and the workflows. Pure
 * data; the canonical encoding is stable.
 */
function archicadCorpusDigestData() {
  return {
    reference: ARCHICAD_CORPUS_REFERENCE,
    manifest: ARCHICAD_REFERENCE_MANIFEST,
    analogs: ARCHICAD_COMMAND_ANALOGS,
    workflows: ARCHICAD_WORKFLOWS,
  };
}

let cachedArchicadCorpusJson: string | null = null;

/** The canonical JSON encoding of the pinned Archicad corpus data (stable). */
export function archicadCorpusCanonicalJson(): string {
  if (cachedArchicadCorpusJson === null) {
    cachedArchicadCorpusJson = canonicalStringify(archicadCorpusDigestData());
  }
  return cachedArchicadCorpusJson;
}

/** The stable sha256 over the canonical Archicad corpus encoding (the version pin). */
export function archicadCorpusSha256(): string {
  return createHash("sha256").update(archicadCorpusCanonicalJson(), "utf8").digest("hex");
}

/** The declared outcome-classification counts over the whole Archicad corpus. */
export function archicadCorpusOutcomeCounts(): { exact: number; lossy: number; unsupported: number; interopExact: number; interopLossy: number; interopUnsupported: number } {
  let exact = 0;
  let lossy = 0;
  let unsupported = 0;
  for (const w of ARCHICAD_WORKFLOWS) {
    for (const p of w.phases) {
      for (const e of p.expectations) {
        if (e.outcome === "exact") exact += 1;
        else if (e.outcome === "lossy") lossy += 1;
        else unsupported += 1;
      }
    }
  }
  let interopExact = 0;
  let interopLossy = 0;
  let interopUnsupported = 0;
  for (const w of ARCHICAD_WORKFLOWS) {
    for (const i of w.interop) {
      if (i.expected === "exact") interopExact += 1;
      else if (i.expected === "lossy") interopLossy += 1;
      else interopUnsupported += 1;
    }
  }
  return { exact, lossy, unsupported, interopExact, interopLossy, interopUnsupported };
}

// ---------------------------------------------------------------------------
// The derived Archicad corpus catalog (the single source of truth for the
// Certification workbench's corpus selector — derived HERE, never
// hard-coded in the UI).
// ---------------------------------------------------------------------------

/** The derived per-workflow catalog row for the Archicad corpus. */
export interface ArchicadCatalogWorkflow {
  readonly id: string;
  readonly title: string;
  readonly discipline: string;
  readonly phases: number;
  readonly expectations: number;
}

/** The derived Archicad corpus catalog (the workbench's second catalog). */
export function archicadCorpusCatalog(): {
  readonly corpus: {
    readonly id: string;
    readonly version: string;
    readonly referenceProduct: string;
    readonly sha256: string;
  };
  readonly sources: readonly {
    readonly id: string;
    readonly product: string;
    readonly title: string;
    readonly locator: string;
    readonly docId: string;
    readonly scope: string;
  }[];
  readonly commandBindings: {
    readonly semanticAnalogs: readonly { readonly offisosSurface: string; readonly surface: string; readonly archicadReference: string; readonly source: string; readonly scope: string }[];
  };
  readonly workflows: readonly ArchicadCatalogWorkflow[];
  readonly totals: { readonly workflows: number; readonly phases: number; readonly expectations: number; readonly interop: number };
} {
  const manifestIds = new Set(ARCHICAD_REFERENCE_MANIFEST.map((s) => s.id));
  const workflows: ArchicadCatalogWorkflow[] = ARCHICAD_WORKFLOWS.map((w) => ({
    id: w.id,
    title: w.title,
    discipline: w.discipline,
    phases: w.phases.length,
    expectations: w.phases.reduce((n, p) => n + p.expectations.length, 0),
  }));
  return {
    corpus: {
      id: ARCHICAD_CORPUS_REFERENCE.corpusId,
      version: ARCHICAD_CORPUS_REFERENCE.corpusVersion,
      referenceProduct: ARCHICAD_CORPUS_REFERENCE.referenceProduct,
      sha256: archicadCorpusSha256(),
    },
    sources: ARCHICAD_REFERENCE_MANIFEST.map((s) => ({
      id: s.id,
      product: s.product,
      title: s.title,
      locator: s.locator,
      docId: s.docId,
      scope: s.scope,
    })),
    commandBindings: {
      semanticAnalogs: ARCHICAD_COMMAND_ANALOGS.map((a) => ({
        offisosSurface: a.offisosSurface,
        surface: a.surface,
        archicadReference: a.archicadReference,
        source: manifestIds.has(a.source) ? a.source : "",
        scope: a.scope,
      })),
    },
    workflows,
    totals: {
      workflows: workflows.length,
      phases: workflows.reduce((n, w) => n + w.phases, 0),
      expectations: workflows.reduce((n, w) => n + w.expectations, 0),
      interop: ARCHICAD_WORKFLOWS.reduce((n, w) => n + w.interop.length, 0),
    },
  };
}

export type { CorpusWorkflow, CorpusScriptStep, CorpusExpectation, CorpusInteropExpectation, CorpusPerfTarget, CorpusRobustness };
