# 快速开始

## 安装

当前发行包支持主流 glibc Linux x86_64 主机。从 GitHub Releases 下载
`bittune-<version>-linux-x86_64.tar.gz` 并运行：

```bash
tar -xzf bittune-<version>-linux-x86_64.tar.gz
cd bittune-<version>-linux-x86_64
sudo ./install.sh
```

安装器会自动检查主机、识别在线或离线包内容、准备固定版本 Node.js（当前为 v22.22.2）与 Bittune，并创建
`/usr/local/bin/bittune`。离线包使用同一条 `sudo ./install.sh` 命令。

在线包会下载生产 npm 依赖和固定版本的 Python 测量工具；离线包包含 Node.js 和
生产 npm 依赖，全程不访问网络，除非宿主上已准备好 Python 工具，否则会跳过。

Bittune 以 root 安装并在 root 下使用；如需改用普通用户运行，请将该用户加入 `docker` 组。

安装完成后，`bittune` 可在任意目录使用：

```bash
bittune version
bittune doctor
```

`bittune doctor` 逐项检查 Node.js、Docker、NVIDIA GPU 与 Container Toolkit、
模型缓存、EvalScope 等状态，并给出缺失项的说明。

## 配置 Agent LLM

```bash
export BITTUNE_AGENT_LLM_API_KEY='your-api-key'
bittune configure \
  --base-url https://endpoint.example.com/v1 \
  --model-id your-tool-capable-model
bittune doctor
```

`--model-id` 需要选择支持工具调用的模型。

## 启动会话

```bash
bittune
```

进入 TUI 交互界面后，直接用自然语言描述目标，例如：

> 检查这台机器的环境，发现本地可用的模型，用 vLLM 部署吞吐最高的那个并压测。

Agent 会自主组合环境检查、模型发现、受管部署、压测和调优工具，并输出可复核的
结论与证据。会话可以退出后恢复；`bittune --fresh [message]` 可在不读取历史证据
的隔离命名空间中开始全新会话。

## 开发

```bash
npm install
npm run check
npm test
npm run bittune
npm run package:agent
```
