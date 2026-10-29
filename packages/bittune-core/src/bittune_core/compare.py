"""Deterministic comparison of BenchmarkResults; optional Experiment record.

Comparability is the card fingerprint and the workload identity, not the
snapshot row id and not the whole workload hash. A mismatch is a successful
incomparable result: no percentage. An Experiment exists only when the caller
asks to record a claimable comparison.
"""

import math
import uuid
from typing import Any

from bittune_core.benchmark import card_fingerprint
from bittune_core.contracts import SUITE_COMPARISON_METHOD, ContractError, claimable
from bittune_core.runs import ManagedRun
from bittune_core.store import CoreStore, utc_now

COMPARISON_METHOD = "deterministic-v1"
_RESULT_CONTEXT = (
    ("metric_normalizer_version", lambda result: result.get("metric_normalizer_version")),
    ("measurement_contract", lambda result: (result.get("measurement") or {}).get("contract_version")),
    ("acceptance", lambda result: (result.get("measurement") or {}).get("acceptance")),
    ("dataset_input_sha256", lambda result: (result.get("measurement") or {}).get("dataset_input_sha256")),
    ("dataset_hash_method", lambda result: (result.get("measurement") or {}).get("dataset_hash_method")),
)
_CONTEXT = (
    ("argv_profile_version", lambda workload: workload.get("argv_profile_version")),
    ("warmup", lambda workload: workload.get("warmup")),
    ("request_timeout_seconds", lambda workload: workload.get("request_timeout_seconds")),
    ("request_rate", lambda workload: workload.get("request_rate")),
    ("stream", lambda workload: (workload.get("generation") or {}).get("stream")),
    ("ignore_eos", lambda workload: (workload.get("generation") or {}).get("ignore_eos")),
    ("prefix_length", lambda workload: workload.get("prefix_length")),
    ("seed", lambda workload: (workload.get("request_source") or {}).get("seed")),
    ("tokenizer_revision", lambda workload: (workload.get("tokenizer") or {}).get("revision")),
    ("evalscope_version", lambda workload: (workload.get("provider") or {}).get("version")),
)


