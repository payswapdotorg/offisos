# Offisos Infrastructure Roadmap — Dependency-Ordered Work Items

**Status:** ACTIVE — INFRA-001 VERIFIED; INFRA-002 ASSIGNED
**Verified foundation:** INFRA-001 @ `0e94680bcedc20bcfb4d4d51eeefb089d7e45665`
**Current successor:** INFRA-002 — Neon PostgreSQL foundation (authoritative transactional store)
**Purpose:** the authoritative decomposition of the persistent serverless foundation into
releasable, independently verifiable work items, derived from the INFRA-001 audit
(`offisos-state-inventory.md`, `offisos-persistence-model.md`,
`offisos-worker-model.md`).
**Sequencing authority:** the Architect releases successors per
`docs/governance/architect-return-protocol.md` §7 — records are born `DRAFT` by the
Architect at release time. This document defines the scope/order; governance records
establish legal lifecycle state.

## Current release state

- **INFRA-001:** VERIFIED at merge commit `0e94680bcedc20bcfb4d4d51eeefb089d7e45665`; PR #141; Architect decision `DEC-001` approved and `DEC-002` verified.
- **INFRA-002:** ASSIGNED; depends on INFRA-001 VERIFIED; worker: `z-ai-infra-agent`.
- **COMPAT-CAD-007:** remains independently ASSIGNED; it is not blocked by INFRA-002.
- **COMPAT-CAD-011:** remains coordinated behind INFRA-002/003/004 for durable SAVE/OPEN on the authoritative stores.

---

## 1. Decomposition principles

1. **Every item is independently verifiable and revertible** (the phase table in
   `offisos-serverless-architecture.md` §9).
2. **No item requires freezing the CAD roadmap.** All items touch host wiring, additive
   ports, or new services — not the CAD semantics under remediation
   (COMPAT-CAD-006 → …). The one coordination point is COMPAT-CAD-011 (below).
3. **Fail-closed honesty is preserved at every step**: unconfigured production stays
   functional (reference engines, client-held files) and declines typed on the new
   surfaces.
4. **Evidence-gated**: each item's acceptance is deterministic tests + CI + (where
   production-affecting) exact-head deployment + browser verification — the repo's
   established loop.

## 2. Coordination with the CAD roadmap

`docs/cad/autocad-parity-roadmap.md` defines **COMPAT-CAD-011 — Durable
SAVE/OPEN/reload-safe document persistence (PLANNED)**, gated on the G9 golden
workflow (save/reload/DXF round-trip; DEF-009/010).

- **Sequencing recommendation:** INFRA-002/003/004 land first; COMPAT-CAD-011 then
  implements the user-facing durable SAVE/OPEN workflow **on** the authoritative
  stores instead of patching the instance-local handler (avoiding double-built
  persistence and a later rework).
- If the CAD roadmap must proceed before INFRA-004 is VERIFIED, COMPAT-CAD-011's
  scope should stay Electron-file-first (the `FileP016Persist` path) and adopt the
  `DocumentStore` port when INFRA-004 merges — the port contract is designed to make
  that adoption a wiring change, not a redesign.

## 3. The work items

### INFRA-002 — Neon PostgreSQL foundation (authoritative transactional store)

- **Depends on:** INFRA-001 VERIFIED.
- **Scope:** the `DocumentStore` port (the P016 discipline applied to document
  persistence: registry + version chain + idempotency + command log); the Neon
  adapter (promoted `p016-postgres.ts` semantics: pooled connection, idempotent DDL,
  `json`-not-`jsonb` byte-identity, advisory-lock/CAS serialization); a
  `MemoryDocumentStore` (dev/tests) and `FailClosedDocumentStore`; the multi-backend
  byte-identity fixture pattern.
- **Acceptance (shape):** deterministic cross-backend store tests (memory vs postgres
  byte-identical persisted views); CAS conflict tests; idempotency
  insert-on-conflict tests; CI job with a real postgres service (the P016 web-job
  precedent); fail-closed production behavior typed; zero behavior change for the
  existing v1 request path.
- **Non-goals:** no R2, no request-shape change, no worker, no production env wiring.
- **Evidence:** automated-test-suite + CI run (postgres service) + the reproducible
  cross-backend script.

### INFRA-003 — Cloudflare R2 object store (authoritative artifacts)

- **Depends on:** INFRA-002 (the registry that references the objects).
- **Scope:** the `ObjectStore` port (content-addressed put/get/exists; S3-compatible
  R2 adapter via the AWS SDK with `If-None-Match: *` create-if-absent claims; MinIO
  adapter for CI/local); the R2 namespace (`offisos-persistence-model.md` §3.1);
  checkpoint blob bodies to R2 (the `P016Persist` blob path gains an R2-backed
  implementation of the SAME port); `document.save` gains the durable server-side
  version-body write (client download unchanged); export artifact writes.
- **Acceptance (shape):** content-addressed dedup tests (identical content →
  identical key, idempotent re-put); restart-proof against R2/MinIO; byte-identical
  fixture round-trips; CI with MinIO service; fail-closed behavior when unconfigured.
- **Non-goals:** no request-shape change; no worker.

### INFRA-004 — Stateless document requests (WireEnvelope v2 + multi-instance proof)

