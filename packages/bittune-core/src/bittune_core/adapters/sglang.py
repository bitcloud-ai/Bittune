"""SGLang adapter: the managed parameter surface and CLI compilation."""

import math
from typing import Any

from bittune_core.contracts import ContractError, canonical_json, sha256_bytes

CAPABILITY_VERSION = "sglang-managed-v2"

VALID_DTYPES = ("auto", "bfloat16", "float16", "float32")

PARAMETERS: list[dict[str, Any]] = [
    {"name": "dtype", "type": "enum", "default": "auto", "values": VALID_DTYPES},
    {"name": "tensor_parallel_size", "type": "integer", "default": 1, "minimum": 1},
    {"name": "gpu_device_ids", "type": "integer_array", "default": [], "minimum": 0},
    {"name": "context_length", "type": "integer", "unit": "tokens", "default": 8192, "minimum": 1},
    {"name": "max_running_requests", "type": "integer", "default": 4, "minimum": 1},
    {"name": "chunked_prefill_size", "type": "integer", "unit": "tokens", "default": 4096, "minimum": 1},
    {"name": "mem_fraction_static", "type": "number", "default": 0.8, "minimum": 0, "exclusive_minimum": True, "maximum": 1},
    {"name": "disable_cuda_graph", "type": "boolean", "default": False},
    {"name": "disable_radix_cache", "type": "boolean", "default": False},
    {"name": "attention_backend", "type": "enum", "default": "auto", "values": ("auto", "flashinfer", "triton")},
    {"name": "kv_cache_dtype", "type": "enum", "default": "auto", "values": ("auto", "bfloat16", "fp8_e4m3", "fp8_e5m2")},
]

_DESCRIPTORS = {item["name"]: item for item in PARAMETERS}

_FLAG_FOR_PARAMETER = {
    "dtype": "--dtype",
    "tensor_parallel_size": "--tp-size",
    "context_length": "--context-length",
    "max_running_requests": "--max-running-requests",
    "chunked_prefill_size": "--chunked-prefill-size",
    "mem_fraction_static": "--mem-fraction-static",
    "disable_cuda_graph": "--disable-cuda-graph",
    "disable_radix_cache": "--disable-radix-cache",
    "attention_backend": "--attention-backend",
    "kv_cache_dtype": "--kv-cache-dtype",
}

REQUIRED_FLAGS = ["--model-path", "--served-model-name", "--host", "--port"]


def invalid(name: str, message: str) -> None:
    raise ContractError("invalid_serving_configuration", f"{name}: {message}", {"parameter": name})


def materialize(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        invalid("serving_spec", "must be an object")
    result = {item["name"]: item["default"] for item in PARAMETERS}
    for name, raw in value.items():
        descriptor = _DESCRIPTORS.get(name)
        if descriptor is None:
            raise ContractError(
                "unsupported_serving_parameter",
                f"SGLang adapter does not expose parameter {name}.",
                {"parameter": name},
                remediation="Use only the declared SGLang serving_spec fields.",
            )
        result[name] = _assert_value(descriptor, raw)
    devices = result["gpu_device_ids"]
    if devices and len(devices) < result["tensor_parallel_size"]:
        invalid("gpu_device_ids", "must contain at least tensor_parallel_size devices")
    if result["chunked_prefill_size"] < result["max_running_requests"]:
        invalid("chunked_prefill_size", "must be >= max_running_requests")
    return result


def _assert_value(descriptor: dict[str, Any], value: Any) -> Any:
    kind = descriptor["type"]
    if kind == "boolean":
        if not isinstance(value, bool):
            invalid(descriptor["name"], "must be boolean")
        return value
    if kind == "enum":
        if not isinstance(value, str) or value not in descriptor.get("values", ()):
            invalid(descriptor["name"], f"must be one of {', '.join(descriptor.get('values', ()))}")
        return value
    if kind == "integer_array":
        if not isinstance(value, list) or any(not isinstance(item, int) or isinstance(item, bool) or item < descriptor.get("minimum", float("-inf")) for item in value):
            invalid(descriptor["name"], "must be an array of supported GPU indexes")
        if len(set(value)) != len(value):
            invalid(descriptor["name"], "must not contain duplicate GPU indexes")
        return list(value)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        invalid(descriptor["name"], f"must be a finite {kind}")
    if kind == "integer" and isinstance(value, float) and not value.is_integer():
        invalid(descriptor["name"], "must be an integer")
    minimum = descriptor.get("minimum")
    if minimum is not None:
        if descriptor.get("exclusive_minimum"):
            if value <= minimum:
                invalid(descriptor["name"], f"must be > {minimum}")
        elif value < minimum:
            invalid(descriptor["name"], f"must be >= {minimum}")
    maximum = descriptor.get("maximum")
    if maximum is not None and value > maximum:
        invalid(descriptor["name"], f"must be <= {maximum}")
    return value


def fingerprint(configuration: dict[str, Any]) -> str:
    return sha256_bytes(canonical_json({"capability_version": CAPABILITY_VERSION, "configuration": materialize(configuration)}).encode("utf-8"))


def compile_engine_args(configuration: dict[str, Any], supported_flags: list[str] | None = None) -> list[str]:
    config = materialize(configuration)
    flags = set(supported_flags) if supported_flags is not None else None
    args: list[str] = []
    for name, flag in _FLAG_FOR_PARAMETER.items():
        if name in ("attention_backend", "kv_cache_dtype") and config[name] == "auto":
            continue
        descriptor = _DESCRIPTORS[name]
        append_ok = flags is None or flag in flags
        if not append_ok and config[name] != descriptor["default"]:
            raise ContractError(
                "runtime_cli_incompatible",
                f"The selected SGLang image does not support {flag}, required by {name}.",
                {"flag": flag, "parameter": name},
            )
        if not append_ok:
            continue
        if descriptor["type"] == "boolean":
            if config[name]:
                args.append(flag)
        else:
            args.append(flag)
            args.append(str(config[name]))
    return args


def compile_docker_gpu_args(configuration: dict[str, Any]) -> list[str]:
    devices = materialize(configuration)["gpu_device_ids"]
    return ["--gpus", f"device={','.join(str(item) for item in devices)}" if devices else "all"]


def launch_args(model_path: str, model_id: str, engine_args: list[str]) -> list[str]:
    return ["--model-path", model_path, "--served-model-name", model_id, *engine_args, "--host", "0.0.0.0", "--port", "8000"]
