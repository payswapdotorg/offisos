# ConstructionOS API Contract

**Architecture version:** 1.0

## 1. API philosophy

The API exposes stable construction-domain capabilities. It does not expose internal implementation details such as a specific CAD engine worker or AI provider.

Native applications, extensions and external consumers use the same domain service contracts.

## 2. API domains

`/v1/projects`
`/v1/models`
`/v1/elements`
`/v1/quantities`
`/v1/estimates`
`/v1/rfqs`
`/v1/bids`
`/v1/subcontractors`
`/v1/suppliers`
`/v1/schedules`
`/v1/inspections`
`/v1/maintenance`
`/v1/scenarios`
`/v1/predictions`
`/v1/evidence`
`/v1/ai`
`/v1/extensions`
`/v1/jobs`
`/v1/webhooks`

## 3. Authentication

Support:

- OAuth/OIDC for interactive users;
- scoped API keys for service integrations;
- service-to-service credentials;
- extension credentials.

Credentials are tenant-scoped and least-privilege.

## 4. Idempotency

Mutating operations that create financial/procurement/project state support idempotency keys.

## 5. Async jobs

Long-running operations return a job resource:

```json
{
  "job_id": "job_123",
  "status": "QUEUED",
  "resource": null
}
```

Job states:

`QUEUED → RUNNING → SUCCEEDED | FAILED | CANCELED`

## 6. Webhooks/events

External integrations can subscribe to typed domain events subject to tenant authorization.

Example:

`model.version.created`
`estimate.recalculated`
`rfq.bid.received`
`maintenance.recommended`

## 7. API errors

Errors include:

- stable error code;
- human-readable message;
- retryability;
- correlation ID;
- field errors where applicable;
- relevant evidence/validation references where safe.

## 8. Versioning

Breaking changes create new API versions. Additive changes should preserve backward compatibility where possible.

## 9. Example: quantity takeoff

```http
POST /v1/projects/{project_id}/quantities/takeoff
Idempotency-Key: ...
```

Request references a model version and quantity rules.

Response may return an asynchronous job.

## 10. Example: create RFQ from scope

```http
POST /v1/projects/{project_id}/rfqs
```

Payload references quantity/estimate versions and the selected scope IDs.

## 11. Example: bid optimization

```http
POST /v1/projects/{project_id}/bids/optimize
```

The response must include the recommended bid, uncertainty distribution, assumptions, constraints and evidence references.

## 12. External API boundary

The API must not promise that a specific internal engine will remain unchanged. Only domain contract semantics are stable guarantees.
