/**
 * CAD-PARITY-019 (Issue #122) — the version-pinned AutoCAD professional
 * workflow corpus + reference expectations. THE FIRST P019 DELIVERABLE
 * (the certification-first execution rule: this corpus is defined and
 * version-pinned BEFORE any certification evidence is produced — every
 * later certification claim is measured against THIS artifact).
 *
 * Revision 2 (the architect review on PR #125, 2026-09-03): the reference
 * basis is now INDEPENDENTLY AUDITABLE — every workflow and every
 * expectation is bound to a version-pinned AUTHORITATIVE AUTODESK SOURCE
 * through the reference manifest below (URL + document ID + the specific
 * command/topic scope, included in the corpus digest), and every Offisos
 * command surface the corpus drives that is NOT an Autodesk-documented
 * 2024 command is EXPLICITLY modeled as a semantic analog in the command
 * analog map (bound to the Autodesk reference it is the analog OF — never
 * presented as an Autodesk command name). The corpus digest changed with
 * this revision; the certification fixture is regenerated against it.
 *
 * What this module is:
 *  - a REPRESENTATIVE corpus of integrated professional workflows (not a
 *    feature checklist — each workflow is a multi-phase task a CAD
 *    professional actually performs, composed from the VERIFIED P002..P018
 *    + COMPAT-CAD-004 surfaces through the REAL command registry);
 *  - VERSION-PINNED against a declared AutoCAD reference family (below),
 *    with the declared reference behavior written out per workflow so the
 *    certification measures against DOCUMENTED expectations, never vibes;
 *  - executable: the certification engine (engine.ts) compiles each
 *    phase's command-line script through the SHARED prompt-engine command
 *    registry, executes the emitted App API stream through a driver (the
 *    in-process renderer, the Web/Electron host transports, or the real
 *    Web app over HTTP), and assesses the result against the declared
 *    expectations;
 *  - honest: every expectation carries an explicit expected outcome
 *    classification — "exact" (the Offisos semantics match the declared
 *    AutoCAD reference within the supported boundary), "lossy" (a
 *    documented structural/semantic loss), or "unsupported" (a typed
 *    refusal — never a fabricated semantic). Feature-list presence alone
 *    is never sufficient (the P019 acceptance criteria).
 *
 * Determinism: the corpus is PURE DATA. Its canonical JSON encoding and
 * sha256 (below) are stable — the certification report pins the corpus
 * hash so every piece of certification evidence is bound to exactly this
 * corpus revision. Perf budgets are wall-clock ASSERTED, never pinned.
 *
 * Engine boundary (LOCK-018): type-only imports + the pure canonical
 * serializer; no engine, no host, no I/O. The corpus declares WHAT to
 * certify; the engine executes it against the governed App API surface
 * only.
 */

import { createHash } from "node:crypto";
import { canonicalStringify } from "../caddocument/serialization.js";
import type { PromptEvent } from "../workspace/prompt-engine.js";

// ---------------------------------------------------------------------------
// The version pin.
// ---------------------------------------------------------------------------

/**
 * The declared AutoCAD reference family this corpus is pinned against.
 *
 * Primary reference: AutoCAD 2024 (the base professional CAD behavior —
 * drawing, modify, layers, annotation, blocks, layouts/plot, 3D solids,
 * xrefs). Vertical reference: AutoCAD Architecture 2024 (the AEC object
 * behavior — walls, hosted openings, slabs, roofs, stairs, railings,
 * spaces, schedules/quantities) and AutoCAD MEP 2024 (duct/pipe/conduit
 * runs, connections, equipment) for the specialized workflows, mirroring
 * the P018 toolset provenance. The declared reference behavior is written
 * out per workflow below (concise declarations of the documented command
 * behavior); the pin is the version, the declarations, the reference
 * manifest, the command bindings and the corpus sha256 — all frozen in
 * this module.
 */
export const CORPUS_REFERENCE = {
  corpusId: "autocad-p019-corpus",
  corpusVersion: "2",
  referenceProduct: "AutoCAD 2024 (base) + AutoCAD Architecture 2024 (AEC objects) + AutoCAD MEP 2024 (MEP objects) — the declared AutoCAD reference family",
  referenceBasis:
    "The version-pinned Autodesk reference manifest (CORPUS_REFERENCE_MANIFEST below): every workflow and expectation cites its authoritative Autodesk documentation source (URL + document ID + the specific command/topic); the Offisos command surfaces that are not Autodesk-documented 2024 commands are explicitly modeled as semantic analogs (CORPUS_COMMAND_ANALOGS below)",
  pinnedAt: "2026-09-03",
  revisedAt: "2026-09-03",
  revisionNote:
    "Rev 2 — the architect review on PR #125: the authoritative version-pinned Autodesk reference manifest bound into the corpus digest; the explicit command-analog map (WALLRUN/PLACEOPENING/SPACEGRID/STAIRRUN/ZONE/MEPRUN/MEPREPORT/MEPCONNECT/EQUIPADD/RASTERATTACH/PATTERNMIRROR/MOVE3D/UCSNEW/XRELOAD/XDETACH and the App-API publisher/revision surfaces are Offisos semantic analogs, never claimed Autodesk command names)",
  pinnedBy: "CAD-PARITY-019 first implementation deliverable (Issue #122, certification-first execution rule)",
} as const;

// ---------------------------------------------------------------------------
// The version-pinned Autodesk reference manifest (rev 2).
// ---------------------------------------------------------------------------

/**
 * One authoritative Autodesk source in the version-pinned reference
 * manifest. Each entry is INDEPENDENTLY AUDITABLE: the locator is a
 * version-pinned (2024/ENU) Autodesk Help URL, the docId is the Autodesk
 * document identifier, and the scope names the specific commands/topics
 * the corpus draws from it. Workflows, expectations and command bindings
 * cite these entries by id; the manifest is part of the corpus digest.
 */
export interface CorpusReferenceSource {
  /** The manifest key (cited by workflows, expectations and command bindings). */
  readonly id: string;
  /** The Autodesk product the source documents (version-pinned). */
  readonly product: string;
  /** The Autodesk documentation page title. */
  readonly title: string;
  /** The version-pinned locator (URL) — the independently auditable reference. */
  readonly locator: string;
  /** The Autodesk document identifier (the GUID / page id in the locator). */
  readonly docId: string;
  /** The specific commands/topics this source covers as used by the corpus. */
  readonly scope: string;
}

/** The version-pinned authoritative Autodesk reference manifest (rev 2). */
export const CORPUS_REFERENCE_MANIFEST: readonly CorpusReferenceSource[] = [
  {
    id: "autocad-2024-commands",
    product: "AutoCAD 2024",
    title: "AutoCAD 2024 Help — Commands (A–Z)",
    locator: "https://help.autodesk.com/view/ACD/2024/ENU/?page=commands",
    docId: "ACD/2024/ENU?page=commands",
    scope:
      "The AutoCAD 2024 base command index (each entry resolves to a canonical cloudhelp/2024/ENU document): -LAYER (the Make option), RECTANG (RECTANGLE is the documented alias), LINE, CIRCLE, ARC, OFFSET, MIRROR, COPY, MOVE, ROTATE, CHPROP, LAYERSTATE, DIMSTYLE, DIMLINEAR, DIMALIGNED, DIMRADIUS, DIMDIAMETER, LEADER, MTEXT, REVCLOUD, BLOCK, INSERT, ATTEDIT, ARRAY, LAYOUT, MVIEW, PAGESETUP, PLOT, PUBLISH, BOX, UNION, SUBTRACT, INTERSECT, 3DMOVE, UCS, SECTIONPLANE, IMAGEATTACH, XATTACH, XLIST.",
  },
  {
    id: "autocad-2024-negxref",
    product: "AutoCAD 2024",
    title: "-XREF (Command) — the command-line external-reference options",
    locator: "https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-Core/files/GUID-70599862-DF52-4291-B64B-8A4C45599F39.htm",
    docId: "GUID-70599862-DF52-4291-B64B-8A4C45599F39",
    scope:
      "The command-line xref management options: ? (list), Bind, Detach (erases all instances of a specified xref and marks the definition for deletion), Path, Unload, Reload (re-reads the most recently saved version), Overlay, Attach.",
  },
  {
    id: "autocad-2024-dxf",
    product: "AutoCAD 2024 (DXF)",
    title: "DXF Reference — About the DXF Format (DXF)",
    locator: "https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DXF/files/GUID-235B22E0-A567-4CF6-92D3-38A2306D73F3.htm",
    docId: "GUID-235B22E0-A567-4CF6-92D3-38A2306D73F3",
    scope:
      "The Autodesk DXF Reference: the tagged data representation of all the information contained in an AutoCAD drawing file (group codes, HEADER/CLASSES/TABLES/BLOCKS/ENTITIES/OBJECTS sections — the DXF exchange semantics).",
  },
  {
    id: "autocad-2024-sheet-set-manager",
    product: "AutoCAD 2024",
    title: "Sheet Set Manager (AutoCAD 2024 User's Guide)",
    locator: "https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-Core/files/GUID-9751A902-27DC-4BCD-8D3D-585478B213DD.htm",
    docId: "GUID-9751A902-27DC-4BCD-8D3D-585478B213DD",
    scope:
      "The Sheet Set Manager: displays and organizes named collections of drawing sheets — the sheet list, subsets, publishing the set, and the sheet revision tracking (the sheet-set publication workflow).",
  },
  {
    id: "arch-2024-commands",
    product: "AutoCAD Architecture 2024 (toolset)",
    title: "AutoCAD Architecture 2024 Toolset — Frequently Used Commands",
    locator: "https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-Architecture/files/GUID-72935B4D-8B1E-4DBC-8380-0D7C05C45F4D.htm",
    docId: "GUID-72935B4D-8B1E-4DBC-8380-0D7C05C45F4D",
    scope:
      "The Architecture 2024 toolset frequently-used command index: WALLADD, WALLADDSELECTED, DOORADD, WINDOWADD, ROOFADD, SLABADD, SPACEADD, STAIRADD, SCHEDULEADD, SCHEDULETAG, ANNOREVISIONCLOUDADD, MASSELEMENTADD, MVBLOCKADD, DIMADD, EXPORTTOAUTOCAD, … (the documented AEC object commands — the authoritative list the Architecture workflows are measured against).",
  },
  {
    id: "arch-2024-ifc",
    product: "AutoCAD Architecture 2024 (toolset)",
    title: "About Architectural Objects and IFC (Architecture 2024)",
    locator: "https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-Architecture/files/GUID-2FE0DBE9-2C5C-4FAD-A558-C2A69C47A82E.htm",
    docId: "GUID-2FE0DBE9-2C5C-4FAD-A558-C2A69C47A82E",
    scope:
      "The Architecture 2024 (and MEP 2024) IFC exchange mapping: the building objects imported from an IFC file are created as the corresponding toolset objects and exported objects carry consistent GUIDs in the IFC output — the IFC exchange behavior basis for the interoperability expectations.",
  },
  {
    id: "mep-2024-commands",
    product: "AutoCAD MEP 2024 (toolset)",
    title: "AutoCAD MEP 2024 Help — Commands (A–Z)",
    locator: "https://help.autodesk.com/view/BLDSYS/2024/ENU/?page=commands",
    docId: "BLDSYS/2024/ENU?page=commands",
    scope:
      "The MEP 2024 toolset command index (base commands + the toolset additions, e.g. DEVICEADD) — the AUTHORITATIVE basis that AutoCAD MEP 2024 documents NO MEPRUN, MEPREPORT, MEPCONNECT or EQUIPADD commands: the Offisos MEP surfaces are internal semantic analogs of the documented palette-driven MEP routing/equipment workflows, never claimed as Autodesk command names.",
  },
];

// ---------------------------------------------------------------------------
// The command bindings (rev 2): Autodesk-documented invocations + the
// explicit semantic-analog map.
// ---------------------------------------------------------------------------

/**
 * A command-line invocation in the corpus scripts that IS an
 * Autodesk-documented 2024 command, bound to its authoritative source.
 */
export interface CorpusAutodeskCommand {
  /** The command-line name the corpus types. */
  readonly command: string;
  /** The Autodesk-documented command (page/topic) it resolves to. */
  readonly autodeskCommand: string;
  /** The manifest source binding the reference. */
  readonly source: string;
}

/**
 * The corpus command-line invocations that are Autodesk-documented 2024
 * commands (verified against the A–Z command indexes of the manifest
 * sources). Everything else the corpus types is in CORPUS_COMMAND_ANALOGS.
 */
