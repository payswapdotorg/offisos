# RESEARCH-CAD-006 — CAD/BIM exact-version licensing/composition evidence

**Work item:** RESEARCH-CAD-006 (GitHub issue #6)
**Architecture version:** 1.1 (FROZEN)
**Scope (per Issue #6 directive):** exact-version licensing/composition
evidence for the stack actually tested across RESEARCH-CAD-001..005,
covering **both** the web deployment model and the Electron/desktop
deployment model. **No legal approval or production packaging change is
implied.** Composition approval is LICENSE-001's decision; this gate
produces the inventory and composition flags that feed it.

## What this gate is — and is not

This is a **records/inventory benchmark**, not an engine-exercise benchmark.
It records the exact tested components and versions from the authoritative
pinned sources (the CAD-001 `requirements.txt` pins, the CAD-001..005
`evidence/run-001/environment.json` snapshots, and the FreeCAD AppImage
SHA256 manifest), identifies each component's license from stable upstream
facts, raises composition flags for LICENSE-001, and analyses both
deployment models. It does **not** run FreeCAD/OCCT/IfcOpenShell and does
**not** approve any composition.

## Exact tested stack (authoritative)

| Component | Exact version | License | Tested in |
|---|---|---|---|
| IfcOpenShell | 0.8.5 | LGPL-3.0-or-later | CAD-001, CAD-003, CAD-004, CAD-005 |
| OCCT (via cadquery-ocp) | 7.8.1 | LGPL-2.1-or-later WITH OCCT-LINKING-EXCEPTION | CAD-001, CAD-002, CAD-003, CAD-005 |
| cadquery-ocp (bindings) | 7.8.1.1.post1 | Apache-2.0 | CAD-001..005 (distribution channel) |
| cadquery | 2.6.1 | Apache-2.0 | CAD-001..005 (distribution channel only) |
| ezdxf | 1.4.3 | MIT | CAD-001 (2D drafting gap-fill) |
| numpy | 2.1.3 | BSD-3-Clause | CAD-001..005 (transitive) |
| FreeCAD | 1.1.3 (AppImage, SHA256 `3a853eb6…`) | LGPL-2.1-or-later | CAD-001, CAD-002, CAD-005 |
| Python | 3.12.13 (local) / 3.11 (AppImage) | PSF-2.0 | runtime |

## Running

```bash
# deterministic correctness gate (CI runs this)
make test

# full evidence package -> evidence/run-001/
make bench
```

The harness is pure-Python and needs no CAD engine importable; versions are
read from the authoritative pinned sources and cross-checked against the
currently-importable distribution metadata where present.

## Layout

```
research/cad-006/
  Makefile                      deterministic test + evidence-run targets
  requirements.txt             pinned toolchain (pytest only; engines asserted from snapshots)
  report.md                     findings report (separates OBSERVED from INFERRED)
  offisos_licbench/
    harness.py                  BenchmarkResult + environment_snapshot + write_evidence
    inventory.py                TESTED_COMPONENTS + DEPLOYMENT_MODELS (the data model)
    benchmarks/
      bench_versions.py         exact versions recorded from pins + snapshots + live cross-check
      bench_licenses.py         upstream license facts + metadata cross-check
      bench_composition.py      composition flags for LICENSE-001 (no approval)
      bench_deployment_web.py    web deployment model analysis
      bench_deployment_desktop.py Electron/desktop deployment model analysis
      bench_replacement_path.py adapter boundary (v1.1) as the LGPL-compliance mechanism
      run_all.py                orchestrator -> evidence/<run-id>/
  tests/
    test_benchmark_suite.py     deterministic correctness gate
  evidence/run-001/             committed reference evidence run
```

## Honesty statement

Everything marked OBSERVED/CALCULATED is backed by a check in the evidence
run; INFERRED statements cite their supporting checks. The final composition
decision (proceed / proceed with constraints / reject / ACR) belongs to
LICENSE-001's legal/architect review — this gate recommends, it does not
decide, and it approves nothing.
