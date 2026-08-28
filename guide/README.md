# Bittune 用户文档

Bittune 是运行在你自己 GPU 机器上的推理工程智能体：用自然语言描述目标，它完成环境检查、模型选择、vLLM/SGLang 部署、性能压测和参数调优，并把结论记录成可复核的执行证据。

本目录只描述当前已可用的产品能力。产品版图与演进方向（BitTune Cloud、社区、排行榜）见[路线图](../ROADMAP.md)。

- [快速开始](getting-started.md)：安装、配置 Agent LLM、启动和恢复会话。
- [运行指南](operations.md)：运行目录、推理 Provider 前置条件、证据存储和 MCP 运维。

命令帮助始终以本地安装版本为准：

```bash
bittune --help
bittune doctor
```

## 术语表

| 术语 | 含义 |
|---|---|
| Agent | 对话式智能体，负责理解目标并选择工具。 |
| Runtime（推理引擎） | vLLM、SGLang 等实际运行模型的推理服务。 |
| Provider | 推理 Runtime 的具体适配实现。 |
| Domain Tool | Bittune 提供的受限领域工具，真实操作的执行入口。 |
| Run Record / Artifact | 一次受管操作的结构化记录与其原始输出文件。 |
| Preset | 已发布的部署配置资产（模型、镜像、参数组合）。 |
| measured / estimated | 证据等级：来自真实测量 / 来自推算，工具输出中显式区分。 |
