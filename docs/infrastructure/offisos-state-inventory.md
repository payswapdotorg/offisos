# Offisos State Inventory — Serverless Persistence Audit

**Status:** DRAFT (INFRA-001 deliverable)
**Audited revision:** main `a9867a8` (branch point of `work/infra-001-persistent-serverless-foundation`)
**Machine-readable companion:** `offisos-state-inventory.json`
**Method:** full read of the governance/spec set, host wiring, the App API handler, the
CADDocument core, the persist adapters, the jobs/collab/recovery cores, the workspace
shell, CI workflows, and the production deployment evidence (PR #133).

---

## 1. Classification scheme

Every piece of state in the web host + shared app shell falls into exactly one of five
categories. The category decides the target store and the failure semantics — nothing
else does.

| Cat | Name | Rule | Target |
|---|---|---|---|
| A | Authoritative persistent | Must survive every request/rotation/process death; is the authority for its domain | Neon (transactional/registry) + R2 (immutable bodies) |
| B | Persistent artifacts | Immutable content-addressed or provenance-preserved files | R2 |
| C | Ephemeral coordination | Transient, recomputable, derivable; loss = performance only | Upstash Redis (never authority) |
| D | Presentation client | Display/interaction state; never needed for server correctness | Client (React) |
| E | Worker state | Engine/execution contexts; stateless per call | Worker service + durable job records (A) |

## 2. Category A — authoritative persistent

### ST-A01 — CADDocument versioned content (the editor working representation)

- **Where:** `app/src/caddocument/document.ts` (the class); live instance in
  `AppApiHandler.doc` (`app/src/app-api/contract.ts:575`).
- **What:** the full working document — `elements`, `layers`, `ltypes`, `textStyles`,
  `dimStyles`, `layerStates`, `blockDefs`, `xrefs`, `constraints`, `layouts`,
  `viewports`, `ucs`, `sectionPlanes`, `navigatorNodes`, `titleBlocks`, `schedules`,
  `propertyDefs`, `specialized`, `revisions`, `publisherSets`, `docsViews`,
  `docsSheets`, `ifcImports`, `draftingSettings`, `bimSettings`,
  `sourceArtifactLineage`, the `version` (VersionMeta) and `modelHistory`.
- **Identity:** `version.entity_id` is the document identity (it is also today's P016
  project key); `version_id` derives deterministically from the canonical content hash
  (`caddocument/versioning.ts`); element/table ids are document-owned deterministic
  (`el-NNNNNN` mint counters, re-derived from max ids on open).
- **Today's store:** *instance memory* between checkpoints. Autosave mints a durable
  content-addressed checkpoint every N mutating commands (bounded policy); SAVE emits a
  client file download; OPEN re-uploads the payload. **Nothing server-side holds the
  live document between checkpoints.**
- **Why category A:** LOCK-019 names CADDocument the canonical working representation —
  its committed versions are authoritative editor state (the Construction Graph remains
  the *project/asset* authority; the two are bridged, never merged).
- **Target:** Neon registry + append-only version chain; R2 content-addressed bodies
  (the snapshot serialization is already deterministic and byte-pinnable — the pinned
  parity fixtures prove it on every CI run).

### ST-A02 — Model revision history

- Immutable append-only `ModelHistory`, persisted inside the snapshot, replayed
  deterministically (`verifiedReplay`, `canonicalHashOf`). Target: R2 with the version
  body + Neon index rows for revision-number/hash lookup.

### ST-A03 — P016 project event log

- The collaboration/recovery/jobs/automation project record: `clock`, `collab`
  (members/presence/comments/activity/transactions/merge lineage), `recovery`
  (checkpoint index), `jobs`, `automation` — one authoritative record per project key,
  versioned through append-only events whose `append` is the serialization point
  (advisory-lock/create-if-absent claim + bounded retries + pure re-run transitions).
- **Current state:** postgres in CI (real service; restart-proof evidence), file on
  Electron, memory in dev, **fail-closed in production** (no store configured → typed
  `p016_persistence_unconfigured` decline; PR #133 documents that production runs with
  no external secrets).
- **Target:** Neon, promoted from the CI-proven schema; blobs to R2.

### ST-A04 — Recovery checkpoints

- Durable versioned snapshots minted by the autosave policy (N mutations) and by
  explicit `recovery.checkpoint`/`recovery.autosave`; content-addressed blobs; the
  restore path (`recovery.restore`) is proven to rebuild the canonical document
  hash-exactly **from a fresh handler** (the restart-proof CI boundary). Target: R2
  blobs + Neon index.

### ST-A05 — Job records

- The stepwise durable job machine (`queued → running → succeeded/failed`, one
  deterministic step per `jobs.tick`, working state persisted between ticks, results
  bound to the revision they were computed against, `JOB_PERSIST_HINT`: "worker output
  is never authority"). Target: Neon `jobs` table with claim lease + attempts; result
  artifacts in R2; the persistent worker service (INFRA-006) becomes an executor.

### ST-A06 — Command + idempotency records *(proposed)*

- Today commands are not journaled server-side and idempotency is instance-local
  (ST-C01). The stateless request model needs: a Neon `idempotency_keys` table (unique
  `(scope, key)` → persisted response binding) and command log rows (audit + the
  "who issued what against which revision" trail). This is additive schema, not new
  domain semantics.

## 3. Category B — persistent artifacts

| ID | Artifact | Today | Target namespace (R2) |
|---|---|---|---|
| ST-B01 | Saved workspace file (`document.save` bytes) | browser download only | `documents/{entityId}/versions/{versionId}.json` (authoritative bodies; download stays as export) |
| ST-B02 | Checkpoint snapshot blobs | P016 store (CI/Electron only in practice) | `checkpoints/{sha256}.json` (immutable, dedup by create-if-absent) |
| ST-B03 | Plot/export artifacts (SVG/PDF/plot-ir + sha256) | response payload → client download | `exports/{documentId}/{sha256}.{ext}` |
| ST-B04 | Interop files (IFC/DXF/BCF; imports preserve provenance — LOCK-012) | payload-carried; `ifc.*` typed unavailable in serverless production | `sources/{sha256}.ifc` + `exports/{sha256}.{ext}` (worker-produced) |
| ST-B05 | Engine mesh/tessellation outputs (large LOD results) | in-process cache only | `meshes/{descriptorHash}.{quality}.json` — recomputable cache-tier artifacts (never authority), R2 body + Redis index |

## 4. Category C — ephemeral coordination (Upstash Redis; never authority)

| ID | State | Today | Target key pattern (TTL) | Authority source | Loss behavior | Rebuild |
|---|---|---|---|---|---|---|
| ST-C01 | Idempotency cache | in-process LRU (1024) — **instance-local duplicate-execution defect** | `idem:{scope}:{key}` (24h) | Neon `idempotency_keys` (ST-A06) | dedup still correct (slower) | read-through on miss |
| ST-C02 | Presence/liveness | P016-record beats (deterministic clock TTL) | `presence:{projectKey}:{userId}` (PRESENCE_TTL) | P016 record (ST-A03) | liveness reads degrade to record reads | beat re-populates |
| ST-C03 | Model stream cache pages | in-process, version-keyed, non-authority contract | `cache:stream:{docId}:{version}:{page}` (bounded) | the authoritative snapshot | recompute on miss | recompute (deterministic) |
| ST-C04 | Tessellation cache | in-process, descriptor+quality keyed, dual budgets | `cache:mesh:{descriptorHash}:{quality}` + R2 body | the canonical geometry (descriptor-derived) | recompute on miss | recompute/engineer |
| ST-C05 | Engine availability probe | once per handler instance (15s budget) | `probe:engine:{engineId}` (~60s) | the probe itself | probes re-run | re-probe |
| ST-C06 | Coordination locks *(optional)* | not needed (Neon CAS / advisory locks serialize) | `lock:doc:{entityId}` (lease TTL) | Neon CAS | CAS still decides; lock is an optimization | expire |

Every Redis key above is **recomputable or derivable from A/B stores**; that is the
definition of category C and the §6 "Redis is never authoritative" rule.

## 5. Category D — presentation client (stays client-side)

- **ST-D01** workspace snapshot cache (`shell.tsx` `snapshot` state, version-monotonic
  adoption guard) — display cache of the authoritative snapshot.
- **ST-D02** view/camera/viewport state (zoom/pan/reset signals, story/viewport
  selection) — **the active COMPAT-CAD-006 scope**; their negative tests prove
  navigation never mutates the document. Category D by their own design.
- **ST-D03** command-line prompt state (`engineState` + the prompt engine).
- **ST-D04** selection UI (ephemeral §5.4 editor selection; persisted with the
  snapshot since COMPAT-CAD-001 but excluded from the version hash).
- **ST-D05** dock/palette/aids UI state.

## 6. Category E — worker state

- **ST-E01** OCCT worker processes — process-per-call (spawn python; wall-clock 15s;
  64 MiB stdout cap; prlimit address-space ceiling). Stateless per call; the target
  worker service fronts the *same JSON stdio protocol* over claim/execute HTTP.
- **ST-E02** IFC worker (IfcOpenShell 0.8.5) — disposable per-op; typed
  `ifc_unavailable` on serverless (the honest production boundary today). Target:
  runs where the toolchain is installed (the worker service).
- **ST-E03** job execution working state — already durable-per-tick (ST-A05); a
  worker is an additional ticker with a claim lease, not a stateful owner.

## 7. Cross-cutting observations (the audit's load-bearing conclusions)

1. **One root cause.** The handler singleton (`route.ts:172`) is the only holder of
   the live document. The multi-instance divergence, the cold-instance empty document,
   the instance-local idempotency, and the payload-carried SAVE/OPEN are all the same
   defect: **state placement**, not a missing feature.
2. **The discipline already exists.** The P016 port proves the correct pattern
   (serialized appends, pure transitions, content-addressed blobs, fail-closed,
   byte-identity across backends — including the `json`-vs-`jsonb` determinism
   lesson). Document persistence extends this precedent; it does not invent a new one.
3. **Production is not wired.** CI proves the durable layer; production runs with no
   store secrets, so P016 fails closed there. INFRA-002/003/007 close that gap.
4. **The engines are already honest.** The reference fallback with per-element
   `geometryEngine` provenance and the typed `ifc_unavailable` decline mean the worker
   service is a capability unlock, not a correctness fix.
5. **No tenancy exists yet.** `userId` is a payload field; the namespace reserves
   `tenants/default` and the security model documents the honest single-tenant phase-1
   boundary (LOCK-009 enforcement is deferred to the auth work item — stated, not
   claimed).
