#!/usr/bin/env node
/**
 * Offisos governance CLI.
 *
 * Commands:
 *   validate [--root <dir>]
 *       Validate the canonical state machine, the architecture-version
 *       registry, the protected-path manifest, the ACR registry, the
 *       reconciliation registry and every work-item record in
 *       governance/work-items/. Writes governance-report.json and exits
 *       non-zero on any violation.
 *
 *   check-protected (--base <git-ref> | --paths-file <file>) [--acr <ids>] [--root <dir>]
 *       Check changed paths against the protected-path manifest.
 *       --base computes changed paths via `git diff --name-only
 *       <base>...HEAD` and applies bootstrap semantics (changes to paths or
 *       protected trees that already exist on the base branch are
 *       violations; brand-new protected files are the bootstrap case).
 *       --paths-file reads one path per line and applies strict semantics
 *       (every matching path is a violation).
 *       --acr cites one or more ACR ids (comma-separated, repeatable) that
 *       the change is routed through (ARCH-WF-002). A protected change is
 *       waived only when a cited ACR is APPROVED/IMPLEMENTED, real, and
 *       enumerates the exact path in authorized_paths; every other protected
 *       change remains a violation.
 *       Registry lifecycle rule (--base mode): a modification of an EXISTING
 *       record under a lifecycle-managed registry pattern
 *       (governance/acr/**, governance/reconciliations/**) is waived only
 *       when the before/after content is a narrowly content-checked legal
 *       lifecycle transition of that record (status edge + exactly the gate
 *       instruments, each role-correct — registry-lifecycle.ts); waived
 *       transitions are reported explicitly as REGISTRY LIFECYCLE. A NEWLY
 *       CREATED record under those patterns must satisfy the CREATION
 *       TRAVERSAL: its introduction commit must be born at the INITIAL
 *       lifecycle status (ACR → PROPOSED, reconciliation → STAGED) and every
 *       later change to the same record within the checked range must itself
 *       be a legal lifecycle transition — a record born mid-lifecycle
 *       (already APPROVED / IMPLEMENTED / DECIDED) or advanced by anything
 *       other than the legal edges is a violation, because the transition
 *       guard only sees before/after pairs for pre-existing paths (demo
 *       fixtures, demo: true, are exempt but inert). Lawful creations are
 *       reported explicitly as REGISTRY ADDITION, with the traversed edges
 *       when the same change advanced the record. In --paths-file strict
 *       mode there is no record content or history, so registry-record
 *       modifications AND additions fail closed.
 *
 *   check-verified-revisions [--base <git-ref>] [--root <dir>]
 *       Revision-bound verification drift audit (ARCH-WF-002): for every
 *       VERIFIED work item, compare its verification binding revision with
 *       the current tree; bound paths that changed after the binding
 *       revision make the verification stale (fail). Requires local git
 *       history (full clone).
 *
 * All checks are deterministic and offline (git operations are local).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { validateRepository } from "./validate.js";
import { protectedPathsCheckResult } from "./protected-paths.js";
import { computeVerifiedRevisionAudit } from "./revision-binding.js";
import { loadAcrs, loadWorkItems, readJson } from "./loaders.js";
import type { AcrRecord, CheckResult, ProtectedPathsFile } from "./types.js";

function printCheck(check: CheckResult): void {
  const tag = check.status === "pass" ? "[PASS]" : "[FAIL]";
  console.log(`${tag} ${check.id} — ${check.description}`);
  for (const detail of check.details ?? []) {
    console.log(`        ${detail}`);
  }
}

function printSummary(checks: CheckResult[]): number {
  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  console.log("");
  console.log(`Summary: ${passed} passed, ${failed} failed (${checks.length} checks).`);
  return failed > 0 ? 1 : 0;
}

/**
 * Completes a command: sets the exit code and returns, letting the process
 * exit naturally so pending stdio writes drain first. process.exit() here
 * would truncate the tail of piped stdout — the Summary line is the LAST
 * write, and on a loaded runner the final libuv write had not been flushed
 * when exit fired (observed as CI run 33333571893 failing
 * repo-integration's `CLI validate exits with the expected code` assertion
 * with the exit code intact but no "Summary:" in stdout).
 */
function finish(code: number): void {
  process.exitCode = code;
}

function usage(): never {
  console.error(
    [
      "Usage:",
      "  npm run governance -- validate [--root <dir>]",
      "  npm run governance -- check-protected (--paths-file <file> | --base <git-ref>) [--acr ACR-003,ACR-004] [--root <dir>]",
      "  npm run governance -- check-verified-revisions [--base <git-ref>] [--root <dir>]",
    ].join("\n"),
  );
  process.exit(2);
}

/**
 * Parses args where later occurrences of a repeated key accumulate into a
 * comma-joined value (for --acr), and all other keys keep last-wins semantics.
 */
function parseArgs(args: string[], multiKeys: Set<string> = new Set()): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) usage();
    const key = arg.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) usage();
    if (multiKeys.has(key)) {
      options.set(key, options.has(key) ? `${options.get(key)},${value}` : value);
    } else {
      options.set(key, value);
    }
    i++;
  }
  return options;
}

