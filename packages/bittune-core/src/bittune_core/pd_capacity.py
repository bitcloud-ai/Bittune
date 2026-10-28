"""P/D estimate from one suite. Caps are derived, never measured.

Missing either anchor writes the fact with no caps. A supplied cache pair that
is not healthy on both sides also writes no caps.
"""

from __future__ import annotations

import uuid
from typing import Any

from bittune_core.benchmark import subject_identity_fields
from bittune_core.contracts import ContractError
from bittune_core.runs import ManagedRun
from bittune_core.store import CoreStore, utc_now

_FORMULA = (
    "p_cap_req_per_s = anchor_prefill.goodput_req_per_s\n"
    "d_cap_tok_per_s = anchor_decode.output_tokens_per_second\n"
    "ratio_p_to_d = p_cap_req_per_s / (d_cap_tok_per_s / anchor_decode.output_tokens)"
)


def run_pd_planning(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    with ManagedRun(store, "benchmark_suite", params, context["session_id"], context) as run:
        suite_id = params.get("suite_result_id")
        if not isinstance(suite_id, str) or not suite_id:
            raise ContractError("invalid_input", "pd_planning 需要已有扫描的 suite_result_id。")
        suite = store.get_fact("suite_result", suite_id)["payload"]
        cache_id = params.get("cache_pair_result_id")
        boundary = "no_cache_check"
        if isinstance(cache_id, str) and cache_id:
            pair = store.get_fact("cache_pair_result", cache_id)["payload"]
            if not _pair_complete(pair):
                payload = _base(suite, "evidence_insufficient", "pairs_incomplete", "缓存对不是两侧完整，不写容量。", evidence_boundary="pairs_incomplete", cache_pair_result_id=cache_id)
                return _finish(store, run, payload)
            boundary = "cache_checked"
        prefill = _best(suite["rows"], "input_bucket", "8193-32768")
        decode = _best(suite["rows"], "output_bucket", "2049-8192")
        if prefill is None or decode is None:
            payload = _base(suite, "evidence_insufficient", "anchor_missing", "缺少 prefill 或 decode 锚点，不写容量。", evidence_boundary=boundary)
            return _finish(store, run, payload)
        goodput = prefill.get("goodput_req_per_s")
        decode_rate = (decode.get("metrics") or {}).get("output_tokens_per_second")
        output_tokens = decode.get("output_tokens")
        if not _positive(goodput) or not _positive(decode_rate) or not _positive(output_tokens):
            payload = _base(suite, "evidence_insufficient", "anchor_unusable", "锚点吞吐或输出长度为 0，不写配比。", evidence_boundary=boundary)
            return _finish(store, run, payload)
        payload = _base(
            suite,
            "healthy",
            "ok",
            "由同一扫描的 prefill 与 decode 锚点推算，不是实测容量。",
            evidence_boundary=boundary,
            p_cap_req_per_s=goodput,
            d_cap_tok_per_s=decode_rate,
            ratio_p_to_d=goodput / (decode_rate / output_tokens),
            formula=_FORMULA,
            provenance="derived",
        )
        if isinstance(cache_id, str) and cache_id:
            payload["cache_pair_result_id"] = cache_id
        return _finish(store, run, payload)


def _pair_complete(pair: dict[str, Any]) -> bool:
    sides = pair.get("sides")
    if not isinstance(sides, dict):
        return pair.get("state") == "healthy" and pair.get("cold_healthy") is True and pair.get("hot_healthy") is True
    cold = sides.get("cold") or {}
    hot = sides.get("hot") or {}
    return cold.get("state") == "healthy" and hot.get("state") == "healthy"


def _best(rows: list[dict[str, Any]], bucket_key: str, minimum: str) -> dict[str, Any] | None:
    order = ("0-2048", "2049-8192", "8193-32768", "32769+")
    floor = order.index(minimum)
    chosen: dict[str, Any] | None = None
    for row in rows:
        projection = row.get("projection") or {}
        bucket = projection.get(bucket_key)
        if row.get("state") != "healthy":
            continue
        if not isinstance(bucket, str) or bucket not in order or order.index(bucket) < floor:
            continue
        goodput = row.get("goodput_req_per_s")
        if not _positive(goodput):
            continue
        if chosen is None or goodput > chosen["goodput_req_per_s"]:
            chosen = row
    return chosen


def _positive(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


def _base(suite: dict[str, Any], state: str, reason_code: str, reason_detail: str, **extra: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schema_version": 1,
        "pd_estimate_id": f"pd-{uuid.uuid4()}",
        "suite_result_id": suite["suite_result_id"],
        "profile_id": suite["profile_id"],
        **subject_identity_fields(suite),
        "model_ref": suite.get("model_ref") or {},
        "runtime_spec": suite.get("runtime_spec") or {},
        "state": state,
        "reason_code": reason_code,
        "reason_detail": reason_detail,
        "created_at": utc_now(),
        "provenance": "derived",
    }
    extra.pop("provenance", None)
    payload.update(extra)
    return payload


def _finish(store: CoreStore, run: ManagedRun, payload: dict[str, Any]) -> dict[str, Any]:
    store.put_pd_estimate(payload, run.run_id)
    return run.success(payload["reason_detail"], {"pd_estimate": payload})
