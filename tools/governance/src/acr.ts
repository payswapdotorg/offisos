/**
 * Architecture Change Request registry semantics (ARCH-WF-002, Issue #12).
 *
 * governance/acr/*.json is the machine-readable ACR registry. This module
 * enforces the canonical lifecycle:
 *
 *   PROPOSED → ENDORSED (Architect review, verdict "endorsed")
 *            → APPROVED (Product Owner approval)
 *            → IMPLEMENTED (landed via the referenced work item)
 *   REJECTED is terminal (either gate may reject).
 *
 * The gates are role-owned and machine-checkable: only the Architect records
 * review, only the Product Owner records approval, and review must precede
 * approval. An APPROVED version-changing ACR must already have created its new
 * immutable architecture version (spec/architecture-lock.md Section 3).
 *
 * ACR-001 and ACR-002 are legacy markdown ACRs (governance/architecture-changes/)
 * that predate this registry; they remain resolvable historical records and the
 * machine-readable lifecycle starts at ACR-003.
 */
import type {
  AcrRecord,
  ArchitectureVersionsFile,
  CheckResult,
  WorkItemRecord,
} from "./types.js";
import { fail, pass } from "./state-machine.js";
import type { LoadedAcr } from "./loaders.js";

function parseDate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

/** An ACR authorizes routing while APPROVED or IMPLEMENTED. */
export function acrIsActive(a: AcrRecord): boolean {
  return a.status === "APPROVED" || a.status === "IMPLEMENTED";
}

/** Demo fixtures use the reserved ACR-9xx id range; real ACRs never do. */
export function isDemoAcrId(id: string): boolean {
  return /^ACR-9[0-9]{2}$/.test(id);
}

export interface AcrRegistryContext {
  architectureVersions: ArchitectureVersionsFile;
  requirementIds: Set<string>;
  /** All loaded work-item records (demo included) by id. */
  workItems: Map<string, WorkItemRecord>;
}

function reviewCoherence(a: AcrRecord): string[] {
  const details: string[] = [];
  const review = a.review;
  if (review !== undefined) {
    if (review.role !== "architect") {
      details.push(`review was recorded by role '${review.role}'; only the architect may review an ACR.`);
    }
    if (a.requested_at !== undefined && parseDate(review.reviewed_at)! < parseDate(a.requested_at)!) {
      details.push(`review (reviewed_at ${review.reviewed_at}) predates the request (requested_at ${a.requested_at}).`);
    }
  }
  return details;
}

function approvalCoherence(a: AcrRecord): string[] {
  const details: string[] = [];
  const approval = a.approval;
  if (approval !== undefined) {
    if (approval.role !== "product-owner") {
      details.push(`approval was recorded by role '${approval.role}'; only the product-owner may approve an ACR.`);
    }
    if (a.review === undefined) {
      details.push("approval exists without a prior architect review; the Architect endorsement must precede Product Owner approval.");
    } else {
      if (a.review.verdict !== "endorsed") {
        details.push(`approval exists although the architect review verdict is '${a.review.verdict}'.`);
      }
      if (parseDate(approval.approved_at)! < parseDate(a.review.reviewed_at)!) {
        details.push(
          `approval (approved_at ${approval.approved_at}) predates the architect review (reviewed_at ${a.review.reviewed_at}).`,
        );
      }
    }
  }
  return details;
}

function statusCoherence(a: AcrRecord): string[] {
  const details: string[] = [];
  const hasReview = a.review !== undefined;
  const hasApproval = a.approval !== undefined;
  const hasImplementation = a.implementation !== undefined;
  const endorsed = hasReview && a.review!.verdict === "endorsed";
  const approved = hasApproval && a.approval!.decision === "approved";
  const rejectedReview = hasReview && a.review!.verdict === "rejected";
  const rejectedApproval = hasApproval && a.approval!.decision === "rejected";

  switch (a.status) {
    case "PROPOSED":
      if (hasReview) details.push("status PROPOSED but a review is already recorded; advance to ENDORSED or REJECTED.");
      if (hasApproval) details.push("status PROPOSED but an approval is already recorded.");
      if (hasImplementation) details.push("status PROPOSED but an implementation is already recorded.");
      break;
    case "ENDORSED":
      if (!endorsed) details.push("status ENDORSED requires a recorded architect review with verdict 'endorsed'.");
      if (hasApproval) details.push("status ENDORSED but an approval is already recorded; advance to APPROVED or REJECTED.");
      if (hasImplementation) details.push("status ENDORSED but an implementation is already recorded.");
      break;
    case "APPROVED":
      if (!endorsed) details.push("status APPROVED requires a prior architect review with verdict 'endorsed'.");
      if (!approved) details.push("status APPROVED requires a recorded product-owner approval with decision 'approved'.");
      if (hasImplementation) details.push("status APPROVED but an implementation is already recorded; advance to IMPLEMENTED.");
      break;
    case "IMPLEMENTED": {
      if (!endorsed) details.push("status IMPLEMENTED requires a prior architect review with verdict 'endorsed'.");
      if (!approved) details.push("status IMPLEMENTED requires a recorded product-owner approval with decision 'approved'.");
      if (a.implementation === undefined) {
        details.push("status IMPLEMENTED requires an implementation reference (work_item + pr/commit).");
      }
      break;
    }
    case "REJECTED":
      if (!rejectedReview && !rejectedApproval) {
        details.push("status REJECTED requires either a rejected architect review or a rejected product-owner approval.");
      }
      if (hasImplementation) details.push("status REJECTED cannot carry an implementation reference.");
      break;
  }
  return [...details, ...reviewCoherence(a), ...approvalCoherence(a)];
}