def compare_results(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    with ManagedRun(store, "compare_results", params, context["session_id"], context) as run:
        has_benchmarks = "benchmark_result_ids" in params
        has_points = "suite_points" in params
        if has_benchmarks == has_points:
            raise ContractError(
                "invalid_input",
                "compare_results 需要 benchmark_result_ids 或 suite_points 其中之一，不能都缺也不能都有。",
            )
        if has_points:
            return _compare_suite_points(store, run, params)
        ids = params.get("benchmark_result_ids")
        if not isinstance(ids, list) or len(ids) < 2 or any(not isinstance(item, str) for item in ids):
            raise ContractError("invalid_input", "benchmark_result_ids 需要至少两个 BenchmarkResult ID。")
        results = [store.get_fact("benchmark_result", benchmark_id)["payload"] for benchmark_id in ids]
        baseline = results[0]
        branch = _benchmark_branch(store, results)
        conclusion: dict[str, Any] = {
            "comparison_method": COMPARISON_METHOD,
            "comparable": branch["comparable"],
            "claimable": branch["claimable"],
            "baseline_benchmark_result_id": baseline["benchmark_result_id"],
            "compared_benchmark_result_ids": [item["benchmark_result_id"] for item in results],
            "summary": branch["summary"],
        }
        if branch.get("reason"):
            conclusion["reason"] = branch["reason"]
        if not branch["comparable"] or not branch["claimable"]:
            if branch.get("values"):
                conclusion["values"] = branch["values"]
            return run.success(branch["summary"], {"comparison": conclusion})

        objective = params.get("objective") if isinstance(params.get("objective"), str) and params["objective"] else None
        deltas = _compute_deltas(baseline, results[1:], objective)
        conclusion["interpretation"] = "确定性数值比较 verdict（±1% 阈值），不是统计显著性检验；未对测量噪声与样本方差建模。"
        conclusion["objective"] = deltas["objective"]
        conclusion["deltas"] = deltas["deltas"]
        conclusion["summary"] = deltas["summary"]

        data = {"comparison": conclusion}
        data.update(_record_experiment(store, run, params, conclusion, conclusion["compared_benchmark_result_ids"]))
        return run.success(deltas["summary"], data)


def _record_experiment(store, run, params, conclusion, benchmark_ids):
    if params.get("record") is not True:
        return {}
    if any(not isinstance(rid, str) for rid in benchmark_ids):
        raise ContractError("invalid_input", "比较归档需要每个工作点的原始BenchmarkResult。")
    for rid in benchmark_ids:
        store.get_fact("benchmark_result", rid)
    payload = {
        "schema_version": 1, "experiment_id": f"exp-{uuid.uuid4()}",
        "objective": conclusion["objective"],
        "hypothesis": params.get("hypothesis") if isinstance(params.get("hypothesis"), str) else "",
        "baseline_benchmark_result_id": benchmark_ids[0],
        "compared_benchmark_result_ids": benchmark_ids,
        "comparison_method": conclusion["comparison_method"], "conclusion": conclusion,
        "created_at": utc_now(), "provenance": "derived",
    }
    if "suite_points" in params:
        payload["suite_points"] = params["suite_points"]
    store.put_experiment(payload, run.run_id)
    return {"experiment": payload}


def _compare_suite_points(store: CoreStore, run: ManagedRun, params: dict[str, Any]) -> dict[str, Any]:
    points = params.get("suite_points")
    if not isinstance(points, list) or len(points) < 2 or any(not isinstance(item, dict) for item in points):
        raise ContractError("invalid_input", "suite_points 需要至少两个工作点。")
    rows = [_resolve_suite_point(store, item) for item in points]
    branch = _suite_branch(store, rows)
    conclusion: dict[str, Any] = {
        "comparison_method": SUITE_COMPARISON_METHOD,
        "comparable": branch["comparable"],
        "claimable": branch["claimable"],
        "baseline": {"suite_result_id": rows[0]["suite_result_id"], "scenario_id": rows[0]["scenario_id"], "concurrency": rows[0]["concurrency"]},
        "summary": branch["summary"],
    }
    if branch.get("reason"):
        conclusion["reason"] = branch["reason"]
    if not branch["comparable"] or not branch["claimable"]:
        if branch.get("values"):
            conclusion["values"] = branch["values"]
        return run.success(branch["summary"], {"comparison": conclusion})
    objective = params.get("objective") if isinstance(params.get("objective"), str) and params["objective"] else "goodput_req_per_s"
    deltas = _compute_deltas(_as_benchmark_view(rows[0]), [_as_benchmark_view(row) for row in rows[1:]], objective)
    conclusion["objective"] = deltas["objective"]
    conclusion["deltas"] = deltas["deltas"]
    conclusion["summary"] = deltas["summary"]
    data = {"comparison": conclusion}
    data.update(_record_experiment(store, run, params, conclusion, [row.get("benchmark_result_id") for row in rows]))
    return run.success(deltas["summary"], data)


def _resolve_suite_point(store: CoreStore, point: dict[str, Any]) -> dict[str, Any]:
    suite_id = point.get("suite_result_id")
    scenario_id = point.get("scenario_id")
    concurrency = point.get("concurrency")
    if not isinstance(suite_id, str) or not isinstance(scenario_id, str) or isinstance(concurrency, bool) or not isinstance(concurrency, int):
        raise ContractError("invalid_input", "suite_points 每项需要 suite_result_id、scenario_id 和 concurrency。")
    suite = store.get_fact("suite_result", suite_id)["payload"]
    repeat = point.get("repeat")
    if repeat is not None and (isinstance(repeat, bool) or not isinstance(repeat, int)):
        raise ContractError("invalid_input", "suite_points 的 repeat 必须是整数。")
    matches = [row for row in suite.get("rows") or [] if row.get("scenario_id") == scenario_id and row.get("concurrency") == concurrency]
    if isinstance(repeat, int) and not isinstance(repeat, bool):
        matches = [row for row in matches if row.get("repeat") == repeat]
    if len(matches) != 1:
        raise ContractError("not_found", f"扫描 {suite_id} 没有唯一的 {scenario_id} 并发 {concurrency} 行。", {"suite_result_id": suite_id})
    return {**matches[0], "suite_result_id": suite["suite_result_id"], "suite": suite}


def _suite_branch(store: CoreStore, rows: list[dict[str, Any]]) -> dict[str, Any]:
    baseline = rows[0]
    context = None
    for other in rows[1:]:
        reason = _suite_reason(store, baseline, other)
        if reason and reason.get("kind") != "context":
            return {"comparable": False, "claimable": False, "reason": reason, "summary": f"不可比：{reason['field']} 不同。"}
        if reason and context is None:
            context = reason
    if context:
        return {
            "comparable": True,
            "claimable": False,
            "reason": {"field": context["field"], "left": context["left"], "right": context["right"]},
            "values": _suite_metric_values(rows),
            "summary": f"负载身份相同，{context['field']} 不同。数字并列，这次比较不可签字。",
        }
    controlled = all(not row.get("measurement") or (row["measurement"].get("dataset_input_sha256") and
                     (row["measurement"].get("cache_policy") or {}).get("mode") == "disabled") for row in rows)
    signed = controlled and all(_suite_row_claimable(store, row) for row in rows)
    if not signed:
        return {"comparable": True, "claimable": False, "summary": "工作点相同，这次比较不可签字。"}
    return {"comparable": True, "claimable": True, "summary": ""}


def _suite_reason(store: CoreStore, baseline: dict[str, Any], other: dict[str, Any]) -> dict[str, Any] | None:
    left_binding = _binding(baseline, baseline["suite"])
    right_binding = _binding(other, other["suite"])
    if left_binding != right_binding:
        return {"field": "binding", "left": left_binding, "right": right_binding}
    for field, getter in (
        ("model_id", lambda suite: (suite.get("model_ref") or {}).get("model_id")),
        ("revision", lambda suite: (suite.get("model_ref") or {}).get("revision")),
        ("runtime_kind", lambda suite: (suite.get("runtime_spec") or {}).get("runtime_kind")),
    ):
        left = getter(baseline["suite"])
        right = getter(other["suite"])
        if left != right:
            return {"field": field, "left": left, "right": right}
    if baseline.get("state") not in ("healthy", "measured") or other.get("state") not in ("healthy", "measured"):
        return {"field": "state", "left": baseline.get("state"), "right": other.get("state")}
    if baseline["suite"].get("profile_hash") != other["suite"].get("profile_hash"):
        return {"field": "profile_hash", "left": baseline["suite"].get("profile_hash"), "right": other["suite"].get("profile_hash")}
    both_representative = baseline.get("representative") is True and other.get("representative") is True
    left_projection = dict(baseline.get("projection") or {})
    right_projection = dict(other.get("projection") or {})
    if both_representative:
        left_projection.pop("load_bucket", None)
        right_projection.pop("load_bucket", None)
    if left_projection != right_projection:
        return {"field": "projection", "left": left_projection, "right": right_projection}
    if not both_representative and baseline.get("concurrency") != other.get("concurrency"):
        return {"field": "concurrency", "left": baseline.get("concurrency"), "right": other.get("concurrency")}
    fingerprint = _fingerprint_reason(_result_fingerprint(store, baseline["suite"]), _result_fingerprint(store, other["suite"]))
    if fingerprint:
        return fingerprint
    return _suite_context_reason(store, baseline, other)


def _suite_context_reason(store: CoreStore, baseline: dict[str, Any], other: dict[str, Any]) -> dict[str, Any] | None:
    left_id = baseline.get("benchmark_result_id")
    right_id = other.get("benchmark_result_id")
    if not isinstance(left_id, str) or not isinstance(right_id, str):
        return None
    try:
        left = store.get_fact("benchmark_result", left_id)["payload"]
        right = store.get_fact("benchmark_result", right_id)["payload"]
    except ContractError as error:
        if error.code != "not_found":
            raise
        return None
    context = _workload_reason(left, right, _RESULT_CONTEXT) or _workload_reason(left.get("workload") or {}, right.get("workload") or {}, _CONTEXT)
    if context is None:
        return None
    return {"kind": "context", **context}


def _suite_metric_values(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    values = []
    for row in rows:
        metrics = {key: value for key, value in (row.get("metrics") or {}).items() if _finite_number(value) is not None}
        goodput = _finite_number(row.get("goodput_req_per_s"))
        if goodput is not None:
            metrics["goodput_req_per_s"] = goodput
        values.append({"benchmark_result_id": row.get("benchmark_result_id") or row["suite"]["suite_result_id"], "metrics": metrics})
    return values


def _suite_row_claimable(store: CoreStore, row: dict[str, Any]) -> bool:
    benchmark_id = row.get("benchmark_result_id")
    if isinstance(benchmark_id, str):
        try:
            benchmark = store.get_fact("benchmark_result", benchmark_id)["payload"]
        except ContractError as error:
            if error.code != "not_found":
                raise
        else:
            return claimable(benchmark)
    return claimable({**row, "provenance": "measured", "binding": _binding(row, row["suite"])})


def _as_benchmark_view(row: dict[str, Any]) -> dict[str, Any]:
    metrics = dict(row.get("metrics") or {})
    metrics["goodput_req_per_s"] = row.get("goodput_req_per_s")
    return {"benchmark_result_id": row.get("benchmark_result_id") or row["suite"]["suite_result_id"], "metrics": metrics}


_IDENTITY = (
    ("mode", lambda workload: workload.get("mode")),
    ("concurrency", lambda workload: workload.get("concurrency")),
    ("input_tokens", lambda workload: workload.get("input_tokens")),
    ("output_tokens", lambda workload: workload.get("output_tokens")),
    ("temperature", lambda workload: (workload.get("generation") or {}).get("temperature")),
    ("top_p", lambda workload: (workload.get("generation") or {}).get("top_p")),
)
def _benchmark_branch(store: CoreStore, results: list[dict[str, Any]]) -> dict[str, Any]:
    baseline = results[0]
    context = None
    for other in results[1:]:
        reason = _benchmark_reason(store, baseline, other)
        if reason and reason["kind"] == "fork":
            return {"comparable": False, "claimable": False, "reason": reason["reason"], "summary": f"不可比：{reason['reason']['field']} 不同。"}
        if reason and context is None:
            context = reason["reason"]
    if context:
        return {
            "comparable": True,
            "claimable": False,
            "reason": context,
            "values": _metric_values(results),
            "summary": f"负载身份相同，{context['field']} 不同。数字并列，这次比较不可签字。",
        }
    if any(item.get("measurement") and (item["measurement"].get("status") != "complete" or
            not item["measurement"].get("dataset_input_sha256") or
            (item["measurement"].get("cache_policy") or {}).get("mode") != "disabled" or
            (item.get("workload") or {}).get("mode") != "closed_loop" or
            ((item["measurement"].get("acceptance") or {}).get("schema_version") == 2 and
             (item["measurement"].get("request_slo_status") != "complete" or item["measurement"].get("slo",{}).get("passed") is None))) for item in results):
        return {"comparable": True, "claimable": False, "summary": "有实际测量，但输入身份或受管缓存关闭证据不足，不签公平比较。"}
    if not all(claimable(item) for item in results):
        return {"comparable": True, "claimable": False, "summary": "负载与指纹相同，这次比较不可签字。"}
    return {"comparable": True, "claimable": True, "summary": ""}


def _benchmark_reason(store: CoreStore, baseline: dict[str, Any], other: dict[str, Any]) -> dict[str, Any] | None:
    left_binding = baseline.get("binding", "bound")
    right_binding = other.get("binding", "bound")
    if left_binding != right_binding:
        return {"kind": "fork", "reason": {"field": "binding", "left": left_binding, "right": right_binding}}
    for field, getter in (
        ("model_id", lambda item: (item.get("model_ref") or {}).get("model_id")),
        ("revision", lambda item: (item.get("model_ref") or {}).get("revision")),
        ("runtime_kind", lambda item: (item.get("runtime_spec") or {}).get("runtime_kind")),
    ):
        left = getter(baseline)
        right = getter(other)
        if left != right:
            return {"kind": "fork", "reason": {"field": field, "left": left, "right": right}}
    identity = _workload_reason(baseline.get("workload") or {}, other.get("workload") or {}, _IDENTITY)
    if identity:
        return {"kind": "fork", "reason": identity}
    fingerprint = _fingerprint_reason(_result_fingerprint(store, baseline), _result_fingerprint(store, other))
    if fingerprint:
        return {"kind": "fork", "reason": fingerprint}
    context = _workload_reason(baseline, other, _RESULT_CONTEXT) or _workload_reason(baseline.get("workload") or {}, other.get("workload") or {}, _CONTEXT)
    if context:
        return {"kind": "context", "reason": context}
    return None


def _workload_reason(left_workload: dict[str, Any], right_workload: dict[str, Any], fields) -> dict[str, Any] | None:
    for field, getter in fields:
        left = getter(left_workload)
        right = getter(right_workload)
        if left != right:
            return {"field": field, "left": left, "right": right}
    return None


def _result_fingerprint(store: CoreStore, result: dict[str, Any]) -> dict[str, Any] | None:
    """Bound reads the snapshot. Declared uses its own client fingerprint."""
    if result.get("binding") == "declared":
        raw = result.get("hardware_fingerprint")
        if not isinstance(raw, dict):
            return None
        fields = ("family", "gpu_count", "vram_gib", "gpu_arch")
        if any(key not in raw for key in fields):
            return None
        return {key: raw[key] for key in fields}
    snapshot_id = result.get("hardware_snapshot_id")
    if not isinstance(snapshot_id, str) or not snapshot_id:
        return None
    try:
        snapshot = store.get_fact("hardware_snapshot", snapshot_id)["payload"]
    except ContractError as error:
        if error.code != "not_found":
            raise
        return None
    return card_fingerprint(snapshot.get("gpus") or [])


def _fingerprint_reason(left: dict[str, Any] | None, right: dict[str, Any] | None) -> dict[str, Any] | None:
    if left is None or right is None:
        return {"field": "hardware_fingerprint", "left": left, "right": right}
    for field in ("family", "gpu_count", "vram_gib", "gpu_arch"):
        if left[field] != right[field]:
            return {"field": field, "left": left[field], "right": right[field]}
    return None


def _metric_values(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    values = []
    for item in results:
        metrics = {key: value for key, value in (item.get("metrics") or {}).items() if _finite_number(value) is not None}
        values.append({"benchmark_result_id": item.get("benchmark_result_id"), "metrics": metrics})
    return values


def _binding(row: dict[str, Any], suite: dict[str, Any]) -> str:
    binding = row.get("binding", suite.get("binding", "bound"))
    return binding if isinstance(binding, str) else "bound"


def _compute_deltas(baseline: dict[str, Any], others: list[dict[str, Any]], objective: str | None) -> dict[str, Any]:
    baseline_metrics = {key: value for key, value in baseline.get("metrics", {}).items() if _finite_number(value) is not None}
    shared = sorted(set(baseline_metrics) & set().union(*(set(other.get("metrics", {})) for other in others)))
    if objective:
        if objective not in baseline_metrics:
            raise ContractError(
                "invalid_input",
                f"objective {objective} 不在基准实测指标中。",
                {"objective": objective, "available": sorted(baseline_metrics)},
                remediation="objective 必须是 BenchmarkResult.metrics 中已存在的指标。",
            )
    else:
        objective = "requests_per_second" if "requests_per_second" in baseline_metrics else ("output_tokens_per_second" if "output_tokens_per_second" in baseline_metrics else (shared[0] if shared else None))
        if objective is None:
            raise ContractError("invalid_input", "实测结果没有可比较的数值指标。", {})

    base_value = _finite_number(baseline_metrics.get(objective))
    if base_value is None:
        raise ContractError("invalid_input", f"objective {objective} 的基线值不是有限数值。", {"objective": objective})
    if base_value == 0:
        raise ContractError(
            "invalid_input",
            f"objective {objective} 的基线值为 0，百分比变化无定义。",
            {"objective": objective, "baseline_value": base_value},
            remediation="选择非零基线，或只报告绝对值而不计算 delta_percent。",
        )
    direction = "lower_better" if any(token in objective.lower() for token in ("latency", "ttft", "tpot", "itl")) else "higher_better"
    deltas: list[dict[str, Any]] = []
    for other in others:
        other_value = _finite_number((other.get("metrics") or {}).get(objective))
        if other_value is None:
            raise ContractError(
                "invalid_input",
                f"BenchmarkResult {other.get('benchmark_result_id')} 缺少可用 objective 指标 {objective}。",
                {"objective": objective, "benchmark_result_id": other.get("benchmark_result_id")},
                remediation="只比较都包含同一有限数值指标的 BenchmarkResult。",
            )
        percent = (other_value - base_value) / base_value * 100
        effective_percent = -percent if direction == "lower_better" else percent
        deltas.append(
            {
                "benchmark_result_id": other["benchmark_result_id"],
                "objective_metric": objective,
                "baseline_value": base_value,
                "measured_value": other_value,
                "delta_percent": round(percent, 2),
                "direction": direction,
                # Comparative labels, deliberately not significance words: this
                # is deterministic arithmetic over summary metrics.
                "verdict": "within_1pct" if abs(percent) < 1 else ("higher" if effective_percent > 0 else "lower"),
            }
        )
    best = max(deltas, key=lambda item: (-item["delta_percent"] if direction == "lower_better" else item["delta_percent"]))
    summary = (
        f"以 {objective} 为目标的确定性数值比较（非显著性检验，阈值 ±1%）："
        f"{best['benchmark_result_id']} 为 {best['measured_value']}，较基线 {best['baseline_value']}"
        f" 差 {best['delta_percent']:+.2f}%，verdict={best['verdict']}。"
    )
    return {"objective": objective, "deltas": deltas, "summary": summary}


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None
