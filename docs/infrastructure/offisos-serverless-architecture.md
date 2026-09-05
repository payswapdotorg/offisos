# Offisos Serverless Architecture — Persistent State Foundation

**Status:** DRAFT (INFRA-001 deliverable — implementation/analyst output, pending independent Architect review)
**Architecture version:** 1.1 (FROZEN — this document designs WITHIN the frozen architecture; it changes nothing)
**Work item:** INFRA-001 — `governance/work-items/INFRA-001.json`
**Scope:** Web host (`apps/web`, Vercel deployment) + the shared app shell (`app/src`) persistence topology.
**Non-scope:** no code changes, no protected-path modifications, no ACR.

---

## 1. Why this document exists

The production black-box benchmark (CAD-BENCH-RW-001, plus every real-browser session against
`https://offisos.vercel.app`) exposed a **serverless state problem**: the deployed `/api/cad`
route holds the open `CADDocument` inside a **module-level handler singleton**
(`apps/web/src/app/api/cad/route.ts:172`, `const handlerPromise = createHandler()`).
Vercel runs the route on multiple concurrent function instances and recycles them freely, so:

- Request A lands on instance A → the handler singleton holds document state A.
- Request B lands on instance B → the handler singleton holds a *different* (possibly empty,
  possibly stale) document state B.
- A cold instance starts with an **empty document** (`CADDocument.empty("web-workspace")`) —
  any command arriving there acts on the wrong document.
- Instance recycling silently discards everything the handler accumulated since the last
  durable checkpoint.

This is not a bug to patch inside the handler; it is a **request-model and authority
placement question**. This document answers it with evidence drawn from the repository audit
(INFRA-001, section 3) and defines the target topology, the request lifecycle, the
persistence model, the worker model, and the dependency-ordered migration path.

The design target model:

```text
Vercel (application platform — evidence-driven, not ideological)
  ↓ stateless application/API
  ↓ authoritative persistent state
  ├── Neon PostgreSQL      (authoritative transactional state)
  ├── Cloudflare R2        (object storage: versions, checkpoints, artifacts)
  └── Upstash Redis        (ephemeral coordination ONLY — never authoritative)
  ↓ persistent asynchronous work
  ↓ CAD/BIM workers (Railway primary / Cloud Run alternative — see offisos-worker-model.md)
```

This is the Storage section of the frozen architecture applied to the web host:
`spec/architecture.md` §6 already fixes the authority split — *PostgreSQL: authoritative
structured domain state; object storage: large files and immutable artifacts;
Redis/queue layer: transient coordination, job queues, caching and locks — never
authoritative*. The Vercel platform stays because it is what is actually deployed
(project `offisos`, `prj_p4IGIM5pBpL8pgVdfJhczR789BFL`; production deployment
`dpl_2keo5yEQ3o3WnHncF6ggGMoqjAvm` from main `f4a1a73`); the state moves out of the
function instance and into the §6-authoritative stores.

## 2. Non-negotiable constraints (from the frozen architecture)

| Rule | Consequence for this design |
|---|---|
| LOCK-019 — Construction Graph is the canonical project/asset system of record; CADDocument is the editor/working representation | Document persistence (Neon/R2) persists the **CADDocument working representation with versioning and provenance**; it must never become a competing Construction Graph. The existing graph bridge (`app/src/graph/bridge.ts`) remains the only promotion path. |
| LOCK-005 — authoritative changes are versioned and traceable | Every persisted document mutation is an append-only version with deterministic id (already true in `caddocument/versioning.ts`); Neon records the version chain, R2 stores the content-addressed bodies. |
| LOCK-007 — never present an inferred/guessed value as observed fact | Cross-instance reads load the *authoritative* snapshot, never a guessed merge; conflicts return typed responses; malformed persisted records are rejected (`validatePersistedP016State` precedent). |
| LOCK-009 — tenant/project/resource access enforced server-side | The current app has **no auth/tenancy**; the schema reserves the namespace and the security model documents the honest single-tenant phase-1 boundary. Tenancy enforcement arrives with the auth work item, not invented here. |
| LOCK-010 — secrets never ordinary application data | Store credentials live only in Vercel env vars / worker env; never in code, fixtures, docs, PR bodies. |
| LOCK-017/018 — shared web/desktop core; renderer never sees engines/hosts concerns | The persistence boundary is host wiring (the `P016Persist` precedent — "the engine-adapter pattern at LOCK-003 applied to persistence"); the shared core stays pure. |
| Determinism (`IMPLEMENTATION.md`) — semantic results are pure functions of canonical inputs | The persisted document state, the project clock, and job outputs stay deterministic; caches are recomputable and never authoritative. |

