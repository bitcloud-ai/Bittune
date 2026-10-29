"""Suite entry. One call, one intent.

Stage 1 implements ``performance_sweep``. The other three intents land in later
stages and are rejected here until then, rather than half-running.
"""

from __future__ import annotations

import json
import time
import urllib.request
import uuid
from typing import Any

import bittune_core.benchmark as benchmark_api
from bittune_core.benchmark import execute_workload, resolve_measure_subject, subject_fact_fields
from bittune_core.contracts import (
    EARLY_STOP_FORMULA_VERSION,
    SLO_JUDGEMENT_VERSION,
    SUITE_ROW_STATES,
    SUITE_SCHEMA_VERSION,
    ContractError,
)
from bittune_core.plans import resolve_model_snapshot
from bittune_core.process import run_command
from bittune_core.runs import ManagedRun
from bittune_core.store import CoreStore, utc_now
from bittune_core.suite_profiles import load_profile, project_scenario
from bittune_core.suite_policy import decide
from bittune_core.measurement import MeasurementBuilder

_HEALTHY_METRICS = (
    "requests_per_second",
    "output_tokens_per_second",
    "success_rate",
    "p99_e2e_latency_ms",
    "p99_ttft_ms",
    "p50_ttft_ms",
)


def benchmark_suite(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    intent = params.get("intent")
    if intent == "correctness":
        from bittune_core.correctness import run_correctness

        return run_correctness(params, context)
    if intent == "pd_planning":
        from bittune_core.pd_capacity import run_pd_planning

        return run_pd_planning(params, context)
    if intent == "cache_pair":
        from bittune_core.cache_pair import run_cache_pair

        return run_cache_pair(params, context)
    if intent != "performance_sweep":
        raise ContractError("invalid_input", "benchmark_suite 本阶段不接受这个 intent。", {"intent": intent})
    store: CoreStore = context["store"]
    cancellation = context["cancellation"]
    with ManagedRun(store, "benchmark_suite", params, context["session_id"], context) as run:
        profile = load_profile(params.get("profile_path"))
        profile_artifact = run.artifact("suite-profile", json.dumps({"registry": profile["registry"], "acceptance": profile["acceptance"], "profile_hash": profile["profile_hash"]}, ensure_ascii=False, sort_keys=True), "application/json")
        profile["artifact_id"] = profile_artifact["artifact_id"]
        service = _ready_managed(store, params, cancellation)
        provider_version = _evalscope_version(run, cancellation)
        package = params.get("package") or "short"
        if package not in ("short", "full"):
            raise ContractError("invalid_input", "package 只能是 short 或 full。", {})
        points = _selected_points(profile, package, bool(params.get("destructive_authorized")))
        if _smoke_blocked(service, cancellation, run):
            rows = [_row(point, "environment_blocked", "smoke_failed", "流式或非流式探活失败，未开始扫描。") for point in points]
            return _finish(store, run, profile, service, rows, None)
        memory_floor = profile["registry"].get("min_free_memory_bytes")
        if isinstance(memory_floor, int) and not _memory_ok(memory_floor, cancellation):
            rows = [_row(point, "environment_blocked", "memory_floor", "空闲显存低于档案门槛，未开始扫描。") for point in points]
            return _finish(store, run, profile, service, rows, None)
        rows, artifact = _sweep(points, profile, service, provider_version, store, run, cancellation)
        return _finish(store, run, profile, service, rows, artifact)


def _ready_managed(store: CoreStore, params: Any, cancellation: Any) -> dict[str, Any]:
    return resolve_measure_subject(params, store, cancellation)


def _evalscope_version(run: ManagedRun, cancellation: Any) -> str:
    version = run_command(["evalscope", "--version"], timeout_seconds=15, cancellation=cancellation)
    text = version["stdout"].strip()
    run.artifact("evalscope-preflight", f"{version['stdout']}\n{version['stderr']}")
    if version["exit_code"] != 0 or not text:
        raise ContractError(
            "evalscope_unavailable",
            "EvalScope 不可用：`evalscope --version` 无法执行或没有版本输出。",
            {"exit_code": version["exit_code"]},
        )
    return text


def _selected_points(profile: dict[str, Any], package: str, authorized: bool) -> list[dict[str, Any]]:
    registry = profile["registry"]
    adaptive = registry.get("concurrency_mode") == "adaptive"
    points: list[dict[str, Any]] = []
    for scenario in registry["scenarios"]:
        if adaptive:
            point = {**scenario, "concurrency": registry["min_probe"], "adaptive": True, "max_probe": registry["max_probe"]}
            if scenario.get("destructive") and not authorized:
                point["prestate"] = "not_selected"
            points.append(point)
            continue
        for concurrency in scenario["concurrency"]:
            point = {**scenario, "concurrency": concurrency}
            if scenario.get("destructive") and not authorized:
                point["prestate"] = "not_selected"
            points.append(point)
    if package == "full":
        stability = registry.get("stability")
        if isinstance(stability, dict):
            declared = next((item for item in registry["scenarios"] if item["scenario_id"] == stability["scenario_id"]), None)
            if declared is None:
                raise ContractError("invalid_profile", "稳定性段指向的场景不在档案里。", {"scenario_id": stability.get("scenario_id")})
            for index in range(int(stability["repeats"])):
                point = {**declared, "concurrency": stability["concurrency"], "request_count": stability["request_count"], "repeat": index + 1}
                point.pop("adaptive", None)
                point.pop("max_probe", None)
                if declared.get("destructive") and not authorized:
                    point["prestate"] = "not_selected"
                points.append(point)
    return points


def smoke_chat(endpoint: str, model: str, stream: bool, timeout: float = 10) -> bool:
    """One minimal chat. Status only: a streaming body is not parsed."""
    payload = json.dumps({"model": model, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 1, "temperature": 0, "stream": stream}).encode()
    request = urllib.request.Request(f"{endpoint}/v1/chat/completions", data=payload, headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status == 200
    except Exception:  # noqa: BLE001
        return False


def _smoke_blocked(service: dict[str, Any], cancellation: Any, run: ManagedRun) -> bool:
    model = (service.get("model_ref") or {}).get("model_id", "")
    failures = [f"stream={stream}" for stream in (False, True) if not smoke_chat(service["endpoint"], model, stream)]
    run.artifact("suite-smoke", json.dumps({"failures": failures}, ensure_ascii=False), "application/json")
    return bool(failures)


def _signal_killed(outcome: dict[str, Any]) -> bool:
    code = outcome.get("exit_code")
    return outcome.get("kind") == "process_failed" and isinstance(code, int) and not isinstance(code, bool) and code < 0


def _gpus_present(service: dict[str, Any], cancellation: Any) -> bool:
    try:
        result = run_command(["nvidia-smi", "--query-gpu=index", "--format=csv,noheader"], timeout_seconds=10, cancellation=cancellation)
    except ContractError:
        return False
    if result["exit_code"] != 0:
        return False
    indexes = [int(line.split(",")[0].strip()) for line in result["stdout"].splitlines() if line.split(",")[0].strip().isdigit()]
    wanted = (service.get("serving_spec") or {}).get("gpu_device_ids") or []
    if wanted:
        return all(isinstance(index, int) and not isinstance(index, bool) and index in indexes for index in wanted)
    return bool(indexes)


def _safety_block(service: dict[str, Any], cancellation: Any) -> tuple[str, str] | None:
    if not benchmark_api._endpoint_ready(service.get("endpoint"), cancellation):
        return ("service_not_ready", "服务在档位之间不再 ready，本档未发送请求。")
    if not _gpus_present(service, cancellation):
        return ("gpu_missing", "nvidia-smi 看不到卡，本档未发送请求。")
    return None


def _memory_ok(floor: int, cancellation: Any) -> bool:
    result = run_command(["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"], timeout_seconds=10, cancellation=cancellation)
    if result["exit_code"] != 0:
        return False
    free = []
    for line in result["stdout"].splitlines():
        try:
            free.append(int(line.strip()) * 1024 * 1024)
        except ValueError:
            continue
    return bool(free) and max(free) >= floor


def _context_limit(service: dict[str, Any]) -> int | None:
    spec = service.get("serving_spec") or {}
    for key in ("max_model_len", "context_length"):
        value = spec.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            return value
    return None


def _sweep(points, profile, service, provider_version, store, run, cancellation) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    rows: list[dict[str, Any]] = []
    healthy_by_scenario: dict[str, list[dict[str, Any]]] = {}
    safety_stopped: set[str] = set()
    early_stopped: set[str] = set()
    context_stopped: set[str] = set()
    stops: list[dict[str, Any]] = []
    limit = _context_limit(service)
    model_ref = service.get("model_ref") or {}
    tokenizer = resolve_model_snapshot(model_ref.get("model_id", ""), model_ref.get("revision", ""), model_ref.get("local_path"), cancellation)
    if tokenizer is None:
        raise ContractError("model_snapshot_missing", "本地缺少模型快照，无法扫描。")
    acceptance = profile["acceptance"]
    candidates: list[dict[str, Any]] = []
    modern = acceptance["schema_version"] == 2
    budget = profile["registry"].get("budget") or {}
    started = time.monotonic()
    used_requests = used_points = 0
    occurrences = {}
    index = 0
    while index < len(points):
        point = points[index]
        index += 1
        scenario_id = point["scenario_id"]
        if modern:
            key = (scenario_id, point["concurrency"])
            occurrences[key] = occurrences.get(key, 0) + 1
            point = {**point, "repeat": occurrences[key]}
            artifact_bytes = sum(ref.get("size_bytes", 0) for ref in run.artifact_refs)
            exhausted = (used_points >= budget["max_points"] or used_requests + point["request_count"] > budget["max_requests"] or
                         time.monotonic()-started >= budget["max_duration_seconds"] or artifact_bytes >= budget["max_artifact_bytes"])
            if exhausted:
                rows.append(_row(point, "not_run_budget", "budget_exhausted", "冻结预算不足，未开始本档；不截断已产生的证据。"))
                continue
        if point.get("prestate") == "not_selected":
            rows.append(_row(point, "not_selected", "destructive_not_authorized", "破坏性场景未授权，未发送请求。"))
            continue
        if scenario_id in safety_stopped:
            rows.append(_row(point, "not_run_safety_stop", "safety_stop", "同一场景因安全事件停止，本档未跑。"))
            continue
        if scenario_id in early_stopped:
            rows.append(_row(point, "not_run_early_stop", "early_stop", "连续两档成功率跌破且有效吞吐下降，后续档未跑。"))
            continue
        if scenario_id in context_stopped:
            rows.append(_row(point, "not_run_context_limit", "context_limit", "同一场景更早的档已超过上下文长度，本档未跑。"))
            continue
        if limit is not None and point["input_tokens"] + point["output_tokens"] > limit:
            rows.append(_row(point, "unsupported_context_length", "context_too_long", "输入加输出超过服务上下文长度，未发送请求。"))
            context_stopped.add(scenario_id)
            _note_adaptive(point, rows[-1], points, candidates, early_stopped)
            continue
        blocked = _safety_block(service, cancellation)
        if blocked:
            rows.append(_row(point, "not_run_safety_stop", blocked[0], blocked[1]))
            safety_stopped.add(scenario_id)
            _note_adaptive(point, rows[-1], points, candidates, early_stopped)
            continue
        workload = _workload_input(point)
        used_points += 1
        used_requests += point["request_count"]
        outcome = execute_workload(
            workload,
            service=service,
            model_ref=model_ref,
            provider_version=provider_version,
            tokenizer_path=tokenizer["host_path"],
            store=store,
            run=run,
            cancellation=cancellation,
            record_gpu_samples=_is_stability_point(point),
            acceptance=acceptance,
            prefix_length=point.get("prefix_length", 0),
        )
        samples_artifact = _memory_samples_artifact(run, outcome)
        if not outcome["ok"]:
            if _signal_killed(outcome):
                rows.append(_row(point, "not_run_safety_stop", "process_killed", "这一档进程被信号终止，同一场景后续档未跑。"))
                safety_stopped.add(scenario_id)
            else:
                rows.append(_row(point, "invalid_measurement", outcome["kind"], "这一档没有得到完整测量。"))
            if modern:
                rows[-1].update(decision="stop", decision_reason="invalid_measurement")
                early_stopped.add(scenario_id)
            _attach_samples(rows[-1], samples_artifact)
            _note_adaptive(point, rows[-1], points, candidates, early_stopped)
            continue
        if modern and (not outcome.get("measurement") or outcome["measurement"]["status"] != "complete"):
            rows.append(_row(point, "invalid_measurement", "contract_missing", "缺少完整的版本化measurement契约。"))
            early_stopped.add(scenario_id)
            continue
        benchmark = _write_benchmark(store, run, service, outcome)
        if modern:
            measurement = outcome.get("measurement")
            judgement = measurement["slo"]
            row = _row(point, "measured", "ok", "测量完整；SLO结果和扫描决定单独列出。")
            row.update(benchmark_result_id=benchmark["benchmark_result_id"], workload_hash=outcome["workload_hash"],
                       output_tokens=point["output_tokens"], metrics=measurement["metrics"], measurement=measurement,
                       measurement_status="complete", slo=judgement, slo_status=judgement["status"],
                       request_slo_status=measurement.get("request_slo_status"),
                       goodput_req_per_s=measurement["metrics"]["goodput_req_per_s"])
            previous = healthy_by_scenario.setdefault(scenario_id, [])
            decision, reason = decide(previous, row, acceptance)
            row.update(decision=decision, decision_reason=reason)
            _attach_samples(row, samples_artifact)
            rows.append(row); previous.append(row)
            candidates.append({"scenario_id": scenario_id, "concurrency": point["concurrency"], "repeat": point["repeat"], "decision": decision, "reason": reason})
            if decision == "confirm":
                points.insert(index, {**point, "confirmation": True})
            elif decision == "stop":
                early_stopped.add(scenario_id)
            elif point.get("adaptive"):
                nxt = point["concurrency"] * 2
                if nxt <= point["max_probe"]:
                    points.append({**point, "concurrency": nxt})
            continue
        judgement = _judge(outcome["metrics"], acceptance)
        row = _row(point, "healthy", "ok", "测量完整。")
        row.update({
            "benchmark_result_id": benchmark["benchmark_result_id"],
            "workload_hash": outcome["workload_hash"],
            "output_tokens": point["output_tokens"],
            "metrics": {name: outcome["metrics"].get(name) for name in _HEALTHY_METRICS},
            "slo": judgement,
            "goodput_req_per_s": None,
            "legacy_slo_passed_rps": outcome["metrics"]["requests_per_second"] if judgement["passed"] else None,
            "goodput_unavailable_reason": "legacy profile has no request SLO; point-gated RPS is not goodput",
        })
        _attach_samples(row, samples_artifact)
        rows.append(row)
        previous = healthy_by_scenario.setdefault(scenario_id, [])
        if _should_stop(previous, row):
            stops.append({
                "formula": EARLY_STOP_FORMULA_VERSION,
                "scenario_id": scenario_id,
                "previous_benchmark_result_id": previous[-1].get("benchmark_result_id"),
                "benchmark_result_id": row.get("benchmark_result_id"),
                "previous_concurrency": previous[-1]["concurrency"],
                "concurrency": row["concurrency"],
                "previous_success_rate": previous[-1]["metrics"]["success_rate"],
                "success_rate": row["metrics"]["success_rate"],
                "previous_requests_per_second": previous[-1]["metrics"]["requests_per_second"],
                "requests_per_second": row["metrics"]["requests_per_second"],
                "second_signal": "requests_per_second",
                "note": "goodput 在 SLO 未过时为空，第二信号用 requests_per_second，不把空值当成 0。",
            })
            early_stopped.add(scenario_id)
            previous.append(row)
            _note_adaptive(point, row, points, candidates, early_stopped)
            continue
        previous.append(row)
        _note_adaptive(point, row, points, candidates, early_stopped)
    if candidates:
        run.artifact("adaptive-candidates", json.dumps({"version": "bounded-confirm-v2" if modern else EARLY_STOP_FORMULA_VERSION, "candidates": candidates}, ensure_ascii=False), "application/json")
    artifact = None
    if stops:
        artifact = run.artifact(
            "early-stop",
            json.dumps({"formula": EARLY_STOP_FORMULA_VERSION, "stops": stops}, ensure_ascii=False),
            "application/json",
        )
    return rows, artifact


def _is_stability_point(point: dict[str, Any]) -> bool:
    repeat = point.get("repeat")
    return isinstance(repeat, int) and not isinstance(repeat, bool)


def _memory_samples_artifact(run: ManagedRun, outcome: dict[str, Any]) -> dict[str, Any] | None:
    series = outcome.get("gpu_memory_samples")
    if not isinstance(series, dict):
        return None
    return run.artifact("gpu-memory-samples", json.dumps(series, ensure_ascii=False), "application/json")


def _attach_samples(row: dict[str, Any], artifact: dict[str, Any] | None) -> None:
    if artifact is not None:
        row["gpu_memory_samples_artifact_id"] = artifact["artifact_id"]


def _should_stop(previous: list[dict[str, Any]], current: dict[str, Any]) -> bool:
    """The latest two healthy rungs are both under the success floor and goodput fell.

    Goodput is null when the rung missed SLO, so the comparison uses request
    throughput. One signal is not enough.
    """
    if not previous or current["slo"]["success_rate_pass"] is not False or previous[-1]["slo"]["success_rate_pass"] is not False:
        return False
    previous_rate = previous[-1]["metrics"]["requests_per_second"]
    current_rate = current["metrics"]["requests_per_second"]
    return isinstance(previous_rate, (int, float)) and isinstance(current_rate, (int, float)) and current_rate < previous_rate


def _note_adaptive(point, row, points, candidates, early_stopped) -> None:
    if not point.get("adaptive") or point.get("prestate") == "not_selected":
        return
    scenario_id = point["scenario_id"]
    if row["state"] != "healthy":
        reason = "safety_stop" if row["state"] == "not_run_safety_stop" else "no_healthy_anchor"
        candidates.append({"scenario_id": scenario_id, "concurrency": point["concurrency"], "next": None, "reason": reason})
        return
    if scenario_id in early_stopped:
        candidates.append({"scenario_id": scenario_id, "concurrency": point["concurrency"], "next": None, "reason": "early_stop"})
        return
    nxt = point["concurrency"] * 2
    if nxt <= point["max_probe"]:
        points.append({**point, "concurrency": nxt})
        candidates.append({"scenario_id": scenario_id, "concurrency": point["concurrency"], "next": nxt, "reason": "healthy_times_two"})
    else:
        candidates.append({"scenario_id": scenario_id, "concurrency": point["concurrency"], "next": None, "reason": "at_max_probe"})


def _judge(metrics: dict[str, Any], acceptance: dict[str, Any]) -> dict[str, Any]:
    success_pass = metrics["success_rate"] >= acceptance["success_rate_min"]
    e2e_pass = metrics["p99_e2e_latency_ms"] <= acceptance["p99_e2e_latency_ms_max"]
    ttft_pass = metrics["p99_ttft_ms"] <= acceptance["p99_ttft_ms_max"]
    return {
        "version": SLO_JUDGEMENT_VERSION,
        "passed": success_pass and e2e_pass and ttft_pass,
        "success_rate_pass": success_pass,
        "p99_e2e_pass": e2e_pass,
        "p99_ttft_pass": ttft_pass,
    }


def _write_benchmark(store: CoreStore, run: ManagedRun, service: dict[str, Any], outcome: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "schema_version": 2,
        "benchmark_result_id": f"bench-{uuid.uuid4()}",
        **subject_fact_fields(service),
        "workload": outcome["workload"],
        "workload_hash": outcome["workload_hash"],
        "metrics": outcome["metrics"],
        "metric_distributions": outcome["distributions"],
        "metric_normalizer_version": outcome["normalizer_version"],
        "request_samples_available": outcome["request_samples_available"],
        **({"measurement": outcome["measurement"]} if "measurement" in outcome else {}),
        **({"request_evidence": outcome["request_evidence"]} if "request_evidence" in outcome else {}),
        "observed_gpu_memory_peak_bytes": outcome["observed_gpu_memory_peak_bytes"],
        "provider": {"name": "evalscope", "version": outcome["provider_version"]},
        "summary_artifact_id": outcome["summary_artifact"]["artifact_id"],
        "artifact_ids": outcome.get("artifact_ids", []),
        "measured_at": utc_now(),
        "provenance": "measured",
    }
    if service.get("binding") != "declared":
        plan_id = service.get("plan_id")
        plan = store.get_fact("deployment_plan", plan_id)["payload"] if plan_id else None
        payload["plan_id"] = plan_id
        payload["hardware_snapshot_id"] = (plan or {}).get("hardware_snapshot_id")
    store.put_benchmark_result(payload, run.run_id)
    return payload


def _workload_input(point: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": 2,
        "mode": "closed_loop",
        "concurrency": point["concurrency"],
        "request_count": point["request_count"],
        "input_tokens": point["input_tokens"],
        "output_tokens": point["output_tokens"],
        "stream": point.get("stream", True),
        "ignore_eos": point.get("ignore_eos", True),
        "temperature": point.get("temperature", 0),
        "top_p": point.get("top_p", 1),
        "seed": point.get("seed", 0),
        "warmup_requests": point.get("warmup_requests", 1),
        "request_timeout_seconds": point.get("request_timeout_seconds", 120),
    }


def _row(point: dict[str, Any], state: str, reason_code: str, reason_detail: str) -> dict[str, Any]:
    if state not in SUITE_ROW_STATES:
        raise ContractError("invalid_input", f"未知行状态 {state}。")
    payload = {
        "scenario_id": point["scenario_id"],
        "projection": project_scenario(point["scenario_id"], point["input_tokens"], point["output_tokens"], point["concurrency"], point.get("scenario")),
        "concurrency": point["concurrency"],
        "state": state,
        "reason_code": reason_code,
        "reason_detail": reason_detail,
        "planned_input_tokens": point.get("input_tokens"),
        "planned_output_tokens": point.get("output_tokens"),
        "planned_request_count": point.get("request_count"),
    }
    if point.get("representative") is True:
        payload["representative"] = True
    repeat = point.get("repeat")
    if isinstance(repeat, int) and not isinstance(repeat, bool):
        payload["repeat"] = repeat
    return payload


def _finish(store, run, profile, service, rows, early_artifact) -> dict[str, Any]:
    binding = service.get("binding", "bound")
    for row in rows:
        row["binding"] = binding
        if profile['acceptance']['schema_version'] == 2 and not row.get('measurement'):
            absent = MeasurementBuilder(profile['acceptance']).finish({}, 'absent')
            absent['unavailable_reasons'] = {key: row['reason_detail'] for key in absent['metrics']}
            absent['unavailable_fields'] = sorted(absent['metrics'])
            row.update(measurement=absent, metrics=absent['metrics'], measurement_status='not_run' if row['state'].startswith('not_') or row['state'] in ('unsupported_context_length','not_selected','environment_blocked') else 'invalid',
                       slo_status='not_evaluated', request_slo_status='not_evaluated', goodput_req_per_s=None)
    payload = {
        "schema_version": 2 if profile["acceptance"]["schema_version"] == 2 else SUITE_SCHEMA_VERSION,
        "suite_result_id": f"suite-{uuid.uuid4()}",
        "profile_id": profile["profile_id"],
        "profile_hash": profile["profile_hash"],
        "profile_artifact_id": profile.get("artifact_id"),
        "suite_policy_version": "bounded-confirm-v2" if profile["acceptance"]["schema_version"] == 2 else EARLY_STOP_FORMULA_VERSION,
        "acceptance": profile["acceptance"],
        "budget": profile["registry"].get("budget"),
        **subject_fact_fields(service),
        "rows": rows,
        "early_stop_artifact_id": None if early_artifact is None else early_artifact["artifact_id"],
        "created_at": utc_now(),
        "provenance": "derived",
    }
    if service.get("binding") != "declared":
        plan_id = service.get("plan_id")
        plan = store.get_fact("deployment_plan", plan_id)["payload"] if plan_id else None
        payload["hardware_snapshot_id"] = (plan or {}).get("hardware_snapshot_id")
    store.put_suite_result(payload, run.run_id)
    healthy = sum(1 for row in rows if row["state"] in ("healthy", "measured"))
    return run.success(
        f"短扫描完成：{len(rows)} 行，其中 {healthy} 行测量完整。",
        {"suite_result": payload},
    )
