/**
 * ACR-Routing citation parsing (ARCH-WF-002).
 *
 * The citation channel for routing protected-path changes through an ACR is a
 * single routing line in the pull-request body:
 *
 *     ACR-Routing: ACR-003
 *     ACR-Routing: ACR-003, ACR-004
 *
 * The parser accepts the label case-insensitively with the markdown
 * decorations a PR body realistically carries — a leading list bullet
 * (`- ACR-Routing: …`, the .github/PULL_REQUEST_TEMPLATE.md form) and/or
 * bold emphasis (`**ACR-Routing: …**`) — so a citation written the way the
 * template renders it is never silently dropped.
 *
 * Fail-closed rules:
 *   - Everything from an HTML comment start (`<!--`) to the end of the line is
 *     stripped BEFORE token extraction, so an unfilled template comment can
 *     never leak its example ids into a citation.
 *   - Only `ACR-NNN` tokens are extracted (a constrained, word-bounded
 *     pattern — injection safe); any surrounding prose is ignored.
 *   - The LAST routing line in the body wins (single-line semantics).
 *   - A line whose routing label is not line-initial (prose before it) never
 *     matches.
 */
import { readFileSync } from "node:fs";

export function parseAcrRouting(body: string): string[] {
  const LINE = /^[ \t]*(?:[-*][ \t]+)?\*{0,2}[ \t]*acr-routing:[ \t]*/i;
  const TOKEN = /ACR-\d{3}\b/g;
  let ids: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/<!--.*$/, "");
    if (!LINE.test(line)) continue;
    const start = line.search(LINE);
    if (start < 0) continue;
    ids = line.slice(start).match(TOKEN) ?? [];
  }
  return ids;
}

// CLI mode: read the PR body on stdin, print the comma-joined ACR ids (exit 0)
// or print nothing and exit 1 when no routing line cites any ACR. Used by
// .github/workflows/governance.yml so CI and the test suite share this exact
// implementation.
if (process.argv[1] !== undefined && process.argv[1].endsWith("parse-acr-routing.ts")) {
  const body = readFileSync(0, "utf8");
  const ids = parseAcrRouting(body);
  if (ids.length === 0) process.exit(1);
  process.stdout.write(ids.join(","));
}
