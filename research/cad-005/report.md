# RESEARCH-CAD-005 findings report

Evidence: `evidence/run-001/` (local run, 2026-08-25, 2-core Intel Xeon,
ifcopenshell 0.8.5 · OCCT 7.8.1.1 (cadquery-ocp 7.8.1.1.post1) · FreeCAD
1.1.3 AppImage). Total: **83 pass / 0 fail / 0 unknown**. Absolute times
are environment-specific; cross-environment conclusions use ratios and
orderings only (CI reproduces the identical run on the identical pinned
toolchain and fixtures — see the workflow artifact).

Recommendation: **(b) the candidate remains operationally viable with
explicit constraints.** Every constraint below is a measured property
recorded in the evidence, not an assumption.

## 1. Fixture scales (issue scope 1)

| Tier | IfcProducts | STEP entities | File | OCCT workload | FCStd doc |
|---|---|---|---|---|---|
| small | 41 | 948 | 55 KB | 24 primitives / 25-hole plate | 40 objects |
| medium | 237 | 5,380 | 325 KB | 120 primitives / 100-hole plate | 240 objects |
| large | 4,830 | 109,036 | 6.9 MB | 480 primitives / 400-hole plate | 840 objects |

The large tier is a 30-storey, 1,500-wall building — representative of
anticipated professional use at the file sizes this environment can
exercise. Structural determinism of fixture generation is asserted
(rebuild ⇒ identical counts/totals); byte-identity is impossible because
IFC GlobalIds regenerate per build (CAD-001 finding, restated as an
explicit datum).

## 2. Core operations, engine vs Offisos translation (issue scopes 2–3)

Median wall-clock, engine + adapter split at a stated boundary:

| Operation | small | medium | large | adapter share (L) |
|---|---|---|---|---|
| IFC open + domain indexing | 15 ms | 77 ms | 1,233 ms | **43.6%** |
| IFC controlled export (mutation+lineage / serialize) | 4+4 ms | 14+31 ms | 83+350 ms | 19% of total |
| Semantic extraction (psets / snapshot+JSON) | 9 ms | 55 ms | 1,059 ms | ~54% |
| Quantity extraction (qto+BRep / records) | 6 ms | 35 ms | 712 ms | ~35% |
| Boolean cut chain | 183 ms | 879 ms | 2,876 ms | 5.9% |
| Tessellation (view-pipeline proxy) | 6 ms | 43 ms | 1,403 ms | — |
| FreeCAD open → edit → recompute → save → reopen | 408 ms | 1,168 ms | 3,647 ms | in-engine timings |

Throughputs (first-sample): IFC open ≈ 3.9k elements/s at the large
tier; semantic extraction ≈ 4.4k elements/s (stable across tiers);
quantity extraction ≈ 2.1k walls/s; sequential booleans 128–160/s;
tessellation 100k triangles/s (small shapes) falling to 17k/s on the
400-hole stress shape.

**Offisos translation overhead is material** — 36–54% of end-to-end
time on the IFC/semantic paths (grows with element count; the engine
side improves per-element with scale while the adapter side stays
roughly linear). Any production threshold set in the compatibility
matrix must budget adapter time separately from engine time; measuring
"the engine" alone would understate end-to-end latency by ~1.8× on the
semantic path.

FreeCAD process overhead (subprocess + JSON protocol, the process-
isolation tax) is 94–225 ms per engine call — cheap relative to
document operations at every tier, making process-per-call isolation
affordable.

## 3. Memory and resources

- FreeCAD engine child peak RSS: 35 MB cold start; 94/107/146 MB at
  small/medium/large documents.
- IFC open+index+serialize phase: RSS 509→637 MB in the benchmark
  process (VmHWM growth 44 MB at the large tier; the process had already
  peaked from fixture generation — monotonic VmHWM semantics documented
  in every record).
- File sizes scale linearly (55 KB → 6.9 MB).

## 4. Repeated-run variance and determinism (issue scope 4)

Coefficients of variation over 10 identical runs: IFC open **4.1%**,
semantic extraction **1.9%**, boolean chain **0.9%** — timings are
distributions, never single best-case samples (full sample lists in the
evidence). Result determinism: extraction outputs are **byte-identical**
across repeats; OCCT volumes identical; quantity records identical; IFC
GlobalIds explicitly nondeterministic across regeneration (domain ids
canonical — Architecture v1.1 invariant).

## 5. Failure, recovery, corruption (issue scope 4)

- Malformed IFC (garbage bytes, wrong schema header) → typed
  `AdapterFailure(malformed_input)`, recoverable, engine exception type
  recorded; valid operations succeed afterwards in the same process.
- **Toolchain finding:** a *truncated* IFC file opens "successfully" as
  a **silently partial model** (lazy STEP parsing; 7 of 12 walls). The
  adapter MUST structurally validate imports (counts/checksums) —
  recorded as an operational constraint, with the detection exercised.
