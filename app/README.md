# CAD-IMPLEMENT-001 — Shared CAD/BIM application shell (Web + Electron)

**Architecture version:** 1.1 (FROZEN)
**Work item:** CAD-IMPLEMENT-001 (Issue #24)
**Implements:** ACR-002 topology + LOCK-017/018/019

## 1. What this is

The first production implementation work item for the CAD/BIM application. It
delivers the shared shell that proves the frozen Architecture v1.1 CAD/BIM
client topology:

```
                    CAD/BIM Renderer Core            (src/renderer — platform-independent)
                             │
              ┌──────────────┴──────────────┐
              │                             │
        Electron Host                  Web Host         (src/host-electron, src/host-web)
              │                             │
        Native/Desktop                HTTP/WebSocket
          Transport                      Transport
              │                             │
              └──────────────┬──────────────┘
                             │
                       CAD/BIM App API                 (src/app-api — semantic command/query contract v1)
                             │
                       CAD/BIM Engine
                             │
                    CADDocument Model                  (src/caddocument — versioned working rep, §5.4)
                             │
                    Construction Graph                  (out of scope: canonical SoR, not the CADDocument)
```

The renderer core does **not** import Electron, browser APIs, FreeCAD,
OpenCascade or IfcOpenShell (LOCK-018, §5.5). Host and engine concerns are
exposed through the contracts in `src/contracts/`. A static test
(`test/no-forbidden-imports.test.ts`) enforces this invariant on every build.

## 2. Package layout

| Package | Role | Architectural lock |
|---------|------|--------------------|
| `src/contracts` | Host capabilities, transport, command/query, CADDocument, adapter, scene | LOCK-017/018/019, §5.3–5.5 |
| `src/renderer` | Platform-independent renderer/editor core | LOCK-017/018 |
| `src/app-api` | Versioned command/query contract v1 + schema + idempotency | §5.3, api-contract.md |
| `src/caddocument` | Versioned document model, serialization, undo/redo, provenance | §5.4, data-model.md §2 |
| `src/host-web` | Web host (HTTP/WebSocket transport) | §5.3, §16 |
| `src/host-electron` | Electron host (allowlisted native IPC transport) | §5.3, §16 |
| `src/adapters/dummy` | In-memory engine + file adapter (adapter-boundary test double) | LOCK-003/018 |

## 3. First-PR acceptance proof

The first PR must prove (per Issue #24):

1. **Web/Electron parity** — `test/host-parity.test.ts`: the same command
   sequence through the Web Host and the Electron Host yields identical
   CADDocument state.
2. **Document serialization/versioning** — `test/serialization-roundtrip.test.ts`
   + `test/version-chain.test.ts`: canonical JSON round-trip preserves
   identity; version chain satisfies data-model.md §2.
3. **Transport independence** — the renderer talks to hosts only through the
   `Transport` contract; `test/contract-schema.test.ts` proves the wire
   contract is versioned and stable.
4. **Dummy-adapter operation** — `test/dummy-adapter-e2e.test.ts`: end-to-end
   open → applyEdit → serialize → undo → redo → verify using only the dummy
   adapter; no production engine is imported.
5. **Undo/redo** — `test/undo-redo.test.ts`: command log + inverse semantics
   over the CADDocument.
6. **CI reproducibility** — `test/reproducibility.test.ts`: deterministic scene
   graph + canonical serialization hashes; the CI workflow reproduces locally.
7. **No engine coupling** — `test/no-forbidden-imports.test.ts`: static check
   that no source file under `src/renderer`, `src/app-api`, `src/caddocument`
   or `src/contracts` imports Electron, browser, FreeCAD, OCCT or IfcOpenShell.

## 4. Out of scope (per Issue #24)

- Production CAD/BIM engine integration (FreeCAD/OCCT/IfcOpenShell) — a future
  work item behind the proven adapter boundary.
- Construction Graph integration — CADDocument is the editor's working
  representation, not the canonical SoR (LOCK-019, §5.4).
- Legal/composition approval — that is LICENSE-001's decision (CAD-006 feeds
  it; CAD-006 continues separately).
- Production packaging change — out of scope per Issue #24.
