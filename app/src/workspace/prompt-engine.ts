/**
 * CAD-PARITY-002 prompt engine — the deterministic command-interaction
 * state machine (Issue #75; CAD-P-002 "command line and prompt state").
 *
 * A pure reducer: applyPromptEvent(state, event, ctx) → { state, output }.
 * The same event sequence always produces the same prompt texts, echo lines
 * and CommandPlans on every host (Web/Electron parity acceptance
 * criterion). The engine NEVER mutates state itself: completed commands
 * emit App API command plans that the host executes through its transport
 * (§5.3 — the only mutating path).
 *
 * Interaction model (AutoCAD-class familiarity):
 *  - commands start from any surface (ribbon/menu/palette/shortcut) or by
 *    typing a name/alias at the command line;
 *  - steps collect typed input (coordinate syntax, numbers, text, options)
 *    or picks (points with snap applied by the host, entity hits);
 *  - Enter finishes optional steps / accepts defaults / repeats the last
 *    command when idle;
 *  - Esc cancels the running command ("*Cancel*") or clears the selection;
 *  - LINE chains segments (Undo option removes the last segment through
 *    document.undo); POLYLINE collects vertices until Enter (Close option).
 *
 * Host-local aids (ortho/polar/tracking) constrain the CURSOR before the
 * pick reaches this engine (feedback.ts) — the engine stays pure.
 */

import type { Vec2 } from "../drafting/precision.js";
import { commandById, resolveCommand, type WorkspaceCommand } from "./commands.js";
import { resolveTypedDistance, resolveTypedPoint } from "./typed-input.js";
import type {
  CommandContext,
  CommandPlan,
  EntityPick,
  PromptStep,
  PromptValue,
} from "./types.js";

// ---------------------------------------------------------------------------
// State + events.
// ---------------------------------------------------------------------------

export interface PromptEngineState {
  readonly commandId: string | null;
  readonly stepIndex: number;
  readonly values: Readonly<Record<string, PromptValue>>;
  /** Last collected point (relative input base / direct-distance base). */
  readonly lastPoint: Vec2 | null;
  /** Last STARTED command — Enter repeats it when idle. */
  readonly lastCommandId: string | null;
  /** LINE chain: from-points of the created segments (for the Undo option). */
  readonly chainStack: readonly Vec2[];
}

export const IDLE_PROMPT_STATE: PromptEngineState = {
  commandId: null,
  stepIndex: 0,
  values: {},
  lastPoint: null,
  lastCommandId: null,
  chainStack: [],
};

export type PromptEvent =
  | { readonly type: "start"; readonly commandId: string }
  | { readonly type: "typed"; readonly text: string; readonly cursor?: Vec2 | null }
  | { readonly type: "pick"; readonly point: Vec2 }
  | { readonly type: "entity"; readonly entity: EntityPick }
  | { readonly type: "enter" }
  | { readonly type: "cancel" };

export interface PromptEngineOutput {
  /** Echo lines for the command-line history (this event only). */
  readonly lines: readonly string[];
  /** The prompt to display now (null when idle). */
  readonly prompt: string | null;
  /** Display name of the running command (null when idle). */
  readonly commandName: string | null;
  /** Semantic plan emitted by this event (execute through the App API). */
  readonly plan: CommandPlan | null;
}

