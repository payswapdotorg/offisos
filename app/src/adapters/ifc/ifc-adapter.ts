/**
 * IFC interop adapter (COMPAT-IFC-001 / Issue #47).
 *
 * The concrete `IfcInteropAdapter` (contracts/adapter.ts) behind the frozen
 * boundary: every operation spawns a DISPOSABLE Python worker process
 * (worker/ifc-worker.py — the only place IfcOpenShell/IfcTester/bcf-client
 * appear; LOCK-018). The adapter structurally validates the worker's
 * responses before they can reach the App API (CAD-005 §5 discipline).
 */

import { ADAPTER_BOUNDARY_MARK } from "../../contracts/adapter.js";
import type { IfcInteropAdapter } from "../../contracts/adapter.js";
import type {
  IfcBcfParsedTopic,
  IfcBcfTopicRequest,
  IfcBuildRequest,
  IfcBuildResult,
  IfcIdsResult,
  IfcParsedDocumentationRecord,
  IfcParsedToolsetRecord,
  IfcParseResult,
} from "../../contracts/ifc.js";
import { AdapterFailure } from "../../contracts/geometry.js";
import { isToolsetsDomainKind } from "../../ifc/toolsetmap.js";
import { runIfcWorker, type IfcProcessOptions } from "./ifc-process.js";
import type {
  WorkerBcfBuildOk,
  WorkerBcfParseOk,
  WorkerBuildOk,
  WorkerIdsOk,
  WorkerOkResponse,
  WorkerParseOk,
  WorkerResponse,
} from "./ifc-worker-protocol.js";

const ENGINE_ID = "ifc";

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function assertIdentity(response: WorkerOkResponse): void {
  if (response.engine !== ENGINE_ID || typeof response.engineVersion !== "string") {
    throw new AdapterFailure("engine_error", "IFC worker response identity is malformed", false);
  }
}

function assertBase64(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AdapterFailure("engine_error", `IFC worker ${what} is malformed`, false);
  }
  return value;
}

/** CAD-PARITY-018 (Issue #118 criterion 14): map the toolsets groups onto
 *  the worker's GENERIC IfcGroup carrier. The worker's group writer/reader
 *  is generic over {guid, name, identity, fields} records (the P014
 *  design) — the toolsets records ride the same `documentation.groups`
 *  slot AFTER the documentation groups (deterministic order), and the
 *  worker protocol is UNCHANGED. A request without toolsets groups maps to
 *  EXACTLY the pre-P018 worker model (legacy byte-identity). */
function workerBuildModel(request: IfcBuildRequest): IfcBuildRequest {
  const { toolsets, ...rest } = request;
  const toolsetGroups = toolsets?.groups;
  if (toolsetGroups === undefined || toolsetGroups.length === 0) {
    return rest;
  }
  const docsGroups = rest.documentation?.groups ?? [];
  return { ...rest, documentation: { groups: [...docsGroups, ...toolsetGroups] } };
}

/** CAD-PARITY-018 (Issue #118 criterion 14): split the worker's generic
 *  group parse by DomainKind — groups carrying a toolsets DomainKind
 *  become `parsed.toolsets` (structurally validated here, before the App
 *  API), everything else stays `parsed.documentation` with EXACTLY the
 *  pre-P018 semantics (legacy parse results stay shape-identical when the
 *  file carries no toolsets groups). */
function splitToolsetsGroups(result: Omit<IfcParseResult, "engineVersion">): Omit<IfcParseResult, "engineVersion"> {
  const docs = result.documentation;
  if (docs === undefined || docs.records.length === 0) {
    return result;
  }
  const toolsetsRecords: IfcParsedToolsetRecord[] = [];
  const docsRecords: IfcParsedDocumentationRecord[] = [];
  for (const record of docs.records) {
    if (isToolsetsDomainKind(record.identity)) {
      // Structural validation (the adapter discipline: nothing malformed
      // reaches the App API).
      if (
        typeof record.globalId !== "string" ||
        typeof record.name !== "string" ||
        record.identity === null ||
        typeof record.identity["DomainId"] !== "string" ||
        typeof record.identity["DomainKind"] !== "string" ||
        typeof record.fields !== "object" || record.fields === null
      ) {
        throw new AdapterFailure("engine_error", "IFC worker toolsets group record is malformed", false);
      }
      toolsetsRecords.push({
        globalId: record.globalId,
        name: record.name,
        identity: record.identity,
        fields: record.fields,
      });
    } else {
      docsRecords.push(record);
    }
  }
  if (toolsetsRecords.length === 0) {
    return result;
  }
  const { documentation: _original, ...rest } = result;
  return {
    ...rest,
    ...(docsRecords.length > 0 ? { documentation: { records: docsRecords } } : {}),
    toolsets: { records: toolsetsRecords },
  };
}

export interface IfcInteropAdapterOptions extends IfcProcessOptions {}

