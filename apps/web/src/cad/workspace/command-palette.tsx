"use client";

/**
 * CAD-PARITY-002 command palette / command search (Web host) — Ctrl+K
 * fuzzy search over EVERY workspace command by name, alias or description
 * (CAD-P-002 "command search/command palette"). Deterministic ranking from
 * the shared registry; keyboard-navigable (a11y: role=dialog + labels).
 */

import * as React from "react";
import { Search } from "lucide-react";
import { searchCommands, type WorkspaceCommand } from "@offisos/cad-app-shell/workspace/commands";

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onRun: (command: WorkspaceCommand) => void;
}

export function CommandPalette(props: CommandPaletteProps): React.JSX.Element | null {
  const [query, setQuery] = React.useState("");
  const [index, setIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const hits = React.useMemo(() => searchCommands(query).slice(0, 40), [query]);

  React.useEffect(() => {
    if (props.open) {
      const t = setTimeout(() => {
        setQuery("");
        setIndex(0);
        inputRef.current?.focus();
      }, 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [props.open]);

  if (!props.open) return null;

  const run = (command: WorkspaceCommand) => {
    props.onRun(command);
    props.onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command search"
      onClick={props.onClose}
      data-testid="command-palette"
    >
      <div
        className="w-[min(560px,92vw)] overflow-hidden rounded-lg border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            className="w-full bg-transparent text-sm outline-none"
            placeholder="Search commands by name, alias or description…"
            aria-label="command search input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                props.onClose();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(hits.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const hit = hits[index];
                if (hit !== undefined) run(hit.command);
              }
            }}
          />
          <kbd className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">Esc</kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto py-1" role="listbox" aria-label="command results">
          {hits.length === 0 && (
            <li className="px-4 py-3 text-sm text-muted-foreground">No command matches “{query}”.</li>
          )}
          {hits.map((hit, i) => (
            <li key={hit.command.id} role="option" aria-selected={i === index}>
              <button
                type="button"
                className={
                  "flex w-full items-baseline gap-2 px-4 py-1.5 text-left text-sm " +
                  (i === index ? "bg-muted" : "hover:bg-muted/60")
                }
                onMouseEnter={() => setIndex(i)}
                onClick={() => run(hit.command)}
              >
                <span className="font-mono font-semibold">{hit.command.name}</span>
                <span className="text-xs text-muted-foreground">
                  {hit.command.aliases.filter((a) => a !== hit.command.name).join(", ")}
                </span>
                <span className="ml-auto truncate text-xs text-muted-foreground">{hit.command.description}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