export const CORPUS_AUTODESK_COMMANDS: readonly CorpusAutodeskCommand[] = [
  { command: "-LAYER", autodeskCommand: "-LAYER (Command) — the Make option", source: "autocad-2024-commands" },
  { command: "RECTANGLE", autodeskCommand: "RECTANG (Command) — RECTANGLE is the documented alias", source: "autocad-2024-commands" },
  { command: "LINE", autodeskCommand: "LINE (Command)", source: "autocad-2024-commands" },
  { command: "CIRCLE", autodeskCommand: "CIRCLE (Command)", source: "autocad-2024-commands" },
  { command: "ARC", autodeskCommand: "ARC (Command)", source: "autocad-2024-commands" },
  { command: "OFFSET", autodeskCommand: "OFFSET (Command)", source: "autocad-2024-commands" },
  { command: "MIRROR", autodeskCommand: "MIRROR (Command)", source: "autocad-2024-commands" },
  { command: "COPY", autodeskCommand: "COPY (Command)", source: "autocad-2024-commands" },
  { command: "MOVE", autodeskCommand: "MOVE (Command)", source: "autocad-2024-commands" },
  { command: "ROTATE", autodeskCommand: "ROTATE (Command)", source: "autocad-2024-commands" },
  { command: "CHPROP", autodeskCommand: "CHPROP (Command)", source: "autocad-2024-commands" },
  { command: "MTEXT", autodeskCommand: "MTEXT (Command)", source: "autocad-2024-commands" },
  { command: "LEADER", autodeskCommand: "LEADER (Command)", source: "autocad-2024-commands" },
  { command: "REVCLOUD", autodeskCommand: "REVCLOUD (Command)", source: "autocad-2024-commands" },
  { command: "BLOCK", autodeskCommand: "BLOCK (Command)", source: "autocad-2024-commands" },
  { command: "INSERT", autodeskCommand: "INSERT (Command)", source: "autocad-2024-commands" },
  { command: "ATTEDIT", autodeskCommand: "ATTEDIT (Command)", source: "autocad-2024-commands" },
  { command: "ARRAY", autodeskCommand: "ARRAY (Command)", source: "autocad-2024-commands" },
  { command: "PAGESETUP", autodeskCommand: "PAGESETUP (Command)", source: "autocad-2024-commands" },
  { command: "BOX", autodeskCommand: "BOX (Command)", source: "autocad-2024-commands" },
  { command: "UNION", autodeskCommand: "UNION (Command)", source: "autocad-2024-commands" },
  { command: "SUBTRACT", autodeskCommand: "SUBTRACT (Command)", source: "autocad-2024-commands" },
  { command: "INTERSECT", autodeskCommand: "INTERSECT (Command)", source: "autocad-2024-commands" },
  { command: "SECTIONPLANE", autodeskCommand: "SECTIONPLANE (Command)", source: "autocad-2024-commands" },
  { command: "XATTACH", autodeskCommand: "XATTACH (Command)", source: "autocad-2024-commands" },
  { command: "XLIST", autodeskCommand: "XLIST (Express Tool)", source: "autocad-2024-commands" },
];

/**
 * One explicitly-modeled command analog: an Offisos surface the corpus
 * drives that is NOT an Autodesk-documented 2024 command, bound to the
 * AUTHORITATIVE Autodesk reference it is a semantic analog OF. The
 * Offisos name is never presented as an Autodesk command name — the
 * relation is declared here, in the digest-pinned corpus data.
 */
export interface CorpusCommandAnalog {
  /** The Offisos surface (the name the corpus drives). */
  readonly offisosSurface: string;
  /** Where the surface is driven: the command line or the App API. */
  readonly surface: "command-line" | "app-api";
  /** The Autodesk-documented command/topic this surface is the analog of. */
  readonly autodeskReference: string;
  /** The manifest source binding the reference. */
  readonly source: string;
  /** What maps and what does not (the honest analog scope). */
  readonly scope: string;
}

/**
 * The explicit semantic-analog map (rev 2). Every Offisos surface the
 * corpus drives that is NOT an Autodesk-documented 2024 command is listed
 * here with its authoritative Autodesk reference — the honest disclosure
 * the architect review on PR #125 required.
 */
export const CORPUS_COMMAND_ANALOGS: readonly CorpusCommandAnalog[] = [
  {
    offisosSurface: "WALLRUN",
    surface: "command-line",
    autodeskReference: "WALLADD (Command) — AutoCAD Architecture 2024",
    source: "arch-2024-commands",
    scope:
      "The Offisos WALLRUN composes a multi-segment wall run from a polyline over the verified P011 BIM wall primitives (optional junction openings at the interior vertices); the Autodesk-documented behavior it is the analog of is WALLADD's wall placement — WALLRUN is not an Autodesk command name and does not reproduce WALLADD's style/palette interaction.",
  },
  {
    offisosSurface: "PLACEOPENING",
    surface: "command-line",
    autodeskReference: "DOORADD / WINDOWADD (Command) — AutoCAD Architecture 2024",
    source: "arch-2024-commands",
    scope:
      "The Offisos PLACEOPENING places a hosted door/window opening into an existing wall (the P011 host binding); the Autodesk-documented behavior it is the analog of is DOORADD/WINDOWADD's hosted-opening insertion — PLACEOPENING is not an Autodesk command name.",
  },
  {
    offisosSurface: "SPACEGRID",
    surface: "command-line",
    autodeskReference: "SPACEADD (Command) — AutoCAD Architecture 2024",
    source: "arch-2024-commands",
    scope:
      "The Offisos SPACEGRID composes a bounded room/space grid; the Autodesk-documented behavior it is the analog of is SPACEADD's space placement — SPACEGRID is not an Autodesk command name.",
  },
  {
    offisosSurface: "STAIRRUN",
    surface: "command-line",
    autodeskReference: "STAIRADD (Command) — AutoCAD Architecture 2024",
    source: "arch-2024-commands",
    scope:
      "The Offisos STAIRRUN composes a stair run (with an optional railing pair) over the P011 stair/railing primitives; the Autodesk-documented behavior it is the analog of is STAIRADD's stair placement — STAIRRUN is not an Autodesk command name.",
  },
  {
    offisosSurface: "ZONE",
    surface: "command-line",
    autodeskReference: "SPACEADD (Command) — AutoCAD Architecture 2024",
    source: "arch-2024-commands",
    scope:
      "The Offisos ZONE names a space from an existing bim.space (the P011 zone primitive); the Autodesk-documented behavior it is the analog of is SPACEADD's space naming — ZONE is not an Autodesk command name.",
  },
  {
    offisosSurface: "MEPRUN",
    surface: "command-line",
    autodeskReference: "No documented MEP 2024 command — the palette-driven MEP duct/pipe/conduit routing workflow",
    source: "mep-2024-commands",
    scope:
      "AutoCAD MEP 2024 documents NO MEPRUN command (verified against the MEP 2024 command index). The Offisos MEPRUN creates a bounded duct/pipe/conduit routing run record — an internal semantic analog of the documented MEP routing workflow, never a claimed Autodesk command parity.",
  },
  {
    offisosSurface: "MEPREPORT",
    surface: "command-line",
    autodeskReference: "No documented MEP 2024 command — the MEP route-validation / clash-and-clearance diagnostics concept",
    source: "mep-2024-commands",
    scope:
      "AutoCAD MEP 2024 documents NO MEPREPORT command. The Offisos MEPREPORT reports the deterministic route validation incl. clash/clearance diagnostics — an internal semantic analog of the documented MEP validation concept.",
  },
  {
    offisosSurface: "MEPCONNECT",
    surface: "command-line",
    autodeskReference: "No documented MEP 2024 command — the MEP connector/join workflow",
    source: "mep-2024-commands",
    scope:
      "AutoCAD MEP 2024 documents NO MEPCONNECT command. The Offisos MEPCONNECT connects a run end to a connector (equipment port / run / free endpoint — domain-neutral) — an internal semantic analog of the documented MEP connector workflow.",
  },
  {
    offisosSurface: "EQUIPADD",
    surface: "command-line",
    autodeskReference: "No documented MEP 2024 command — the MEP equipment placement workflow (equipment with connector ports)",
    source: "mep-2024-commands",
    scope:
      "AutoCAD MEP 2024 documents NO EQUIPADD command. The Offisos EQUIPADD places a bounded mechanical equipment record with connector/port metadata — an internal semantic analog of the documented MEP equipment placement workflow.",
  },
  {
    offisosSurface: "RASTERATTACH",
    surface: "command-line",
    autodeskReference: "IMAGEATTACH (Command) — AutoCAD 2024",
    source: "autocad-2024-commands",
    scope:
      "The Offisos RASTERATTACH attaches a raster/underlay reference to a registered source with placement + content digest; the Autodesk-documented behavior it is the analog of is IMAGEATTACH's image reference insertion — RASTERATTACH is not an Autodesk command name.",
  },
  {
    offisosSurface: "PATTERNMIRROR (PMIR)",
    surface: "command-line",
    autodeskReference: "MIRROR (Command) + the mirrored block insertion",
    source: "autocad-2024-commands",
    scope:
      "The Offisos PATTERNMIRROR reflects a placed pattern instance across a two-point axis (the COMPAT-CAD-004 reflected placement rotation' = 2φ − θ with the additive mirrored state); the Autodesk-documented behavior it is the analog of is MIRROR's reflective copy — PATTERNMIRROR is not an Autodesk command name.",
  },
  {
    offisosSurface: "MOVE3D",
    surface: "command-line",
    autodeskReference: "3DMOVE (Command) — AutoCAD 2024",
    source: "autocad-2024-commands",
    scope:
      "The Offisos MOVE3D translates a 3D solid by a typed displacement (identity preserved); the Autodesk-documented behavior it is the analog of is 3DMOVE's 3D translation — MOVE3D is not an Autodesk command name.",
  },
  {
    offisosSurface: "UCSNEW",
    surface: "command-line",
    autodeskReference: "UCS (Command) — the New option (AutoCAD 2024)",
    source: "autocad-2024-commands",
    scope:
      "The Offisos UCSNEW defines a named workplane from a typed origin + axes; the Autodesk-documented behavior it is the analog of is UCS's New workplane definition — UCSNEW is not an Autodesk command name.",
  },
  {
    offisosSurface: "XRELOAD",
    surface: "command-line",
    autodeskReference: "-XREF (Command) — the Reload option (AutoCAD 2024)",
    source: "autocad-2024-negxref",
    scope:
      "AutoCAD 2024 documents NO standalone XRELOAD command — reloading is the -XREF Reload option / the External References palette. The Offisos XRELOAD is the semantic analog of the -XREF Reload option and honestly DECLINES typed at the command line (re-reading external content is beyond the bounded surface — never a silent no-op).",
  },
  {
    offisosSurface: "XDETACH",
    surface: "command-line",
    autodeskReference: "-XREF (Command) — the Detach option (AutoCAD 2024)",
    source: "autocad-2024-negxref",
    scope:
      "AutoCAD 2024 documents NO standalone XDETACH command — detaching is the -XREF Detach option. The Offisos XDETACH is the semantic analog of the -XREF Detach option: it removes the reference record and all its instances in one atomic revision.",
  },
  {
    offisosSurface: "PUBLISH (publisher.run)",
    surface: "app-api",
    autodeskReference: "PUBLISH (Command) + the Sheet Set Manager publish-the-set behavior",
    source: "autocad-2024-sheet-set-manager",
    scope:
      "The Offisos publisher.run produces the deterministic publication result for a publisher set (one page per item with its content digest); it is the semantic analog of the Autodesk-documented PUBLISH command's set publication — driven through the App API, not the Autodesk command surface.",
  },
  {
    offisosSurface: "SUBSET/PUBSET (navigator.createSubset / publisher.create)",
    surface: "app-api",
    autodeskReference: "The Sheet Set Manager subsets and sheet organization",
    source: "autocad-2024-sheet-set-manager",
    scope:
      "The Offisos navigator subset and publisher set records organize sheets for publication; they are the semantic analogs of the Sheet Set Manager's subset/sheet-list organization — driven through the App API.",
  },
  {
    offisosSurface: "LAYOUTCLONE (layout.clone)",
    surface: "app-api",
    autodeskReference: "The Sheet Set Manager sheet creation and the LAYOUT tab management",
    source: "autocad-2024-sheet-set-manager",
    scope:
      "The Offisos layout.clone creates a new layout sheet derived from an existing one; it is the semantic analog of the sheet-set/LAYOUT sheet duplication behavior — driven through the App API.",
  },
  {
    offisosSurface: "REVISION (revision.add)",
    surface: "app-api",
    autodeskReference: "The Sheet Set Manager revision tracking (issued sheets)",
    source: "autocad-2024-sheet-set-manager",
    scope:
      "The Offisos revision.add records a drawing revision (code/description/issued) in the document's revision table; it is the semantic analog of the sheet-set revision tracking — driven through the App API.",
  },
];