export function createIfcInteropAdapter(options: IfcInteropAdapterOptions = {}): IfcInteropAdapter {
  return {
    adapterMark: ADAPTER_BOUNDARY_MARK,
    engineId: ENGINE_ID,
    get engineVersion(): string {
      // Version is only knowable after a worker ping; the App API surfaces it
      // through ifc.probe / result payloads instead of this property.
      return "ifcopenshell-0.8.5";
    },
    async probe(): Promise<{ available: boolean; engineVersion: string | null; message: string | null }> {
      try {
        const response = await runIfcWorker({ op: "ping" }, (r) => r as WorkerOkResponse, {
          ...options,
          timeoutMs: options.timeoutMs ?? 30_000,
        });
        assertIdentity(response);
        return { available: true, engineVersion: response.engineVersion, message: null };
      } catch (e) {
        return { available: false, engineVersion: null, message: (e as Error).message };
      }
    },
    async build(request: IfcBuildRequest): Promise<IfcBuildResult> {
      const response = await runIfcWorker({ op: "build", model: workerBuildModel(request) }, (r) => {
        const ok = r as WorkerBuildOk;
        assertIdentity(ok);
        if (typeof ok.ifc !== "string" || !Number.isInteger(ok.size) || ok.size <= 0 || typeof ok.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(ok.sha256)) {
          throw new AdapterFailure("engine_error", "IFC worker build response is malformed", false);
        }
        return ok;
      }, options);
      return {
        ifc: assertBase64(response.ifc, "build payload"),
        size: response.size,
        sha256: response.sha256,
        engineVersion: response.engineVersion,
      };
    },
    async parse(ifc: string): Promise<IfcParseResult> {
      const response = await runIfcWorker({ op: "parse", ifc }, (r) => {
        const ok = r as WorkerParseOk;
        assertIdentity(ok);
        const result = ok.result;
        if (
          typeof result !== "object" || result === null ||
          typeof result.schema !== "string" ||
          !Array.isArray(result.stories) || !Array.isArray(result.elements) ||
          typeof result.relationships !== "object" || result.relationships === null
        ) {
          throw new AdapterFailure("engine_error", "IFC worker parse response is malformed", false);
        }
        for (const story of result.stories) {
          if (typeof story.globalId !== "string" || !isFiniteNumber(story.elevation)) {
            throw new AdapterFailure("engine_error", "IFC worker parse story is malformed", false);
          }
        }
        for (const el of result.elements) {
          if (typeof el.globalId !== "string" || typeof el.ifcClass !== "string") {
            throw new AdapterFailure("engine_error", "IFC worker parse element is malformed", false);
          }
          if (el.profile !== null && (!isFiniteNumber(el.profile.xdim) || !isFiniteNumber(el.profile.ydim) || !isFiniteNumber(el.profile.depth))) {
            throw new AdapterFailure("engine_error", "IFC worker parse profile is malformed", false);
          }
        }
        return ok;
      }, options);
      return { ...splitToolsetsGroups(response.result), engineVersion: response.engineVersion };
    },
    async validateIds(ifc: string, idsXml: string): Promise<IfcIdsResult> {
      const response = await runIfcWorker({ op: "ids", ifc, ids: idsXml }, (r) => {
        const ok = r as WorkerIdsOk;
        assertIdentity(ok);
        if (typeof ok.result !== "object" || ok.result === null || !Array.isArray(ok.result.specs)) {
          throw new AdapterFailure("engine_error", "IFC worker ids response is malformed", false);
        }
        for (const spec of ok.result.specs) {
          if (
            typeof spec.name !== "string" ||
            (spec.status !== "pass" && spec.status !== "fail") ||
            !Array.isArray(spec.applicable) || !Array.isArray(spec.passed) || !Array.isArray(spec.failed)
          ) {
            throw new AdapterFailure("engine_error", "IFC worker ids spec is malformed", false);
          }
        }
        return ok;
      }, options);
      return response.result;
    },
    async buildBcf(topics: readonly IfcBcfTopicRequest[]): Promise<{ bcf: string; size: number }> {
      const response = await runIfcWorker({ op: "bcf_build", topics: [...topics] }, (r) => {
        const ok = r as WorkerBcfBuildOk;
        assertIdentity(ok);
        if (typeof ok.bcf !== "string" || !Number.isInteger(ok.size) || ok.size <= 0) {
          throw new AdapterFailure("engine_error", "IFC worker bcf_build response is malformed", false);
        }
        return ok;
      }, options);
      return { bcf: assertBase64(response.bcf, "bcf payload"), size: response.size };
    },
    async parseBcf(bcf: string): Promise<{ topics: readonly IfcBcfParsedTopic[] }> {
      const response = await runIfcWorker({ op: "bcf_parse", bcf }, (r) => {
        const ok = r as WorkerBcfParseOk;
        assertIdentity(ok);
        if (!Array.isArray(ok.topics)) {
          throw new AdapterFailure("engine_error", "IFC worker bcf_parse response is malformed", false);
        }
        // CAD-PARITY-014 (D3): the viewpoint + lineage fields are part of
        // the response contract — structural validation before the App API.
        for (const topic of ok.topics) {
          if (typeof topic !== "object" || topic === null) {
            throw new AdapterFailure("engine_error", "IFC worker bcf_parse topic is malformed", false);
          }
          if (topic.viewpoint !== null && typeof topic.viewpoint !== "object") {
            throw new AdapterFailure("engine_error", "IFC worker bcf_parse topic viewpoint is malformed", false);
          }
          if (topic.viewpoint !== null) {
            const vp = topic.viewpoint as Record<string, unknown>;
            for (const key of ["cameraViewPoint", "cameraDirection", "cameraUpVector"] as const) {
              const vec = vp[key];
              if (!Array.isArray(vec) || vec.length !== 3 || !vec.every((x) => isFiniteNumber(x))) {
                throw new AdapterFailure("engine_error", `IFC worker bcf_parse viewpoint.${key} is malformed`, false);
              }
            }
            if (typeof vp.orthogonal !== "boolean" || (vp.viewToWorldScale !== null && !isFiniteNumber(vp.viewToWorldScale))) {
              throw new AdapterFailure("engine_error", "IFC worker bcf_parse viewpoint camera kind is malformed", false);
            }
          }
          if (topic.sourceRevision !== null && typeof topic.sourceRevision !== "string") {
            throw new AdapterFailure("engine_error", "IFC worker bcf_parse topic sourceRevision is malformed", false);
          }
        }
        return ok;
      }, options);
      return { topics: response.topics };
    },
  };
}
