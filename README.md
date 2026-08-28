# Bittune

[简体中文](README.md) ｜ [English](README.en.md)

![Release](https://img.shields.io/github/v/release/bitcloud-ai/Bittune) [![CI](https://img.shields.io/github/actions/workflow/status/bitcloud-ai/Bittune/ci.yml?label=CI)](https://github.com/bitcloud-ai/Bittune/actions/workflows/ci.yml) ![License](https://img.shields.io/badge/license-MIT-blue.svg)

## Bittune 是什么

Bittune 是运行在你自己 GPU 机器上的**推理工程智能体**：你用自然语言说清目标，它替你完成环境检查、模型选择、vLLM/SGLang 服务部署、性能压测和参数调优，并把每一步的结论记录成可复核的执行证据。

```text
你说："在这台 5090 上部署 Qwen，vLLM，把吞吐调到最高"
Bittune：检查 GPU/Docker 环境 → 发现本机模型 → 受管部署 vLLM → EvalScope 压测
        → 候选参数逐个实测 → 给出最优配置和前后对比报告
```

所有性能结论都来自**真实部署与真实压测**，绑定环境指纹与配置 Hash；失败同样留痕，波动与容量边界如实呈现。

## 产品版图

- **Bittune Local**（当前开源）：上面的全部能力，本地完成、离线可用。
- **BitTune Cloud**（规划中）：可选连接的云端平台——认证的模型/引擎/工具组合目录、多设备管理、社区与可复核排行榜、调优经验回传。详见[路线图](ROADMAP.md)。

核心原则：**云端提供事实，客户端真实执行。** 部署与调优始终发生在你的设备上，经你确认、由可审计的受管工具执行；原始 Prompt、模型输出、密钥和数据集始终留在你的设备上。

[快速开始](guide/getting-started.md) · [运行指南](guide/operations.md) · [用户文档](guide/README.md) · [路线图](ROADMAP.md)

## 功能

- 读取 GPU、Linux、Docker 和 NVIDIA Runtime 状态，发现本机模型缓存与已有服务。
- 用受限配置创建并管理 vLLM 或 SGLang 服务，独立执行启动、就绪检查、端点探测、日志读取和停止。
- 调用 EvalScope `perf` 测量受管服务，并将原始输出保存为 Run Record 和 Artifact。
- 从同一部署、环境、负载和配置的多次实测中推导 `MeasuredOperatingPoint`，给出吞吐与时延的运行区间和容量边界。
- 记录调优和容量探索实验，支持重复基准、候选比较和可追溯结论。
- 通过静态 Domain Tool Registry 提供受管操作；Agent 根据当前对话目标选择工具。
- 可选接入管理员配置的只读 MCP 服务；实际环境事实和执行证据以本机工具为准。

## 快速开始

从 [GitHub Releases](https://github.com/bitcloud-ai/Bittune/releases) 下载 `bittune-<version>-linux-x86_64.tar.gz`，在主流 glibc Linux x86_64 主机安装：

```bash
tar -xzf bittune-<version>-linux-x86_64.tar.gz
cd bittune-<version>-linux-x86_64
sudo ./install.sh
```

安装器会自动识别在线或离线包、安装 Node.js 与 Bittune，并创建 `/usr/local/bin/bittune`。离线包使用同一个 `sudo ./install.sh` 命令且不访问网络；在线安装会另外准备可选的固定版本 Python 测量工具。

配置 OpenAI-compatible Agent LLM，然后启动：

```bash
export BITTUNE_AGENT_LLM_API_KEY='your-api-key'
bittune configure --base-url https://endpoint.example.com/v1 --model-id your-tool-capable-model
bittune doctor
bittune
```

完整的前置条件、离线安装和配置说明见[快速开始](guide/getting-started.md)。在线安装器会把固定版本的 EvalScope 与 Hugging Face CLI 安装到 `/opt/bittune/py`，Bittune 启动器在运行时自动使用该环境；GPU 驱动、Docker、NVIDIA Container Toolkit、Runtime 镜像与模型由管理员按需准备，运行 `bittune doctor` 可查看各项状态。

## 运行要求

- Linux 发行包支持主流 glibc x86_64 主机（Ubuntu、Debian、RHEL、Rocky、Fedora、openSUSE 等），安装器会自动准备固定版本 Node.js（当前为 v22.22.2）；实际环境是否满足要求以 `bittune doctor` 检查结果为准。
- 任意 OpenAI-compatible Agent LLM endpoint 是启动 Bittune 的必需条件。
- GPU、Docker、NVIDIA Container Toolkit、vLLM/SGLang、模型缓存和 EvalScope 都是按需能力；只有目标涉及对应操作时才需要准备。
- 对用户明确的部署目标，Agent 可通过受限 Domain Tool 拉取 Runtime 镜像和 Hugging Face 模型 Snapshot，并通过 `discover_runtime_images` 自动发现本机已有的 vLLM/SGLang 镜像。可选配置 `BITTUNE_RUNTIME_POLICY_FILE` 指向镜像仓库白名单 JSON 以限制允许的镜像范围。

## 从源码运行

源码开发需要 Node.js >= 22.19.0（发行包自带固定版本 Node.js，与系统安装的版本无关）：

```bash
npm install
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
- [运行指南](guide/operations.md)：运行目录、Provider 前置条件、证据存储和 MCP 运维。
- [用户文档首页](guide/README.md)：文档导航与支持范围。
- [路线图](ROADMAP.md)：产品版图与 P1–P4 演进方向。

## 参与

- [贡献指南](CONTRIBUTING.md)：开发环境、提交规范与设计讨论。
- [支持与求助](SUPPORT.md)：使用问题、Bug 反馈与功能建议。
- [安全政策](SECURITY.md)：漏洞私密披露。
- 问题与想法请使用 [Issues](https://github.com/bitcloud-ai/Bittune/issues) 与 [Discussions](https://github.com/bitcloud-ai/Bittune/discussions)。

## 许可证

Bittune 自有代码采用 [MIT License](LICENSE)。第三方组件的版权与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
