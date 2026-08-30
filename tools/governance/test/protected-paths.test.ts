/**
 * Protected-path tests.
 *
 * Proves: pattern matching works for exact paths and directory-tree globs;
 * the real manifest detects changes to frozen architecture artifacts; the
 * failure message routes to the Architecture Change Request process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkProtectedPaths,
  checkProtectedPathsWithRouting,
  globToRegex,
  matchProtectedPath,
  protectedPathsCheckResult,
  protectedPathsCheckResult as routedResult,
} from "../src/protected-paths.js";
import { loadAcrs, loadProtectedPaths } from "../src/loaders.js";
import { REPO_ROOT } from "./helpers.js";

test("exact patterns match only the exact path", () => {
  const regex = globToRegex("spec/architecture.md");
  assert.ok(regex.test("spec/architecture.md"));
  assert.ok(!regex.test("spec/architecture.md.bak"));
  assert.ok(!regex.test("docs/spec/architecture.md"));
  assert.ok(!regex.test("spec/architecture-lock.md"));
});

test("directory-tree globs match nested paths only under the tree", () => {
  const regex = globToRegex("spec/adr/**");
  assert.ok(regex.test("spec/adr/001-modular-monolith.md"));
  assert.ok(regex.test("spec/adr/nested/deep/decision.md"));
  assert.ok(!regex.test("spec/adrenaline/file.md"));
  assert.ok(!regex.test("spec/adr"));
  assert.ok(!regex.test("other/adr/001.md"));
});

test("single-star globs do not cross directory boundaries", () => {
  const regex = globToRegex("tools/*");
  assert.ok(regex.test("tools/cli.ts"));
  assert.ok(!regex.test("tools/governance/cli.ts"));
});

test("the real manifest flags frozen architecture artifacts", () => {
  const manifest = loadProtectedPaths(REPO_ROOT);
  const violations = checkProtectedPaths(
    [
      "spec/architecture.md",
      "spec/architecture-lock.md",
      "spec/adr/001-modular-monolith.md",
      "tools/governance/src/cli.ts",
      "governance/work-items/ARCH-WF-001.json",
      "spec/requirements.md", // tracked by spec but NOT in the protected manifest
    ],
    manifest,
  );
  const violatedPaths = violations.map((v) => v.path).sort();
  assert.deepEqual(violatedPaths, [
    "spec/adr/001-modular-monolith.md",
    "spec/architecture-lock.md",
    "spec/architecture.md",
  ].sort());
});

test("ordinary implementation changes pass the protected check", () => {
  const manifest = loadProtectedPaths(REPO_ROOT);
  const violations = checkProtectedPaths(
    ["tools/governance/src/rules.ts", "governance/work-items/RESEARCH-CAD-001.json", "package.json"],
    manifest,
  );
  assert.deepEqual(violations, []);
});

test("a protected change fails with ACR routing guidance", () => {
  const manifest = loadProtectedPaths(REPO_ROOT);
  const result = protectedPathsCheckResult(["spec/architecture-lock.md"], manifest);
  assert.equal(result.status, "fail");
  const message = (result.details ?? []).join(" ");
  assert.ok(message.includes("Architecture Change Request"), "must route to the ACR process");
});

test("bootstrap semantics: creating a brand-new protected file is not a violation", () => {
  const manifest = loadProtectedPaths(REPO_ROOT);
  // Simulate a base branch where the governance system does not exist yet.
  const violations = checkProtectedPaths(
    ["governance/workflow-states.json", "governance/protected-paths.json", "tools/governance/src/cli.ts"],
    manifest,
    { existsOnBase: () => false },
  );
  assert.deepEqual(violations, []);
});

test("bootstrap semantics: modifying an existing protected file is a violation", () => {
  const manifest = loadProtectedPaths(REPO_ROOT);
  const violations = checkProtectedPaths(
    ["governance/workflow-states.json"],
    manifest,
    { existsOnBase: (p) => p === "governance/workflow-states.json" },
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.path, "governance/workflow-states.json");
});

test("bootstrap semantics: adding a file into an existing protected tree is a violation", () => {
  const manifest = loadProtectedPaths(REPO_ROOT);
  // spec/adr/ exists on the base branch, so a new ADR must be routed through review.
  const violations = checkProtectedPaths(
    ["spec/adr/099-new-decision.md"],
    manifest,
    { existsOnBase: (p) => p === "spec/adr" },
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.path, "spec/adr/099-new-decision.md");
});

test("bootstrap semantics: adding a file into a tree that does not exist on base is not a violation", () => {
  const manifest = loadProtectedPaths(REPO_ROOT);
  const violations = checkProtectedPaths(
    ["spec/adr/099-new-decision.md"],
    manifest,
    { existsOnBase: () => false },
  );
  assert.deepEqual(violations, []);
});

test("check-protected reads changed paths from a paths file", () => {
  const manifest = loadProtectedPaths(REPO_ROOT);
  const dir = mkdtempSync(join(tmpdir(), "offisos-paths-"));
  const pathsFile = join(dir, "changed.txt");
  writeFileSync(pathsFile, "README.md\nspec/adr/002-provider-independent-ai.md\n\n  \n");
  const changed = readPathsFile(pathsFile);
  const violations = checkProtectedPaths(changed, manifest);
  assert.deepEqual(violations.map((v) => v.path), ["spec/adr/002-provider-independent-ai.md"]);
  rmSync(dir, { recursive: true, force: true });
});

function readPathsFile(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
}

// ---------------------------------------------------------------------------
// ACR routing (ARCH-WF-002, Issue #12).
// ---------------------------------------------------------------------------


import type { AcrRecord, ProtectedPathsFile } from "../src/types.js";

function routingManifest(): ProtectedPathsFile {
  return {
    architecture_version: "1.1",
    patterns: [
      { pattern: "governance/protected-paths.json", reason: "The manifest." },
      { pattern: "spec/architecture-lock.md", reason: "Frozen lock." },
      { pattern: "governance/acr/**", reason: "ACR registry.", additions: "allowed" },
      { pattern: "governance/schemas/**", reason: "Control contracts." },
    ],
  };
}

function approvedAcr(): AcrRecord {
  return structuredClone({
    id: "ACR-010",
    title: "Routing fixture ACR",
    status: "APPROVED",
    requested_by: "requester-a",
    requested_at: "2026-09-01T00:00:00Z",
    problem: "Fixture problem statement long enough for the schema.",
    evidence: ["fixture evidence"],
    impact: "Fixture impact statement long enough for the schema.",
    alternatives: ["do nothing — rejected."],
    recommendation: "Fixture recommendation long enough for the schema.",
    migration_plan: "Fixture migration plan long enough for the schema.",
    compatibility: "Fixture compatibility statement long enough for the schema.",
    security_impact: "Fixture security impact statement long enough for the schema.",
    affected_requirements: ["FLOW-004"],
    affected_work_items: [],
    architecture_version_from: "1.1",
    architecture_version_to: "1.1",
    authorized_paths: ["governance/protected-paths.json"],
    review: {
      reviewed_by: "architect-a",
      role: "architect",
      reviewed_at: "2026-09-01T00:10:00Z",
      verdict: "endorsed",
      rationale: "endorsed",
    },
    approval: {
      approved_by: "owner-a",
      role: "product-owner",
      approved_at: "2026-09-01T00:20:00Z",
      decision: "approved",
      rationale: "approved",
    },
  });
}

test("an approved ACR routes the exact paths it authorizes, explicitly", () => {
  const manifest = routingManifest();
  const registry = new Map([["ACR-010", approvedAcr()]]);
  const result = routedResult(
    ["governance/protected-paths.json", "tools/governance/src/cli.ts"],
    manifest,
    { acrRouting: { registry, citedAcrs: ["ACR-010"] } },
  );
  assert.equal(result.status, "pass");
  const message = (result.details ?? []).join(" ");
  assert.ok(message.includes("ROUTED via ACR-010"), "must report the explicit routing");
  assert.ok(message.includes("approved_by".slice(0, 0) + "product-owner approval"), "must name the approving authority");
});

test("a cited PROPOSED ACR cannot route — the refusal is reported", () => {
  const manifest = routingManifest();
  const acr = approvedAcr();
  acr.status = "PROPOSED";
  acr.review = undefined;
  acr.approval = undefined;
  const registry = new Map([["ACR-010", acr]]);
  const result = routedResult(["governance/protected-paths.json"], manifest, {
    acrRouting: { registry, citedAcrs: ["ACR-010"] },
  });
  assert.equal(result.status, "fail");
  const message = (result.details ?? []).join(" ");
  assert.ok(message.includes("'ACR-010' is PROPOSED"), "must explain the refusal");
  assert.ok(message.includes("APPROVED or IMPLEMENTED"));
});

test("a cited ACR that does not cover the path refuses to route it", () => {
  const manifest = routingManifest();
  const registry = new Map([["ACR-010", approvedAcr()]]);
  const result = routedResult(["spec/architecture-lock.md"], manifest, {
    acrRouting: { registry, citedAcrs: ["ACR-010"] },
  });
  assert.equal(result.status, "fail");
  const message = (result.details ?? []).join(" ");
  assert.ok(message.includes("does not authorize 'spec/architecture-lock.md'"));
});

test("an uncited approved ACR authorizes nothing — routing is explicit only", () => {
  const manifest = routingManifest();
  const registry = new Map([["ACR-010", approvedAcr()]]);
  // No citedAcrs: implicit routing must not happen.
  const result = routedResult(["governance/protected-paths.json"], manifest, {
    acrRouting: { registry, citedAcrs: [] },
  });
  assert.equal(result.status, "fail");
});

test("demo ACRs and unresolvable citations cannot route", () => {
  const manifest = routingManifest();
  const demo = approvedAcr();
  demo.id = "ACR-901";
  demo.demo = true;
  demo.disclaimer = "demo";
  const registry = new Map<string, AcrRecord>([["ACR-901", demo]]);
  const result = routedResult(["governance/protected-paths.json"], manifest, {
    acrRouting: { registry, citedAcrs: ["ACR-901", "ACR-777"] },
  });
  assert.equal(result.status, "fail");
  const message = (result.details ?? []).join(" ");
  assert.ok(message.includes("demo fixture"));
  assert.ok(message.includes("ACR-777' does not resolve"));
});

test("registry trees: additions are the normal flow, modifications stay protected", () => {
  const manifest = routingManifest();
  const baseFiles = new Set(["governance/acr/ACR-010.json"]);
  const existsOnBase = (p: string) => baseFiles.has(p) || p === "governance/acr";
  const outcome = checkProtectedPathsWithRouting(
    ["governance/acr/ACR-011.json", "governance/acr/ACR-010.json"],
    manifest,
    { existsOnBase },
  );
  assert.deepEqual(outcome.violations.map((v) => v.path), ["governance/acr/ACR-010.json"]);
});

test("protected schema trees: additions need ACR routing too", () => {
  const manifest = routingManifest();
  const existsOnBase = (p: string) => p === "governance/schemas";
  const outcome = checkProtectedPathsWithRouting(["governance/schemas/new-control.schema.json"], manifest, { existsOnBase });
  assert.equal(outcome.violations.length, 1);
  assert.equal(outcome.violations[0]!.path, "governance/schemas/new-control.schema.json");
});

test("the real ACR-003 is PROPOSED and therefore cannot yet route its paths", () => {
  const manifest = loadProtectedPaths(REPO_ROOT);
  const registry = new Map<string, AcrRecord>();
  for (const { record } of loadAcrs(REPO_ROOT)) registry.set(record.id, record);
  const acr003 = registry.get("ACR-003");
  assert.ok(acr003 !== undefined, "ACR-003 must be registered");
  assert.equal(acr003.status, "PROPOSED", "ACR-003 awaits Architect review and Product Owner approval");
  const result = routedResult(
    ["governance/protected-paths.json", "governance/schemas/acr.schema.json"],
    manifest,
    { acrRouting: { registry, citedAcrs: ["ACR-003"] } },
  );
  assert.equal(result.status, "fail", "until approved, the ARCH-WF-002 protected-path change must stay unrouted");
  const message = (result.details ?? []).join(" ");
  assert.ok(message.includes("'ACR-003' is PROPOSED"));
});

test("when ACR-003 is approved it routes exactly its three authorized paths", () => {
  const manifest = loadProtectedPaths(REPO_ROOT);
  const registry = new Map<string, AcrRecord>();
  for (const { record } of loadAcrs(REPO_ROOT)) registry.set(record.id, record);
  const approved = structuredClone(registry.get("ACR-003")!);
  approved.status = "APPROVED";
  approved.review = {
    reviewed_by: "architect-a",
    role: "architect",
    reviewed_at: "2026-08-30T18:30:00Z",
    verdict: "endorsed",
    rationale: "fixture endorsement for the routing test",
  };
  approved.approval = {
    approved_by: "owner-a",
    role: "product-owner",
    approved_at: "2026-08-30T18:31:00Z",
    decision: "approved",
    rationale: "fixture approval for the routing test",
  };
  registry.set("ACR-003", approved);
  const result = routedResult(
    ["governance/protected-paths.json", "governance/schemas/acr.schema.json", "governance/schemas/reconciliation.schema.json", "governance/workflow-states.json"],
    manifest,
    { existsOnBase: () => true, acrRouting: { registry, citedAcrs: ["ACR-003"] } },
  );
  assert.equal(result.status, "fail", "workflow-states.json is not authorized by ACR-003");
  const message = (result.details ?? []).join(" ");
  assert.ok(message.includes("ROUTED via ACR-003"), "the three authorized paths are routed");
  assert.ok(message.includes("'governance/workflow-states.json' matches"), "the unauthorized path stays a violation");
});
