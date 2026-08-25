# ACR-002 — CAD/BIM Web and Desktop Client Topology

**Architecture version:** 1.0 → 1.1
**Status:** APPROVED BY PRODUCT OWNER / PENDING ARCHITECTURE PR MERGE
**Date:** 2026-08-25

## Problem

The frozen architecture defines CAD/BIM as a compatibility application behind engine adapters, but does not explicitly define the client/runtime topology required to deliver the CAD/BIM application consistently on both web and desktop/Electron platforms.

A CAD/BIM editor is highly interactive and includes capabilities that may require native processes, filesystem access, large-model computation, GPU/rendering integration, and local/offline workflows. The application therefore needs a shared renderer/editor core with platform-specific hosts and transport layers.

## Requested change

Add a dedicated CAD/BIM client topology:

```text
                    CAD/BIM Renderer Core
                             │
              ┌──────────────┴──────────────┐
              │                             │
        Electron Host                  Web Host
              │                             │
        Native/Desktop                   HTTP/WebSocket
          Transport                      Transport
              │                             │
              └──────────────┬──────────────┘
                             │
                       CAD/BIM App API
                             │
                       CAD/BIM Engine
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
    Geometry Engine       BIM Engine         File Engine
     (OCCT/FreeCAD)     (IFC/openBIM)      (IFC/STEP/DXF/FCStd)
          │                  │                  │
          └──────────────────┴──────────────────┘
                             │
                    CADDocument Model
                             │
                    Construction Graph
```

The CADDocument is the editor's canonical working representation for an open CAD/BIM artifact and must be versioned and provenance-aware. It is not a replacement for the Construction Graph, which remains the canonical domain/project system of record.

The shared renderer/editor core must run against an abstract CAD/BIM application API rather than directly invoking Electron, browser APIs, FreeCAD, OpenCascade, or IfcOpenShell.

The Electron host may use native/local workers and filesystem capabilities through a native transport. The web host uses HTTP/WebSocket/domain APIs and may delegate heavy native CAD/BIM work to authorized backend workers.

## Architectural constraints

1. Web and desktop share one renderer/editor core and one semantic command/API contract.
2. Platform hosts provide capabilities; they do not define CAD/BIM domain behavior.
3. CAD/BIM engine access remains behind stable engine adapters.
4. File-format handling remains behind file-engine adapters.
5. CADDocument is a document/editor model, not the Construction Graph.
6. Construction Graph IDs remain canonical for domain identity; engine IDs remain provenance/source identifiers.
7. Heavy native computation may execute locally on Electron or remotely through backend workers, but both paths implement the same capability contract.
8. Web and Electron collaboration/versioning semantics must converge on the same versioned domain/document contracts.
9. No renderer is permitted to bypass authorization, domain validation, evidence, or workflow controls.
10. The topology must preserve replacement of the CAD/BIM engine without rewriting the renderer or Construction Graph.

## Alternatives considered

1. Separate web and desktop CAD implementations — rejected because divergence would double-test semantic behavior and undermine compatibility consistency.
2. Electron-only application — rejected because web delivery is a required product platform.
3. Browser renderer directly coupled to a CAD engine — rejected because it destroys engine/host independence and complicates security and replacement.
4. CADDocument as the Construction Graph — rejected because editor/file representation is not equivalent to the canonical construction domain model.

## Compatibility / migration

Existing CAD/BIM adapter contracts remain valid. RESEARCH-CAD-001 and RESEARCH-CAD-002 evidence maps naturally into the engine/file adapter layer. Future CAD/BIM implementation work must target the shared renderer/API boundary rather than platform-specific editor implementations.

No existing Construction Graph contract needs to change. Existing work items retain the architecture version against which they were created.

## Security impact

Electron native capabilities must be explicitly allowlisted and isolated. Web clients must never obtain native filesystem/process privileges through renderer code. Heavy native engines exposed through a desktop or server worker must operate through authenticated, capability-scoped transport contracts.

## Migration / implementation sequence

1. Define the CAD/BIM renderer command/query contract.
2. Define CADDocument serialization/versioning and provenance contract.
3. Implement a web host using HTTP/WebSocket transport.
4. Implement an Electron host using native/local transport.
5. Connect both hosts to the same engine/file adapter contracts.
6. Connect CADDocument changes to Construction Graph version/events.
7. Prove semantic parity between web and Electron using the same benchmark fixtures.

## Recommendation

Adopt the web/desktop shared-renderer topology as Architecture v1.1 for the CAD/BIM application.

This changes application/runtime architecture but does not change Construction Graph authority, engine independence, provider independence, evidence requirements, or modular-monolith-first constraints.
