# ConstructionOS Security and Tenancy Model

**Architecture version:** 1.0

## 1. Tenant hierarchy

`Platform → Tenant → Organization → Team → Project → Resource`

Resources may include documents, models, estimates, RFQs, bids, schedules, inspections and APIs.

## 2. Server-side authorization

Every protected request is authorized server-side against tenant/project/resource context.

Client-side hiding is not a security boundary.

## 3. Roles

Baseline roles include:

- platform administrator;
- tenant administrator;
- organization administrator;
- project owner;
- architect;
- engineer;
- quantity surveyor/estimator;
- project manager;
- procurement;
- inspector;
- maintenance manager;
- subcontractor;
- supplier;
- client;
- external consultant.

Projects can define custom roles subject to a policy framework.

## 4. Commercial confidentiality

Commercial objects have explicit confidentiality classes.

Examples:

`PUBLIC_PROJECT_INFO`
`TEAM_ONLY`
`CLIENT_VISIBLE`
`INTERNAL_COMMERCIAL`
`PRIVATE_BIDROOM`
`REGULATED_CONFIDENTIAL`

Competitor quotes and internal markup are never visible to external bidders.

## 5. Subcontractor external sessions

External RFQ recipients get scoped access to the specific package and submission actions. They do not become project members unless explicitly invited.

## 6. AI data policy

Prompt construction must respect tenant and object permissions. The AI Gateway must know which data can be sent to each provider. Providers may be excluded by tenant policy, geography or confidentiality class.

## 7. Extension security

Extensions inherit the invoking principal's authorization but cannot exceed their manifest permissions.

## 8. Audit

Security-sensitive actions are audited:

- permission changes;
- API key creation/revocation;
- export/download;
- bid access;
- secret use;
- extension install/update/revoke;
- AI execution on restricted data;
- human approvals.

## 9. Isolation tests

CI must include tests attempting:

- cross-tenant object access;
- cross-project bid access;
- subcontractor competitor-bid access;
- extension privilege escalation;
- prompt-context leakage.
