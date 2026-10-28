"""Load a suite registry and its acceptance profile.

A custom path replaces the built-in profile wholesale. There is no field merge.
Validation failures become ``invalid_profile`` with a short remediation; the
validator's own stack never leaves Core.
"""

from __future__ import annotations

import json
from importlib import resources
from pathlib import Path
from typing import Any

import jsonschema

from .contracts import SUITE_PROFILE_ID, ContractError, sha256_bytes

_BUILTIN_SCENARIO = {
    "short-chat": "chat",
    "short-rag": "rag",
    "short-batch": "batch",
    "short-code": "coding",
}

_DATA = resources.files("bittune_core") / "data"


def _schema(name: str) -> dict[str, Any]:
    return json.loads((_DATA / "schemas" / name).read_text(encoding="utf-8"))


def _reject(message: str) -> None:
    raise ContractError(
        "invalid_profile",
        message,
        remediation="按 suite-registry 与 acceptance-profile 的 schema 修正整份档案后重试。",
    )


def _validate(instance: Any, schema_name: str) -> None:
    try:
        jsonschema.validate(instance, _schema(schema_name))
    except jsonschema.ValidationError as error:
        _reject(f"档案不符合 {schema_name}：{error.message}")
    except jsonschema.SchemaError as error:
        _reject(f"档案 schema 无法使用：{error.message}")


def load_builtin() -> dict[str, Any]:
    document = json.loads((_DATA / "bittune-default-v1.json").read_text(encoding="utf-8"))
    return load_document(document, source="builtin")


def load_profile(path: str | None) -> dict[str, Any]:
    """Built-in short profile when ``path`` is omitted; otherwise the whole file."""
    if not path:
        return load_builtin()
    file = Path(path)
    if not file.is_file():
        _reject(f"找不到档案文件：{file.name}")
    try:
        document = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        _reject("档案不是可读的 JSON。")
    return load_document(document, source="file")


def load_document(document: Any, *, source: str) -> dict[str, Any]:
    if not isinstance(document, dict) or "registry" not in document or "acceptance" not in document:
        _reject("档案必须同时包含 registry 与 acceptance，且不得与内置档案逐字段合并。")
    registry = document["registry"]
    acceptance = document["acceptance"]
    _validate(registry, "suite-registry.schema.json")
    _validate(acceptance, "acceptance-profile.schema.json")
    if registry["concurrency_mode"] == "adaptive":
        if "min_probe" not in registry or "max_probe" not in registry:
            _reject("自适应档案必须同时声明 min_probe 与 max_probe。")
        if registry["min_probe"] > registry["max_probe"]:
            _reject("自适应档案的 min_probe 不能大于 max_probe。")
    if (registry["schema_version"] == 2) != (acceptance["schema_version"] == 2):
        _reject("registry与acceptance必须同时采用v2，旧档案不能隐式升级。")
    seen: set[str] = set()
    for scenario in registry["scenarios"]:
        if scenario["scenario_id"] in seen:
            _reject(f"场景 {scenario['scenario_id']} 重复。")
        seen.add(scenario["scenario_id"])
        if scenario['closed_loop'] is not True:
            _reject('当前suite只支持closed_loop；不把声明的open_loop静默改成闭环。')
        from .benchmark import materialize_workload
        try:
            materialize_workload({**scenario, 'schema_version':2, 'mode':'closed_loop', 'concurrency':max([*scenario['concurrency'],registry.get('min_probe',1),registry.get('max_probe',1)])},
                                 'profile-validation', 'not-executed', prefix_length=scenario.get('prefix_length',0))
        except ContractError as error:
            _reject(error.message)
        builtin = _BUILTIN_SCENARIO.get(scenario["scenario_id"])
        if source == "builtin":
            continue
        if "scenario" not in scenario and builtin is None:
            _reject(f"场景 {scenario['scenario_id']} 必须声明 scenario（chat、rag、batch、coding 之一）。")
        if builtin is not None and scenario.get("scenario") not in (None, builtin):
            _reject(f"场景 {scenario['scenario_id']} 的投影固定为 {builtin}。")
    raw = json.dumps({"registry": registry, "acceptance": acceptance}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    profile_id = SUITE_PROFILE_ID if source == "builtin" else sha256_bytes(raw.encode("utf-8")).split(":", 1)[1][:16]
    return {
        "profile_id": profile_id,
        "profile_hash": sha256_bytes(raw.encode("utf-8")),
        "registry": registry,
        "acceptance": acceptance,
    }


def project_scenario(
    scenario_id: str,
    input_tokens: int,
    output_tokens: int,
    concurrency: int,
    scenario: str | None = None,
) -> dict[str, str]:
    """Bucket names are computed. The scenario kind is declared, not a bucket field."""
    kind = scenario or _BUILTIN_SCENARIO.get(scenario_id)
    if kind is None:
        raise ContractError("invalid_profile", f"场景 {scenario_id} 没有可投影的场景类型。")
    return {
        "scenario": kind,
        "input_bucket": _token_bucket(input_tokens),
        "output_bucket": _token_bucket(output_tokens),
        "load_bucket": _load_bucket(concurrency),
    }


def _token_bucket(tokens: int) -> str:
    if tokens <= 2048:
        return "0-2048"
    if tokens <= 8192:
        return "2049-8192"
    if tokens <= 32768:
        return "8193-32768"
    return "32769+"

def _load_bucket(concurrency: int) -> str:
    if concurrency == 1:
        return "1"
    if concurrency <= 8:
        return "2-8"
    if concurrency <= 32:
        return "9-32"
    return "33+"
