/**
 * IFC worker protocol types (COMPAT-IFC-001 / Issue #47).
 *
 * The JSON protocol spoken over stdio with the isolated Python worker
 * (worker/ifc-worker.py) — exactly the OCCT worker discipline
 * (CAD-IMPLEMENT-002 precedent): one request per DISPOSABLE subprocess,
 * typed request/response pairs, every failure a typed code. This module is
 * TYPES ONLY: it imports nothing at runtime (type-only re-exports of the
 * contracts layer) and is safe to reference from anywhere (the concrete
 * adapter lives behind the boundary; LOCK-018).
 *
 * The worker is the ONLY place IfcOpenShell/IfcTester/bcf-client appear
 * (RESEARCH-CAD-003-proven toolchain, pinned: ifcopenshell 0.8.5,
 * IfcTester 0.8.5). All numbers on the wire are in IFC file units
 * (METRE, per the export convention) — the TS side owns the canonical
 * mm domain and the unit normalization.
 */

import type {
  IfcBcfParsedTopic,
  IfcBcfTopicRequest,
  IfcBuildRequest,
  IfcIdsResult,
  IfcParseResult,
} from "../../contracts/ifc.js";

export type {
  IfcIdentity,
  IfcStoryInput,
  IfcWallInput,
  IfcSlabInput,
  IfcOpeningInput,
  IfcFillInput,
  IfcSpaceInput,
  IfcBuildRequest,
  IfcParsedStory,
  IfcParsedProfile,
  IfcParsedElement,
  IfcParseResult,
  IfcIdsSpecResult,
  IfcIdsResult,
  IfcBcfTopicRequest,
  IfcBcfParsedComment,
  IfcBcfParsedTopic,
} from "../../contracts/ifc.js";

// Historical aliases used by the process driver (kept for protocol symmetry).
export type WorkerIdentity = import("../../contracts/ifc.js").IfcIdentity;
export type WorkerBuildModel = import("../../contracts/ifc.js").IfcBuildRequest;

// --- Requests / responses ------------------------------------------------------

export interface WorkerPingRequest {
  readonly op: "ping";
}

export interface WorkerParseRequest {
  readonly op: "parse";
  /** Base64 of the IFC file bytes. */
  readonly ifc: string;
}

export interface WorkerBuildRequest {
  readonly op: "build";
  readonly model: IfcBuildRequest;
}

export interface WorkerIdsRequest {
  readonly op: "ids";
  readonly ifc: string;
  /** IDS specification XML (ids:ids document). */
  readonly ids: string;
}

export interface WorkerBcfBuildRequest {
  readonly op: "bcf_build";
  readonly topics: readonly IfcBcfTopicRequest[];
}

export interface WorkerBcfParseRequest {
  readonly op: "bcf_parse";
  /** Base64 of the .bcf (zip) container bytes. */
  readonly bcf: string;
}

export type WorkerRequest =
  | WorkerPingRequest
  | WorkerParseRequest
  | WorkerBuildRequest
  | WorkerIdsRequest
  | WorkerBcfBuildRequest
  | WorkerBcfParseRequest;

export interface WorkerOkResponse {
  readonly ok: true;
  readonly engine: "ifc";
  readonly engineVersion: string;
  readonly toolchain: { readonly ifctester: string; readonly bcf: string };
}

export interface WorkerPingOk extends WorkerOkResponse {
  // ping carries only the identity fields above
}

export interface WorkerParseOk extends WorkerOkResponse {
  readonly result: Omit<IfcParseResult, "engineVersion">;
}

export interface WorkerBuildOk extends WorkerOkResponse {
  /** Base64 of the deterministic IFC file bytes. */
  readonly ifc: string;
  readonly size: number;
  /** SHA-256 of the IFC bytes (computed in the worker, verified in TS). */
  readonly sha256: string;
}

export interface WorkerIdsOk extends WorkerOkResponse {
  readonly result: IfcIdsResult;
}

export interface WorkerBcfBuildOk extends WorkerOkResponse {
  /** Base64 of the .bcf container bytes. */
  readonly bcf: string;
  readonly size: number;
}

export interface WorkerBcfParseOk extends WorkerOkResponse {
  readonly topics: readonly IfcBcfParsedTopic[];
}

export type WorkerOk =
  | WorkerPingOk
  | WorkerParseOk
  | WorkerBuildOk
  | WorkerIdsOk
  | WorkerBcfBuildOk
  | WorkerBcfParseOk;

export interface WorkerErrResponse {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type WorkerResponse = WorkerOk | WorkerErrResponse;
