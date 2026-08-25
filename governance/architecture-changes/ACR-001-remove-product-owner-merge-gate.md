# ACR-001 — Remove Product Owner transition authority and merge gate

**Original architecture target:** 1.0 → proposed 1.1
**Current status:** SUPERSEDED FOR VERSION ASSIGNMENT
**Date:** 2026-08-24

## Problem

The current governance state machine requires Product Owner authority for several workflow transitions, including `APPROVED → MERGED`. The desired operating model is that once the Architect approves a work item, the workflow proceeds directly to merge without a separate Product Owner approval gate.

## Requested change

Remove Product Owner transition authority from the workflow. In particular:

- `APPROVED → MERGED` shall no longer require `product-owner` authority.
- The merge transition shall be executable by the implementer/authorized merge automation after `APPROVED`.
- Product Owner shall no longer be a required lifecycle actor in the canonical state machine.

## Resolution

The Product Owner's governance intent remains approved, but the proposed architecture version number `1.1` is superseded by ACR-002's CAD/BIM client-topology change, which establishes Architecture v1.1.

ACR-001 therefore remains a valid historical governance decision but is no longer the architecture-version assignment for the active v1.1 release. Its implementation should be tracked under a subsequent Architecture Change Request/version when the governance state-machine change is formally implemented.

## Compatibility / migration

Historical work-item records containing Product Owner transitions remain valid historical records. No historical transition is rewritten solely to accommodate this versioning change.

## Approval

The Product Owner's original request remains recorded in this ACR. No silent mutation of the frozen architecture was performed.
