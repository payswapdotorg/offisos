# COMPAT-CAD-009 — Worker Implementation Prompt

You are the implementation worker `z-ai-implementation-agent` for Offisos.

## Authorized assignment

Implement **COMPAT-CAD-009: blocks, inserts, attributes and symbols** against the current verified mainline after COMPAT-CAD-008.

Architecture **v1.1 is frozen**. The Construction Graph remains the canonical system of record. Preserve the shared CADDocument semantic model, EngineAdapterBundle/native-engine isolation, deterministic domain-owned identities, revision/history semantics, typed failures and Web/Electron parity.

## Scope

Implement the bounded capability required for the next AutoCAD-class roadmap phase:

- block definition/canonical ownership semantics;
- block insert/materialized instance semantics;
- attributes associated with block definitions/inserts where required by the frozen contract;
- symbol-library semantics required by the roadmap;
- canonical identity and provenance for definitions, inserts and attributes;
- deterministic ordering and serialization;
- rendering and selectability through the same canonical members/entities;
- one atomic canonical revision for supported creation/edit operations;
- deterministic undo/redo and deletion/ownership policy;
- command/prompt behavior and typed invalid/unsupported handling;
- shared engine-free semantic execution for Web and Electron;
- deterministic regression evidence against CC005–CC008.

## Mandatory constraints

Do not implement or expand:

- hatches, annotations or dimensions beyond what is strictly necessary to preserve existing behavior (CC010);
- durable SAVE/OPEN or multi-instance persistence (CC011);
- DXF import/export (CC012);
- layouts/sheets/viewports (CC013);
- broad command-language/options/help expansion (CC014);
- generalized undo/history/long-session expansion outside the scoped block operations (CC015);
- architecture changes without an approved ACR;
- benchmark score increases without a full benchmark rerun.

Do not create an application-local competing authority for shared objects. Native engine dependencies, if any are actually required, remain behind the existing adapter boundary.

## Required evidence before return

Produce revision-bound evidence for:

1. deterministic definition/insert/attribute/symbol semantics;
2. canonical stable identity/provenance and deterministic ordering;
3. rendering/selectability of the canonical entities;
4. atomic revision behavior and exact undo/redo;
5. source-definition/instance/attribute deletion and ownership/orphan policy;
6. invalid and explicitly unsupported behavior with typed failures;
7. Web/Electron parity;
8. regression coverage for CC005, CC006, CC007 and CC008;
9. exact-head CI;
10. exact deployment/browser evidence for the roadmap workflows assigned to CC009.

## Architect remediation directive — DEC-001

The first implementation submission reached Architect Review but was returned to `IMPLEMENTING` before approval. The following are mandatory closure items; do not treat them as optional cleanup:

- **Provenance monotonicity:** `insertIndex` must remain collision-free and deterministic across deletion/reinsert history for a block definition. A deleted instance must not permit a later insert to reuse an index that remains represented by another surviving instance.
- **Provenance consistency:** when `insertProvenance` is present, its `blockId` must equal the canonical `blockRef.blockId`; malformed inconsistent provenance must be rejected with the existing typed `bad_input` failure before mutation.
- **Deterministic regression proof:** add tests covering deletion followed by reinsertion, provenance mismatch rejection/no-mutation, and any affected ordering/serialization behavior.
- **Independent browser gate:** provide revision-bound exact-deployment black-box evidence through the visible product UI for the CC009 roadmap Golden workflows **G5, G7 and G8**, including block/insert/attribute/symbol visibility and selection plus negative/unsupported behavior. Do not substitute API calls, deterministic unit tests or screenshots for the required browser-agent execution.
- Keep Architecture v1.1 frozen and do not expand into CC010+ scope.

The Architect has recorded the remediation in `governance/work-items/COMPAT-CAD-009.json` as `DEC-001` with lifecycle `ARCHITECT_REVIEW → IMPLEMENTING`.

## Stop gate

Do not self-approve, self-merge, or self-verify. Return at **PR_OPEN / VERIFYING** only after the remediation is implemented and all required evidence is attached to the repository and governance record. The Architect owns later review, approval, merge and `VERIFIED`.

## Worker return format

Report:

- implementation commit(s) and PR;
- exact test counts/pass/fail/skip;
- governance validation result;
- exact-head CI run IDs;
- exact deployment revision and browser-agent evidence IDs/artifacts for G5/G7/G8;
- changed semantic surface and explicit non-goal checks;
- any newly discovered defect or architecture concern;
- confirmation that no benchmark score increase is claimed.
