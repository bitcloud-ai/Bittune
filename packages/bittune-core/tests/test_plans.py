"""Plan contract tests: immutability, policy, snapshot freshness, adapter gates."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_ROOT.parent / "src"))
sys.path.insert(0, str(TESTS_ROOT))

from bittune_core.adapters import require_adapter  # noqa: E402
from bittune_core.contracts import ContractError  # noqa: E402
from bittune_core.plans import _normalize_model_ref, _normalize_runtime_spec, plan_deployment, resolve_model_snapshot, model_path_in_container  # noqa: E402
from bittune_core.store import CoreStore  # noqa: E402
from test_services_fake_docker import TWO_GPUS, FakeCore, plan_create_request  # noqa: E402


def make_context(store: CoreStore) -> dict:
    return {
        "session_id": "session-1",
        "store": store,
        "cancellation": type("NoCancel", (), {"raise_if_requested": lambda self: None})(),
        "emit_progress": lambda *args, **kwargs: None,
    }


class PlanContractTest(unittest.TestCase):
    def test_sglang_explicit_backend_flags_and_auto_preserves_old_argv(self):
        adapter=require_adapter('sglang')
        self.assertNotIn('--attention-backend',adapter.compile_engine_args({}))
        self.assertNotIn('--kv-cache-dtype',adapter.compile_engine_args({}))
        params=dict(attention_backend='flashinfer',kv_cache_dtype='fp8_e4m3')
        args=adapter.compile_engine_args(params,['--attention-backend','--kv-cache-dtype'])
        self.assertEqual(args,['--attention-backend','flashinfer','--kv-cache-dtype','fp8_e4m3'])
        with self.assertRaises(ContractError):adapter.compile_engine_args(params,['--attention-backend'])

    def local_checkpoint(self) -> Path:
        root = self.work / "local-checkpoint"
        root.mkdir(exist_ok=True)
        (root / "config.json").write_text('{"model_type":"fixture"}')
        (root / "tokenizer.json").write_text('{}')
        (root / "model.safetensors").write_bytes(b"fixture weights")
        return root

    def test_existing_local_directory_gets_content_revision_and_narrow_mount(self) -> None:
        root = self.local_checkpoint()
        ref = _normalize_model_ref({"schema_version": 1, "model_id": "org/model", "local_path": str(root)})
        self.assertRegex(ref["revision"], r"^local-[a-f0-9]{64}$")
        mount = resolve_model_snapshot(ref["model_id"], ref["revision"], ref["local_path"])
        self.assertEqual(mount, {"root": str(root.resolve()), "host_path": str(root.resolve())})
        self.assertEqual(model_path_in_container(mount), "/root/.cache/huggingface/.")
        with self.assertRaises(ContractError) as raised:
            _normalize_model_ref({"schema_version": 1, "model_id": "org/model", "local_path": str(root), "revision": "main"})
        self.assertEqual(raised.exception.code, "invalid_input")

    def test_placeholder_image_digest_cannot_create_a_plan(self) -> None:
        with self.assertRaises(ContractError) as raised:
            _normalize_runtime_spec({"schema_version": 1, "runtime_kind": "vllm", "image_repository": "vllm/vllm-openai", "image_digest": "sha256:" + "0" * 64})
        self.assertEqual(raised.exception.code, "invalid_input")

    def test_local_frozen_plan_refuses_changed_weights_at_start(self) -> None:
        from bittune_core.services import deploy_service
        root = self.local_checkpoint()
        request = plan_create_request(self.snapshot_id())
        request["model_ref"] = {"schema_version": 1, "model_id": "org/model", "local_path": str(root)}
        plan_id = self.core.request(plan_deployment, request)["data"]["plan"]["plan_id"]
        frozen = self.core.request(plan_deployment, {"action": "freeze", "plan_id": plan_id})
        self.assertEqual(frozen["data"]["plan"]["status"], "frozen")
        (root / "model.safetensors").write_bytes(b"modified weights")
        with self.assertRaises(ContractError) as raised:
            self.core.request(deploy_service, {"action": "start", "plan_id": plan_id})
        self.assertEqual(raised.exception.code, "model_content_changed")
        self.assertEqual(self.core.store.list_facts("service_instance"), [])

    def test_local_plan_uses_existing_read_only_managed_launch(self) -> None:
        from bittune_core.services import deploy_service
        root = self.local_checkpoint()
        request = plan_create_request(self.snapshot_id())
        request["model_ref"] = {"schema_version": 1, "model_id": "org/model", "local_path": str(root)}
        plan = self.core.request(plan_deployment, request)["data"]["plan"]
        self.core.request(plan_deployment, {"action": "freeze", "plan_id": plan["plan_id"]})
        result = self.core.request(deploy_service, {"action": "start", "plan_id": plan["plan_id"], "ready_timeout_seconds": 0})
        self.assertEqual(result["data"]["service"]["model_ref"], plan["model_ref"])
        artifacts = self.core.store.list_run_artifacts(result["run_id"])
        launch = next(item for item in artifacts if item["label"] == "docker-run")
        command = self.core.store.read_artifact_text(launch["artifact_id"])["text"]
        self.assertIn(f"{root.resolve()}:/root/.cache/huggingface:ro", command)
        self.assertIn("/root/.cache/huggingface/.", command)

    def test_local_revision_is_content_based_and_cannot_escape_directory(self) -> None:
        import shutil
        root = self.local_checkpoint()
        copied = self.work / "copied"
        shutil.copytree(root, copied)
        def identity(path):
            return _normalize_model_ref({"schema_version": 1, "model_id": "org/model", "local_path": str(path)})["revision"]
        self.assertEqual(identity(root), identity(copied))
        (copied / "tokenizer.json").unlink()
        (copied / "tokenizer.json").symlink_to(root / "tokenizer.json")
        with self.assertRaises(ContractError) as raised:
            identity(copied)
        self.assertEqual(raised.exception.code, "invalid_input")

    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp(prefix="bittune-plans-"))
        self.core = FakeCore(self.work, str(self.work / "core"))
        self.core.set_control(gpus=TWO_GPUS, image_ok=True, run_ok=True, stop_ok=True)
        cache = self.work / "models"
        weights = cache / "models--Qwen--Qwen3-32B" / "snapshots" / "rev-0001"
        weights.mkdir(parents=True)
        (weights / "model-00001-of-00002.safetensors").write_bytes(b"\x00" * 64)
        os.environ["BITTUNE_MODEL_CACHE_ROOTS"] = str(cache)
        os.environ["BITTUNE_HOME"] = str(self.work / "core")

    def tearDown(self) -> None:
        self.core.close()
        os.environ.pop("BITTUNE_MODEL_CACHE_ROOTS", None)
        os.environ.pop("BITTUNE_HOME", None)

    def snapshot_id(self) -> str:
        from bittune_core.inspect import inspect_environment

        result = self.core.request(inspect_environment, {})
        return result["data"]["hardware_snapshot"]["hardware_snapshot_id"]

    def frozen_plan(self, snapshot_id: str) -> str:
        created = self.core.request(plan_deployment, plan_create_request(snapshot_id))
        plan_id = created["data"]["plan"]["plan_id"]
        validated = self.core.request(plan_deployment, {"action": "validate", "plan_id": plan_id})
        self.assertEqual(validated["data"]["validation"]["state"], "valid")
        return plan_id

    def test_draft_plan_flow_and_frozen_immutability(self) -> None:
        snapshot_id = self.snapshot_id()
        plan_id = self.frozen_plan(snapshot_id)
        frozen = self.core.request(plan_deployment, {"action": "freeze", "plan_id": plan_id})
        self.assertEqual(frozen["data"]["plan"]["status"], "frozen")
        self.assertIn("frozen_at", frozen["data"]["plan"])

        # Any modification of a frozen plan must be refused by the store.
        tampered = dict(frozen["data"]["plan"])
        tampered["rationale"] = "tampered after freeze"
        with self.assertRaises(ContractError) as raised:
            self.core.store.put_deployment_plan(tampered, "run-00000000-0000-4000-8000-000000000000")
        self.assertEqual(raised.exception.code, "state_conflict")

        # Idempotent identical write stays fine.
        self.core.store.put_deployment_plan(dict(frozen["data"]["plan"]), "run-00000000-0000-4000-8000-000000000000")

    def test_draft_conditional_update_rejects_stale_writer(self) -> None:
        snapshot_id = self.snapshot_id()
        created = self.core.request(plan_deployment, plan_create_request(snapshot_id))
        plan_id = created["data"]["plan"]["plan_id"]
        fact = self.core.store.get_fact("deployment_plan", plan_id)
        newer = dict(fact["payload"])
        newer["rationale"] = "new writer"
        self.core.store.put_deployment_plan(newer, "run-00000000-0000-4000-8000-000000000000", expected_content_hash=fact["content_hash"])
        stale = dict(fact["payload"])
        stale["rationale"] = "old writer"
        with self.assertRaises(ContractError) as raised:
            self.core.store.put_deployment_plan(stale, "run-00000000-0000-4000-8000-000000000000", expected_content_hash=fact["content_hash"])
        self.assertEqual(raised.exception.code, "state_conflict")

    def test_adapter_rejects_undeclared_parameters(self) -> None:
        vllm = require_adapter("vllm")
        with self.assertRaises(ContractError) as raised:
            vllm.materialize({"arbitrary_flag": "yes"})
        self.assertEqual(raised.exception.code, "unsupported_serving_parameter")
        sglang = require_adapter("sglang")
        with self.assertRaises(ContractError):
            sglang.materialize({"tensor_parallel_size": 0})
        with self.assertRaises(ContractError):
            require_adapter("tgi")

    def test_image_policy_rejects_unlisted_repository(self) -> None:
        policy = {
            "allowedRuntimeRepositories": ["docker.io/someone-else/allowed"],
            "runtimeImages": [],
        }
        (Path(os.environ["BITTUNE_HOME"]) / "runtime-policy.json").write_text(json.dumps(policy), encoding="utf-8")
        snapshot_id = self.snapshot_id()
        created = self.core.request(plan_deployment, plan_create_request(snapshot_id))
        plan_id = created["data"]["plan"]["plan_id"]
        validated = self.core.request(plan_deployment, {"action": "validate", "plan_id": plan_id})
        self.assertEqual(validated["data"]["validation"]["state"], "invalid")
        failure = next(check for check in validated["data"]["validation"]["checks"] if check["name"] == "image_policy")
        self.assertFalse(failure["ok"])

    def test_stale_snapshot_is_refused(self) -> None:
        snapshot_id = self.snapshot_id()
        from bittune_core.contracts import canonical_json, sha256_canonical

        store: CoreStore = self.core.store
        fact = store.get_fact("hardware_snapshot", snapshot_id)
        aged = dict(fact["payload"])
        aged["observed_at"] = "2026-08-01T00:00:00Z"
        store.db.execute(
            "UPDATE hardware_snapshots SET payload_json = ?, content_hash = ? WHERE hardware_snapshot_id = ?",
            (canonical_json(aged), sha256_canonical(aged), snapshot_id),
        )
        store.db.commit()
        created = self.core.request(plan_deployment, plan_create_request(snapshot_id))["data"]["plan"]
        plan_id = created["plan_id"]
        validated = self.core.request(plan_deployment, {"action": "validate", "plan_id": plan_id})["data"]["validation"]
        self.assertEqual(validated["state"], "invalid")
        self.assertTrue(any(item.get("code") == "snapshot_stale" for item in validated["errors"]))
        with self.assertRaises(ContractError) as raised:
            self.core.request(plan_deployment, {"action": "freeze", "plan_id": plan_id})
        self.assertEqual(raised.exception.code, "plan_not_attemptable")
        self.assertTrue(any(item.get("code") == "snapshot_stale" for item in raised.exception.details["errors"]))
        copied = self.core.request(plan_deployment, {
            "action": "create",
            "prior_source": "none",
            "based_on_plan_id": plan_id,
            "goal": "copied stale draft",
            "rationale": "create does not check freshness",
        })["data"]["plan"]
        self.assertEqual(copied["hardware_snapshot_id"], snapshot_id)
        copied_validation = self.core.request(plan_deployment, {"action": "validate", "plan_id": copied["plan_id"]})["data"]["validation"]
        self.assertEqual(copied_validation["state"], "invalid")
        self.assertTrue(any(item.get("code") == "snapshot_stale" for item in copied_validation["errors"]))

    def test_model_ref_and_runtime_spec_contracts(self) -> None:
        valid_ref = _normalize_model_ref({"schema_version": 1, "model_id": "org/model", "revision": "abc123"})
        self.assertEqual(valid_ref["revision"], "abc123")
        with self.assertRaises(ContractError):
            _normalize_model_ref({"schema_version": 2, "model_id": "org/model", "revision": "abc123"})
        with self.assertRaises(ContractError):
            _normalize_model_ref({"schema_version": 1, "model_id": "org/model", "revision": "not a revision"})
        valid_spec = _normalize_runtime_spec({
            "schema_version": 1,
            "runtime_kind": "vllm",
            "image_repository": "docker.io/vllm/vllm-openai",
            "image_digest": "sha256:" + "c" * 64,
        })
        self.assertEqual(valid_spec["runtime_kind"], "vllm")
        with self.assertRaises(ContractError):
            _normalize_runtime_spec({"schema_version": 1, "runtime_kind": "vllm", "image_repository": "x", "image_digest": "v0.1"})

    def test_validate_without_snapshot_is_refused(self) -> None:
        created = self.core.request(plan_deployment, plan_create_request(None))
        plan_id = created["data"]["plan"]["plan_id"]
        validated = self.core.request(plan_deployment, {"action": "validate", "plan_id": plan_id})
        self.assertEqual(validated["data"]["validation"]["state"], "invalid")
        self.assertTrue(any(check["name"] == "hardware_snapshot" and not check["ok"] for check in validated["data"]["validation"]["checks"]))

    def test_user_specified_create_needs_no_recommendation(self) -> None:
        missing = plan_create_request(None)
        missing.pop("prior_source")
        with self.assertRaises(ContractError) as raised:
            self.core.request(plan_deployment, missing)
        self.assertIn("prior_source 必填", raised.exception.message)
        request = plan_create_request(None)
        request["prior_source"] = "user_specified"
        created = self.core.request(plan_deployment, request)["data"]["plan"]
        self.assertEqual(created["prior_source"], "user_specified")
        self.assertEqual(created["model_ref"]["model_id"], "Qwen/Qwen3-32B")




    def test_validate_and_freeze_reject_create_only_fields(self) -> None:
        snapshot_id = self.snapshot_id()
        plan_id = self.frozen_plan(snapshot_id)
        before = self.core.store.get_fact("deployment_plan", plan_id)
        for action, extra in (
            ("validate", {"prior_source": "none"}),
            ("freeze", {"based_on_plan_id": plan_id}),
        ):
            with self.assertRaises(ContractError) as raised:
                self.core.request(plan_deployment, {"action": action, "plan_id": plan_id, **extra})
            self.assertIn("不接收 prior_source 或 based_on_plan_id", raised.exception.message)
        after = self.core.store.get_fact("deployment_plan", plan_id)
        self.assertEqual(after["content_hash"], before["content_hash"])

    def test_based_on_plan_copies_into_a_new_draft(self) -> None:
        snapshot_id = self.snapshot_id()
        plan_id = self.frozen_plan(snapshot_id)
        frozen = self.core.request(plan_deployment, {"action": "freeze", "plan_id": plan_id})["data"]["plan"]
        before = self.core.store.get_fact("deployment_plan", plan_id)
        created = self.core.request(plan_deployment, {
            "action": "create",
            "prior_source": "none",
            "based_on_plan_id": plan_id,
            "goal": "copied draft",
            "rationale": "same card, new draft",
        })["data"]["plan"]
        self.assertEqual(created["status"], "draft")
        self.assertNotEqual(created["plan_id"], plan_id)
        self.assertEqual(created["derived_from"], plan_id)
        self.assertEqual(created["model_ref"], frozen["model_ref"])
        self.assertEqual(created["runtime_spec"], frozen["runtime_spec"])
        self.assertEqual(created["serving_spec"], frozen["serving_spec"])
        self.assertEqual(created["hardware_snapshot_id"], snapshot_id)
        after = self.core.store.get_fact("deployment_plan", plan_id)
        self.assertEqual(after["content_hash"], before["content_hash"])
        self.assertEqual(after["payload"]["status"], "frozen")


if __name__ == "__main__":
    unittest.main()