export interface PromptEngineResult {
  readonly state: PromptEngineState;
  readonly output: PromptEngineOutput;
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function command(state: PromptEngineState): WorkspaceCommand | null {
  return state.commandId === null ? null : commandById(state.commandId);
}

function currentStep(state: PromptEngineState): PromptStep | null {
  const cmd = command(state);
  if (cmd === null) return null;
  return cmd.steps[state.stepIndex] ?? null;
}

function promptFor(state: PromptEngineState): string | null {
  const step = currentStep(state);
  return step === null ? null : step.prompt;
}

function idleOutput(lines: readonly string[]): PromptEngineOutput {
  return { lines, prompt: null, commandName: null, plan: null };
}

function activeOutput(
  state: PromptEngineState,
  lines: readonly string[],
  plan: CommandPlan | null = null,
): PromptEngineOutput {
  const cmd = command(state);
  return {
    lines,
    prompt: promptFor(state),
    commandName: cmd === null ? null : cmd.name,
    plan,
  };
}

function fmt(p: Vec2): string {
  const n = (x: number) => (Number.isInteger(x) ? String(x) : String(Number(x.toFixed(3))));
  return `${n(p[0])},${n(p[1])}`;
}

/** Base point for relative/direct-distance input of the CURRENT step. */
function stepBase(state: PromptEngineState): Vec2 | null {
  const step = currentStep(state);
  if (step !== null && step.baseStep !== undefined) {
    const v = state.values[step.baseStep];
    if (v !== undefined && v.kind === "point") return v.point;
  }
  return state.lastPoint;
}

function startCommand(state: PromptEngineState, cmd: WorkspaceCommand, ctx: CommandContext): PromptEngineResult {
  if (cmd.instant !== undefined) {
    // Instant commands: emit the plan and stay idle.
    const plan = cmd.instant(ctx);
    return {
      state: { ...IDLE_PROMPT_STATE, lastCommandId: cmd.id },
      output: { lines: [cmd.name, ...plan.echo], prompt: null, commandName: null, plan },
    };
  }
  if (cmd.steps.length === 0) {
    return {
      state,
      output: idleOutput([`${cmd.name}: no interactive steps defined — nothing to do.`]),
    };
  }
  // Fast-fail guard: BIM authoring commands without an active story.
  if (cmd.id === "wall" || cmd.id === "slab") {
    if (ctx.activeStoryId === null) {
      return {
        state,
        output: idleOutput([
          `${cmd.name} requires an active story — create one with STORY or select it in the Navigator.`,
        ]),
      };
    }
  }
  const next: PromptEngineState = {
    ...IDLE_PROMPT_STATE,
    commandId: cmd.id,
    lastCommandId: cmd.id,
    stepIndex: 0,
    values: {},
  };
  return { state: next, output: activeOutput(next, [cmd.name]) };
}

/** Collect one value into the state and advance/complete the command. */
function collectValue(
  state: PromptEngineState,
  cmd: WorkspaceCommand,
  value: PromptValue,
  echo: readonly string[],
  ctx: CommandContext,
): PromptEngineResult {
  const step = currentStep(state);
  if (step === null) return { state, output: activeOutput(state, echo) };

  let values: Record<string, PromptValue> = { ...state.values };
  let lastPoint = state.lastPoint;
  let chainStack = state.chainStack;

  if (step.multiple === true) {
    if (value.kind === "point") {
      const existing = values[step.id];
      const points = existing !== undefined && existing.kind === "points" ? [...existing.points] : [];
      points.push(value.point);
      values[step.id] = { kind: "points", points };
      lastPoint = value.point;
    } else if (value.kind === "entities") {
      const existing = values[step.id];
      const entities = existing !== undefined && existing.kind === "entities" ? [...existing.entities] : [];
      entities.push(...value.entities);
      values[step.id] = { kind: "entities", entities };
    } else {
      values[step.id] = value;
    }
  } else {
    values[step.id] = value;
    if (value.kind === "point") lastPoint = value.point;
  }

  // LINE chaining: completing the final step of a chained command emits a
  // plan and re-prompts the final step with the carried base.
  const isLastStep = state.stepIndex === cmd.steps.length - 1;
  if (isLastStep && (cmd.chained === true || step.multiple === true)) {
    if (cmd.chained === true) {
      // Chained point command (LINE): emit one plan per collected point.
      if (value.kind !== "point") {
        return { state, output: activeOutput(state, [...echo, "*Invalid input for a chained point step.*"]) };
      }
      let plan: CommandPlan;
      try {
        plan = cmd.build!(values, ctx);
      } catch (e) {
        // Validation failure cancels the command with an actionable message.
        return { state: { ...IDLE_PROMPT_STATE, lastCommandId: cmd.id }, output: idleOutput([...echo, (e as Error).message]) };
      }
      const prevFrom = state.values.from !== undefined && state.values.from.kind === "point" ? (state.values.from as { kind: "point"; point: Vec2 }).point : null;
      chainStack = prevFrom === null ? chainStack : [...chainStack, prevFrom];
      // Carry the just-collected point as the new chain base.
      const carry: Record<string, PromptValue> = { from: value };
      const next: PromptEngineState = {
        ...state,
        values: carry,
        lastPoint: value.point,
        chainStack,
        stepIndex: cmd.steps.length - 1,
      };
      return { state: next, output: activeOutput(next, [...echo, ...plan.echo], plan) };
    }
    // Multiple non-chained step (POLYLINE vertices, object picks): stay on
    // the same step collecting more input.
    const next: PromptEngineState = { ...state, values, lastPoint };
    return { state: next, output: activeOutput(next, echo) };
  }

  if (isLastStep) {
    return completeCommand({ ...state, values, lastPoint, chainStack }, cmd, echo, ctx);
  }

  const next: PromptEngineState = { ...state, values, lastPoint, chainStack, stepIndex: state.stepIndex + 1 };
  return { state: next, output: activeOutput(next, echo) };
}

function completeCommand(
  state: PromptEngineState,
  cmd: WorkspaceCommand,
  echo: readonly string[],
  ctx: CommandContext,
): PromptEngineResult {
  let plan: CommandPlan;
  try {
    plan = cmd.build!(state.values, ctx);
  } catch (e) {
    return {
      state: { ...IDLE_PROMPT_STATE, lastCommandId: cmd.id },
      output: idleOutput([...echo, (e as Error).message]),
    };
  }
  const next: PromptEngineState = { ...IDLE_PROMPT_STATE, lastCommandId: cmd.id };
  return { state: next, output: { lines: [...echo, ...plan.echo], prompt: null, commandName: null, plan } };
}

function applyOptionKeyword(
  state: PromptEngineState,
  cmd: WorkspaceCommand,
  keyword: string,
  ctx: CommandContext,
): PromptEngineResult | null {
  const step = currentStep(state);
  if (step === null || step.options === undefined) return null;
  const option = step.options.find((o) => o.keyword.toUpperCase() === keyword.toUpperCase());
  if (option === undefined) return null;

  if (cmd.id === "line" && option.keyword === "U") {
    // Undo the last chained segment through the document's own undo.
    if (state.chainStack.length === 0) {
      return { state, output: activeOutput(state, ["Undo: nothing to undo in this LINE run."]) };
    }
    const previous = state.chainStack[state.chainStack.length - 1]!;
    const chainStack = state.chainStack.slice(0, -1);
    const next: PromptEngineState = {
      ...state,
      chainStack,
      values: { from: { kind: "point", point: previous } },
      lastPoint: previous,
    };
    return {
      state: next,
      output: activeOutput(next, ["Undo one segment."], { appApi: [{ name: "document.undo", payload: {} }], ui: [], echo: [] }),
    };
  }

  if (cmd.id === "polyline" && option.keyword === "C") {
    const closed: PromptValue = { kind: "text", text: "C" };
    const values = { ...state.values, closed };
    return completeCommand({ ...state, values }, cmd, ["Close."], ctx);
  }

  return { state, output: activeOutput(state, [`Option ${option.label} is not available in this state.`]) };
}

// ---------------------------------------------------------------------------
// The reducer.
// ---------------------------------------------------------------------------

export function applyPromptEvent(
  state: PromptEngineState,
  event: PromptEvent,
  ctx: CommandContext,
): PromptEngineResult {
  const cmd = command(state);

  switch (event.type) {
    case "start": {
      const target = commandById(event.commandId);
      if (target === null) {
        return { state, output: idleOutput([`Unknown command '${event.commandId}'.`]) };
      }
      if (cmd !== null) {
        const started = startCommand({ ...IDLE_PROMPT_STATE, lastCommandId: state.lastCommandId }, target, ctx);
        return { state: started.state, output: { ...started.output, lines: ["*Cancel*", ...started.output.lines] } };
      }
      return startCommand(state, target, ctx);
    }

    case "cancel": {
      if (cmd === null) {
        return { state, output: idleOutput(["*Cancel*"]) };
      }
      return { state: { ...IDLE_PROMPT_STATE, lastCommandId: state.lastCommandId }, output: idleOutput(["*Cancel*"]) };
    }

    case "enter": {
      if (cmd === null) {
        // Enter repeats the last command (AutoCAD-class behavior).
        if (state.lastCommandId === null) {
          return { state, output: idleOutput([]) };
        }
        const target = commandById(state.lastCommandId);
        if (target === null) return { state, output: idleOutput([]) };
        const started = startCommand({ ...state, commandId: null }, target, ctx);
        return started;
      }
      const step = currentStep(state);
      if (step === null) return { state, output: activeOutput(state, []) };

      // Option-free Enter on an optional multiple step: finish collection.
      if (step.optional === true && (step.multiple === true || step.kind === "entity")) {
        if (step.kind === "entity") {
          const existing = state.values[step.id];
          const picked = existing !== undefined && existing.kind === "entities" ? existing.entities : [];
          if (picked.length === 0) {
            if (ctx.currentSelection.length > 0) {
              // Use the current (pre)selection — professional behavior.
              const picked: PromptValue = { kind: "entities", entities: [...ctx.currentSelection] };
              const values = { ...state.values, [step.id]: picked };
              const withSelection: PromptEngineState = { ...state, values };
              const isLast = state.stepIndex === cmd.steps.length - 1;
              if (isLast) return completeCommand(withSelection, cmd, [`${ctx.currentSelection.length} found (current selection).`], ctx);
              const next: PromptEngineState = { ...withSelection, stepIndex: state.stepIndex + 1 };
              return { state: next, output: activeOutput(next, [`${ctx.currentSelection.length} found (current selection).`]) };
            }
            return { state, output: activeOutput(state, ["No objects selected — pick objects first."]) };
          }
          const min = step.minInputs ?? 1;
          if (picked.length < min) {
            return { state, output: activeOutput(state, [`Need at least ${min} object(s) — ${picked.length} selected.`]) };
          }
          const isLast = state.stepIndex === cmd.steps.length - 1;
          if (isLast) return completeCommand(state, cmd, [], ctx);
          const next: PromptEngineState = { ...state, stepIndex: state.stepIndex + 1 };
          return { state: next, output: activeOutput(next, []) };
        }
        // Optional multiple POINT step (POLYLINE vertices): finish.
        const existing = state.values[step.id];
        const points = existing !== undefined && existing.kind === "points" ? existing.points : [];
        const min = step.minInputs ?? 1;
        if (points.length < min) {
          return { state, output: activeOutput(state, [`Need at least ${min} more point(s) — press Esc to cancel.`]) };
        }
        return completeCommand(state, cmd, [], ctx);
      }

      // Enter accepts a declared default (number/text steps).
      if (step.defaultValue !== undefined) {
        const v: PromptValue =
          typeof step.defaultValue === "number"
            ? { kind: "number", value: step.defaultValue }
            : { kind: "text", text: step.defaultValue };
        return collectValue(state, cmd, v, [`<${String(step.defaultValue)}>`], ctx);
      }

      // Enter on a chained final point step ends the command.
      if (cmd.chained === true && state.stepIndex === cmd.steps.length - 1) {
        return { state: { ...IDLE_PROMPT_STATE, lastCommandId: cmd.id }, output: idleOutput([`${cmd.name} finished.`]) };
      }

      return {
        state,
        output: activeOutput(state, [`This step requires a ${step.kind} — Esc cancels.`]),
      };
    }

    case "pick": {
      if (cmd === null) return { state, output: idleOutput([]) };
      const step = currentStep(state);
      if (step === null) return { state, output: activeOutput(state, []) };
      if (step.kind === "point") {
        return collectValue(state, cmd, { kind: "point", point: event.point }, [`(${fmt(event.point)})`], ctx);
      }
      if (step.kind === "distance") {
        const base = stepBase(state);
        if (base === null) {
          return { state, output: activeOutput(state, ["Pick distance needs a base point — type a number instead."]) };
        }
        const d = Math.hypot(event.point[0] - base[0], event.point[1] - base[1]);
        if (!(d > 0)) {
          return { state, output: activeOutput(state, ["Distance must be positive — pick away from the base point."]) };
        }
        return collectValue(state, cmd, { kind: "distance", distance: d }, [`(${fmt(event.point)}) → distance ${fmt([d, 0]).split(",")[0]}`], ctx);
      }
      if (step.kind === "displacement") {
        const base = stepBase(state);
        if (base === null) {
          return { state, output: activeOutput(state, ["Displacement needs a base point."]) };
        }
        const vector: Vec2 = [event.point[0] - base[0], event.point[1] - base[1]];
        return collectValue(state, cmd, { kind: "displacement", vector }, [`displacement (${fmt(vector)})`], ctx);
      }
      return { state, output: activeOutput(state, ["This step does not accept a point pick."]) };
    }

    case "entity": {
      if (cmd === null) return { state, output: idleOutput([]) };
      const step = currentStep(state);
      if (step === null || step.kind !== "entity") {
        return { state, output: activeOutput(state, ["This step does not accept an object pick."]) };
      }
      if (step.validate !== undefined) {
        const rejection = step.validate(event.entity);
        if (rejection !== null) {
          return { state, output: activeOutput(state, [rejection]) };
        }
      }
      return collectValue(state, cmd, { kind: "entities", entities: [event.entity] }, [`1 found (${event.entity.id})`], ctx);
    }

    case "typed": {
      const text = event.text.trim();
      if (text.length === 0) {
        return applyPromptEvent(state, { type: "enter" }, ctx);
      }

      if (cmd === null) {
        const target = resolveCommand(text);
        if (target === null) {
          return { state, output: idleOutput([`Unknown command '${text.toUpperCase()}'. Press F1 or Ctrl+K for the command search.`]) };
        }
        return startCommand(state, target, ctx);
      }

      // Step option keyword? (options win over command switching — "U" is
      // LINE's Undo and "C" is POLYLINE's Close while those steps run)
      const optioned = applyOptionKeyword(state, cmd, text, ctx);
      if (optioned !== null) return optioned;

      // A command token typed while a command runs starts the new command
      // (canceling the current one) — except inside text steps, where the
      // token is legitimate input (e.g. a story named "Wall").
      const runningStep = currentStep(state);
      if (runningStep !== null && runningStep.kind !== "text") {
        const switchTarget = resolveCommand(text);
        if (switchTarget !== null) {
          const started = startCommand({ ...IDLE_PROMPT_STATE, lastCommandId: state.lastCommandId }, switchTarget, ctx);
          return { state: started.state, output: { ...started.output, lines: ["*Cancel*", ...started.output.lines] } };
        }
      }

      const step = currentStep(state);
      if (step === null) return { state, output: activeOutput(state, []) };

      switch (step.kind) {
        case "point": {
          const resolution = resolveTypedPoint(text, stepBase(state), event.cursor ?? null);
          if (!resolution.ok) return { state, output: activeOutput(state, [resolution.reason]) };
          return collectValue(state, cmd, { kind: "point", point: resolution.point }, [`${text} → (${fmt(resolution.point)})`], ctx);
        }
        case "distance": {
          const resolution = resolveTypedDistance(text, stepBase(state), event.cursor ?? null);
          if (!resolution.ok) return { state, output: activeOutput(state, [resolution.reason]) };
          // resolveTypedDistance returns the distance encoded as [d, 0].
          const distance = resolution.point[0];
          if (!(distance > 0)) return { state, output: activeOutput(state, ["Distance must be positive."]) };
          return collectValue(state, cmd, { kind: "distance", distance }, [`${text} → distance ${distance}`], ctx);
        }
        case "number": {
          const n = Number(text);
          if (!Number.isFinite(n)) {
            return { state, output: activeOutput(state, [`'${text}' is not a number.`]) };
          }
          return collectValue(state, cmd, { kind: "number", value: n }, [text], ctx);
        }
        case "text": {
          return collectValue(state, cmd, { kind: "text", text }, [text], ctx);
        }
        case "entity": {
          if (text.toUpperCase() === "P") {
            if (ctx.currentSelection.length === 0) {
              return { state, output: activeOutput(state, ["No previous selection — pick objects or type P with a selection active."]) };
            }
            return collectValue(
              state,
              cmd,
              { kind: "entities", entities: [...ctx.currentSelection] },
              [`${ctx.currentSelection.length} found (previous selection)`],
              ctx,
            );
          }
          return { state, output: activeOutput(state, [`'${text}' is not an object — pick in the canvas or type P for the previous selection.`]) };
        }
        case "displacement": {
          const resolution = resolveTypedPoint(text, null, event.cursor ?? null);
          if (resolution.ok) {
            // Typed "dx,dy" / "dist<angle" IS the displacement.
            const vector: Vec2 = resolution.point;
            return collectValue(state, cmd, { kind: "displacement", vector }, [`displacement (${fmt(vector)})`], ctx);
          }
          const n = Number(text);
          if (Number.isFinite(n)) {
            return { state, output: activeOutput(state, ["Displacement needs a direction — type 'dx,dy' or pick a point."]) };
          }
          return { state, output: activeOutput(state, [resolution.reason]) };
        }
      }
      return { state, output: activeOutput(state, []) };
    }
  }
}

// ---------------------------------------------------------------------------
// Script harness — deterministic command scripts (tests + host smokes).
// ---------------------------------------------------------------------------

export interface CommandScriptStep {
  readonly event: PromptEvent;
  /** Human-readable description of the step (evidence + debugging). */
  readonly note?: string;
}

/**
 * Apply a sequence of input events, invoking `execute` for every emitted
 * CommandPlan (the host executes the plan through its transport). Returns
 * the final state and every echo line produced — the deterministic record
 * of the interaction. Used by the app tests AND both host workflow smokes
 * to prove Web/Electron semantic parity (same script → same plans → same
 * document state).
 */
export function runCommandScript(
  steps: readonly CommandScriptStep[],
  ctx: CommandContext,
  execute: (plan: CommandPlan) => void,
  initial: PromptEngineState = IDLE_PROMPT_STATE,
): { readonly state: PromptEngineState; readonly lines: readonly string[] } {
  let state = initial;
  const lines: string[] = [];
  for (const step of steps) {
    const result = applyPromptEvent(state, step.event, ctx);
    state = result.state;
    lines.push(...result.output.lines);
    if (result.output.plan !== null) execute(result.output.plan);
  }
  return { state, lines };
}
