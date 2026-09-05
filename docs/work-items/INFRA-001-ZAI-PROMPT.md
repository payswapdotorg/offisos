# INFRA-002 — Z.ai Implementation Directive

> This is the successor handoff prompt produced by INFRA-001 (the audit/design work
> item). It is the repository-backed implementation directive for the FIRST
> implementation work item of the persistent serverless foundation.
> The Architect releases the governance record (`governance/work-items/INFRA-002.json`,
> born DRAFT) and assigns this prompt per the return protocol; this document defines
> the frozen scope to be released.

## Authority

Implement `INFRA-002 — Neon PostgreSQL foundation (authoritative transactional store)`
against the latest VERIFIED `main` baseline, exactly as specified in:

- `docs/infrastructure/offisos-infrastructure-roadmap.md` §3 (INFRA-002 entry);
- `docs/infrastructure/offisos-persistence-model.md` §2 (the schema + transaction boundaries);
- `docs/infrastructure/offisos-serverless-architecture.md` (the topology this belongs to);
- `docs/infrastructure/offisos-state-inventory.md` (what state moves and why).

Architecture: ConstructionOS Architecture v1.1 — FROZEN.
Dependency: `INFRA-001` (this audit/design work item, once VERIFIED).

## Mission

Introduce the authoritative transactional document store as an additive, host-wired
port — the `P016Persist` discipline applied to document persistence:

- the `DocumentStore` port (pure TypeScript, engine-free, no environment reads);
- the `MemoryDocumentStore` (dev/tests) and `FailClosedDocumentStore` (the honest
  unconfigured production default);
- the Neon/PostgreSQL adapter: document registry, append-only version chain,
  `idempotency_keys`, `command_log` (the schema in persistence-model §2.2);
- optimistic concurrency: CAS on `documents.head_version_id` with typed
  `document_conflict` outcomes;
- the cross-backend byte-identity fixture discipline (the `json`-not-`jsonb` lesson);
- a CI web-job extension with a real postgres service running the store suite.

## Required implementation rules

1. Do not introduce a new canonical store semantics: the CADDocument remains the
   working representation (LOCK-019); the store persists its committed versions with
   versioning and provenance (LOCK-005); no Construction Graph identity is created.
2. Follow the port precedent exactly: host wiring selects the backend; the core stays
   pure; unconfigured production fails closed typed — never a silent memory fallback.
3. The v1 request path must be behavior-identical: no envelope change, no handler
   semantic change in this work item (that is INFRA-004). The store's surface is
   exercised by tests, not by the production request flow yet.
4. Determinism: persisted state round-trips byte-exactly; the deterministic version
   ids / content hashes from `caddocument/versioning.ts` are the store's keys — never
   store-generated ids.
5. No R2, no Redis, no worker, no request-shape change, no Vercel env wiring in this
   work item (those are INFRA-003/005/006/007).
6. No protected-path modifications; no ACR; the app suites stay regression-green.

## Required test/evidence work

- Deterministic store suite: registry create/read; append-only version chain
  linearity; CAS conflict (one winner, typed conflict with current head for the
  loser); idempotency insert-on-conflict (replay returns the persisted binding);
  fail-closed typed behavior; malformed-record rejection (LOCK-007).
- Cross-backend byte identity: memory vs postgres produce byte-identical persisted
  views for the same command sequence (the pinnable-fixture pattern).
- A restart/reopen test: a fresh handler rebuilds the document from the store
  hash-exactly through `CADDocument.open` (the recovery.restore precedent).
- CI: the web job gains the store suite against the real postgres service
  (the `cad-parity-016.yml` web-host precedent — DATABASE_URL service wiring).
- Governance: the INFRA-002 record (created by the Architect at release) walks its
  legal lifecycle; evidence revision-bound to the implementation head.

## Required regression gates

- full deterministic application suite (app/);
- Web lint/typecheck/build;
- existing P016 persist/parity tests unchanged and green;
- governance validate + check-protected + check-verified-revisions on the exact head.

## Scope honesty

The store is exercised by tests, not yet by production traffic: production behavior
is unchanged in this work item (fail-closed paths preserved). Document it exactly
that way in the PR. The request-model change (reference-bound sessions,
WireEnvelope v2, the multi-instance proof) is INFRA-004.

## Governance stop gate

After implementation and evidence are complete:

- update the governance record with revision-bound evidence;
- open/refresh the implementation PR;
- set the work item to `PR_OPEN/VERIFYING`;
- stop implementation-side lifecycle advancement.

Do not add `ARCHITECT_REVIEW`, `APPROVED`, `MERGED`, or `VERIFIED`. The Architect
will automatically continue the governance loop from the worker return.

---

*INFRA-001 final report note (for the Architect's review of THIS work item): the
audit, the five-category state inventory, the persistence model, the worker model
with the Railway-primary/Cloud Run-alternative recommendation, the migration
roadmap INFRA-002..007 and the security/local-dev models are the deliverables under
`docs/infrastructure/`; the implementation stop gate applies — this record stops at
PR_OPEN/VERIFYING.*
