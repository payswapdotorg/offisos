# ConstructionOS Development Workflow

**Purpose:** Define how ChatGPT, Z.ai and the Product Owner collaborate to implement the frozen architecture.

This workflow is adapted from the WorkflowOS development model: frozen architecture, traceable requirements/work items, dependency-driven execution, evidence-based verification and independent architecture review.

## 1. Authority

The repository/spec is authoritative for architecture and requirements.

The Product Owner authorizes major product/architecture changes.

The Architect/Reviewer validates architectural compliance and evidence.

Z.ai implements assigned work items and must not redefine frozen architecture.

## 2. Work-item lifecycle

```text
DRAFT
  ↓
READY
  ↓
ASSIGNED
  ↓
IMPLEMENTING
  ↓
PR_OPEN
  ↓
VERIFYING
  ↓
ARCHITECT_REVIEW
  ↓
APPROVED → MERGED → VERIFIED
```

Failure paths:

- verification failure → IMPLEMENTING;
- review changes requested → IMPLEMENTING;
- architecture change required → ARCHITECTURE_CHANGE_REQUEST;
- blocking issue → IMPLEMENTATION_BLOCKED.

## 3. Z.ai implementation contract

Z.ai receives:

- one work item;
- relevant requirements;
- architecture version;
- dependencies;
- acceptance criteria;
- out-of-scope rules;
- evidence expectations.

Z.ai returns:

- implementation;
- tests;
- PR;
- verification evidence;
- changed files summary;
- known limitations;
- architecture compliance statement.

Z.ai MUST stop implementation-side lifecycle advancement at `PR_OPEN/VERIFYING`. It must not wait for the Product Owner to issue another chat instruction before handing the PR to the Architect.

## 4. Architect review contract

The Architect checks:

### Requirement compliance

Did implementation satisfy every acceptance criterion?

### Architecture compliance

Did it stay inside frozen boundaries?

### Engineering quality

Correctness, maintainability, security, performance, observability.

### Evidence quality

Does evidence prove the criterion?

## 5. Architect return protocol — autonomous continuation

When a worker returns with a work item at `PR_OPEN/VERIFYING`, that return is the trigger for the Architect to continue through all legal downstream governance steps without an intermediate user prompt.

The canonical operating protocol is `docs/governance/architect-return-protocol.md`.

The Architect autonomously performs, as applicable:

```text
worker return
→ reconcile PR / work-item / exact head
→ complete or validate required evidence and CI
→ VERIFYING → ARCHITECT_REVIEW
→ independent review
→ APPROVED (if accepted)
→ MERGED
→ exact merge binding
→ post-merge checks to terminal
→ merged-tree verification
→ exact-head deployment
→ required browser / black-box validation
→ evidence reconciliation
→ MERGED → VERIFIED
→ governance record closure
→ authoritative roadmap update
→ successor work-item + repository implementation prompt
→ next worker release
```

The Architect does **not** stop between these routine steps to request `next`, `go`, `continue`, or equivalent user input.

The Architect stops only when:

- changes are required and a repository-backed remediation directive/prompt has been created;
- an Architecture Change Request is required;
- an external hard blocker prevents lawful verification;
- a Product Owner decision is required outside existing authorization.

A successful work item therefore hands off directly to the next persisted work item; a failed work item hands off directly to a persisted remediation instruction.

## 6. Research work items

Research work is used when an implementation assumption is not yet proven. Research outputs must state:

- question;
- hypothesis;
- experiment;
- evidence;
- finding;
- decision;
- architecture impact.

## 7. No “looks finished” approvals

A screenshot or natural-language claim is insufficient for correctness-critical functionality where automated or deterministic evidence is possible.

## 8. Clone/compatibility workflow

For compatible applications:

`fixture corpus → baseline behavior → implementation → round-trip test → semantic test → visual test → workflow benchmark → performance benchmark → architect review`

For CAD compatibility specifically, the browser-agent phase gate is mandatory after every work item and is part of the Architect return loop.

## 9. Architecture change workflow

```text
Finding
 ↓
Architecture Change Request
 ↓
Impact analysis
 ↓
Alternatives
 ↓
Product Owner decision
 ↓
Architecture vNext
 ↓
Requirement/work-item impact update
```

No implementation branch may silently redefine a frozen architecture rule.
