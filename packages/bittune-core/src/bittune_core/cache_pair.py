"""Cold/hot cache pair. Only SGLang with a real flush is measured.

vLLM and anything else are ``not_applicable``. A failed flush is the same:
prefix length stays the profile value and is never rewritten to 0.
"""

from __future__ import annotations

import hashlib
import json
import urllib.request
import uuid
from typing import Any

from bittune_core.benchmark import execute_workload
from bittune_core.plans import resolve_model_snapshot
from bittune_core.runs import ManagedRun
from bittune_core.store import CoreStore, utc_now
from bittune_core.benchmark import subject_identity_fields
from bittune_core.suite import _evalscope_version, _ready_managed, _workload_input
from bittune_core.suite_profiles import load_profile

_BAND = 0.05
_HIT = "sglang:cache_hit_tokens"
_PROMPT = "sglang:prompt_tokens"


def run_cache_pair(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    cancellation = context["cancellation"]
    with ManagedRun(store, "benchmark_suite", params, context["session_id"], context) as run:
        profile = load_profile(params.get("profile_path"))
        service = _ready_managed(store, params, cancellation)
        if _data_parallel(service):
            return _finish(store, run, _base(service, profile, "not_applicable", "dp_unbound", "数据并行未纳入缓存对，不发送请求。"))
        if (service.get("runtime_spec") or {}).get("runtime_kind") != "sglang":
            return _finish(store, run, _base(service, profile, "not_applicable", "runtime_unsupported", "该引擎没有已验证的 flush，不发送请求。"))
        point = _cache_point(profile)
        if point is None:
            return _finish(store, run, _base(service, profile, "not_applicable", "prefix_unset", "档案没有大于 0 的 prefix_length，不用 0 冒充冷测。"))
        if not _flush(service["endpoint"]):
            return _finish(store, run, _base(service, profile, "not_applicable", "flush_failed", "flush_cache 没有返回 2xx，不改用 prefix 0。"))
        provider_version = _evalscope_version(run, cancellation)
        model_ref = service.get("model_ref") or {}
        tokenizer = resolve_model_snapshot(model_ref.get("model_id", ""), model_ref.get("revision", ""), model_ref.get("local_path"), cancellation)
        if tokenizer is None:
            return _finish(store, run, _base(service, profile, "not_applicable", "model_snapshot_missing", "本地缺少模型快照，不发送缓存对请求。"))
        return _measure(store, run, cancellation, service, profile, point, provider_version, model_ref, tokenizer["host_path"])


def _measure(store, run, cancellation, service, profile, point, provider_version, model_ref, tokenizer_path) -> dict[str, Any]:
    workload = _workload_input(point)
    prefix = point["prefix_length"]
    cold, hot, observed, cold_observed = _protocol(workload, prefix, service, model_ref, provider_version, tokenizer_path, store, run, cancellation)
    constructed = prefix / point["input_tokens"]
    payload = _pair_payload(service, profile, cold, hot, constructed, observed, prefix)
    if cold_observed is not None:
        payload["cold_window_hit_rate"] = cold_observed
    if payload["state"] != "healthy" or observed is None or abs(observed - constructed) <= _BAND:
        return _finish(store, run, payload)
    payload["data_quality"] = "hit_rate_out_of_band"
    adjusted = max(1, min(point["input_tokens"] - 1, round(observed * point["input_tokens"])))
    if adjusted == prefix or not _flush(service["endpoint"]):
        return _finish(store, run, payload)
    cold, hot, observed, cold_observed = _protocol(workload, adjusted, service, model_ref, provider_version, tokenizer_path, store, run, cancellation)
    retried = _pair_payload(service, profile, cold, hot, adjusted / point["input_tokens"], observed, adjusted)
    if cold_observed is not None:
        retried["cold_window_hit_rate"] = cold_observed
    retried["calibration_attempts"] = 1
    if observed is not None and abs(observed - retried["constructed_hit_rate"]) > _BAND:
        retried["data_quality"] = "hit_rate_out_of_band"
    elif observed is None:
        retried["data_quality"] = "counter_missing"
    return _finish(store, run, retried)


def _protocol(workload, prefix, service, model_ref, provider_version, tokenizer_path, store, run, cancellation):
    """flush already happened. Cold is recorded, then one warmup, then the hot window."""
    before = _counters(service["endpoint"])
    cold = _once({**workload, "warmup_requests": 0}, prefix, service, model_ref, provider_version, tokenizer_path, store, run, cancellation)
    after_cold = _counters(service["endpoint"])
    _once(workload, prefix, service, model_ref, provider_version, tokenizer_path, store, run, cancellation)
    before_hot = _counters(service["endpoint"])
    hot = _once(workload, prefix, service, model_ref, provider_version, tokenizer_path, store, run, cancellation)
    after_hot = _counters(service["endpoint"])
    return cold, hot, _delta(before_hot, after_hot), _delta(before, after_cold)


def _once(workload, prefix, service, model_ref, provider_version, tokenizer_path, store, run, cancellation) -> dict[str, Any]:
    return execute_workload(
        workload,
        service=service,
        model_ref=model_ref,
        provider_version=provider_version,
        tokenizer_path=tokenizer_path,
        store=store,
        run=run,
        cancellation=cancellation,
        prefix_length=prefix,
    )


def _pair_payload(service, profile, cold, hot, constructed, observed, prefix) -> dict[str, Any]:
    same_shape = _shape_sha(cold) is not None and _shape_sha(cold) == _shape_sha(hot)
    cold_bytes = _byte_digest(cold)
    hot_bytes = _byte_digest(hot)
    bytes_differ = cold_bytes is not None and hot_bytes is not None and cold_bytes != hot_bytes
    healthy = bool(cold.get("ok") and hot.get("ok") and same_shape and not bytes_differ)
    payload = _base(
        service,
        profile,
        "healthy" if healthy else "invalid_measurement",
        "ok" if healthy else "pair_incomplete",
        "冷测与热测使用同一 prefix，两侧输入一致。" if healthy else "冷测或热测缺字段，或两侧输入不一致，两侧都不标 healthy。",
        sides={"cold": _side(cold, healthy), "hot": _side(hot, healthy)},
        cold_healthy=healthy,
        hot_healthy=healthy,
        constructed_hit_rate=constructed,
        prefix_length=prefix,
    )
    if cold_bytes is not None and cold_bytes == hot_bytes:
        payload["dataset_input_sha256"] = cold_bytes
        payload["input_identity"] = "bytes"
    elif same_shape and not bytes_differ:
        payload["input_identity"] = "shape_only"
    if observed is None:
        payload["data_quality"] = "counter_missing"
    else:
        payload["observed_hit_rate"] = observed
    return payload


def _side(outcome: dict[str, Any], healthy: bool) -> dict[str, Any]:
    view: dict[str, Any] = {"state": "healthy" if healthy else "invalid_measurement", "ok": bool(outcome.get("ok"))}
    if outcome.get("workload_hash"):
        view["workload_hash"] = outcome["workload_hash"]
    digest = _byte_digest(outcome)
    if digest:
        view["input_sha256"] = digest
    return view


def _shape_sha(outcome: dict[str, Any]) -> str | None:
    workload = outcome.get("workload") or {}
    if "input_tokens" not in workload or "prefix_length" not in workload:
        return None
    raw = json.dumps({"input_tokens": workload["input_tokens"], "prefix_length": workload["prefix_length"]}, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


def _byte_digest(outcome: dict[str, Any]) -> str | None:
    workload = outcome.get("workload") if isinstance(outcome.get("workload"), dict) else {}
    for source in (outcome, workload):
        digest = source.get("prompt_sha256")
        if isinstance(digest, str) and digest:
            return digest
    return None


def _cache_point(profile: dict[str, Any]) -> dict[str, Any] | None:
    for scenario in profile["registry"]["scenarios"]:
        prefix = scenario.get("prefix_length")
        if isinstance(prefix, int) and not isinstance(prefix, bool) and 0 < prefix < scenario["input_tokens"]:
            return {**scenario, "concurrency": scenario["concurrency"][0], "prefix_length": prefix}
    return None


def _data_parallel(service: dict[str, Any]) -> bool:
    spec = service.get("serving_spec") or {}
    if spec.get("attention_dp"):
        return True
    for key in ("data_parallel_size", "dp_size"):
        value = spec.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value > 1:
            return True
    return False


def _flush(endpoint: str) -> bool:
    request = urllib.request.Request(f"{endpoint}/flush_cache", data=b"{}", headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return 200 <= response.status < 300
    except Exception:  # noqa: BLE001
        return False


def _counters(endpoint: str) -> dict[str, float] | None:
    request = urllib.request.Request(f"{endpoint}/metrics", method="GET")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            if response.status != 200:
                return None
            text = response.read().decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return None
    found: dict[str, float] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        name, _, raw = line.partition(" ")
        metric = name.split("{", 1)[0]
        if metric in (_HIT, _PROMPT):
            try:
                found[metric] = float(raw)
            except ValueError:
                return None
    if _HIT not in found or _PROMPT not in found:
        return None
    return found


def _delta(before: dict[str, float] | None, after: dict[str, float] | None) -> float | None:
    if not before or not after:
        return None
    prompt = after[_PROMPT] - before[_PROMPT]
    if prompt <= 0:
        return None
    return (after[_HIT] - before[_HIT]) / prompt


def _base(service, profile, state, reason_code, reason_detail, **extra: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schema_version": 1,
        "cache_pair_result_id": f"cache-{uuid.uuid4()}",
        "profile_id": profile["profile_id"],
        **subject_identity_fields(service),
        "model_ref": service.get("model_ref") or {},
        "runtime_spec": service.get("runtime_spec") or {},
        "state": state,
        "reason_code": reason_code,
        "reason_detail": reason_detail,
        "created_at": utc_now(),
        "provenance": "derived",
    }
    payload.update(extra)
    return payload


def _finish(store: CoreStore, run: ManagedRun, payload: dict[str, Any]) -> dict[str, Any]:
    store.put_cache_pair_result(payload, run.run_id)
    return run.success(payload["reason_detail"], {"cache_pair_result": payload})
