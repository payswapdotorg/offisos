# Offisos Persistence Model — Neon / R2 / Redis

**Status:** DRAFT (INFRA-001 deliverable)
**Architecture version:** 1.1 (FROZEN — additive design within LOCK rules; no ACR required)
**Companions:** `offisos-serverless-architecture.md` (topology), `offisos-state-inventory.md` (what state exists), `offisos-worker-model.md` (execution)

---

## 1. Design rules (inherited, not invented)

1. **The port discipline is the P016 precedent** (`app/src/persist/index.ts`): a pure
   TypeScript port, host-wired backends, `append` as the serialization point, pure
   transitions re-run under contention, content-addressed immutable blobs, bounded
   retries, typed failures, fail-closed when unconfigured. Every new store follows it.
2. **Neon is authoritative for transactional/structured state** (spec §6; the CI-proven
   `p016_events`/`p016_blobs` semantics promote directly).
3. **R2 is authoritative for immutable object content** (spec §6; the
   content-addressed/checkpoint/export/source artifacts).
4. **Redis is never authoritative** (spec §6): every key is recomputable or derivable;
   loss degrades performance, never correctness.
5. **Determinism is a persistence requirement**: persisted state must round-trip
   byte-exactly (the `json`-not-`jsonb` lesson from `p016-postgres.ts`); persisted
   outputs are pure functions of canonical inputs (no wall-clock/random in data paths).
6. **LOCK-019**: persisted document state is the CADDocument working representation
   with versioning and provenance — never a competing Construction Graph. Promotion to
   graph state stays on the existing bridge.

## 2. Neon PostgreSQL — authoritative transactional state

### 2.1 Connection & runtime model

- Serverless-honest pooling (the existing adapter pattern): small per-instance pool
  (`max: 3`, 10s idle/connect timeouts) — Neon's pooled connection string
  (`-pooled` endpoint) handles instance churn; scale-to-zero is acceptable (first
  request pays the wake).
- One app role with least-privilege grants; migrations are idempotent DDL
  (`CREATE TABLE IF NOT EXISTS` + in-place column migration) — the existing
  `p016-postgres.ts` migration discipline.
- All authoritative writes go through the App API (the function); the worker service
  writes only its job-claim/result rows and its R2 namespace.

### 2.2 Schema (v1 — additive over the proven P016 tables)

