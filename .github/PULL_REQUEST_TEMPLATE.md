<!--
PR requirements are defined in governance/README.md (Repository integration).
The governance CI check must pass before review. Work-item records under
governance/work-items/ are the canonical state; keep them in sync with this PR.
-->

## Work item

- Work-item ID: <!-- e.g. ARCH-WF-001 -->
- Governance record: governance/work-items/<ID>.json
- GitHub issue: #<!-- issue number -->

## Architecture

- Architecture version targeted: 1.0
- [ ] This PR does not modify architecture-controlled artifacts (`spec/architecture.md`, `spec/architecture-lock.md`, `spec/adr/**`, `spec/00-readme.md`, `spec/SPEC-MANIFEST.md`, `governance/workflow-states.json`, `governance/architecture-versions.json`, `governance/protected-paths.json`, `governance/schemas/**`, existing files under `governance/acr/**` and `governance/reconciliations/**`) — enforced by `npm run governance -- check-protected`
- If this PR must change an architecture-controlled artifact, it is routed through an Architecture Change Request instead of a silent change:
  - ACR-Routing: <!-- e.g. ACR-Routing: ACR-003 — the single line the governance CI reads; the cited ACR must be APPROVED or IMPLEMENTED and must enumerate the exact changed paths in its authorized_paths -->
  - ACR record: governance/acr/ACR-<!-- NNN -->.json (status: <!-- PROPOSED / ENDORSED / APPROVED / IMPLEMENTED -->)

## What was implemented

<!-- What exactly does this PR change? List the areas. -->

## Files / artifacts created or changed

<!-- Bullet list of the important files and what they contain. -->

## Evidence

<!-- Evidence entries must also be recorded in the governance work-item record. -->

- [ ] `npm test` — deterministic test suite, exit 0
- [ ] `npm run governance -- validate` — all records valid
- [ ] `npm run governance -- check-verified-revisions` — no stale VERIFIED bindings
- [ ] CI run for this PR is green (governance workflow)
- Evidence entries recorded in the governance record: <!-- EV-xxx… -->

## Reproduction

<!-- Exact commands an independent engineer can run to reproduce the evidence. -->

```
npm ci
npm test
npm run governance -- validate
npm run governance -- check-verified-revisions
```

## Not verified / limitations

<!-- Explicitly state anything NOT verified by this PR. Do not claim VERIFIED;
     verification is decided by the Architect (governance/README.md). -->

## State

- [ ] Governance record transitions updated (e.g. IMPLEMENTING → PR_OPEN referencing this PR number)
