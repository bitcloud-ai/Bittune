"""Adapter selection: `if runtime_kind` is the whole extension point."""

from typing import Any

from bittune_core.contracts import ContractError

from bittune_core.adapters import sglang, vllm

RUNTIME_KINDS = ("vllm", "sglang")


def require_adapter(kind: Any):
    if kind == "vllm":
        return vllm
    if kind == "sglang":
        return sglang
    raise ContractError(
        "unsupported_runtime_kind",
        f"Bittune does not support runtime_kind {kind!r}.",
        {"runtime_kind": kind, "supported": list(RUNTIME_KINDS)},
        remediation="Choose one of the supported adapter kinds.",
    )


def inspect_image_cli(kind: Any, docker_runner, run_reference: str) -> dict[str, Any]:
    """Probe the selected image for the adapter's required CLI flags.

    Two fixed strategies: vLLM uses the `vllm` entrypoint, SGLang tries the two
    Python executables. The image help is the authority for every launch
    argument; a missing required flag aborts deployment with a clear reason.
    """
    adapter = require_adapter(kind)
    if kind == "vllm":
        help_result = docker_runner(
            ["docker", "run", "--rm", "--pull=never", "--network=none", "--cap-drop=ALL", "--pids-limit", "256", "--entrypoint", "vllm", run_reference, "serve", "--help=all"],
            timeout_seconds=120,
        )
        flags = _extract_flags(f"{help_result['stdout']}\n{help_result['stderr']}")
        diagnostics = f"$ vllm serve --help=all\n{help_result['stdout']}\n{help_result['stderr']}"
        if help_result["exit_code"] != 0 or not _has_required(adapter, flags):
            fallback = docker_runner(
                ["docker", "run", "--rm", "--pull=never", "--network=none", "--cap-drop=ALL", "--pids-limit", "256", "--entrypoint", "vllm", run_reference, "serve", "--help"],
                timeout_seconds=120,
            )
            flags = _extract_flags(f"{fallback['stdout']}\n{fallback['stderr']}")
            diagnostics = f"{diagnostics}\n$ vllm serve --help\n{fallback['stdout']}\n{fallback['stderr']}"
            if fallback["exit_code"] != 0:
                raise ContractError(
                    "runtime_cli_unavailable",
                    f"Unable to read vLLM CLI help from the selected image.",
                    {"diagnostics": diagnostics[-4000:]},
                    remediation="Verify the image digest matches a vLLM image with the `vllm` entrypoint.",
                )
        _require_flags(adapter, flags, diagnostics)
        return {"entrypoint": "vllm", "entrypoint_args": [], "flags": flags, "diagnostics": diagnostics}
    attempts: list[dict[str, Any]] = []
    for executable in ("python3", "python"):
        result = docker_runner(
            ["docker", "run", "--rm", "--pull=never", "--network=none", "--cap-drop=ALL", "--pids-limit", "256", "--entrypoint", executable, run_reference, "-m", "sglang.launch_server", "--help"],
            timeout_seconds=120,
        )
        attempt = {"executable": executable, "result": result}
        attempts.append(attempt)
        flags = _extract_flags(f"{result['stdout']}\n{result['stderr']}")
        if result["exit_code"] != 0 or not _has_required(adapter, flags):
            continue
        diagnostics = "\n".join(
            f"$ {item['executable']} -m sglang.launch_server --help\n{item['result']['stdout']}\n{item['result']['stderr']}" for item in attempts
        )
        _require_flags(adapter, flags, diagnostics)
        return {"entrypoint": executable, "entrypoint_args": ["-m", "sglang.launch_server"], "flags": flags, "diagnostics": diagnostics}
    diagnostics = "\n".join(
        f"$ {item['executable']} -m sglang.launch_server --help\n{item['result']['stdout']}\n{item['result']['stderr']}" for item in attempts
    )
    raise ContractError(
        "runtime_cli_incompatible",
        "The selected SGLang image does not expose the required launch_server flags.",
        {"required_flags": list(adapter.REQUIRED_FLAGS), "diagnostics": diagnostics[-4000:]},
        remediation="Use an sglang-runtime image that ships sglang.launch_server with the standard server flags.",
    )


def _extract_flags(help_text: str) -> list[str]:
    import re

    return sorted(set(re.findall(r"--[a-z][a-z0-9-]*", help_text, re.IGNORECASE))) if help_text else []


def _has_required(adapter, flags: list[str]) -> bool:
    return all(flag in flags for flag in adapter.REQUIRED_FLAGS)


def _require_flags(adapter, flags: list[str], diagnostics: str) -> None:
    missing = [flag for flag in adapter.REQUIRED_FLAGS if flag not in flags]
    if missing:
        raise ContractError(
            "runtime_cli_incompatible",
            f"The selected {adapter.CAPABILITY_VERSION} image does not expose {', '.join(missing)}.",
            {"missing_flags": missing, "diagnostics": diagnostics[-4000:]},
            remediation="Verify the image digest and that it ships the standard server CLI.",
        )
