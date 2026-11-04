---
name: benchmark-single-node
description: 单机模型服务压测、Token长度与并发扫描、时延吞吐验收
---

# 单机受管测量

先读取用户已选范围；未选范围时由 benchmark-suite 展示目录。用已有服务 ID 或用户明确授权的回环端点。冻结硬件、模型、引擎、上下文、输入/输出 Token、并发、请求数、预热和 SLO。

- 一次生成或小流量验证使用受管单点测量，不扩展为整套压测。
- 并发扫描使用受管套件的 performance_sweep；档案须符合 Core 现有 schema。V3 目录中的编号和参数是参考，不能直接作为 Core 档案传入。
- 缓存专项转 benchmark-cache；规划转 benchmark-pd；已有结果交付转 benchmark-report。
- 正确性仅在用户明确选择且有兼容数据包时运行，不因安装 V3 资源自动插入固定60题或权重全量校验。

V3 原始规范和场景注册表安装在本机资源目录。通过 `../benchmark-suite/scripts/benchmark_assets.py reference single-node references/single-node-benchmark.md` 按需读取；只取本次场景所需部分。

实测统一走现有受管工具，由 Core 保存结果、绑定与 Artifact。V3 原始执行器不替代受管测量。报告保留失败、提前停止、不适用与未运行的区别；TTFT/TPOT/ITL、吞吐与 goodput 均引用已保存事实和原始精度。
