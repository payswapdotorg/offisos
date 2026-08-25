import type { NextConfig } from "next";

// CAD-IMPLEMENT-001 / Issue #24 milestone-3 integration: the canonical
// @offisos/cad-app-shell contracts (../../app/src/*) use Node ESM `.js`
// extension specifiers in relative imports (e.g. `export * from "./host.js";`).
// Under tsconfig `moduleResolution: "bundler"` TypeScript type-checking
// resolves `.js` -> `.ts` automatically. Next.js 16's default Turbopack dev
// bundler does NOT natively resolve `.js` specifiers to `.ts` files for
// server-side (route.ts) imports through the canonical app/src tree
// (verified empirically: 500 Module not found for `./contract.js` in
// `app/src/app-api/index.ts` when imported from `apps/web/src/app/api/cad/
// route.ts`). The webpack fallback below (active because `next dev
// --webpack` is used in the dev script) maps `.js` -> `.ts/.tsx/.js` so
// the canonical single-source-of-truth contracts resolve correctly. See
// the Task 18 worklog section for the resolution-path evidence.
const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Resolve `.js` specifiers to `.ts` for the canonical app/src/ contracts
  // (Node ESM `.js`-strip convention; moduleResolution: bundler).
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias || {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
