"""write_report: the only entry point that creates a Report.

The Agent supplies title, scope, narrative, conclusion, references and
structured metric claims. The Core resolves every reference, refuses claims
that do not point at an existing BenchmarkResult metric, renders the numbers
(with machine IDs beside human labels) and writes the Report fact plus a
Markdown Artifact. Success, failure, cancellation and no-gain are all
expressible: measured numbers must come from claims; anything else stays in
the narrative and is never rendered as a measured metric.

"""

import json
import math
import uuid
from typing import Any

from bittune_core.measurement import CONTRACT
from bittune_core.contracts import (
    PD_CLAIM_METRICS,
    SUITE_CLAIM_METRICS,
    ContractError,
    claimable,
)
from bittune_core.runs import ManagedRun
from bittune_core.store import CoreStore, utc_now

_METRIC_UNITS: dict[str, str] = {
    "requests_per_second": "req/s",
    "output_tokens_per_second": "tok/s",
    "success_rate": "%",
    "observed_gpu_memory_peak_bytes": "bytes",
}

REFERENCE_KINDS = {
    "plan_ids": "deployment_plan",
    "benchmark_result_ids": "benchmark_result",
    "service_instance_ids": "service_instance",
    "experiment_ids": "experiment",
    "hardware_snapshot_ids": "hardware_snapshot",
    "suite_result_ids": "suite_result",
    "pd_estimate_ids": "pd_estimate",
}
REPORT_REFERENCE_KEYS = (*REFERENCE_KINDS, "run_ids", "artifact_ids")


