/**
 * Type definitions for the Offisos repository governance system.
 *
 * These types mirror governance/schemas/*.json. The JSON Schemas are the
 * canonical, inspectable definitions; these interfaces exist so the validator
 * itself is type-checked.
 */

export interface StateDef {
  description: string;
  terminal: boolean;
}

export interface TransitionDef {
  from: string;
  to: string;
  label?: string;
  actors: string[];
  requires: string[];
  reference_fields?: string[];
}

export interface EvidencePolicy {
  minimum_accepted_evidence: number;
  accepted_types: string[];
  insufficient_types: string[];
  must_be_revision_bound: boolean;
  policy?: string;
}

export interface StateEntryRequirements {
  requires_transition_reference?: string;
  requires_last_decision?: string;
  requires_requirements_resolved?: boolean;
  evidence?: EvidencePolicy;
}

export interface DecisionRules {
  deciding_role: string;
  statuses: string[];
  remediation_required_for: string[];
  reverification_policy?: string;
}

export interface WorkflowStates {
  definition_version: number;
  architecture_version: string;
  source_of_authority: string;
  notes?: string;
  roles: Record<string, string>;
  initial_state: string;
  states: Record<string, StateDef>;
  transitions: TransitionDef[];
  state_entry_requirements: Record<string, StateEntryRequirements>;
  decision_rules: DecisionRules;
}

export interface TransitionReference {
  issue?: number;
  pr?: number;
  assignee?: string;
  commit?: string;
  merge_commit?: string;
  evidence?: string[];
  decision?: string;
  acr?: string;
  artifact?: string;
}

export interface TransitionRecord {
  from: string;
  to: string;
  at: string;
  actor: string;
  role: string;
  reason: string;
  failure_reason?: string;
  references?: TransitionReference;
}

export interface EvidenceReferences {
  pr?: number;
  commit?: string;
  workflow_run?: string;
  artifact_path?: string;
  path?: string;
}

export interface EvidenceRecord {
  id: string;
  type: string;
  description: string;
  produced_at: string;
  reproducible: boolean;
  reproduction?: string;
  references?: EvidenceReferences;
}

export interface DecisionRecord {
  id: string;
  status: string;
  decided_at: string;
  decided_by: string;
  role: string;
  rationale: string;
  evidence_refs?: string[];
  remediation_required?: string;
}

export interface WorkItemRecord {
  id: string;
  demo?: boolean;
  disclaimer?: string;
  title: string;
  issue: number;
  objective: string;
  architecture_version: string;
  requirements: string[];
  dependencies: string[];
  acceptance_criteria: string[];
  non_goals?: string[];
  risk_assumptions?: string[];
  evidence_requirements: string[];
  state: string;
  transitions: TransitionRecord[];
  evidence?: EvidenceRecord[];
  decisions?: DecisionRecord[];
  acr?: string;
}

export interface ArchitectureVersionEntry {
  version: string;
  status: string;
  defined_by: string[];
  declared_in?: string[];
  locked_at?: string;
  protected_paths_manifest?: string;
  /** ACR ids that produced this version; must resolve to registry records or legacy markdown ACRs. */
  change_requests?: string[];
  superseded_by?: string;
}

export interface ArchitectureVersionsFile {
  notes?: string;
  active_version: string;
  versions: ArchitectureVersionEntry[];
}

export interface ProtectedPathPattern {
  pattern: string;
  reason: string;
  /**
   * "allowed" marks registry trees whose additions are the normal flow
   * (e.g. governance/acr/** — proposing a new ACR must not itself require an
   * ACR). Only modifications/deletions/renames of existing paths remain
   * violations for such patterns. Absent (default): additions inside an
   * existing protected tree are violations too (ARCH-WF-002).
   */
  additions?: "allowed";
  /**
   * Registry lifecycle management (ARCH-WF-002 remediation, Issue #12):
   * marks a registry tree whose EXISTING records may only change through
   * their own machine-checkable lifecycle transitions — "acr" for
   * governance/acr/** (PROPOSED → ENDORSED → APPROVED → IMPLEMENTED, or →
   * REJECTED), "reconciliation" for governance/reconciliations/**
   * (STAGED → DECIDED). A modification of an existing record is waived ONLY
   * when it is a narrowly content-checked legal transition (status edge +
   * exactly the gate instruments, each role-correct; see
   * tools/governance/src/registry-lifecycle.ts). Every other modification
   * of an existing record remains a protected-path violation. This breaks
   * the circular authorization (an ACR's own lifecycle advancement can
   * never require another ACR) without making the registries mutable.
   */
  lifecycle?: "acr" | "reconciliation";
}

