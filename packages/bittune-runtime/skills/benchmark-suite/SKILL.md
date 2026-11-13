---
name: benchmark-suite
description: 压测范围选择与单机、缓存、P/D规划、报告模块路由
---

# 压测任务路由

沿用用户已选范围；范围未知时先展示目录并确定场景、预算和停止条件。命令路径相对本Skill目录，调用时解析为绝对路径。

```text
python3 scripts/benchmark_assets.py catalog single-node --format json
python3 scripts/benchmark_assets.py catalog pd-cluster --json
```

- 单点验证、并发或长度扫描：读取 benchmark-single-node。
- 文本规则质量：用benchmark_suite(intent=correctness)和本机correctness-pack-v1；明确样例/输出预算，期望答案留在本机，不称作通用模型质量。
- 工作点费用估算：用benchmark_suite(intent=cost_planning)引用已保存Suite工作点，单价/币种/GPU张数必须用户给定，结果标estimated并附来源Artifact，不运行新负载。
- 缓存构造、冷暖配对：读取 benchmark-cache。
- P:D容量或集群测试目录：读取 benchmark-pd。
- 报告、Excel、证据交付：读取 benchmark-report。

只执行已授权场景。实测通过Core受管工具保存事实；离线计算与外部结果保留来源。当前没有远程多机负载适配器；遇到未支持项说明缺口，不扩展为原始runner或独立Agent执行。
