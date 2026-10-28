"""Environment and service inspection: deterministic, one-shot host probes.

`inspect_environment` never fails just because a device class is missing:
every probe result lands in an immutable HardwareSnapshot marked `detected`,
and missing tooling is recorded as an explicit availability flag. Deployment
validation is what turns missing facts into actionable refusals.

`inspect_service` is read-only: it reads stored ServiceInstances and refreshes
their Docker-side observation without ever changing ownership or state. list can
also report untracked containers, and those observations are not stored.
"""

import json
import re
import socket
import uuid
from typing import Any

from bittune_core.contracts import ContractError
from bittune_core.process import run_command
from bittune_core.runs import ManagedRun
from bittune_core.store import CoreStore, utc_now

MIB = 1024 * 1024
_NVIDIA_PROBES = {
    "nvbandwidth": ["nvbandwidth"],
    "nccl": ["all_reduce_perf", "-b", "8", "-e", "8", "-f", "2", "-g", "1", "-n", "1"],
    "dcgm": ["dcgmi", "discovery", "-l"],
}


def inspect_environment(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    cancellation = context["cancellation"]
    with ManagedRun(store, "inspect_environment", {}, context["session_id"], context) as run:
        probes: list[dict[str, Any]] = []
        gpus: list[dict[str, Any]] = []
        try:
            run.progress("读取 NVIDIA GPU 状态…")
            result = run_command(
                ["nvidia-smi", "--query-gpu=index,uuid,name,driver_version,compute_cap,memory.total,memory.free,utilization.gpu,power.draw", "--format=csv,noheader,nounits"],
                timeout_seconds=15,
                cancellation=cancellation,
            )
            raw = f"$ {' '.join(result['args'])}\n{result['stdout']}\n{result['stderr']}"
            probes.append({"label": "nvidia-smi-gpu", "content": raw})
            for line in result["stdout"].strip().splitlines():
                fields = [field.strip() for field in line.split(",")]
                if len(fields) < 9:
                    continue
                gpus.append(
                    {
                        "index": int(fields[0]),
                        "uuid": fields[1],
                        "name": fields[2],
                        "driver_version": fields[3],
                        "compute_capability": fields[4],
                        "memory_total_bytes": int(fields[5]) * MIB,
                        "memory_free_bytes": int(fields[6]) * MIB,
                        "utilization_percent": int(round(float(fields[7]))),
                        "power_watts": int(round(float(fields[8]))),
                    }
                )
        except ContractError as error:
            probes.append({"label": "nvidia-smi-error", "content": f"{error.code}: {error.message}"})
        cuda_version: str | None = None
        try:
            header = run_command(["nvidia-smi"], timeout_seconds=15, cancellation=cancellation)
            raw_header = f"$ nvidia-smi\n{header['stdout']}\n{header['stderr']}"
            probes.append({"label": "nvidia-smi-header", "content": raw_header})
            match = re.search(r"CUDA Version:\s*([0-9]+\.[0-9]+)", header["stdout"])
            if match:
                cuda_version = match.group(1)
        except ContractError as error:
            probes.append({"label": "nvidia-smi-header-error", "content": f"{error.code}: {error.message}"})
        host = _probe_host(probes, cancellation)
        docker = _probe_docker(probes, cancellation)
        requested = params.get("probes")
        if requested:
            _run_requested_probes(requested, probes, cancellation)
        for probe in probes:
            run.artifact(probe["label"], probe["content"])
        gpu_uuid = gpus[0]["uuid"] if gpus else socket.gethostname()
        snapshot_id = f"snapshot-{uuid.uuid4()}"
        snapshot: dict[str, Any] = {
            "schema_version": 1,
            "hardware_snapshot_id": snapshot_id,
            "observed_at": utc_now(),
            "host_id": gpu_uuid,
            "provenance": "detected",
            "gpus": gpus,
            "topology": {"gpu_count": len(gpus), "gpu_uuids": [item["uuid"] for item in gpus]},
            "nvidia_available": bool(gpus),
            **({"cuda_version": cuda_version} if cuda_version else {}),
            **host,
            "docker": docker,
        }
        store.put_hardware_snapshot(snapshot, run.run_id)
        warnings = []
        if not gpus:
            warnings.append("nvidia-smi 未检测到 NVIDIA GPU；受管 GPU 部署将被校验拒绝，可用 Bash 准备环境后重新 inspect_environment。")
        if docker.get("daemon") is None:
            warnings.append("Docker daemon 不可用；受管部署将被校验拒绝。")
        summary = f"已生成不可变 HardwareSnapshot {snapshot_id}：{len(gpus)} 张 GPU，Docker daemon {'可用' if docker.get('daemon') else '不可用'}。"
        return run.success(summary, {"hardware_snapshot": snapshot}, warnings or None)


def _run_requested_probes(names: Any, probes: list[dict[str, Any]], cancellation: Any) -> None:
    if not isinstance(names, list):
        raise ContractError("invalid_input", "probes 必须是列表。")
    for name in names:
        argv = _NVIDIA_PROBES.get(name)
        if argv is None:
            raise ContractError("invalid_input", f"不认识的探测项 {name}。", {"probe": name})
        try:
            result = run_command(argv, timeout_seconds=60, cancellation=cancellation)
            probes.append({"label": name, "content": f"$ {' '.join(argv)}\n{result['stdout']}\n{result['stderr']}"})
        except ContractError as error:
            if error.code == "unavailable":
                probes.append({"label": f"{name}-tool_missing", "content": f"tool_missing: {error.message}"})
            else:
                probes.append({"label": name, "content": f"{error.code}: {error.message}"})


def _probe_host(probes: list[dict[str, Any]], cancellation: Any) -> dict[str, Any]:
    host: dict[str, Any] = {}
    try:
        uname = run_command(["uname", "-srm"], timeout_seconds=10, cancellation=cancellation)
        probes.append({"label": "linux-host", "content": f"$ uname -srm\n{uname['stdout']}\n{uname['stderr']}"})
        host["kernel"] = uname["stdout"].strip()
    except ContractError as error:
        host["kernel"] = f"unavailable: {error.code}"
    cpu_rows: list[list[str]] = []
    try:
        lscpu = run_command(["lscpu"], timeout_seconds=10, cancellation=cancellation)
        cpu_rows = [line.split(":", 1) for line in lscpu["stdout"].splitlines() if ":" in line]
        host["cpu"] = {key.strip().split(" ")[0]: value.strip() for key, value in cpu_rows}
    except ContractError:
        host["cpu"] = {}
    try:
        memory = run_command(["free", "-b"], timeout_seconds=10, cancellation=cancellation)
        line = next((item for item in memory["stdout"].splitlines() if item.startswith("Mem:")), "")
        fields = line.split()
        host["memory"] = {"total_bytes": int(fields[1]) if len(fields) > 1 else 0, "available_bytes": int(fields[6]) if len(fields) > 6 else 0}
    except ContractError:
        host["memory"] = {}
    try:
        os_release = run_command(["cat", "/etc/os-release"], timeout_seconds=10, cancellation=cancellation)
        host["os"] = _parse_key_value(os_release["stdout"])
    except ContractError:
        host["os"] = {}
    return host


def _probe_docker(probes: list[dict[str, Any]], cancellation: Any) -> dict[str, Any]:
    docker: dict[str, Any] = {"daemon": None}
    try:
        version = run_command(["docker", "version", "--format", "{{json .}}"], timeout_seconds=15, cancellation=cancellation)
        info = run_command(["docker", "info", "--format", "{{json .}}"], timeout_seconds=15, cancellation=cancellation)
        content = f"$ docker version\n{version['stdout']}\n{version['stderr']}\n$ docker info\n{info['stdout']}\n{info['stderr']}"
        probes.append({"label": "docker-runtime", "content": content})
        if version["exit_code"] == 0 and info["exit_code"] == 0:
            info_data = _safe_json(info["stdout"]) or {}
            runtimes = list((info_data.get("Runtimes") or {}).keys())
            version_data = _safe_json(version["stdout"]) or {}
            client = version_data.get("Client", {}) if isinstance(version_data.get("Client"), dict) else {}
            server = version_data.get("Server", {}) if isinstance(version_data.get("Server"), dict) else {}
            docker = {
                "daemon": True,
                "client_version": client.get("Version"),
                "server_version": server.get("Version") or info_data.get("ServerVersion"),
                "storage_driver": info_data.get("Driver"),
                "runtimes": runtimes,
                "nvidia_runtime_registered": "nvidia" in runtimes,
            }
        else:
            probes[-1]["content"] = f"{content}\n[unavailable]"
    except ContractError:
        pass
    return docker


def _parse_key_value(text: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in text.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        result[key] = value.strip().strip('"')
    return result


def _safe_json(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _docker_inspect(store: CoreStore, service: dict[str, Any], cancellation: Any) -> dict[str, Any]:
    container_id = service.get("container_id")
    if not container_id:
        return {"status": "no_container", "running": False}
    result = run_command(
        ["docker", "container", "inspect", container_id, "--format", "{{json .}}"],
        timeout_seconds=15,
        cancellation=cancellation,
    )
    if result["exit_code"] != 0:
        return {"status": "docker_inspect_failed", "running": False, "error": result["stderr"][:300]}
    data = _safe_json(result["stdout"]) or {}
    state = data.get("State") or {}
    return {
        "status": state.get("Status", "unknown"),
        "running": bool(state.get("Running")),
        "exit_code": state.get("ExitCode"),
        "oom_killed": bool(state.get("OOMKilled")),
    }


def _untracked_containers(known_ids: set[str], cancellation: Any) -> list[dict[str, str]]:
    try:
        result = run_command(
            ["docker", "ps", "--no-trunc", "--format", "{{json .}}"],
            timeout_seconds=15,
            cancellation=cancellation,
        )
    except ContractError as error:
        if error.code == "cancelled":
            raise
        return []
    if result["exit_code"] != 0:
        return []
    found: list[dict[str, str]] = []
    for line in result["stdout"].splitlines():
        item = _safe_json(line)
        if not isinstance(item, dict):
            continue
        container_id = item.get("ID")
        if not isinstance(container_id, str) or not container_id or container_id in known_ids:
            continue
        image = item.get("Image") if isinstance(item.get("Image"), str) else ""
        command = item.get("Command") if isinstance(item.get("Command"), str) else ""
        ports = item.get("Ports") if isinstance(item.get("Ports"), str) else ""
        kind = _container_runtime_kind(image, command)
        endpoint = _published_endpoint(ports)
        if kind is None or endpoint is None:
            continue
        found.append({"container_id": container_id, "image": image, "endpoint": endpoint, "runtime_kind": kind})
    return found


def _container_runtime_kind(image: str, command: str) -> str | None:
    text = f"{image}\n{command}".lower()
    if "sglang" in text:
        return "sglang"
    if "vllm" in text:
        return "vllm"
    return None


def _published_endpoint(ports: str) -> str | None:
    match = re.search(r":(\d+)->", ports)
    if match is None:
        return None
    return f"http://127.0.0.1:{match.group(1)}"


def inspect_service(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    cancellation = context["cancellation"]
    action = params.get("action")
    with ManagedRun(store, "inspect_service", params, context["session_id"], context) as run:
        if action == "get":
            service_id = params.get("service_instance_id")
            if not isinstance(service_id, str) or not service_id:
                raise ContractError("invalid_input", "get 需要 service_instance_id。", remediation="先用 action=list 找到服务 ID。")
            fact = store.get_fact("service_instance", service_id)
            service = fact["payload"]
            state = _docker_inspect(store, service, cancellation) if service.get("container_id") else {"status": "no_container", "running": False}
            service["last_observed_at"] = utc_now()
            store.put_service_instance(service, run.run_id)
            return run.success(
                f"服务 {service_id} 当前状态为 {state.get('status')}（ownership={service.get('ownership')}）。",
                {"service": service, "current_container_state": state},
            )
        rows = store.list_facts("service_instance", limit=100)
        services = []
        known_ids: set[str] = set()
        for row in rows:
            container_id = row["payload"].get("container_id")
            if isinstance(container_id, str) and container_id:
                known_ids.add(container_id)
            state = _docker_inspect(store, row["payload"], cancellation) if row["payload"].get("container_id") else {"status": "no_container", "running": False}
            services.append({"service": row["payload"], "current_container_state": state})
        untracked = _untracked_containers(known_ids, cancellation)
        summary = f"发现 {len(services)} 个已记录的服务观察（managed/observed/external 均可读，不做任何变更）。"
        if untracked:
            summary += f"另有 {len(untracked)} 个未跟踪容器，未写入服务事实。"
        return run.success(summary, {"services": services, "untracked": untracked})
