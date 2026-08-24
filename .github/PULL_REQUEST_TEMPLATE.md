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
- [ ] This PR does not modify architecture-controlled artifacts (`spec/architecture.md`, `spec/architecture-lock.md`, `spec/adr/**`, `spec/00-readme.md`, `spec/SPEC-MANIFEST.md`, `governance/workflow-states.json`, `governance/architecture-versions.json`, `governance/protected-paths.json`) — enforced by `npm run governance -- check-protected`
- [ ] If an architecture-controlled artifact must change, an Architecture Change Request is referenced instead of a silent change (ACR lifecycle: ARCH-WF-002)

## What was implemented

<!-- What exactly does this PR change? List the areas. -->

## Files / artifacts created or changed

<!-- Bullet list of the important files and what they contain. -->

## Evidence

<!-- Evidence entries must also be recorded in the governance work-item record. -->

- [ ] `npm test` — deterministic test suite, exit 0
- [ ] `npm run governance -- validate` — all work-item records valid, exit 0
- [ ] CI run for this PR is green (governance workflow)
- Evidence entries recorded in the governance record: <!-- EV-xxx… -->

## Reproduction

<!-- Exact commands an independent engineer can run to reproduce the evidence. -->

```
npm ci
npm test
npm run governance -- validate
```

## Not verified / limitations

<!-- Explicitly state anything NOT verified by this PR. Do not claim VERIFIED;
     verification is decided by the Architect (governance/README.md). -->

## State

- [ ] Governance record transitions updated (e.g. IMPLEMENTING → PR_OPEN referencing this PR number)
