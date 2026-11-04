---
name: benchmark-suite
description: 压测测试目录与范围选择；路由单机、缓存、P/D规划和结果交付
---

# 压测能力入口

先沿用用户已选范围，不重复要求选套餐；范围未知时给出标准、自定义与完整非破坏性三种选择。默认短验收只跑用户同意的有限场景；安装资源不自动触发正确性、全量权重校验、长稳、并发极限或多机测试。

## 本机 V3 资源

脚本相对于本 Skill 所在目录。安装和计算使用当前 Python，执行脚本仍遵守 Runtime 的正常策略与动作确认。

```text
python3 scripts/benchmark_assets.py status
python3 scripts/benchmark_assets.py install --archive <V3完整交付包.zip> --documents <Word与Excel包.zip>
python3 scripts/benchmark_assets.py catalog single-node --format json
python3 scripts/benchmark_assets.py catalog pd-cluster --json
```

安装只读取经过核对的 V3.0.1 本地包，验证摘要，在 BITTUNE_HOME 下保留资源；BITTUNE_BENCHMARK_ASSETS 可指定资源目录。不会下载依赖、启动服务、导入独立执行 Agent 或改动 GPU。两个文档版本分别保存，不混为同一个规范。

## 按目标拆分

| 用户目标 | 读取技能 | 当前接线 |
| --- | --- | --- |
| 单点验证、单机扫描、长上下文 | benchmark-single-node | 原 Core 受管单点/套件 |
| 冷暖缓存、命中率 | benchmark-cache | V3离线构造计算 + Core支持的cache_pair |
| P:D规划、集群目录与拓扑 | benchmark-pd | V3目录/离线计算 + Core pd_planning；多机负载适配未接线 |
| 报告、Excel、证据包 | benchmark-report | Core原生导出；V3工作簿仅接V3登记格式 |

目录和参考资料不代表所有条目都已能由 Core 执行；遇到未接线项列出缺口后停止该项，不改用原始 runner 或外部 Agent 绕过事实记录。受管服务结果按其绑定和出处引用；本机回环端点为声明来源，不能冒充受管实测。