- Degenerate primitives are rejected by OCCT with a typed
  `Standard_DomainError`; the adapter converts engine exceptions to
  typed `AdapterFailure(engine_error)` (LOCK-003 exercised on a real
  failure). Valid complex booleans succeed after each failure (recovery
  proven for every scenario).
- **Toolchain finding:** the OCCT STEP reader *tolerates* NUL-byte
  corruption mid-file (reads 4 solids silently) but refuses truncation
  with a typed `IFSelect_RetFail` — artifact validation needs checksums
  at the Offisos boundary, not just reader success.
- Corrupted FCStd reopen is contained inside the isolated engine
  subprocess.
- Data-loss prevention: the durable-write pattern (temp + atomic
  rename) leaves the original intact after a simulated mid-write crash
  and commits atomically — measured, including under process
  interruption (no partial FCStd at the target path).

## 6. Cancellation, interruption, timeouts (issue scope 4)

- **In-process cancellation is impossible**: with a cancel flag
  requested during a long native OCCT call, the call runs to its full
  baseline duration (measured: baseline 1.02 s vs
  cancel-requested-attempt 1.05 s) and the flag is observed only after
  the call returns. Native engine calls are not preemptable from
  Python.
- Process-level cancellation works and is fast: SIGTERM (escalating to
  SIGKILL) kills a long FreeCAD build in < 1 s, commits **no partial
  artifact**, and the parent survives.
- Timeouts fire as a typed `EngineTimeout` at the process boundary
  (measured: 2 s budget fired at ~2.1 s, runaway process killed).
- After cancellation and timeout kills, the next engine subprocess run
  starts and completes normally (worker restart recovery).

## 7. Adapter operational behavior (issue scope 5)

- **Process isolation**: the parent/host process never imports FreeCAD
  (asserted in evidence); every FreeCAD call runs in a fresh subprocess
  with identical results across consecutive runs (no cross-call state
  dependence). ifcopenshell in-process state is file-scoped (no
  cross-contamination between concurrently open files — measured).
- **Threads do not parallelize native engine work**: 3 threaded
  extractions vs sequential measured speedup 1.63× (far from 3×; the
  gap is GIL contention plus non-releasing native calls — and 1.63× is
  itself host-noise sensitive). Parallel engine work requires process
  workers.
- **Resource exhaustion is recorded, not omitted**, in both measured
  modes: a 256 MB `RLIMIT_AS` ceiling prevents OCCT/VTK library mapping
  (typed `ImportError` — engine never starts); a 1 GB ceiling lets the
  engine start and then the native allocator dies **hard mid-allocation
  (SIGSEGV, rc −11)**. The engine does not fail cleanly under
  address-space exhaustion — rlimits are enforceable only because the
  worker is a disposable process.
- **Multi-tool boolean scaling cliff**: one `BRepAlgoAPI_Cut` with N
  cylinder tools scales superlinearly — 100/225/400/500 tools measured
  0.46/1.07/4.58/97.28 s (**20.4× jump between 400 and 500 tools**;
  per-hole cost 4.6 → 186 ms). This is the identified workload where
  the candidate becomes materially slower; constraint: decompose large
  multi-tool booleans into bounded batches and enforce per-op timeouts.

### Adapter/worker constraints for the modular monolith (synthesis)

1. Engine calls run in **disposable subprocesses** (process-per-call or
   a worker pool) — required by non-preemptability (6), thread
   non-parallelism (7), and exhaustion containment (7).
2. Every engine invocation gets a **wall-clock timeout** enforced at
   the process boundary with SIGTERM→SIGKILL escalation (typed
   `EngineTimeout`).
3. Per-worker **RLIMIT_AS ceiling** — exhaustion is survivable only at
   the process boundary; the parent survives both measured modes.
4. **Structural validation + checksums on every import** — the engines
   do not reliably detect truncation (IFC) or NUL corruption (STEP).
5. **Bounded-batch boolean decomposition** + per-operation budgets —
   the multi-tool cliff is real and steep.
6. **Durable writes** (temp + atomic rename) for every artifact —
   measured data-loss prevention under interruption.
7. Engine startup cost (FreeCAD cold start 82–114 ms; protocol overhead
   94–225 ms/call) is small enough that process-per-call isolation is
   affordable at every measured tier.

## 8. Where the candidate exceeds resources / becomes unstable

At the exercised tier scales: nowhere (all operations complete with
bounded time and memory; largest tier stated above). The two
stress-boundary data points recorded: the multi-tool boolean cliff
(500 tools ⇒ 97 s) and forced address-space exhaustion (SIGSEGV under a
1 GB ceiling). Neither occurs at tier-scale workloads; both define the
constraints above.

## 9. Comparability statement

The local evidence run and the CI run execute identical pinned
toolchains on identical fixtures, but on different hardware (CI =
GitHub-hosted `ubuntu-latest`). Absolute wall-clock/memory numbers are
not comparable across those environments; the evidence records ratios,
orderings, throughput classes and failure modes as the comparable
currency, with each run's environment snapshot attached
(`evidence/*/environment.json`).
