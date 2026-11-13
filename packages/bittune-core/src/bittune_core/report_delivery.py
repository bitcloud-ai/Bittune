"""Report-bound exports: saved sources only, never a new model measurement."""
from __future__ import annotations

import io
import json
import sys
import zipfile
from openpyxl import Workbook

from bittune_core.contracts import ContractError, sha256_bytes
from bittune_core.deliverable import _workbook, _fact_source
from bittune_core.measurement import CONTRACT
from bittune_core.redaction import redact
from bittune_core.reports import REFERENCE_KINDS
from bittune_core.runs import ManagedRun
from bittune_core.store import utc_now

_LINKS = {"service_instance_id": "service_instance", "plan_id": "deployment_plan",
    "hardware_snapshot_id": "hardware_snapshot", "correctness_result_id": "correctness_result",
    "cache_pair_result_id": "cache_pair_result", "pd_estimate_id": "pd_estimate"}


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2).encode()


def _sources(store, report):
    queue = [("report", report["id"])]
    facts, runs, artifacts = {}, set(), set()
    while queue:
        kind, rid = queue.pop()
        if (kind, rid) in facts:
            continue
        if not isinstance(rid, str) or "/" in rid or "\\" in rid or rid in (".", ".."):
            raise ContractError("invalid_input", "报告包含无效来源ID。")
        fact = store.get_fact(kind, rid)
        facts[(kind, rid)] = fact
        runs.add(fact["source_run_id"])
        value = fact["payload"]
        for key, target in _LINKS.items():
            if value.get(key):
                queue.append((target, value[key]))
        artifacts.update(value.get("artifact_ids") or [])
        for key in ("profile_artifact_id", "early_stop_artifact_id"):
            if value.get(key):
                artifacts.add(value[key])
        if kind == "report":
            for ref_kind, refs in value.get("references", {}).items():
                for ref in refs:
                    if ref_kind in REFERENCE_KINDS:
                        queue.append((REFERENCE_KINDS[ref_kind], ref["id"]))
                    elif ref_kind == "run_ids":
                        runs.add(ref["id"])
                    elif ref_kind == "artifact_ids":
                        artifacts.add(ref["id"])
            parent = value.get("coverage", {}).get("source_report_id")
            if parent:
                queue.append(("report", parent))
        if kind == "suite_result":
            for row in value.get("rows", []):
                if row.get("benchmark_result_id"):
                    queue.append(("benchmark_result", row["benchmark_result_id"]))
        if kind == "experiment":
            for bid in value.get("compared_benchmark_result_ids", []):
                queue.append(("benchmark_result", bid))
            for point in value.get("suite_points", []):
                queue.append(("suite_result", point["suite_result_id"]))
    run_records = {}
    for (kind, _), fact in facts.items():
        if kind == "report":
            for source in fact["payload"].get("coverage", {}).get("suites", []):
                saved = facts[("suite_result", source["suite_result_id"])]
                if source.get("source_content_hash") and saved["content_hash"] != source["source_content_hash"]:
                    raise ContractError("report_source_changed", "报告声明的套件摘要与现存来源不一致，未生成交付包。")
    for rid in sorted(runs):
        run_records[rid] = store.get_run(rid)
        artifacts.update(a["artifact_id"] for a in store.list_run_artifacts(rid))
    return facts, run_records, artifacts


def _cell(value):
    # Report titles and scenario labels are data, never spreadsheet formulas.
    return "'" + value if isinstance(value, str) and value.startswith(("=", "+", "-", "@")) else value


def _overview(report, suites):
    book = Workbook()
    index = book.active
    index.title = "来源索引"
    index.append(["报告", _cell(report["payload"]["title"]), report["id"], report["content_hash"]])
    index.append(["套件ID", "服务ID", "来源摘要", "测量行数"])
    detail = book.create_sheet("全部工作点")
    columns = ["套件ID", "服务ID", "BenchmarkID", "场景", "并发", "重复", "测量状态", "缓存条件",
               "平均首字ms", "平均TPOTms", "平均端到端ms", "输出Token/s", "成功率", "请求goodput/s"]
    detail.append(columns)
    for fact in suites:
        s = fact["payload"]
        index.append([s["suite_result_id"], s.get("service_instance_id"), fact["content_hash"], len(s.get("rows", []))])
        for row in s.get("rows", []):
            m = row.get("measurement") or {}
            metrics = m.get("metrics") or row.get("metrics") or {}
            values = [s["suite_result_id"], s.get("service_instance_id"), row.get("benchmark_result_id"),
                row.get("scenario_id"), row.get("concurrency"), row.get("repeat", 1),
                row.get("measurement_status") or row.get("state"), m.get("cache_policy", {}).get("mode")]
            values += [metrics.get(k) for k in ("mean_ttft_ms", "mean_tpot_ms", "mean_e2e_latency_ms",
                "output_tokens_per_second", "success_rate", "goodput_req_per_s")]
            detail.append([_cell(v) for v in values])
    for sheet in book:
        sheet.freeze_panes = "A2"
        sheet.auto_filter.ref = sheet.dimensions
        for column in sheet.columns:
            sheet.column_dimensions[column[0].column_letter].width = 26
    result = io.BytesIO()
    book.save(result)
    return result.getvalue()


