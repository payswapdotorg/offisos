# INFRA-002 — ZAI Implementation Directive (fork resubmission)

Repository: `payswapdotorg/offisos`  
GitHub issue: **#2**  
Work-item: `governance/work-items/INFRA-002.json`

Implement only the frozen INFRA-002 Neon PostgreSQL foundation and stop at `PR_OPEN / VERIFYING`. Preserve Architecture v1.1 and the existing v1 request path. Do not self-approve, merge, or verify.

Mandatory scope: DocumentStore P016 persistence discipline; Neon/PostgreSQL adapter; MemoryDocumentStore; FailClosedDocumentStore; cross-backend byte-identity fixtures; deterministic CAS/idempotency/failure tests; real-PostgreSQL CI.

Mandatory remediation carried forward from the previous Architect review: `body_bytes` is `BIGINT NOT NULL` and stored NULL/malformed values fail typed `document_corrupt`; `persistedView()` fails typed `document_corrupt` when a referenced body is missing; deterministic tests and a real-PostgreSQL proof cover both corruption cases.

Explicit non-goals: R2, WireEnvelope v2, stateless request migration, Redis, worker service, production environment wiring, architecture changes. Protected architecture changes require ACR.

Required return evidence: exact implementation revision and PR head, deterministic tests, exact CI including real PostgreSQL, cross-backend byte-identity proof, corruption proofs, governance/schema validation, changed-file scope, and known limitations. Every claim must be revision-bound.