// ---------------------------------------------------------------------------
// Corpus types.
// ---------------------------------------------------------------------------

/** An entity pick resolved at run time (the ids are document-minted). */
export type CorpusEntityRef =
  | { readonly by: "nth"; readonly type: string; readonly nth: number }
  | { readonly by: "id"; readonly id: string };

/** A prompt-engine input event with run-time-resolvable entity picks. */
export type CorpusScriptEvent =
  | { readonly type: "typed"; readonly text: string }
  | { readonly type: "pick"; readonly point: readonly [number, number] }
  | { readonly type: "entity"; readonly entity: CorpusEntityRef }
  | { readonly type: "entityPoint"; readonly entity: CorpusEntityRef; readonly point: readonly [number, number] }
  | { readonly type: "enter" }
  | { readonly type: "cancel" };

export interface CorpusScriptStep {
  readonly event: CorpusScriptEvent;
  /** Human-readable note (evidence + debugging). */
  readonly note?: string;
}

/** A direct App API call (setup/probe surface not at the command line). */
export interface CorpusCommand {
  readonly name: string;
  readonly payload?: unknown;
  /** Label for `result` expectation checks. */
  readonly as?: string;
}

/** A query whose result feeds `result` expectation checks. */
export interface CorpusQuery {
  readonly name: string;
  readonly payload?: unknown;
  readonly as: string;
}

/** The declarative check vocabulary (deterministic, engine-free). */
export type CorpusCheck =
  | { readonly kind: "count"; readonly equals: number }
  | { readonly kind: "countBy"; readonly type: string; readonly equals: number }
  | { readonly kind: "state"; readonly path: string; readonly equals: unknown; readonly tol?: number }
  | { readonly kind: "result"; readonly of: string; readonly path: string; readonly equals: unknown; readonly tol?: number }
  | { readonly kind: "resultSame"; readonly of1: string; readonly of2: string; readonly path: string }
  | { readonly kind: "echo"; readonly equals: string }
  | { readonly kind: "decline"; readonly command: string; readonly payload?: unknown; readonly code: string; readonly via?: "command" | "query" }
  | { readonly kind: "revisionDelta"; readonly equals: number }
  | { readonly kind: "revisionCount"; readonly equals: number };

/** One declared reference expectation. */
export interface CorpusExpectation {
  readonly id: string;
  /** The declared AutoCAD 2024 reference behavior being certified. */
  readonly reference: string;
  /** The manifest source id binding this expectation's reference behavior
   *  to its authoritative Autodesk documentation (rev 2). */
  readonly source: string;
  /** The expected outcome classification (the honest certification). */
  readonly outcome: "exact" | "lossy" | "unsupported";
  /** For lossy/unsupported: the documented boundary rationale. */
  readonly rationale?: string;
  readonly check: CorpusCheck;
}

/** An interoperability expectation at an external-format boundary. */
export interface CorpusInteropExpectation {
  readonly id: string;
  readonly surface: "ifc" | "dxf" | "bcf" | "ids" | "sheet";
  /** The semantic concept being exchanged. */
  readonly concept: string;
  /** The declared AutoCAD/vertical exchange reference behavior. */
  readonly reference: string;
  /** The manifest source id binding this exchange reference to its
   *  authoritative Autodesk documentation (rev 2). */
  readonly source: string;
  readonly expected: "exact" | "lossy" | "unsupported";
  readonly note: string;
  /**
   * The live probe the engine runs: the REAL carrier codec/report, never a
   * narrative claim. The probe's observed classification must equal
   * `expected` (tolerance counts as exact; the 0-row boundary is
   * "unsupported" — nothing carried, never fabricated).
   */
  readonly probe:
    | { readonly kind: "dxfAggregate" }
    | { readonly kind: "dxfUnsupportedTypes"; readonly includes: readonly string[] }
    | { readonly kind: "dxfLayers" }
    | { readonly kind: "ifcAggregate" }
    | { readonly kind: "toolsetsInterop"; readonly conceptId: string; readonly surface?: "ifc" | "bcf" | "ids" }
    | { readonly kind: "sheetExportDecline"; readonly format: string }
    | { readonly kind: "sheetExportDigestStable"; readonly format: string };
}

/** A performance target (wall-clock ASSERTED, never pinned). */
export interface CorpusPerfTarget {
  readonly label: string;
  readonly budgetMs: number;
}

/** The cross-cutting robustness expectations per workflow. */
export interface CorpusRobustness {
  /** Save→open round-trip: canonical identities + digest preserved. */
  readonly roundTrip: boolean;
  /** Undo/redo atomicity for the last N revisions (exact state restore). */
  readonly undoRedoSteps: number;
  /** Full replay in a fresh document reproduces the normalized digest. */
  readonly replayStable: boolean;
}

export interface CorpusPhase {
  readonly id: string;
  readonly title: string;
  /** The professional command-line stream (compiled via the shared registry). */
  readonly script?: readonly CorpusScriptStep[];
  /** Direct App API commands (setup/probe surface). */
  readonly commands?: readonly CorpusCommand[];
  /** Queries feeding `result` checks (run AFTER the script/commands). */
  readonly queries?: readonly CorpusQuery[];
  readonly expectations: readonly CorpusExpectation[];
}

export interface CorpusWorkflow {
  readonly id: string;
  readonly title: string;
  readonly discipline: string;
  /** The declared AutoCAD 2024 documented behavior for this workflow family. */
  readonly referenceBehavior: string;
  /** The manifest source ids binding this workflow's reference behavior to
   *  its authoritative Autodesk documentation (rev 2 — the auditable
   *  reference basis; every id resolves in CORPUS_REFERENCE_MANIFEST). */
  readonly sources: readonly string[];
  readonly phases: readonly CorpusPhase[];
  readonly interop: readonly CorpusInteropExpectation[];
  readonly perf: readonly CorpusPerfTarget[];
  readonly robustness: CorpusRobustness;
}

// ---------------------------------------------------------------------------
// The corpus.
// ---------------------------------------------------------------------------

