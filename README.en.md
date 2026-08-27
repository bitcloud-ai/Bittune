# Bittune

[简体中文](README.md) ｜ [English](README.en.md)

An engineering agent for GPU inference deployment, benchmarking, and tuning.

[Quick Start](guide/getting-started.md) · [Operations Guide](guide/operations.md) · [Documentation Index](guide/README.md) · [Roadmap](ROADMAP.en.md)

## What it does

Bittune organizes environment inspection, model discovery, service deployment, availability probing, performance testing, and evidence recording into auditable engineering tools. The Agent chooses the next step based on your goal, current observations, and existing run records — it never runs a fixed pipeline.

- Reads GPU, Linux, Docker, and NVIDIA runtime state; discovers local model caches and existing services.
- Creates and manages vLLM or SGLang services with restricted configurations, performing start, readiness check, endpoint probing, log reading, and stop as independently auditable operations.
- Runs standardized benchmarks against managed services via EvalScope `perf`, persisting raw output as Run Records and Artifacts.
- Derives a `MeasuredOperatingPoint` from measurements taken against the same deployment, environment, workload, and configuration — a single success is never misreported as maximum capacity.
- Records tuning and capacity-exploration experiments with repeatable baselines, candidate comparison, and traceable conclusions.
- Does not take over external runtimes, models, services, or endpoints by default; all writes go through restricted domain tools.
- Exposes managed operations through a static Domain Tool Registry; the Agent selects tools per conversational goal rather than switching session phases.
- Optionally connects to administrator-configured read-only MCP servers. MCP provides reference knowledge only; actual environment facts and execution evidence always come from local tools.

## Quick start

Download `bittune-installer-<version>.tar.gz` from [GitHub Releases](https://github.com/bitcloud-ai/Bittune/releases) and install on an Ubuntu x86_64 host:

```bash
tar -xzf bittune-installer-<version>.tar.gz
cd bittune-installer-<version>
sudo ./bootstrap.sh --package ./bittune-runtime-<version>.tgz <linux-user> --yes
```

You can run a read-only preflight first by replacing `--yes` with `--check-only`; it reports the current environment and prerequisites without changing anything. Installation proceeds in stages that print preflight, plan, execution, and post-install checks; every failure reports its cause, a suggested command, and log location (`/opt/bittune/install.log`). Reruns are idempotent and skip components already satisfied. For air-gapped hosts, use an offline bundle directory and install with `--offline <bundle-dir>`.

Configure an OpenAI-compatible Agent LLM endpoint, then launch:

```bash
export BITTUNE_AGENT_LLM_API_KEY='your-api-key'
bittune configure --base-url https://endpoint.example.com/v1 --model-id your-tool-capable-model
bittune doctor
bittune
```

For full prerequisites, offline installation, and configuration details see [Quick Start](guide/getting-started.md). The online installer bootstraps pinned EvalScope and Hugging Face CLI tooling into `/opt/bittune/py` and adds them to PATH; GPU drivers, Docker, NVIDIA Container Toolkit, runtime images, and models are always prepared by the administrator — run `bittune doctor` to inspect each item.

## Requirements

- Linux packages currently support apt-based x86_64 hosts and bundle a pinned Node.js runtime.
- Any OpenAI-compatible Agent LLM endpoint is required to start Bittune.
- GPUs, Docker, NVIDIA Container Toolkit, vLLM/SGLang, model caches, and EvalScope are on-demand capabilities; prepare them only when your goal involves the corresponding operations.
- The installer never installs or modifies GPU drivers, Docker/NVIDIA toolkit, container images, or models. For an explicit deployment target, the Agent may pull runtime images and Hugging Face model snapshots through restricted Domain Tools.
- The Agent discovers existing vLLM/SGLang images automatically via `discover_runtime_images`. You can optionally point `BITTUNE_RUNTIME_POLICY_FILE` at a registry allowlist JSON to constrain permitted image sources.

## Running from source

Development requires Node.js >= 22.19.0:

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
- [Roadmap](ROADMAP.en.md): public product direction and non-goals.

## License

Bittune's own code is released under the [MIT License](LICENSE). Copyrights and licenses of third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
