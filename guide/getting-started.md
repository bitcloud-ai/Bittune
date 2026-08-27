# 快速开始

## 1. 安装

当前 Linux 发行包支持 apt-based x86_64 主机。从 GitHub Release 下载
`bittune-installer-<version>.tar.gz` 后执行：

```bash
tar -xzf bittune-installer-<version>.tar.gz
cd bittune-installer-<version>
sudo ./bootstrap.sh --package ./bittune-runtime-<version>.tgz <linux-user> --yes
```

安装器分五个阶段执行：环境体检、计划确认、组件安装（系统基础包 → 固定版本 Node.js → Bittune Runtime → 钉版 EvalScope/Hugging Face CLI）、装后自检与结果汇报。任何一步失败会打印原因、建议命令与日志位置（`/opt/bittune/install.log`）；重跑幂等，已满足的组件自动跳过。只读体检：把 `--yes` 换成 `--check-only`。

安装到 `/opt/bittune`，并创建 `/usr/local/bin/bittune`。GPU Driver、Docker、NVIDIA Container Toolkit、推理镜像与模型不属于安装器范围，始终由管理员准备；`bittune doctor` 会逐项报告状态。

若默认路径已被其他产品使用，可指定隔离目录：

```bash
sudo BITTUNE_INSTALL_ROOT=/opt/bittune-agent-runtime \
  ./bootstrap.sh --package ./bittune-runtime-<version>.tgz <linux-user> --yes
```

离线主机先在有网机器执行 `./build-offline-bundle-ubuntu.sh` 产出 bundle 目录，目标机上：

```bash
sudo BITTUNE_INSTALL_ROOT=/opt/bittune-agent-runtime \
  ./bootstrap.sh --offline /path/to/bittune-offline-bundle <linux-user> --yes
```

## 2. 配置 Agent LLM

Bittune 使用 OpenAI-compatible endpoint 进行 Agent 推理。API Key 只通过环境变量提供：

```bash
export BITTUNE_AGENT_LLM_API_KEY='your-api-key'
bittune configure \
  --base-url https://endpoint.example.com/v1 \
  --model-id your-tool-capable-model
```

也可以用 `--api-key-env` 指定其他环境变量名：

```bash
export COMPANY_LLM_KEY='your-api-key'
bittune configure \
  --base-url https://endpoint.example.com/v1 \
  --model-id your-tool-capable-model \
  --api-key-env COMPANY_LLM_KEY
```

配置完成后检查本机状态：

```bash
bittune doctor
```

## 3. 启动会话

```bash
bittune
```

在会话中直接说明工程目标，例如：

```text
检查这台机器是否具备部署 vLLM 的条件，并说明缺少的前置项。
```

当目标涉及部署、压测、容量分析或实验时，Bittune 会根据当前对话选择相应 Domain Tool。缺少 Docker、GPU、模型或 EvalScope 时，相关操作会返回明确限制，不会伪造测量结果；用户可以在后续回合修改目标或指定下一步。

## 4. 恢复会话

Bittune 会在会话输出中显示恢复命令。也可以使用：

```bash
bittune --session <session-id>
```

## 5. 从源码运行

开发环境要求 Node.js >= 22.19.0：

```bash
npm install
npm run check
npm test
npm run bittune
```

构建可发布安装包：

```bash
npm run package:agent
npm run test:gpu-acceptance
```