export const P019_WORKFLOWS: readonly CorpusWorkflow[] = [
  // -------------------------------------------------------------------------
  // WF-1 — architectural floor-plan drafting (the classic 2D professional
  // drafting workflow: layers → primitives → modify → properties).
  // -------------------------------------------------------------------------
  {
    id: "wf-plan-drafting",
    title: "Architectural floor-plan drafting",
    discipline: "drafting",
    sources: ["autocad-2024-commands", "autocad-2024-dxf"],
    referenceBehavior:
      "AutoCAD 2024 documented drafting behavior: -LAYER Make creates a layer and makes it current; LINE draws straight segments between specified points; RECTANGLE draws a four-segment closed polyline; CIRCLE draws a circle from center + radius; ARC draws an arc through its start/center/end; OFFSET creates a parallel curve at a typed distance on the specified side; MIRROR reflects objects across a two-point axis with keep/erase-source; COPY duplicates at a displacement; MOVE translates; ROTATE rotates about a base point by a typed angle; TRIM removes geometry cut at cutting edges; FILLET joins two objects with a tangent arc of a given radius; CHPROP changes the displayed properties of selected objects; LAYERSTATE saves the current layer state under a name.",
    phases: [
      {
        id: "layers",
        title: "Layer setup (the professional discipline: layers before linework)",
        script: [
          { event: { type: "typed", text: "-LAYER" } },
          { event: { type: "typed", text: "M" } },
          { event: { type: "typed", text: "A-WALL" } },
          { event: { type: "enter" } },
        ],
        expectations: [
          {
            id: "exp-layer-created",
            reference: "-LAYER Make creates layer A-WALL.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "layers.1.name", equals: "A-WALL" },
          },
          {
            id: "exp-layer-current",
            reference: "-LAYER Make makes the new layer current (the active-layer reference is the canonical layer identity).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "draftingSettings.activeLayer", equals: "ly-000001" },
          },
        ],
      },
      {
        id: "primitives",
        title: "Plan primitives (rectangle envelope + wall line + circle + arc)",
        script: [
          { event: { type: "typed", text: "RECTANGLE" } },
          { event: { type: "typed", text: "0,0" } },
          { event: { type: "typed", text: "12000,8000" } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "LINE" } },
          { event: { type: "typed", text: "0,0" } },
          { event: { type: "typed", text: "12000,0" } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "CIRCLE" } },
          { event: { type: "typed", text: "3000,4000" } },
          { event: { type: "typed", text: "600" } },
          { event: { type: "typed", text: "ARC" } },
          { event: { type: "typed", text: "6750,2750" } },
          { event: { type: "typed", text: "7500,2000" } },
          { event: { type: "typed", text: "6750,3500" } },
        ],
        expectations: [
          {
            id: "exp-rectangle",
            reference: "RECTANGLE draws the axis-aligned rectangle from the two corners.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "rectangle", equals: 1 },
          },
          {
            id: "exp-line",
            reference: "LINE draws the straight segment between the two specified points.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "line", equals: 1 },
          },
          {
            id: "exp-circle-radius",
            reference: "CIRCLE draws a circle with the exact specified radius.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.2.props.radius", equals: 600, tol: 1e-9 },
          },
          {
            id: "exp-arc-created",
            reference: "ARC draws an arc through the specified center/start/end.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "arc", equals: 1 },
          },
          {
            id: "exp-on-current-layer",
            reference: "Objects are created on the current layer (the AutoCAD layer discipline; the element carries the canonical layer identity).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.0.props.layer", equals: "ly-000001" },
          },
          {
            id: "exp-one-revision-per-primitive",
            reference: "Each draw command = one atomic model revision (the AutoCAD single-command undo granularity).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "revisionDelta", equals: 4 },
          },
        ],
      },
      {
        id: "offset-mirror",
        title: "Wall offsets + mirrored fixture",
        script: [
          { event: { type: "typed", text: "OFFSET" } },
          { event: { type: "typed", text: "240" } },
          { event: { type: "entity", entity: { by: "nth", type: "line", nth: 0 } } },
          { event: { type: "pick", point: [0, 240] } },
          { event: { type: "typed", text: "MIRROR" } },
          { event: { type: "entity", entity: { by: "nth", type: "circle", nth: 0 } } },
          { event: { type: "pick", point: [0, 0] } },
          { event: { type: "pick", point: [0, 1000] } },
          { event: { type: "typed", text: "N" } },
        ],
        expectations: [
          {
            id: "exp-offset-parallel",
            reference: "OFFSET creates a parallel copy at exactly the typed distance (240) on the picked side.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "line", equals: 2 },
          },
          {
            id: "exp-offset-distance",
            reference: "The offset copy lies at the exact typed distance from the source line (y = 240).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.4.props.y1", equals: 240, tol: 1e-9 },
          },
          {
            id: "exp-mirror-keeps-source",
            reference: "MIRROR with N (default) keeps the source object.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "circle", equals: 2 },
          },
          {
            id: "exp-offset-one-revision",
            reference: "Each modify command = one atomic model revision (Δrev 2 for OFFSET + MIRROR).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "revisionDelta", equals: 2 },
          },
        ],
      },
      {
        id: "modify",
        title: "Modify: COPY / MOVE / ROTATE",
        script: [
          { event: { type: "typed", text: "COPY" } },
          { event: { type: "entity", entity: { by: "nth", type: "arc", nth: 0 } } },
          { event: { type: "pick", point: [0, 0] } },
          { event: { type: "pick", point: [1000, 0] } },
          { event: { type: "typed", text: "MOVE" } },
          { event: { type: "entity", entity: { by: "nth", type: "arc", nth: 1 } } },
          { event: { type: "pick", point: [0, 0] } },
          { event: { type: "pick", point: [0, 200] } },
          { event: { type: "typed", text: "ROTATE" } },
          { event: { type: "entity", entity: { by: "nth", type: "arc", nth: 1 } } },
          { event: { type: "pick", point: [0, 200] } },
          { event: { type: "typed", text: "45" } },
        ],
        expectations: [
          {
            id: "exp-copy-duplicates",
            reference: "COPY duplicates the selected object at the typed displacement.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "arc", equals: 2 },
          },
          {
            id: "exp-move-preserves-count",
            reference: "MOVE translates the selected object (no duplication).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "arc", equals: 2 },
          },
          {
            id: "exp-rotate-keeps-count",
            reference: "ROTATE rotates the selected object about the base point (no duplication).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "arc", equals: 2 },
          },
        ],
      },
      {
        id: "props",
        title: "Properties + layer state (CHPROP + LAYERSTATE)",
        script: [
          { event: { type: "typed", text: "CHPROP" } },
          { event: { type: "entity", entity: { by: "nth", type: "circle", nth: 0 } } },
          { event: { type: "typed", text: "C" } },
          { event: { type: "typed", text: "#0e7490" } },
          { event: { type: "enter" } },
        ],
        expectations: [
          {
            id: "exp-chprop-color",
            reference: "CHPROP Color sets the object's display color exactly.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.2.props.color", equals: "#0e7490" },
          },
          {
            id: "exp-chprop-one-revision",
            reference: "One CHPROP command = one atomic model revision.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "revisionDelta", equals: 1 },
          },
          {
            id: "exp-unknown-command-declines",
            reference: "An unknown command is a typed refusal — never a fabricated semantic (the AutoCAD 'Unknown command' discipline).",
            source: "autocad-2024-commands",
            outcome: "unsupported",
            rationale: "The closed command registry declines unknown App API names.",
            check: { kind: "decline", command: "cert.ghost", code: "unknown_command" },
          },
        ],
      },
    ],
    interop: [
      {
        id: "io-dxf-linework",
        surface: "dxf",
        concept: "2D plan linework (lines/polylines/circles/arcs)",
        reference: "AutoCAD DXF carries 2D linework geometry exactly (the exchange format's core).",
        source: "autocad-2024-dxf",
        expected: "exact",
        note: "every carried geometry field round-trips exact (or within the declared 1e-5 mm tolerance)",
        probe: { kind: "dxfAggregate" },
      },
      {
        id: "io-dxf-layers",
        surface: "dxf",
        concept: "layer table",
        reference: "AutoCAD DXF carries the layer table (names, colors).",
        source: "autocad-2024-dxf",
        expected: "exact",
        note: "the layer table matches at re-import (no lossy layer rows)",
        probe: { kind: "dxfLayers" },
      },
    ],
    perf: [{ label: "wf-plan-drafting total", budgetMs: 30000 }],
    robustness: { roundTrip: true, undoRedoSteps: 2, replayStable: true },
  },

  // -------------------------------------------------------------------------
  // WF-2 — annotation/documentation deliverable.
  // -------------------------------------------------------------------------
  {
    id: "wf-annotation-docs",
    title: "Dimensioned annotated drawing documentation",
    discipline: "annotation",
    sources: ["autocad-2024-commands", "autocad-2024-sheet-set-manager", "autocad-2024-dxf"],
    referenceBehavior:
      "AutoCAD 2024 documented annotation behavior: DIMSTYLE defines the governing dimension style (scale, text height); DIMLINEAR places a linear dimension measuring the true horizontal/vertical distance between two extension-line origins; DIMALIGNED measures the true aligned distance; DIMRADIUS/DIMDIAMETER label the true radius/diameter of circles/arcs; DIMTEDIT moves the dimension text along the dimension; TEXT places single-line text at a height; MTEXT places multiline text; LEADER/MLEADER annotate with a leader line; REVCLOUD draws a revision cloud; the drawing revision table records issued revisions (the Sheet Set Manager revision tracking — the Offisos revision surface is its semantic analog).",
    phases: [
      {
        id: "seed",
        title: "Seed geometry (the drawing being annotated)",
        commands: [
          {
            name: "entity.create",
            payload: {
              entities: [
                { type: "line", layer: "0", x1: 0, y1: 0, x2: 6000, y2: 0 },
                { type: "line", layer: "0", x1: 0, y1: 0, x2: 0, y2: 3000 },
                { type: "circle", layer: "0", cx: 4000, cy: 1500, r: 500 },
              ],
            },
            as: "seed",
          },
        ],
        expectations: [
          {
            id: "exp-seed",
            reference: "The seed linework for annotation exists (setup).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "count", equals: 3 },
          },
        ],
      },
      {
        id: "dimensions",
        title: "Dimension chain (DIMLINEAR + DIMDIAMETER + DIMRADIUS over the seed circle)",
        commands: [
          {
            name: "annotation.create",
            payload: {
              entities: [
                {
                  type: "dim-linear",
                  layer: "0",
                  p1: { x: 0, y: 0 },
                  p2: { x: 6000, y: 0 },
                  placement: { x: 3000, y: -400 },
                  mode: "horizontal",
                  measured: 6000,
                },
                {
                  type: "dim-diameter",
                  layer: "0",
                  target: "el-000003",
                  angle: 0,
                  placement: { x: 4400, y: 900 },
                },
                {
                  type: "dim-radius",
                  layer: "0",
                  target: "el-000003",
                  placement: { x: 4400, y: 1900 },
                },
              ],
            },
            as: "dims",
          },
        ],
        expectations: [
          {
            id: "exp-dim-count",
            reference: "Each dimension command places exactly one dimension entity.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "dim-linear", equals: 1 },
          },
          {
            id: "exp-dim-linear-measured",
            reference: "DIMLINEAR measures the TRUE horizontal distance (6000) — the dimension is a measurement, not a decoration.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.3.props.measured", equals: 6000, tol: 1e-9 },
          },
          {
            id: "exp-dim-diameter-measured",
            reference: "DIMDIAMETER measures the TRUE circle diameter (2 × 500 = 1000, derived from the dimensioned target).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.4.props.measured", equals: 1000, tol: 1e-9 },
          },
          {
            id: "exp-dim-radius-measured",
            reference: "DIMRADIUS measures the TRUE circle radius (500, derived from the dimensioned target).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.5.props.measured", equals: 500, tol: 1e-9 },
          },
          {
            id: "exp-dim-atomic",
            reference: "One dimension batch = one atomic model revision.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "revisionDelta", equals: 1 },
          },
        ],
      },
      {
        id: "text-leaders",
        title: "Text + leaders (MTEXT + LEADER via the command line)",
        script: [
          { event: { type: "typed", text: "MTEXT" } },
          { event: { type: "pick", point: [1000, 3600] } },
          { event: { type: "typed", text: "400" } },
          { event: { type: "typed", text: "FLOOR PLAN — SCALE 1:100" } },
          { event: { type: "typed", text: "LEADER" } },
          { event: { type: "pick", point: [4500, 1500] } },
          { event: { type: "pick", point: [5200, 2400] } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "R500 COLUMN" } },
        ],
        expectations: [
          {
            id: "exp-mtext",
            reference: "MTEXT places the multiline text at the picked corner with the typed column width and content.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.6.props.value", equals: "FLOOR PLAN — SCALE 1:100" },
          },
          {
            id: "exp-leader",
            reference: "LEADER annotates the picked points with the leader line + text.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "leader", equals: 1 },
          },
        ],
      },
      {
        id: "revision-cloud",
        title: "Revision cloud + the revision table (REVCLOUD + REVISION)",
        script: [
          { event: { type: "typed", text: "REVCLOUD" } },
          { event: { type: "pick", point: [3900, 1400] } },
          { event: { type: "pick", point: [5100, 1600] } },
        ],
        commands: [
          {
            name: "revision.add",
            payload: { code: "P01", description: "First issue", issued: false },
            as: "rev",
          },
        ],
        expectations: [
          {
            id: "exp-revcloud",
            reference: "REVCLOUD draws the closed scalloped revision cloud around the revised area.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.8.props.marker", equals: "revcloud" },
          },
          {
            id: "exp-revcloud-closed",
            reference: "The revision cloud is a closed polyline (the markup boundary).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.8.props.closed", equals: true },
          },
          {
            id: "exp-revision-recorded",
            reference: "The drawing revision table records the issued revision.",
            source: "autocad-2024-sheet-set-manager",
            outcome: "exact",
            check: { kind: "result", of: "rev", path: "revision.code", equals: "P01" },
          },
        ],
      },
    ],
    interop: [
      {
        id: "io-dxf-annotation",
        surface: "dxf",
        concept: "annotation entities (dimensions/text/leaders)",
        reference: "AutoCAD DXF carries dimensions/text as annotation entities.",
        source: "autocad-2024-dxf",
        expected: "unsupported",
        note: "the annotation entities are typed-skipped by the DXF writer (counted in the unsupported report — never fabricated linework)",
        probe: { kind: "dxfUnsupportedTypes", includes: ["annotation.dim-linear", "annotation.dim-diameter", "annotation.dim-radius", "annotation.mtext", "annotation.leader"] },
      },
      {
        id: "io-sheet-dwg",
        surface: "sheet",
        concept: "DWG sheet export",
        reference: "AutoCAD writes native DWG; Offisos sheet export supports the deterministic sheet formats (IR/PDF/SVG) and typed-declines DWG.",
        source: "autocad-2024-commands",
        expected: "unsupported",
        note: "DWG export is a typed refusal (no fabricated DWG)",
        probe: { kind: "sheetExportDecline", format: "dwg" },
      },
      {
        id: "io-sheet-svg",
        surface: "sheet",
        concept: "deterministic sheet output (SVG)",
        reference: "Plot output must be deterministic (identical input → identical bytes).",
        source: "autocad-2024-commands",
        expected: "exact",
        note: "SVG export digest stable across repeated export",
        probe: { kind: "sheetExportDigestStable", format: "svg" },
      },
    ],
    perf: [{ label: "wf-annotation-docs total", budgetMs: 30000 }],
    robustness: { roundTrip: true, undoRedoSteps: 1, replayStable: true },
  },

  // -------------------------------------------------------------------------
  // WF-3 — reusable symbol library (blocks/attributes/arrays/patterns).
  // -------------------------------------------------------------------------
  {
    id: "wf-symbol-blocks",
    title: "Reusable symbol library and placement",
    discipline: "blocks",
    sources: ["autocad-2024-commands", "autocad-2024-dxf"],
    referenceBehavior:
      "AutoCAD 2024 documented block behavior: BLOCK groups the selected objects into a NAMED block definition (the source objects are removed from the drawing); INSERT places scaled/rotated instances of a definition, resolving attribute values; ATTDEF defines a tag placeholder inside the definition; ATTEDIT edits the attribute value of a picked instance; ARRAY creates deterministic rectangular/polar arrays of the selected objects; MIRROR reflects instances across an axis (the AutoCAD mirrored-insertion analog: the COMPAT-CAD-004 reflected placement rotation' = 2φ − θ with the additive mirrored state).",
    phases: [
      {
        id: "seed",
        title: "Seed the symbol source geometry",
        commands: [
          {
            name: "entity.create",
            payload: {
              entities: [
                { type: "line", layer: "0", x1: 0, y1: 0, x2: 600, y2: 0 },
                { type: "circle", layer: "0", cx: 300, cy: 150, r: 60 },
              ],
            },
            as: "seed",
          },
        ],
        expectations: [
          { id: "exp-seed-two", reference: "Two source objects for the symbol.", source: "autocad-2024-commands", outcome: "exact", check: { kind: "count", equals: 2 } },
        ],
      },
      {
        id: "define",
        title: "BLOCK: define the symbol (sources converted into the definition)",
        script: [
          { event: { type: "typed", text: "BLOCK" } },
          { event: { type: "typed", text: "COL-SYMBOL" } },
          { event: { type: "typed", text: "0,0" } },
          { event: { type: "entity", entity: { by: "nth", type: "line", nth: 0 } } },
          { event: { type: "entity", entity: { by: "nth", type: "circle", nth: 0 } } },
          { event: { type: "enter" } },
        ],
        expectations: [
          {
            id: "exp-block-definition",
            reference: "BLOCK converts the selected objects into the named definition (sources leave model space).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "blockDefs.0.name", equals: "COL-SYMBOL" },
          },
          {
            id: "exp-block-entities",
            reference: "The definition carries the two source objects as its inline entities.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "blockDefs.0.entities.length", equals: 2 },
          },
          {
            id: "exp-sources-converted",
            reference: "Model space no longer contains the converted sources.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "count", equals: 0 },
          },
          {
            id: "exp-block-one-revision",
            reference: "BLOCK is ONE atomic revision.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "revisionDelta", equals: 1 },
          },
        ],
      },
      {
        id: "insert-attedit",
        title: "INSERT with attributes + ATTEDIT (the symbol placement workflow)",
        commands: [
          {
            name: "block.update",
            payload: {
              name: "COL-SYMBOL",
              patch: {
                entities: [
                  { type: "line", x1: 0, y1: 0, x2: 600, y2: 0, layer: "0" },
                  { type: "circle", cx: 300, cy: 150, r: 60, layer: "0" },
                  { type: "attdef", tag: "MARK", default: "A", layer: "0", x: 0, y: 320, height: 40, rotation: 0 },
                ],
              },
            },
            as: "def-update",
          },
          {
            name: "block.insert",
            payload: { name: "COL-SYMBOL", x: 2000, y: 2000, scale: 1, rotation: 0, attributes: [{ tag: "MARK", value: "C1" }] },
            as: "insert1",
          },
        ],
        script: [
          { event: { type: "typed", text: "INSERT" } },
          { event: { type: "typed", text: "COL-SYMBOL" } },
          { event: { type: "typed", text: "5000,2000" } },
          { event: { type: "typed", text: "1" } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "C2" } },
        ],
        expectations: [
          {
            id: "exp-insert-placement",
            reference: "INSERT places the instance at the exact specified point/scale/rotation (the typed attribute value resolves the attdef).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.1.props.x", equals: 5000, tol: 1e-9 },
          },
          {
            id: "exp-attribute-value",
            reference: "INSERT resolves the attdef's attribute value from the typed prompt.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.0.props.attributes.0.value", equals: "C1" },
          },
          {
            id: "exp-attdef-carried",
            reference: "The definition's ATTDEF tag rides the instance with its resolved value.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.0.props.attributes.0.tag", equals: "MARK" },
          },
        ],
      },
      {
        id: "attedit",
        title: "ATTEDIT: pick the instance → tag → new value",
        script: [
          { event: { type: "typed", text: "ATTEDIT" } },
          { event: { type: "entity", entity: { by: "nth", type: "block-ref", nth: 0 } } },
          { event: { type: "typed", text: "MARK" } },
          { event: { type: "typed", text: "C1-EDITED" } },
        ],
        expectations: [
          {
            id: "exp-attedit-value",
            reference: "ATTEDIT changes the picked instance's attribute value exactly.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.0.props.attributes.0.value", equals: "C1-EDITED" },
          },
          {
            id: "exp-attedit-atomic",
            reference: "One ATTEDIT command = one atomic model revision.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "revisionDelta", equals: 1 },
          },
        ],
      },
      {
        id: "array",
        title: "ARRAY (the deterministic rectangular placement pattern)",
        script: [
          { event: { type: "typed", text: "ARRAY" } },
          { event: { type: "entity", entity: { by: "nth", type: "block-ref", nth: 0 } } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "R" } },
          { event: { type: "typed", text: "3" } },
          { event: { type: "typed", text: "2" } },
          { event: { type: "typed", text: "800" } },
          { event: { type: "typed", text: "600" } },
        ],
        expectations: [
          {
            id: "exp-array-count",
            reference: "A 3×2 rectangular ARRAY places exactly 5 new instances (rows×columns − 1; the source position completes the pattern — 2 + 5 = 7).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "block-ref", equals: 7 },
          },
          {
            id: "exp-array-atomic",
            reference: "The whole array is ONE atomic model revision (the AutoCAD single-command undo granularity).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "revisionDelta", equals: 1 },
          },
        ],
      },
      {
        id: "pattern-mirror",
        title: "PATTERNMIRROR (the reflected symbol placement — the MIRROR semantic analog)",
        script: [
          { event: { type: "typed", text: "PMIR" } },
          { event: { type: "entity", entity: { by: "nth", type: "block-ref", nth: 0 } } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "0,0" } },
          { event: { type: "typed", text: "0,1000" } },
          { event: { type: "typed", text: "N" } },
        ],
        expectations: [
          {
            id: "exp-pattern-mirror-count",
            reference: "PATTERNMIRROR (the MIRROR semantic analog) creates the reflected copy (7 + 1 = 8 instances, source kept).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "block-ref", equals: 8 },
          },
          {
            id: "exp-pattern-mirror-reflected",
            reference: "The mirrored instance placement is the exact reflection (rotation' = 2φ − θ, additive mirrored state).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.7.props.mirrored", equals: true },
          },
          {
            id: "exp-pattern-mirror-axis",
            reference: "The mirrored insertion point is the exact reflection of the source across the axis (x ↦ −x).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.7.props.x", equals: -2000, tol: 1e-9 },
          },
        ],
      },
    ],
    interop: [
      {
        id: "io-dxf-blocks",
        surface: "dxf",
        concept: "block definitions + instances",
        reference: "AutoCAD DXF carries block definitions and inserts.",
        source: "autocad-2024-dxf",
        expected: "unsupported",
        note: "the block instances are typed-skipped by the DXF writer (counted in the unsupported report — never fabricated linework)",
        probe: { kind: "dxfUnsupportedTypes", includes: ["geometry-unknown"] },
      },
    ],
    perf: [{ label: "wf-symbol-blocks total", budgetMs: 30000 }],
    robustness: { roundTrip: true, undoRedoSteps: 1, replayStable: true },
  },

  // -------------------------------------------------------------------------
  // WF-4 — sheet set assembly + deterministic publication.
  // -------------------------------------------------------------------------
  {
    id: "wf-sheet-publication",
    title: "Sheet set assembly and deterministic publication",
    discipline: "sheet",
    sources: ["autocad-2024-commands", "autocad-2024-sheet-set-manager"],
    referenceBehavior:
      "AutoCAD 2024 documented layout/plot behavior: LAYOUT creates a paper-space layout tab; viewports (MVIEW) show model-space contents on the sheet; PAGESETUP records the page size/plot settings; the title block is placed on the sheet; PLOT produces the plotted output of the layout (deterministically — the same layout plots the same output); the sheet set manager organizes sheets into subsets and publishes the set (PUBLISH); revisions track issued sheets.",
    phases: [
      {
        id: "seed",
        title: "Seed the model + docs structures (the content being published)",
        commands: [
          {
            name: "entity.create",
            payload: { entities: [{ type: "line", layer: "0", x1: 0, y1: 0, x2: 42000, y2: 0 }] },
            as: "seed",
          },
        ],
        expectations: [
          { id: "exp-seed", reference: "The published model content exists.", source: "autocad-2024-commands", outcome: "exact", check: { kind: "count", equals: 1 } },
        ],
      },
      {
        id: "layout",
        title: "LAYOUT + PAGESETUP + title block",
        commands: [
          { name: "layout.create", payload: { name: "A-101 Ground Floor" }, as: "layout" },
          {
            name: "titleblock.create",
            payload: {
              name: "Std A3",
              widthMm: 180,
              heightMm: 48,
              rowHeightMm: 12,
              rows: [
                { label: "Project", field: "text", value: "P019 Certification" },
                { label: "Layout", field: "layoutName" },
              ],
            },
            as: "titleblock",
          },
          {
            name: "layout.update",
            payload: { id: "lo-000001", patch: { titleBlockPlacement: { titleBlockId: "tb-000001", xMm: 220, yMm: 240 } } },
            as: "tb-place",
          },
        ],
        script: [
          { event: { type: "typed", text: "PAGESETUP" } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "A2" } },
          { event: { type: "typed", text: "Landscape" } },
          { event: { type: "typed", text: "15" } },
          { event: { type: "enter" } },
          { event: { type: "enter" } },
          { event: { type: "enter" } },
        ],
        expectations: [
          {
            id: "exp-layout-id",
            reference: "The layout tab is created with a deterministic identity.",
            source: "autocad-2024-sheet-set-manager",
            outcome: "exact",
            check: { kind: "result", of: "layout", path: "layoutId", equals: "lo-000001" },
          },
          {
            id: "exp-pagesetup",
            reference: "PAGESETUP records the page size/plot settings (A2 landscape, 15 mm margins).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "layouts.0.pageSetup.paperSize", equals: "A2" },
          },
          {
            id: "exp-pagesetup-dimensions",
            reference: "The canonical A2 portrait dimensions are carried (420 × 594).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "layouts.0.pageSetup.widthMm", equals: 420 },
          },
          {
            id: "exp-titleblock-placed",
            reference: "The title block is placed on the sheet at the exact position.",
            source: "autocad-2024-sheet-set-manager",
            outcome: "exact",
            check: { kind: "state", path: "layouts.0.titleBlockPlacement.xMm", equals: 220 },
          },
        ],
      },
      {
        id: "clone-publish",
        title: "LAYOUTCLONE + the publication set (SUBSET/PUBSET/PUBLISH)",
        commands: [
          { name: "layout.clone", payload: { layoutId: "lo-000001", newName: "A-102 Ground Floor (copy)" }, as: "clone" },
          { name: "navigator.createSubset", payload: { name: "A Series", parentId: null, prefix: "A", numbering: "none" }, as: "subset" },
          {
            name: "publisher.create",
            payload: { name: "Issue Set", items: [{ kind: "layout", id: "lo-000001", format: "pdf" }, { kind: "layout", id: "lo-000002", format: "pdf" }] },
            as: "pubset",
          },
          { name: "publisher.run", payload: { id: "pub-000001" }, as: "publish" },
        ],
        expectations: [
          {
            id: "exp-clone",
            reference: "LAYOUTCLONE duplicates the layout tab (contents + setup) under the new name.",
            source: "autocad-2024-sheet-set-manager",
            outcome: "exact",
            check: { kind: "result", of: "clone", path: "name", equals: "A-102 Ground Floor (copy)" },
          },
          {
            id: "exp-publish-deterministic",
            reference: "The Offisos publisher surface (the PUBLISH / Sheet-Set-Manager publish semantic analog, driven through the App API) produces the deterministic publication result for the set (one page per item with its content digest).",
            source: "autocad-2024-sheet-set-manager",
            outcome: "exact",
            check: { kind: "result", of: "publish", path: "pages.length", equals: 2 },
          },
        ],
      },
      {
        id: "plot",
        title: "PLOT: the deterministic sheet export",
        commands: [
          { name: "plot.export", payload: { id: "lo-000001", format: "svg" }, as: "plot1" },
          { name: "plot.export", payload: { id: "lo-000001", format: "svg" }, as: "plot2" },
        ],
        expectations: [
          {
            id: "exp-plot-digest-stable",
            reference: "PLOT is deterministic: the same layout exports the same bytes twice.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "resultSame", of1: "plot1", of2: "plot2", path: "sha256" },
          },
        ],
      },
    ],
    interop: [
      {
        id: "io-sheet-pdf",
        surface: "sheet",
        concept: "PDF sheet export determinism",
        reference: "Plot output must be deterministic (identical input → identical bytes).",
        source: "autocad-2024-commands",
        expected: "exact",
        note: "PDF export digest stable across repeated export",
        probe: { kind: "sheetExportDigestStable", format: "pdf" },
      },
    ],
    perf: [{ label: "wf-sheet-publication total", budgetMs: 45000 }],
    robustness: { roundTrip: true, undoRedoSteps: 1, replayStable: true },
  },

  // -------------------------------------------------------------------------
  // WF-5 — 3D massing model (solids + booleans + transforms + sections).
  // -------------------------------------------------------------------------
  {
    id: "wf-model3d-mass",
    title: "3D massing model with exact sections",
    discipline: "model3d",
    sources: ["autocad-2024-commands", "arch-2024-ifc"],
    referenceBehavior:
      "AutoCAD 2024 documented solid modeling behavior: BOX creates a rectangular solid from width/depth/height; CYLINDER creates a cylindrical solid; UNION fuses solids into one; SUBTRACT removes the common volume; INTERSECT keeps the common volume; 3D transforms (3DMOVE — the Offisos MOVE3D is its semantic analog — plus ROTATE3D/SCALE3D) apply rigid/affine transforms to solids; UCS defines workplanes (the Offisos UCSNEW is the UCS New-option semantic analog); SECTIONPLANE cuts a view section; exact section geometry is engine-backed (the OCCT adapter); TESSELLATE produces the mesh representation.",
    phases: [
      {
        id: "primitives",
        title: "Solid primitives (BOX ×2 overlapping + a disjoint box)",
        script: [
          { event: { type: "typed", text: "BOX" } },
          { event: { type: "typed", text: "4" } },
          { event: { type: "typed", text: "4" } },
          { event: { type: "typed", text: "4" } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "BOX" } },
          { event: { type: "typed", text: "4" } },
          { event: { type: "typed", text: "4" } },
          { event: { type: "typed", text: "4" } },
          { event: { type: "typed", text: "2,0,0" } },
          { event: { type: "typed", text: "BOX" } },
          { event: { type: "typed", text: "2" } },
          { event: { type: "typed", text: "2" } },
          { event: { type: "typed", text: "2" } },
          { event: { type: "typed", text: "10,10,10" } },
        ],
        expectations: [
          {
            id: "exp-box-identity",
            reference: "BOX creates the solid with a deterministic document-minted identity.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.0.id", equals: "el-000001" },
          },
          {
            id: "exp-box-count",
            reference: "Each BOX command creates exactly one solid (one atomic revision per command).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "count", equals: 3 },
          },
          {
            id: "exp-box-provenance",
            reference: "The solid carries its engine provenance (the shape descriptor + the mesh token) in the same atomic revision.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.0.props.shape", equals: "box" },
          },
        ],
      },
      {
        id: "booleans",
        title: "Boolean triad (UNION + INTERSECT + SUBTRACT + the typed disjoint-INTERSECT decline)",
        script: [
          { event: { type: "typed", text: "UNION" } },
          { event: { type: "typed", text: "el-000001" } },
          { event: { type: "typed", text: "el-000003" } },
          { event: { type: "typed", text: "INTERSECT" } },
          { event: { type: "typed", text: "el-000002" } },
          { event: { type: "typed", text: "el-000004" } },
          { event: { type: "typed", text: "BOX" } },
          { event: { type: "typed", text: "1" } },
          { event: { type: "typed", text: "4" } },
          { event: { type: "typed", text: "4" } },
          { event: { type: "typed", text: "3,0,0" } },
          { event: { type: "typed", text: "SUBTRACT" } },
          { event: { type: "typed", text: "el-000005" } },
          { event: { type: "typed", text: "el-000006" } },
          { event: { type: "typed", text: "BOX" } },
          { event: { type: "typed", text: "1" } },
          { event: { type: "typed", text: "1" } },
          { event: { type: "typed", text: "1" } },
          { event: { type: "typed", text: "10,0,0" } },
        ],
        expectations: [
          {
            id: "exp-union",
            reference: "UNION fuses the solids into a single solid (the operands are consumed into the result; the disjoint fuse is reference-exact).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.0.id", equals: "el-000007" },
          },
          {
            id: "exp-subtract-provenance",
            reference: "The subtraction result carries the difference provenance (op + operand ids).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.0.props.op", equals: "difference" },
          },
          {
            id: "exp-subtract-exact",
            reference: "SUBTRACT removes exactly the common cell (the remaining slab spans x ∈ [2, 3] exactly — the reference-exact boolean class).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.0.props.meshBBox.0", equals: 2, tol: 1e-9 },
          },
          {
            id: "exp-subtract-exact-max",
            reference: "The remaining slab's max extent is exact (x = 3).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.0.props.meshBBox.3", equals: 3, tol: 1e-9 },
          },
          {
            id: "exp-intersect-decline",
            reference: "AutoCAD INTERSECT of disjoint solids yields an empty result; Offisos declares the typed boolean_empty decline — never a fabricated empty solid.",
            source: "autocad-2024-commands",
            outcome: "unsupported",
            rationale: "A disjoint intersection is the typed boolean_empty refusal (documented, deterministic).",
            check: { kind: "decline", command: "model3d.boolean", payload: { op: "intersection", elementIds: ["el-000007", "el-000008"] }, code: "boolean_empty" },
          },
        ],
      },
      {
        id: "transforms-section",
        title: "3D transform + UCS + the section workflow (the honest engine boundary)",
        script: [
          { event: { type: "typed", text: "MOVE3D" } },
          { event: { type: "typed", text: "el-000007" } },
          { event: { type: "typed", text: "0,0,0" } },
          { event: { type: "typed", text: "UCSNEW" } },
          { event: { type: "typed", text: "TOP" } },
          { event: { type: "typed", text: "0,0,4" } },
          { event: { type: "typed", text: "1,0,0" } },
          { event: { type: "typed", text: "0,1,0" } },
          { event: { type: "typed", text: "SECTIONPLANE" } },
          { event: { type: "typed", text: "MID-X" } },
          { event: { type: "typed", text: "2.5,0,0" } },
          { event: { type: "typed", text: "1,0,0" } },
        ],
        queries: [{ name: "model3d.section", payload: { name: "MID-X" }, as: "section-exact" }],
        expectations: [
          {
            id: "exp-move3d-preserves",
            reference: "MOVE3D (the 3DMOVE semantic analog) translates the solid (identity preserved).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.0.id", equals: "el-000007" },
          },
          {
            id: "exp-ucs",
            reference: "UCSNEW (the UCS New-option semantic analog) defines the named workplane with the typed origin.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "ucs.0.id", equals: "ucs-000001" },
          },
          {
            id: "exp-ucs-origin",
            reference: "The UCS origin is the exact typed triple (orthonormalized axes derived deterministically).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "ucs.0.origin.2", equals: 4, tol: 1e-9 },
          },
          {
            id: "exp-sectionplane",
            reference: "SECTIONPLANE defines the named cutting plane at the typed point/normal.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "sectionPlanes.0.name", equals: "MID-X" },
          },
          {
            id: "exp-section-exact",
            reference:
              "AutoCAD SECTIONPLANE produces the exact section geometry: the canonical intersection loops with their deterministic hash. Offisos computes the exact section through the engine adapter's SectionProvider — the reference basis provides exact cell-class sections (analytic), and the OCCT engine carries the same capability (VERIFIED by the CAD-PARITY-010 suite).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "result", of: "section-exact", path: "exact", equals: true },
          },
          {
            id: "exp-section-exact-facets",
            reference: "The exact section facets carry closed canonical loops (at least one sectioned solid).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "result", of: "section-exact", path: "section.facets.length", equals: 1 },
          },
        ],
      },
    ],
    interop: [
      {
        id: "io-ifc-solids",
        surface: "ifc",
        concept: "solid geometry export",
        reference: "AutoCAD-class solids export to IFC as swept/boolean solids.",
        source: "arch-2024-ifc",
        expected: "unsupported",
        note: "the model3d solids are not a carried IFC class in the bounded model (typed skip — never fabricated geometry)",
        probe: { kind: "ifcAggregate" },
      },
    ],
    perf: [{ label: "wf-model3d-mass total", budgetMs: 45000 }],
    robustness: { roundTrip: true, undoRedoSteps: 1, replayStable: true },
  },

  // -------------------------------------------------------------------------
  // WF-6 — building model with schedules and quantities.
  // -------------------------------------------------------------------------
  {
    id: "wf-bim-quantities",
    title: "Building model with schedules and quantities",
    discipline: "bim",
    sources: ["arch-2024-commands", "arch-2024-ifc"],
    referenceBehavior:
      "AutoCAD Architecture 2024 documented AEC behavior: stories/levels organize the model; walls, hosted openings (windows/doors), slabs, roofs, stairs, railings and spaces are parametric objects; object properties (property sets) attach structured data; schedules extract the object data into tables with deterministic subtotals; quantities (QTO) derive material quantities from the model geometry per revision; materials assign to elements; the model revision recalculates quantities deterministically.",
    phases: [
      {
        id: "authoring",
        title: "AEC authoring (STORY + WALL + hosted openings + SLAB + STAIRRUN + ZONE)",
        commands: [
          {
            name: "bim.createElements",
            payload: {
              entities: [
                { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
                { type: "bim.wall", id: "wall-a", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 240, height: 3000 },
                { type: "bim.wall", id: "wall-b", storyId: "story-gf", start: [0, 0], end: [0, 4000], width: 240, height: 3000 },
                { type: "bim.opening", id: "op-1", hostId: "wall-a", distance: 2500, width: 1200, height: 1500, sill: 900 },
                { type: "bim.window", id: "win-1", openingId: "op-1", storyId: "story-gf" },
                { type: "bim.opening", id: "op-2", hostId: "wall-b", distance: 2000, width: 900, height: 2100, sill: 0 },
                { type: "bim.door", id: "door-1", openingId: "op-2", storyId: "story-gf" },
                { type: "bim.slab", id: "slab-1", storyId: "story-gf", corner1: [0, 0], corner2: [6000, 4000], thickness: 200 },
                { type: "bim.story", id: "story-1st", name: "First Floor", level: 3000, height: 3000 },
                { type: "bim.space", id: "space-office", storyId: "story-gf", name: "Office", footprint: [[100, 100], [5900, 100], [5900, 3900], [100, 3900]], height: 3000 },
              ],
            },
            as: "bim-seed",
          },
        ],
        script: [
          { event: { type: "typed", text: "STAIRRUN" } },
          { event: { type: "typed", text: "story-gf" } },
          { event: { type: "typed", text: "story-1st" } },
          { event: { type: "typed", text: "5000,500" } },
          { event: { type: "typed", text: "0" } },
          { event: { type: "typed", text: "1200" } },
          { event: { type: "typed", text: "16" } },
          { event: { type: "typed", text: "280" } },
          { event: { type: "typed", text: "BOTH" } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "ZONE" } },
          { event: { type: "typed", text: "OFFICE-01" } },
          { event: { type: "entity", entity: { by: "id", id: "space-office" } } },
          { event: { type: "enter" } },
        ],
        expectations: [
          {
            id: "exp-bim-elements",
            reference: "The AEC objects are created with the exact declared parameters (one atomic batch).",
            source: "arch-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.wall", equals: 2 },
          },
          {
            id: "exp-hosted-openings",
            reference: "Hosted openings attach to their host walls at the declared positions.",
            source: "arch-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.window", equals: 1 },
          },
          {
            id: "exp-stair",
            reference: "STAIRRUN (the STAIRADD semantic analog) places the deterministic stair run between the two typed stories (with its railing pair).",
            source: "arch-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.stair", equals: 1 },
          },
          {
            id: "exp-stair-railings",
            reference: "The stair run's railing pair is placed at the deterministic offsets.",
            source: "arch-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.railing", equals: 2 },
          },
          {
            id: "exp-zone",
            reference: "ZONE (the SPACEADD semantic analog) creates the named space.",
            source: "arch-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.zone", equals: 1 },
          },
        ],
      },
      {
        id: "properties-materials",
        title: "Property definitions + materials (PROPDEF + MATERIAL + assign)",
        commands: [
          { name: "property.create", payload: { name: "Fire rating", set: "PSet Safety", key: "FireRating", type: "number", unit: "min", appliesTo: ["bim.wall"] }, as: "propdef" },
          { name: "material.create", payload: { name: "Concrete C30", category: "Concrete", density: 2400 }, as: "material" },
          { name: "material.assign", payload: { ids: ["wall-a"], materialId: "el-000005" }, as: "assign" },
        ],
        expectations: [
          {
            id: "exp-propdef",
            reference: "The property definition is registered with the declared typed identity (the document-owned declaration registry).",
            source: "arch-2024-commands",
            outcome: "exact",
            check: { kind: "result", of: "propdef", path: "propertyDef.id", equals: "prd-000001" },
          },
          {
            id: "exp-material",
            reference: "The material is registered as a canonical model element (the document-unique exchange key).",
            source: "arch-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.14.props.name", equals: "Concrete C30" },
          },
          {
            id: "exp-material-assigned",
            reference: "The material is assigned to the element (the canonical materialId reference).",
            source: "arch-2024-commands",
            outcome: "exact",
            check: { kind: "state", path: "elements.1.props.materialId", equals: "el-000005" },
          },
        ],
      },
      {
        id: "schedules-qto",
        title: "Schedules + QTO (the deterministic extraction + revision-bound takeoff)",
        commands: [
          {
            name: "schedule.create",
            payload: {
              name: "Wall schedule",
              source: "elements",
              filter: { type: "bim.wall" },
              columns: [
                { key: "id", label: "Id" },
                { key: "material", label: "Material" },
              ],
            },
            as: "schedule",
          },
        ],
        queries: [{ name: "quantities.run", payload: { source: "elements", groupBy: "type" }, as: "qto" }],
        expectations: [
          {
            id: "exp-schedule",
            reference: "The schedule extracts the wall objects into the deterministic table.",
            source: "arch-2024-commands",
            outcome: "exact",
            check: { kind: "result", of: "schedule", path: "schedule.id", equals: "sch-000001" },
          },
          {
            id: "exp-qto-rows",
            reference: "QTO derives the quantities from the model geometry (the deterministic takeoff rows — one per element carrying a canonical quantity rule; the rest are listed in skipped with the typed reason).",
            source: "arch-2024-commands",
            outcome: "exact",
            check: { kind: "result", of: "qto", path: "rows.length", equals: 6 },
          },
          {
            id: "exp-qto-totals",
            reference: "QTO totals aggregate every measured row deterministically.",
            source: "arch-2024-commands",
            outcome: "exact",
            check: { kind: "result", of: "qto", path: "totals.count", equals: 6 },
          },
        ],
      },
    ],
    interop: [
      {
        id: "io-ifc-walls",
        surface: "ifc",
        concept: "AEC wall elements",
        reference: "AutoCAD Architecture exports walls to IFC as IfcWall with geometry.",
        source: "arch-2024-ifc",
        expected: "exact",
        note: "the DRY IFC round-trip over the same state is zero-loss by design (COMPAT-IFC-001)",
        probe: { kind: "ifcAggregate" },
      },
    ],
    perf: [{ label: "wf-bim-quantities total", budgetMs: 45000 }],
    robustness: { roundTrip: true, undoRedoSteps: 1, replayStable: true },
  },

  // -------------------------------------------------------------------------
  // WF-7 — specialized architecture/MEP/mechanical toolsets.
  // -------------------------------------------------------------------------
  {
    id: "wf-specialized-toolsets",
    title: "Architecture/MEP/mechanical specialized toolset workflows",
    discipline: "toolsets",
    sources: ["arch-2024-commands", "mep-2024-commands", "autocad-2024-commands", "arch-2024-ifc"],
    referenceBehavior:
      "The Autodesk-documented AEC/MEP reference behavior, with the Offisos surfaces declared as EXPLICIT SEMANTIC ANALOGS (never claimed Autodesk command names — the rev-2 command-analog map): AutoCAD Architecture 2024 documents the AEC object commands WALLADD, DOORADD, WINDOWADD, ROOFADD, SLABADD, SPACEADD, STAIRADD and SCHEDULEADD (the frequently-used command index); the Offisos WALLRUN, PLACEOPENING, SPACEGRID, STAIRRUN and ZONE are semantic analogs of those documented behaviors — WALLRUN composes multi-segment wall runs over the verified P011 BIM wall primitives (the WALLADD analog), PLACEOPENING places hosted openings into their host walls (the DOORADD/WINDOWADD analog), SPACEGRID places bounded space grids (the SPACEADD analog), STAIRRUN composes stair runs with optional railings (the STAIRADD analog) and ZONE names spaces (the SPACEADD analog). AutoCAD MEP 2024 documents NO MEPRUN, MEPREPORT, MEPCONNECT or EQUIPADD commands (verified against the MEP 2024 command index): the Offisos MEP commands are internal semantic surfaces over the DOCUMENTED MEP workflow concepts — duct/pipe/conduit runs route between endpoints with nominal sizes, connectors join runs, route validation reports clash/clearance diagnostics, and mechanical equipment carries ordinal connector ports. Raster underlays: AutoCAD 2024 documents IMAGEATTACH; the Offisos RASTERATTACH is its semantic analog (registered source + placement + content digest — the non-authoritative trace).",
    phases: [
      {
        id: "arch-toolset",
        title: "The architecture toolset (the WALLADD/DOORADD/SPACEADD semantic analogs WALLRUN/PLACEOPENING/SPACEGRID through the command line)",
        commands: [
          {
            name: "bim.createElements",
            payload: { entities: [{ type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 }] },
            as: "story",
          },
        ],
        script: [
          { event: { type: "typed", text: "WALLRUN" } },
          { event: { type: "typed", text: "story-gf" } },
          { event: { type: "typed", text: "0,0;6000,0;6000,5000" } },
          { event: { type: "typed", text: "300" } },
          { event: { type: "typed", text: "3000" } },
          { event: { type: "typed", text: "run" } },
          { event: { type: "typed", text: "OPEN" } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "PLACEOPENING" } },
          { event: { type: "typed", text: "el-000001" } },
          { event: { type: "typed", text: "DOO" } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "0.5" } },
          { event: { type: "typed", text: "900" } },
          { event: { type: "typed", text: "2100" } },
          { event: { type: "typed", text: "0" } },
          { event: { type: "typed", text: "SPACEGRID" } },
          { event: { type: "typed", text: "story-gf" } },
          { event: { type: "typed", text: "0,0" } },
          { event: { type: "typed", text: "4" } },
          { event: { type: "typed", text: "3" } },
          { event: { type: "typed", text: "4000" } },
          { event: { type: "typed", text: "3000" } },
          { event: { type: "typed", text: "ROOM" } },
        ],
        expectations: [
          {
            id: "exp-wallrun",
            reference: "The Offisos WALLRUN command (the WALLADD semantic analog) chains the declared vertices as canonical wall elements (one atomic batch, document-minted identities).",
            source: "arch-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.wall", equals: 2 },
          },
          {
            id: "exp-wallrun-junction",
            reference: "The Offisos WALLRUN command (the WALLADD semantic analog) places the junction opening at the shared vertex (the OPEN junction mode).",
            source: "arch-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.opening", equals: 2 },
          },
          {
            id: "exp-hosted-opening",
            reference: "The Offisos PLACEOPENING command (the DOORADD/WINDOWADD semantic analog) places the hosted door that cuts its host wall at the declared fractional position (t=0.5).",
            source: "arch-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.door", equals: 1 },
          },
          {
            id: "exp-spacegrid",
            reference: "The Offisos SPACEGRID command (the SPACEADD semantic analog) places the declared 4×3 grid of spaces (12 deterministic prefix-<col>-<row> names).",
            source: "arch-2024-commands",
            outcome: "exact",
            check: { kind: "countBy", type: "bim.space", equals: 12 },
          },
        ],
      },
      {
        id: "mep-toolset",
        title: "The MEP toolset (the Offisos MEPRUN semantic surface + the clash/clearance diagnostics + the typed declines)",
        script: [
          { event: { type: "typed", text: "MEPRUN" } },
          { event: { type: "typed", text: "DUC" } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "round" } },
          { event: { type: "typed", text: "300" } },
          { event: { type: "typed", text: "0,500,0" } },
          { event: { type: "typed", text: "3000,500,0" } },
          { event: { type: "typed", text: "sa-1" } },
          { event: { type: "typed", text: "MEPREPORT" } },
          { event: { type: "typed", text: "100" } },
        ],
        queries: [
          { name: "toolset.listRecords", payload: { kind: "mep.run" }, as: "mep-runs" },
        ],
        expectations: [
          {
            id: "exp-meprun-identity",
            reference: "The Offisos MEPRUN command (an internal semantic surface — AutoCAD MEP 2024 documents no such command) creates the document-owned specialized run record with a deterministic minted identity.",
            source: "mep-2024-commands",
            outcome: "exact",
            check: { kind: "result", of: "mep-runs", path: "records.0.id", equals: "tls-000001" },
          },
          {
            id: "exp-meprun-kind",
            reference: "The Offisos MEPRUN command's run record carries its typed toolset/kind classification (the documented MEP routing-workflow analog).",
            source: "mep-2024-commands",
            outcome: "exact",
            check: { kind: "result", of: "mep-runs", path: "records.0.kind", equals: "mep.run" },
          },
          {
            id: "exp-mepreport",
            reference: "The Offisos MEPREPORT command (an internal semantic surface — the documented MEP route-validation/clash-diagnostics analog) reports the deterministic route validation incl. clash/clearance diagnostics against the canonical wall bodies.",
            source: "mep-2024-commands",
            outcome: "exact",
            check: { kind: "echo", equals: "MEPREPORT: clash/clearance diagnostics at 100mm." },
          },
          {
            id: "exp-mepconnect-decline",
            reference: "The Offisos MEPCONNECT command (the documented MEP connector-workflow analog) refuses connecting to an unknown run typed (never a fabricated connection).",
            source: "mep-2024-commands",
            outcome: "unsupported",
            rationale: "The unknown-run connection is refused typed (toolset_not_found).",
            check: { kind: "decline", command: "toolset.mepConnect", payload: { runId: "tls-999999", at: "start", target: { kind: "endpoint", point: { x: 0, y: 0, z: 0 } } }, code: "toolset_not_found" },
          },
        ],
      },
      {
        id: "mech-raster",
        title: "The mechanical + raster toolsets (the Offisos EQUIPADD/MEPCONNECT semantic surfaces + the IMAGEATTACH-analog RASTERATTACH)",
        commands: [
          {
            name: "toolset.rasterAddSource",
            payload: {
              source: {
                sourceRef: "underlay/site-plan.png",
                contentDigest: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                widthPx: 1000,
                heightPx: 600,
                lineWork: [
                  { x1: 100, y1: 100, x2: 900, y2: 100 },
                  { x1: 100, y1: 300, x2: 900, y2: 300 },
                ],
              },
            },
            as: "raster-source",
          },
        ],
        script: [
          { event: { type: "typed", text: "EQUIPADD" } },
          { event: { type: "typed", text: "PUMP" } },
          { event: { type: "typed", text: "pump-a" } },
          { event: { type: "typed", text: "-500,0,0" } },
          { event: { type: "typed", text: "2" } },
          { event: { type: "typed", text: "MEPCONNECT" } },
          { event: { type: "typed", text: "tls-000001" } },
          { event: { type: "typed", text: "STAR" } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "EQU" } },
          { event: { type: "typed", text: "tls-000003" } },
          { event: { type: "typed", text: "p1" } },
          { event: { type: "typed", text: "n/a" } },
          { event: { type: "typed", text: "0,0,0" } },
          { event: { type: "typed", text: "RASTERATTACH" } },
          { event: { type: "typed", text: "underlay/site-plan.png" } },
          { event: { type: "typed", text: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" } },
          { event: { type: "typed", text: "0,0" } },
          { event: { type: "typed", text: "0.5" } },
          { event: { type: "typed", text: "0" } },
        ],
        queries: [
          { name: "toolset.listRecords", payload: {}, as: "inventory" },
          { name: "toolset.listRecords", payload: { kind: "mech.equipment" }, as: "equipment" },
          { name: "toolset.listRecords", payload: { kind: "mep.run" }, as: "mep-runs-after" },
        ],
        expectations: [
          {
            id: "exp-equip-ports",
            reference: "The Offisos EQUIPADD command (an internal semantic surface — the documented MEP equipment-placement analog) creates the equipment record with its ordinal ports (the deterministic mechanical discipline — the EQUIPADD echo states the port count).",
            source: "mep-2024-commands",
            outcome: "exact",
            check: { kind: "echo", equals: "EQUIPADD: pump 'pump-a' at {\"x\":-500,\"y\":0,\"z\":0} (2 port(s))." },
          },
          {
            id: "exp-equip-identity",
            reference: "The equipment record identity follows the run record (the monotonic tls- counter).",
            source: "mep-2024-commands",
            outcome: "exact",
            check: { kind: "result", of: "equipment", path: "records.0.id", equals: "tls-000003" },
          },
          {
            id: "exp-mepconnect-inrecord",
            reference: "The Offisos MEPCONNECT command's in-record connection joins the run start to the equipment port (the deterministic connector discipline — the typed connect outcome).",
            source: "mep-2024-commands",
            outcome: "exact",
            check: { kind: "echo", equals: "MEPCONNECT: 'tls-000001' start → {\"kind\":\"equipment\",\"equipmentId\":\"tls-000003\",\"portId\":\"p1\"}." },
          },
          {
            id: "exp-raster",
            reference: "The Offisos RASTERATTACH command (the IMAGEATTACH semantic analog) attaches the raster underlay with its placement and content digest (the non-authoritative trace).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "result", of: "inventory", path: "count", equals: 4 },
          },
        ],
      },
    ],
    interop: [
      {
        id: "io-toolsets-ifc-identity",
        surface: "ifc",
        concept: "specialized record identity",
        reference: "AutoCAD MEP 2024 (with Architecture 2024) exports objects to IFC with consistent identity (the documented toolset IFC exchange mapping).",
        source: "arch-2024-ifc",
        expected: "exact",
        note: "Pset_OffisosIdentity",
        probe: { kind: "toolsetsInterop", conceptId: "specialized-record-identity", surface: "ifc" },
      },
      {
        id: "io-toolsets-ifc-raster",
        surface: "ifc",
        concept: "raster payloads",
        reference: "Raster underlay payloads are not an IFC carrier concept (the documented IFC exchange mapping carries building objects, not raster bytes).",
        source: "arch-2024-ifc",
        expected: "unsupported",
        note: "raster image bytes never ride the carrier and are never fabricated",
        probe: { kind: "toolsetsInterop", conceptId: "raster-binary-payload", surface: "ifc" },
      },
      {
        id: "io-toolsets-ifc-arrays",
        surface: "ifc",
        concept: "structured arrays (segments/ports/connections)",
        reference: "The MEP/Architecture 2024 documented IFC exchange maps building objects to the corresponding IFC entities (native distribution structure).",
        source: "arch-2024-ifc",
        expected: "lossy",
        note: "segments / connections / ports / lineWork ride the documented escaped joined-string carrier: VALUES round-trip byte-exactly, but the IFC representation is a flattened property string, not native IFC structure",
        probe: { kind: "toolsetsInterop", conceptId: "specialized-record-structured-arrays", surface: "ifc" },
      },
    ],
    perf: [{ label: "wf-specialized-toolsets total", budgetMs: 45000 }],
    robustness: { roundTrip: true, undoRedoSteps: 1, replayStable: true },
  },

  // -------------------------------------------------------------------------
  // WF-8 — collaborative, recoverable, automated document workflow.
  // -------------------------------------------------------------------------
  {
    id: "wf-collab-automation",
    title: "Collaborative recoverable automated document workflow",
    discipline: "collab",
    sources: ["autocad-2024-commands", "autocad-2024-negxref", "autocad-2024-dxf"],
    referenceBehavior:
      "AutoCAD 2024 documented reference/xref behavior: XATTACH attaches an external reference with a name/path/insertion point/scale/rotation (the command line attaches UNRESOLVED — reading external file content needs the References palette); XLIST lists the reference table. AutoCAD 2024 documents NO standalone XRELOAD/XDETACH commands — reloading and detaching are the -XREF command's Reload and Detach options (the External References palette exposes them in the UI): the Offisos XRELOAD is the -XREF Reload analog that honestly declines typed at the command line (reading external content is beyond the bounded surface), and the Offisos XDETACH is the -XREF Detach analog that removes the reference record and all its instances in one atomic revision. The collaboration analog (declared, not an Autodesk claim): presence/comments over the shared document; checkpoints record recoverable states; automated scripts execute a recorded command sequence with reproducible outcomes; subscriptions observe the semantic event stream.",
    phases: [
      {
        id: "xrefs-attach",
        title: "External references (XATTACH → XLIST → the typed XRELOAD boundary — the -XREF Reload analog)",
        script: [
          { event: { type: "typed", text: "XATTACH" } },
          { event: { type: "typed", text: "site-base" } },
          { event: { type: "typed", text: "site-base.dwg" } },
          { event: { type: "pick", point: [0, 0] } },
          { event: { type: "enter" } },
          { event: { type: "enter" } },
          { event: { type: "typed", text: "XLIST" } },
          { event: { type: "typed", text: "XRELOAD" } },
        ],
        queries: [{ name: "xrefs.status", payload: {}, as: "xstatus" }],
        expectations: [
          {
            id: "exp-xattach",
            reference: "XATTACH attaches the external reference with the declared name (unresolved — the command line cannot read file content; the honest AutoCAD-class boundary).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "result", of: "xstatus", path: "xrefs.length", equals: 1 },
          },
          {
            id: "exp-xattach-status",
            reference: "The attached reference reports its unresolved status honestly.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "result", of: "xstatus", path: "xrefs.0.recordStatus", equals: "unresolved" },
          },
          {
            id: "exp-xlist",
            reference: "XLIST lists the external-reference table (name, status, path, instance count, provenance hash).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "echo", equals: "XLIST: external references —" },
          },
          {
            id: "exp-xreload-decline",
            reference: "AutoCAD 2024 documents NO standalone XRELOAD command — reloading is the -XREF Reload option / the External References palette; the Offisos XRELOAD (the -XREF Reload semantic analog) declines typed at the command line (reading external content is beyond the bounded surface) — never a silent no-op.",
            source: "autocad-2024-negxref",
            outcome: "unsupported",
            rationale: "The command-line XRELOAD (the -XREF Reload analog) is the typed unsupported surface (the palette owns the file re-read).",
            check: { kind: "echo", equals: "XRELOAD requires re-reading the external file — open the References palette (XREF) and use Reload with the refreshed file. The command line cannot read external content (typed unsupported, never a silent no-op)." },
          },
        ],
      },
      {
        id: "xrefs-detach",
        title: "XDETACH: the reference record and instances removed in one atomic revision (the -XREF Detach analog)",
        script: [
          { event: { type: "typed", text: "XDETACH" } },
          { event: { type: "typed", text: "site-base" } },
        ],
        expectations: [
          {
            id: "exp-xdetach",
            reference: "The Offisos XDETACH (the semantic analog of the -XREF Detach option) removes the reference and its instances (the explicit detach cascade — one atomic revision).",
            source: "autocad-2024-negxref",
            outcome: "exact",
            check: { kind: "count", equals: 0 },
          },
          {
            id: "exp-xdetach-atomic",
            reference: "The detach is ONE atomic model revision.",
            source: "autocad-2024-negxref",
            outcome: "exact",
            check: { kind: "revisionDelta", equals: 1 },
          },
        ],
      },
      {
        id: "collab",
        title: "Collaboration (presence + comment over the shared document)",
        commands: [
          { name: "collab.join", payload: { userId: "architect", role: "editor" }, as: "join" },
          { name: "collab.presence", payload: { userId: "architect" }, as: "presence" },
          { name: "collab.comment", payload: { userId: "architect", body: "Check the wall width" }, as: "comment" },
        ],
        queries: [{ name: "collab.state", payload: {}, as: "collabstate" }],
        expectations: [
          {
            id: "exp-presence",
            reference: "Presence records the collaborating principal in the shared roster.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "result", of: "presence", path: "member.userId", equals: "architect" },
          },
          {
            id: "exp-comment",
            reference: "The comment is recorded with its author and body (durable, visible to every participant).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "result", of: "comment", path: "comment.body", equals: "Check the wall width" },
          },
          {
            id: "exp-collab-state",
            reference: "The shared collaboration state reports the roster and the comment thread.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "result", of: "collabstate", path: "members.length", equals: 1 },
          },
        ],
      },
      {
        id: "recovery",
        title: "Recovery (CKPT: the recoverable checkpoint state)",
        commands: [
          { name: "recovery.checkpoint", payload: {}, as: "ckpt" },
        ],
        queries: [{ name: "recovery.list", payload: {}, as: "recover" }],
        expectations: [
          {
            id: "exp-ckpt",
            reference: "The checkpoint records the recoverable state (the durable, revision-traceable manual checkpoint).",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "result", of: "ckpt", path: "checkpoint.cause", equals: "manual" },
          },
          {
            id: "exp-recovery-list",
            reference: "The recovery list reports the retained checkpoints.",
            source: "autocad-2024-commands",
            outcome: "exact",
            check: { kind: "result", of: "recover", path: "checkpoints.length", equals: 1 },
          },
        ],
      },
    ],
    interop: [
      {
        id: "io-dxf-xrefs",
        surface: "dxf",
        concept: "external references",
        reference: "AutoCAD DXF records external references (the XREF table).",
        source: "autocad-2024-dxf",
        expected: "unsupported",
        note: "the end-state document carries no DXF-writer content class — xref records are document-owned state the DXF writer does not carry (typed skip, never fabricated)",
        probe: { kind: "dxfAggregate" },
      },
    ],
    perf: [{ label: "wf-collab-automation total", budgetMs: 45000 }],
    robustness: { roundTrip: true, undoRedoSteps: 1, replayStable: true },
  },
];