```sql
-- (existing, promoted unchanged from the CI-proven adapter)
-- p016_events (project_key TEXT, n BIGINT, state JSON, created_at TIMESTAMPTZ)
--   PK (project_key, n) — the append-only project event log; serialization via
--   advisory lock + PK claim.
-- p016_blobs (sha TEXT PK, content JSON, created_at) — content-addressed blobs.
--   NOTE: with R2 wired (INFRA-003), new checkpoint blob BODIES go to R2; this table
--   remains the compatibility/CI backend and the small-blob fast path. The port
--   contract is unchanged — backends differ, byte-identity holds.

-- === Document registry (new — INFRA-002) ===
CREATE TABLE IF NOT EXISTS documents (
  entity_id        TEXT PRIMARY KEY,          -- version.entity_id (the document identity)
  tenant           TEXT NOT NULL DEFAULT 'default',  -- reserved (LOCK-009; enforcement with auth)
  format           TEXT NOT NULL,
  format_version   TEXT NOT NULL,
  created_by       TEXT NOT NULL,
  head_version_id  TEXT NOT NULL,             -- CAS target
  head_version_number BIGINT NOT NULL,
  head_content_hash TEXT NOT NULL,            -- the canonical content-only hash
  head_model_revision BIGINT NOT NULL,        -- modelHistory head number
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- === Append-only version chain (new — INFRA-002) ===
CREATE TABLE IF NOT EXISTS document_versions (
  entity_id       TEXT NOT NULL REFERENCES documents(entity_id),
  version_id      TEXT NOT NULL,              -- deterministic (content-hash derived)
  parent_version_id TEXT,                     -- NULL only for the root
  version_number  BIGINT NOT NULL,
  content_hash    TEXT NOT NULL,
  model_revision  BIGINT NOT NULL,
  body_ref        TEXT NOT NULL,              -- R2 object key (content-addressed)
  body_bytes      BIGINT,                     -- observability
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, version_id),
  UNIQUE (entity_id, version_number)
);
CREATE INDEX IF NOT EXISTS document_versions_head
  ON document_versions (entity_id, version_number DESC);

-- === Command + idempotency records (new — INFRA-002/004) ===
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope           TEXT NOT NULL,              -- e.g. 'command:<documentId>'
  idem_key        TEXT NOT NULL,              -- the wire idempotencyKey
  request_hash    TEXT NOT NULL,              -- SHA-256 of the canonical request
  response_binding TEXT NOT NULL,             -- serialized response or result ref
  applied_version TEXT NOT NULL,              -- version_id the command produced
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, idem_key)
);

CREATE TABLE IF NOT EXISTS command_log (
  seq             BIGSERIAL PRIMARY KEY,      -- audit order (NOT the domain clock)
  entity_id       TEXT NOT NULL,
  command_name    TEXT NOT NULL,
  base_version_id TEXT NOT NULL,
  result_version_id TEXT,
  idem_scope      TEXT,
  idem_key        TEXT,
  actor           TEXT,                       -- userId once auth exists (honest NULL now)
  ok              BOOLEAN NOT NULL,
  err_code        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS command_log_doc
  ON command_log (entity_id, seq);

-- === Jobs (new — INFRA-006; promotes the P016 jobs section to claimable rows) ===
CREATE TABLE IF NOT EXISTS jobs (
  job_id          TEXT PRIMARY KEY,           -- job-NNNNNN (existing mint discipline)
  entity_id       TEXT NOT NULL,
  kind            TEXT NOT NULL,              -- closed vocabulary (existing JOB_KINDS + engine kinds)
  status          TEXT NOT NULL,              -- queued|claimed|running|succeeded|failed|retired
  step            BIGINT NOT NULL DEFAULT 0,
  total_steps     BIGINT NOT NULL,
  params          JSON NOT NULL,
  work            JSON NOT NULL DEFAULT '{}', -- deterministic per-step working state
  input_binding   JSON NOT NULL,              -- {versionId, versionNumber, contentHash, modelRevision}
  result_ref      TEXT,                       -- R2 key (report artifact) — never authority
  failure         JSON,
  attempts        BIGINT NOT NULL DEFAULT 0,
  max_attempts    BIGINT NOT NULL DEFAULT 3,
  claim_lease_until TIMESTAMPTZ,              -- worker claim lease (heartbeat-extended)
  claimed_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_claimable ON jobs (status, created_at);
```

### 2.3 Transaction boundaries (the request commit)

The **commit of a mutating command** is one Neon transaction:

```text
BEGIN;
  1. SELECT ... FROM documents WHERE entity_id = $doc FOR UPDATE;          -- CAS base
     -- mismatch with the request's baseRevision → ROLLBACK, typed
     -- document_conflict response with current head + intervening versions
  2. INSERT INTO document_versions (…);                                     -- the new version
  3. UPDATE documents SET head_version_id = $new, … WHERE entity_id = $doc;
  4. INSERT INTO idempotency_keys (…) — on conflict → the persisted binding (replay)
  5. INSERT INTO command_log (…);
COMMIT;                                                                     -- the serialization point
```

- The R2 object put happens **before** the transaction (content-addressed: the object
  key is the content hash — a pre-put is idempotent and a rolled-back transaction
  leaves an unreferenced, harmless object; GC sweeps orphans later). This avoids
  two-phase-commit without risking a referenced-but-missing body: the transaction only
  commits when the body provably exists (`head`/`exists` check).
- Contention semantics: exactly one writer wins per base revision; the loser receives
  the typed conflict (the `collab.commit` precedent — intervening transactions +
  overlapping canonical element ids; explicit rebase/discard by the client, never a
  silent merge).
- P016 events keep their own serialization point (advisory lock / PK claim) — the two
  logs stay decoupled as they are today (the P016 record is per project key; the
  document version chain is per document identity; they already interlock via
  `p016ProjectKey()` = `entity_id`).

### 2.4 Optimistic concurrency rules

- Mutating requests carry `(documentId, baseRevision)`.
- CAS on `head_version_id`; conflicts are typed, data-carrying, reproducible.
- `document.create` mints a new registry row (root version); `document.open` binds to
  an existing registry row (open-by-id) — the payload-carried snapshot path remains
  for import/compat (stamped as a new document identity when it carries no known id).
