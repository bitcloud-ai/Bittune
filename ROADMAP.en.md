# Bittune Roadmap

简体中文 ｜ [English](ROADMAP.en.md)

> This document describes Bittune's product positioning and direction. Stages are defined by the results a user can obtain, not by dates; entries are kept at theme level so they can be expanded or collapsed as needed. Last updated: 2026-08-28.

## What Bittune is

Bittune is an open-source inference engineering agent that runs on your own GPU machine: you state the goal in natural language, and it handles environment inspection, model selection, vLLM/SGLang deployment, performance benchmarking, and parameter tuning — recording every conclusion as auditable execution evidence.

The product consists of two parts:

- **Bittune Local** (open source today): a conversational agent running on the user's GPU device, performing detection, deployment, benchmarking, tuning, and evidence recording locally.
- **BitTune Cloud** (planned): an optional cloud platform providing a certified catalog of model/quantization/engine/tool combinations, multi-device management, a community with verifiable leaderboards, experience-based knowledge feedback, and Router listing for validated model services.

One core principle: **the cloud provides facts, the client executes for real.** Cloud catalogs, community experience, leaderboards, and knowledge packs are candidates only — every deployment and tuning action happens on the user's device, confirmed by the user, through managed tools. Raw prompts, model outputs, secrets, and datasets stay on the device.

Status legend:

| Mark | Meaning |
|---|---|
| ✅ Shipped | Available in an official Release |
| 🚧 In progress | Active goals on the current development line |
| 📋 Planned | Committed direction for upcoming versions |
| 💭 Exploring | Direction holds, entry conditions not yet met — discussion welcome |

## ✅ Shipped

