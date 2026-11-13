---
name: prepare-engine
description: 准备引擎镜像
---

# 准备引擎镜像

本机没有对应引擎镜像、下一步又要部署时使用本 Skill。不要现场编 `docker pull`，也不要接受任意镜像地址。

## 怎么做

只跑本 Skill 目录下的脚本：

```text
scripts/prepare-engine.sh <vllm|sglang> [官方仓库@sha256:精确摘要]
scripts/prepare-engine.sh <vllm|sglang> 官方仓库@sha256:精确摘要 export-oci 绝对输出目录
scripts/prepare-engine.sh <vllm|sglang> 官方仓库@sha256:精确摘要 import-oci 绝对制品目录
```

- 第一参数选 `vllm` 或 `sglang`。其它引擎交给核心 Agent 处理。
- 已从固定版本官方资料核验兼容性并取得真实 digest 时，经用户确认后，将计划中
  的完整镜像引用作为第二参数传入。脚本只接受对应官方仓库的精确摘要。
- 省略第二参数保留默认版本兼容路径；默认版本不满足目标模型时，先调查合适的
  固定版本和 digest。版本支持与本机实跑是不同证据，不把下载成功说成能部署。
- 网络属于 Runtime Policy 的确认项。用户拒绝后停止，不要换镜像源绕过。
- 离线制品准备使用 `export-oci`，调用配置好的 crane v0.20.6，仅导出 Linux/amd64
  官方固定摘要；保留原始 manifest 和压缩层，核验后交由目标节点导入。

- 离线导入使用 `import-oci`，先验证全部OCI摘要，再用配置好的本机回环 registry
  让指定 Docker daemon 按原官方摘要拉入；daemon 的回环镜像源须由管理员预先配置，
  技能不修改 daemon、不启动模型、不从已有镜像缓存替代制品。

## 成功

普通准备报告本机已存在镜像；OCI导出仅报告制品已核验，不代表目标节点已导入。
不要调用部署、不要启动服务。把结果交给核心 Agent。

## 失败

说明缺什么后停止：没有 Docker、镜像名不在白名单、网络确认被拒。不要发明镜像地址，也不要改成未钉死的 tag。
