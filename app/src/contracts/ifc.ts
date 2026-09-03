/**
 * IFC/openBIM interop wire contracts (COMPAT-IFC-001 / Issue #47).
 *
 * TYPES ONLY — pure, engine-free, browser-safe. These are the shapes
 * exchanged with the IFC interop adapter (contracts/adapter.ts
 * IfcInteropAdapter), mirroring the Python worker protocol
 * (src/adapters/ifc/ifc-worker-protocol.ts) which re-exports them. All byte
 * payloads are base64 strings; all wire numbers are METRES (the IFC file
 * convention). The canonical Offisos domain (mm) and the unit normalization
 * live in the IFC core (src/ifc), never here.
 */

// --- Build request (deterministic IFC generation) ----------------------------

/** Identity provenance written as Pset_OffisosIdentity on every element.
 *  IDENTITY ONLY: the export is a pure function of the canonical element
 *  state — version metadata never enters the file (byte-determinism across
 *  documents; the document history is the canonical revision record). */
export interface IfcIdentity {
  readonly DomainId: string;
  readonly DomainKind: string;
  readonly ModelRevision?: string;
}

/** A story in the build request (IFC length units: metres). */
export interface IfcStoryInput {
  readonly guid: string;
  readonly name: string;
  readonly elevation: number;
  /** Canonical story height (m) — carried as Pset_OffisosParams.Height. */
  readonly height: number;
  readonly identity: IfcIdentity;
}

/** A wall (metres). `angle` is the wall axis rotation about +Z (radians). */
export interface IfcWallInput {
  readonly guid: string;
  readonly name: string;
  readonly storyGuid: string;
  readonly start: readonly [number, number];
  readonly angle: number;
  readonly length: number;
  readonly height: number;
  readonly thickness: number;
  /** World Z of the wall base (m) = story elevation + baseOffset. */
  readonly baseZ: number;
  readonly identity: IfcIdentity;
  readonly qtos?: Readonly<Record<string, number>>;
  readonly custom?: Readonly<Record<string, string | number | boolean>>;
}

/** A slab (metres), axis-aligned footprint corners in world XY. */
export interface IfcSlabInput {
  readonly guid: string;
  readonly name: string;
  readonly storyGuid: string;
  readonly corner1: readonly [number, number];
  readonly corner2: readonly [number, number];
  readonly thickness: number;
  /** World Z of the slab base (m). */
  readonly baseZ: number;
  readonly identity: IfcIdentity;
  readonly qtos?: Readonly<Record<string, number>>;
  readonly custom?: Readonly<Record<string, string | number | boolean>>;
}

/** An opening (metres) — a hosted void in `hostGuid`'s wall, parametrized in
 *  the HOST WALL's axis frame (exactly the canonical params): `distance` is
 *  the near-edge position along the host axis from the wall start, `sill`
 *  the base offset above the wall base. The void box uses the wall
 *  convention (profile XY = axis width × lateral through-cut thickness,
 *  extruded +Z by the clear height); the worker writes the placement in
 *  the host wall's frame (IfcRelVoidsElement nests opening placements
 *  under the host). */
export interface IfcOpeningInput {
  readonly guid: string;
  readonly name: string;
  readonly hostGuid: string;
  /** Near-edge position along the host axis from the wall start (m, ≥ 0). */
  readonly distance: number;
  /** Base offset above the host wall base (m, ≥ 0). */
  readonly sill: number;
  readonly width: number;
  readonly height: number;
  /** Host wall thickness (m) — the void box extrudes through it (+2 mm overhang). */
  readonly thickness: number;
  readonly identity: IfcIdentity;
}

/** A door or window filling an opening (metres). */
export interface IfcFillInput {
  readonly guid: string;
  readonly name: string;
  readonly openingGuid: string;
  readonly storyGuid: string;
  readonly overallWidth: number;
  readonly overallHeight: number;
  readonly identity: IfcIdentity;
  /** Door semantic params (Pset_OffisosParams): swing + leaf thickness (mm). */
  readonly params?: Readonly<Record<string, string | number | boolean>>;
}

