# COMPAT-CAD-008 — ARRAY Semantic Contract

## Status and authority

- Work item: `COMPAT-CAD-008`
- Issue: `#5`
- Architecture: ConstructionOS Architecture v1.1 — **FROZEN**
- Dependency: `COMPAT-CAD-007`
- Current lifecycle state: **DRAFT / PREPARATION ONLY**
- This document is a durable semantic contract for implementation preparation. It does **not** authorize a PR, merge, approval, or verification.

## 1. Canonical ownership

The Construction Graph remains the canonical system of record. `CADDocument` is an editor/working representation.

An ARRAY operation may use transient preview geometry and temporary picks, but no preview member becomes canonical until the single successful ARRAY commit.

Materialized array members are ordinary canonical entities in the existing flat partition. They must therefore participate in the existing render, select, modify, erase, undo and redo semantics without a second object authority.

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

## 3. Common ARRAY model

An ARRAY operation is defined by:

- `sourceIds`: ordered canonical source entity identifiers selected for repetition.
- `mode`: `RECTANGULAR` or `POLAR`; path mode remains unsupported unless separately proven and frozen.
- `parameters`: mode-specific values in canonical units.
- `preview`: presentation-only derived state.

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

- `dx = column * columnSpacing`
- `dy = row * rowSpacing`

A successful rectangular ARRAY with `rows=1` and `columns=1` is a no-op and must not create duplicate canonical entities; the implementation should return an explicit deterministic no-op result under the existing command contract rather than fabricate a second copy.

Negative spacing values are invalid unless the frozen existing transform model explicitly defines signed spacing. Zero spacing is valid only if the resulting duplicate/overlapping members are still uniquely canonical and the existing entity model permits them; otherwise it must fail typed before mutation. The implementation must resolve and test this boundary explicitly rather than relying on renderer behavior.

## 5. Polar arrays

Supported parameters:

- `center`: finite canonical point
- `count`: positive integer
- `angleStep`: finite canonical angle

The source occurrence is member index `0` and retains the source orientation.

Member ordering is increasing index order `0..count-1`. Member `i` is derived from the source transform by rotation of `i * angleStep` around `center` using the existing canonical transform semantics.

A `count=1` operation is a deterministic no-op and must not create a duplicate.

The implementation must define the full-circle convention before coding. If a full circle is represented by a total span of `360°`, the final member index must not silently duplicate index `0`; the chosen convention must be deterministic and covered by fixtures.

## 6. Identity and provenance

Canonical identity must be document/domain-owned and deterministic. Native engine GlobalIds are provenance only.

Each materialized member must have:

- a stable canonical entity id;
- explicit provenance linking it to the ARRAY operation and source occurrence;
- deterministic member index/order metadata where the model supports it;
- no collision with an existing canonical id;
- no hidden renderer-only identity.

For identical canonical input, source state, parameters and history position, identity allocation must be deterministic.

If the existing identity allocator intentionally uses revision-scoped entropy or an equivalent mechanism, byte-identity requirements must instead be satisfied by the canonical serialization contract already frozen by the architecture. The worker must document the actual invariant and prove it with fixtures rather than assuming a new allocator.

## 7. Source/member mutation policy

CC008 must choose one explicit policy and test it consistently:

- editing a source after an ARRAY commit does **not** retroactively mutate previously materialized members unless an existing canonical dependency mechanism already guarantees that behavior;
- deleting a source does **not** leave orphaned ARRAY-owned entities;
- deleting an individual member removes exactly that canonical member and records the existing normal edit history;
- undoing ARRAY restores the exact pre-ARRAY canonical state;
- redoing ARRAY restores the exact post-ARRAY canonical state.

The implementation must not introduce hidden live links that create a second authority for geometry state.

## 8. Rendering and selection

After commit:

- every materialized member must render through the same canonical rendering path as ordinary entities;
- every materialized member must be selectable immediately through the existing CC007 selection path;
- selection results must reference canonical member ids, not transient preview handles;
- ERASE must remove the selected canonical members using existing command semantics;
- modify/transform operations must operate on selected members using existing canonical transforms;
- cancelled or invalid previews must leave no renderable or selectable phantom member.

## 9. Web/Electron parity

Web and Electron must invoke the same engine-free semantic ARRAY command contract and produce equivalent affected serialized canonical state.

Any host-specific UI event translation is allowed only before the shared semantic boundary. Divergent domain logic, identity allocation, command semantics or canonical serialization is out of scope and must be rejected.

## 10. Typed failures

At minimum, the eventual implementation must distinguish invalid parameters from unsupported capability where the existing error taxonomy permits.

Examples requiring explicit handling include:

- zero or negative counts;
- non-finite numeric parameters;
- malformed source selection;
- unsupported path-array mode;
- degenerate source geometry when the existing geometry contract cannot represent the result;
- identity/materialization collisions that cannot be resolved deterministically.

No invalid or unsupported input may report success or fabricate geometry.

## 11. Deterministic evidence fixtures

The implementation evidence should include fixed fixtures for:

1. rectangular `2x3` creation;
2. rectangular `1x1` no-op;
3. rectangular invalid count;
4. polar count `4` with a non-zero center;
5. polar full-circle convention;
6. polar count `1` no-op;
7. invalid/unsupported path mode;
8. member selection immediately after commit;
9. erase one member and undo/redo;
10. repeated execution byte identity;
11. Web/Electron semantic equivalence;
12. regression of CC005/006/007 prompt, selection, transform and no-mutation behavior.

Each fixture should capture canonical ids/order, serialized affected state and revision cardinality, not only rendered pixels.

## 12. Benchmark boundary

No benchmark score change is implied by this contract. A benchmark claim requires the repository's measured benchmark process and revision-bound evidence after implementation and verification.

## 13. Scope guardrails

This contract does not authorize:

- blocks/inserts/attributes or symbol libraries (`COMPAT-CAD-009`);
- hatch/annotation/dimension expansion (`COMPAT-CAD-010`);
- durable SAVE/OPEN completion (`COMPAT-CAD-011`);
- DXF interoperability (`COMPAT-CAD-012`);
- layout/sheet viewport identity (`COMPAT-CAD-013`);
- changes to Architecture v1.1 without the ACR lifecycle.
