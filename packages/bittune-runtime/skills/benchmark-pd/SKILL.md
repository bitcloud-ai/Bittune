---
name: benchmark-pd
description: P/D容量规划、拓扑与KV传输测试目录；区分单机估算和集群实测
---

# P/D 规划与集群目录

单机已有扫描与缓存证据需要规划时，优先用受管套件 pd_planning，引用本次已保存结果。补充离线容量敏感性计算可调用 `../benchmark-suite/scripts/benchmark_assets.py pd-plan -- --help`；参数与算法复用已安装 V3 脚本。容量输入必须来自明确的已测实例与 SLO，标记估算，不作为新的部署配置。

集群任务先调用 `../benchmark-suite/scripts/benchmark_assets.py catalog pd-cluster --json`，再用 `python3 ../benchmark-suite/scripts/benchmark_assets.py reference pd-cluster references/topology.md` 按需读取资源目录中的参考；cache-router.md、kv-transfer.md 与 reporting.md 也通过同一入口读取。列出节点、物理卡归属、P/D实例、Router、KV路径与测量条件的缺口。

当前 Bittune Core 是本机受管执行边界，尚无远程集群部署/负载适配器。V3 集群参考和原始脚本已本机安装，但多机实测未接线：先交付目录、拓扑和缺口，不能把安装成功说成集群已测通，也不通过原始 SSH/runner 旁路创建集群测量事实。
