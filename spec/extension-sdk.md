# ConstructionOS Extension SDK

**Architecture version:** 1.0

## 1. Purpose

Extensions let third parties add construction capabilities without modifying core domain logic.

Examples:

- corrosion test/analysis;
- thermal inspection;
- drone imagery processing;
- local building-code pack;
- laboratory connector;
- supplier catalog;
- specialist engineering solver.

## 2. Extension manifest

Each extension declares:

```yaml
id: example.corrosion
version: 1.0.0
api_version: 1
capabilities:
  - inspection.corrosion.assess
permissions:
  - read:inspection
  - read:bim.element
  - write:condition.assessment
network:
  mode: restricted
secrets:
  mode: none
supported_jurisdictions: [GH]
```

## 3. Capability contract

A capability defines:

- inputs;
- outputs;
- required permissions;
- quality metadata;
- version;
- supported jurisdictions/formats;
- cost/latency estimates;
- failure semantics.

## 4. Security

Extensions must not:

- query arbitrary database tables;
- bypass authorization;
- access unrestricted tenant data;
- change workflow state directly;
- access secrets without declared scope;
- silently transmit customer data to third parties.

## 5. Extension execution

Potential execution modes:

- isolated process;
- container/sandbox;
- remote extension service.

The execution boundary must be explicit in the extension manifest.

## 6. Version compatibility

An extension declares compatible ConstructionOS API/SDK versions. Incompatible extensions are blocked or run through explicit compatibility adapters.

## 7. Lifecycle

`DISCOVERED → INSTALLED → ENABLED → UPDATED → DISABLED → REVOKED`

## 8. Example capability

```text
inspection.corrosion.assess

Input:
- BIM element
- inspection observations
- optional sensor/lab data

Output:
- condition assessment
- severity
- uncertainty
- recommended next test
- maintenance recommendation
- evidence references
```

## 9. Marketplace

The marketplace/catalog records publisher, version, permissions, capabilities, security status, compatibility, pricing and reviews. Marketplace presence does not imply engineering certification.
