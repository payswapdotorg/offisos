/**
 * LOCK-018/§5.5 forbidden-import static check.
 *
 * Asserts that no source file under the platform-independent core
 * (src/contracts, src/renderer, src/app-api, src/caddocument) imports
 * Electron, browser UI, or CAD/BIM engine packages. The renderer/editor core
 * must not directly depend on these (LOCK-018); host and engine concerns are
 * exposed through contracts. Host packages (src/host-web, src/host-electron)
 * and adapters (src/adapters) are explicitly excluded — they implement the
 * host/adapter side of the boundary.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = fileURLToPath(new URL("../", import.meta.url));

const FORBIDDEN_SPECIFIERS = [
  "electron",
  "react",
  "react-dom",
  "react-dom/",
  "@electron/",
  "freecad",
  "FreeCAD",
  "opencascade",
  "OpenCascade",
  "occt",
  "OCCT",
  "ifcopenshell",
  "IfcOpenShell",
];

const PROTECTED_DIRS = ["src/contracts", "src/renderer", "src/app-api", "src/caddocument"];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (full.endsWith(".ts")) {
      yield full;
    }
  }
}

test("protected core directories exist and contain source", () => {
  for (const rel of PROTECTED_DIRS) {
    assert.ok(existsSync(join(APP_ROOT, rel)), `missing protected dir: ${rel}`);
  }
});

test("no forbidden imports in platform-independent core", () => {
  const violations: string[] = [];
  for (const rel of PROTECTED_DIRS) {
    const dir = join(APP_ROOT, rel);
    for (const file of walk(dir)) {
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");
      for (const [i, line] of lines.entries()) {
        if (!/^\s*(import|export)\b/.test(line)) continue;
        for (const forbidden of FORBIDDEN_SPECIFIERS) {
          const re = new RegExp(`["']${forbidden.replace("/", "/")}`);
          if (re.test(line)) {
            violations.push(`${relative(APP_ROOT, file)}:${i + 1}: ${line.trim()}`);
          }
        }
      }
    }
  }
  assert.equal(
    violations.length,
    0,
    `LOCK-018 violation — forbidden engine/host/browser imports in core:\n${violations.join("\n")}`,
  );
});

test("host and adapter packages exist (boundary counterpart)", () => {
  for (const rel of ["src/host-web", "src/host-electron", "src/adapters/dummy"]) {
    assert.ok(existsSync(join(APP_ROOT, rel)), `missing host/adapter dir: ${rel}`);
  }
});