/** A space (metres). `footprint` is relative to `position` (object coords). */
export interface IfcSpaceInput {
  readonly guid: string;
  readonly name: string;
  readonly storyGuid: string;
  readonly position: readonly [number, number];
  /** World Z of the space base (m). */
  readonly z: number;
  readonly footprint: readonly (readonly [number, number])[];
  readonly height: number;
  readonly longName: string;
  readonly identity: IfcIdentity;
  readonly qtos?: Readonly<Record<string, number>>;
  readonly custom?: Readonly<Record<string, string | number | boolean>>;
}

// --- COMPAT-BIM-003 (additive): materials + component instances ---------------

/** A canonical material in the build request. IfcMaterial has NO GlobalId —
 *  `guid` is the deterministic association key derived from the canonical
 *  material id (wire bookkeeping only); identity provenance rides in the
 *  IfcMaterialProperties set named Pset_OffisosIdentity. */
export interface IfcMaterialInput {
  readonly guid: string;
  readonly name: string;
  readonly description?: string;
  readonly identity: IfcIdentity;
  /** Canonical material properties (+ color as R/G/B integers) → the
   *  IfcMaterialProperties set named Pset_OffisosMaterial. */
  readonly properties?: Readonly<Record<string, string | number | boolean>>;
}

/** A component instance (metres): a freestanding parametric box placed in the
 *  story-local plane, mapped per category to IfcWall/IfcDoor/IfcWindow/
 *  IfcFurnishingElement. The box is CENTERED on `position` (the worker shifts
 *  the corner-anchored profile origin); `component` carries the
 *  Pset_OffisosComponent provenance (DefinitionId, Category, effective
 *  parameters, override keys) that the import reconciles on. */
export interface IfcComponentInput {
  readonly guid: string;
  readonly name: string;
  readonly storyGuid: string;
  readonly category: "wall" | "door" | "window" | "furniture" | "fixture";
  readonly position: readonly [number, number];
  readonly rotation: number;
  /** World Z of the box base (m). */
  readonly baseZ: number;
  /** Box extents [sizeX, sizeY, sizeZ] from the effective parameters (m). */
  readonly size: readonly [number, number, number];
  readonly identity: IfcIdentity;
  readonly component: Readonly<Record<string, string | number | boolean>>;
  readonly materialGuid?: string;
}

// --- CAD-PARITY-014 (additive, Issue #107): documentation exchange carrier --

/** One documentation table record as an IFC IfcGroup (D2): IfcGroup is an
 *  IfcRoot (the guid derives deterministically from the canonical record id)
 *  AND an IfcObject (psets attach). Pset_OffisosIdentity carries the identity
 *  provenance; Pset_OffisosDocs carries the record fields as scalar property
 *  values. Array-valued fields encode as documented comma/pipe-joined strings
 *  (ifc/docmap.ts owns the encoding; see its module header). */
export interface IfcDocumentationRecord {
  /** IfcGuid = ifcGuidFor(canonical record id) — same discipline as elements. */
  readonly guid: string;
  /** The IfcGroup Name (the record's display name). */
  readonly name: string;
  /** Identity ONLY (no version metadata — byte-determinism across documents). */
  readonly identity: IfcIdentity;
  /** The record fields as Pset_OffisosDocs property values (string|number|
   *  boolean; arrays pre-encoded as documented joined strings). */
  readonly fields: Readonly<Record<string, string | number | boolean>>;
}

/** The documentation exchange input (CAD-PARITY-014): one IfcGroup per
 *  record, in fixed kind-group order. Absent → the build is byte-identical
 *  to the pre-P014 legacy export (the fixture-pinned invariant). */
export interface IfcDocumentationInput {
  readonly groups: readonly IfcDocumentationRecord[];
}

