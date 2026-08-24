# ADR-002 — Provider-Independent AI Gateway

**Status:** Accepted
**Architecture:** 1.0

## Context

The system must not depend on one model/provider and must route across multiple AI agents/providers.

## Decision

All AI access passes through an AI Gateway with provider adapters, model routing, fallbacks and execution telemetry. OpenRouter is an initial adapter, not the architecture boundary.

## Consequences

Additional abstraction and telemetry are required, but model/provider replacement remains possible and routing can optimize quality/cost/latency.
