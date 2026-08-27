"use client";

/**
 * CAD-PARITY-002 command line (Web host) — the AutoCAD-class prompt/
 * entry surface (CAD-P-002). Input is dispatched to the shared prompt
 * engine verbatim; the history shows every echo line; the active prompt is
 * always visible. Up/Down walks the typed history.
 */

import * as React from "react";
import { ChevronRight } from "lucide-react";

export interface CommandLineProps {
  readonly history: readonly string[];
  readonly prompt: string | null;
  readonly commandName: string | null;
  readonly onSubmit: (text: string) => void;
  readonly onCancel: () => void;
}

export function CommandLine(props: CommandLineProps): React.JSX.Element {
  const [value, setValue] = React.useState("");
  const [historyIndex, setHistoryIndex] = React.useState(-1);
  const [typedHistory, setTypedHistory] = React.useState<string[]>([]);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [props.history, props.prompt]);

  const submit = () => {
    const text = value.trim();
    if (text.length === 0) {
      props.onSubmit("");
      return;
    }
    setTypedHistory((h) => [...h, text]);
    setHistoryIndex(-1);
    setValue("");
    props.onSubmit(text);
  };

  return (
    <div className="flex min-h-[92px] flex-col border-t bg-background" data-testid="command-line">
      <div
        ref={scrollRef}
        className="max-h-28 flex-1 overflow-y-auto px-3 py-1 font-mono text-xs leading-5 text-muted-foreground"
        aria-live="polite"
        aria-label="command history"
        data-testid="command-history"
      >
        {props.history.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap">{line}</div>
        ))}
        {props.prompt !== null && (
          <div className="font-semibold text-foreground">
            {props.commandName !== null ? `${props.commandName}: ` : ""}
            {props.prompt}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 border-t px-2 py-1">
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          className="w-full bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground/70"
          placeholder={props.prompt ?? "Type a command or alias (L, C, WA, ST…) — Ctrl+K searches"}
          aria-label="command input"
          data-testid="command-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setValue("");
              props.onCancel();
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              if (typedHistory.length === 0) return;
              const next = historyIndex === -1 ? typedHistory.length - 1 : Math.max(0, historyIndex - 1);
              setHistoryIndex(next);
              setValue(typedHistory[next] ?? "");
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              if (historyIndex === -1) return;
              const next = historyIndex + 1;
              if (next >= typedHistory.length) {
                setHistoryIndex(-1);
                setValue("");
              } else {
                setHistoryIndex(next);
                setValue(typedHistory[next] ?? "");
              }
            }
          }}
        />
      </div>
    </div>
  );
}