/** Version rules: `from` always resolves; `to` resolves (new versions exist once approved). */
function versionCoherence(a: AcrRecord, versions: ArchitectureVersionsFile): string[] {
  const details: string[] = [];
  const known = new Set(versions.versions.map((v) => v.version));
  if (!known.has(a.architecture_version_from)) {
    details.push(`architecture_version_from '${a.architecture_version_from}' is not a registered architecture version.`);
  }
  const sameVersion = a.architecture_version_from === a.architecture_version_to;
  if (sameVersion) {
    if (!known.has(a.architecture_version_to)) {
      details.push(
        `architecture_version_to '${a.architecture_version_to}' is not a registered architecture version (same-version control changes must reference an existing version).`,
      );
    }
  } else if (a.status === "APPROVED" || a.status === "IMPLEMENTED") {
    // An approved version-changing ACR must already have created its immutable version.
    const entry = versions.versions.find((v) => v.version === a.architecture_version_to);
    if (entry === undefined) {
      details.push(
        `architecture_version_to '${a.architecture_version_to}' is not registered although the ACR is ${a.status}; ` +
          "an approved version change creates a new immutable architecture version (spec/architecture-lock.md Section 3).",
      );
    } else if (!(entry.change_requests ?? []).includes(a.id)) {
      details.push(
        `architecture version '${a.architecture_version_to}' does not list '${a.id}' in its change_requests; ` +
          "the version registry entry must bind to the ACR that created it.",
      );
    }
  }
  return details;
}

/** Reference resolution: requirements, work items, authorized paths, demo rules. */
function referenceCoherence(
  a: AcrRecord,
  ctx: AcrRegistryContext,
  legacyAcrIds: Set<string>,
): string[] {
  const details: string[] = [];
  for (const req of a.affected_requirements) {
    if (!ctx.requirementIds.has(req)) {
      details.push(`affected requirement '${req}' does not resolve in the spec requirement registries.`);
    }
  }
  for (const wi of a.affected_work_items) {
    const record = ctx.workItems.get(wi);
    if (record === undefined) {
      details.push(`affected work item '${wi}' does not resolve to a registered work-item record.`);
    } else if (a.demo !== true && record.demo === true) {
      details.push(`real ACR '${a.id}' lists demo fixture '${wi}' as an affected work item.`);
    }
  }
  const seen = new Set<string>();
  for (const p of a.authorized_paths) {
    if (p.trim().length === 0) details.push("authorized_paths contains an empty path.");
    if (p.includes("*")) {
      details.push(`authorized_paths entry '${p}' contains a glob character; routing authorizes exact paths only.`);
    }
    if (seen.has(p)) details.push(`authorized_paths contains duplicate path '${p}'.`);
    seen.add(p);
  }
  if (a.demo === true) {
    if ((a.disclaimer ?? "").trim().length === 0) {
      details.push("demo ACRs must carry a non-empty disclaimer.");
    }
    if (!isDemoAcrId(a.id)) {
      details.push(`demo ACR '${a.id}' must use the reserved ACR-9xx id range.`);
    }
  } else {
    if (isDemoAcrId(a.id)) {
      details.push(`real ACR '${a.id}' must not use the demo-reserved ACR-9xx id range.`);
    }
    if (legacyAcrIds.has(a.id)) {
      details.push(`registry ACR '${a.id}' collides with a legacy markdown ACR in governance/architecture-changes/.`);
    }
  }
  return details;
}

