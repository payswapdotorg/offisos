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

## 5. Research work items

Research work is used when an implementation assumption is not yet proven. Research outputs must state:

- question;
- hypothesis;
- experiment;
- evidence;
- finding;
- decision;
- architecture impact.

## 6. No “looks finished” approvals

A screenshot or natural-language claim is insufficient for correctness-critical functionality where automated or deterministic evidence is possible.

## 7. Clone/compatibility workflow

For compatible applications:

`fixture corpus → baseline behavior → implementation → round-trip test → semantic test → visual test → workflow benchmark → performance benchmark → architect review`

## 8. Architecture change workflow

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
