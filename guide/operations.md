# 运行指南

## 运行目录

默认运行目录为 `~/.bittune`，可以通过环境变量调整：

| 环境变量 | 用途 |
|---|---|
| `BITTUNE_HOME` | Bittune 根目录。 |
| `BITTUNE_AGENT_DIR` | Agent 模型配置和会话目录。 |
| `BITTUNE_SESSION_DIR` | 会话文件目录。 |
| `BITTUNE_STATE_DIR` | SQLite 状态库与 Artifact 索引目录。 |
| `BITTUNE_LOG_DIR` | 运行日志目录。 |
| `BITTUNE_MODEL_CACHE_ROOTS` | 额外模型缓存根目录，使用系统路径分隔符分隔。 |
| `BITTUNE_ARTIFACT_RETENTION_DAYS` | 未被领域状态引用的完成 Run 保留天数，默认 30。 |
| `BITTUNE_ARTIFACT_MAX_BYTES` | 未引用证据清理后的总 Artifact 上限，默认 10737418240（10 GiB）。 |

API Key 环境变量由 `bittune configure --api-key-env` 指定；默认名称为
`BITTUNE_AGENT_LLM_API_KEY`。不要把密钥写入项目文件、MCP 配置或 Shell 历史。

需要从零开始且不得读取或复用历史 Run、Experiment、Artifact、会话或受管服务
记录时，使用 `bittune --fresh [message]`。它为本次 Agent 会话创建新的 Evidence
namespace，移除历史证据读取工具，且不能与 `--session` 同用；实时的主机、GPU、模型
缓存和外部服务发现仍是只读可用的。普通 `bittune` 会话不受影响，仍可恢复已有证据和
调优上下文。

Preset、受管服务与 Run 记录按启动 `bittune` 时所在的目录划分工作空间。请始终在
同一目录启动 `bittune`；从其他目录启动的会话看不到之前目录名下的部署定义、服务和
证据（它们并未被删除）。

## 推理 Provider 前置条件

只有目标需要本机推理、模型下载或性能测试时，才准备以下工具。在线安装器会自动把固定版本的 EvalScope 与 Hugging Face CLI 安装到 `/opt/bittune/py`，Bittune 启动器在运行时自动使用该环境。手动准备时请使用独立虚拟环境，避免写入系统 Python：

```bash
docker info
nvidia-smi
python3 -m venv /opt/bittune/py
/opt/bittune/py/bin/pip install 'huggingface_hub[cli]==1.27.0' 'evalscope[perf]==1.10.0'
/opt/bittune/py/bin/hf --help
/opt/bittune/py/bin/evalscope perf --help
```

Bittune 对外部 Runtime、模型、服务和端点默认只读，发现到的容器与端点仅作为参考事实；受管操作只作用于 Bittune 创建并登记的资源。Hugging Face 是当前唯一可下载并进入受管部署闭环的模型源；ModelScope 本地缓存只用于发现。

## 证据与状态

受管操作会写入本地 SQLite State Store。每条运行记录包含受限输入、观测摘要、时间、哈希和 Artifact 引用。查询类工具只返回当前会话所需信息，不创建运行记录。

启动 StateStore 和开始压测时会清理超过保留期或容量上限的未引用完成 Run。被 Preset、Service、Experiment、Optimization 或 Baseline 引用的证据不会被自动删除。停止受管服务会删除 Bittune 创建的已停止 Docker 容器。

性能或容量结论只适用于生成它的部署、环境、负载和配置。单次成功表示一个已测运行点，不等同于最大吞吐或稳定容量。

## MCP 运维

可选 MCP 配置文件位于 `$BITTUNE_HOME/mcp.json`。第一版仅支持管理员声明为只读的 Streamable HTTP 服务，并只调用 `allowTools` 白名单；远端 Tool 的实际副作用由管理员和服务提供方负责，Bittune 不将其结果视为本机 Evidence。

配置中的密钥必须引用环境变量：

```json
{
  "mcpServers": {
    "knowledge": {
      "enabled": true,
      "transport": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${BITTUNE_MCP_API_KEY}"
      },
      "allowTools": ["search_knowledge"],
      "effect": "read-only",
      "timeoutMs": 10000,
      "toolPurposes": {
        "search_knowledge": "deployment-knowledge"
      }
    }
  }
}
```

检查 MCP 配置和连接状态：

```bash
bittune mcp list
bittune mcp get knowledge
bittune mcp test knowledge
```

MCP 服务不可用时，Bittune 保留本机工具能力，并在运行时给出诊断信息。

`toolPurposes` 可选值为 `reference`、`model-recommendation` 和 `deployment-knowledge`。MCP 只提供可选参考，不是发布 Preset、启动服务或压测的前置；MCP 不可用时，Agent 继续使用本机 Domain Tool，并明确区分 measured 与 estimated。

## 对话与工具行为

正常运行 `bittune` 即可开始或继续对话，Agent 依据你的当前目标自主选择工具。以下行为可以按需控制：

- 可选的 `runtime-policy.json` 白名单限制允许使用的 Runtime 镜像仓库范围；
- 发布部署配置前，模型 Revision 会被解析为不可变的 commit SHA，保证部署内容可追溯。
