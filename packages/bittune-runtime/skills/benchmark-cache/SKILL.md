---
name: benchmark-cache
description: 缓存冷暖配对、目标命中率构造与实测命中率解释
---

# 缓存规划与受管冷暖测量

目标命中率是负载构造条件，不是测量结果。需要共享/私有 Token 长度时，调用已安装 V3 离线计算器：

```text
python3 ../benchmark-suite/scripts/benchmark_assets.py cache-plan -- --input-tokens 4096 --output-tokens 128 --hit-rate 80% --json
```

实测用受管套件 cache_pair，先确认当前引擎和 Core 档案支持所需缓存方法。读本机 `references/cache-hit-simulation.md` 获取口径。冷/热数据源和缓存重置证据不完整时说明缺口；不自行换成原始 runner 压测。扩大命中率梯度或破坏性清缓存必须符合当前已授权范围。

分别报告构造比例、冷/热协议和实测命中率；无法取得服务计数器时实测字段为空并解释原因。离线计算器输出只能称为规划，不能写入实测事实或冒充缓存已验证。
