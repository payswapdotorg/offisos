# INFRA-002 — ZAI Implementation Directive

## Role

You are `z-ai-infra-agent`, the implementation worker for **INFRA-002 — Neon PostgreSQL foundation (authoritative transactional store)** in `pectoraux/offisos`.

The Architect has verified INFRA-001. Implement only the frozen scope below and stop at `PR_OPEN / VERIFYING`. Do not self-approve or self-verify.

## Authority and dependency

- Architecture: **ConstructionOS Architecture v1.1 — FROZEN**.
- Predecessor: **INFRA-001 VERIFIED** at `0e94680bcedc20bcfb4d4d51eeefb089d7e45665`.
- Primary specification: `governance/work-items/INFRA-002.json` and `docs/infrastructure/offisos-infrastructure-roadmap.md`.
- Persistence precedent: existing P016 port/adapters under `app/src/persist/*` and the verified INFRA-001 persistence model.

## Objective

Create the authoritative Neon PostgreSQL persistence foundation without changing the existing v1 request path.

## Frozen scope

1. Define the `DocumentStore` port using the P016 discipline: document registry, append-only version chain, idempotency records, command log, deterministic persisted representation.
2. Implement the Neon adapter using the proven `p016-postgres.ts` semantics: pooled connections, idempotent DDL/migrations, byte-preserving `json` handling where required, advisory-lock/CAS serialization, bounded retries and typed failures.
3. Implement `MemoryDocumentStore` for local development and deterministic tests.
4. Implement `FailClosedDocumentStore` for unconfigured production behavior.
5. Establish a cross-backend fixture pattern proving byte-identical persisted views.
6. Add deterministic tests for normal writes, CAS conflicts, retries/idempotency and failure behavior.
7. Add CI coverage against a real PostgreSQL service using the repository's existing CI conventions.

## Acceptance gates

- Memory and Postgres produce byte-identical canonical persisted views for the fixture set.
- Concurrent writes with stale base revision fail deterministically with the typed conflict surface; no silent merge/repair.
- Idempotency survives retries and uses insert-on-conflict semantics at the authority layer.
- Real PostgreSQL is exercised in CI; tests do not only mock the adapter.
- Missing production configuration fails closed with explicit typed behavior.
- Existing v1 request/transport behavior remains unchanged.
- No R2 work, no WireEnvelope v2, no stateless request migration, no Redis integration, no worker service and no production environment wiring.

## Architecture constraints

Preserve LOCK-003/004/005/007/010/018/019. Construction Graph remains canonical authority; the persistence layer stores the CADDocument working representation and provenance, not a competing graph. Worker code must not become canonical document authority. No protected architecture path may be modified without an ACR.

## Evidence package

Before returning:

- exact implementation revision and PR head;
- deterministic automated-test result;
- exact CI run including real PostgreSQL service;
- reproducible cross-backend test script/output;
- schema/governance validation result;
- changed-file list proving scope containment.

Every claim must be revision-bound. Do not fabricate timestamps or evidence. Do not modify existing VERIFIED governance records except the new INFRA-002 record on your work branch as required by the lifecycle.

## Stop gate

Return the repository to:

`DRAFT → READY → ASSIGNED → IMPLEMENTING → PR_OPEN → VERIFYING`

Your final worker response must identify the exact PR head, tests, CI, evidence, changed files, known failures, and confirm that no Architect lifecycle state was asserted.