/** IMPLEMENTED status requires a bidirectional link to the implementing work item. */
function implementationCoherence(a: AcrRecord, ctx: AcrRegistryContext): string[] {
  const details: string[] = [];
  const impl = a.implementation;
  if (impl === undefined) return details;
  const record = ctx.workItems.get(impl.work_item);
  if (record === undefined) {
    details.push(`implementation references unknown work item '${impl.work_item}'.`);
    return details;
  }
  if (a.demo !== true && record.demo === true) {
    details.push(`real ACR '${a.id}' claims demo fixture '${impl.work_item}' as its implementation.`);
  }
  if (a.demo === true && record.demo !== true) {
    details.push(`demo ACR '${a.id}' claims real work item '${impl.work_item}' as its implementation.`);
  }
  if (record.acr !== a.id) {
    details.push(
      `implementation references work item '${impl.work_item}', but that record's acr field is '${record.acr ?? "unset"}' (expected '${a.id}'); the link must be bidirectional.`,
    );
  }
  const refs = impl.references ?? {};
  if (refs.pr === undefined && refs.commit === undefined) {
    details.push("implementation must reference the landing PR and/or commit.");
  }
  return details;
}

export interface AcrValidationOutcome {
  checks: CheckResult[];
  /** Non-demo ACR records by id. */
  registry: Map<string, AcrRecord>;
  /** All ACR records (demo included) by id. */
  allRecords: Map<string, AcrRecord>;
}

/**
 * Validates the whole ACR registry: registry-level integrity plus, for every
 * record, lifecycle coherence, ordering, reference resolution, authorized-path
 * integrity, demo marking and implementation linkage.
 *
 * `schemaValidIds` carries the ids of records that already passed JSON-Schema
 * validation (schema failures are reported by the caller); semantic checks for
 * malformed records are skipped defensively.
 */
export function validateAcrRegistry(
  loaded: LoadedAcr[],
  ctx: AcrRegistryContext,
  legacyAcrIds: Set<string>,
): AcrValidationOutcome {
  const checks: CheckResult[] = [];
  const allRecords = new Map<string, AcrRecord>();
  const registry = new Map<string, AcrRecord>();

  const duplicateIds: string[] = [];
  const filenameMismatches: string[] = [];
  for (const { file, record } of loaded) {
    if (allRecords.has(record.id)) duplicateIds.push(record.id);
    allRecords.set(record.id, record);
    if (record.demo !== true) registry.set(record.id, record);
    if (file !== `${record.id}.json`) {
      filenameMismatches.push(`'${file}' contains ACR id '${record.id}'; expected file name '${record.id}.json'.`);
    }
  }
  checks.push(
    duplicateIds.length === 0
      ? pass("acr/registry-unique-ids", "ACR ids are unique across governance/acr/.")
      : fail("acr/registry-unique-ids", "Duplicate ACR ids detected.", duplicateIds),
  );
  checks.push(
    filenameMismatches.length === 0
      ? pass("acr/registry-filename-match", "Every ACR file is named after its id.")
      : fail("acr/registry-filename-match", "ACR file names do not match record ids.", filenameMismatches),
  );

  for (const { record } of loaded) {
    const lifecycleDetails = [
      ...statusCoherence(record),
      ...versionCoherence(record, ctx.architectureVersions),
      ...implementationCoherence(record, ctx),
    ];
    checks.push(
      lifecycleDetails.length === 0
        ? pass(
            `acr/${record.id}/lifecycle`,
            `Lifecycle coherent: ${record.id} is ${record.status}${record.demo === true ? " (demo fixture)" : ""}.`,
          )
        : fail(`acr/${record.id}/lifecycle`, "ACR lifecycle rules violated.", lifecycleDetails),
    );

    const referenceDetails = referenceCoherence(record, ctx, legacyAcrIds);
    checks.push(
      referenceDetails.length === 0
        ? pass(
            `acr/${record.id}/references`,
            `All ${record.affected_requirements.length} requirement(s), ${record.affected_work_items.length} work item(s) and ${record.authorized_paths.length} authorized path(s) resolve; demo marking is correct.`,
          )
        : fail(`acr/${record.id}/references`, "ACR reference rules violated.", referenceDetails),
    );
  }

  return { checks, registry, allRecords };
}

/**
 * Architecture-version registry binding: every change_requests entry must
 * resolve to a JSON registry ACR or a legacy markdown ACR.
 */
export function validateArchitectureVersionAcrBinding(
  versions: ArchitectureVersionsFile,
  registry: Map<string, AcrRecord>,
  legacyAcrIds: Set<string>,
): CheckResult {
  const details: string[] = [];
  for (const version of versions.versions) {
    for (const acrId of version.change_requests ?? []) {
      if (registry.has(acrId)) continue;
      if (legacyAcrIds.has(acrId)) continue;
      details.push(
        `version '${version.version}' lists change request '${acrId}' which resolves neither to governance/acr/ nor to a legacy markdown ACR.`,
      );
    }
  }
  return details.length === 0
    ? pass(
        "architecture-versions/change-request-resolution",
        "Every architecture-version change request resolves to a registry or legacy ACR.",
      )
    : fail("architecture-versions/change-request-resolution", "Architecture-version change requests do not resolve.", details);
}
