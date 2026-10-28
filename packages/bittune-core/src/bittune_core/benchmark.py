"""Normalized benchmarking: workload freeze, EvalScope execution, metrics.

A BenchmarkResult only exists for a ready managed service with a frozen,
hashed workload. Everything else - missing tooling, warmup failure, a
non-ready service, provider errors - leaves only Run/Artifact evidence and
never a Canonical measurement. Metrics come from the EvalScope raw reports
through the deterministic normalizer; the Core never invents numbers.
"""

import json
import math
import re
import threading
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from bittune_core.contracts import GPU_ARCH_BY_CAPABILITY, ContractError, canonical_json, sha256_canonical
from bittune_core.gpu_product import gpu_product
from bittune_core.plans import resolve_model_snapshot
from bittune_core.process import run_command
from bittune_core.metric_stats import _percentile, _statistics
from bittune_core.measurement import cache_context, validate_acceptance, validate_measurement
from bittune_core.request_evidence import collect_request_evidence
from bittune_core.runs import ManagedRun
from bittune_core.store import CoreStore, utc_now

WORKLOAD_SCHEMA_VERSION = 2
ARGV_PROFILE_VERSION = "evalscope-perf-openai-random-v3"
METRIC_NORMALIZER_VERSION = "evalscope-normalizer-v6"
_EXECUTE_KINDS = ("warmup_failed", "process_failed", "no_metrics", "timed_out_partial")

OFFLINE_ENV = {
    "HF_HUB_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
    "HF_DATASETS_OFFLINE": "1",
    "HF_HUB_DISABLE_TELEMETRY": "1",
}


_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def resolve_measure_subject(params: dict[str, Any], store: CoreStore, cancellation: Any) -> dict[str, Any]:
    """The one subject check for a single benchmark and a suite.

    A service id is bound and keeps the managed plus ready checks. An endpoint
    is declared and must be loopback. Both or neither is invalid_input. Core
    does not read an approved flag; the Runtime dialog is the only confirmation.
    """
    if not isinstance(params, dict) or "approved" in params:
        raise ContractError("invalid_input", "测量对象只能是受管服务或回环端点之一。确认不能作为参数传入。")
    endpoint = params.get("endpoint")
    if isinstance(endpoint, dict) and "approved" in endpoint:
        raise ContractError("invalid_input", "确认不能作为参数传入。")
    has_service = params.get("service_instance_id") is not None
    has_endpoint = endpoint is not None
    if has_service == has_endpoint:
        raise ContractError("invalid_input", "测量对象只能是受管服务或回环端点之一。")
    if has_endpoint:
        return _declared_subject(endpoint, store)
    return _bound_subject(params.get("service_instance_id"), store, cancellation)


def _bound_subject(service_id: Any, store: CoreStore, cancellation: Any) -> dict[str, Any]:
    if not isinstance(service_id, str) or not service_id.startswith("service-"):
        raise ContractError("invalid_input", "benchmark 需要受管服务的 service_instance_id。")
    service = dict(store.get_fact("service_instance", service_id)["payload"])
    if service.get("ownership") != "managed":
        raise ContractError("service_not_managed", f"服务 {service_id} 不是 managed 服务，不能压测。", {"ownership": service.get("ownership")})
    if service.get("observed_state") != "ready" or not _endpoint_ready(service.get("endpoint"), cancellation):
        raise ContractError(
            "service_not_ready",
            f"服务 {service_id} 未处于 ready 状态（observed={service.get('observed_state')}）。",
            {"service_instance_id": service_id},
            remediation="用 deploy_service(start) 启动并等待 Ready 后再压测。",
        )
    service["binding"] = "bound"
    return service


def _declared_subject(endpoint: Any, store: CoreStore) -> dict[str, Any]:
    if not isinstance(endpoint, dict):
        raise ContractError("invalid_input", "endpoint 必须是对象。")
    url = _loopback_url(endpoint.get("url"))
    model_id = endpoint.get("model_id")
    if not isinstance(model_id, str) or not model_id:
        raise ContractError("invalid_input", "endpoint.model_id 必须是非空字符串。")
    revision = endpoint.get("revision")
    if revision is not None and not isinstance(revision, str):
        raise ContractError("invalid_input", "endpoint.revision 必须是字符串。")
    record = {"url": url, "model_id": model_id}
    model_ref = {"model_id": model_id}
    if isinstance(revision, str) and revision:
        record["revision"] = revision
        model_ref["revision"] = revision
    service: dict[str, Any] = {
        "binding": "declared",
        "endpoint": url,
        "endpoint_record": record,
        "model_ref": model_ref,
        "runtime_spec": {},
        "serving_spec": {},
    }
    fingerprint = _client_fingerprint(store)
    if fingerprint is not None:
        service["hardware_fingerprint"] = fingerprint
    return service


