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

/** Identity provenance written as Pset_OffisosIdentity on every element. */
export interface IfcIdentity {
  readonly DomainId: string;
  readonly DomainKind: string;
  readonly ModelRevision: string;
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

export interface IfcParseResult {
  readonly schema: string;
  readonly lengthUnitName: string | null;
  readonly lengthUnitPrefix: string | null;
  readonly stories: readonly IfcParsedStory[];
  readonly elements: readonly IfcParsedElement[];
  readonly relationships: {
    readonly voids: number;
    readonly fills: number;
    readonly containment: number;
    readonly aggregation: number;
  };
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
}
