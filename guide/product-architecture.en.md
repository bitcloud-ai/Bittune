# BitTune Full Product Architecture

> This document covers both the current `Bittune-main 0.4.0` code and the broader BitTune product roadmap. "Implemented" means code and tests exist in this repository. Cloud, community, leaderboards, knowledge return, and Router are explicitly labeled as roadmap items and are not claimed as delivered repository features.

## One-sentence introduction

BitTune helps an existing single host, multi-GPU node, or GPU cluster move from "hardware exists" to "a verifiable model API is available": the local agent inspects, deploys, benchmarks, and tunes; Cloud supplies certified combinations, versions, artifacts, teams, and governed experience services; community and leaderboards turn comparable and reviewable tuning outcomes into shared knowledge.

## Architecture

```text
users / teams / hardware vendors
             |
       CLI / TUI / Web
             |
+---------- customer-side Bittune Local ----------+
| Pi conversation agent / session resume / tools  |
| inspect / discover / vLLM & SGLang execution    |
| baseline / tune / retest / report               |
| local SQLite / Run Record / Artifact             |
+--------------------------------------------------+
             |
       outbound secure connection
       authorized minimized projection up
       signed catalog/version/knowledge down
             |
+----------------- BitTune Cloud ------------------+
| identity, organization, device, version, policy  |
| certified model/quantization/engine/tool catalog |
| signed manifests and optional artifact registry  |
| experience cohorts, community, leaderboards      |
| approved knowledge rollout and optional Router   |
+--------------------------------------------------+
```

## Current Pi-based local agent

The repository uses Pi `0.84.1` packages for conversation and TUI. The model proposes the next trusted Domain Tool; deterministic tools perform real operations and preserve evidence. Current code includes Linux/GPU/Docker discovery, local model/runtime/service discovery, restricted vLLM and SGLang lifecycle operations, EvalScope benchmarking, operating-point and capacity-baseline derivation, tuning contexts/candidates/trials/comparisons/recovery, local SQLite WAL Run Records and Artifacts, session resume, isolated fresh experiments, and optional read-only MCP references.

## Cloud roadmap

Cloud is not a remote replacement for customer-side execution. Its role is to make certified product facts discoverable and governable: identities and teams; devices and node groups; Local versions and upgrade policy; models, fixed revisions, quantizations, engines and versions; approved tool combinations; dependencies, licenses, SBOMs, signatures and approvals; signed manifests and optional Harbor/customer-registry artifact distribution; tenant, data-scope, consent, quota, cost, and residency policy.

## Community roadmap

Community combines discussions with optionally shared, redacted tuning evidence. Planned surfaces include user/team/vendor profiles, device/model/engine topics, report and configuration citations, reproducibility feedback, follows, and contributor reputation. Users control private, tenant, or public visibility and whether identity is displayed.

## Leaderboard roadmap

Leaderboards compare evidence only after cohorting by GPU model/count/topology, model/fixed revision/quantization, engine/version, dataset and benchmark standard, token lengths and concurrency, and driver/runtime fingerprint. Ranking dimensions include throughput, first-token and end-to-end latency, memory headroom, stability, baseline-to-candidate improvement, report completeness, and reproducibility. Unsigned, incomparable, or resource-contended results do not enter official rankings.

## Knowledge return and continuous learning roadmap

```text
local Evidence
→ explicitly consented Experience Record
→ comparable cohort
→ Knowledge Candidate
→ quality/privacy/security/license review
→ signed Knowledge Pack
→ staged, revocable, rollback-capable delivery
→ real validation on the customer device
```

Success, no-gain, and failure experience remain separate. Cloud priors never directly authorize deployment.

## Router roadmap

After endpoint availability, identity, routing, metering, simulated revenue, and delisting checks pass, a user may separately authorize a validated model service for Router supply. Router publishing is not the default result of Local tuning and requires production acceptance and a commercial agreement.

## Non-negotiable boundaries

- Local-first by default; current local capabilities remain usable without Cloud.
- Raw prompts, outputs, secrets, datasets, and raw Evidence are not uploaded by default.
- Cloud catalogs, community experience, leaderboards, and MCP provide references and candidates, not execution authority.
- Models, engines, and configurations still require real validation on the target device.
- Sharing requires explicit data scope, consent, withdrawal, and deletion workflows.
- Cloud does not become a second authoritative local Run Record or Artifact store.

## Status summary

| Product area | Repository `0.4.0` status |
|---|---|
| Pi conversation, TUI, session resume | Implemented |
| Trusted Domain Tools and vLLM/SGLang loop | Implemented; real GPU support remains Release-specific |
| Local Run Records, Artifacts, tuning comparison | Implemented |
| Administrator-configured read-only MCP | Implemented |
| Cloud identity/device/catalog/version/image management | Product roadmap; not current repository code |
| Community and profiles | Product roadmap |
| Evidence-backed peer leaderboards | Product roadmap |
| Experience cohorts and signed knowledge return | Product roadmap |
| Router publishing and token supply | Later commercial integration roadmap |
