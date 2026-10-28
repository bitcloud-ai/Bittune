# Bittune

[简体中文](README.md) ｜ [English](README.en.md)

![Release](https://img.shields.io/github/v/release/bitcloud-ai/Bittune) [![CI](https://img.shields.io/github/actions/workflow/status/bitcloud-ai/Bittune/ci.yml?label=CI)](https://github.com/bitcloud-ai/Bittune/actions/workflows/ci.yml) ![License](https://img.shields.io/badge/license-MIT-blue.svg)

## What Bittune is

Bittune is a **local inference-serving Harness** that runs on your own GPU machine. The Agent investigates the host freely with generic tools (read/bash/edit/write) and uses 10 managed tools for environment snapshots, deployment plans, managed services, normalized benchmarks, comparisons, and traceable reports. Every step leaves auditable execution evidence.

```text
You say: "Deploy Qwen with vLLM on this machine and benchmark the throughput"
Bittune: inspect_environment → plan_deployment (validate → confirm → freeze)
        → deploy_service → benchmark_service (EvalScope) → compare_results → write_report
```

Every measured number comes from a **real Core-managed benchmark**, bound to a hardware snapshot and a workload hash; failures, cancellations, and no-gain outcomes are recorded and reported just as honestly.

## Product landscape

- **Bittune Local** (open source today): everything above, running locally and fully usable offline.
- **BitTune Cloud** (planned): an optional cloud platform — a certified catalog of model/engine/tool combinations, multi-device management, a community with verifiable leaderboards, and tuning-experience feedback. See the [Roadmap](ROADMAP.en.md).

Core principle: **the cloud provides facts, the client executes for real.** Every deployment and tuning action happens on your device, confirmed by you, through auditable managed tools; raw prompts, model outputs, secrets, and datasets stay on your device.

[Quick Start](guide/getting-started.md) · [Operations Guide](guide/operations.md) · [Documentation Index](guide/README.md) · [Roadmap](ROADMAP.en.md)

## What it does

- 4 generic tools (read/bash/edit/write) plus 10 managed tools; the Agent decides what to investigate and which path to try, the Harness executes, validates, and keeps receipts.
- `inspect_environment` produces an immutable HardwareSnapshot (GPUs, driver, Docker, topology) in one shot.
- `plan_deployment`: draft → deterministic validation → user confirmation → freeze into an immutable snapshot; validation checks the exact model revision, local image digest, model weights, GPU count, and the host image policy.
- Existing flat Transformers model directories can be mounted read-only; Core derives their content identity without copying weights into a cache layout.
- `deploy_service`: managed containers come only from frozen plans (`--pull=never`, offline env vars, ownership labels + local record double-proof); containers started by Bash are never treated as managed and are never stopped or recovered.
- `benchmark_service`: EvalScope `perf` against ready managed services with a fixed argv profile; TTFT/TPOT/ITL/latency/RPS/TPS/success rate are normalized and raw JSON, logs, and EvalScope request metrics are kept as Artifacts, with request, success/failure, and actual token-shape checks. Fixed synthetic workloads require `/v1/completions` token-ID support.
- `benchmark_suite`: budgeted measurements from versioned profiles, separating measurement completeness, per-request goodput, and aggregate SLO verdicts. Fair-comparison claims require cache control and actual input identity. See the [measurement contract](guide/benchmark-contract.md) for fields, units, and history compatibility.
- `export_deliverable`: select an existing suite or specific benchmarks to export consistent XLSX and evidence ZIP files, including actual Artifact bytes and hash manifests, without measuring again.
- `compare_results`: comparability (model, environment, workload hash) is verified before any deterministic delta conclusion; record it as an Experiment when needed.
- `write_report`: every measured number traces back to its BenchmarkResult and raw Artifact; estimates may only appear in explicitly labelled narrative.
- Optional [specified-resource tasks](guide/task-scope-and-reporting.md) reject broad enumeration before execution. Compact suite selections and report inheritance let Core verify reference coverage without copying large arrays through the Agent.
- All Runs, Artifacts, facts, and reports live under `~/.bittune/core` (SQLite + files), written exclusively by the local Python Core — the Agent session can never write them directly.

## Quick start

Download `bittune-<version>-linux-x86_64.tar.gz` from [GitHub Releases](https://github.com/bitcloud-ai/Bittune/releases) and install on a mainstream glibc Linux x86_64 host:

```bash
tar -xzf bittune-<version>-linux-x86_64.tar.gz
cd bittune-<version>-linux-x86_64
sudo ./install.sh
```

The installer detects online or offline package contents automatically, installs Node.js, Bittune, and the local Python Core, and creates `/usr/local/bin/bittune`. The offline package uses the same `sudo ./install.sh` command and never contacts the network — the Python Core installs offline from a prebuilt wheel. Online installs additionally prepare the optional fixed-version EvalScope measurement tools. Bittune installs and runs as root: run `bittune` in a root session after installation; to run as a regular user instead, add that user to the `docker` group.

Configure an OpenAI-compatible Agent LLM endpoint, then launch:

```bash
export BITTUNE_AGENT_LLM_API_KEY='your-api-key'
bittune configure --base-url https://endpoint.example.com/v1 --model-id your-tool-capable-model
bittune doctor
bittune
```

For full prerequisites, offline installation, and configuration details see [Quick Start](guide/getting-started.md). The installer places the Python Core into the `/opt/bittune/py` virtualenv and each session runs `python -m bittune_core` from it (`bittune doctor` self-checks this); GPU drivers, Docker, NVIDIA Container Toolkit, runtime images, and models are prepared by the administrator as needed.

## Requirements

- Linux packages support mainstream glibc x86_64 hosts (Ubuntu, Debian, RHEL, Rocky, Fedora, openSUSE, and similar) and prepare a pinned Node.js runtime automatically (v22.22.2 in current packages); whether your environment meets the requirements is what `bittune doctor` reports.
- Any OpenAI-compatible Agent LLM endpoint is required to start Bittune.
- GPUs, Docker, NVIDIA Container Toolkit, vLLM/SGLang, model caches, and EvalScope are on-demand capabilities; prepare them only when your goal involves the corresponding operations.
- For an explicit deployment target, the Agent may pull runtime images and Hugging Face model snapshots through restricted Domain Tools, and discovers existing vLLM/SGLang images automatically via `discover_runtime_images`. You can optionally point `BITTUNE_RUNTIME_POLICY_FILE` at a registry allowlist JSON to constrain permitted image sources.

## Running from source

Source development requires Python >= 3.10, the OpenSSL CLI, and Node.js >= 22.19.0 (release packages ship their own pinned Node.js, independent of your system installation):

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -e ./packages/bittune-core
export BITTUNE_TEST_PYTHON="$PWD/.venv/bin/python"
export BITTUNE_CORE_PYTHON="$PWD/.venv/bin/python"
npm run check
npm test
npm run bittune
```

Building release artifacts:

```bash
npm run package:agent
npm run test:gpu-acceptance
```

## Documentation

- [Quick Start](guide/getting-started.md): installation, first configuration, and session resume.
- [Operations Guide](guide/operations.md): working directories, prerequisites, evidence storage, and Core operations.
- [Documentation Index](guide/README.md): navigation and support scope.
- [Roadmap](ROADMAP.en.md): product landscape and P1–P4 direction.
- User guides are currently published in Simplified Chinese; English versions are planned.

## Community

- [Contributing](CONTRIBUTING.md): development setup, commit conventions, and design discussions.
- [Support](SUPPORT.md): usage questions, bug reports, and feature requests.
- [Security](SECURITY.md): private vulnerability disclosure.
- Ideas and issues: [Issues](https://github.com/bitcloud-ai/Bittune/issues) and [Discussions](https://github.com/bitcloud-ai/Bittune/discussions).

## License

Bittune's own code is released under the [MIT License](LICENSE). Copyrights and licenses of third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
