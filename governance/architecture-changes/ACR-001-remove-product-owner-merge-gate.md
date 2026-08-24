# ACR-001 — Remove Product Owner transition authority and merge gate

**Architecture version:** 1.0 → proposed 1.1
**Status:** APPROVED BY PRODUCT OWNER / PENDING GOVERNANCE IMPLEMENTATION
**Date:** 2026-08-24

## Problem
The current governance state machine requires Product Owner authority for several workflow transitions, including `APPROVED → MERGED`. The desired operating model is that once the Architect approves a work item, the workflow proceeds directly to merge without a separate Product Owner approval gate.

## Requested change
Remove Product Owner transition authority from the workflow. In particular:

- `APPROVED → MERGED` shall no longer require `product-owner` authority.
- The merge transition shall be executable by the implementer/authorized merge automation after `APPROVED`.
- Product Owner shall no longer be a required lifecycle actor in the canonical state machine.

## Impact
This changes repository governance rather than product-domain architecture. It affects the canonical state machine, governance documentation, tests, and role descriptions.

## Alternatives considered
1. Keep the Product Owner merge gate — rejected because it adds a redundant approval step after Architect approval.
2. Permit Product Owner or Architect to merge — rejected because the requested governance model makes Architect approval the decisive gate.
3. Permit implementer/authorized merge automation to merge after Architect approval — selected.

## Compatibility / migration
Existing historical work-item records may contain Product Owner transitions; they remain valid historical records. New transitions will use the revised authorization model. Architecture-controlled governance artifacts must be updated atomically and their tests updated together.

## Recommendation
Adopt the requested workflow for Architecture v1.1.

## Approval
Product Owner explicitly requested this change in the project conversation on 2026-08-24. Architect records implementation of this ACR rather than silently mutating Architecture v1.0.
