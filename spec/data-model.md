# ConstructionOS Data Model and Persistence Rules

**Architecture version:** 1.0

## 1. Persistence boundaries

### PostgreSQL

Authoritative structured data.

### Object storage

Immutable/source/large artifacts.

### Queue/cache

Transient execution support.

## 2. Identity and version pattern

Every versioned entity has:

```text
entity_id
version_id
version_number
parent_version_id
created_at
created_by
source_snapshot_id
status
```

## 3. Provenance

Derived objects should reference their source objects and the execution that produced them.

Example:

```text
Estimate v17
 ├── Model v24
 ├── Quantity v24
 ├── Market snapshot MS-2026-08-24
 ├── Supplier quote Q-381
 ├── Risk model RM-3.2
 └── AI/Tool executions where applicable
```

## 4. Artifact record

Each artifact should retain:

- artifact ID;
- object-store location;
- MIME/content type;
- file hash;
- source/derived flag;
- source application/extension;
- created timestamp;
- tenant/project ownership;
- version/lineage;
- retention class;
- access policy.

## 5. Event store

Events are durable records linked to:

- aggregate/entity ID;
- aggregate version;
- event type/version;
- actor/execution ID;
- timestamp;
- payload;
- causation ID;
- correlation ID.

## 6. Audit

Audit records must distinguish:

- human action;
- agent action;
- extension action;
- automated system action;
- external integration action.

## 7. Derived data

Indexes, search data, caches and analytics materializations are rebuildable and never authoritative.

## 8. Deletion

Tenant/data deletion must respect legal/retention requirements and preserve required audit/provenance boundaries. Hard deletion must not silently destroy required project lineage.
