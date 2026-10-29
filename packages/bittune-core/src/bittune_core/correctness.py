"""Correctness intent. The pack stays in the caller's file.

The fact keeps pack id, counts, sample id to request id, and pass/fail.
Messages and expected text never enter the fact or the run artifact.
"""

from __future__ import annotations

import json
import urllib.request
import uuid
from pathlib import Path
from typing import Any

import jsonschema

from bittune_core.contracts import ContractError
from bittune_core.runs import ManagedRun
from bittune_core.store import CoreStore, utc_now
from bittune_core.benchmark import subject_identity_fields
from bittune_core.suite import _ready_managed
from bittune_core.suite_profiles import _schema, load_profile


def run_correctness(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    cancellation = context["cancellation"]
    with ManagedRun(store, "benchmark_suite", params, context["session_id"], context) as run:
        profile = load_profile(params.get("profile_path") if isinstance(params.get("profile_path"), str) else None)
        service = _ready_managed(store, params, cancellation)
        pack_path = params.get("correctness_pack_path")
        if not isinstance(pack_path, str) or not pack_path or not Path(pack_path).is_file():
            return _finish(store, run, _base(service, profile, "evidence_insufficient", "pack_missing", "没有可用的正确性包，不计算准确率。"))
        try:
            document = json.loads(Path(pack_path).read_text(encoding="utf-8"))
            jsonschema.validate(document, _schema("correctness-pack.schema.json"))
        except (OSError, json.JSONDecodeError, jsonschema.ValidationError, jsonschema.SchemaError):
            return _finish(store, run, _base(service, profile, "evidence_insufficient", "pack_invalid", "正确性包无法读取或不符合 schema，不计算准确率。"))
        samples = _score(service, document["samples"])
        if any("passed" not in item for item in samples):
            return _finish(store, run, _base(
                service,
                profile,
                "aggregate_blocked",
                "unmapped_or_score_error",
                "有样本对不上或打分失败，不计算准确率。",
                pack_id=document["pack_id"],
                samples=samples,
            ))
        hits = sum(1 for item in samples if item["passed"])
        payload = _base(
            service,
            profile,
            "healthy",
            "ok",
            "每个样本都有对应回复并完成打分。",
            pack_id=document["pack_id"],
            sample_count=len(samples),
            hit_count=hits,
            accuracy=hits / len(samples),
            samples=samples,
        )
        return _finish(store, run, payload)


def _score(service: dict[str, Any], samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    scored: list[dict[str, Any]] = []
    model = (service.get("model_ref") or {}).get("model_id", "")
    for sample in samples:
        try:
            reply, request_id = _chat(service["endpoint"], model, sample["messages"])
        except Exception:  # noqa: BLE001 — one failed request stays on the sample
            scored.append(_sample(sample["sample_id"], None, error="request_failed"))
            continue
        if reply == "":
            scored.append(_sample(sample["sample_id"], request_id, error="unmapped"))
            continue
        try:
            expected = sample["expected"]
            passed = reply == expected["text"] if expected["kind"] == "exact" else expected["text"] in reply
        except Exception:  # noqa: BLE001 — a scoring error stays on the sample
            scored.append(_sample(sample["sample_id"], request_id, error="score_failed"))
            continue
        scored.append(_sample(sample["sample_id"], request_id, passed=passed))
    return scored


def _sample(sample_id: str, request_id: str | None, passed: bool | None = None, error: str | None = None) -> dict[str, Any]:
    item: dict[str, Any] = {"sample_id": sample_id}
    if isinstance(request_id, str) and request_id:
        item["request_id"] = request_id
    else:
        item["request_id_missing"] = True
    if error:
        item["error"] = error
    else:
        item["passed"] = passed
    return item


def _chat(endpoint: str, model: str, messages: list[dict[str, str]]) -> tuple[str, str | None]:
    """One non-streaming completion. Empty text means the reply could not be mapped."""
    payload = json.dumps({"model": model, "messages": messages, "temperature": 0, "stream": False}).encode()
    request = urllib.request.Request(
        f"{endpoint}/v1/chat/completions",
        data=payload,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise OSError(response.status)
        body = json.loads(response.read().decode("utf-8"))
    request_id = body.get("id") if isinstance(body, dict) else None
    if not isinstance(request_id, str) or not request_id:
        request_id = None
    choices = body.get("choices") if isinstance(body, dict) else None
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return "", request_id
    message = choices[0].get("message")
    content = message.get("content") if isinstance(message, dict) else None
    return (content if isinstance(content, str) else ""), request_id


def _base(service: dict[str, Any], profile: dict[str, Any], state: str, reason_code: str, reason_detail: str, **extra: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schema_version": 1,
        "correctness_result_id": f"correct-{uuid.uuid4()}",
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
    if '"expected"' in json.dumps(payload, ensure_ascii=False) or '"messages"' in json.dumps(payload, ensure_ascii=False):
        raise ContractError("invalid_input", "正确性 fact 不能保存样本正文。")
    return payload


def _finish(store: CoreStore, run: ManagedRun, payload: dict[str, Any]) -> dict[str, Any]:
    store.put_correctness_result(payload, run.run_id)
    run.artifact("correctness", json.dumps(payload, ensure_ascii=False), "application/json")
    return run.success(payload["reason_detail"], {"correctness_result": payload})
