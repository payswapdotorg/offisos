# ConstructionOS Event Model

**Architecture version:** 1.0

## 1. Event rules

Events are:

- versioned;
- typed;
- immutable;
- attributable;
- idempotently consumable;
- linked to a source entity/version;
- linked to a causation/correlation chain.

## 2. Core event families

### Project

`project.created`
`project.updated`
`project.archived`

### Model

`model.created`
`model.version.created`
`model.element.changed`
`model.version.approved`

### Quantity

`quantity.calculation.started`
`quantity.changed`
`quantity.calculation.failed`

### Cost

`estimate.created`
`estimate.recalculated`
`estimate.assumption.changed`

### RFQ

`rfq.created`
`rfq.scope.changed`
`rfq.issued`
`rfq.bid.received`
`rfq.bid.updated`
`rfq.bid.leveled`
`rfq.closed`

### Schedule

`schedule.created`
`schedule.changed`
`schedule.progress.updated`
`schedule.baseline.created`

### Inspection/maintenance

`inspection.created`
`test.completed`
`finding.created`
`condition.updated`
`defect.created`
`maintenance.recommended`
`maintenance.completed`

### AI

`ai.execution.started`
`ai.execution.completed`
`ai.execution.failed`
`ai.model.selected`
`ai.verification.completed`

### Predictions

`prediction.issued`
`prediction.resolved`
`prediction.calibrated`

### Extensions

`extension.installed`
`extension.updated`
`extension.revoked`

## 3. Key cascade example

```text
model.version.created
      ↓
quantity.recalculate.requested
      ↓
quantity.changed
      ↓
estimate.recalculated
      ↓
rfq.scope.impact.detected
      ↓
subcontractor.reattribution.required
      ↓
rfq.bid.updated
      ↓
bid.comparison.updated
```

## 4. Event payload requirements

Every event includes:

- `event_id`
- `event_type`
- `event_version`
- `occurred_at`
- `tenant_id`
- `project_id` when applicable
- `actor_type`
- `actor_id` when applicable
- `source_entity_id`
- `source_version_id`
- `causation_id`
- `correlation_id`
- `payload`
