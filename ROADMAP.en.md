# BitTune Roadmap

简体中文 ｜ [English](ROADMAP.en.md)

> This document describes BitTune's public direction for users and contributors. Stages are defined by the results a user can obtain, not by dates or feature counts; entries are deliberately kept at the theme level. Last updated: 2026-08-27.

Status legend:

| Mark | Meaning |
|---|---|
| ✅ Shipped | Available in an official Release |
| 🚧 In progress | Active goals on the current development line |
| 📋 Planned | Committed direction for upcoming versions |
| 💭 Exploring | Direction holds, entry conditions not yet met — discussion welcome |

## Product main line

Bittune is a local-first inference deployment and optimization agent: it helps users who already have compute — a multi-GPU machine or a usable cluster — find better deployment configurations for their models and keep improving them through real testing.

All planning advances along one main line:

```text
user goal → agent understanding → few managed domain tools → deterministic engineering core
          → real deployment and real measurement → auditable experiment records → reusable performance knowledge
```

Two invariant principles:

- The LLM handles understanding, trade-offs, and explanation; every number must come from deterministic tools and real measurements — never gut feeling.
- Get single-machine right first, then extend to multi-GPU and clusters through stable boundaries; extension means adding implementations, not rewriting the upper layers.

## ✅ Shipped

Per the latest [Release](https://github.com/bitcloud-ai/BitTune/releases), the current baseline includes:

- A Linux x86_64 single-node installer with offline installation support and `bittune doctor` environment self-checks.
- A unified managed lifecycle for multiple inference engines (currently vLLM and SGLang): restricted-configuration creation, readiness checks, endpoint probing, log reading, and stopping.
- Standardized performance benchmarking and measured operating-point derivation — a single success is never misreported as maximum capacity.
- Run Record / Artifact execution evidence: sensitive fields auto-redacted; failures are recorded too.
- Tuning experiment recording and comparison, with every conclusion bound to environment fingerprints and configuration hashes.
- TUI interaction with session resume; optional connection to administrator-configured read-only MCP reference sources.

## 🚧 In progress

- Splitting hardware inspection, model discovery, deployment, and benchmarking out of a single implementation into a deterministic core layer with versioned boundaries, so the same pipeline can be tested and replaced independently.
- Hardening tuning-data retention policy: execution evidence always stays local; any export or sharing requires explicit authorization and data minimization.
- Freezing acceptance evidence for the multi-engine closed loop (baselines, regression, rollback) in real GPU environments.

## 📋 Planned · next major cycle

Together these goals answer one question: **make the interfaces others depend on stable, and win freedom of replacement for internal implementations.**

1. **Public domain contracts**
   Environment facts, model profiles, workload profiles, deployment intents, benchmark results, and experiment records expressed as versioned public contracts; the Agent works against contracts, not against any engine's specific parameters.
2. **Engine adapter interface**
   New inference engines plug in by implementing adapters for lifecycle, observation, and benchmarking — no changes to the agent layer. This will be the first clear contribution path for the community.
3. **Experiment record v1**
   "Deploy A → benchmark → Deploy B → benchmark → compare" becomes a first-class operation: conclusions can be replayed, cited, and traced across sessions.
4. **Local performance registry v0**
   Answer locally: "same hardware, same model, same workload — what did we measure before?" Data schema comes before data scale.
5. **Reports and human-readable output**
   Tuning reports structured into two layers — machine-verifiable plus directly human-readable — as the basic unit for external sharing.

## 🌤 Later · mid-term themes

The following themes enter scheduling sequentially after the "Planned" group completes; ordering follows real-world feedback:

- **Multi-GPU and topology awareness**
  NUMA, interconnect, and communication bottlenecks become first-class observed facts, supporting diagnosis and advice for parallelism strategies.
- **Constrained adoption of existing clusters**
  Capability discovery and managed deployment on Kubernetes GPU clusters you already run, reusing exactly the same ownership, authorization, evidence, and rollback semantics as single-machine mode.
- **Distributed serving forms**
  Beyond aggregated serving, build planning, deployment, and evaluation capabilities for disaggregated Prefill/Decode forms.
- **Prior-guided search**
  Narrow the candidate space with performance prediction and historical priors; predictions are always validated by real benchmarks with recorded deviations — turning wide blind sweeps into few, precise, verifiable experiments. The end state does not remove benchmarks; it predicts hundreds of configurations first, then verifies only the most valuable few for real.
- **Open data exchange format**
  Import/export formats for anonymized benchmark datasets and hardware profiles so the community can exchange verifiable performance knowledge while nothing leaves your machine by default.

## 💭 Exploring

- Accelerator support beyond NVIDIA (depends on ecosystem maturity and real demand).
- Visualization views for a local web console.
- A standard plugin mechanism for third-party agent components to integrate with the product framework.
- Windows / macOS host experience (lowest current priority).

## Explicit non-goals

Non-goals matter as much as the roadmap; none of the following will appear in any near-term release:

- Bittune does not install cluster infrastructure, does not build its own scheduler, and does not replace existing resource management systems.
- Externally running model services are read-only by default; only resources created and ownership-registered by Bittune are ever managed.
- No resident production monitoring/alerting platform; continuous observation is a later stage with its own entry conditions.
- Hosted cloud consoles, centralized multi-device operations, and commercial value-added services are outside this repository's scope and delivered separately via official distributions.
- No promise of "works out of the box on any hardware": every new device class passes a real-environment identity and artifact verification gate before being declared supported.

## Long-term constraints across all stages

Full discussions live in [`docs/architecture/`](docs/architecture/README.md); excerpted items that apply everywhere:

- The Agent only proposes; all real operations go through managed tools that can be authorized, cancelled, recovered, and rolled back.
- Permission, resource ownership, and evidence are three orthogonal concepts and must not be conflated with tool visibility.
- Every significant conclusion distinguishes its source: declared / detected / measured / modeled / inferred.
- Each stage validates user outcomes in real environments before expanding permissions or environment scope.

## How to participate and influence the roadmap

- Share ideas through Issues (`feature_request` template) or start Discussions.
- For larger design changes, open an RFC-style Discussion first and reach consensus before development starts.
- This document is maintained on a rolling window (usually synced per minor release); "Planned" items get broken down into implementation plans with acceptance criteria when they enter development (see [`docs/plans/`](docs/plans/current.md)).
- Please do not report security vulnerabilities in public issues — follow [`SECURITY.md`](SECURITY.md).
