# Bittune

[简体中文](README.md) ｜ [English](README.en.md)

![Release](https://img.shields.io/github/v/release/bitcloud-ai/Bittune) [![CI](https://img.shields.io/github/actions/workflow/status/bitcloud-ai/Bittune/ci.yml?label=CI)](https://github.com/bitcloud-ai/Bittune/actions/workflows/ci.yml) ![License](https://img.shields.io/badge/license-MIT-blue.svg)

## Bittune 是什么

Bittune 是运行在你自己 GPU 机器上的**本地推理服务 Harness**：Agent 用通用工具（read/bash/edit/write）自由调查这台机器，用 10 个受管工具完成环境探测、部署计划、受管服务、规范化压测、结果比较和可追溯报告。每一步都留下可复核的执行证据。

```text
你说："在这台机器上部署 Qwen 到 vLLM，压测看看吞吐"
Bittune：inspect_environment → plan_deployment(校验→确认→冻结) → deploy_service
        → benchmark_service（EvalScope 实测） → compare_results → write_report
```

所有性能数字都来自 Core 的**真实实测**并绑定硬件快照与 workload hash；失败、取消与无增益同样留痕、如实成报告。

## 产品版图

- **Bittune Local**（当前开源）：上面的全部能力，本地完成、离线可用。
- **BitTune Cloud**（规划中）：可选连接的云端平台——认证的模型/引擎/工具组合目录、多设备管理、社区与可复核排行榜、调优经验回传。详见[路线图](ROADMAP.md)。

核心原则：**云端提供事实，客户端真实执行。** 部署与调优始终发生在你的设备上，经你确认、由可审计的受管工具执行；原始 Prompt、模型输出、密钥和数据集始终留在你的设备上。

[快速开始](guide/getting-started.md) · [运行指南](guide/operations.md) · [用户文档](guide/README.md) · [路线图](ROADMAP.md)

## 功能

- 4 个通用工具（read/bash/edit/write）+ 10 个受管工具；Agent 决定调查什么、试什么方案，Harness 负责执行、校验与留痕。
- `inspect_environment` 一次性生成不可变 HardwareSnapshot（GPU、驱动、Docker、拓扑）。
- `plan_deployment`：draft → 确定性校验 → 用户确认 → freeze 为不可变部署快照；校验精确 revision、本地镜像 digest、模型权重、GPU 规模与环境信息。
- 已有平铺 Transformers 模型目录可直接只读接入，由 Core 生成内容身份，无需复制权重到缓存结构。
- `deploy_service`：仅从 frozen plan 创建受管容器（`--pull=never`、离线环境变量、归属 label + 本地记录双证明）；Bash 启动的容器绝不会被当作受管服务停止或恢复。
- `benchmark_service`：对 ready 受管服务运行固定 profile 的 EvalScope `perf`，归一化 TTFT/TPOT/ITL/时延/RPS/TPS/成功率，原始 JSON、日志和 EvalScope 逐请求指标均归档为 Artifact，校验请求行数、成功/失败计数和实际 token 形状。固定合成负载需要端点支持 `/v1/completions` token-ID 请求。
- `benchmark_suite`：按版本化档案执行有预算的多档测量，区分测量完整性、逐请求 goodput 和聚合 SLO；缓存与实际输入身份不足时不签公平比较。字段、单位及旧结果兼容规则见[测量契约](guide/benchmark-contract.md)。
- `export_deliverable`：精确选择已有套件或单点，导出同源 XLSX 与含实际 Artifact 字节和哈希清单的证据 ZIP，不重新测量。
- `compare_results`：先校验模型/环境/workload hash 可比性，再给出确定性 delta 结论；需要留档时写为 Experiment。
- `write_report`：报告每个实测数字都回溯到 BenchmarkResult 与原始 Artifact；估算只能出现在明确标注的叙述中。
- 可选[指定资源任务模式](guide/task-scope-and-reporting.md)在执行前拒绝全局枚举；报告可按套件紧凑选择或继承已有报告，由 Core 核对引用覆盖，避免手抄大数组。
- 所有 Run、Artifact、事实与报告保存在 `~/.bittune/core`（SQLite + 文件），由本地 Python Core 唯一写入，Agent 会话永远无法直写。

## 快速开始

从 [GitHub Releases](https://github.com/bitcloud-ai/Bittune/releases) 下载 `bittune-<version>-linux-x86_64.tar.gz`，在主流 glibc Linux x86_64 主机安装：

```bash
tar -xzf bittune-<version>-linux-x86_64.tar.gz
cd bittune-<version>-linux-x86_64
sudo ./install.sh
```

安装器会自动识别在线或离线包、安装 Node.js、Bittune 与本地 Python Core，并创建 `/usr/local/bin/bittune`。离线包使用同一个 `sudo ./install.sh` 命令且不访问网络（Python Core 以预构建 wheel 离线安装）；在线安装会另外准备可选的固定版本 EvalScope 测量工具。Bittune 以 root 安装并在 root 下使用：安装后在 root 会话中执行 `bittune`；如需改用普通用户运行，请将该用户加入 `docker` 组。

配置 OpenAI-compatible Agent LLM，然后启动：

```bash
export BITTUNE_AGENT_LLM_API_KEY='your-api-key'
bittune configure --base-url https://endpoint.example.com/v1 --model-id your-tool-capable-model
bittune doctor
bittune
```

完整的前置条件、离线安装和配置说明见[快速开始](guide/getting-started.md)。安装器把 Python Core 装入 `/opt/bittune/py` 虚拟环境，Bittune 会话启动时以该环境运行 `python -m bittune_core`（`bittune doctor` 会自检）；GPU 驱动、Docker、NVIDIA Container Toolkit、Runtime 镜像与模型由管理员按需准备。

## 运行要求

- Linux 发行包支持主流 glibc x86_64 主机（Ubuntu、Debian、RHEL、Rocky、Fedora、openSUSE 等），安装器会自动准备固定版本 Node.js（当前为 v22.22.2）；实际环境是否满足要求以 `bittune doctor` 检查结果为准。
- 任意 OpenAI-compatible Agent LLM endpoint 是启动 Bittune 的必需条件。
- GPU、Docker、NVIDIA Container Toolkit、vLLM/SGLang、模型缓存和 EvalScope 都是按需能力；只有目标涉及对应操作时才需要准备。
- 受管部署不隐式下载任何东西：模型缓存与 Runtime 镜像由 Agent 用 Bash（受 Runtime Policy 约束）准备，Core 只校验精确 revision 与镜像 digest 是否已在本机。可配置 `BITTUNE_RUNTIME_POLICY_FILE` 指向镜像仓库白名单 JSON 以限制可部署的镜像范围。
- 通用工具执行受 Runtime Policy 约束：低影响只读调查放行，宿主动作/网络写入需要一次性确认，BitTune 自有目录（`~/.bittune`）不可读写。

## 从源码运行

源码开发需要 Python >= 3.10、OpenSSL CLI 与 Node.js >= 22.19.0（发行包自带固定版本 Node.js，与系统安装的版本无关）：

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

构建发行物：

```bash
npm run package:agent
npm run test:gpu-acceptance
```

## 文档

- [快速开始](guide/getting-started.md)：安装、首次配置与会话恢复。
- [运行指南](guide/operations.md)：运行目录、前置条件、证据存储与 Core 运维。
- [用户文档首页](guide/README.md)：文档导航与支持范围。
- [路线图](ROADMAP.md)：产品版图与 P1–P4 演进方向。

## 参与

- [贡献指南](CONTRIBUTING.md)：开发环境、提交规范与设计讨论。
- [支持与求助](SUPPORT.md)：使用问题、Bug 反馈与功能建议。
- [安全政策](SECURITY.md)：漏洞私密披露。
- 问题与想法请使用 [Issues](https://github.com/bitcloud-ai/Bittune/issues) 与 [Discussions](https://github.com/bitcloud-ai/Bittune/discussions)。

## 许可证

Bittune 自有代码采用 [MIT License](LICENSE)。第三方组件的版权与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
