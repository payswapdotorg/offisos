# Offisos Infrastructure Roadmap — Dependency-Ordered Work Items

**Status:** ACTIVE — INFRA-001 VERIFIED; INFRA-002 ASSIGNED
**Verified foundation:** INFRA-001 @ `0e94680bcedc20bcfb4d4d51eeefb089d7e45665`
**Current successor:** INFRA-002 — Neon PostgreSQL foundation (authoritative transactional store)
**Purpose:** the authoritative decomposition of the persistent serverless foundation into releasable, independently verifiable work items, derived from the INFRA-001 audit (`offisos-state-inventory.md`, `offisos-persistence-model.md`, `offisos-worker-model.md`).
**Sequencing authority:** the Architect releases successors per `docs/governance/architect-return-protocol.md` §7 — records are born `DRAFT` by the Architect at release time. This document defines the scope/order; governance records establish legal lifecycle state.

## Current release state

- **INFRA-001:** VERIFIED at merge commit `0e94680bcedc20bcfb4d4d51eeefb089d7e45665`; PR #141; Architect decision `DEC-001` approved and `DEC-002` verified.
- **INFRA-002:** ASSIGNED; depends on INFRA-001 VERIFIED; worker: `z-ai-infra-agent`.
- **COMPAT-CAD-007:** remains independently ASSIGNED; it is not blocked by INFRA-002.
- **COMPAT-CAD-011:** remains coordinated behind INFRA-002/003/004 for durable SAVE/OPEN on the authoritative stores.

---

## 1. Decomposition principles

1. **Every item is independently verifiable and revertible** (the phase table in `offisos-serverless-architecture.md` §9).
2. **No item requires freezing the CAD roadmap.** All items touch host wiring, additive ports, or new services — not the CAD semantics under remediation. The one coordination point is COMPAT-CAD-011 (below).
3. **Fail-closed honesty is preserved at every step**: unconfigured production stays functional (reference engines, client-held files) and declines typed on new surfaces.
4. **Evidence-gated**: each item's acceptance is deterministic tests + CI + (where production-affecting) exact-head deployment + browser verification — the repo's established loop.

## 2. Coordination with the CAD roadmap

`docs/cad/autocad-parity-roadmap.md` defines **COMPAT-CAD-011 — Durable SAVE/OPEN/reload-safe document persistence (PLANNED)**, gated on the G9 golden workflow (save/reload/DXF round-trip; DEF-009/010).

- **Sequencing recommendation:** INFRA-002/003/004 land first; COMPAT-CAD-011 then implements the user-facing durable SAVE/OPEN workflow **on** the authoritative stores instead of patching the instance-local handler (avoiding double-built persistence and later rework).
- If the CAD roadmap must proceed before INFRA-004 is VERIFIED, COMPAT-CAD-011's scope should stay Electron-file-first (the `FileP016Persist` path) and adopt the `DocumentStore` port when INFRA-004 merges — the port contract is designed to make that adoption a wiring change, not a redesign.

## 3. The work items

### INFRA-002 — Neon PostgreSQL foundation (authoritative transactional store)

- **Depends on:** INFRA-001 VERIFIED.
- **Scope:** the `DocumentStore` port (P016 discipline: registry + version chain + idempotency + command log); Neon adapter promoted from `p016-postgres.ts` semantics (pooled connection, idempotent DDL, `json`-not-`jsonb` byte identity, advisory-lock/CAS serialization); `MemoryDocumentStore`; `FailClosedDocumentStore`; multi-backend byte-identity fixture pattern.
- **Acceptance (shape):** deterministic cross-backend store tests (memory vs postgres byte-identical persisted views); CAS conflict tests; idempotency insert-on-conflict; CI with a real postgres service; fail-closed production behavior typed; zero behavior change to the existing v1 request path.
- **Non-goals:** no R2, no request-shape change, no worker, no production env wiring.
- **Evidence:** automated-test-suite + CI run (postgres service) + reproducible cross-backend script.