Per the latest [Release](https://github.com/bitcloud-ai/Bittune/releases), the current baseline includes:

- A Linux x86_64 single-node installer with offline installation support and `bittune doctor` environment self-checks.
- A unified managed lifecycle for multiple inference engines (currently vLLM and SGLang): restricted-configuration creation, readiness checks, endpoint probing, log reading, and stopping.
- Standardized performance benchmarking and measured operating-point (MeasuredOperatingPoint) derivation.
- Run Record / Artifact execution evidence: sensitive fields auto-redacted; failures are recorded too.
- Tuning experiment recording and comparison, with every conclusion bound to environment fingerprints and configuration hashes.
- TUI interaction with session resume; optional connection to administrator-configured read-only MCP reference sources.

## 🚧 In progress

- Polishing environment inspection, model discovery, deployment, and benchmarking into independently updatable modules, so engine and capability upgrades land smoothly.
- Refining local evidence retention and authorized sharing: evidence stays local; export and sharing are explicitly authorized by the user and minimized automatically.
- Completing regression validation of the vLLM and SGLang closed loop in real GPU environments, shipping every release with a full evidence chain.

## 📋 P1 · Productizing the local engineering loop

Upgrade "it runs" into "it delivers, is verifiable, and can be cited", producing dual-layer tuning reports — machine-verifiable plus human-readable — the basic unit for community sharing and knowledge feedback.

- **Public domain contracts**: environment facts, model profiles, workload profiles, deployment intents, benchmark results, and experiment records expressed as versioned public contracts.
- **Engine adapter interface**: new inference engines plug in by implementing adapters for lifecycle, observation, and benchmarking — no changes to the agent layer.
- **First-class experiment loop**: "Deploy A → benchmark → Deploy B → benchmark → compare" becomes replayable, citable, and traceable across sessions.
- **Local performance registry**: answers locally — "same hardware, same model, same workload: what did we measure before?"
- **Dual-layer reports**: machine-verifiable plus directly human-readable report formats.

## 📋 P2 · BitTune Cloud connectivity, certified catalog, and multi-device management

Local stays fully functional offline; connecting to the cloud adds a certified catalog and multi-device management. How the two sides work together: execution evidence produced locally is synced to the cloud as summaries and signed references after user authorization; catalogs and knowledge packs delivered by the cloud are verified, user-confirmed, and validated on the target device before becoming executable candidates.

- **Outbound-only secure connection**: device registration and data sync use outbound encrypted channels only; losing connectivity degrades gracefully to pure local mode.
- **Certified combination catalog**: signed catalog of models (pinned revisions) / quantization variants / engines / tool combinations; the client re-verifies compatibility locally before anything becomes a candidate.
- **Version and artifact governance**: agent version compatibility, upgrade policies, signed manifests, and artifact indexes (optional Harbor image distribution).
- **Organization and device management**: a web console for users, organizations, devices, and multi-node groups.
- **Data consent**: user-selected data scope with withdrawal and deletion; only summaries and signed references are ever synced.

## 📋 P3 · Community and verifiable leaderboards

A collaboration network around signed-evidence tuning cases, so validated results can be discovered, reproduced, and compared.

- **User / team / device-vendor profiles**: public cases, contribution records, and badges.
- **Signed-evidence case library**: model, engine, device, benchmark, tuning results, and applicability; case facts come from signed evidence, while discussions and likes are part of the conversation around each case.
- **Reproduce on my device**: the web generates a reproduction request; you return to the local CLI, re-detect, confirm, execute, and produce new evidence.
- **Like-for-like leaderboards**: comparable groups formed by "GPU model/count/topology + model/revision/quantization + engine/version + test standard + environment fingerprint", comparing throughput, latency, VRAM headroom, stability, and tuning gains; the leaderboard includes only results within a comparable group backed by signed evidence.
- **Privacy by choice**: private, tenant-visible, and public visibility tiers — users decide whether to reveal identity.

## 📋 P4 · Knowledge feedback, continuous learning, and Router

Turn reviewed experience into priors for the next recommendation, and connect validated model services to commercial supply.

- **Experience classification**: successful, no-gain, and failed experiences are modeled separately; failures form failure-avoidance knowledge.
- **Knowledge pipeline**: experience clustering → knowledge candidates → quality/privacy/security/license review → signed knowledge packs → staged rollout at 5%→25%→100%, revocable and rollback-ready.
- **Client-side re-validation**: knowledge packs and cloud priors only produce candidates; the client must re-detect, obtain user confirmation, and verify for real.
- **Recommendation improvement**: explainable rules and comparable-cohort statistics first; offline ranking-model training and shadow evaluation come later.
- **Router listing**: production-validated model services can apply for Router sandbox verification (interfaces, routing, metering, reconciliation); production listing and billing are a separate commercial stage.

## 🌤 Later themes

The following themes are scheduled based on real usage feedback as P1–P4 progress:

- **Multi-GPU and topology awareness**: NUMA, interconnects, and communication bottlenecks as first-class observed facts.
- **Distributed serving forms**: planning, deployment, and evaluation for disaggregated Prefill/Decode and similar forms.
- **Prior-guided search**: predict hundreds of configurations first, then verify only the most valuable few for real.
- **Open data exchange formats**: import/export for anonymized benchmark data and hardware profiles.
- **More accelerators and operating systems**: hardware beyond NVIDIA; Windows / macOS host experience.
- **Local web console visualization** and a plugin mechanism for third-party agent components.

## Product principles

- Conclusions come from real measurements; priors, predictions, and community experience must be verified on the target device with deviations recorded.
- Execution authority always stays client-side: every real operation goes through managed tools that can be authorized, cancelled, recovered, and rolled back.
- Every significant conclusion states its source and evidence; unverifiable content is explicitly marked as estimated.
- Data minimization: raw prompts, model outputs, secrets, and datasets stay on the device by default.

## How to participate and influence the roadmap

- Share ideas through Issues (`feature_request` template) or start Discussions.
- For larger design changes, open an RFC-style Discussion first and reach consensus before development starts.
- This document is maintained on a rolling window (usually synced per minor release); "Planned" items get broken down into implementation plans with acceptance criteria when they enter development.
- Please do not report security vulnerabilities in public issues — follow [`SECURITY.md`](SECURITY.md).
