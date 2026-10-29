"""DeploymentPlan: draft -> validate -> freeze.

The Core validates a scheme is *attemptable on this host*: exact references
exist and are fresh, the adapter compiles the configuration, model weights and
the pinned image are present locally, GPU/topology constraints hold, and the
image repository passes the host policy. It never judges whether the plan is
the optimal engineering choice, and it promises nothing about start success.
"""

import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from bittune_core.adapters import require_adapter
from bittune_core.contracts import ContractError
from bittune_core.process import run_command
from bittune_core.local_model import local_model_identity
from bittune_core.runs import ManagedRun
from bittune_core.store import CoreStore, utc_now

SNAPSHOT_MAX_AGE_HOURS = 24
_MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)?$")
_REVISION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$")
_DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
_REPOSITORY = re.compile(r"^[a-z0-9][a-z0-9._:/-]{0,255}$")
_QUANTIZATION = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_RUNTIME_MAJOR = re.compile(r"^[0-9]{1,16}$")
_WEIGHTS = re.compile(r"\.(safetensors|bin|pt|pth|gguf)$", re.IGNORECASE)


def plan_deployment(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    cancellation = context["cancellation"]
    with ManagedRun(store, "plan_deployment", params, context["session_id"], context) as run:
        action = params.get("action")
        if action == "create":
            return _create(params, store, run, cancellation)
        if "prior_source" in params or "based_on_plan_id" in params:
            raise ContractError("invalid_input", "validate 和 freeze 不接收 prior_source 或 based_on_plan_id。")
        plan_id = params.get("plan_id")
        if not isinstance(plan_id, str) or not plan_id.startswith("plan-"):
            raise ContractError("invalid_input", "validate/freeze 需要 plan_id。", remediation="先用 action=create 建立 draft 计划。")
        plan_fact = store.get_fact("deployment_plan", plan_id)
        plan = plan_fact["payload"]
        if plan.get("status") == "frozen":
            raise ContractError(
                "state_conflict",
                "Plan 已冻结为不可变快照。",
                {"plan_id": plan_id},
                remediation="需要不同配置时新建 draft，而不是修改已冻结计划。",
            )
        if action == "validate":
            plan["validation"] = validate_plan(store, plan, run, cancellation)
            store.put_deployment_plan(plan, run.run_id, expected_content_hash=plan_fact["content_hash"])
            return run.success(f"Plan {plan_id} 校验{['失败', '通过'][int(plan['validation']['state'] == 'valid')]}。", {"plan": plan, "validation": plan["validation"]})
        if action == "freeze":
            run.progress("冻结前重新校验资源和前置条件…")
            plan["validation"] = validate_plan(store, plan, run, cancellation)
            if plan["validation"]["state"] != "valid":
                raise ContractError(
                    "plan_not_attemptable",
                    "冻结前校验未通过，计划保持 draft。",
                    {"plan_id": plan_id, "errors": plan["validation"]["errors"]},
                    remediation="按 errors 逐项修正后重新 validate，再 freeze。",
                )
            plan["status"] = "frozen"
            plan["frozen_at"] = utc_now()
            store.put_deployment_plan(plan, run.run_id, expected_content_hash=plan_fact["content_hash"])
            return run.success(f"Plan {plan_id} 已冻结：配置固化为不可变快照，可用于 deploy_service.start。", {"plan": plan})
        raise ContractError("invalid_input", f"Unknown plan action {action!r}.", {"action": action})


_PRIOR_SOURCES = ("user_specified", "none")


def _create(params: dict[str, Any], store: CoreStore, run: ManagedRun, cancellation: Any = None) -> dict[str, Any]:
    prior_source = params.get("prior_source")
    if prior_source not in _PRIOR_SOURCES:
        raise ContractError("invalid_input", "prior_source 必填，取值为 user_specified 或 none。", {"field": "prior_source"})
    copied = _copied_plan(store, params.get("based_on_plan_id"))
    goal = params.get("goal") if isinstance(params.get("goal"), str) else ""
    rationale = params.get("rationale") if isinstance(params.get("rationale"), str) else ""
    runtime_spec = _normalize_runtime_spec(_taken(params, copied, "runtime_spec"))
    adapter = require_adapter(runtime_spec["runtime_kind"])
    serving_spec = adapter.materialize(_taken(params, copied, "serving_spec") or {})
    model_input = _taken(params, copied, "model_ref")
    if isinstance(model_input, dict) and "local_path" in model_input:
        run.progress("只读计算本地模型内容身份，权重不会被复制或修改…")
    model_ref = _normalize_model_ref(model_input, cancellation)
    hardware_snapshot_id = params.get("hardware_snapshot_id") if "hardware_snapshot_id" in params else (copied or {}).get("hardware_snapshot_id")
    if isinstance(hardware_snapshot_id, str) and hardware_snapshot_id:
        store.get_fact("hardware_snapshot", hardware_snapshot_id)
    resource_choices = params.get("resource_choices") if isinstance(params.get("resource_choices"), dict) else {}
    plan_id = f"plan-{uuid.uuid4()}"
    plan: dict[str, Any] = {
        "schema_version": 1,
        "plan_id": plan_id,
        "status": "draft",
        "goal": goal,
        "rationale": rationale,
        "model_ref": model_ref,
        "runtime_spec": runtime_spec,
        "serving_spec": serving_spec,
        "hardware_snapshot_id": hardware_snapshot_id or None,
        "resource_choices": resource_choices,
        "prior_source": prior_source,
        "provenance": "declared",
        "created_at": utc_now(),
        "validation": {
            "state": "not_validated",
            "checks": [],
            "errors": [],
            "message": "draft 已保存；调用 plan_deployment(action=validate) 做确定性校验。",
        },
    }
    if copied is not None:
        plan["derived_from"] = copied["plan_id"]
    store.put_deployment_plan(plan, run.run_id)
    return run.success(f"Draft 计划 {plan_id} 已保存，尚未校验。", {"plan": plan})


def _copied_plan(store: CoreStore, plan_id: Any) -> dict[str, Any] | None:
    if plan_id is None:
        return None
    if not isinstance(plan_id, str) or not plan_id.startswith("plan-"):
        raise ContractError("invalid_input", "based_on_plan_id 必须是计划 ID。", {"field": "based_on_plan_id"})
    return store.get_fact("deployment_plan", plan_id)["payload"]


def _taken(params: dict[str, Any], copied: dict[str, Any] | None, key: str) -> Any:
    if params.get(key) is not None:
        return params.get(key)
    if copied is not None:
        return copied.get(key)
    return None




def validate_plan(store: CoreStore, plan: dict[str, Any], run: ManagedRun, cancellation: Any) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    def check(name: str, ok: bool, detail: str, error: dict[str, Any] | None = None) -> None:
        checks.append({"name": name, "ok": ok, "detail": detail})
        if not ok and error:
            errors.append({"check": name, **error})

    model_ref = plan["model_ref"]
    runtime_spec = plan["runtime_spec"]
    adapter = require_adapter(runtime_spec["runtime_kind"])

    snapshot: dict[str, Any] | None = None
    if plan.get("hardware_snapshot_id"):
        try:
            snapshot = store.get_fact("hardware_snapshot", plan["hardware_snapshot_id"])["payload"]
            _check_snapshot_fresh(snapshot)
            check("hardware_snapshot", True, f"引用 HardwareSnapshot {plan['hardware_snapshot_id']} 存在且新鲜。")
        except ContractError as error:
            snapshot = None
            check("hardware_snapshot", False, error.message, error.to_result())
    else:
        check("hardware_snapshot", False, "计划未引用 HardwareSnapshot。", {"code": "hardware_snapshot_missing", "message": "计划未引用 HardwareSnapshot。", "remediation": "先 inspect_environment，再 create 时传入 hardware_snapshot_id。"})

    try:
        adapter.materialize(plan["serving_spec"])
        check("adapter_compile", True, f"{runtime_spec['runtime_kind']} serving_spec 可编译。")
    except ContractError as error:
        check("adapter_compile", False, error.message, error.to_result())

    mount = resolve_model_snapshot(model_ref["model_id"], model_ref["revision"], model_ref.get("local_path"), cancellation)
    if mount is None:
        check(
            "model_available",
            False,
            f"本地缓存中没有模型 {model_ref['model_id']}@{model_ref['revision']}（或缺少权重文件）。",
            {
                "code": "model_snapshot_missing",
                "message": f"本地没有模型 {model_ref['model_id']}@{model_ref['revision']}。",
                "remediation": "Core 不隐式下载模型；用 Bash 准备（如 hf download）到本地缓存后重新 validate。",
            },
        )
    else:
        check("model_available", True, f"模型权重可读取：{mount['host_path']}")

    image = resolve_image(runtime_spec, cancellation)
    if image is None:
        check(
            "image_available",
            False,
            f"本地没有镜像 {runtime_spec['image_repository']}@{runtime_spec['image_digest']}。",
            {
                "code": "image_missing",
                "message": f"本地没有镜像 {runtime_spec['image_repository']}@{runtime_spec['image_digest']}。",
                "remediation": "Core 不隐式拉取镜像；用 Bash 执行 docker pull（经 Runtime Policy）后重新 validate。",
            },
        )
    else:
        check("image_available", True, f"镜像可用（image_id {image['image_id'][:19]}…）。")

    if snapshot:
        gpu_count = snapshot["topology"]["gpu_count"]
        workers = _parallel_workers(adapter, plan["serving_spec"])
        devices = plan["serving_spec"].get("gpu_device_ids") or []
        invalid = [index for index in devices if index >= gpu_count]
        if invalid:
            check(
                "gpu_topology",
                False,
                f"gpu_device_ids {invalid} 超出已观测 GPU 索引（共 {gpu_count} 张）。",
                {"code": "gpu_topology_mismatch", "message": f"GPU 索引 {invalid} 不在引用的 HardwareSnapshot 中。", "remediation": "调整 gpu_device_ids 或重新 inspect_environment。"},
            )
        elif not devices and workers > gpu_count:
            check(
                "gpu_topology",
                False,
                f"并行规模 {workers} 超过观测 GPU 数量 {gpu_count}。",
                {"code": "gpu_topology_mismatch", "message": f"并行规模 {workers} 超过观测 GPU 数量 {gpu_count}。", "remediation": "降低并行度或重新 inspect_environment。"},
            )
        else:
            check("gpu_topology", True, f"GPU 并行规模在观测拓扑内（{workers} ≤ {gpu_count}）。")

    if not _repository_allowed(runtime_spec["image_repository"], runtime_spec["image_digest"]):
        check(
            "image_policy",
            False,
            f"镜像仓库 {runtime_spec['image_repository']} 不在管理员策略允许列表内。",
            {"code": "runtime_repository_not_allowed", "message": f"镜像仓库 {runtime_spec['image_repository']} 不在管理员策略允许列表内。", "remediation": "更新宿主的 runtime-policy.json 或改用已允许的镜像仓库。"},
        )
    else:
        check("image_policy", True, "镜像仓库通过宿主策略。")

    ok = all(item["ok"] for item in checks)
    return {
        "state": "valid" if ok else "invalid",
        "checked_at": utc_now(),
        "checks": checks,
        "errors": errors,
        "message": "该方案可在当前主机上尝试。" if ok else "校验未通过；按 errors 逐项修正后重新 validate。",
    }


def _parallel_workers(adapter, serving_spec: dict[str, Any]) -> int:
    if adapter.__name__.endswith("vllm"):
        return serving_spec.get("tensor_parallel_size", 1) * serving_spec.get("pipeline_parallel_size", 1)
    return serving_spec.get("tensor_parallel_size", 1)


def _normalize_model_ref(value: Any, cancellation: Any = None) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError("invalid_input", "model_ref 必须是带 schema_version 的对象。", remediation="model_ref: {schema_version: 1, model_id, revision}。")
    if value.get("schema_version") != 1:
        raise ContractError("invalid_input", "model_ref.schema_version 必须为 1。", {})
    model_id = value.get("model_id")
    revision = value.get("revision")
    if not isinstance(model_id, str) or not _MODEL_ID.match(model_id):
        raise ContractError("invalid_input", "model_ref.model_id 格式不合法。", {})
    local_path = None
    if "local_path" in value:
        local_path, detected_revision = local_model_identity(value["local_path"], cancellation)
        if revision is not None and revision != detected_revision:
            raise ContractError("invalid_input", "本地目录的 revision 由 Core 按内容生成；创建时请省略 revision。")
        revision = detected_revision
    if not isinstance(revision, str) or not _REVISION.match(revision):
        raise ContractError("invalid_input", "model_ref.revision 必须是稳定的 revision 字符串。", {})
    # Optional quantization (phase 2): experiences export a fixed revision +
    # quantization, so plans may declare it. Plans without it stay fully
    # valid for local deployment; only the experience export refuses.
    quantization = value.get("quantization")
    if quantization is not None and (not isinstance(quantization, str) or not _QUANTIZATION.match(quantization)):
        raise ContractError("invalid_input", "model_ref.quantization 格式不合法。", {})
    normalized = {"schema_version": 1, "model_id": model_id, "revision": revision}
    if local_path is not None:
        normalized["local_path"] = local_path
    if quantization is not None:
        normalized["quantization"] = quantization
    return normalized


def _normalize_runtime_spec(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError("invalid_input", "runtime_spec 必须是带 schema_version 的对象。", remediation="runtime_spec: {schema_version: 1, runtime_kind, image_repository, image_digest}。")
    if value.get("schema_version") != 1:
        raise ContractError("invalid_input", "runtime_spec.schema_version 必须为 1。", {})
    runtime_kind = value.get("runtime_kind")
    require_adapter(runtime_kind)
    repository = value.get("image_repository")
    digest = value.get("image_digest")
    if not isinstance(repository, str) or not _REPOSITORY.match(repository):
        raise ContractError("invalid_input", "runtime_spec.image_repository 格式不合法。", {})
    if not isinstance(digest, str) or not _DIGEST.match(digest):
        raise ContractError("invalid_input", "runtime_spec.image_digest 必须是 sha256:<64 hex>。", {})
    if digest == "sha256:" + "0" * 64:
        raise ContractError("invalid_input", "runtime_spec.image_digest 不能是全零占位摘要；先查得真实镜像 digest。")
    # Optional runtime_major (phase 2): experiences export the runtime kind +
    # major version. Deployment semantics are unchanged when omitted; only
    # the experience export refuses to proceed without it.
    runtime_major = value.get("runtime_major")
    if runtime_major is not None and (not isinstance(runtime_major, str) or not _RUNTIME_MAJOR.match(runtime_major)):
        raise ContractError("invalid_input", "runtime_spec.runtime_major 必须是纯数字主版本。", {})
    normalized = {"schema_version": 1, "runtime_kind": runtime_kind, "image_repository": repository, "image_digest": digest}
    if runtime_major is not None:
        normalized["runtime_major"] = runtime_major
    return normalized


def _check_snapshot_fresh(snapshot: dict[str, Any]) -> None:
    observed_at = snapshot.get("observed_at") or ""
    try:
        observed = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
    except ValueError:
        raise ContractError("invalid_input", "HardwareSnapshot 缺少合法的 observed_at。", {})
    age = datetime.now(timezone.utc) - observed
    if age.total_seconds() > SNAPSHOT_MAX_AGE_HOURS * 3600:
        raise ContractError(
            "snapshot_stale",
            f"HardwareSnapshot 已观察 {int(age.total_seconds() // 3600)} 小时，超过 {SNAPSHOT_MAX_AGE_HOURS} 小时上限。",
            remediation="重新运行 inspect_environment 后更新计划引用。",
        )


def model_cache_roots() -> list[Path]:
    configured = os.environ.get("BITTUNE_MODEL_CACHE_ROOTS", "")
    roots = [Path(item).resolve() for item in configured.split(os.pathsep) if item.strip()]
    direct = os.environ.get("HF_HUB_CACHE") or os.environ.get("HF_HOME") or str(Path.home() / ".cache" / "huggingface")
    roots.append(Path(direct).resolve())
    seen: set[str] = set()
    result: list[Path] = []
    for root in roots:
        if str(root) not in seen:
            seen.add(str(root))
            result.append(root)
    return result


def resolve_model_snapshot(model_id: str, revision: str, local_path: Any = None, cancellation: Any = None) -> dict[str, str] | None:
    """Finds readable model weights for the exact revision; None when absent."""
    if local_path is not None:
        root, current_revision = local_model_identity(local_path, cancellation)
        if current_revision != revision:
            raise ContractError("model_content_changed", "本地模型内容与计划冻结的 revision 不一致，请新建计划。")
        return {"root": root, "host_path": root}
    snapshot_dir = f"models--{model_id.replace('/', '--')}/snapshots/{revision}"

    def has_weights(path: Path) -> bool:
        try:
            if not path.is_dir():
                return False
            resolved_path = path.resolve()
            for child in path.iterdir():
                resolved_child = child.resolve()
                if not resolved_child.is_relative_to(resolved_path):
                    continue
                if resolved_child.is_file() and _WEIGHTS.search(child.name):
                    return True
            return False
        except OSError:
            return False

    for root in model_cache_roots():
        for candidate in (root / "hub" / snapshot_dir, root / snapshot_dir):
            try:
                candidate.resolve().relative_to(root.resolve())
            except (OSError, ValueError):
                continue
            if has_weights(candidate):
                return {"root": str(root), "host_path": str(candidate.resolve())}
    return None


def model_path_in_container(mount: dict[str, str]) -> str:
    relative = Path(mount["host_path"]).relative_to(Path(mount["root"]))
    return f"/root/.cache/huggingface/{relative.as_posix()}"


def resolve_image(runtime_spec: dict[str, Any], cancellation: Any) -> dict[str, Any] | None:
    reference = f"{runtime_spec['image_repository']}@{runtime_spec['image_digest']}"
    direct = run_command(["docker", "image", "inspect", reference, "--format", "{{json .}}"], timeout_seconds=20, cancellation=cancellation)
    if direct["exit_code"] == 0:
        image = _safe_json(direct["stdout"])
        if isinstance(image, dict) and image.get("Id") and _image_digest_matches(image, runtime_spec["image_repository"], runtime_spec["image_digest"]):
            return _image_brief(image, reference, "repo_digest")
    loaded = run_command(["docker", "image", "inspect", runtime_spec["image_digest"], "--format", "{{json .}}"], timeout_seconds=20, cancellation=cancellation)
    if loaded["exit_code"] != 0:
        return None
    image = _safe_json(loaded["stdout"])
    if not isinstance(image, dict):
        return None
    descriptor = image.get("Descriptor") or {}
    if descriptor.get("digest") != runtime_spec["image_digest"]:
        return None
    if not _repository_matches(image, runtime_spec["image_repository"]):
        return None
    return _image_brief(image, reference, "offline_image_id")


def _image_digest_matches(image: dict[str, Any], repository: str, digest: str) -> bool:
    if (image.get("Descriptor") or {}).get("digest") == digest:
        return True
    expected = f"{repository}@{digest}"
    return expected in (image.get("RepoDigests") or [])


def _image_brief(image: dict[str, Any], reference: str, source: str) -> dict[str, Any]:
    # For an offline (docker load) image the concrete run reference is its ID.
    return {
        "image_id": image.get("Id", ""),
        "run_reference": image["Id"] if source == "offline_image_id" else reference,
        "repo_digests": image.get("RepoDigests") or [],
        "source": source,
    }


def _repository_matches(image: dict[str, Any], repository: str) -> bool:
    expected = {repository, f"docker.io/{repository}", f"index.docker.io/{repository}"}
    identity = image.get("Identity") or {}
    pulls = identity.get("Pull") or []
    if any((item.get("Repository") in expected) for item in pulls if isinstance(item, dict)):
        return True
    descriptor = image.get("Descriptor") or {}
    annotations = descriptor.get("annotations") or {}
    return annotations.get("containerd.io/distribution.source.docker.io") == repository


def runtime_policy_path() -> str:
    override = os.environ.get("BITTUNE_RUNTIME_POLICY_FILE", "").strip()
    if override:
        return override
    home = os.environ.get("BITTUNE_HOME", "").strip()
    if home:
        return str(Path(home) / "runtime-policy.json")
    return str(Path.home() / ".bittune" / "runtime-policy.json")


def _repository_allowed(repository: str, digest: str) -> bool:
    path = Path(runtime_policy_path())
    try:
        policy = _safe_json(path.read_text(encoding="utf-8"))
    except OSError:
        return True  # No policy file: all local runtime images are allowed.
    if not isinstance(policy, dict):
        return True
    allowed = policy.get("allowedRuntimeRepositories") or []
    if not isinstance(allowed, list) or repository not in allowed:
        return False
    for image in policy.get("runtimeImages") or []:
        if isinstance(image, dict) and image.get("repository") == repository and image.get("digest") != digest:
            return False
    return True


def _safe_json(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None
