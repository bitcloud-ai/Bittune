# Bittune

[简体中文](README.md) ｜ [English](README.en.md)

![Release](https://img.shields.io/github/v/release/bitcloud-ai/Bittune) [![CI](https://img.shields.io/github/actions/workflow/status/bitcloud-ai/Bittune/ci.yml?label=CI)](https://github.com/bitcloud-ai/Bittune/actions/workflows/ci.yml) ![License](https://img.shields.io/badge/license-MIT-blue.svg)

## What Bittune is

Bittune is an **inference engineering agent** that runs on your own GPU machine: you state the goal in natural language, and it handles environment inspection, model selection, vLLM/SGLang service deployment, performance benchmarking, and parameter tuning — recording every conclusion as auditable execution evidence.

```text
You say: "Deploy Qwen on this RTX 5090 with vLLM and maximize throughput"
Bittune: inspects GPU/Docker environment → discovers local models → deploys vLLM (managed)
        → benchmarks via EvalScope → measures candidate configurations one by one
        → reports the best configuration with a before/after comparison
```

Every performance conclusion comes from **real deployments and real benchmarks**, bound to environment fingerprints and configuration hashes; failures are recorded too, and variance is reported honestly.

## Product landscape

- **Bittune Local** (open source today): everything above, running locally and fully usable offline.
- **BitTune Cloud** (planned): an optional cloud platform — a certified catalog of model/engine/tool combinations, multi-device management, a community with verifiable leaderboards, and tuning-experience feedback. See the [Roadmap](ROADMAP.en.md).

Core principle: **the cloud provides facts, the client executes for real.** Every deployment and tuning action happens on your device, confirmed by you, through auditable managed tools; raw prompts, model outputs, secrets, and datasets stay on your device.

[Quick Start](guide/getting-started.md) · [Operations Guide](guide/operations.md) · [Documentation Index](guide/README.md) · [Roadmap](ROADMAP.en.md)

## What it does

- Reads GPU, Linux, Docker, and NVIDIA runtime state; discovers local model caches and existing services.
- Creates and manages vLLM or SGLang services with restricted configurations, performing start, readiness check, endpoint probing, log reading, and stop as independently auditable operations.
- Runs standardized benchmarks against managed services via EvalScope `perf`, persisting raw output as Run Records and Artifacts.
- Derives a `MeasuredOperatingPoint` from repeated measurements against the same deployment, environment, workload, and configuration — reporting the operating range and capacity boundary.
- Records tuning and capacity-exploration experiments with repeatable baselines, candidate comparison, and traceable conclusions.
- Exposes managed operations through a static Domain Tool Registry; the Agent selects tools per conversational goal.
- Optionally connects to administrator-configured read-only MCP servers; actual environment facts and execution evidence always come from local tools.

## Quick start

Download `bittune-<version>-linux-x86_64.tar.gz` from [GitHub Releases](https://github.com/bitcloud-ai/Bittune/releases) and install on a mainstream glibc Linux x86_64 host:

```bash
tar -xzf bittune-<version>-linux-x86_64.tar.gz
cd bittune-<version>-linux-x86_64
sudo ./install.sh
```

The installer detects online or offline package contents automatically, installs the required Node.js and Bittune components, and creates `/usr/local/bin/bittune`. The offline package uses the same `sudo ./install.sh` command and never contacts the network. Online installs also prepare the optional fixed-version Python measurement tools. Bittune installs and runs as root: run `bittune` in a root session after installation; to run as a regular user instead, add that user to the `docker` group.

Configure an OpenAI-compatible Agent LLM endpoint, then launch:

```bash
export BITTUNE_AGENT_LLM_API_KEY='your-api-key'
bittune configure --base-url https://endpoint.example.com/v1 --model-id your-tool-capable-model
bittune doctor
bittune
```

For full prerequisites, offline installation, and configuration details see [Quick Start](guide/getting-started.md). The online installer installs fixed-version EvalScope and Hugging Face CLI tooling into `/opt/bittune/py`, and the Bittune launcher uses this environment automatically at runtime; GPU drivers, Docker, NVIDIA Container Toolkit, runtime images, and models are prepared by the administrator as needed — run `bittune doctor` to inspect each item.

## Requirements

- Linux packages support mainstream glibc x86_64 hosts (Ubuntu, Debian, RHEL, Rocky, Fedora, openSUSE, and similar) and prepare a pinned Node.js runtime automatically (v22.22.2 in current packages); whether your environment meets the requirements is what `bittune doctor` reports.
- Any OpenAI-compatible Agent LLM endpoint is required to start Bittune.
- GPUs, Docker, NVIDIA Container Toolkit, vLLM/SGLang, model caches, and EvalScope are on-demand capabilities; prepare them only when your goal involves the corresponding operations.
- For an explicit deployment target, the Agent may pull runtime images and Hugging Face model snapshots through restricted Domain Tools, and discovers existing vLLM/SGLang images automatically via `discover_runtime_images`. You can optionally point `BITTUNE_RUNTIME_POLICY_FILE` at a registry allowlist JSON to constrain permitted image sources.

## Running from source

Source development requires Node.js >= 22.19.0 (release packages ship their own pinned Node.js, independent of your system installation):

```bash
npm install
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
- [Operations Guide](guide/operations.md): working directory, provider prerequisites, evidence storage, and MCP operations.
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
