# Bittune

> 面向 GPU 推理部署、压测和调优的工程智能体。

Bittune 将环境检查、模型发现、服务部署、可用性探测、性能测试和证据记录组织为可审计的工程工具。Agent 根据目标、当前观测和已有运行记录选择下一步，而不是执行固定流水线。

[快速开始](guide/getting-started.md) · [运行指南](guide/operations.md) · [用户文档](guide/README.md) · [路线图](ROADMAP.md)

## 功能

- 读取 GPU、Linux、Docker 和 NVIDIA Runtime 状态，发现本机模型缓存与已有服务。
- 用受限配置创建并管理 vLLM 或 SGLang 服务，独立执行启动、就绪检查、端点探测、日志读取和停止。
- 调用 EvalScope `perf` 测量受管服务，并将原始输出保存为 Run Record 和 Artifact。
- 从同一部署、环境、负载和配置的实测数据推导 `MeasuredOperatingPoint`，不将单次成功误报为最大容量。
- 记录调优和容量探索实验，支持重复基准、候选比较和可追溯结论。
- 默认不接管外部 Runtime、模型、服务或端点；写操作始终通过受限领域工具执行。
- 通过静态 Domain Tool Registry 提供受管操作；Agent 按当前对话目标选择工具，不切换会话阶段。
- 可选接入管理员配置的只读 MCP 服务。MCP 只提供参考知识，不是部署或压测前置；实际环境事实和执行证据以本机工具为准。

## 快速开始

从 [GitHub Releases](https://github.com/bitcloud-ai/BitTune/releases) 下载 `bittune-installer-<version>.tar.gz`，在 Ubuntu x86_64 主机安装：

```bash
tar -xzf bittune-installer-<version>.tar.gz
cd bittune-installer-<version>
sudo ./bootstrap.sh --package ./bittune-runtime-<version>.tgz <linux-user> --yes
```

安装前可先执行只读体检：把上面命令的 `--yes` 换成 `--check-only`，输出环境与前置项现状且不做任何修改。安装过程分阶段打印体检、计划、执行与自检；任何一步失败都会给出原因、建议命令与日志位置（`/opt/bittune/install.log`），重跑幂等、自动跳过已完成组件。离线主机使用离线 bundle 目录并以 `--offline <bundle目录>` 安装。

配置 OpenAI-compatible Agent LLM，然后启动：

```bash
export BITTUNE_AGENT_LLM_API_KEY='your-api-key'
bittune configure --base-url https://endpoint.example.com/v1 --model-id your-tool-capable-model
bittune doctor
bittune
```

完整的前置条件、离线安装和配置说明见[快速开始](guide/getting-started.md)。在线安装器会把钉版的 EvalScope 与 Hugging Face CLI 自举到 `/opt/bittune/py` 并挂入 PATH；GPU 驱动、Docker、NVIDIA Container Toolkit、Runtime 镜像与模型始终由管理员准备，运行 `bittune doctor` 可查看各项状态。

## 运行要求

- Linux 发行包当前支持 apt-based x86_64 主机，并携带固定 Node.js 运行时。
- 任意 OpenAI-compatible Agent LLM endpoint 是启动 Bittune 的必需条件。
- GPU、Docker、NVIDIA Container Toolkit、vLLM/SGLang、模型缓存和 EvalScope 都是按需能力；只有目标涉及对应操作时才需要准备。
- 安装器不会安装或修改 GPU 驱动、Docker/NVIDIA Toolkit、容器镜像或模型。对用户明确的部署目标，Agent 可通过受限 Domain Tool 拉取 Runtime 镜像和 Hugging Face 模型 Snapshot。
- Agent 通过 `discover_runtime_images` 自动发现本机已有的 vLLM/SGLang 镜像。可选配置 `BITTUNE_RUNTIME_POLICY_FILE` 指向镜像仓库白名单 JSON 以限制允许的镜像范围。

## 从源码运行

开发环境需要 Node.js >= 22.19.0：

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
- [路线图](ROADMAP.md)：公开的产品演进方向与非目标。

## 许可证

Bittune 自有代码采用 [MIT License](LICENSE)。第三方组件的版权与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
