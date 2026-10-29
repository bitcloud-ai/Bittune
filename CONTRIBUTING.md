# 贡献指南

感谢关注 Bittune！本文说明如何搭建开发环境、提交变更和参与设计讨论。

## 开发环境

- Node.js >= 22.19.0；Python >= 3.10；OpenSSL CLI（本机 HTTPS 测试证书）

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -e ./packages/bittune-core
export BITTUNE_TEST_PYTHON="$PWD/.venv/bin/python"
export BITTUNE_CORE_PYTHON="$PWD/.venv/bin/python"
npm run check     # TypeScript 类型检查
npm test          # 全部测试
npm run bittune   # 本地启动
```

构建发行物：

```bash
npm run package:agent
npm run test:gpu-acceptance   # 需要真实 Linux GPU 主机
```

## 提交规范

- Commit message 使用 Conventional Commits（现有历史即范本）：`feat(scope): ...`、`fix(scope): ...`、`docs: ...`、`chore: ...`。
- 一个 PR 聚焦一件事；行为变更必须伴随对应测试，且同步更新受影响的"当前实现"契约文档。

## 文档纪律

- 行为变更需要附带对应的测试，并在 PR 说明里写清影响范围；
- 仓库正文统一使用 **Bittune** 作为产品名。

## 设计讨论

涉及长期架构边界的改动（领域契约、Tool 面、Provider 边界）请先在 Discussions 提交 RFC 形式的提案。开发前请先阅读 [ROADMAP](ROADMAP.md)，确认方向一致——优先推进路线图上已排期的阶段，避免与之冲突的重复实现。

## 发布验收（维护者）

发布候选需要在空闲的真实 Linux NVIDIA GPU 主机验证当前 Harness。不要使用旧版
`BITTUNE_STATE_DIR` 或旧工具 Run ID；证据来自 `BITTUNE_CORE_HOME`。

先准备隔离的 Core 目录、固定 revision 的完整模型缓存，以及本地已存在的镜像
repository/digest。配置 JSON 包含 `core_home`、`output`、`model_ref`、`workload`
和 `runtimes`（每项含 `runtime_spec`、`serving_spec`）；字段沿用受管工具契约。
`workload.schema_version` 为 2。发布验收的 runtimes 必须同时包含 vllm 和 sglang。
建议先用小模型、concurrency=1、8 个 64 输入/32 输出 token 的请求。

```bash
export BITTUNE_CORE_PYTHON=/path/to/core-venv/bin/python
export BITTUNE_MODEL_CACHE_ROOTS=/path/to/model-cache
node --import tsx scripts/run-managed-gpu-smoke.mjs /path/to/config.json --execute
npm run test:gpu-acceptance -- /path/to/acceptance.json
```

`--execute` 表示操作者已授权本次冻结、启动和停止；该驱动直接调用现有受管工具，
不替代产品交互确认测试。GPU 上有计算进程时等待，不终止其它任务。每个引擎
执行 inspect → create/validate/freeze → start/ready → inspect_service → 两次相同
EvalScope workload → compare → report → stop，失败启动留下的本轮服务也通过
Core 停止。保存 JSON 清单、完整 Core Store/Artifact 与控制台日志；验证器重新
读取事实、Run 和 Artifact 并核验 hash。短请求只验证集成，不证明容量或调优收益。

当前 Linux GPU 验收与真实 Agent API 对话是两项验证；后者还需要支持工具调用的
Agent endpoint，不能用确定性驱动通过来冒充自然语言任务通过。

## 公开推送前检查

每次向公开仓库推送前，必须先核对待上传文件、提交历史和目标分支：

- 检查提交差异和文件清单；保留产品源码、正式测试、合成夹具和通用用户文档。
- 不上传私钥、令牌、认证配置、个人信息、真实服务器地址/路径、客户数据、内部交接、原始运行报告或日志；固定测试凭据必须明确为不可用的示例。
- 检查新增提交的作者邮箱等元数据，使用适合公开的身份；`.gitignore`不能清除已经进入历史的内容。
- 只推送已经复查的目标分支，不使用`--all`或`--mirror`批量上传本地备份和旧开发历史。
- `docs/`整个目录及内部资料仅保存在本地，不上传。公开用户指南须先脱敏；发现敏感内容时先清理再推送。

## 安全问题

发现安全问题请勿提公开 Issue，按 [SECURITY.md](SECURITY.md) 披露。
