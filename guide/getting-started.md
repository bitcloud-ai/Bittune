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

在线包会下载生产 npm 依赖和固定版本的 Python 测量工具；离线包包含 Node.js 与
生产 npm 依赖，Python Core 以预构建 wheel 在虚拟环境中离线安装，全程不访问网络。
固定版本的 EvalScope 测量工具仅在线安装提供（离线环境需自行准备）。

Bittune 以 root 安装并在 root 下使用；如需改用普通用户运行，请将该用户加入 `docker` 组。

安装完成后，`bittune` 可在任意目录使用：

```bash
bittune version
bittune doctor
```

`bittune doctor` 逐项检查 Node.js、Python Core、Docker、NVIDIA GPU 与
Container Toolkit、EvalScope 等状态，并给出缺失项的说明。

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

> 检查这台机器的环境，准备本地模型缓存，用 vLLM 部署并压测，最后给出报告。

Agent 用 Bash 自由调查、用受管工具走完部署→压测→报告闭环，并输出可复核的
结论与证据。会话可以退出后用 `bittune --session <id>` 恢复；Run、Artifact 与
事实保存在 `~/.bittune/core`，重启后仍可通过 `inspect_records` 回查。

## 确认偏好

普通确认（未知命令、工作区外写入这类 routine ask）可以调整偏好：

```
/approval ask      # 逐次确认（默认）
/approval session  # 本次会话跳过普通确认（新会话自动恢复）
/approval always   # 全局始终跳过（写入全局设置；用 /approval ask 恢复）
```

危险命令、网络/依赖写入、受管部署生命周期和上传发布永远是显式确认，不受
该偏好影响。状态栏会显示当前偏好。

## 开发

```bash
npm install
npm run check
npm test
npm run bittune
npm run package:agent
```
