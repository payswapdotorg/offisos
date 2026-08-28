/**
 * CAD-PARITY-002 shared workspace core — public surface (Issue #75).
 *
 * Both hosts import from here (`@offisos/cad-app-shell/workspace`). The
 * module is engine-free and host-free (LOCK-003/018 — enforced by the
 * forbidden-import scan) and deterministic end to end.
 */

export * from "./types.js";
export {
  WORKSPACE_COMMANDS,
  WORKSPACE_COMMAND_INDEX,
  resolveCommand,
  commandById,
  searchCommands,
  isDraftingPick,
  isBimPick,
  projectOnWall,
  type WorkspaceCommand,
  type CommandSearchHit,
} from "./commands.js";
export {
  IDLE_PROMPT_STATE,
  applyPromptEvent,
  describePrompt,
  runCommandScript,
  type PromptEngineState,
  type PromptEvent,
  type PromptEngineOutput,
  type PromptEngineResult,
  type CommandScriptStep,
} from "./prompt-engine.js";
export {
  hitTest,
  pickAt,
  cyclePick,
  applyPickModifier,
  selectionRectangle,
  windowSelect,
  type PickCandidate,
  type PickModifier,
  type SelectionRectangle,
} from "./selection.js";
export {
  gripsFor,
  gripDrag,
  type GripHandle,
  type GripEditResult,
} from "./grips.js";
export {
  DEFAULT_DRAFTING_AIDS,
  DEFAULT_COORDINATE_FORMAT,
  constrainCursor,
  formatCoordinate,
  rubberInfo,
  type DraftingAids,
  type CursorFeedback,
  type CoordinateFormat,
  type RubberInfo,
} from "./feedback.js";
export {
  mapKeyEvent,
  temporaryAidOverride,
  type KeyAction,
  type KeyFocusZone,
  type NormalizedKeyEvent,
} from "./keymap.js";
export { classifyTypedInput, resolveTypedPoint, resolveTypedDistance, type TypedInput } from "./typed-input.js";