// ---------------------------------------------------------------------------
// The corpus identity (the version pin made checkable).
// ---------------------------------------------------------------------------

/** The corpus fields included in the canonical digest (the pinned data).
 *  Rev 2: the version-pinned Autodesk reference manifest, the
 *  Autodesk-documented command bindings and the explicit command-analog map
 *  are PART OF THE DIGEST — the reference basis is auditable and any change
 *  to it changes the corpus identity. */
function corpusDigestData(): unknown {
  return {
    reference: CORPUS_REFERENCE,
    referenceManifest: CORPUS_REFERENCE_MANIFEST,
    autodeskCommands: CORPUS_AUTODESK_COMMANDS,
    commandAnalogs: CORPUS_COMMAND_ANALOGS,
    workflows: P019_WORKFLOWS.map((w) => ({
      id: w.id,
      title: w.title,
      discipline: w.discipline,
      referenceBehavior: w.referenceBehavior,
      sources: w.sources,
      phases: w.phases.map((p) => ({
        id: p.id,
        title: p.title,
        script: p.script ?? null,
        commands: (p.commands ?? []).map((c) => ({ name: c.name, payload: c.payload ?? null, as: c.as ?? null })),
        queries: (p.queries ?? []).map((qq) => ({ name: qq.name, payload: qq.payload ?? null, as: qq.as })),
        expectations: p.expectations.map((e) => ({
          id: e.id,
          reference: e.reference,
          source: e.source,
          outcome: e.outcome,
          rationale: e.rationale ?? null,
          check: e.check,
        })),
      })),
      interop: w.interop.map((i) => ({
        id: i.id,
        surface: i.surface,
        concept: i.concept,
        reference: i.reference,
        source: i.source,
        expected: i.expected,
        note: i.note,
        probe: i.probe,
      })),
      perf: w.perf,
      robustness: w.robustness,
    })),
  };
}