// --- CAD-PARITY-018 (Issue #118, acceptance criterion 14 — the corrective
// interop coverage): the specialized-toolsets IfcGroup exchange carrier ----

/** A specialized-toolsets exchange record (CAD-PARITY-018): the SAME
 *  IfcGroup carrier discipline as IfcDocumentationRecord — one IfcGroup per
 *  specialized record (`tls-NNNNNN`), IfcRoot guid LOCKED to
 *  ifcGuidFor(record id) (the P014 caller-guid discipline),
 *  Pset_OffisosIdentity carrying {DomainId: record id, DomainKind:
 *  "toolsets.<kind>"} and Pset_OffisosDocs carrying the record fields as
 *  scalar property values (numbers ride the exact-reversible String(n)
 *  encoding; structured arrays ride the documented escaped joined-string
 *  encoding — ifc/toolsetmap.ts owns the codec). The worker-side group
 *  writer/reader is GENERIC over identity+fields records (the P014 design),
 *  so this carrier requires ZERO worker/adapter-protocol changes: the IFC
 *  adapter maps these groups onto the worker's documentation group carrier
 *  and discriminates them back by DomainKind on parse. */
export interface IfcToolsetRecord {
  /** IfcGuid = ifcGuidFor(canonical record id) — same discipline as elements. */
  readonly guid: string;
  /** The IfcGroup Name (the record's display name). */
  readonly name: string;
  /** Identity ONLY (no version metadata — byte-determinism across documents). */
  readonly identity: IfcIdentity;
  /** The record fields as Pset_OffisosDocs property values. */
  readonly fields: Readonly<Record<string, string | number | boolean>>;
}

/** The specialized-toolsets exchange input (CAD-PARITY-018): one IfcGroup
 *  per specialized record, in fixed kind-group order (mep runs → mechanical
 *  equipment → raster sources → raster references, each by record id).
 *  Absent on documents without specialized records → no groups are created
 *  and the generated bytes are byte-identical to the pre-P018 export (the
 *  fixture-pinned additivity invariant). */
export interface IfcToolsetsInput {
  readonly groups: readonly IfcToolsetRecord[];
}

/** The complete deterministic build model (sorted, versioned, hashable). */
export interface IfcBuildRequest {
  readonly projectName: string;
  readonly stories: readonly IfcStoryInput[];
  readonly walls: readonly IfcWallInput[];
  readonly slabs: readonly IfcSlabInput[];
  readonly openings: readonly IfcOpeningInput[];
  readonly doors: readonly IfcFillInput[];
  readonly windows: readonly IfcFillInput[];
  readonly spaces: readonly IfcSpaceInput[];
  // COMPAT-BIM-003 (additive; empty arrays on legacy callers).
  readonly materials?: readonly IfcMaterialInput[];
  readonly components?: readonly IfcComponentInput[];
  // CAD-PARITY-014 (additive): the documentation tables exchange as IfcGroup
  // entities. Absent on legacy documents → no groups are created and the
  // generated bytes are byte-identical to the pre-P014 export.
  readonly documentation?: IfcDocumentationInput;
  // CAD-PARITY-018 (additive, Issue #118 criterion 14): the specialized
  // toolsets records exchange through the same IfcGroup carrier. Absent on
  // documents without specialized records → byte-identical to the pre-P018
  // export; when present, the adapter appends these groups AFTER the
  // documentation groups (deterministic order).
  readonly toolsets?: IfcToolsetsInput;
}

export interface IfcBuildResult {
  /** Base64 of the deterministic IFC file bytes. */
  readonly ifc: string;
  readonly size: number;
  /** SHA-256 of the IFC bytes. */
  readonly sha256: string;
  readonly engineVersion: string;
}

// --- Parse result (semantic IR of an IFC file) --------------------------------