### INFRA-003 — Cloudflare R2 object store (authoritative artifacts)

- **Depends on:** INFRA-002 (registry that references the objects).
- **Scope:** the `ObjectStore` port; R2 adapter via the AWS SDK; MinIO adapter for CI/local; R2 content-addressed namespace; checkpoint blob bodies; durable server-side version-body writes; export artifact writes.
- **Acceptance (shape):** content-addressed dedup; restart-proof R2/MinIO; byte-identical fixture round-trips; CI with MinIO; fail-closed behavior when unconfigured.
- **Non-goals:** no request-shape change; no worker.

### INFRA-004 — Stateless document requests (WireEnvelope v2 + multi-instance proof)

- **Depends on:** INFRA-002, INFRA-003.
- **Scope:** additive `WireEnvelope` v2 (`documentId`, `baseRevision`); reference-bound sessions; execute + CAS commit; typed `document_conflict`; the six-assertion multi-instance proof over real postgres + MinIO; v1 session-bound compatibility path.
- **Acceptance (shape):** every proof assertion; conflict determinism; cold-instance convergence; deployed v2 smoke against wired production stores; regression-green app/web suites.
- **Non-goals:** no worker; no fabricated undo-across-instance journal; no tenancy enforcement.

### INFRA-005 — Upstash Redis coordination layer (never authority)

- **Depends on:** INFRA-002.
- **Scope:** `CoordinationCache` port + Upstash adapter; idempotency read-through, presence, stream/mesh caches, probe memoization, optional locks; honest backend observability; local dev without Redis.
- **Acceptance (shape):** Redis-loss correctness tests; TTL/bounds tests; no command fails merely because Redis is absent; CI with redis.

### INFRA-006 — Persistent CAD/BIM worker service

- **Depends on:** INFRA-002 + INFRA-004; benefits from INFRA-003.
- **Scope:** claim-lease job executor; Railway primary / Cloud Run alternative; existing engine worker toolchain; HMAC claim ingress; additive engine-backed job kinds; App API `OFFISOS_WORKER_URL` extension.
- **Acceptance (shape):** lease reclaim; exactly-one-claimer; stale-revision rejection; toolchain parity; deployed `ifc.*` capability unlock; browser verification.
- **Non-goals:** no worker-authored canonical state; no WebSocket requirement.

### INFRA-007 — Production wiring, security hardening, deployment binding

- **Depends on:** INFRA-002..006.
- **Scope:** Vercel env wiring for Neon/R2/Upstash/worker claim secret; rotation runbook; Vercel→worker claim verification; exact-head production deployment + browser verification; deployed multi-instance smoke; fail-closed→wired evidence.
- **Acceptance (shape):** production durable SAVE/OPEN through UI; P016 surfaces working in production; instance-rotation proof; zero secrets in repository/PRs/logs.

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
| R2/S3 API drift vs MinIO in CI | port contract + cross-backend byte-identity fixtures pin behavior |
| v2 envelope breaking v1 clients | additive envelope; v1 compat path retained until INFRA-007 evidence retires it |
| Worker claim secret compromise | short-TTL HMAC claims, rotation runbook, least-privilege store roles |
| Undo-journal expectation mismatch after rotation | typed revert-to-parent semantics; documented; modelHistory replay remains exact |
| Cost surprises at scale | store-native dashboards + bounded cache/worker resources and measured acceptance | 

## 5. Definition of done for the program (INFRA-008 candidate: closure)

- Production multi-instance proof passes on the deployed URL (session A creates layer → cold session B sees and extends it → one authoritative document).
- Durable SAVE/OPEN works through the visible UI on production.
- P016 surfaces (collab/recovery/jobs) are wired and restart-proof in production.
- `ifc.*` returns real results on production through the worker service.
- All store failure modes fail closed typed, with zero secrets in the repository.
- The CAD roadmap's G9 golden workflow (save/reload round-trip) is green against the authoritative stores.