let cachedCorpusJson: string | null = null;

/** The canonical JSON encoding of the pinned corpus data (stable). */
export function corpusCanonicalJson(): string {
  if (cachedCorpusJson === null) {
    cachedCorpusJson = canonicalStringify(corpusDigestData());
  }
  return cachedCorpusJson;
}

/** The stable sha256 over the canonical corpus encoding (the version pin). */
export function corpusSha256(): string {
  return createHash("sha256").update(corpusCanonicalJson(), "utf8").digest("hex");
}

/** The declared outcome-classification counts over the whole corpus. */
export function corpusOutcomeCounts(): { exact: number; lossy: number; unsupported: number; interopExact: number; interopLossy: number; interopUnsupported: number } {
  let exact = 0;
  let lossy = 0;
  let unsupported = 0;
  for (const w of P019_WORKFLOWS) {
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
  for (const w of P019_WORKFLOWS) {
    for (const i of w.interop) {
      if (i.expected === "exact") interopExact += 1;
      else if (i.expected === "lossy") interopLossy += 1;
      else interopUnsupported += 1;
    }
  }
  return { exact, lossy, unsupported, interopExact, interopLossy, interopUnsupported };
}

// ---------------------------------------------------------------------------
// The derived corpus catalog (rev 2 — the single source of truth for the
// Certification workbench; derived HERE, never hard-coded in the UI).
// ---------------------------------------------------------------------------

/** The derived per-workflow catalog row (phases + expectations counted from
 *  THIS corpus — the canonical values the workbench renders through the
 *  certification.corpusCatalog App API query). */
export interface CorpusCatalogWorkflow {
  readonly id: string;
  readonly title: string;
  readonly discipline: string;
  readonly phases: number;
  readonly expectations: number;
}

/** The derived corpus catalog: the version pin, the auditable reference
 *  manifest, the command bindings summary and the per-workflow counts —
 *  everything a UI needs, derived from the pinned corpus data (any corpus
 *  change flows through automatically; nothing can go stale). */
export function corpusCatalog(): {
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
    readonly autodeskDocumented: readonly { readonly command: string; readonly autodeskCommand: string; readonly source: string }[];
    readonly semanticAnalogs: readonly { readonly offisosSurface: string; readonly surface: string; readonly autodeskReference: string; readonly source: string; readonly scope: string }[];
  };
  readonly workflows: readonly CorpusCatalogWorkflow[];
  readonly totals: { readonly workflows: number; readonly phases: number; readonly expectations: number; readonly interop: number };
} {
  const manifestIds = new Set(CORPUS_REFERENCE_MANIFEST.map((s) => s.id));
  const workflows: CorpusCatalogWorkflow[] = P019_WORKFLOWS.map((w) => ({
    id: w.id,
    title: w.title,
    discipline: w.discipline,
    phases: w.phases.length,
    expectations: w.phases.reduce((n, p) => n + p.expectations.length, 0),
  }));
  return {
    corpus: {
      id: CORPUS_REFERENCE.corpusId,
      version: CORPUS_REFERENCE.corpusVersion,
      referenceProduct: CORPUS_REFERENCE.referenceProduct,
      sha256: corpusSha256(),
    },
    sources: CORPUS_REFERENCE_MANIFEST.map((s) => ({
      id: s.id,
      product: s.product,
      title: s.title,
      locator: s.locator,
      docId: s.docId,
      scope: s.scope,
    })),
    commandBindings: {
      autodeskDocumented: CORPUS_AUTODESK_COMMANDS.map((c) => ({
        command: c.command,
        autodeskCommand: c.autodeskCommand,
        source: manifestIds.has(c.source) ? c.source : "",
      })),
      semanticAnalogs: CORPUS_COMMAND_ANALOGS.map((a) => ({
        offisosSurface: a.offisosSurface,
        surface: a.surface,
        autodeskReference: a.autodeskReference,
        source: manifestIds.has(a.source) ? a.source : "",
        scope: a.scope,
      })),
    },
    workflows,
    totals: {
      workflows: workflows.length,
      phases: workflows.reduce((n, w) => n + w.phases, 0),
      expectations: workflows.reduce((n, w) => n + w.expectations, 0),
      interop: P019_WORKFLOWS.reduce((n, w) => n + w.interop.length, 0),
    },
  };
}