export interface IfcParsedStory {
  readonly globalId: string;
  readonly name: string;
  readonly elevation: number;
  /** Pset_OffisosParams.Height when present (m), else null. */
  readonly height: number | null;
  readonly psets: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly qtos: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** Extruded-rect body profile facts: the swept profile's bounding box
 *  (x0,y0 = min corner in profile coords; corner-anchored profiles have
 *  (0,0), IfcRectangleProfileDef is centered → negative x0/y0) + the
 *  extrusion depth. The IFC core interprets per element kind. */
export interface IfcParsedProfile {
  readonly kind: "rect";
  readonly x0: number;
  readonly y0: number;
  readonly xdim: number;
  readonly ydim: number;
  readonly depth: number;
}

export interface IfcParsedElement {
  readonly globalId: string;
  readonly ifcClass: string;
  readonly name: string;
  /** Containing storey (containment or aggregation), when resolvable. */
  readonly storyGlobalId: string | null;
  /** Voids host (openings only). */
  readonly hostGlobalId: string | null;
  /** Fills opening (doors/windows only). */
  readonly fillOpeningGlobalId: string | null;
  /** Associated material NAME (COMPAT-BIM-003; IfcMaterial has no GlobalId). */
  readonly materialName: string | null;
  readonly psets: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly qtos: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** World placement translation (m, rounded 1e-9), when placed. */
  readonly placement: readonly [number, number, number] | null;
  /** World XY rotation 2x2 (rounded 1e-9), when placed. */
  readonly rotation: readonly [readonly [number, number], readonly [number, number]] | null;
  /** Extruded-rect body profile (m), when extractable. */
  readonly profile: IfcParsedProfile | null;
  /** Footprint curve points in object coords (m), when extractable. */
  readonly footprint: readonly (readonly [number, number])[] | null;
  /** Standard door/window overall sizes (m). */
  readonly overallWidth: number | null;
  readonly overallHeight: number | null;
}

/** A parsed material (COMPAT-BIM-003). `psets` carries the
 *  IfcMaterialProperties sets keyed by name — Pset_OffisosIdentity carries the
 *  canonical id for reconciliation; Pset_OffisosMaterial carries the canonical
 *  material properties (+ color R/G/B). */
export interface IfcParsedMaterial {
  readonly name: string;
  readonly description: string | null;
  readonly psets: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** A parsed documentation IfcGroup record (CAD-PARITY-014): the group's
 *  GlobalId + Name plus its two psets (identity provenance and the record
 *  fields — raw values, decode lives in ifc/docmap.ts). */
export interface IfcParsedDocumentationRecord {
  readonly globalId: string;
  readonly name: string;
  /** Pset_OffisosIdentity values, when the group carries the identity set. */
  readonly identity: Readonly<Record<string, unknown>> | null;
  /** Pset_OffisosDocs values, when the group carries the docs set. */
  readonly fields: Readonly<Record<string, unknown>>;
}

/** The parsed documentation dimension of an IFC file (CAD-PARITY-014). */
export interface IfcParsedDocumentation {
  readonly records: readonly IfcParsedDocumentationRecord[];
}

/** A parsed specialized-toolsets IfcGroup record (CAD-PARITY-018): the
 *  group's GlobalId + Name plus its two psets — Pset_OffisosIdentity with
 *  DomainKind "toolsets.<kind>" (the adapter discriminates toolsets groups
 *  out of the worker's generic group parse by this DomainKind) and
 *  Pset_OffisosDocs with the record fields (raw values; decode lives in
 *  ifc/toolsetmap.ts). */
export interface IfcParsedToolsetRecord {
  readonly globalId: string;
  readonly name: string;
  /** Pset_OffisosIdentity values, when the group carries the identity set. */
  readonly identity: Readonly<Record<string, unknown>> | null;
  /** Pset_OffisosDocs values, when the group carries the fields set. */
  readonly fields: Readonly<Record<string, unknown>>;
}

/** The parsed specialized-toolsets dimension of an IFC file
 *  (CAD-PARITY-018). Absent when the file carries no toolsets groups —
 *  legacy parse results stay shape-identical. */
export interface IfcParsedToolsets {
  readonly records: readonly IfcParsedToolsetRecord[];
}

export interface IfcParseResult {
  readonly schema: string;
  readonly lengthUnitName: string | null;
  readonly lengthUnitPrefix: string | null;
  readonly stories: readonly IfcParsedStory[];
  readonly elements: readonly IfcParsedElement[];
  readonly materials: readonly IfcParsedMaterial[];
  readonly relationships: {
    readonly voids: number;
    readonly fills: number;
    readonly containment: number;
    readonly aggregation: number;
    readonly materialAssociations: number;
  };
  // CAD-PARITY-014 (additive): the documentation IfcGroup records (one per
  // exported record; absent when the file carries none — legacy parse results
  // stay shape-identical).
  readonly documentation?: IfcParsedDocumentation;
  // CAD-PARITY-018 (additive, Issue #118 criterion 14): the specialized
  // toolsets IfcGroup records, discriminated by DomainKind at the adapter
  // (absent when the file carries none — legacy parse results stay
  // shape-identical).
  readonly toolsets?: IfcParsedToolsets;
  readonly engineVersion: string;
}

// --- IDS / BCF ----------------------------------------------------------------

export interface IfcIdsSpecResult {
  readonly name: string;
  readonly status: "pass" | "fail";
  readonly applicable: readonly string[];
  readonly passed: readonly string[];
  readonly failed: readonly string[];
}

export interface IfcIdsResult {
  readonly specs: readonly IfcIdsSpecResult[];
}

// --- CAD-PARITY-014 (additive, Issue #107): BCF viewpoint + source lineage --

/** A BCF 3.0 camera viewpoint (D3). Coordinates are world metres (the IFC
 *  convention) — the caller resolves them from the canonical model. */
export interface IfcBcfViewpoint {
  readonly cameraViewPoint: readonly [number, number, number];
  readonly cameraDirection: readonly [number, number, number];
  readonly cameraUpVector: readonly [number, number, number];
  /** Orthogonal camera (viewToWorldScale required); absent = perspective. */
  readonly orthogonal?: boolean;
  /** ViewToWorldScale for orthogonal cameras. */
  readonly viewToWorldScale?: number;
}

/** A parsed BCF viewpoint: the camera triple + the orthogonal/perspective
 *  distinction (viewToWorldScale null for perspective cameras). */
export interface IfcBcfParsedViewpoint {
  readonly cameraViewPoint: readonly [number, number, number];
  readonly cameraDirection: readonly [number, number, number];
  readonly cameraUpVector: readonly [number, number, number];
  readonly orthogonal: boolean;
  readonly viewToWorldScale: number | null;
}

export interface IfcBcfTopicRequest {
  readonly title: string;
  readonly description: string;
  readonly author: string;
  readonly type: string;
  readonly status: string;
  /** Referenced element guids (IfcGuid selection components). */
  readonly references: readonly string[];
  readonly comment: string | null;
  readonly commentAuthor: string | null;
  // CAD-PARITY-014 (additive): the topic's camera viewpoint (absent = the
  // legacy origin-target viewpoint — backward compatible) and the source
  // lineage (the exporting document's canonical revision identity, chosen by
  // the CALLER; carried as the BCF topic document reference).
  readonly viewpoint?: IfcBcfViewpoint;
  readonly sourceRevision?: string;
}

export interface IfcBcfParsedComment {
  readonly author: string;
  readonly comment: string;
  readonly date: string;
}

export interface IfcBcfParsedTopic {
  readonly guid: string;
  readonly title: string;
  readonly description: string;
  readonly type: string;
  readonly status: string;
  readonly comments: readonly IfcBcfParsedComment[];
  /** Referenced IfcGuids from viewpoint selection components. */
  readonly references: readonly string[];
  // CAD-PARITY-014 (additive): the topic's camera viewpoint (null when the
  // topic carries none) and the source lineage (null when absent).
  readonly viewpoint: IfcBcfParsedViewpoint | null;
  readonly sourceRevision: string | null;
}