def export_report(params, context):
    from bittune_core.report_pdf import signed_report_pdf, sign_delivery_manifest
    store = context["store"]
    if sys.version_info < (3, 11):
        raise ContractError("report_dependencies_missing", "签名报告需要Python3.11或更高版本的reports模块；基础CLI仍可使用原有导出。")
    report_id = params.get("report_id")
    if not isinstance(report_id, str) or not report_id.startswith("report-"):
        raise ContractError("invalid_input", "报告导出需要明确report_id。")
    if any(key in params for key in ("service_instance_id", "suite_result_id", "benchmark_result_ids", "profile_id")):
        raise ContractError("invalid_input", "报告导出与单服务导出参数不能混用。")
    with ManagedRun(store, "export_deliverable", params, context["session_id"], context) as run:
        report = store.get_fact("report", report_id)
        run.progress("读取已保存报告并生成本机签名PDF，不启动模型或测量…")
        try:
            pdf, certificate, signature = signed_report_pdf(store, report)
        except ModuleNotFoundError:
            raise ContractError("report_dependencies_missing", "此Core环境尚未安装reports模块，请先配置报告运行依赖。") from None
        if params["intent"] == "signed_pdf":
            artifact = run.artifact("signed-report-pdf", pdf, "application/pdf")
            run.artifact("report-signing-certificate", certificate, "application/x-pem-file")
            return run.success("签名PDF已生成并通过本机验签；证书为本机自签。",
                               {"artifact": artifact, "signature": signature})
        facts, runs, artifact_ids = _sources(store, report)
        suites = [f for (kind, _), f in facts.items() if kind == "suite_result"]
        content, files, source_index = io.BytesIO(), [], []
        with zipfile.ZipFile(content, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            def write(path, data):
                archive.writestr(path, data)
                files.append({"path": path, "sha256": sha256_bytes(data), "size_bytes": len(data)})
            from bittune_core.report_reading import reading_markdown
            write("report.md", reading_markdown(report["payload"]).encode("utf-8"))
            write("report/signed-report.pdf", pdf)
            write("report/signing-certificate.pem", certificate)
            write("report/signature-verification.json", _json(signature))
            write("all-workpoints.xlsx", _overview(report, suites))
            for (kind, rid), fact in sorted(facts.items()):
                path = f"facts/{kind}/{rid}.json"
                body = _json(redact(fact["payload"]))
                write(path, body)
                source_index.append(_fact_source(path, kind, fact, body))
            for fact in suites:
                s = fact["payload"]
                write(f"workbooks/{s['suite_result_id']}.xlsx", _workbook(s, None))
            for rid, record in sorted(runs.items()):
                write(f"runs/{rid}.json", _json(redact(record)))
            for aid in sorted(artifact_ids):
                write(f"artifacts/{aid}", store.read_artifact_bytes(aid))
            write("measurement-contract.json", _json(CONTRACT))
            manifest = {"schema_version": "bittune-report-bundle-v1", "report_id": report_id,
                "report_content_hash": report["content_hash"], "completeness": "complete",
                "export_run_id": run.run_id, "exported_at": utc_now(),
                "manifest_signature": {"algorithm": "RSASSA-PKCS1-v1_5-SHA256", "path": "manifest.sig",
                    "certificate_path": "report/signing-certificate.pem", "trust_mode": "local_self_signed"},
                "suite_ids": [f["id"] for f in suites], "facts": source_index, "files": files,
                "scope": "Saved report and its declared source closure; no new measurements or weights."}
            manifest_bytes = _json(manifest)
            archive.writestr("manifest.json", manifest_bytes)
            archive.writestr("manifest.sig", sign_delivery_manifest(store, manifest_bytes))
        artifact = run.artifact("report-bundle", content.getvalue(), "application/zip")
        return run.success("完整报告交付包已生成，覆盖全部报告来源；未重新测量。",
            {"artifact": artifact, "signature": signature, "suite_ids": manifest["suite_ids"],
             "fact_count": len(facts), "file_count": len(files), "completeness": "complete", "manifest_signature_valid": True})
