# RESEARCH-CAD-005 — CAD/BIM performance, scalability, and operational robustness benchmark

Issue #5 · Architecture v1.1 (frozen) · Research/feasibility only ·
Recommendation is the Architect's decision; VERIFIED is not claimed.

## Objective

Determine whether the candidate CAD/BIM stack (FreeCAD 1.1.3 /
OpenCascade 7.8.1, IfcOpenShell 0.8.5) is operationally viable for
representative ConstructionOS workloads behind the frozen adapter
boundary, by measuring performance, memory behavior, scalability,
determinism, failure recovery and resource isolation — separating
engine performance from Offisos adapter/translation overhead and
producing raw, reproducible evidence for the licensing/composition and
implementation-path decision.

## Layout

```
offisos_perfbench/
  harness.py            epistemic harness (vendored cad-004 conventions)
  resources.py          peak-RSS measurement (/proc VmHWM + child watcher)
  timing.py             repeated-run stats with ENGINE/ADAPTER split
  fixtures.py           tiered fixture corpus (IFC / OCCT / FCStd specs)
  ifc_adapter.py        the Offisos translation layer (the ADAPTER side)
  occt_engine.py        direct OCCT operations (the ENGINE side)
  freecad_runner.py     process-isolated FreeCADCmd runner (file-based
                        result protocol, timeouts, cancellation)
  benchmarks/
    bench_fixtures.py       tier characteristics + structural determinism
    bench_engine_ifc.py     IFC open/export/query scaling (engine vs adapter)
    bench_engine_occt.py    booleans, tessellation, STEP-IO + scaling cliff
    bench_engine_freecad.py process lifecycle, open/recompute/save/reopen
    bench_extraction.py     semantic + quantity extraction scaling
    bench_determinism.py    repeated-run variance, result determinism
    bench_robustness.py     malformed input, failed ops, corruption,
                            durable-write data-loss prevention
    bench_cancellation.py   non-preemptability proof, cancel, timeouts
    bench_isolation.py      process isolation, threads, exhaustion,
                            adapter/worker constraint synthesis
    run_all.py              orchestrator (resumable) + recommendation
tests/                   deterministic correctness gate (small tiers)
evidence/run-001/        the committed evidence package
```

## Fixture tiers (issue #5 scope 1)

| Tier | IFC fixture | OCCT workload | FreeCAD FCStd |
|---|---|---|---|
| small — small architectural model | 41 IfcProducts, 948 STEP entities, 55 KB | 24 primitives, 25-hole plate | 40 objects |
| medium — medium construction model | 237 products, 5,380 entities, 325 KB | 120 primitives, 100-hole plate | 240 objects |
| large — larger stress model (anticipated professional use) | 4,830 products, 109,036 entities, 6.9 MB, 30 storeys, 1,500 walls | 480 primitives, 400-hole plate | 840 objects |

All fixtures are procedurally generated and deterministic (pure index
arithmetic; no RNG). Structural determinism is asserted across rebuilds;
byte-identity is not expected because IFC GlobalIds are regenerated per
build (CAD-001 engine-nondeterminism finding, restated as an explicit
datum).

## Measurement model

Every timed operation is split at a stated, auditable boundary:

- **ENGINE** — time inside the candidate engine/library
  (ifcopenshell, OCCT, FreeCADCmd in-engine timings);
- **ADAPTER** — time in Offisos translation code (domain-id indexing,
  snapshot assembly, quantity records with provenance, mutation lineage,
  JSON serialization; subprocess+protocol overhead for the FreeCAD
  path).

Repeated operations record every sample plus min/median/mean/max/stdev
(``timing.py``); memory uses Linux ``/proc`` VmHWM with its monotonic
semantics documented, and a watcher thread records child-process peak
RSS.

## Environment / reproducibility

Pinned toolchain (see requirements.txt and evidence environment.json):
ifcopenshell 0.8.5, cadquery-ocp 7.8.1.1.post1 (OCCT 7.8.1), FreeCAD
1.1.3 AppImage (SHA256-pinned, installed without sudo). Absolute
wall-clock and memory numbers are environment-specific — recorded with
every run — and cross-environment conclusions use ratios/orderings only
(the local evidence run and the CI run use identical toolchains and
fixtures).

## Running

```
make test    # deterministic suite (small tiers, ~10 s)
make bench   # full evidence run (RUN_ID=run-001 default)
# CI: python -m offisos_perfbench.benchmarks.run_all ci-run
```

The full run is resumable: completed modules persist in ``.work/`` and
are reused on the next invocation (``CAD005_FRESH=1`` resets).

## Findings (see evidence/run-001 and report.md)

1. In-process cancellation of native engine calls is impossible
   (measured: cancel-requested native call runs to full duration);
   cancellation and timeouts must be enforced at the process boundary
   (typed ``EngineTimeout``, SIGTERM→SIGKILL measured).
2. Threads do not parallelize native engine work (measured speedup
   ≈1.2–1.4× on 3 threads); parallelism requires process workers.
3. Multi-tool boolean operations scale superlinearly and hit a cliff
   (measured 20.4× time ratio between 400 and 500 tools) — decompose
   large booleans into bounded batches.
4. Truncated IFC files open "successfully" as silently partial models
   (lazy STEP parsing) — the adapter MUST structurally validate
   imports; the OCCT STEP reader tolerates NUL-byte corruption.
5. Resource exhaustion under RLIMIT_AS is never a clean engine failure
   (typed ImportError at 256 MB; hard SIGSEGV mid-allocation at 1 GB) —
   viable only because workers are disposable processes.
6. Durable writes (temp + atomic rename) preserve artifacts under
   mid-write crashes (measured); malformed inputs fail typed and
   recoverable at the adapter boundary.

Recommendation: **(b) candidate remains operationally viable with
explicit constraints** — the constraints above are measured properties
of the engine boundary, not blockers.