## 3. Audit findings (the evidence base)

Full detail: `offisos-state-inventory.md` (+ `.json`). The load-bearing findings:

1. **The handler singleton is the whole session.** `AppApiHandler` holds `this.doc`
   (all document tables), the undo/redo journals, the in-memory `IdempotencyCache`
   (LRU, 1024 entries), the tessellation cache, the model stream cache and the session
   counters. Nothing about the *document* survives the instance except the P016
   checkpoint blobs (see 3).
2. **Production runs with no external secrets** (PR #133 deployment guide evidence:
   "the engine-free CAD/BIM demo … runs with no external secrets"). Therefore in
   production `createP016Persist()` resolves to `FailClosedP016Persist`: every
   `collab.*` / `recovery.*` / `jobs.*` command declines with the typed
   `p016_persistence_unconfigured` error. The durable P016 backends are exercised in
   **CI only** (postgres service; restart-proof script). The `BlobP016Persist`
   (Vercel Blob) path is wired but not production-configured.
3. **A durable persistence port already exists and is proven.** `P016Persist`
   (`app/src/persist/index.ts`): append-only event log with `append()` as the
   serialization point, pure transitions re-run under contention, content-addressed
   immutable blobs, bounded retries, typed failures. Backends: memory (dev/tests),
   file (Electron), **postgres** (`p016_events`/`p016_blobs`, advisory-lock
   serialization, `json` (not `jsonb`) for byte-identity), **blob** (Vercel Blob,
   create-if-absent claims). The CI restart-proof (`collab-p016-restart-proof.mjs`)
   proves process-death durability through postgres; `recovery.restore` rebuilds the
   canonical document hash-exactly **from a fresh handler**.
4. **Autosave checkpoints are the only durable document state** — minted every N
   mutating commands (`DEFAULT_RECOVERY_POLICY`), stored as content-addressed blobs.
   Between checkpoints, and on any non-P016 command path, the live document exists
   only in instance memory. The client-side SAVE is a **browser file download**
   (`shell.tsx` `executeFileSave` → `document.save` returns bytes → download link);
   OPEN uploads the snapshot/bytes back in the request payload.
5. **Idempotency is instance-local.** `IdempotencyCache` is a bounded in-process map.
   The same `idempotencyKey` hitting a second instance re-executes the command —
   duplicate execution under retry/rotation.
6. **The engine boundary is already serverless-honest.** `OFFISOS_GEOMETRY_ENGINE=auto`
   probes OCCT once and falls back to the deterministic reference engine
   (provenance-recorded per element); `ifc.*` fails typed `ifc_unavailable` without the
   toolchain. Process-per-call OCCT/IFC workers (stdio JSON, wall-clock timeout,
   byte-capped stdout, prlimit address-space ceiling) are the right *protocol* to front
   a persistent worker service.
7. **Jobs are already a durable stepwise state machine** (`app/src/jobs/index.ts`):
   queued → running → terminal, one deterministic step per `jobs.tick`, persisted
   through the P016 record, output bound to the revision it was computed against
   (`revisionBinding`), "worker output never authority". This is the seed of the
   async-job model; what is missing is an *executor* that ticks without a client
   driving it.
8. **The document model is persistence-ready.** `CADDocumentSnapshot` is a stable,
   deterministic, byte-pinnable JSON serialization (additive-optional tables; content
   hash derived version ids; immutable `modelHistory`). Mint counters are derived on
   open from max ids; undo/redo journals are deliberately session-scoped (a reopened
   document has empty journals — standard CAD semantics).

## 4. Target topology

