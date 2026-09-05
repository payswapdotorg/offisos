# Offisos Worker Model — Persistent Asynchronous CAD/BIM Execution

**Status:** DRAFT (INFRA-001 deliverable)
**Architecture version:** 1.1 (FROZEN — engines stay behind the EngineAdapterBundle/worker boundary, LOCK-003/018)
**Companions:** `offisos-serverless-architecture.md`, `offisos-persistence-model.md` (jobs schema), `offisos-infrastructure-roadmap.md` (INFRA-006)

---

## 1. The problem

Vercel functions cannot run the native CAD/BIM toolchain:

- **OCCT 7.8.1.1** (via `cadquery-ocp`, the kernel FreeCAD builds on) — heavy native
  Python imports, memory spikes on booleans/tessellation, subprocess isolation
  requirements (`prlimit` address-space ceilings are enforceable *only because the
  worker is a disposable process* — `occt-process.ts`).
- **IfcOpenShell 0.8.5 + IfcTester** — the IFC/IDS/BCF toolchain, absent on Vercel
  (production `ifc.*` returns the typed `ifc_unavailable` decline — honest, but a
  capability gap).
- **Wall-clock budgets** — geometry calls carry a 15s default; heavy regeneration
  (docs regenerate, quantity takeoff over large models, stream warm) exceeds what a
  request-scoped function should own.

Today's serverless-honest answer is the reference-engine fallback (deterministic,
provenance-recorded) plus client-driven `jobs.tick`. The production answer is a
**persistent worker service**: long-running, warm, toolchain-complete, executing
durable jobs claimed from the authoritative job records.

## 2. What already exists (the audit's building blocks)

| Building block | Where | Reuse |
|---|---|---|
| JSON-over-stdio worker protocol | `app/src/adapters/occt/worker-protocol.ts`, `ifc-worker-protocol.ts` | The worker service fronts the SAME protocol — the service wraps the process contract, not a new engine API |
| Process-per-call isolation (timeout, stdout cap, rlimits) | `occt-process.ts`, `ifc-process.ts` | Unchanged inside the service; the service adds claim/heartbeat/retry around it |
| Durable stepwise jobs (queued → running → terminal, one deterministic step per tick) | `app/src/jobs/index.ts` (JobStore, persisted in the P016 record; INFRA-006 promotes to the Neon `jobs` table) | The job machine is the claim protocol's state model; workers become tickers |
| Revision binding on outputs | `buildResult`'s `revisionBinding` (version id/number, content hash, model revision) | Every worker output carries it; results rejected on head mismatch ("worker output never authority") |
| Engine-availability wiring pattern | `route.ts` ENGINE_MODE (reference/occt/auto + typed fallback) | The App API selects local adapter vs remote worker service at the wiring point — LOCK-003 discipline |
| Job kinds (closed vocabulary) | `JOB_KINDS`: `docs.regenerate`, `quantity.recalculate`, `model.stream.warm` | Extended additively: `ifc.import`, `ifc.export`, `geometry.prepare`, `dxf.*`, `mesh.*`, maintenance GC |

## 3. The job lifecycle (durable, claim-based, honest)

```text
1. REQUEST  (Vercel function)
     → INSERT jobs (status=queued, input_binding = the current head revision binding,
       params, total_steps, max_attempts)           [Neon — the authority]
     → respond immediately with the job view (the client is free to poll/stream)
2. CLAIM    (worker service)
     → UPDATE jobs SET status='claimed', claimed_by=$worker, claim_lease_until=now()+lease,
       attempts=attempts+1 WHERE job_id=$id AND (status='queued' OR claim_lease_until < now())
     → exactly-one-claimer semantics via the conditional UPDATE (the CAS pattern)
3. EXECUTE  (worker)
     → load inputs by reference (R2 body for the input revision — hash-verified)
     → run the deterministic step(s) through the process-per-call engine workers
     → produce result artifacts (content-addressed R2 writes: jobs/{id}/result-{sha}.json)
4. COMPLETE (worker)
     → UPDATE jobs SET status='succeeded', result_ref=$r2key, step=total_steps …
       (input_binding re-checked against the CURRENT head: a stale binding marks the
        result stale — typed, never silently applied)
5. PROMOTION (never automatic)
     → canonical state changes ONLY through the caller's explicit document command path
       (the JOB_PERSIST_HINT contract — unchanged)
```

