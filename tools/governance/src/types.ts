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
}

export interface ArchitectureVersionsFile {
  notes?: string;
  active_version: string;
  versions: ArchitectureVersionEntry[];
}

export interface ProtectedPathPattern {
  pattern: string;
  reason: string;
}

export interface ProtectedPathsFile {
  notes?: string;
  architecture_version: string;
  patterns: ProtectedPathPattern[];
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