### 4.1 Request path (stateless)

```text
Browser / Electron / Agent
  → POST /api/cad  (WireEnvelope v2 — additive; v1 stays compatible)
      { api: "2", documentId, baseRevision, body: CommandQueryRequest }
  → Vercel function (any instance, cold or warm)
      1. load authoritative snapshot for (documentId, baseRevision) — R2 (content-addressed)
         through a Neon registry read; small warm caches (in-process + Redis) are
         non-authoritative and keyed by version_id
      2. materialize CADDocument (CADDocument.open — the existing canonical path)
      3. validate + execute the command (the existing pure core — unchanged)
      4. commit: append the new version (Neon CAS on the version registry + R2 put of
         the content-addressed snapshot) — the P016 "append is the serialization
         point" pattern, one transaction, bounded retries
      5. respond with the result + the new revision binding
  → conflicts (baseRevision ≠ current head) return the typed conflict response
     with the current head and intervening versions (the collab transaction
     machinery already models reproducible conflict records)
```

Phase discipline: the handler keeps its current shape behind a boundary. The
`DocumentStore` port (below) is introduced the way `P016Persist` was — host wiring,
pure core, additive, fail-closed honesty preserved.

### 4.2 Store responsibilities (details in offisos-persistence-model.md)

| Store | Authority | Contents | Failure behavior |
|---|---|---|---|
| **Neon PostgreSQL** | Authoritative transactional state | Document registry + append-only version chain + command/idempotency records + P016 project event log (promoted from the CI-only tables) + job records + audit | Hard dependency: writes fail-closed with typed errors (no silent degradation — the established pattern) |
| **Cloudflare R2** | Authoritative object storage | Immutable content-addressed artifacts: document version bodies, checkpoint snapshots, plot exports, interop files (IFC/DXF), imported source artifacts (provenance preserved, LOCK-012) | Read misses are typed `not_found`; writes idempotent by content hash |
| **Upstash Redis** | **Never authoritative** | Idempotency read-through cache, presence/liveness, mesh/stream caches, short-lived coordination locks, engine-probe memoization | Loss = performance degradation only; every key is recomputable or derivable from Neon/R2; keys documented with TTL + rebuild strategy |
| **CAD/BIM worker service** | Executes engine work; output is never authority | OCCT geometry realization, IFC import/export, tessellation, heavy regeneration — claim → execute → persist result artifacts + revision binding | Jobs time out/retire typed; results rejected on revision mismatch; nothing a worker writes becomes canonical without the explicit document command path |

### 4.3 What stays exactly where it is

- The **Construction Graph** authority and the graph bridge — untouched (LOCK-019).
- The **AppApiHandler command surface** (100+ commands) — untouched; the envelope and
  the storage boundaries change, the semantic contract does not.
- The **renderer/workspace core** (`apps/web/src/cad/*`, pure, engine-free) — untouched.
- The **Electron host** — keeps `FileP016Persist` and its local-file save/open flow; the
  same shared `DocumentStore` port gains a local-directory adapter for parity.
- The **engine-adapter boundary** (LOCK-003/018) — the worker service fronts the SAME
  JSON worker protocol that `occt-process.ts`/`ifc-process.ts` speak today.

## 5. Serverless request lifecycle (the concurrency contract)

1. **Document binding.** A session opens a document by id; every mutating request
   carries `(documentId, baseRevision)`. Queries carry the document reference and
   may read any committed revision (Time Machine-friendly, LOCK-006).
2. **Optimistic concurrency.** The commit is a compare-and-swap on the version
   registry: `UPDATE ... WHERE head_version = $baseRevision`. Exactly one writer
   wins; the loser receives a typed `document_conflict` response containing the
   current head, the intervening version list, and the overlapping canonical
   element ids — the same shape `collab.commit` already produces for transactional
   conflicts. The client may rebase (re-apply on the fresh head) or discard —
   explicit, never a silent merge.
3. **Idempotency.** Commands with an `idempotencyKey` insert into the Neon
   idempotency table inside the same transaction as the command record (unique key
   on `(scope, key)`); Redis is a read-through cache with TTL. A replayed key
   returns the persisted response binding — instance-independent.
