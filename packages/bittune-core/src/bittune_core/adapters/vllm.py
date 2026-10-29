"""vLLM adapter: the managed parameter surface and CLI compilation.

The adapter accepts only the declared serving fields, materializes defaults,
and compiles engine arguments. When an image capability check supplied the
flags the selected image actually supports, every non-default parameter must
be backed by its mapped CLI flag - the adapter never guesses image behavior.
"""

import math
from typing import Any

from bittune_core.contracts import ContractError, canonical_json, sha256_bytes

CAPABILITY_VERSION = "vllm-managed-v3"

VALID_DTYPES = ("auto", "bfloat16", "float16", "float32")

PARAMETERS: list[dict[str, Any]] = [
    {"name": "dtype", "type": "enum", "default": "auto", "values": VALID_DTYPES},
    {"name": "tensor_parallel_size", "type": "integer", "default": 1, "minimum": 1},
    {"name": "pipeline_parallel_size", "type": "integer", "default": 1, "minimum": 1},
    {"name": "gpu_device_ids", "type": "integer_array", "default": [], "minimum": 0},
    {"name": "max_model_len", "type": "integer", "unit": "tokens", "default": 8192, "minimum": 1},
    {"name": "max_num_seqs", "type": "integer", "default": 4, "minimum": 1},
    {"name": "max_num_batched_tokens", "type": "integer", "unit": "tokens", "default": 4096, "minimum": 1},
    {"name": "gpu_memory_utilization", "type": "number", "default": 0.8, "minimum": 0, "exclusive_minimum": True, "maximum": 1},
    {"name": "swap_space_gib", "type": "number", "unit": "GiB", "default": 4, "minimum": 0},
    {"name": "enforce_eager", "type": "boolean", "default": False},
    {"name": "enable_prefix_caching", "type": "boolean", "default": True},
]

_DESCRIPTORS = {item["name"]: item for item in PARAMETERS}

#: A non-default parameter maps to these flags; image inspection must list them.
_FLAG_FOR_PARAMETER = {
    "dtype": "--dtype",
    "tensor_parallel_size": "--tensor-parallel-size",
    "pipeline_parallel_size": "--pipeline-parallel-size",
    "max_model_len": "--max-model-len",
    "max_num_seqs": "--max-num-seqs",
    "max_num_batched_tokens": "--max-num-batched-tokens",
    "gpu_memory_utilization": "--gpu-memory-utilization",
    "swap_space_gib": "--swap-space",
    "enforce_eager": "--enforce-eager",
    "enable_prefix_caching": "--enable-prefix-caching",
}

REQUIRED_FLAGS = ["--model", "--served-model-name", "--host", "--port"]



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
                f"vLLM adapter does not expose parameter {name}.",
                {"parameter": name},
                remediation="Use only the declared vLLM serving_spec fields.",
            )
        result[name] = _assert_value(descriptor, raw)
    devices = result["gpu_device_ids"]
    workers = result["tensor_parallel_size"] * result["pipeline_parallel_size"]
    if devices and len(devices) < workers:
        invalid("gpu_device_ids", "must contain at least tensor_parallel_size * pipeline_parallel_size devices")
    if result["max_num_batched_tokens"] < result["max_num_seqs"]:
        invalid("max_num_batched_tokens", "must be >= max_num_seqs")
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
        if name == "enable_prefix_caching" and config[name] is False:
            flag = "--no-enable-prefix-caching"
        descriptor = _DESCRIPTORS[name]
        append_ok = flags is None or flag in flags
        if not append_ok and config[name] != descriptor["default"]:
            raise ContractError(
                "runtime_cli_incompatible",
                f"The selected vLLM image does not support {flag}, required by {name}.",
                {"flag": flag, "parameter": name},
            )
        if not append_ok:
            continue
        if descriptor["type"] == "boolean":
            if config[name] or name == "enable_prefix_caching":
                args.append(flag)
        else:
            args.append(flag)
            args.append(str(config[name]))
    return args


def compile_docker_gpu_args(configuration: dict[str, Any]) -> list[str]:
    devices = materialize(configuration)["gpu_device_ids"]
    return ["--gpus", f"device={','.join(str(item) for item in devices)}" if devices else "all"]


def launch_args(model_path: str, model_id: str, engine_args: list[str]) -> list[str]:
    return ["--model", model_path, "--served-model-name", model_id, *engine_args, "--host", "0.0.0.0", "--port", "8000"]