- Job results carry `input_binding`; a result whose input binding no longer matches
  the head is rejected typed (`stale_revision`) — "worker output never authority".

### 2.5 Tenant isolation (honest boundary)

- `documents.tenant` defaults to `'default'` and is **not yet enforced** — the app has
  no authentication today (`userId` is a payload field). The column reserves the
  LOCK-009 namespace; enforcement (row-level security or query scoping) arrives with
  the auth work item. This is stated in the security model, not silently assumed.

## 3. Cloudflare R2 — authoritative object storage

### 3.1 Namespace (derived from the app's identity model)

```text
tenants/{tenant}/                                   (phase 1: tenants/default)
  documents/{entity_id}/
    versions/{version_id}.json                      (immutable; the CADDocumentSnapshot body —
                                                     content-addressed: version_id derives from
                                                     the content hash; identical content = identical id
                                                     = idempotent re-put)
    checkpoints/{content_sha256}.json               (immutable, dedup — today's P016 blob semantics)
    exports/{format}/{content_sha256}.{ext}         (plot SVG/PDF/plot-ir, DXF, IFC exports)
    sources/{content_sha256}.{ext}                  (imported artifacts — provenance preserved, LOCK-012)
  jobs/{job_id}/
    result-{content_sha256}.json                    (job report artifacts — never authority)
  meshes/{descriptor_hash}/{quality}.json           (recomputable cache-tier artifacts, INFRA-006)
```

- All keys content-addressed where the content defines identity; write-once semantics
  via create-if-absent (`If-None-Match: *`) — the proven `BlobP016Persist` claim
  pattern on S3-compatible API.
- The existing Vercel Blob adapter remains a legal backend for the same port (local
  parity + migration safety); R2 is the target for cost (zero egress) and portability
  (S3 API). The choice is a wiring decision, not a semantic one — the port contract
  keeps them interchangeable.
- Version bodies are immutable and deduplicated by construction: two commands that
  produce identical content produce identical `version_id`s (deterministic versioning
  already guarantees this).

### 3.2 Read path

- Resolve `(documentId, revision)` → Neon registry row → `body_ref` → R2 GET.
- Warm caches (in-process LRU by `version_id` + Redis availability index) are
  non-authoritative: a cache entry is validated by the registry (hash compare) before
  use — the ModelStreamCache "revalidate against the CURRENT canonical version, stale
  entries never served" contract generalized.
- `recovery.restore` semantics generalize: any fresh instance rebuilds the canonical
  document through `CADDocument.open(body)` + hash-exact validation — the restart-proof
  flow, now the *normal* load path.

## 4. Upstash Redis — ephemeral coordination (never authority)

Every key declares: pattern, TTL, authority source, failure behavior, rebuild strategy.

| Key pattern | TTL | Authority | On loss | Rebuild |
|---|---|---|---|---|
| `idem:{scope}:{key}` → response binding | 24h | Neon `idempotency_keys` | dedup slower, still correct | read-through on miss (Neon insert wins; Redis caches the winner) |
| `presence:{projectKey}:{userId}` → member snapshot | PRESENCE_TTL | P016 record (ST-A03) | liveness reads fall back to the record | next beat |
| `cache:stream:{docId}:{version}:{page}` → page payload | bounded LRU | the authoritative version body | recompute page | deterministic recompute |
| `cache:mesh:{descriptorHash}:{quality}` → mesh artifact ref | bounded | canonical geometry (descriptor) | recompute/engineer | R2 body or engine re-run |
| `probe:engine:{engineId}` → probe verdict | ~60s | the probe itself | probes re-run | re-probe |
| `lock:doc:{entityId}` (optional) | lease TTL | Neon CAS | CAS still decides | expire/retake |

Rules:

- Redis is a **cache/coordination tier only**; there is no write path where Redis is
  the sole record of a decision. The idempotency INSERT happens in the Neon
  transaction; Redis mirrors the winner.