Failure semantics: worker crash → lease expires → the job returns to `queued`
(attempts + 1); attempts exhausted → `retired` with the typed failure record; every
transition is a durable row update, so the job's timeline survives any executor death
(the same property the P016 tick machine already proves).

Client-visible surface: `jobs.create` / `jobs.get` / `jobs.list` keep their shapes; a
`jobs.subscribe` stream (SSE) is an additive convenience — polling remains the honest
baseline (the deployed smoke already drives jobs through the App API).

## 4. Worker service topology

```text
┌─ Worker service (Railway primary / Cloud Run alternative) ────────────────┐
│  HTTP ingress (HMAC-claim auth)                                           │
│  claim loop: poll claimable jobs (or receive a notify webhook)            │
│  per job: lease → execute → persist result → complete                     │
│  engine sandbox: the existing process-per-call python workers             │
│    (occt-worker.py / ifc-worker.py — pinned toolchain image)              │
│  NO authoritative state inside the service                                │
└──────────────────────────────────────────────────────────────────────────┘
     ↑ claim/complete (Neon)                    ↑ bodies/results (R2)
     └── Vercel functions create jobs ──────────┘ (reference: the CAS/registry)
```

- The service is **stateless at rest**: all coordination lives in the jobs table;
  any instance can die at any moment; the lease protocol self-heals.
- Scale: run N replicas; leases make over-claiming impossible; each replica owns its
  engine pool (warm python processes → subprocess per call as today).
- The App API wiring point chooses per capability: local reference engine
  (deterministic, serverless-safe) vs remote worker (toolchain-complete) — the
  `ENGINE_MODE` pattern, extended with `OFFISOS_WORKER_URL`.

## 5. Platform analysis (evidence-driven, load-matched)

