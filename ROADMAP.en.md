# Bittune Roadmap

简体中文 ｜ [English](ROADMAP.en.md)

> This document describes Bittune's public direction for users and contributors. Stages are defined by the results a user can obtain, not by dates or feature counts; entries are kept at the theme level so they can be expanded or collapsed as needed. Last updated: 2026-08-27.

Status legend:

| Mark | Meaning |
|---|---|
| ✅ Shipped | Available in an official Release |
| 🚧 In progress | Active goals on the current development line |
| 📋 Planned | Committed direction for upcoming versions |
| 💭 Exploring | Direction holds, entry conditions not yet met — discussion welcome |

## Product main line

Bittune is the local-first open-source agent and engineering execution entry point of the broader BitTune product. It helps users who already have compute — a multi-GPU machine or a usable cluster — find better deployment configurations and improve them through real testing. The complete product roadmap also includes Cloud certification and management, community, leaderboards, knowledge return, and an optional Router commercial entry.

All planning advances along one main line:

```text
user goal → Local agent → managed domain tools → real deploy/benchmark/tune
          → auditable local evidence → explicitly consented minimized experience
          → Cloud comparable cohorts → community/leaderboards → approved signed knowledge return
          → real Local validation again → optional Router publishing
```

Prioritize a correct and complete single-machine experience before extending to multi-GPU and clusters; optimization conclusions always come from real measurements, never estimates. Cloud experience, community data, and rankings may narrow the search but never replace target-device validation.

### Status boundary

- The current `0.4.0` repository is primarily the Pi-based local agent: TUI, Domain Tools, vLLM/SGLang, benchmarking and tuning, local evidence, session resume, and read-only MCP.
- BitTune Cloud, the Web community, leaderboards, knowledge return, and Router are full-product roadmap items. Their presence in this roadmap is not a claim that this repository has already delivered them.

## ✅ Shipped

Per the latest [Release](https://github.com/bitcloud-ai/Bittune/releases), the current baseline includes:

- A Linux x86_64 single-node installer with offline installation support and `bittune doctor` environment self-checks.
- A unified managed lifecycle for multiple inference engines (currently vLLM and SGLang): restricted-configuration creation, readiness checks, endpoint probing, log reading, and stopping.
- Standardized performance benchmarking and measured operating-point derivation — a single success is never misreported as maximum capacity.
- Run Record / Artifact execution evidence: sensitive fields auto-redacted; failures are recorded too.
- Tuning experiment recording and comparison, with every conclusion bound to environment fingerprints and configuration hashes.
- TUI interaction with session resume; optional connection to administrator-configured read-only MCP reference sources.

## 🚧 In progress

- Refactoring hardware inspection, model discovery, deployment, and benchmarking into independently updatable modules.
- Hardening tuning-data retention policy: execution evidence always stays local; any export or sharing requires explicit authorization and data minimization.
- Freezing acceptance evidence for the multi-engine closed loop (baselines, regression, rollback) in real GPU environments.

## 📋 Planned · staged product roadmap

### P1: Productize the Local engineering loop

- Public versioned contracts for environment, model, workload, deployment, baseline, Trial, and report data.
- Engine adapter interface so new engines do not require changes to the agent loop.
- A replayable `Baseline → Candidate → like-for-like retest → comparison report` object.
- Local performance registry for prior measurements in comparable environments.
- Machine-verifiable and human-readable report layers.

**Exit condition:** fixed real-GPU acceptance evidence for vLLM/SGLang inspection, deployment, benchmarking, tuning, recovery, and reporting.

### P2: Cloud connection, certified catalog, and multi-device management

- Outbound-only device registration; raw Evidence is not uploaded by default.
- Certified model/fixed-revision/quantization/engine/tool combinations and signed manifests.
- Local version, compatibility, upgrade policy, artifact index, and optional Harbor/customer-registry management.
- Web management for users, organizations, devices, node groups, task projections, report indexes, and consent.
- Cloud combinations remain candidates; Local still verifies signatures, obtains user confirmation, and performs real validation.

**Exit condition:** independent acceptance for identity, tenancy, consent, data scope, signed catalog, offline degradation, withdrawal, and deletion.

### P3: Community and reviewable leaderboards

- User, team, and hardware-vendor profiles with optional identity disclosure.
- Discussions, citations, follows, and reproducibility feedback around devices, models, engines, tuning outcomes, and reports.
- Comparable cohorts keyed by GPU/topology, model/revision/quantization, engine/version, workload, and environment fingerprint.
- Rankings for throughput, latency, memory headroom, stability, tuning improvement, reproducibility, and contribution.
- Only complete, comparable, contention-free evidence above the minimum gate enters official rankings.

**Exit condition:** formal comparability, privacy, anti-gaming, appeal, withdrawal, and visibility rules with accepted datasets.

### P4: Knowledge return, continuous learning, and Router

- Consent-based redacted Experience is cohort-built separately for success, no-gain, and failure outcomes.
- Cohorts produce Knowledge Candidates; quality, privacy, security, license, and human review produce signed Knowledge Packs.
- Staged rollout, usage trace, instant revocation, and rollback; Local still validates every prior.
- Production-accepted model services may optionally enter Router publishing, routing, metering, revenue, and delisting flows.

**Exit condition:** the experience-to-knowledge chain is auditable, revocable, and rollback-capable, and Router authorization remains separate from Local tuning.

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
  Import/export formats for anonymized benchmark datasets and hardware profiles as an offline interoperability path; this does not replace consent, signatures, or evidence gates.

## 💭 Exploring

- Accelerator support beyond NVIDIA (depends on ecosystem maturity and real demand).
- Fully offline local Web views, separate from the planned Cloud Web management plane.
- A standard plugin mechanism for third-party agent components to integrate with the product framework.
- Windows / macOS host experience (lowest current priority).

## Explicit non-goals

Non-goals matter as much as the roadmap; none of the following will appear in any near-term release:

- Bittune does not install cluster infrastructure, does not build its own scheduler, and does not replace existing resource management systems.
- Externally running model services are read-only by default; only resources created and ownership-registered by Bittune are ever managed.
- No resident production monitoring/alerting platform; continuous observation is a later stage with its own entry conditions.
- No promise of "works out of the box on any hardware": every new device class passes a real-environment identity and artifact verification gate before being declared supported.

## Long-term constraints across all stages

- All real operations go through managed tools that can be authorized, cancelled, recovered, and rolled back.
- Every significant conclusion states its source and evidence.

## How to participate and influence the roadmap

- Share ideas through Issues (`feature_request` template) or start Discussions.
- For larger design changes, open an RFC-style Discussion first and reach consensus before development starts.
- This document is maintained on a rolling window (usually synced per minor release); "Planned" items get broken down into implementation plans with acceptance criteria when they enter development.
- Please do not report security vulnerabilities in public issues — follow [`SECURITY.md`](SECURITY.md).
