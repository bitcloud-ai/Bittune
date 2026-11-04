---
name: benchmark-pd
description: P/D容量估算、拓扑与KV传输测试目录
---

# P/D规划

已有本机扫描/缓存证据时，优先用Core的pd_planning引用保存结果。补充敏感性计算调用 `python3 ../benchmark-suite/scripts/benchmark_assets.py pd-plan -- --help`；容量输入必须注明实测实例与SLO，输出标为估算。

集群目录使用同一脚本的 `catalog pd-cluster --json`；拓扑参考使用 `reference pd-cluster references/topology.md`，cache-router.md、kv-transfer.md、reporting.md同理。命令路径相对本Skill目录，先解析为绝对路径。

当前支持本机容量规划和集群测试目录，不执行远程多机负载。实例/物理卡归属、路由与KV传输证据不足时说明缺口。
