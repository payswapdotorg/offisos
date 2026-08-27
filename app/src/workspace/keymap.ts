/**
 * CAD-PARITY-002 keyboard map (Issue #75; CAD-UX-002 keyboard-first parity:
 * "keyboard shortcut infrastructure and temporary modifiers").
 *
 * Maps normalized key events to workspace actions. Both hosts feed the same
 * normalized structure, so shortcuts behave identically on Web and Electron.
 * The map is DATA — hosts dispatch actions through the shared command
 * registry (command:*) or local shell handlers (palette/toggle/zoom).
 *
 * Focus zones: while the command line owns focus, only Esc/Enter are mapped
 * (typing goes to the input); the canvas zone maps the full drafting set.
 */

export type KeyFocusZone = "global" | "canvas" | "commandLine";

export type KeyAction =
  | { readonly type: "command"; readonly commandId: string }
  | { readonly type: "toggle"; readonly aid: "osnap" | "grid" | "ortho" | "snap" | "polar" | "otrack" }
  | { readonly type: "palette"; readonly palette: "search" | "help" | "layers" | "properties" | "navigator" | "workspace" }
  | { readonly type: "cancel" }
  | { readonly type: "enter" }
  | { readonly type: "zoomExtents" }
  | { readonly type: "selectionAll" }
  | { readonly type: "fileSave" }
  | { readonly type: "fileNew" };

/** Normalized keyboard event (both hosts translate their native events). */
export interface NormalizedKeyEvent {
  readonly key: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

function isPlain(e: NormalizedKeyEvent): boolean {
  return !e.ctrl && !e.alt && !e.meta;
}

/**
 * Resolve a key event in a focus zone. Returns null when the key is not
 * mapped (the host's default behavior applies).
 */
export function mapKeyEvent(event: NormalizedKeyEvent, zone: KeyFocusZone): KeyAction | null {
  if (zone === "commandLine") {
    if (event.key === "Escape") return { type: "cancel" };
    return null;
  }

  // --- Application-wide chords (both zones) -------------------------------
  if (event.ctrl && !event.alt && !event.meta) {
    switch (event.key.toLowerCase()) {
      case "k":
        return { type: "palette", palette: "search" };
      case "z":
        return event.shift
          ? { type: "command", commandId: "redo" }
          : { type: "command", commandId: "undo" };
      case "y":
        return { type: "command", commandId: "redo" };
      case "s":
        return { type: "fileSave" };
      case "n":
        return { type: "fileNew" };
      case "a":
        return { type: "selectionAll" };
      default:
        return null;
    }
  }

  if (event.meta && !event.ctrl) {
    // macOS-style equivalents.
    switch (event.key.toLowerCase()) {
      case "k":
        return { type: "palette", palette: "search" };
      case "z":
        return event.shift ? { type: "command", commandId: "redo" } : { type: "command", commandId: "undo" };
      case "s":
        return { type: "fileSave" };
      case "a":
        return { type: "selectionAll" };
      default:
        return null;
    }
  }

  // --- Canvas-zone keys (function keys, Esc/Enter, Del) --------------------
  if (zone === "global") {
    // Outside the canvas only the command-lifecycle keys apply.
    if (isPlain(event)) {
      if (event.key === "Escape") return { type: "cancel" };
      if (event.key === "Enter") return { type: "enter" };
    }
    return null;
  }
  if (isPlain(event)) {
    switch (event.key) {
      case "F1":
        return { type: "palette", palette: "help" };
      case "F3":
        return { type: "toggle", aid: "osnap" };
      case "F7":
        return { type: "toggle", aid: "grid" };
      case "F8":
        return { type: "toggle", aid: "ortho" };
      case "F9":
        return { type: "toggle", aid: "snap" };
      case "F10":
        return { type: "toggle", aid: "polar" };
      case "F11":
        return { type: "toggle", aid: "otrack" };
      case "Escape":
        return { type: "cancel" };
      case "Enter":
        return { type: "enter" };
      case "Delete":
        return { type: "command", commandId: "erase" };
      case "e":
        return { type: "command", commandId: "zoomextents" };
      default:
        return null;
    }
  }

  return null;
}

/**
 * Temporary modifier: Shift held while picking in a point step forces the
 * ortho constraint for that pick (AutoCAD-class temporary override). The
 * host merges this into the DraftingAids passed to constrainCursor.
 */
export function temporaryAidOverride(event: { readonly shift: boolean }): { readonly forceOrtho: boolean } {
  return { forceOrtho: event.shift };
}
