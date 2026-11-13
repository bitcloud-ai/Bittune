"""Concise reading copy over saved report claims; evidence stays in the bundle."""
import re

METRICS = {
    "requests_per_second": "每秒完成请求", "output_tokens_per_second": "输出速度",
    "mean_ttft_ms": "平均首字等待时间", "p50_ttft_ms": "首字等待时间中位数",
    "p99_ttft_ms": "99%请求首字等待时间", "mean_tpot_ms": "平均每字生成时间",
    "p99_e2e_latency_ms": "99%请求完整响应时间", "success_rate": "请求成功率",
    "mean_e2e_latency_ms": "平均完整响应时间",
    "goodput_req_per_s": "每秒达标请求",
}


def _prose(value):
    return re.sub(r"(```|~~~)[^\n]*\n[\s\S]*?(?:\n\1[^\n]*(?:\n|$)|$)",
                  "\n技术内容见详细报告压缩包。\n", value or "")


def _cell(value):
    return str(value if value is not None else "—").replace("|", r"\|").replace("\n", " ")


def reading_markdown(report):
    rid = report["report_id"]
    number = "RPT-" + rid.removeprefix("report-").replace("-", "")[:12].upper()
    lines = [f"# {report['title']}", "", f"报告编号：{number}", "", "## 结论", "",
             _prose(report.get("conclusion")) or "请结合下方实测结果与说明阅读。", "", "## 测试范围", "",
             _prose(report.get("scope")) or "未提供范围说明。", "", "## 说明与限制", "",
             _prose(report.get("narrative")) or "无补充说明。"]
    claims = [c for key in ("suite_claims", "metric_claims", "predicted_claims", "pd_claims") for c in report.get(key, [])]
    for key, title in (("hardware_snapshot_ids", "测试环境"), ("plan_ids", "部署配置")):
        entries = report.get("references", {}).get(key, [])
        if entries:
            lines += ["", f"## {title}", "", *dict.fromkeys(f"- {_prose(e['label'])}" for e in entries)]
    experiments = report.get("references", {}).get("experiment_ids", [])
    if experiments:
        lines += ["", "## 配置比较", "", f"本报告引用{len(experiments)}条已保存的配置比较，具体条件与原始结论见详细报告压缩包。"]
    if claims:
        lines += ["", "## 实测与评估结果", "", "| 测试编号 | 指标 | 结果 | 测试条件 |", "| --- | --- | --- | --- |"]
        for c in claims:
            condition = f"并发{c['concurrency']} · 第{c.get('repeat', 1)}次" if "concurrency" in c else c.get("prediction_label") or c.get("provenance") or "见来源说明"
            test = "TEST-" + c["suite_result_id"].removeprefix("suite-").replace("-", "")[:12].upper() if c.get("suite_result_id") else "单项评估"
            lines.append(f"| {test} | {_cell(METRICS.get(c.get('metric')) or c.get('label') or c.get('metric'))} | {_cell(c.get('display', c.get('value')))} | {_cell(condition)} |")
    lines += ["", "## 来源与详细资料", "", f"原始报告编号：{rid}", "",
              "完整配置、原始测量、来源索引与签名文件见详细报告压缩包；本阅读版不新增测量或改变原始结果。", ""]
    return "\n".join(lines)
