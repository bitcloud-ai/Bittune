"""Bounded, cancellation-aware subprocess execution.

Every Docker / probe / CLI call the Core makes goes through here: output is
capped, timeouts terminate the process group, and the request cancellation
event kills the child and raises the stable `cancelled` error so the Run is
always committed with an honest status.
"""

import subprocess
import threading
import time
from typing import Any

from bittune_core.contracts import ContractError

MAX_BYTES = 1024 * 1024
POLL_SECONDS = 0.2


def run_command(
    args: list[str],
    *,
    timeout_seconds: float = 60,
    max_bytes: int = MAX_BYTES,
    cancellation: Any | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    started = time.monotonic()

    def cancel_check() -> None:
        if cancellation is not None and hasattr(cancellation, "raise_if_requested"):
            cancellation.raise_if_requested()

    import os

    try:
        process = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            env=dict(os.environ, **env) if env else None,
        )
    except FileNotFoundError:
        # Missing probe binaries (nvidia-smi, docker, lscpu, …) are availability
        # flags, not Core crashes. inspect_environment catches ContractError.
        raise ContractError(
            "unavailable",
            f"{args[0]} 不可用。",
            {"command": args[0]},
        ) from None
    capture: dict[str, Any] = {"stdout": b"", "stderr": b"", "truncated": False}

    def read_stream(stream, key: str) -> None:
        try:
            while True:
                if stream is None:
                    return
                chunk = stream.read(65536)
                if not chunk:
                    return
                remaining = max_bytes - len(capture["stdout"]) - len(capture["stderr"])
                if remaining <= 0:
                    capture["truncated"] = True
                    continue
                part = chunk[:remaining]
                capture[key] += part
                if len(chunk) > remaining:
                    capture["truncated"] = True
        finally:
            if stream is not None:
                stream.close()

    readers = [
        threading.Thread(target=read_stream, args=(process.stdout, "stdout"), daemon=True),
        threading.Thread(target=read_stream, args=(process.stderr, "stderr"), daemon=True),
    ]
    for reader in readers:
        reader.start()

    timed_out = False
    try:
        while True:
            exit_code = process.poll()
            if exit_code is not None:
                break
            if time.monotonic() - started > timeout_seconds:
                timed_out = True
                break
            try:
                cancel_check()
            except ContractError:
                process.terminate()
                process.wait(timeout=5)
                raise
            time.sleep(POLL_SECONDS)
        if exit_code is None:
            process.terminate()
            try:
                exit_code = process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                exit_code = process.wait(timeout=5)
    finally:
        for reader in readers:
            reader.join(timeout=1)
    cancel_check()
    if timed_out:
        raise ContractError(
            "timeout",
            f"{args[0]} 在 {timeout_seconds}s 内未完成。",
            {"command": args[0]},
            remediation="增大超时或检查目标组件状态。",
        )
    return {
        "args": args,
        "exit_code": exit_code,
        "stdout": capture["stdout"].decode("utf-8", errors="replace"),
        "stderr": capture["stderr"].decode("utf-8", errors="replace"),
        "duration_ms": round((time.monotonic() - started) * 1000),
        "truncated": capture["truncated"],
    }


def wait_interval(seconds: float, cancellation: Any) -> None:
    """Cancel-aware sleep: checks the cancellation event every 0.2s slice."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if cancellation is not None and hasattr(cancellation, "raise_if_requested"):
            cancellation.raise_if_requested()
        time.sleep(min(POLL_SECONDS, deadline - time.monotonic()))