4. **Revision-bound results.** Every successful response carries the new revision
   binding (`version_id`, `version_number`, `content_hash`, `model_revision`) —
   jobs, plots, and interop outputs bind to the revision they were computed
   against (the existing `revisionBinding` pattern), so stale results are
   detectable and rejectable.
5. **Session/document swap.** `document.create`/`document.open` remain the epoch
   boundaries (the existing `docEpoch` guard); under v2 they operate on server-side
   references (open-by-id) instead of payload-carried snapshots.
6. **Undo/redo.** The undo journal remains session-scoped presentation state
   (category D in the inventory): a reopened or rotated-in session re-derives
   history from the immutable `modelHistory` (the `verifiedReplay` path already
   proves deterministic replay). Undo across instances therefore degrades to
   "revert to parent version" semantics — an explicit, typed outcome, never a
   fabricated journal.

## 6. Multi-instance proof obligation (the acceptance test)

The divergence must be *disproven by test*, not argued. The proof (specified for
INFRA-004, patterned on the existing restart-proof + host-parity suites):

```text
Given one real Postgres (Neon-compatible) + R2-compatible object store,
  Instance A (fresh handler): document.create → drafting.addLayer("WALLS")
  Instance B (a SECOND fresh handler, same store, same documentId):
      entity.create on layer "WALLS"
  Assert:
    - B sees A's layer (B loaded the authoritative snapshot — not its own memory)
    - the version chain is linear and monotonic across both instances
    - one model history; A's next read returns B's entity
    - a third cold instance C reads the same authoritative document
    - concurrent conflicting writes: exactly one commits, the other gets the typed
      document_conflict with the intervening versions
```

CI shape: a dedicated job (postgres service + an S3-compatible local store such as
MinIO, or the R2 endpoint itself) running the deterministic two-handler suite; the
deployed equivalent runs the collab smoke against the wired production stores —
the same CI↔deployed evidence split the repo already uses.

## 7. Security model

- **Secret placement.** `DATABASE_URL`, R2 credentials, `UPSTASH_REDIS_*`,
  worker claim secret: Vercel project env vars (production + preview) and the
  worker service env. Never in the repository, PR bodies, fixtures, or logs
  (LOCK-010; AGENTS.md Security). Local dev uses explicit opt-ins
  (`OFFISOS_P016_PERSIST=memory` precedent) and `.env*` is gitignored.
- **Store access.** The Vercel functions are the only writers to Neon/R2 for
  canonical state; the worker service writes only to its result namespace and job
  records. R2 tokens are scoped per-bucket; Neon uses a dedicated app role with
  least-privilege grants.
- **Worker ingress.** Job claims are HMAC-signed (per-job nonce, short TTL);
  the worker endpoint is not publicly invocable without a valid claim. Results are
  written with revision bindings and rejected on mismatch.
- **Tenancy.** Honest phase-1 boundary: the current application has NO
  authentication — `userId` is a command payload field. This design reserves the
  namespace (`tenants/default/…`) and keeps every store keyed by document id, but
  it does not fabricate enforcement. Server-side enforcement arrives with the auth
  work item (LOCK-009 is a stated requirement, not a claim of current state).
- **Audit.** The command/idempotency records give the "who issued what against
  which revision" trail the audit module will consume; the governance record
  discipline (revision-bound evidence) is the process-level mirror.

## 8. Local development model

- `OFFISOS_PERSIST=memory` (default in `NODE_ENV=development`): everything
  in-process, deterministic, no services — the current dev experience, unchanged.
- `DATABASE_URL` (+ R2/dev endpoint): the real backend path — same code, same
  determinism, byte-identical fixtures (the `json`-not-`jsonb` lesson).
- Docker compose (later work item): postgres + MinIO (R2-compatible) + redis —
  one-command local parity with the CI proof job.
- The fail-closed rule stays: production with unconfigured stores declines typed,
  it never silently degrades to memory.

## 9. Migration strategy (zero/low risk, dependency-ordered)

