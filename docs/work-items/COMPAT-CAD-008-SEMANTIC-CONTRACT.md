# COMPAT-CAD-008 — ARRAY Semantic Contract

## Status and authority

- Work item: `COMPAT-CAD-008`
- Issue: `#5`
- Architecture: ConstructionOS Architecture v1.1 — **FROZEN**
- Dependency: `COMPAT-CAD-007` — **VERIFIED**
- Current lifecycle state: **IMPLEMENTING — ARCHITECT CHANGES REQUESTED**
- This document is the durable semantic contract for CC008. It defines the bounded implementation behavior and evidence obligations; lifecycle authorization is governed by `governance/work-items/COMPAT-CAD-008.json` and `governance/workflow-states.json`.

## 1. Canonical ownership

The Construction Graph remains the canonical system of record. `CADDocument` is an editor/working representation.

An ARRAY operation may use transient preview geometry and temporary picks, but no preview member becomes canonical until the single successful ARRAY commit.

Materialized array members are ordinary canonical entities in the existing flat partition. They must therefore participate in the existing render, select, modify, erase, undo and redo semantics without a second object authority.

Each materialized member must also carry deterministic ARRAY provenance/ownership sufficient to identify the ARRAY operation, source occurrence and member ordering/index according to the existing canonical model. This provenance must not become a competing application-local authority.

The source/member deletion policy must be deterministic and must not leave orphaned ARRAY-owned canonical entities. Undo and redo must restore the exact canonical states defined by that policy.

## 2. Command lifecycle

The semantic command path is:

`idle → prompt/source-selection → parameter-entry → preview → commit | cancel/fail`

Rules:

1. Preview is non-mutating.
2. Invalid or unsupported input fails explicitly and leaves canonical state unchanged.
3. A successful mutating ARRAY command creates exactly **one** canonical revision.
4. The revision contains the source-preserving result plus all materialized members required by the chosen mode.
5. Undo removes that complete revision atomically; redo restores the same canonical result.
6. Repeated execution with identical canonical input and parameters produces byte-identical semantic output.
7. Source deletion and member deletion/modification follow the explicit deterministic ownership policy and preserve revision/history integrity.

## 3. Common ARRAY model

An ARRAY operation is defined by:

- `sourceIds`: ordered canonical source entity identifiers selected for repetition.
- `mode`: `RECTANGULAR` or `POLAR`; path mode remains unsupported unless separately proven and frozen.
- `parameters`: mode-specific values in canonical units.
- `preview`: presentation-only derived state.
- `provenance`: canonical relationship between the ARRAY operation, source occurrence and each materialized member.

The implementation must preserve the existing CC007 prompt ownership and selection semantics. ARRAY must not introduce a parallel prompt or selection implementation.

## 4. Rectangular arrays

Supported parameters:

- `rows`: positive integer
- `columns`: positive integer
- `rowSpacing`: finite canonical distance
- `columnSpacing`: finite canonical distance

The source placement is the logical origin. Member ordering is row-major and deterministic:

`row = 0..rows-1`, then `column = 0..columns-1`.

The source occurrence is the `(0,0)` member. Additional members are translated by:
