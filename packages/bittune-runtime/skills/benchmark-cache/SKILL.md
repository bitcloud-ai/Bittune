---
name: benchmark-cache
description: 缓存构造计算、冷暖配对与实测命中率解释
---

# 缓存规划与测量

纯规划调用离线计算器，返回共享/私有Token长度后结束。命令路径相对本Skill目录，先解析为绝对路径。

```text
python3 ../benchmark-suite/scripts/benchmark_assets.py cache-plan -- --input-tokens 4096 --output-tokens 128 --hit-rate 80% --json
```

准备实测时通过同一脚本的 `reference single-node references/cache-hit-simulation.md` 读取协议；使用Core的cache_pair，并核对引擎、档案、清缓存影响和授权范围。

构造比例、冷暖协议、实测命中率分别报告。缺少计数器或重置证据时保留空值和原因；规划值不作为实测。