Principle: **no step requires freezing the CAD roadmap**, and every step is
independently verifiable and reversible. The CAD workstream (COMPAT-CAD-006 → …)
continues on its own branch/PR cadence; these infra work items touch host wiring
and additive ports, not the CAD semantics under remediation.

| Phase | Work item | Delta | Risk |
|---|---|---|---|
| 0 (this PR) | INFRA-001 | Documentation only — zero code, zero protected paths | None |
| 1 | INFRA-002 (Neon) | `DocumentStore` port + Neon adapters + registry schema; CI job against real postgres; env wiring optional; production unchanged until wired | Low — additive port, fail-closed default |
| 2 | INFRA-003 (R2) | Object store adapter + content-addressed namespace; checkpoint blobs gain an R2 backend; SAVE gains a server-side durable path (client download stays available) | Low — additive |
| 3 | INFRA-004 (stateless requests) | WireEnvelope v2 (documentId + baseRevision), CAS + typed conflicts, multi-instance proof in CI; v1 envelope keeps working (compat session path) | Medium — request-shape change, additive + heavily tested |
| 4 | INFRA-005 (Redis) | Idempotency read-through, presence, caches — all non-authoritative | Low |
| 5 | INFRA-006 (workers) | Persistent CAD/BIM worker service (Railway primary / Cloud Run alt), job claim protocol, engine-backed jobs in production | Medium — new service, new trust boundary |
| 6 | INFRA-007 (production wiring) | Vercel env wiring, secret runbook, deployment binding evidence, browser verification against wired production | Medium — production change, evidence-gated |

Coordination note for the Architect: the CAD roadmap's **COMPAT-CAD-011 (durable
SAVE/OPEN/reload-safe document persistence, currently PLANNED)** is the CAD-side
consumer of the INFRA-004 surface. Sequencing INFRA-004 ahead of COMPAT-CAD-011
avoids double-building document persistence; COMPAT-CAD-011 then implements the
user-facing SAVE/OPEN workflow on the authoritative stores rather than patching
the instance-local handler.

## 10. Decision record (summary)

| Decision | Choice | Rejected alternative | Why |
|---|---|---|---|
| Application platform | Vercel (stay) | Re-platform to a long-running server | Evidence-driven: production is already Vercel; the defect is state placement, not the platform; re-platforming is a larger risk with no benchmarked payoff |
| Authoritative structured store | Neon PostgreSQL | Plain Postgres on a VM; Vercel Postgres | Serverless-compatible (connection proxy, scale-to-zero), branch-for-preview-story, same `pg` wire protocol as the existing CI-proven adapter |
| Object store | Cloudflare R2 | Vercel Blob; S3 direct | S3-compatible API (portability), zero egress (CAD artifacts are large), content-addressed immutable semantics already match the blob adapter contract; Vercel Blob remains a valid adapter (the port stays) |
| Coordination | Upstash Redis | Vercel KV; in-memory only | REST + native clients that work on serverless; but strictly non-authoritative — any Redis loss is recoverable by design |
| CAD workers | Railway primary / Cloud Run alternative | ECS/Fargate; Modal; in-Vercel engines | Workers need warm processes + pinned Python toolchain + subprocess isolation; see offisos-worker-model.md decision matrix |
| Concurrency model | Optimistic CAS + typed conflicts | Distributed locks as authority | Matches the existing collab transaction semantics; LOCK-007-honest; works across arbitrary instances |
| Idempotency | Neon table (authority) + Redis cache (speed) | In-memory only (today) | Instance-independent correctness; bounded storage; TTL cleanable |

## 11. Relation to the existing document set

- `spec/architecture.md` §6 — this design *implements* that storage split for the web host.
- `spec/architecture-lock.md` — no LOCK rule is modified; each is mapped in section 2.
- `docs/cad/autocad-parity-roadmap.md` — COMPAT-CAD-011 dependency coordination (section 9).
- `app/src/persist/index.ts` — the P016 port is the architectural precedent this design extends (same discipline: port + pure transitions + serialization point + fail-closed).
- `apps/web/src/app/api/cad/route.ts` — the audit's primary finding site (the handler singleton).
- PR #133 — the production deployment reality (no secrets, manual `--prod`, gitsha-bound).
