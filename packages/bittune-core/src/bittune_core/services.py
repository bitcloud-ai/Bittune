"""Managed service lifecycle: start/stop/recover over host Docker.

Managed ownership is proven twice - by the local record (ownership=managed)
and by the container labels written at creation. stop/recover refuse anything
that lacks either proof; containers started by Agent Bash never qualify and
are never touched. The Core never pulls images or downloads models here, and
every start re-checks the frozen plan's prerequisites right before `docker
run` instead of trusting an earlier Bash success.
"""

import json
import urllib.request
import uuid
from typing import Any

from bittune_core.adapters import inspect_image_cli, require_adapter
from bittune_core.contracts import ContractError
from bittune_core.plans import model_path_in_container, resolve_image, resolve_model_snapshot, validate_plan
from bittune_core.process import run_command, wait_interval
from bittune_core.runs import ManagedRun
from bittune_core.store import CoreStore, utc_now

READY_POLL_SECONDS = 2
DEFAULT_READY_TIMEOUT_SECONDS = 300


def deploy_service(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    cancellation = context["cancellation"]
    with ManagedRun(store, "deploy_service", params, context["session_id"], context) as run:
        action = params.get("action")
        if action == "start":
            return _start(params, store, run, cancellation, context.get('task_scope'))
        service_id = params.get("service_instance_id")
        if not isinstance(service_id, str) or not service_id.startswith("service-"):
            raise ContractError("invalid_input", "stop/recover 需要 service_instance_id。", remediation="deploy_service.stop(service_instance_id=…) 只作用于受管服务。")
        fact = _require_managed_row(store, service_id)
        service = fact["payload"]
        if action == "stop":
            return _stop(service, store, run, cancellation)
        if action == "recover":
            return _recover(service, store, run, cancellation)
        raise ContractError("invalid_input", f"Unknown deploy action {action!r}.", {"action": action})


def _start(params: dict[str, Any], store: CoreStore, run: ManagedRun, cancellation: Any, task_scope=None) -> dict[str, Any]:
    plan_id = params.get("plan_id")
    if not isinstance(plan_id, str) or not plan_id.startswith("plan-"):
        raise ContractError("invalid_input", "start 需要 frozen plan 的 plan_id。", remediation="plan_deployment(create → validate → freeze) 之后，用 frozen plan 启动。")
    plan = store.get_fact("deployment_plan", plan_id)["payload"]
    if plan["status"] != "frozen":
        raise ContractError(
            "plan_not_frozen",
            f"Plan {plan_id} 尚未冻结（status={plan['status']}）。",
            {"plan_id": plan_id},
            remediation="先执行 plan_deployment(action=freeze)，用户确认后才会冻结。",
        )
    ready_timeout = params.get("ready_timeout_seconds", DEFAULT_READY_TIMEOUT_SECONDS)
    if not isinstance(ready_timeout, int) or isinstance(ready_timeout, bool) or not (0 <= ready_timeout <= 900):
        raise ContractError("invalid_input", "ready_timeout_seconds 必须是 0..900 的整数。", {"ready_timeout_seconds": ready_timeout})

    # Replay every frozen-plan gate immediately before creating a container.
    # This closes the validate/freeze/start gap for hardware, policy, image,
    # model and adapter inputs instead of rechecking only two fields.
    replay = validate_plan(store, plan, run, cancellation)
    if replay["state"] != "valid":
        raise ContractError(
            "plan_not_attemptable",
            "冻结计划在启动前重放校验未通过，未创建容器。",
            {"plan_id": plan_id, "errors": replay["errors"]},
            remediation="刷新 HardwareSnapshot/本地镜像/模型缓存后重新 validate；配置变更请新建 plan。",
        )
    model_ref = plan["model_ref"]
    runtime_spec = plan["runtime_spec"]
    adapter = require_adapter(runtime_spec["runtime_kind"])
    serving_spec = adapter.materialize(plan["serving_spec"])

    run.progress("部署前复核镜像与模型…")
    image = resolve_image(runtime_spec, cancellation)
    if image is None:
        raise ContractError(
            "image_missing",
            f"本地没有镜像 {runtime_spec['image_repository']}@{runtime_spec['image_digest']}。",
            remediation="Core 不隐式拉取镜像；用 Bash 执行 docker pull 后重试。",
        )
    mount = resolve_model_snapshot(model_ref["model_id"], model_ref["revision"], model_ref.get("local_path"), cancellation)
    if mount is None:
        raise ContractError(
            "model_snapshot_missing",
            f"本地缓存中没有模型 {model_ref['model_id']}@{model_ref['revision']}。",
            remediation="Core 不隐式下载模型；用 Bash 准备模型缓存后重试。",
        )

    run.progress("读取所选镜像的 CLI 能力…")
    cli = inspect_image_cli(runtime_spec["runtime_kind"], lambda args, timeout_seconds=60: run_command(args, timeout_seconds=timeout_seconds, cancellation=cancellation), image["run_reference"])
    run.artifact(f"{runtime_spec['runtime_kind']}-cli-profile", cli["diagnostics"][-64_000:])
    engine_args = adapter.compile_engine_args(serving_spec, cli["flags"])

    service_id = f"service-{uuid.uuid4()}"
    container_name = f"bittune-{service_id}"
    layout = _docker_run_args(
        runtime_kind=runtime_spec["runtime_kind"],
        container_name=container_name,
        service_id=service_id,
        plan_id=plan_id,
        gpu_args=adapter.compile_docker_gpu_args(serving_spec),
        mount_root=mount["root"],
        entrypoint=cli["entrypoint"] if runtime_spec["runtime_kind"] == "sglang" else None,
        image=image["run_reference"],
        entrypoint_args=cli["entrypoint_args"],
        launch=adapter.launch_args(model_path_in_container(mount), model_ref["model_id"], engine_args),
    )
    run.progress(f"启动受管 {runtime_spec['runtime_kind']} 容器 {container_name}…")
    started = run_command(layout, timeout_seconds=120, max_bytes=1024 * 1024, cancellation=cancellation)
    run.artifact("docker-run", f"$ {' '.join(layout)}\n{started['stdout']}\n{started['stderr']}")
    if started["exit_code"] != 0:
        last_line = (started["stderr"] or started["stdout"]).strip().splitlines()[-1:] or ["无输出"]
        raise ContractError(
            "container_launch_failed",
            f"docker run 失败：{last_line[0][:300]}",
            {"exit_code": started["exit_code"]},
            remediation="检查 Docker daemon、GPU 运行时注册与日志 Artifact。",
        )
    container_id = started["stdout"].strip()
    if not container_id or not container_id[:1].isalnum():
        raise ContractError("provider_error", "Docker 未返回合法的容器 ID。", {"stdout": container_id[:200]})

    # Persist the managed record before deriving runtime state, then observe.
    service: dict[str, Any] = {
        "schema_version": 1,
        "service_instance_id": service_id,
        "plan_id": plan_id,
        "ownership": "managed",
        "model_ref": model_ref,
        "runtime_spec": runtime_spec,
        "serving_spec": serving_spec,
        "engine_args": engine_args,
        "container_id": container_id,
        "container_name": container_name,
        "endpoint": None,
        "port": None,
        "desired": "running",
        "observed_state": "created",
        "observed_at": utc_now(),
        "last_observed_at": utc_now(),
        "created_at": utc_now(),
        "config_hash": adapter.fingerprint(serving_spec),
        "provenance": "measured",
    }
    store.put_service_instance(service, run.run_id)
    if task_scope is not None:
        task_scope.services.add(service_id)

    inspection = _inspect_container(container_id, cancellation)
    if not inspection["running"]:
        logs = _docker_logs(container_id, cancellation)
        log_ref = run.artifact("docker-start-failure-logs", logs["raw"])
        service["observed_state"] = inspection["status"]
        store.put_service_instance(service, run.run_id)
        raise ContractError(
            "container_start_failed",
            f"受管容器 {service_id} 启动后未保持运行（{inspection['status']}）。",
            {"log_artifact_id": log_ref["artifact_id"], "log_excerpt": logs["raw"][-4096:]},
            remediation=f"读取 Artifact {log_ref['artifact_id']} 定位启动失败原因。",
        )
    port = _loopback_port(inspection)
    service["endpoint"] = f"http://127.0.0.1:{port}"
    service["port"] = port
    service["observed_state"] = inspection["status"]
    store.put_service_instance(service, run.run_id)

    if ready_timeout > 0:
        run.progress("容器已启动，等待服务 Ready…")
        elapsed, ready, last_error = _wait_ready(service, ready_timeout, run, cancellation)
        if ready:
            service["observed_state"] = "ready"
        service["ready_elapsed_ms"] = int(elapsed * 1000)
        service["last_observed_at"] = utc_now()
        store.put_service_instance(service, run.run_id)
        if not ready:
            raise ContractError(
                "runtime_not_ready",
                f"服务 {service_id} 在 {ready_timeout}s 内未 Ready。",
                {"service_instance_id": service_id, "last_error": last_error, "endpoint": service["endpoint"], "observed_state": service["observed_state"], "artifact_ids": [ref["artifact_id"] for ref in run.artifact_refs]},
                remediation=f"读取容器日志（inspect_records 回查本轮 Artifact）判断模型加载状态后重试或调整配置。",
            )
    else:
        run.progress("跳过 Ready 等待（ready_timeout_seconds=0）。")

    summary = f"受管 {runtime_spec['runtime_kind']} 服务 {service_id} 已{' Ready' if ready_timeout > 0 else ' 启动'}（endpoint {service['endpoint']}）。"
    return run.success(summary, {"service": service})


def _require_managed_row(store: CoreStore, service_id: str) -> dict[str, Any]:
    fact = store.get_fact("service_instance", service_id)
    if fact["payload"].get("ownership") != "managed":
        raise ContractError(
            "service_not_managed",
            f"服务 {service_id} 的 ownership={fact['payload'].get('ownership')}，BitTune 不拥有其生命周期。",
            {"service_instance_id": service_id, "ownership": fact["payload"].get("ownership")},
            remediation="external/observed 服务只能 inspect；只有 Core 从 frozen plan 启动的服务可被 stop/recover。",
        )
    return fact


def _stop(service: dict[str, Any], store: CoreStore, run: ManagedRun, cancellation: Any) -> dict[str, Any]:
    container_id = service.get("container_id")
    service_id = service["service_instance_id"]
    inspection: dict[str, Any] = {}
    if container_id:
        inspection = _inspect_container(container_id, cancellation)
        if inspection.get("status") == "docker_inspect_failed":
            raise ContractError(
                "provider_error",
                f"无法读取容器 {container_id} 状态，拒绝执行 stop。",
                {"container_id": container_id, "error": inspection.get("error")},
                remediation="确认 Docker daemon 可用并成功 inspect 后重试。",
            )
        _require_label_proof(service, inspection)
        stopped = run_command(["docker", "container", "stop", "--time", "30", container_id], timeout_seconds=60, cancellation=cancellation)
        run.artifact("docker-stop", f"$ docker container stop {container_id}\n{stopped['stdout']}\n{stopped['stderr']}")
        if stopped["exit_code"] != 0 and "is not running" not in stopped["stderr"].lower():
            raise ContractError(
                "container_stop_failed",
                f"docker stop 失败：{stopped['stderr'][-300:]}",
                {"exit_code": stopped["exit_code"]},
                remediation="检查 Docker daemon 或重试 deploy_service(stop)。",
            )
        logs = _docker_logs(container_id, cancellation)
        run.artifact("docker-stop-logs", logs["raw"])
        inspection = _inspect_container(container_id, cancellation)
        if inspection.get("status") != "docker_inspect_failed":
            _require_label_proof(service, inspection)
        run.artifact("docker-stop-state", json.dumps(inspection, ensure_ascii=False), "application/json")
    service["desired"] = "stopped"
    service["observed_state"] = inspection.get("status") or "stopped"
    service["observed_at"] = utc_now()
    service["last_observed_at"] = utc_now()
    store.put_service_instance(service, run.run_id)
    confirmed = not container_id or inspection.get("status") in ("exited", "dead")
    summary = f"已停止受管服务 {service_id}。" if confirmed else f"停止命令已执行，服务 {service_id} 的当前观测状态为 {service['observed_state']}。"
    return run.success(summary, {"service": service}, None if confirmed else ["停止后的真实状态尚未确认；请复核本轮服务与 GPU 状态。"])


def _recover(service: dict[str, Any], store: CoreStore, run: ManagedRun, cancellation: Any) -> dict[str, Any]:
    service_id = service["service_instance_id"]
    container_id = service.get("container_id")
    if not container_id:
        store.put_service_instance(service, run.run_id)
        return run.success(f"服务 {service_id} 没有容器记录，无可恢复的真实状态。", {"service": service}, warnings=["该记录无 container_id；用 frozen plan 重新 start，或停止引用。"])

    inspection = _inspect_container(container_id, cancellation)
    if inspection.get("status") == "docker_inspect_failed":
        raise ContractError(
            "provider_error",
            f"无法读取容器 {container_id} 状态：{inspection.get('error', '未知')}",
            {"container_id": container_id},
            remediation="确认 Docker daemon 可用后重试 recover。",
        )
    _require_label_proof(service, inspection)
    logs = _docker_logs(container_id, cancellation)
    run.artifact("docker-recover-logs", logs["raw"])
    service["observed_state"] = inspection["status"]
    service["observed_at"] = utc_now()
    service["last_observed_at"] = utc_now()
    if inspection["running"]:
        port = _loopback_port(inspection)
        service["endpoint"] = f"http://127.0.0.1:{port}"
        service["port"] = port
    else:
        warnings = [f"容器 {container_id} 当前未运行（{inspection.get('status')}）；本地记录已与真实状态对齐。若需服务，请检查日志后用 frozen plan 重新 start。"]
        store.put_service_instance(service, run.run_id)
        return run.success(f"服务 {service_id} 已与真实容器状态对齐（{inspection['status']}）。", {"service": service}, warnings)
    store.put_service_instance(service, run.run_id)
    return run.success(f"服务 {service_id} 已恢复对齐（{inspection['status']}，endpoint {service['endpoint']}）。", {"service": service})


def _docker_run_args(*, runtime_kind: str, container_name: str, service_id: str, plan_id: str, gpu_args: list[str], mount_root: str, entrypoint: str | None, image: str, entrypoint_args: list[str], launch: list[str]) -> list[str]:
    args = [
        "docker", "run", "-d", "--pull=never", "--name", container_name,
        "--label", "bittune.managed=true",
        "--label", f"bittune.service_id={service_id}",
        "--label", f"bittune.plan_id={plan_id}",
        *gpu_args,
        "--ipc", "private",
        "--shm-size", "8g",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", "4096",
        "-p", "127.0.0.1::8000",
        "-v", f"{mount_root}:/root/.cache/huggingface:ro",
        "--env", "HF_HUB_OFFLINE=1",
        "--env", "TRANSFORMERS_OFFLINE=1",
        "--env", "HF_DATASETS_OFFLINE=1",
        "--env", "HF_HUB_DISABLE_TELEMETRY=1",
    ]
    if runtime_kind == "sglang" and entrypoint:
        args += ["--entrypoint", entrypoint]
    args.append(image)
    args += entrypoint_args
    args += launch
    return args


def _inspect_container(container_id: str, cancellation: Any) -> dict[str, Any]:
    result = run_command(
        ["docker", "container", "inspect", container_id, "--format", "{{json .}}"],
        timeout_seconds=15,
        cancellation=cancellation,
    )
    if result["exit_code"] != 0:
        return {"status": "docker_inspect_failed", "running": False, "error": (result["stderr"] or "unknown")[:300]}
    data = _safe_json(result["stdout"])
    if not isinstance(data, dict):
        return {"status": "docker_inspect_failed", "running": False, "error": "docker inspect 输出无法解析。"[:300]}
    state = data.get("State") or {}
    return {
        "status": state.get("Status", "unknown"),
        "running": bool(state.get("Running")),
        "exit_code": state.get("ExitCode"),
        "oom_killed": bool(state.get("OOMKilled")),
        "ports": (data.get("NetworkSettings") or {}).get("Ports") or {},
        "labels": (data.get("Config") or {}).get("Labels") or {},
    }


def _require_label_proof(service: dict[str, Any], inspection: dict[str, Any]) -> None:
    labels = inspection.get("labels") or {}
    if (
        labels.get("bittune.managed") != "true"
        or labels.get("bittune.service_id") != service["service_instance_id"]
        or labels.get("bittune.plan_id") != service.get("plan_id")
    ):
        raise ContractError(
            "service_not_managed",
            f"容器 {service.get('container_id')} 缺少与本地记录一致的 bittune 归属标签。",
            {"container_id": service.get("container_id")},
            remediation="Bash 直接创建的容器没有 managed 标签，BitTune 拒绝 stop/recover。",
        )


def _loopback_port(inspection: dict[str, Any]) -> int:
    bindings = (inspection.get("ports") or {}).get("8000/tcp")
    for binding in bindings or []:
        if binding.get("HostIp") == "127.0.0.1" and isinstance(binding.get("HostPort"), str):
            port = int(binding["HostPort"])
            if 1024 <= port <= 65535:
                return port
    raise ContractError(
        "docker_port_unavailable",
        "Docker 未为容器分配 8000 的 loopback 端口。",
        {"ports": inspection.get("ports")},
        remediation="容器端口发布失败；读取 docker-run Artifact 或 Docker 日志定位。",
    )


def _docker_logs(container_id: str, cancellation: Any) -> dict[str, str]:
    result = run_command(
        ["docker", "container", "logs", "--timestamps", "--tail", "200", container_id],
        timeout_seconds=20,
        max_bytes=512 * 1024,
        cancellation=cancellation,
    )
    raw = result["stdout"] + (f"\n[stderr]\n{result['stderr']}" if result["stderr"] else "")
    return {"raw": raw, "available": result["exit_code"] == 0}


def _wait_ready(service: dict[str, Any], timeout_seconds: int, run: ManagedRun, cancellation: Any) -> tuple[float, bool, str]:
    import time

    started = time.monotonic()
    deadline = started + timeout_seconds
    last_error = ""
    attempts = 0
    while time.monotonic() < deadline:
        if hasattr(cancellation, "raise_if_requested"):
            cancellation.raise_if_requested()
        attempts += 1
        run.progress(f"Ready 探测 {attempts}…")
        inspection = _inspect_container(service["container_id"], cancellation)
        if inspection.get("status") in ("exited", "dead"):
            _require_label_proof(service, inspection)
            service["observed_state"] = inspection["status"]
            run.artifact("docker-ready-exit-state", json.dumps(inspection, ensure_ascii=False), "application/json")
            logs = _docker_logs(service["container_id"], cancellation)
            log_ref = run.artifact("docker-ready-exit-logs", logs["raw"])
            last_error = f"container {inspection['status']}; exit_code={inspection.get('exit_code')}; oom_killed={inspection.get('oom_killed')}; log_artifact_id={log_ref['artifact_id']}"
            return time.monotonic() - started, False, last_error
        try:
            request = urllib.request.Request(f"{service['endpoint']}/v1/models", headers={"Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=5) as response:
                if response.status == 200:
                    return time.monotonic() - started, True, ""
                last_error = f"HTTP {response.status}"
        except Exception as error:  # noqa: BLE001 - endpoint probing is best-effort
            if hasattr(cancellation, "raise_if_requested"):
                cancellation.raise_if_requested()
            last_error = str(error)[:200]
        wait_interval(min(READY_POLL_SECONDS, deadline - time.monotonic()), cancellation)
    return time.monotonic() - started, False, last_error


def _safe_json(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None
