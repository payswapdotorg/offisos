/**
 * State machine semantics.
 *
 * governance/workflow-states.json is the canonical lifecycle definition. This
 * module validates the definition itself (integrity, determinism,
 * reachability) and provides transition lookup/authorization used to validate
 * work-item records.
 */
import type { CheckResult, TransitionDef, WorkflowStates } from "./types.js";

export function pass(id: string, description: string): CheckResult {
  return { id, description, status: "pass" };
}

export function fail(id: string, description: string, details: string[]): CheckResult {
  return { id, description, status: "fail", details };
}

export function findTransitionDef(
  machine: WorkflowStates,
  from: string,
  to: string,
): TransitionDef | undefined {
  return machine.transitions.find((t) => t.from === from && t.to === to);
}

/** States in which a work item is considered "in execution" (post-assignment). */
export function executionStates(machine: WorkflowStates): Set<string> {
  const excluded = new Set([machine.initial_state, "READY"]);
  return new Set(Object.keys(machine.states).filter((s) => !excluded.has(s)));
}

/**
 * Validates the state machine definition itself. A flawed definition would
 * silently weaken every downstream rule, so these checks run on every
 * validation invocation.
 */
export function validateStateMachineDefinition(machine: WorkflowStates): CheckResult[] {
  const results: CheckResult[] = [];
  const stateNames = Object.keys(machine.states);

  // Initial state exists.
  results.push(
    machine.initial_state in machine.states
      ? pass("state-machine/initial-state", "Initial state exists in the state list.")
      : fail("state-machine/initial-state", "Initial state is not a defined state.", [
          `initial_state '${machine.initial_state}' is not among states: ${stateNames.join(", ")}.`,
        ]),
  );

  // Transition endpoints reference defined states.
  const badEndpoints: string[] = [];
  for (const t of machine.transitions) {
    if (!(t.from in machine.states)) badEndpoints.push(`transition '${t.from} -> ${t.to}' has undefined from-state '${t.from}'`);
    if (!(t.to in machine.states)) badEndpoints.push(`transition '${t.from} -> ${t.to}' has undefined to-state '${t.to}'`);
  }
  results.push(
    badEndpoints.length === 0
      ? pass("state-machine/transition-endpoints", "All transition endpoints reference defined states.")
      : fail("state-machine/transition-endpoints", "Transitions reference undefined states.", badEndpoints),
  );

  // Determinism: no duplicate (from, to) pairs.
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const t of machine.transitions) {
    const key = `${t.from}->${t.to}`;
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
  }
  results.push(
    duplicates.length === 0
      ? pass("state-machine/determinism", "No duplicate (from, to) transition pairs; authorization is unambiguous.")
      : fail("state-machine/determinism", "Duplicate (from, to) transitions make authorization ambiguous.", duplicates),
  );

  // Every non-terminal state has at least one outgoing transition (no dead ends).
  const deadEnds = stateNames.filter(
    (s) => !machine.states[s]!.terminal && !machine.transitions.some((t) => t.from === s),
  );
  results.push(
    deadEnds.length === 0
      ? pass("state-machine/no-dead-ends", "Every non-terminal state has at least one outgoing transition.")
      : fail("state-machine/no-dead-ends", "Non-terminal states without outgoing transitions would trap work items.", deadEnds.map((s) => `state '${s}' has no outgoing transition but is not terminal.`)),
  );

  // Every state is reachable from the initial state.
  const reachable = new Set<string>([machine.initial_state]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of machine.transitions) {
      if (reachable.has(t.from) && !reachable.has(t.to)) {
        reachable.add(t.to);
        grew = true;
      }
    }
  }
  const unreachable = stateNames.filter((s) => !reachable.has(s));
  results.push(
    unreachable.length === 0
      ? pass("state-machine/reachability", "Every state is reachable from the initial state.")
      : fail("state-machine/reachability", "Some states can never be reached.", unreachable.map((s) => `state '${s}' is unreachable from '${machine.initial_state}'.`)),
  );

  // At least one terminal state exists.
  const terminals = stateNames.filter((s) => machine.states[s]!.terminal);
  results.push(
    terminals.length > 0
      ? pass("state-machine/terminal-states", `Terminal states defined: ${terminals.join(", ")}.`)
      : fail("state-machine/terminal-states", "No terminal state is defined; work items could never complete.", []),
  );

  // Transition actors are declared roles.
  const roleNames = new Set(Object.keys(machine.roles));
  const badActors: string[] = [];
  for (const t of machine.transitions) {
    for (const actor of t.actors) {
      if (!roleNames.has(actor)) badActors.push(`transition '${t.from} -> ${t.to}' authorizes undeclared role '${actor}'.`);
    }
  }
  results.push(
    badActors.length === 0
      ? pass("state-machine/actor-roles", "All transition actors reference declared roles.")
      : fail("state-machine/actor-roles", "Transitions authorize undeclared roles.", badActors),
  );

  // State entry requirements reference defined states.
  const badEntryKeys = Object.keys(machine.state_entry_requirements).filter(
    (k) => !(k in machine.states),
  );
  results.push(
    badEntryKeys.length === 0
      ? pass("state-machine/entry-requirement-states", "All state entry requirements reference defined states.")
      : fail("state-machine/entry-requirement-states", "State entry requirements reference undefined states.", badEntryKeys.map((k) => `entry requirement for unknown state '${k}'.`)),
  );

  return results;
}