function loadAcrRegistry(root: string): Map<string, AcrRecord> {
  const registry = new Map<string, AcrRecord>();
  for (const { record } of loadAcrs(root)) registry.set(record.id, record);
  return registry;
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest, new Set(["acr"]));
  const root = resolve(options.get("root") ?? process.cwd());

  if (command === "validate") {
    const { report } = validateRepository(root);
    for (const check of report.checks) printCheck(check);
    const reportPath = resolve(root, "governance-report.json");
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log("");
    console.log(`Report artifact: ${reportPath}`);
    finish(printSummary(report.checks));
    return;
  }

  if (command === "check-protected") {
    const pathsFile = options.get("paths-file");
    const base = options.get("base");
    const acrOption = options.get("acr");
    if (pathsFile === undefined && base === undefined) {
      console.error("At least one of --paths-file or --base is required.");
      usage();
    }
    let changedPaths: string[];
    if (pathsFile !== undefined) {
      changedPaths = readFileSync(pathsFile, "utf8").split("\n").filter((l) => l.trim().length > 0);
    } else {
      const baseRef = base!;
      try {
        const output = execSync(`git diff --name-only ${baseRef}...HEAD`, { cwd: root, encoding: "utf8" });
        changedPaths = output.split("\n").filter((l) => l.trim().length > 0);
      } catch (error) {
        console.error(`Failed to run git diff against '${baseRef}': ${(error as Error).message}`);
        finish(2);
        return;
      }
    }
    const manifest = readJson<ProtectedPathsFile>(resolve(root, "governance", "protected-paths.json"));
    // With a base ref, bootstrap semantics apply: changes count as violations
    // when the path (or its protected tree) already exists on the base
    // branch; brand-new protected files where nothing existed before are the
    // documented bootstrap case. Without a base ref, strict mode: every
    // matching path is a violation.
    const routing = acrOption === undefined
      ? undefined
      : {
          registry: loadAcrRegistry(root),
          citedAcrs: acrOption.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
        };
    // Reads (and JSON-parses) a registry record's content at a git ref;
    // undefined when the path is absent or not parseable (fail closed).
    const readRecordAt = (ref: string, path: string): unknown | undefined => {
      try {
        const content = execSync(`git show ${JSON.stringify(`${ref}:${path}`)}`, {
          cwd: root,
          encoding: "utf8",
        });
        return JSON.parse(content) as unknown;
      } catch {
        return undefined;
      }
    };
    const check =
      base === undefined
        ? protectedPathsCheckResult(changedPaths, manifest, routing === undefined ? {} : { acrRouting: routing })
        : protectedPathsCheckResult(changedPaths, manifest, {
            existsOnBase: (path) => {
              try {
                execSync(`git cat-file -e ${base}:${path}`, { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
                return true;
              } catch {
                return false;
              }
            },
            ...(routing === undefined ? {} : { acrRouting: routing }),
            // Registry lifecycle verification (ARCH-WF-002 remediation): for
            // lifecycle-managed registry patterns, the record content is read
            // so the change can be authorized by the narrowly content-checked
            // rules — a MODIFICATION of an existing record needs the before
            // (base) and after (HEAD) pair checked as a legal lifecycle
            // transition; a NEWLY CREATED record needs its full commit-range
            // traversal (creation at the initial status + every later
            // intra-change step as a legal transition — the round-3 creation
            // invariant).
            registryLifecycle: {
              readRecordPair: (path) => ({
                before: readRecordAt(base!, path),
                after: readRecordAt("HEAD", path),
              }),
              readRecordHistory: (path) => {
                try {
                  const log = execSync(
                    `git log --full-history --format=%H --reverse ${JSON.stringify(`${base}..HEAD`)} -- ${JSON.stringify(path)}`,
                    { cwd: root, encoding: "utf8" },
                  );
                  const commits = log.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
                  return commits.map((commit) => ({
                    commit,
                    before: readRecordAt(`${commit}^`, path),
                    after: readRecordAt(commit, path),
                  }));
                } catch {
                  return undefined;
                }
              },
            },
          });
    printCheck(check);
    finish(printSummary([check]));
    return;
  }

  if (command === "check-verified-revisions") {
    const base = options.get("base") ?? "HEAD";
    const records = loadWorkItems(root).map((l) => l.record);
    const git = {
      revParse(ref: string): string | undefined {
        try {
          const out = execSync(`git rev-parse --verify ${JSON.stringify(ref)}^{commit}`, {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
          return out.length > 0 ? out : undefined;
        } catch {
          return undefined;
        }
      },
      diffNames(from: string, to: string): string[] {
        try {
          return execSync(`git diff --name-only ${from} ${JSON.stringify(to)}`, {
            cwd: root,
            encoding: "utf8",
          }).split("\n").filter((l) => l.trim().length > 0);
        } catch {
          return [];
        }
      },
    };
    const { check } = computeVerifiedRevisionAudit(records, git, base);
    printCheck(check);
    finish(printSummary([check]));
    return;
  }

  usage();
}

main();
