# ADR-001 — Modular Monolith First

**Status:** Accepted
**Architecture:** 1.0

## Context

The project has many domains but high uncertainty in exact boundaries and heavy native/external engines.

## Decision

Start with a TypeScript modular monolith plus background/native workers. Domain boundaries are explicit and enforced by interfaces/events.

## Consequences

Simpler early development and testing. Selected domains can later be extracted behind stable contracts.
