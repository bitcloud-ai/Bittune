---
name: benchmark-report
description: Core报告、Excel交付、证据包及V3已登记结果工作簿
---

# 结果交付

Bittune结果使用Core报告与导出工具，引用真实结果和Artifact；保留失败、缺失值和来源。缺失值不补零。

V3已登记结果需要V3工作簿时调用：

```text
python3 ../benchmark-suite/scripts/benchmark_assets.py workbook -- --registration <registered-results.json> --output <new-report.xlsx>
```

命令路径相对本Skill目录，先解析为绝对路径。模板只读并输出新文件；复用Core的Python环境与openpyxl。V3与Core结果格式不互通，Core JSON不能直接传入。

需要参考时通过同一脚本的 `reference single-node references/reporting.md` 或 `reference single-node references/result-contract.json` 读取。对外交付先核对所选内容与脱敏结果，批准后发布。
