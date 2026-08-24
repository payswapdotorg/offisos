# ADR-007 — Event-Driven Cross-App Integration

**Status:** Accepted
**Architecture:** 1.0

## Decision

Cross-domain synchronization occurs through durable versioned events. The canonical example is CAD/BIM model revision → quantity recalculation → estimate update → RFQ impact → subcontractor re-quote.
