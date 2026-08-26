/**
 * OCCT BIM semantics adapter (CAD-IMPLEMENT-002 / Issue #26).
 *
 * Implements the frozen `BimEngineAdapter` contract against the OCCT bundle.
 * BIM semantic extraction (IfcOpenShell/IFC) is an explicit non-goal of this
 * work item (Issue #26: "IFC authoring/round-trip implementation (covered by
 * CAD-003 and a later production slice)"), so this sub-adapter is a documented
 * pass-through: semantics live in `element.props.semantics` until the real
 * BIM engine lands behind the same boundary. The engineId/engineVersion
 * provenance tracks the OCCT bundle's kernel so hosts can display it.
 */

import { ADAPTER_BOUNDARY_MARK } from "../../contracts/adapter.js";
import type { BimEngineAdapter } from "../../contracts/adapter.js";
import type { Element } from "../../contracts/caddocument.js";

export interface OcctBimVersionSource {
  /** Live kernel version (shared cell with the geometry adapter). */
  (): string;
}

export function createOcctBimAdapter(versionSource: OcctBimVersionSource): BimEngineAdapter {
  return {
    adapterMark: ADAPTER_BOUNDARY_MARK,
    engineId: "occt",
    get engineVersion(): string {
      return versionSource();
    },
    async extractSemantics(element: Element): Promise<Readonly<Record<string, unknown>>> {
      const sem = (element.props as Record<string, unknown>).semantics;
      return typeof sem === "object" && sem !== null ? (sem as Record<string, unknown>) : {};
    },
  };
}