def write_report(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    with ManagedRun(store, "write_report", params, context["session_id"], context) as run:
        from bittune_core.report_selection import prepare_report, verify_rendered, coverage_markdown
        params, coverage = prepare_report(params, store, _row_is_claimable)
        title = params.get("title")
        if not isinstance(title, str) or not title.strip():
            raise ContractError("invalid_input", "title 是必填的。")
        scope = params.get("scope") if isinstance(params.get("scope"), str) else ""
        narrative = params.get("narrative") if isinstance(params.get("narrative"), str) else ""
        conclusion = params.get("conclusion") if isinstance(params.get("conclusion"), str) else ""
        if not conclusion.strip() and not narrative.strip():
            raise ContractError("invalid_input", "narrative 与 conclusion 不能同时为空。")

        references_input = params.get("references") if isinstance(params.get("references"), dict) else {}
        resolved_references = _resolve_references(store, references_input)

        claims_input = params.get("metric_claims") if isinstance(params.get("metric_claims"), list) else []
        referenced_benchmark_ids = {
            item for item in (references_input.get("benchmark_result_ids") or []) if isinstance(item, str)
        }
        for claim in claims_input:
            if isinstance(claim, dict) and claim.get("benchmark_result_id") not in referenced_benchmark_ids:
                raise ContractError(
                    "invalid_metric_claim",
                    "metric_claims 中的 BenchmarkResult 必须同时出现在 references.benchmark_result_ids。",
                    {"benchmark_result_id": claim.get("benchmark_result_id")},
                    remediation="将被引用的实测结果 ID 加入 references，确保报告证据链闭合。",
                )
        rendered_claims = _render_claims(store, claims_input)

        referenced_suite_ids = {item for item in (references_input.get("suite_result_ids") or []) if isinstance(item, str)}
        referenced_pd_ids = {item for item in (references_input.get("pd_estimate_ids") or []) if isinstance(item, str)}
        rendered_suite = _render_suite_claims(store, params.get("suite_claims") if isinstance(params.get("suite_claims"), list) else [], referenced_suite_ids)
        rendered_pd = _render_pd_claims(store, params.get("pd_claims") if isinstance(params.get("pd_claims"), list) else [], referenced_pd_ids)
        verify_rendered(coverage, dict(metric_claims=rendered_claims, suite_claims=rendered_suite, pd_claims=rendered_pd))

        markdown = _render_markdown(
            title, scope, narrative, conclusion, resolved_references, rendered_claims, rendered_suite, rendered_pd
        )
        markdown += coverage_markdown(coverage)
        artifact_ref = run.artifact("report", markdown, "text/markdown")

        report_id = f"report-{uuid.uuid4()}"
        payload: dict[str, Any] = {
            "schema_version": 1,
            "report_id": report_id,
            "title": title,
            "scope": scope,
            "narrative": narrative,
            "conclusion": conclusion,
            "references": resolved_references,
            "metric_claims": rendered_claims,
            "suite_claims": rendered_suite,
            "pd_claims": rendered_pd,
            "coverage": coverage,
            "artifact_ids": [artifact_ref["artifact_id"]],
            "created_at": utc_now(),
            "provenance": "derived",
        }
        store.put_report(payload, run.run_id)
        return run.success(f"Report {report_id} 已写入，Markdown Artifact {artifact_ref['artifact_id']}。", {"report": payload})


def _resolve_references(store: CoreStore, references: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    supported = list(REPORT_REFERENCE_KEYS)
    unknown = sorted(set(references) - set(supported))
    if unknown:
        raise ContractError("invalid_input", f"references 不支持字段 {', '.join(unknown)}；支持 {', '.join(supported)}。", {"unknown_fields": unknown, "supported_fields": supported})
    resolved: dict[str, list[dict[str, Any]]] = {}
    for key, kind in REFERENCE_KINDS.items():
        ids = references.get(key) if isinstance(references.get(key), list) else []
        entries: list[dict[str, Any]] = []
        for reference_id in ids:
            if not isinstance(reference_id, str):
                raise ContractError("invalid_input", f"{key} 只能包含字符串 ID。", {})
            fact = store.get_fact(kind, reference_id)
            payload = fact["payload"]
            entry: dict[str, Any] = {"id": reference_id, "kind": kind}
            if kind == "deployment_plan":
                model = (payload.get("model_ref") or {}).get("model_id", "")
                runtime = (payload.get("runtime_spec") or {}).get("runtime_kind", "")
                entry["label"] = f"方案：{model} / {runtime} / status={payload.get('status')}"
            elif kind == "benchmark_result":
                entry["label"] = f"实测：{payload.get('workload_hash', '')[:12]}…（{payload.get('metrics', {}).get('requests_per_second', '无 RPS')} req/s）"
            elif kind == "service_instance":
                entry["label"] = f"服务：{payload.get('endpoint') or '无端点'}（{payload.get('observed_state')}）"
            elif kind == "experiment":
                entry["label"] = f"比较：{payload.get('objective', '')}（{payload.get('conclusion', {}).get('summary', '')}）"
            elif kind == "suite_result":
                entry["label"] = f"扫描：{payload.get('profile_id', '')}（{len(payload.get('rows') or [])} 行）"
            elif kind == "pd_estimate":
                entry["label"] = f"P/D 推算：{payload.get('state', '')}"
            elif kind == "hardware_snapshot":
                entry["label"] = _environment_label(payload)
            entries.append(entry)
        resolved[key] = entries
    run_ids = references.get("run_ids") if isinstance(references.get("run_ids"), list) else []
    run_entries = []
    for run_id in run_ids:
        if not isinstance(run_id, str):
            raise ContractError("invalid_input", "run_ids 只能包含字符串 ID。", {})
        run = store.get_run(run_id)
        run_entries.append({"id": run_id, "kind": "run", "label": f"执行：{run['tool_name']}（{run['status']}）"})
    if run_entries:
        resolved["run_ids"] = run_entries
    artifact_ids = references.get("artifact_ids") if isinstance(references.get("artifact_ids"), list) else []
    artifact_entries = []
    for artifact_id in artifact_ids:
        if not isinstance(artifact_id, str):
            raise ContractError("invalid_input", "artifact_ids 只能包含字符串 ID。", {})
        row = store.artifact_row(artifact_id)
        if row is None:
            raise ContractError("not_found", f"Artifact {artifact_id} 不存在。", {"artifact_id": artifact_id})
        artifact_entries.append({"id": artifact_id, "kind": "artifact", "label": f"证据：{row['label']}（{row['size_bytes']} bytes）"})
    if artifact_entries:
        resolved["artifact_ids"] = artifact_entries
    return resolved


def _render_claims(store: CoreStore, claims_input: list[Any]) -> list[dict[str, Any]]:
    rendered: list[dict[str, Any]] = []
    for claim in claims_input:
        if not isinstance(claim, dict):
            raise ContractError("invalid_input", "metric_claims 每项必须是对象。", {})
        benchmark_id = claim.get("benchmark_result_id")
        metric = claim.get("metric")
        if not isinstance(benchmark_id, str) or not isinstance(metric, str):
            raise ContractError("invalid_input", "metric_claims 需要 benchmark_result_id 与 metric。", {})
        result = store.get_fact("benchmark_result", benchmark_id)["payload"]
        if not claimable(result):
            raise ContractError(
                "invalid_input",
                "该结果不是产品签字的实测。",
                {"benchmark_result_id": benchmark_id},
                remediation="该结果不是产品签字的实测。",
            )
        metrics = result.get("metrics") or {}
        if metric not in metrics:
            raise ContractError(
                "invalid_metric_claim",
                f"指标 {metric} 不在 BenchmarkResult {benchmark_id} 的实测指标中。",
                {"metric": metric, "available": sorted(metrics)},
                remediation="claim 只能引用 Core 实测得到的指标；估算请写进 narrative 并标注 estimated。",
            )
        value = metrics[metric]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise ContractError("invalid_metric_claim", f"指标 {metric} 不是数值，不能进入实测指标表。", {"metric": metric})
        display_value, unit = _metric_display(metric, float(value))
        rendered.append(
            {
                "label": claim.get("label") if isinstance(claim.get("label"), str) and claim["label"] else metric,
                "benchmark_result_id": benchmark_id,
                "metric": metric,
                "value": value,
                "display": f"{display_value} {unit}".strip(),
                "workload_hash": result.get("workload_hash", ""),
            }
        )
    return rendered



def _row_is_claimable(store: CoreStore, suite: dict[str, Any], row: dict[str, Any]) -> bool:
    """Prefer the referenced benchmark. A missing id falls back to the row plus the suite binding."""
    benchmark_id = row.get("benchmark_result_id")
    if isinstance(benchmark_id, str):
        try:
            benchmark = store.get_fact("benchmark_result", benchmark_id)["payload"]
        except ContractError as error:
            if error.code != "not_found":
                raise
        else:
            return claimable(benchmark)
    measured = {**row, "provenance": "measured", "binding": row.get("binding", suite.get("binding", "bound"))}
    return claimable(measured)


def _render_suite_claims(store: CoreStore, claims_input: list[Any], referenced_ids: set[str]) -> list[dict[str, Any]]:
    rendered: list[dict[str, Any]] = []
    for claim in claims_input:
        if not isinstance(claim, dict):
            raise ContractError("invalid_input", "suite_claims 每项必须是对象。", {})
        if "value" in claim:
            raise ContractError("invalid_metric_claim", "suite_claims 禁止手填数字。", {"metric": claim.get("metric")})
        suite_id = claim.get("suite_result_id")
        scenario_id = claim.get("scenario_id")
        concurrency = claim.get("concurrency")
        metric = claim.get("metric")
        if not isinstance(suite_id, str) or not isinstance(scenario_id, str) or isinstance(concurrency, bool) or not isinstance(concurrency, int) or not isinstance(metric, str):
            raise ContractError("invalid_input", "suite_claims 需要 suite_result_id、scenario_id、concurrency 和 metric。", {})
        if metric not in SUITE_CLAIM_METRICS:
            raise ContractError("invalid_metric_claim", f"指标 {metric} 不能出现在扫描引用中。", {"metric": metric})
        if suite_id not in referenced_ids:
            raise ContractError("invalid_metric_claim", "suite_claims 的扫描必须同时出现在 references.suite_result_ids。", {"suite_result_id": suite_id})
        suite = store.get_fact("suite_result", suite_id)["payload"]
        repeat = claim.get("repeat")
        if repeat is not None and (isinstance(repeat, bool) or not isinstance(repeat, int)):
            raise ContractError("invalid_input", "suite_claims 的 repeat 必须是整数。", {})
        matches = [row for row in suite.get("rows") or [] if row.get("scenario_id") == scenario_id and row.get("concurrency") == concurrency]
        if isinstance(repeat, int) and not isinstance(repeat, bool):
            matches = [row for row in matches if row.get("repeat", 1) == repeat]
        if len(matches) != 1:
            raise ContractError("invalid_metric_claim", "扫描里没有这条工作点。", {"scenario_id": scenario_id, "concurrency": concurrency})
        row = matches[0]
        if not _row_is_claimable(store, suite, row):
            raise ContractError(
                "invalid_input",
                "该结果不是产品签字的实测。",
                {"suite_result_id": suite_id},
                remediation="该结果不是产品签字的实测。",
            )
        source = row.get("metrics") or {}
        value = row.get(metric) if metric == "goodput_req_per_s" else source.get(metric)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise ContractError("invalid_metric_claim", f"指标 {metric} 不在该行。", {"metric": metric, "state": row.get("state")})
        display_value, unit = _metric_display(metric, float(value))
        rendered.append({
            "label": claim.get("label") if isinstance(claim.get("label"), str) and claim["label"] else metric,
            "suite_result_id": suite_id,
            "scenario_id": scenario_id,
            "concurrency": concurrency,
            "metric": metric,
            "value": value,
            "display": f"{display_value} {unit}".strip(),
        })
        if isinstance(repeat, int) and not isinstance(repeat, bool):
            rendered[-1]["repeat"] = repeat
    return rendered


def _render_pd_claims(store: CoreStore, claims_input: list[Any], referenced_ids: set[str]) -> list[dict[str, Any]]:
    rendered: list[dict[str, Any]] = []
    for claim in claims_input:
        if not isinstance(claim, dict):
            raise ContractError("invalid_input", "pd_claims 每项必须是对象。", {})
        if "value" in claim:
            raise ContractError("invalid_metric_claim", "pd_claims 禁止手填数字。", {"metric": claim.get("metric")})
        estimate_id = claim.get("pd_estimate_id")
        metric = claim.get("metric")
        if not isinstance(estimate_id, str) or not isinstance(metric, str):
            raise ContractError("invalid_input", "pd_claims 需要 pd_estimate_id 与 metric。", {})
        if metric not in PD_CLAIM_METRICS:
            raise ContractError("invalid_metric_claim", f"指标 {metric} 不能出现在 P/D 引用中。", {"metric": metric})
        if estimate_id not in referenced_ids:
            raise ContractError("invalid_metric_claim", "pd_claims 的推算必须同时出现在 references.pd_estimate_ids。", {"pd_estimate_id": estimate_id})
        estimate = store.get_fact("pd_estimate", estimate_id)["payload"]
        value = estimate.get(metric)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise ContractError("invalid_metric_claim", f"指标 {metric} 不在该推算中。", {"metric": metric, "state": estimate.get("state")})
        display_value, unit = _metric_display(metric, float(value))
        rendered.append({
            "label": claim.get("label") if isinstance(claim.get("label"), str) and claim["label"] else metric,
            "pd_estimate_id": estimate_id,
            "metric": metric,
            "value": value,
            "display": f"{display_value} {unit}".strip(),
            "provenance": estimate.get("provenance"),
        })
    return rendered


def _metric_display(metric: str, value: float) -> tuple[str, str]:
    if metric in ("success_rate", "error_rate", "completed_request_ratio"):
        return f"{value * 100:.2f}", "%"
    unit = _METRIC_UNITS.get(metric, CONTRACT["metrics"].get(metric, "ms" if metric.endswith("_ms") else ""))
    return f"{value:.4g}", unit




def _environment_label(payload: dict[str, Any]) -> str:
    gpus = payload.get("gpus") or []
    gpu_count = (payload.get("topology") or {}).get("gpu_count") or len(gpus)
    first = gpus[0].get("name") if gpus else ""
    driver = gpus[0].get("driver_version") if gpus else ""
    kernel = payload.get("kernel")
    if gpu_count:
        parts = [f"{gpu_count}×GPU"]
        if first:
            parts.append(first)
        if driver:
            parts.append(f"driver {driver}")
        if kernel:
            parts.append(str(kernel))
        return "环境：" + " / ".join(parts)
    return f"环境：{payload.get('kernel') or '主机快照'}"






def _render_markdown(
    title: str,
    scope: str,
    narrative: str,
    conclusion: str,
    references: dict[str, list[dict[str, Any]]],
    claims: list[dict[str, Any]],
    suite_claims: list[dict[str, Any]] | None = None,
    pd_claims: list[dict[str, Any]] | None = None,
) -> str:
    lines: list[str] = [f"# {title}", ""]
    suite_claims = suite_claims or []
    pd_claims = pd_claims or []

    def section(heading: str, body: str | None = None) -> None:
        lines.append(f"## {heading}")
        lines.append("")
        if body:
            lines.append(body)
            lines.append("")

    section("范围", scope or "（未提供）")
    snapshot_refs = references.get("hardware_snapshot_ids") or []
    if snapshot_refs:
        section("环境", "\n".join(f"- {item['label']}（`{item['id']}`）" for item in snapshot_refs))
    plan_refs = references.get("plan_ids") or []
    if plan_refs:
        section("配置", "\n".join(f"- {item['label']}（`{item['id']}`）" for item in plan_refs))
    elif claims:
        section("结果", "\n".join(f"- {item['label']}：{item['display']}（`{item['benchmark_result_id']}`，workload `{item['workload_hash'][:16]}…`）" for item in claims))
    if suite_claims:
        section("扫描", "\n".join(f"- {item['label']}：{item['display']}（`{item['suite_result_id']}` {item['scenario_id']} 并发 {item['concurrency']}）" for item in suite_claims))
    if pd_claims:
        section("P/D 推算", "\n".join(f"- {item['label']}：{item['display']}（`{item['pd_estimate_id']}`，{item['provenance']}）" for item in pd_claims))
    experiment_refs = references.get("experiment_ids") or []
    if experiment_refs:
        section("比较", "\n".join(f"- {item['label']}（`{item['id']}`）" for item in experiment_refs))
    section("结论", conclusion or "（见叙述）")
    section(
        "叙述",
        (
            (narrative or "（无）")
            + "\n\n> 叙述中的数字属于 Agent 解释；凡未出现在上方“结果”的实测指标表中的数值，"
            + "均非 BitTune 实测；估算必须按 estimated 标注对待。"
        ),
    )
    if claims or plan_refs or experiment_refs or len(references) > 1:
        section("追溯")
        for entries in references.values():
            for entry in entries:
                lines.append(f"- {entry['label']}（`{entry['id']}`，kind={entry['kind']}）")
        lines.append("")
    return "\n".join(lines)
