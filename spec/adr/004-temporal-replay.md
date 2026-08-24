# ADR-004 — Historical Time Machine with No Future Leakage

**Status:** Accepted
**Architecture:** 1.0

## Decision

Historical learning uses time-valid snapshots and walk-forward replay. Data first available after replay time T is excluded. Predictions are stored before outcome resolution.

## Consequences

Historical datasets need timestamps/versioning. The system gains scientifically defensible backtesting and counterfactual capabilities.
