#!/usr/bin/env node
/**
 * Offisos governance CLI.
 *
 * Commands:
 *   validate [--root <dir>]
 *       Validate the canonical state machine, the architecture-version
 *       registry, the protected-path manifest and every work-item record in
 *       governance/work-items/. Writes governance-report.json and exits
 *       non-zero on any violation.
 *
 *   check-protected (--base <git-ref> | --paths-file <file>) [--root <dir>]
 *       Check changed paths against the protected-path manifest.
 *       --base computes changed paths via `git diff --name-only
 *       <base>...HEAD` and applies bootstrap semantics (changes to paths or
 *       protected trees that already exist on the base branch are
 *       violations; brand-new protected files are the bootstrap case).
 *       --paths-file reads one path per line and applies strict semantics
 *       (every matching path is a violation).
 *
 * All checks are deterministic and offline.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { validateRepository } from "./validate.js";
import { protectedPathsCheckResult } from "./protected-paths.js";
import { readJson } from "./loaders.js";
import type { CheckResult, ProtectedPathsFile } from "./types.js";

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

function usage(): never {
  console.error(
    [
      "Usage:",
      "  npm run governance -- validate [--root <dir>]",
      "  npm run governance -- check-protected (--paths-file <file> | --base <git-ref>) [--root <dir>]",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(args: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) usage();
    const key = arg.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) usage();
    options.set(key, value);
    i++;
  }
  return options;
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  const root = resolve(options.get("root") ?? process.cwd());

  if (command === "validate") {
    const { report } = validateRepository(root);
    for (const check of report.checks) printCheck(check);
    const reportPath = resolve(root, "governance-report.json");
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log("");
    console.log(`Report artifact: ${reportPath}`);
    process.exit(printSummary(report.checks));
  }

  if (command === "check-protected") {
    const pathsFile = options.get("paths-file");
    const base = options.get("base");
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
        process.exit(2);
      }
    }
    const manifest = readJson<ProtectedPathsFile>(resolve(root, "governance", "protected-paths.json"));
    // With a base ref, bootstrap semantics apply: changes count as violations
    // when the path (or its protected tree) already exists on the base
    // branch; brand-new protected files where nothing existed before are the
    // documented bootstrap case. Without a base ref, strict mode: every
    // matching path is a violation.
    const check =
      base === undefined
        ? protectedPathsCheckResult(changedPaths, manifest)
        : protectedPathsCheckResult(changedPaths, manifest, {
            existsOnBase: (path) => {
              try {
                execSync(`git cat-file -e ${base}:${path}`, { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
                return true;
              } catch {
                return false;
              }
            },
          });
    printCheck(check);
    process.exit(printSummary([check]));
  }

  usage();
}

main();