- Eviction/limits: Upstash eviction or app-side bounded sets; the app treats Redis as
  best-effort at every call site (typed `cache_unavailable` must never fail a command
  that doesn't need the cache).
- Local dev: `OFFISOS_PERSIST=memory` keeps everything in-process (Redis entirely
  optional; `REDIS_URL` unset → skip cache tier, honest via observability view).

## 5. Local development model

| Mode | Env | Stores | Evidence |
|---|---|---|---|
| Pure local (default dev) | `NODE_ENV=development`, nothing set | in-process memory (current behavior, unchanged) | existing dev smokes |
| Real stores | `DATABASE_URL` (+ R2 or MinIO, + `REDIS_URL`) | Neon/dev-postgres + R2-compatible + Redis | byte-identical fixtures across backends (the P016 cross-backend pinnable contract) |
| CI proof | postgres service + MinIO + redis (compose action) | the multi-instance proof job (section 6) | deterministic two-handler suite |
| Production | Vercel env wiring (INFRA-007) | Neon + R2 + Upstash + worker | exact-head deployment + browser evidence |

The fail-closed rule is preserved everywhere: a production host without configured
stores declines typed (`p016_persistence_unconfigured` today;
`documentstore_unconfigured` for the new port) — never a silent in-memory degradation.

## 6. The multi-instance proof (test specification for INFRA-004)

Deterministic suite (the restart-proof/host-parity pattern extended):

```text
Backends: real postgres + an R2-compatible endpoint (MinIO in CI, R2 in prod-parity)
A = fresh AppApiHandler wired to the DocumentStore (Neon+R2 adapters)
B = a SECOND fresh handler, same store wiring, same documentId

1. A: document.create → drafting.addLayer("WALLS")         (version v1 → v2)
2. B: entity.create on layer "WALLS"                        (loads authoritative v2, commits v3)
   ASSERT: B resolved the layer A created (authoritative load, not own memory)
   ASSERT: version chain v1→v2→v3 linear, monotonic, one model history
3. A: document.getState                                      (fresh read)
   ASSERT: A now returns B's entity (converged on the store)
4. C = a THIRD cold handler: document.getState by id
   ASSERT: C reads the same authoritative document (cold-start divergence disproven)
5. Concurrency: A and B commit concurrently from the same baseRevision
   ASSERT: exactly one CAS wins; the loser receives typed document_conflict carrying
   the current head + the intervening versions; no lost update, no silent merge
6. Idempotency: A and B replay the same idempotencyKey for a mutating command
   ASSERT: one execution; both receive the persisted response binding
```

Deployed equivalent: the collab/durability smoke against the wired production stores
(the existing CI↔deployed evidence split — `collab-p016-smoke.mjs` + restart-proof
against `DATABASE_URL`/`BLOB_*` become the Neon/R2 wiring's acceptance instruments).

## 7. Migration & compatibility

- **No data migration exists today** — production has no persisted state to migrate
  (fail-closed; client-held files only). The migration is wiring + adapter rollout,
  not a data backfill. CI/Electron P016 stores keep their schemas (promoted, not
  rewritten).
- **Wire compatibility:** `WireEnvelope` v1 keeps working; v2
  (`{ api: "2", documentId, baseRevision, body }`) is additive — a v1 request binds
  to the handler-local session (compat mode) exactly as today, so no client breaks
  during rollout. The Electron host adds a `LocalDocumentStore` (directory adapter)
  for parity with its `FileP016Persist`.
- **Rollback:** each phase is independently revertible (env wiring off → fail-closed
  or memory; the ports make the backends swappable — the LOCK-003 discipline applied
  to persistence, exactly as the engine-availability pattern does for engines).

## 8. Cost & operational notes

- Neon: scale-to-zero fits the current traffic (a cold first request pays a wake);
  the pooled endpoint absorbs instance churn; storage is the version bodies' index
  (bodies live in R2).
- R2: zero egress; content-addressed dedup means repeated saves of identical content
  cost nothing new; the largest objects (meshes, IFC sources) are cache-tier or
  provenance artifacts, not hot-path reads.
- Upstash: the free/low tiers cover idempotency + presence at current scale; every
  key is bounded.
- GC: orphaned R2 objects (pre-put without a committed transaction) are swept by a
  periodic job comparing the bucket listing to the registry (an INFRA-006 job kind —
  the deterministic-step discipline applies to maintenance too).