def _loopback_url(url: Any) -> str:
    if not isinstance(url, str) or not url:
        raise ContractError("invalid_input", "endpoint.url 必须是本机回环地址。")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ContractError("invalid_input", "endpoint.url 只接受 http 或 https。")
    if parsed.username or parsed.password:
        raise ContractError("invalid_input", "endpoint.url 不接受用户信息。")
    host = (parsed.hostname or "").lower()
    if host not in _LOOPBACK_HOSTS:
        raise ContractError("invalid_input", "endpoint.url 的主机只能是 127.0.0.1、localhost 或 ::1。")
    return url


def card_fingerprint(gpus: list[Any]) -> dict[str, Any] | None:
    """Family, count, VRAM floor and arch. Driver and CUDA are not part of this."""
    if not gpus:
        return None
    families = [gpu_product(str(gpu.get("name") or "")) or "" for gpu in gpus]
    arches = []
    vrams = []
    for gpu in gpus:
        arches.append(GPU_ARCH_BY_CAPABILITY.get(str(gpu.get("compute_capability", "")), ""))
        memory = gpu.get("memory_total_bytes") or 0
        if not isinstance(memory, int) or isinstance(memory, bool) or memory <= 0:
            return None
        vrams.append(memory // (1024**3))
    if not all(arches) or len(set(arches)) != 1 or min(vrams) < 1:
        return None
    family = families[0] if len(set(families)) == 1 else ""
    return {"family": family, "gpu_count": len(gpus), "vram_gib": min(vrams), "gpu_arch": arches[0]}


def _client_fingerprint(store: CoreStore) -> dict[str, Any] | None:
    """Four card fields from the latest local snapshot. source=client is the benchmark client, not the service."""
    snapshots = store.list_facts("hardware_snapshot", limit=1)
    if not snapshots:
        return None
    fingerprint = card_fingerprint(snapshots[0]["payload"].get("gpus") or [])
    if fingerprint is None:
        return None
    return {"source": "client", **fingerprint}


def subject_identity_fields(service: dict[str, Any]) -> dict[str, Any]:
    """Binding plus the service id, or the declared endpoint. Declared omits the id."""
    fields: dict[str, Any] = {"binding": service.get("binding", "bound")}
    service_id = service.get("service_instance_id")
    if service.get("binding") != "declared" and isinstance(service_id, str) and service_id:
        fields["service_instance_id"] = service_id
    if service.get("binding") == "declared":
        fields["endpoint"] = service.get("endpoint_record") or {"url": service.get("endpoint")}
        if service.get("hardware_fingerprint"):
            fields["hardware_fingerprint"] = service["hardware_fingerprint"]
    return fields


def subject_fact_fields(service: dict[str, Any]) -> dict[str, Any]:
    """Shared fact fields. A declared subject omits service_instance_id."""
    return {
        **subject_identity_fields(service),
        "model_ref": service.get("model_ref") or {},
        "runtime_spec": service.get("runtime_spec") or {},
        "serving_spec": service.get("serving_spec") or {},
    }


def benchmark_service(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    cancellation = context["cancellation"]
    with ManagedRun(store, "benchmark_service", params, context["session_id"], context) as run:
        if isinstance(params, dict) and params.get("acceptance") is not None:
            validate_acceptance(params["acceptance"])
        service = resolve_measure_subject(params, store, cancellation)
        service_plan_id = service.get("plan_id") if service.get("binding") != "declared" else None

        plan = store.get_fact("deployment_plan", service_plan_id)["payload"] if service_plan_id else None
        hardware_snapshot_id = plan.get("hardware_snapshot_id") if plan else None
        model_ref = service.get("model_ref") or (plan or {}).get("model_ref") or {}

        # EvalScope must be verifiable before GPU time or service state is touched.
        run.progress("校验 EvalScope 可用性…")
        version = run_command(["evalscope", "--version"], timeout_seconds=15, cancellation=cancellation)
        provider_version = version["stdout"].strip()
        run.artifact("evalscope-preflight", f"{version['stdout']}\n{version['stderr']}")
        if version["exit_code"] != 0 or not provider_version:
            raise ContractError(
                "evalscope_unavailable",
                "EvalScope 不可用：`evalscope --version` 无法执行或没有版本输出。",
                {"exit_code": version["exit_code"]},
                remediation="`pip install 'evalscope[perf]==1.10.0'` 后重试；受管服务保持原状。",
            )

        materialize_workload(params.get("workload") or {}, model_ref.get("model_id", ""), provider_version, revision=model_ref.get("revision", ""))
        tokenizer = resolve_model_snapshot(model_ref.get("model_id", ""), model_ref.get("revision", ""), model_ref.get("local_path"), cancellation)
        if tokenizer is None:
            raise ContractError(
                "model_snapshot_missing",
                f"本地缺少模型 {model_ref.get('model_id')}@{model_ref.get('revision')}，EvalScope 无法解析 tokenizer。Core 不隐式下载模型。",
                remediation="Core 不隐式下载模型；用 Bash 准备模型缓存后重试。",
            )
        outcome = execute_workload(
            params.get("workload") or {},
            service=service,
            model_ref=model_ref,
            provider_version=provider_version,
            tokenizer_path=tokenizer["host_path"],
            store=store,
            run=run,
            cancellation=cancellation,
            acceptance=params.get("acceptance"),
        )
        if not outcome["ok"]:
            kind = outcome["kind"]
            if kind == "token_shape_mismatch":
                raise ContractError("benchmark_token_shape_mismatch", "实际 token 数与固定 workload 不符，不生成 BenchmarkResult。", {"request_evidence": outcome["request_evidence"]})
            if kind == "warmup_failed":
                raise ContractError("benchmark_warmup_failed", "固定 warmup 请求存在失败，未开始正式压测。", {"warmup": outcome.get("warmup")})
            if kind == "process_failed":
                raise ContractError(
                    "benchmark_run_failed",
                    f"EvalScope perf 退出码 {outcome.get('exit_code')}。",
                    {"exit_code": outcome.get("exit_code"), "stderr_tail": outcome.get("stderr_tail", "")},
                    remediation="读取 evalscope-cli 与原始报告 Artifact 定位失败原因。",
                )
            if kind == "timed_out_partial":
                raise ContractError(
                    "benchmark_run_failed",
                    "EvalScope 超时且原始报告不完整，不生成 BenchmarkResult。",
                    {"kind": kind},
                )
            raise ContractError(
                "benchmark_no_metrics",
                "原始 EvalScope 报告未识别到有效实测指标，不生成 BenchmarkResult。",
                {"summary_artifact_id": (outcome.get("summary_artifact") or {}).get("artifact_id")},
                remediation="检查 EvalScope 输出格式和 normalizer 版本后重新执行；不要将空结果标记为 measured。",
            )
        workload = outcome["workload"]
        workload_hash = outcome["workload_hash"]
        normalized = {"metrics": outcome["metrics"], "distributions": outcome["distributions"], "normalizer_version": outcome["normalizer_version"], "request_samples_available": outcome["request_samples_available"]}
        peak_bytes = outcome["observed_gpu_memory_peak_bytes"]
        summary_ref = outcome["summary_artifact"]
        warnings = []
        if not normalized["request_samples_available"]:
            warnings.append("原始报告没有逐请求时延样本；比较只能基于汇总指标。")

        benchmark_id = f"bench-{uuid.uuid4()}"
        payload: dict[str, Any] = {
            "schema_version": 2,
            "benchmark_result_id": benchmark_id,
            **subject_fact_fields(service),
            "plan_id": service_plan_id,
            "model_ref": model_ref,
            "hardware_snapshot_id": hardware_snapshot_id,
            "workload": workload,
            "workload_hash": workload_hash,
            "metrics": normalized["metrics"],
            "metric_distributions": normalized["distributions"],
            "metric_normalizer_version": normalized["normalizer_version"],
            "request_samples_available": normalized["request_samples_available"],
            "request_evidence": outcome["request_evidence"],
            "measurement": outcome["measurement"],
            "observed_gpu_memory_peak_bytes": peak_bytes,
            "provider": {"name": "evalscope", "version": provider_version},
            "artifact_ids": [ref["artifact_id"] for ref in run.artifact_refs],
            "summary_artifact_id": summary_ref["artifact_id"],
            "measured_at": utc_now(),
            "provenance": "measured",
        }
        if service.get("binding") == "declared":
            payload.pop("plan_id", None)
            payload.pop("hardware_snapshot_id", None)
        store.put_benchmark_result(payload, run.run_id)
        summary = (
            f"EvalScope 压测完成：{workload['request_count']} 个请求，"
            f"成功率 {normalized['metrics'].get('success_rate', '未知')}，"
            f"RPS {normalized['metrics'].get('requests_per_second', '未知')}。"
        )
        return run.success(summary, {"benchmark_result": payload}, warnings or None)


def execute_workload(
    workload_input: dict[str, Any],
    *,
    service: dict[str, Any],
    model_ref: dict[str, Any],
    provider_version: str,
    tokenizer_path: str,
    store: CoreStore,
    run: ManagedRun,
    cancellation: Any,
    prefix_length: int = 0,
    record_gpu_samples: bool = False,
    acceptance: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One warmup plus one EvalScope perf. Never raises ContractError for a bad run.

    Callers translate ``kind``. ``--version`` is checked by the caller before this.
    """
    if acceptance is not None:
        validate_acceptance(acceptance)
    artifacts_before = len(run.artifact_refs)
    model_id = model_ref.get("model_id", "")
    revision = model_ref.get("revision", "")
    workload = materialize_workload(workload_input, model_id, provider_version, revision=revision, prefix_length=prefix_length)
    workload_hash = sha256_canonical(workload)
    warmup = _run_warmup(service["endpoint"], model_id, workload, cancellation)
    run.artifact(
        "benchmark-workload",
        json.dumps({"workload": workload, "workload_hash": workload_hash, "metric_normalizer_version": METRIC_NORMALIZER_VERSION, "warmup": warmup, "prefix_length": prefix_length}, ensure_ascii=False, indent=2),
        "application/json",
    )
    if warmup["failures"]:
        return {"ok": False, "kind": "warmup_failed", "workload": workload, "workload_hash": workload_hash, "warmup": warmup}

    output_dir = run_scope_dir(store, run) / f"point-{uuid.uuid4()}"
    args = [
        "perf",
        "--url", f"{service['endpoint']}/v1/chat/completions",
        "--api", "openai",
        "--model", model_id,
        "--parallel", str(workload["concurrency"]),
        "--number", str(workload["request_count"]),
        "--enable-progress-tracker",
        "--outputs-dir", str(output_dir),
        "--dataset", "random",
        "--tokenizer-path", tokenizer_path,
        "--max-tokens", str(workload["output_tokens"]),
        "--min-tokens", str(workload["output_tokens"]),
        "--prefix-length", str(prefix_length),
        "--min-prompt-length", str(workload["input_tokens"] - prefix_length),
        "--max-prompt-length", str(workload["input_tokens"] - prefix_length),
        "--tokenize-prompt",
        "--seed", str(workload["request_source"]["seed"]),
        "--temperature", str(workload["generation"]["temperature"]),
        "--top-p", str(workload["generation"]["top_p"]),
        "--extra-args", json.dumps({"ignore_eos": workload["generation"]["ignore_eos"]}),
        "--total-timeout", str(workload["request_timeout_seconds"]),
    ]
    args.append("--stream" if workload["generation"]["stream"] else "--no-stream")
    if workload["mode"] == "open_loop":
        args += ["--open-loop", "--rate", str(workload["request_rate"])]
    run.artifact("benchmark-argv-notes", json.dumps({
        "argv_profile_version": ARGV_PROFILE_VERSION,
        "cli_parameters": {
            "seed": workload["request_source"]["seed"],
            "temperature": workload["generation"]["temperature"],
            "top_p": workload["generation"]["top_p"],
            "stream": workload["generation"]["stream"],
            "ignore_eos": workload["generation"]["ignore_eos"],
            "tokenize_prompt": True,
            "measured_endpoint": "/v1/completions",
        },
        "not_sent": {},
        "seed_scope": "EvalScope dataset RNG and OpenAI request seed",
        "evidence_scope": "CLI configuration; not server acceptance or deterministic output proof",
    }, ensure_ascii=False), "application/json")

    sampler = _GpuSampler(
        service.get("serving_spec", {}).get("gpu_device_ids") or [],
        cancellation,
        record_samples=record_gpu_samples,
    )
    sampler.start()
    run.progress(f"以 {workload['mode']} 模式运行 EvalScope perf（{workload['request_count']} requests）…")
    interrupted: ContractError | None = None
    try:
        result = run_command(
            ["evalscope", *args],
            timeout_seconds=workload["request_timeout_seconds"] + 120,
            max_bytes=2 * 1024 * 1024,
            cancellation=cancellation,
            env=OFFLINE_ENV,
        )
    except ContractError as error:
        if error.code not in ("timeout", "cancelled"):
            raise
        interrupted = error if error.code == "cancelled" else None
        result = {"exit_code": -1, "stdout": "", "stderr": error.message, "timed_out": error.code == "timeout"}
    finally:
        peak_bytes = sampler.stop()

    def with_samples(payload: dict[str, Any]) -> dict[str, Any]:
        payload["artifact_ids"] = [ref["artifact_id"] for ref in run.artifact_refs[artifacts_before:]]
        if record_gpu_samples:
            payload["gpu_memory_samples"] = sampler.series()
        return payload

    run.artifact("evalscope-cli", f"{result['stdout']}\n{result['stderr']}")
    timed_out = bool(result.get("timed_out"))
    collected = _collect_reports(output_dir)
    for name, content in collected["files"]:
        run.artifact(f"evalscope:{name}", content, "application/json")
    normalized = normalize_reports(collected["reports"])
    evidence = collect_request_evidence(
        output_dir, run, workload["request_count"], normalized["metrics"],
        expected_input_tokens=workload["input_tokens"],
        expected_output_tokens=workload["output_tokens"] if workload["generation"]["ignore_eos"] else None,
        acceptance=acceptance, source_root=output_dir.parent,
    )
    if evidence["metadata"]["status"] != "absent":
        normalized = normalize_reports(collected["reports"], request_samples=evidence["samples"])
    if not workload["generation"]["stream"]:
        normalized["metrics"] = {key: value for key, value in normalized["metrics"].items() if not any(name in key.lower() for name in ("ttft", "tpot", "itl"))}
    measurement = evidence["measurement"]
    measurement["cache_policy"] = cache_context(service)
    validate_measurement(measurement)
    normalized["metrics"].update(measurement["metrics"])
    run.artifact("measurement-contract", json.dumps(measurement, ensure_ascii=False, allow_nan=False), "application/json")
    if interrupted is not None:
        raise interrupted
    if result["exit_code"] != 0 and not timed_out:
        return with_samples({
            "ok": False, "kind": "process_failed", "workload": workload,
            "workload_hash": workload_hash, "exit_code": result["exit_code"],
            "stderr_tail": result["stderr"][-2000:], "request_evidence": evidence["metadata"],
        })

    summary_content = json.dumps(
        {
            "metrics": normalized["metrics"],
            "distributions": normalized["distributions"],
            "metric_normalizer_version": normalized["normalizer_version"],
            "request_samples_available": normalized["request_samples_available"],
            "request_evidence": evidence["metadata"],
            "measurement": measurement,
            "observed_gpu_memory_peak_bytes": peak_bytes,
            "workload": workload,
            "workload_hash": workload_hash,
            "warmup": warmup,
            "timed_out": timed_out,
        },
        ensure_ascii=False,
        indent=2,
    )
    summary_ref = run.artifact("evalscope-summary", summary_content, "application/json")
    complete = _metrics_complete(normalized["metrics"], stream=workload["generation"]["stream"]) and evidence["metadata"]["status"] == "complete" and measurement["status"] == "complete"
    if timed_out and evidence["metadata"]["status"] != "complete":
        complete = False
    if timed_out and not complete:
        return with_samples({"ok": False, "kind": "timed_out_partial", "workload": workload, "workload_hash": workload_hash, "summary_artifact": summary_ref})
    if evidence["metadata"].get("shape_mismatch_count", 0):
        return with_samples({"ok": False, "kind": "token_shape_mismatch", "workload": workload, "workload_hash": workload_hash, "summary_artifact": summary_ref, "request_evidence": evidence["metadata"]})
    if not complete:
        return with_samples({"ok": False, "kind": "no_metrics", "workload": workload, "workload_hash": workload_hash, "summary_artifact": summary_ref, "metrics": normalized["metrics"]})
    return with_samples({
        "ok": True,
        "timed_out": timed_out,
        "workload": workload,
        "workload_hash": workload_hash,
        "metrics": normalized["metrics"],
        "distributions": normalized["distributions"],
        "normalizer_version": normalized["normalizer_version"],
        "request_samples_available": normalized["request_samples_available"],
        "request_evidence": evidence["metadata"],
        "measurement": measurement,
        "observed_gpu_memory_peak_bytes": peak_bytes,
        "summary_artifact": summary_ref,
        "provider_version": provider_version,
    })


def _metrics_complete(metrics: dict[str, Any], *, stream: bool = True) -> bool:
    required = ("requests_per_second", "output_tokens_per_second", "success_rate", "p99_e2e_latency_ms") + (("p99_ttft_ms",) if stream else ())
    return all(isinstance(metrics.get(name), (int, float)) and not isinstance(metrics.get(name), bool) for name in required)


def run_scope_dir(store: CoreStore, run: ManagedRun) -> Path:
    directory: Path = store.home / "artifacts" / f"_bench-scratch-{run.run_id}"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _endpoint_ready(endpoint: str, cancellation: Any) -> bool:
    if not endpoint:
        return False
    try:
        request = urllib.request.Request(f"{endpoint}/v1/models", headers={"Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status == 200
    except Exception:  # noqa: BLE001 - probing is best-effort
        return False


def materialize_workload(
    input_value: Any,
    model_id: str,
    provider_version: str,
    *,
    revision: str = "",
    prefix_length: int = 0,
) -> dict[str, Any]:
    if not isinstance(input_value, dict):
        raise ContractError("invalid_input", "workload 必须是带 schema_version 的对象。")
    if input_value.get("schema_version") != WORKLOAD_SCHEMA_VERSION:
        raise ContractError("invalid_input", f"workload.schema_version 必须为 {WORKLOAD_SCHEMA_VERSION}。", {})
    mode = input_value.get("mode")
    if mode not in ("closed_loop", "open_loop"):
        raise ContractError("invalid_input", "workload.mode 必须是 closed_loop 或 open_loop。", {})
    integers = {
        "concurrency": (1, 4096),
        "request_count": (1, 1000000),
        "input_tokens": (1, 1000000),
        "output_tokens": (1, 1000000),
    }
    values: dict[str, int] = {}
    for name, (minimum, maximum) in integers.items():
        value = input_value.get(name)
        if not isinstance(value, int) or isinstance(value, bool) or not (minimum <= value <= maximum):
            raise ContractError("invalid_input", f"workload.{name} 必须是 {minimum}..{maximum} 的整数。", {"field": name})
        values[name] = value
    request_rate = input_value.get("request_rate")
    if mode == "open_loop":
        if not isinstance(request_rate, (int, float)) or request_rate <= 0:
            raise ContractError("invalid_input", "open_loop 压测必须提供 request_rate。")
    elif request_rate is not None:
        raise ContractError("invalid_input", "closed_loop 压测不接受 request_rate。", {})
    request_timeout = input_value.get("request_timeout_seconds", 600)
    if not isinstance(request_timeout, int) or isinstance(request_timeout, bool) or not (1 <= request_timeout <= 7200):
        raise ContractError("invalid_input", "request_timeout_seconds 必须是 1..7200 的整数。", {})
    warmup_requests = input_value.get("warmup_requests", 0)
    if not isinstance(warmup_requests, int) or isinstance(warmup_requests, bool) or warmup_requests < 0:
        raise ContractError("invalid_input", "warmup_requests 必须是非负整数。", {})
    warmup_timeout = input_value.get("warmup_timeout_seconds", request_timeout)
    if not isinstance(warmup_timeout, int) or isinstance(warmup_timeout, bool) or warmup_timeout < 1:
        raise ContractError("invalid_input", "warmup_timeout_seconds 必须是正整数。", {})
    seed = input_value.get("seed", 0)
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed < 2**32:
        raise ContractError("invalid_input", "workload.seed 必须是 0..4294967295 的整数。", {})
    temperature = input_value.get("temperature", 0)
    top_p = input_value.get("top_p", 1)
    if not isinstance(temperature, (int, float)) or isinstance(temperature, bool) or not math.isfinite(temperature) or temperature < 0:
        raise ContractError("invalid_input", "workload.temperature 必须是非负有限数字。", {})
    if not isinstance(top_p, (int, float)) or isinstance(top_p, bool) or not math.isfinite(top_p) or not 0 < top_p <= 1:
        raise ContractError("invalid_input", "workload.top_p 必须是 (0, 1] 的有限数字。", {})
    if not isinstance(prefix_length, int) or isinstance(prefix_length, bool) or not 0 <= prefix_length <= values["input_tokens"]:
        raise ContractError("invalid_input", "prefix_length 必须是 0..input_tokens 的整数；input_tokens 包含前缀。", {})
    return {
        "schema_version": WORKLOAD_SCHEMA_VERSION,
        "provider": {"name": "evalscope", "version": provider_version},
        "argv_profile_version": ARGV_PROFILE_VERSION,
        "mode": mode,
        "concurrency": values["concurrency"],
        "request_count": values["request_count"],
        "input_tokens": values["input_tokens"],
        "output_tokens": values["output_tokens"],
        "prefix_length": prefix_length,
        **({"request_rate": request_rate} if mode == "open_loop" else {}),
        "request_timeout_seconds": request_timeout,
        "request_source": {"kind": "random", "seed": seed},
        "tokenizer": {"model_id": model_id, "revision": revision, "chat_template": "none-token-ids"},
        "generation": {
            "stream": bool(input_value.get("stream", True)),
            "ignore_eos": bool(input_value.get("ignore_eos", True)),
            "temperature": temperature,
            "top_p": top_p,
        },
        "sampling_frozen": True,
        "warmup": {"requests": warmup_requests, "timeout_seconds": warmup_timeout},
    }


def _run_warmup(endpoint: str, model_id: str, workload: dict[str, Any], cancellation: Any) -> dict[str, Any]:
    failures: list[str] = []
    for index in range(workload["warmup"]["requests"]):
        try:
            if hasattr(cancellation, "raise_if_requested"):
                cancellation.raise_if_requested()
            payload = json.dumps(
                {"model": model_id, "messages": [{"role": "user", "content": "Warm up."}], "max_tokens": 1, "temperature": 0, "stream": workload["generation"]["stream"]},
                ensure_ascii=False,
            ).encode()
            request = urllib.request.Request(
                f"{endpoint}/v1/chat/completions",
                data=payload,
                headers={"content-type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=workload["warmup"]["timeout_seconds"]) as response:
                if response.status != 200:
                    failures.append(f"warmup_{index + 1}: HTTP {response.status}")
                else:
                    response.read()
        except Exception as error:  # noqa: BLE001 - warmup failures are reported, not fatal syntax
            failures.append(f"warmup_{index + 1}: {error}")
    return {"completed": workload["warmup"]["requests"] - len(failures), "failures": failures}


class _GpuSampler:
    """Best-effort GPU memory sampling while EvalScope runs.

    The peak is always kept. A stability rung also keeps each poll: elapsed
    milliseconds from start, and the max used bytes among the selected devices
    on that poll. A missed poll is omitted, not stored as zero, and does not
    stop the later polls. ``stop`` waits out the poll already in flight, then
    hands back a snapshot.
    """

    def __init__(self, device_ids: list[int], cancellation: Any, record_samples: bool = False):
        self.device_ids = [index for index in device_ids if isinstance(index, int) and not isinstance(index, bool)]
        self.cancellation = cancellation
        self.record_samples = record_samples
        self.peak: int | None = None
        self.samples: list[dict[str, int]] = []
        self.started = time.monotonic()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def start(self) -> None:
        self.started = time.monotonic()
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self) -> int | None:
        self._stop.set()
        if self._thread:
            # One poll can use the 5s command timeout plus the 5s terminate wait.
            self._thread.join(timeout=12)
        with self._lock:
            return self.peak

    def series(self) -> dict[str, Any]:
        with self._lock:
            samples = list(self.samples)
        return {"interval_seconds": 0.5, "samples": samples}

    def _loop(self) -> None:
        while not self._stop.is_set():
            self._read()
            self._stop.wait(0.5)

    def _read(self) -> None:
        try:
            result = run_command(
                ["nvidia-smi", "--query-gpu=index,memory.used", "--format=csv,noheader,nounits"],
                timeout_seconds=5,
                cancellation=self.cancellation,
            )
        except ContractError as error:
            if error.code == "cancelled":
                self._stop.set()
            return
        except Exception:  # noqa: BLE001 - sampling is best-effort
            return
        if result["exit_code"] != 0:
            return
        used = self._max_used(result["stdout"])
        if used is None:
            return
        with self._lock:
            self.peak = used if self.peak is None else max(self.peak, used)
            if self.record_samples:
                elapsed_ms = int((time.monotonic() - self.started) * 1000)
                self.samples.append({"elapsed_ms": elapsed_ms, "used_bytes": used})

    def _max_used(self, stdout: str) -> int | None:
        selected = set(self.device_ids)
        found: int | None = None
        for line in stdout.splitlines():
            parts = line.split(",")
            if len(parts) < 2:
                continue
            try:
                index = int(parts[0].strip())
                used = int(parts[1].strip()) * 1024 * 1024
            except ValueError:
                continue
            if selected and index not in selected:
                continue
            found = used if found is None else max(found, used)
        return found


def _collect_reports(output_dir: Path) -> dict[str, Any]:
    files: list[tuple[str, str]] = []
    reports: list[Any] = []
    for path in sorted(output_dir.rglob("*.json")):
        try:
            content = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if not content.strip():
            continue
        files.append((str(path.relative_to(output_dir)), content))
        try:
            reports.append(json.loads(content))
        except json.JSONDecodeError:
            pass
    return {"reports": reports, "files": files}


# ---------------------------------------------------------------------------
# Metric normalization (port of evalscope-normalizer-v2 semantics)
# ---------------------------------------------------------------------------

MetricMap = dict[str, Any]


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, str):
        try:
            number = float(value.strip())
            return number if math.isfinite(number) else None
        except ValueError:
            return None
    return None


def _unit_adjusted_ms(key: str, value: float) -> float:
    lowered = key.lower()
    if "ms" in lowered:
        return value
    if "s" in lowered:
        return value * 1000
    return value


def _scalar_metrics(value: Any, prefix: str = "", output: MetricMap | None = None) -> MetricMap:
    if output is None:
        output = {}
    if isinstance(value, list):
        return output
    if isinstance(value, dict):
        for key, child in value.items():
            _scalar_metrics(child, f"{prefix}.{key}" if prefix else key, output)
    elif value is None or isinstance(value, (str, int, float, bool)):
        normalized = prefix.lower()
        if _looks_like_metric(normalized):
            output[prefix] = value
    return output


def _looks_like_metric(path: str) -> bool:
    """Accept metric-shaped leaves while excluding workload metadata."""
    leaf = path.rsplit(".", 1)[-1].lower().replace("-", "_")
    if leaf in {"rps", "tps", "throughput", "success_rate", "ttft_ms", "tpot_ms", "itl_ms", "e2e_latency_ms"}:
        return True
    patterns = (
        r"success.*rate",
        r"(?:success(?:ful)?|failed|total|all)\s*requests?",
        r"(?:req|request).*(?:throughput|per[_\s-]*second)",
        r"output.*(?:token|tok).*(?:throughput|per[_\s-]*second)",
        r"output\s+throughput",
        r"(?:avg|average|mean).*(?:latency|e2e|ttft|tpot|itl)",
        r"(?:p50|p95|median).*(?:latency|e2e|ttft|tpot|itl)",
    )
    return any(re.search(pattern, leaf) for pattern in patterns)


def _normalized_scalars(raw: MetricMap) -> MetricMap:
    output: MetricMap = dict(raw)
    aliases: list[tuple[str, str]] = [
        (r"success.*rate|success_rate", "success_rate"),
        (r"(^|\.)rps$|request.*per.*second", "requests_per_second"),
        (r"(^|\.)tps$|output.*token.*per.*second|(^|\.)throughput$", "output_tokens_per_second"),
        (r"avg.*(latency|e2e)|mean.*(latency|e2e)", "mean_e2e_latency_ms"),
        (r"avg.*ttft|mean.*ttft", "mean_ttft_ms"),
        (r"avg.*tpot|mean.*tpot", "mean_tpot_ms"),
        (r"avg.*itl|mean.*itl", "mean_itl_ms"),
    ]
    for expression, target in aliases:
        match = next((key for key in raw if re.search(expression, key.lower())), None)
        if match:
            output[target] = raw[match]

    def first_number(expression: str) -> tuple[str, float] | None:
        for key, value in raw.items():
            if re.search(expression, key.lower()):
                parsed = _number(value)
                if parsed is not None:
                    return key, parsed
        return None

    success_requests = first_number(r"(?:^|\.)success(?:ful)?\s*requests?$")
    failed_requests = first_number(r"(?:^|\.)failed\s*requests?$")
    total_requests = first_number(r"(?:^|\.)(?:total|all)\s*requests?$")
    if "success_rate" not in output and success_requests:
        total = total_requests[1] if total_requests else (success_requests[1] + failed_requests[1] if failed_requests else None)
        if total:
            output["success_rate"] = success_requests[1] / total

    req_throughput = first_number(r"(?:^|\.)(?:req|request)\s+throughput(?:\s*\([^)]*req\s*\/\s*s[^)]*\))?$")
    if req_throughput:
        output["requests_per_second"] = req_throughput[1]
    output_throughput = first_number(r"(?:^|\.)(?:output\s+)?(?:token|tok)\s+throughput|(?:^|\.)output\s+throughput")
    if output_throughput:
        output["output_tokens_per_second"] = output_throughput[1]

    latency = first_number(r"(?:^|\.)(?:avg|average|mean)\s+(?:e2e\s+)?latency")
    if latency:
        output["mean_e2e_latency_ms"] = _unit_adjusted_ms(latency[0], latency[1])
    ttft = first_number(r"(?:^|\.)(?:avg|average|mean)\s+(?:ttft|time\s+to\s+first\s+token)")
    if ttft:
        output["mean_ttft_ms"] = _unit_adjusted_ms(ttft[0], ttft[1])
    tpot = first_number(r"(?:^|\.)(?:avg|average|mean)\s+tpot")
    if tpot:
        output["mean_tpot_ms"] = _unit_adjusted_ms(tpot[0], tpot[1])
    itl = first_number(r"(?:^|\.)(?:avg|average|mean)\s+itl")
    if itl:
        output["mean_itl_ms"] = _unit_adjusted_ms(itl[0], itl[1])
    return output




_METRIC_KEYS = ("ttft_ms", "e2e_latency_ms", "tpot_ms", "itl_ms")


def _metric_name(key: str) -> str | None:
    name = key.lower()
    if re.search(r"(^|[_\.])ttft([_\.]|$)", name) or "time_to_first" in name:
        return "ttft_ms"
    if re.search(r"(^|[_\.])tpot([_\.]|$)", name):
        return "tpot_ms"
    if re.search(r"(^|[_\.])itl([_\.]|$)", name):
        return "itl_ms"
    if "e2e" in name or "latency" in name:
        return "e2e_latency_ms"
    return None


def _collect_samples(value: Any, output: dict[str, list[float]] | None = None) -> dict[str, list[float]]:
    if output is None:
        output = {}
    if isinstance(value, list):
        for item in value:
            _collect_samples(item, output)
        return output
    if not isinstance(value, dict):
        return output
    for key, child in value.items():
        name = _metric_name(key)
        if name and isinstance(child, list):
            parsed = [parsed_item for item in child if (parsed_item := _number(item)) is not None]
            if parsed:
                output.setdefault(name, []).extend(parsed)
        _collect_samples(child, output)
    return output


def normalize_reports(reports: list[Any], *, request_samples: dict[str, list[float]] | None = None) -> dict[str, Any]:
    raw: MetricMap = {}
    for report in reports:
        _scalar_metrics(report, "", raw)
    samples: dict[str, list[float]] = {}
    if request_samples is None:
        for report in reports:
            _collect_samples(report, samples)
    else:
        samples = request_samples
    distributions = {key: _statistics(values) for key, values in samples.items() if values}
    metrics: MetricMap = {}
    for key, value in _normalized_scalars(raw).items():
        number = _number(value)
        if number is not None:
            metrics[key] = number
    for key, value in distributions.items():
        metrics[f"mean_{key}"] = value["mean"]
        metrics[f"p50_{key}"] = value["p50"]
        metrics[f"p95_{key}"] = value["p95"]
        metrics[f"p99_{key}"] = value["p99"]
        metrics[f"{key}_sample_count"] = value["sample_count"]
        metrics[f"{key}_standard_deviation"] = value["standard_deviation"]
    # EvalScope 1.10.0 publishes computed percentiles as rows, not samples.
    # Preserve its values and units; these must not populate sample counts.
    columns = {"Latency (s)": "e2e_latency_ms", "TTFT (ms)": "ttft_ms", "TPOT (ms)": "tpot_ms", "ITL (ms)": "itl_ms"}
    for report in reports:
        if not isinstance(report, list):
            continue
        for row in report:
            if not isinstance(row, dict) or row.get("Percentiles") not in ("50%", "95%", "99%"):
                continue
            percentile = "p" + row["Percentiles"].rstrip("%")
            for column, metric in columns.items():
                number = _number(row.get(column))
                if number is not None:
                    metrics.setdefault(f"{percentile}_{metric}", _unit_adjusted_ms(column, number))
    return {
        "normalizer_version": METRIC_NORMALIZER_VERSION,
        "metrics": metrics,
        "distributions": distributions,
        "request_samples_available": bool(distributions),
    }
