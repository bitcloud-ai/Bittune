# 运行指南

## 运行目录

默认运行目录为 `~/.bittune`，可以通过环境变量调整：

| 环境变量 | 用途 |
|---|---|
| `BITTUNE_HOME` | Bittune 根目录（Agent 配置、会话、Core 的默认父目录）。 |
| `BITTUNE_AGENT_DIR` | Agent 模型配置和会话目录。 |
| `BITTUNE_SESSION_DIR` | 会话文件目录。 |
| `BITTUNE_STATE_DIR` | 已废弃的旧状态目录；Harness 从不读取或修改它。 |
| `BITTUNE_CORE_HOME` | Python Core 本地 Store：SQLite、Artifact 与证据 staging（默认 `~/.bittune/core`）。 |
| `BITTUNE_LOG_DIR` | 运行日志目录。 |
| `BITTUNE_CORE_PYTHON` | 运行 `python -m bittune_core` 的解释器（默认取安装器准备的 `/opt/bittune/py`）。 |
| `BITTUNE_CORE_MODULE_PATHS` | 源码开发时的 Core 模块 PYTHONPATH（发行安装不需要）。 |
| `BITTUNE_MODEL_CACHE_ROOTS` | 额外模型缓存根目录，使用系统路径分隔符分隔。 |
| `BITTUNE_RUNTIME_POLICY_FILE` | Runtime 镜像仓库白名单 JSON（默认 `$BITTUNE_HOME/runtime-policy.json`）。 |

API Key 环境变量由 `bittune configure --api-key-env` 指定；默认名称为
`BITTUNE_AGENT_LLM_API_KEY`。不要把密钥写入项目文件或 Shell 历史。

旧版本的 `~/.bittune/state/bittune.db` 不会被读取、迁移或改写；Phase 1 的
Harness 只使用 `~/.bittune/core`。

## 前置条件

只有目标涉及对应操作时才需要准备：

```bash
docker info          # 受管部署需要
nvidia-smi           # GPU 受管部署需要
hf --help            # Bash 侧模型下载需要（Core 绝不隐式下载）
/opt/bittune/py/bin/evalscope --version   # benchmark_service 需要
```

Python Core 由安装器自动装入 `/opt/bittune/py` 虚拟环境，会话启动时以该环境运行
`python -m bittune_core`。手动准备测量工具时请使用独立虚拟环境：

```bash
python3 -m venv /opt/bittune/py
/opt/bittune/py/bin/pip install 'huggingface_hub[cli]==1.27.0' 'evalscope[perf]==1.10.0'
```

Bittune 对已有容器默认只读。`inspect_service(list)` 可以列出未跟踪容器：镜像或命令能对上 vLLM/SGLang，并且发布了端口。这份列表不写入服务事实。停止和恢复只作用于 Core 从 frozen plan 创建、且 label 与本地记录双重证明的受管容器。

## 通用工具与 Runtime Policy

`read`/`bash`/`edit`/`write` 是 Agent 的调查面。真正执行前，Runtime Policy 会做
命令/路径级判断：

- 低影响只读调查通常直接放行；
- 消耗资源或改变宿主的动作（`docker run`、`rm`、`apt install`、网络写入等）会
  弹出一致性确认，非交互会话下被拒绝而不是静默放行；
- `~/.bittune` 下的配置、状态与证据 Store 禁止读写。

Policy 只产出 allow/ask/deny 与原因，不解析 Shell 语法；它约束的是 Agent 的
通用工具，不承诺也无法替代宿主级权限隔离。

## 证据与事实

每次工具调用都会生成一条 Run；Bash 保留命令、退出码、截断后的完整输出，
文件工具记录路径与摘要（不复制文件内容）。以上证据与所有受管事实都写在
`~/.bittune/core`：SQLite（`bittune.db`）保存 Run、Artifact 索引与
Canonical Fact，原始材料在 `core/artifacts/`。Python Core 是唯一逻辑写者，
Agent 与 Runtime 都不持有数据库连接。

Canonical Fact 只包括：HardwareSnapshot、DeploymentPlan、ServiceInstance、
BenchmarkResult、Experiment、Report。每条事实带来源 Run、content hash 与
`provenance-v1` 标签（declared/detected/measured/derived/estimated），读取时
始终校验 hash。Bash 手工诊断（例如 curl 计时）是证据，不是受管实测。

## Core 运维

- Core 是会话级进程：`bittune` 会话开始时启动、结束时退出，不监听任何端口。
- 异常退出后再次启动会把它遗留的 running Run 标记为 interrupted。
- `bittune doctor` 会自检 `python -m bittune_core --version`，缺失时给出安装提示。
- `$BITTUNE_HOME/runtime-policy.json`（或 `BITTUNE_RUNTIME_POLICY_FILE`）以
  `allowedRuntimeRepositories` + 可选的 `runtimeImages`（digest 绑定）限制
  可部署的镜像范围；文件不存在表示允许全部本地镜像。

## 对话与工具行为

正常运行 `bittune` 即可开始或继续对话；`--session <id>` 恢复既有会话。Agent
依据你的当前目标自主选择工具：调查用通用工具，需要 BitTune 负责结果的路径走
inspect_environment → plan_deployment（校验、确认、冻结）→ deploy_service →
benchmark_service → compare_results → write_report，随时用 inspect_records 回查
Run、Artifact 与事实。用户确认发生在冻结计划与启停受管服务之前，不存在可被
伪造的 `approved` 字段。

## 确认偏好（Phase 3）

通用工具的执行点策略输出 allow / ask / deny。普通 ask（未知命令兜底、工作区
外文件写入）受确认偏好控制；显式 ask（危险 shell、网络与依赖写入、重定向到
块设备等）与 deny 永远不受影响：

- `/approval ask`：逐次确认（默认）；
- `/approval session`：本次会话跳过普通确认，只存在会话内存，新会话清除；
- `/approval always`：写入全局设置（`settings.json` 的 `harness.approvalMode`），
  项目 settings.json 无法覆盖；用 `/approval ask` 恢复。

`bittune doctor` 输出当前确认偏好；受管 freeze/start/stop/recover、依赖准备
网络写入、经验上传/发送/公开发布始终是独立显式确认。

## 已有本地模型目录

受管计划可直接引用平铺的 Transformers 模型目录，无需复制权重或改成 Hub 缓存结构：
`model_ref` 使用 `schema_version: 1`、业务 `model_id` 和绝对 `local_path`，创建时
省略 `revision`。Core 只读散列目录内非隐藏的普通文件，生成 `local-<sha256>`
内容 revision；指向目录外的文件链接被拒绝。目录须含 config.json 和权重文件。

冻结、启动、测量前会重新核对内容；权重或 tokenizer 变化后须新建计划。散列会
读取完整权重，属于测量前开销，不计入服务时延。Docker 仅只读挂载该模型目录，
不挂载整个父目录。旧 Hub 精确 revision 引用继续支持。受管工具的模型、镜像和
负载参数现提供完整字段 schema；不得用占位摘要创建草稿来探测接口。

本地路径只属于本机事实；经验上传仍经过现有隐私门禁，不因此放开路径共享。


报告的 `references` 使用工具 schema 列出的复数 `*_ids` 字段；未知引用键会被拒绝，
不再静默忽略。性能断言由 `metric_claims` 引用实测字段渲染。冻结 workload 中的
声明值与实际 argv 转发分别记录，未转发项不能描述成已应用。清理完成结论需要
停止后的检查证据；Core 停止服务后会重新读取该受管容器状态并保存 Artifact。
