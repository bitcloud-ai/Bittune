---
name: benchmark-report
description: 压测结果报告、Excel交付、证据归档及V3既有结果工作簿
---

# 结果交付

对 Bittune 原生结果使用受管报告与交付导出工具，引用真实结果 ID 和 Artifact，保留绑定与来源。模型失败、请求失败、统计不足和未运行分别呈现；缺失值不补零。

用户提供 V3 已登记结果，需要 V3 Excel 时使用已安装的离线生成器：

```text
python3 ../benchmark-suite/scripts/benchmark_assets.py workbook -- --registration <registered-results.json> --output <new-report.xlsx>
```

需要 openpyxl；在当前 Python 环境缺少时报告依赖缺口，不为生成工作簿自动改动服务环境。V3 registration 和 Core 结果结构不同，未提供转换器；不能把 Core JSON 直接传入。模板只读，输出新文件。V3 工作簿属于外部来源交付，不改写为 Core 原生实测。

按需用 `python3 ../benchmark-suite/scripts/benchmark_assets.py reference single-node references/reporting.md` 读取已安装参考；result-contract.json 使用同一入口。原始 DOCX/XLSX、答案包、账号、主机地址、原始日志和工作区文件保留本地；对外输出检查所选内容并脱敏，用户确认后才发布。