export interface ProtectedPathsFile {
  notes?: string;
  architecture_version: string;
  patterns: ProtectedPathPattern[];
}

// ---------------------------------------------------------------------------
// Architecture Change Request records (governance/acr/, ARCH-WF-002).
// ---------------------------------------------------------------------------

export type AcrStatus = "PROPOSED" | "ENDORSED" | "APPROVED" | "IMPLEMENTED" | "REJECTED";

export interface AcrReviewRecord {
  reviewed_by: string;
  role: string;
  reviewed_at: string;
  verdict: "endorsed" | "rejected";
  rationale: string;
}

export interface AcrApprovalRecord {
  approved_by: string;
  role: string;
  approved_at: string;
  decision: "approved" | "rejected";
  rationale: string;
}

export interface AcrImplementationRecord {
  work_item: string;
  references?: { pr?: number; commit?: string };
}

export interface AcrRecord {
  id: string;
  demo?: boolean;
  disclaimer?: string;
  title: string;
  status: AcrStatus;
  requested_by: string;
  requested_at: string;
  problem: string;
  evidence: string[];
  impact: string;
  alternatives: string[];
  recommendation: string;
  migration_plan: string;
  compatibility: string;
  security_impact: string;
  affected_requirements: string[];
  affected_work_items: string[];
  architecture_version_from: string;
  architecture_version_to: string;
  authorized_paths: string[];
  review?: AcrReviewRecord;
  approval?: AcrApprovalRecord;
  implementation?: AcrImplementationRecord;
  related_issue?: number;
  provenance?: string;
}

// ---------------------------------------------------------------------------
// Historical reconciliation records (governance/reconciliations/, ARCH-WF-002).
// ---------------------------------------------------------------------------

export type ReconciliationStatus = "STAGED" | "DECIDED";

export type ReconcilableRule = "transition-legality" | "temporal-ordering" | "decisions";

export type ReconcilableViolation =
  | "unauthorized-role"
  | "precedes-previous"
  | "no-prior-approved-decision";

export interface ReconciliationDefectCitation {
  rule: ReconcilableRule;
  violation: ReconcilableViolation;
  transition?: number;
  state_entry?: string;
  original: {
    from: string;
    to: string;
    at: string;
    actor: string;
    role: string;
  };
  explanation: string;
}

export interface ReconciliationRecord {
  id: string;
  work_item: string;
  status: ReconciliationStatus;
  demo?: boolean;
  disclaimer?: string;
  problem: string;
  defects: ReconciliationDefectCitation[];
  evidence?: EvidenceRecord[];
  acr: string;
  decided_by?: string;
  role?: string;
  decided_at?: string;
  rationale?: string;
  remediation?: string;
}

/**
 * A validated DECIDED reconciliation as consumed by the work-item rule engine
 * (ARCH-WF-002). Only these activate waivers, and only for the enumerated
 * violation keys. The type lives here (not in reconciliation.ts) so rules.ts
 * can consume it without an import cycle.
 */
export interface ActiveReconciliation {
  id: string;
  workItem: string;
  acr: string;
  decidedBy: string;
  decidedAt: string;
  waivedKeys: Set<string>;
}

export interface CheckResult {
  id: string;
  description: string;
  status: "pass" | "fail";
  details?: string[];
}

export interface GovernanceReport {
  generated_at: string;
  tool: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
  checks: CheckResult[];
}
