---
name: benchmark-single-node
description: 单机模型服务压测、Token长度与并发扫描、时延吞吐验收
---

# 单机受管测量

沿用用户已选范围；未选范围由 benchmark-suite 展示目录。冻结模型、引擎、上下文、Token长度、并发、请求数、预热和SLO。

- 小流量验证用 benchmark_service；并发/长度扫描用 benchmark_suite 的 performance_sweep。
- 受管服务传服务ID；外部回环端点明确标为声明来源。V3场景编号不能直接当作Core档案传入。
- 正确性仅在用户选择且有兼容数据包时运行，不附加默认60题或全量权重校验。
- 缓存、P/D规划、报告分别转对应技能。

需要技术参考时调用 `python3 ../benchmark-suite/scripts/benchmark_assets.py reference single-node references/single-node-benchmark.md`。命令路径相对本Skill目录，先解析为绝对路径。

完成后引用Core结果和Artifact；区分失败、提前停止、不适用与未运行，保留指标精度和来源。