Requirements matrix (from the audit): pinned Python 3.12 toolchain
(`cadquery-ocp==7.8.1.1.post1`, `ifcopenshell==0.8.5`, `IfcTester==0.8.5`,
`numpy==2.1.3` — the exact CI pins, Docker-parity with the repo's own toolchain);
warm processes (heavy native imports); memory headroom (OCCT booleans/tessellation
spike to GBs on real models); subprocess spawning with rlimits; HTTP ingress with a
shared-secret claim protocol; negligible cold-start sensitivity for long jobs;
cost proportional to actual CAD workload (currently low/spiky).

| Platform | Warm processes | Toolchain (Docker) | Memory ceiling | Scale-to-zero | Ops overhead | Ingress security | Fit |
|---|---|---|---|---|---|---|---|
| **Railway** | ✅ persistent services | ✅ Dockerfile | ✅ up to ~8–32 GB plans | ⚠️ (service-level sleep) | **lowest** (git/CLI deploy, zero cloud choreography) | public HTTPS + env secrets (HMAC) | **Primary** |
| **Cloud Run** | ✅ min-instances=1 | ✅ container | ✅ up to 32 GB / 8 vCPU | ✅ (request-billed, min-instance warm) | medium (GCP project, SA, Artifact Registry) | IAM invoker (strongest) | **Alternative / scale-out** |
| Fly.io | ✅ machines (fast boot) | ✅ Docker | ✅ to 32 GB | ✅ auto-stop/machine | medium | public HTTPS + secrets | Viable; no differentiator at this scale |
| AWS ECS/Fargate | ✅ | ✅ | ✅ | ⚠ (service-level) | **highest** (VPC, IAM, ECR) | SG/ALB/IAM | Overkill now |
| Modal | ✅ warm containers | ⚠ Python-native packaging | ✅ | ✅ | low | URL auth | Strong OCCT fit, but the programming model (in-code decorators) conflicts with the port/adapter discipline — engine code would drift toward vendor SDK shape |

### Recommendation

- **Primary: Railway.** Rationale: (1) the worker is a want-warm persistent service —
  engine import cost and the process-per-call isolation model both favor
  always-alive processes; (2) Docker parity with the CI toolchain pins makes the
  image exactly the CI environment; (3) the lowest operational overhead matters for
  a solo/agent-driven project (no service-account choreography, no cloud project
  setup); (4) the claim protocol needs only a shared HMAC secret regardless of
  platform; (5) usage-based pricing without per-request cold-start penalties at the
  current low/spiky job volume.
- **Alternative: Cloud Run.** Adopt when job volume justifies scale-to-zero economics
  or when GCP org requirements exist: IAM-secured ingress (service-account invoker)
  is the strongest security model; `min-instances: 1` keeps the engine warm; generous
  limits; request-billed. The same container runs unmodified.
- **Explicitly deferred:** Fly.io (no differentiator), ECS/Fargate (overhead),
  Modal (programming-model lock-in vs. the adapter/port discipline).

The decision is revisable per evidence: the service contract (claim protocol + Docker
image) is platform-neutral, so switching primary is a redeploy, not a redesign.

## 6. Worker image (Dockerfile sketch — INFRA-006 implementation detail)

```dockerfile
FROM python:3.12-slim
# The exact CI pins (cad-parity-016.yml) — the toolchain the smokes certify:
RUN pip install --no-cache-dir \
      cadquery-ocp==7.8.1.1.post1 ifcopenshell==0.8.5 IfcTester==0.8.5 numpy==2.1.3
# Node runtime for the claim loop (or port the loop to Python — same contract):
COPY worker/ /opt/offisos-worker/
# prlimit availability (procps) for the address-space ceilings:
RUN apt-get update && apt-get install -y --no-install-recommends procps && rm -rf /var/lib/apt/lists/*
ENV OFFISOS_OCCT_WORKER=/opt/offisos-worker/occt-worker.py \
    OFFISOS_IFC_WORKER=/opt/offisos-worker/ifc-worker.py
# The worker scripts are THE REPOSITORY'S OWN app/src/adapters/*/worker/*.py —
# copied verbatim, zero fork.
CMD ["node", "/opt/offisos-worker/claim-loop.mjs"]
```

Health: a `/health` endpoint (engine ping: the existing `{"op":"ping"}` probe);
readiness gated on the Neon/R2 connectivity; liveness on the lease heartbeat.

## 7. Security model (the worker trust boundary)

- **Ingress:** job claims are HMAC-SHA256 signed (`job_id` + `nonce` + `exp`, short
  TTL); the endpoint rejects unsigned/expired/replayed claims typed. The Vercel
  functions hold the claim secret; the worker holds the verification key (rotation
  runbook in INFRA-007).
- **Data:** the worker reads only its claim's input references (R2 GET by key) and
  writes only `jobs/{job_id}/…` and `meshes/…` namespaces + its `jobs` row updates —
  least-privilege store credentials (scoped R2 token; Neon role with grants only on
  `jobs`).
- **Never authority:** worker outputs are artifacts + row updates; canonical state
  changes only through the App API document command path; stale revision bindings
  are rejected typed. This is the existing `JOB_PERSIST_HINT` contract, enforced.
- **Isolation:** process-per-call engine workers keep the rlimit/timeout/stdout-cap
  sandbox — the service adds nothing weaker.
- **Secrets:** live only in the service env; never in the repository, PR bodies,
  fixtures, or logs (LOCK-010).

## 8. Determinism & evidence

- Job execution remains a pure function of `(input_revision_body, params, step
  sequence)` — no wall-clock, no random, no environment leakage in outputs (the
  JobStore contract, preserved).
- Acceptance evidence for INFRA-006: deterministic worker-protocol tests (the
  existing app suite, unchanged), a claim-lease integration test against real
  postgres, a toolchain image parity check (the CI engine pins), and the deployed
  production `ifc.*` capability unlock (the typed `ifc_unavailable` decline becomes
  real IFC results — a directly observable browser/API delta, bound to the exact
  deployed revision).
