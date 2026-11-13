---
name: prepare-model
description: 准备本机模型权重
---

# 准备本机模型权重

本机还没有用户指定的模型权重、下一步又要部署时使用本 Skill。不要现场编下载命令，也不要发明下载地址。

## 怎么做

只跑本 Skill 目录下的脚本：

```text
scripts/prepare-model.sh <model_id> [revision] [huggingface|modelscope]
```

- `<model_id>` 是所选来源的仓库 id，例如 `Qwen/Qwen2.5-7B-Instruct`。
- `[revision]` 可选，钉死提交或 tag。省略则用仓库默认修订。
- 来源默认采用节点配置 `BITTUNE_MODEL_SOURCE`，未配置时用 Hugging Face。显式选择 ModelScope 时，由其官方 SDK 下载；Hugging Face 沿用 `hf download`。
- 沿用用户选定的仓库和来源，不自动切换，不手写下载地址。
- 工作目录由脚本选在用户模型缓存；不得写入 BitTune 保护根（`~/.bittune` 及其 Core 目录）。
- 网络属于 Runtime Policy 的确认项。用户拒绝网络后停止，不要换命令绕过。

## 成功

报告本地路径已经存在。不要调用部署、不要启动服务。把路径交给核心 Agent，由它决定下一步。

## 失败

说明缺什么后停止：所选来源的 CLI/SDK 缺失、磁盘不够、网络确认被拒或模型 id 不合法。不要改参数重试绕过，也不要自己拼下载地址。
