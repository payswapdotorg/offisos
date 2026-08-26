// CAD-IMPLEMENT-001 / Issue #24 remediation: build the Electron host.
//
// Bundles three entry points with esbuild:
//   - src/main/main.ts      -> dist/main/main.cjs      (node, CJS, external: electron)
//   - src/main/preload.ts   -> dist/main/preload.cjs   (node, CJS, external: electron)
//   - src/renderer/workspace.ts -> dist/renderer/workspace.js (browser, IIFE)
//
// The `@offisos/cad-app-shell/*` tsconfig paths alias is mapped to ../../app/src
// here so the canonical contracts (single source of truth) are bundled in.
// The canonical app/src/ files import relatives with `.js` specifiers
// (Node ESM convention); esbuild resolves `.js` -> `.ts` via resolveExtensions.
//
// index.html is copied to dist/renderer/ so `win.loadFile` can load it.

import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const appSrc = resolve(root, "../../app/src");

const common = {
  bundle: true,
  resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".css", ".json"],
  alias: { "@offisos/cad-app-shell": appSrc },
  sourcemap: true,
  logLevel: "info",
  legalComments: "none",
};

mkdirSync(join(root, "dist/main"), { recursive: true });
mkdirSync(join(root, "dist/renderer"), { recursive: true });

await esbuild.build({
  ...common,
  entryPoints: ["src/main/main.ts"],
  outfile: "dist/main/main.cjs",
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  banner: { js: "// @offisos/electron-host main — bundled from src/main/main.ts" },
});

await esbuild.build({
  ...common,
  entryPoints: ["src/main/preload.ts"],
  outfile: "dist/main/preload.cjs",
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  banner: { js: "// @offisos/electron-host preload — bundled from src/main/preload.ts" },
});

await esbuild.build({
  ...common,
  entryPoints: ["src/renderer/workspace.ts"],
  outfile: "dist/renderer/workspace.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
});

copyFileSync(join(root, "src/renderer/index.html"), join(root, "dist/renderer/index.html"));

console.log("build: main.cjs + preload.cjs + renderer/workspace.js + index.html written to dist/");
