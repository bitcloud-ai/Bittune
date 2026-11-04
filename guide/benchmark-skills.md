# CLI 推荐与可选压测资源

CLI 部署推荐先读取硬件快照，再由配置的 Agent API 给出一份模型、引擎、显存、上下文和测量预算清单。`*` 为执行前必填；未知权重目录和镜像摘要保留为待补充。可以直接采用或修改清单，无逐字段确认。制品准备、计划固化和服务启停继续使用原生动作确认。

内置技能按单机测量、缓存、P/D规划和报告拆分，自动发现，也可用 `/skill:benchmark-suite` 查看入口。新增模块使用现有 Runtime 技能加载器，不增加模型执行器。

V3.0.1 资源可选，须持有对应本地交付包。在已安装的 `dist/skills/benchmark-suite` 下运行：

```sh
python3 scripts/benchmark_assets.py install --archive /path/to/complete-bundle.zip --documents /path/to/documents.zip
python3 scripts/benchmark_assets.py status
python3 scripts/benchmark_assets.py catalog single-node --format json
python3 scripts/benchmark_assets.py cache-plan -- --input-tokens 4096 --hit-rate 80% --json
```

本机资源默认保存在 `BITTUNE_HOME/benchmark-assets/3.0.1`，未设置 BITTUNE_HOME 时为 `~/.bittune/benchmark-assets/3.0.1`。可用 BITTUNE_BENCHMARK_ASSETS 指定目录。安装验证已审阅包的 SHA256 与完整清单；不下载依赖、不执行压测。安装器与各脚本帮助提供实际选项。

Core 单点/套件继续负责实测与事实入库。V3模块提供本地目录、规范、缓存构造计算、容量计算及已有V3登记结果的工作簿生成（需openpyxl）。V3与Core结果契约不同，当前未提供双向格式转换；多机执行器尚未接入Core。集群资料和脚本安装成功不表示多机实测已经验收。

## 复用记录（2026-11-04）

已审阅本地单机/P-D Skill 3.0.1、完整包清单、两份文档包，以及实际 test_catalog.py、cache_lengths.py、pd_capacity.py 和 build_result_workbook.py 入口；官方原生 CLI、Core 参数 schema、Runtime 静态技能加载器与现有构建复制路径。采用产品技能作路由，资源安装器调用原脚本，不重复实现计算算法。未检索全部第三方压测框架；本次以提供的固定交付包和当前Core契约为范围。

独立 Agent、原始负载 runner 不替换现有 Runtime/Core；集群负载和V3登记格式转换明确待集成。原始规范、数据包与执行证据作为本机资源存储，不进入源码PR或发行包；公开代码只包含适配入口和通用说明。包内未发现独立再分发许可证，故不将原文件随公开代码再分发。安装器使用Python标准库；原始脚本优先复用BITTUNE_CORE_PYTHON，未设置时使用当前Python。已接线离线计算仅需标准库，V3工作簿另需既有openpyxl。

实际适配：单机目录使用 `--format json`，P/D目录使用 `--json`；P/D计算缺省按部署实例归一，避免原脚本按每卡容量放大；工作簿无P/D结果时传入空值并保留相关单元格为空。
