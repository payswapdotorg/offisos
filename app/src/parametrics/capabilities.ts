/**
 * COMPAT-CAD-004 (Issue #121) — the versioned parametrics capability
 * registry (API-001): the closed list of governed App API requests the
 * consolidated parametrics/associative/patterns family covers.
 *
 * The registry is HONEST PROVENANCE, not re-branding: rows with origin
 * "compat-cad-004" are the requests this work item ADDS; rows with origin
 * "verified-baseline" are the pre-existing VERIFIED requests of the
 * constraint (CAD-PARITY-007), block/symbol (CAD-PARITY-006),
 * associative-annotation (CAD-PARITY-005), documentation (COMPAT-CAD-003)
 * and pattern-array (CAD-PARITY-007) surfaces that the family consolidates
 * into one discovery surface. Anything outside the list is the App API's
 * own typed unknown-command/unknown-query decline — never a fabricated
 * semantic.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018).
 */

import type { CommandName, QueryName } from "../contracts/app-api.js";
import type { ParametricCapabilityView } from "../contracts/parametrics.js";
import { PARAMETRICS_API_VERSION } from "../contracts/parametrics.js";

export { PARAMETRICS_API_VERSION } from "../contracts/parametrics.js";

interface ParametricCapabilityDef {
  readonly name: CommandName | QueryName;
  readonly kind: "command" | "query";
  readonly area: "constraints" | "associations" | "symbols" | "patterns";
  readonly summary: string;
  readonly origin: "compat-cad-004" | "verified-baseline";
}

export const PARAMETRIC_CAPABILITIES: readonly ParametricCapabilityDef[] = [
  // --- constraints (the verified CAD-PARITY-007 bounded grammar + solve) ---
  { name: "constraint.create", kind: "command", area: "constraints", origin: "verified-baseline", summary: "Declare ONE geometric/dimensional constraint (id minted upfront; the over-constraint DoF gate; solve + annotation remeasure in ONE atomic revision)." },
  { name: "constraint.update", kind: "command", area: "constraints", origin: "verified-baseline", summary: "Re-declare ONE constraint's value/mode and re-solve (one atomic revision)." },
  { name: "constraint.remove", kind: "command", area: "constraints", origin: "verified-baseline", summary: "Remove ONE constraint (no re-solve — the AutoCAD-class bounded rule)." },
  { name: "constraint.solve", kind: "command", area: "constraints", origin: "verified-baseline", summary: "Solve/diagnose the whole constraint graph and apply the deterministic patches (one atomic revision when anything moves)." },
  { name: "constraints.list", kind: "query", area: "constraints", origin: "verified-baseline", summary: "The constraint inventory with per-record satisfaction status." },
  { name: "constraints.diagnostics", kind: "query", area: "constraints", origin: "verified-baseline", summary: "The full typed constraint diagnostics report (outcome, DoF, violations)." },
  // --- associations (the consolidated associative surface) ---
  { name: "assoc.report", kind: "query", area: "associations", origin: "compat-cad-004", summary: "The consolidated typed associative report: annotations, symbol relationships, xrefs, raster references and docs annotations with ok/dangling/source_loss/missing/stale outcomes (computed fresh, never stored)." },
  { name: "assoc.refresh", kind: "command", area: "associations", origin: "compat-cad-004", summary: "Re-measure every associative annotation AND regenerate the documentation values in ONE atomic revision; dangling references disassociate honestly (never a silent re-target) and every outcome is reported typed." },
  { name: "annotation.remeasure", kind: "command", area: "associations", origin: "verified-baseline", summary: "Re-measure selected/all associative annotations against the current geometry (the verified CAD-PARITY-005 cascade; one atomic revision)." },
  { name: "docs.regenerate", kind: "command", area: "associations", origin: "verified-baseline", summary: "Regenerate the documentation set (view projections + annotation values; one atomic revision — the verified COMPAT-CAD-003 surface)." },
  // --- symbols (the verified CAD-PARITY-006 block/xref surface) ---
  { name: "block.create", kind: "command", area: "symbols", origin: "verified-baseline", summary: "Create ONE block definition from source entities (atomic conversion — the sources are removed into the definition)." },
  { name: "block.insert", kind: "command", area: "symbols", origin: "verified-baseline", summary: "Insert ONE block instance (validated placement + attribute values; document-minted element id)." },
  { name: "block.update", kind: "command", area: "symbols", origin: "verified-baseline", summary: "Update ONE block definition (instances propagate through the definition→instance expansion)." },
  { name: "block.remove", kind: "command", area: "symbols", origin: "verified-baseline", summary: "Remove ONE block definition (reference-checked — never leaves a dangling instance)." },
  { name: "attribute.update", kind: "command", area: "symbols", origin: "verified-baseline", summary: "Update ONE instance attribute value (null = clear to the definition default)." },
  { name: "blocks.list", kind: "query", area: "symbols", origin: "verified-baseline", summary: "The block definition inventory (entity counts, instance counts, attribute tags)." },
  { name: "xrefs.list", kind: "query", area: "symbols", origin: "verified-baseline", summary: "The external-reference inventory (loaded/unresolved status, source hash, instance counts)." },
  // --- patterns (the bounded deterministic pattern operations) ---
  { name: "pattern.mirror", kind: "command", area: "patterns", origin: "compat-cad-004", summary: "Mirror drafting entities AND block instances about a two-point axis in ONE atomic revision: geometry mirrors exactly; symbol instances flip the handedness through the deterministic reflected placement (rotation' = 2φ − θ); xref instances decline typed." },
  { name: "entity.modify", kind: "command", area: "patterns", origin: "verified-baseline", summary: "The verified modify surface — the array arm (rectangular/polar over entities AND symbol instances, document-minted ids, deterministic row-major/polar ordering, ONE atomic revision) and the geometry mirror arm (the CAD-PARITY-007 surface)." },
  // --- discovery ---
  { name: "parametrics.capabilities", kind: "query", area: "constraints", origin: "compat-cad-004", summary: "The versioned typed parametrics capability discovery table (this registry)." },
];

const PARAMETRIC_CAPABILITY_INDEX: ReadonlyMap<string, ParametricCapabilityDef> = new Map(
  PARAMETRIC_CAPABILITIES.map((c) => [c.name, c]),
);

/** The registry lookup (null when the name is not a parametrics capability). */
export function parametricCapabilityOf(name: string): ParametricCapabilityDef | null {
  return PARAMETRIC_CAPABILITY_INDEX.get(name) ?? null;
}

/** The registry view rows (the discovery surface). */
export function parametricCapabilityViews(): readonly ParametricCapabilityView[] {
  return PARAMETRIC_CAPABILITIES.map((c) => ({
    name: c.name,
    kind: c.kind,
    area: c.area,
    summary: c.summary,
    origin: c.origin,
  }));
}
