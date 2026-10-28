---
name: prepare-model
description: 准备本机模型权重
---

# 准备本机模型权重

本机还没有用户指定的模型权重、下一步又要部署时使用本 Skill。不要现场编下载命令，也不要发明下载地址。

## 怎么做

只跑本 Skill 目录下的脚本：

```text
scripts/prepare-model.sh <model_id> [revision]
```

- `<model_id>` 是 Hugging Face 仓库 id，例如 `Qwen/Qwen2.5-7B-Instruct`。
- `[revision]` 可选，钉死提交或 tag。省略则用仓库默认修订。
- 下载源来自本机已有的 Hugging Face CLI（`hf download`）。不要手写下载地址，不要换别的下载器。
- 工作目录由脚本选在用户模型缓存；不得写入 BitTune 保护根（`~/.bittune` 及其 Core 目录）。
- 网络属于 Runtime Policy 的确认项。用户拒绝网络后停止，不要换命令绕过。

## 成功

报告本地路径已经存在。不要调用部署、不要启动服务。把路径交给核心 Agent，由它决定下一步。

## 失败

说明缺什么后停止：没有 `hf` CLI、磁盘不够、网络确认被拒、模型 id 不合法。不要改参数重试绕过，也不要自己拼下载地址。