- **Depends on:** INFRA-002, INFRA-003.
- **Scope:** the additive `WireEnvelope` v2 (`documentId`, `baseRevision`); the
  handler's reference-bound session (load-by-reference → materialize via
  `CADDocument.open` → execute → CAS commit → revision-bound response); typed
  `document_conflict` responses (current head + intervening versions, the collab
  precedent); the **multi-instance proof suite** (the six-assertion specification in
  `offisos-persistence-model.md` §6) as a CI job with two handlers over real
  postgres + MinIO; v1 envelope compat path (session-bound) preserved.
- **Acceptance (shape):** every assertion of the multi-instance proof; conflict
  determinism; cold-instance convergence; the deployed smoke upgraded to drive the
  v2 envelope against the wired production stores; regression-green across the
  existing app/web suites.
- **Non-goals:** no worker; no undo-across-instances journal fabrication (revert-to
  parent semantics stay typed); no tenancy enforcement.

### INFRA-005 — Upstash Redis coordination layer (never authority)

- **Depends on:** INFRA-002 (idempotency authority in Neon).
- **Scope:** the `CoordinationCache` port + Upstash adapter (REST/client, best-effort
  at every call site); the key inventory of `offisos-persistence-model.md` §4
  (idempotency read-through, presence, stream/mesh caches, probe memoization,
  optional locks); honest observability (`collab.state`-style backend reporting);
  local dev without Redis.
- **Acceptance (shape):** Redis-loss tests prove correctness (dedup still correct via
  Neon; caches recompute); TTL/bounds tests; no command fails merely because Redis is
  absent; CI with a redis service.

### INFRA-006 — Persistent CAD/BIM worker service

- **Depends on:** INFRA-002 (jobs table) + INFRA-004 (reference-bound results);
  benefits from INFRA-003 (input bodies).
- **Scope:** the claim-lease job executor (the lifecycle of
  `offisos-worker-model.md` §3); the worker service (Railway primary / Cloud Run
  alternative — the container is the CI toolchain pins); the toolchain image reusing
  the repository's own `app/src/adapters/*/worker/*.py` verbatim; HMAC claim ingress;
  engine-backed job kinds additive to `JOB_KINDS` (`ifc.import/export`,
  `geometry.prepare` remote path, `mesh.*`, maintenance GC); the App API wiring point
  extension (`OFFISOS_WORKER_URL` — the ENGINE_MODE pattern).
- **Acceptance (shape):** lease expiry/reclaim tests; exactly-one-claimer tests;
  stale-revision rejection tests; toolchain image parity (the CI engine pins);
  deployed production `ifc.*` capability unlock (typed decline → real results),
  browser-verified at the exact deployed revision.
- **Non-goals:** no worker-authored canonical state; no WebSocket requirement
  (polling stays the honest baseline; SSE optional additive).

### INFRA-007 — Production wiring, security hardening, deployment binding

- **Depends on:** INFRA-002..006 (the surfaces to wire).
- **Scope:** Vercel project env wiring (Neon URL, R2 credentials, Upstash URL/token,
  worker claim secret — production + preview); secret rotation runbook
  (documentation); Vercel→worker claim protocol verification; the exact-head
  deployment + browser verification of the wired production (the PR #133 discipline:
  `vercel deploy --prod --meta gitsha=…`); the deployed multi-instance smoke (the
  CI↔deployed evidence split); fail-closed → wired transition evidence.
- **Acceptance (shape):** production `/api/cad` durable SAVE/OPEN round-trip through
  the visible UI; P016 commands no longer declining (durable collab/recovery/jobs in
  production); the production instance-rotation proof (the deployed restart
  equivalent); zero secrets in the repository/PRs/logs (checked).

### Successor relationship summary

```text
INFRA-001 (VERIFIED — audit + design)
  └→ INFRA-002 (ASSIGNED — Neon)
       └→ INFRA-003 (R2)
            └→ INFRA-004 (stateless requests + multi-instance proof)  ←─ COMPAT-CAD-011 builds here
                 └→ INFRA-006 (workers) ──┐
       └→ INFRA-005 (Redis) ──────────────┤
                                          └→ INFRA-007 (production wiring + verification)
```

## 4. Risk register (top items, monitored per work item)

| Risk | Mitigation |
|---|---|
| Neon cold-start latency on first request | pooled endpoint + warm caches; acceptable wake cost; measured in INFRA-002 acceptance |
| R2/S3 API drift vs MinIO in CI | the port contract + cross-backend byte-identity fixtures pin behavior |
| The v2 envelope breaking v1 clients | additive envelope; v1 compat path retained until INFRA-007 evidence retires it |
| Worker claim secret compromise | short-TTL HMAC claims, rotation runbook, least-privilege store roles |
| Undo-journal expectation mismatch after rotation | typed revert-to-parent semantics; documented; the modelHistory replay remains exact |
| Cost surprises at scale | Neon scale-to-zero, R2 zero-egress, Upstash bounded keys, worker min-replicas=1 — all monitored via the stores' own dashboards + the observability views |

## 5. Definition of done for the program (INFRA-008 candidate: closure)

- The production multi-instance proof passes on the deployed URL (create layer on
  session A → cold session B sees it and extends it → one authoritative document).
- Durable SAVE/OPEN works through the visible UI on production.
- P016 surfaces (collab/recovery/jobs) are wired and restart-proof in production.
- `ifc.*` returns real results on production through the worker service.
- All stores' failure modes fail closed typed, with zero secrets in the repository.
- The CAD roadmap's G9 golden workflow (save/reload round-trip) is green against the
  authoritative stores.
