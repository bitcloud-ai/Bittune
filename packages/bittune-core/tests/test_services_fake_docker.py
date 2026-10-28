"""Deployment lifecycle fixtures against an in-process fake Docker driver.

These are the Phase 3 fake-Docker acceptance tests: prerequisite failures
abort before any container launch, frozen plans produce labeled managed
records, stop/recover refuse everything that lacks the double ownership
proof, and the happy path does start -> ready -> stop. The fake driver
records every docker argv and answers from a scenario control file; only the
Core handlers under test run here, the process/protocol boundary is covered
by test_protocol. Real NVIDIA Docker acceptance is a separate host gate and
is never claimed from here.
"""

import json
import os
import socket
import sqlite3
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

SRC_ROOT = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_ROOT))

from bittune_core import benchmark as benchmark_module  # noqa: E402
from bittune_core import suite as suite_module  # noqa: E402
from bittune_core import inspect as inspect_module  # noqa: E402
from bittune_core import plans as plans_module  # noqa: E402
from bittune_core import services as services_module  # noqa: E402
from bittune_core.contracts import ContractError  # noqa: E402
from bittune_core.inspect import inspect_environment, inspect_service  # noqa: E402
from bittune_core.plans import plan_deployment  # noqa: E402
from bittune_core.services import deploy_service  # noqa: E402
from bittune_core.store import CoreStore  # noqa: E402

TWO_GPUS = [
    {"index": 0, "uuid": "GPU-uuid-0", "name": "Fake RTX 4090", "driver": "550.54.15", "compute_cap": "8.9", "memory_total_mib": 24564, "memory_free_mib": 24000, "utilization": 0, "power": 20},
    {"index": 1, "uuid": "GPU-uuid-1", "name": "Fake RTX 4090", "driver": "550.54.15", "compute_cap": "8.9", "memory_total_mib": 24564, "memory_free_mib": 24100, "utilization": 0, "power": 18},
]

SERVICE_CONTAINER = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111"

VLLM_HELP = (
    "usage: vllm serve [options]\n--model <str>\n--served-model-name <str>\n--host <str>\n--port <int>\n"
    "--dtype <str>\n--tensor-parallel-size <int>\n--pipeline-parallel-size <int>\n--max-model-len <int>\n"
    "--max-num-seqs <int>\n--max-num-batched-tokens <int>\n--gpu-memory-utilization <float>\n--swap-space <float>\n"
    "--enforce-eager\n--enable-prefix-caching\n"
)

SGLANG_HELP = (
    "usage: sglang.launch_server [options]\n--model-path <str>\n--served-model-name <str>\n--host <str>\n--port <int>\n"
    "--dtype <str>\n--tp-size <int>\n--context-length <int>\n--max-running-requests <int>\n"
    "--chunked-prefill-size <int>\n--mem-fraction-static <float>\n--disable-cuda-graph\n--disable-radix-cache\n"
)


class MiniHttpServer:
    """Small deterministic HTTP responder for /v1/models readiness probes.

    Plain socket loop: no daemon serve_forever thread, so shutdown is clean
    on every platform and no stray socket errors leak into test output.
    """

    def __init__(self, routes: dict[str, tuple[int, bytes]]):
        self.routes = routes
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.socket.bind(("127.0.0.1", 0))
        self.port = self.socket.getsockname()[1]
        self.socket.listen(8)
        self.socket.settimeout(0.2)
        self._stopped = threading.Event()
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self) -> None:
        while not self._stopped.is_set():
            try:
                connection, _ = self.socket.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with connection:
                connection.settimeout(2)
                try:
                    data = connection.recv(65536)
                except OSError:
                    continue
                request_line = data.split(b"\r\n", 1)[0].decode("utf-8", errors="replace") if data else ""
                parts = request_line.split(" ")
                path = parts[1] if len(parts) > 1 else "/"
                status, body = self.routes.get(path, (404, b"not found"))
                reason = "OK" if status == 200 else "Not Found"
                connection.sendall(
                    f"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
                    + body
                )

    def stop(self) -> None:
        self._stopped.set()
        self.socket.close()
        self.thread.join(timeout=2)


def ready_routes(model_id: str = "Qwen/Qwen3-32B") -> dict[str, tuple[int, bytes]]:
    models_body = json.dumps({"object": "list", "data": [{"id": model_id}]}).encode()
    completion_body = json.dumps({"id": "x", "choices": [{"message": {"content": "OK"}}]}).encode()
    return {"/v1/models": (200, models_body), "/v1/chat/completions": (200, completion_body)}


class FakeCore:
    """Runs the real Core handlers in-process with a fake docker backend."""

    def __init__(self, work: Path, home: str):
        self.work = work
        self.home = home
        self.store = CoreStore(home)
        self.store.mark_interrupted_runs()
        self.calls: list[list[str]] = []
        self.control: dict[str, Any] = {}
        self.no_cancel = type("NoCancel", (), {"raise_if_requested": lambda self: None})()
        self.patches = []
        for module in (inspect_module, plans_module, services_module, benchmark_module, suite_module):
            patcher = mock.patch.object(module, "run_command", self.fake_run_command)
            patcher.start()
            self.patches.append(patcher)

    def close(self) -> None:
        for patcher in self.patches:
            patcher.stop()
        self.store.close()

    def set_control(self, **fields) -> None:
        self.control = dict(fields)

    def read_control(self) -> dict:
        return self.control

    def fake_run_command(self, args: list[str], **kwargs) -> dict[str, Any]:
        self.calls.append(args)
        control = self.read_control()
        command = args[0] if args else ""
        if command == "evalscope":
            return self.fake_evalscope(args[1:])
        if "nvidia-smi" in command:
            gpus = control.get("gpus", [])
            if not gpus:
                return {"args": args, "exit_code": 3, "stdout": "", "stderr": "NVIDIA-SMI has failed\n", "duration_ms": 1, "truncated": False}
            lines = [
                f"{gpu['index']}, {gpu['uuid']}, {gpu['name']}, {gpu['driver']}, {gpu['compute_cap']}, {gpu['memory_total_mib']}, {gpu['memory_free_mib']}, {gpu['utilization']}, {gpu['power']}"
                for gpu in gpus
            ]
            return {"args": args, "exit_code": 0, "stdout": "\n".join(lines) + "\n", "stderr": "", "duration_ms": 1, "truncated": False}
        if command in ("uname", "lscpu", "free", "cat", "df"):
            if command == "uname":
                return {"args": args, "exit_code": 0, "stdout": "Linux fakehost 6.8.0 x86_64\n", "stderr": "", "duration_ms": 1, "truncated": False}
            if command == "lscpu":
                return {"args": args, "exit_code": 0, "stdout": "Architecture: x86_64\nCPU(s): 64\n", "stderr": "", "duration_ms": 1, "truncated": False}
            if command == "free":
                return {"args": args, "exit_code": 0, "stdout": "               total        used        free      shared  buff/cache   available\nMem:   134217728    8388608   125829120           0           0   125829120\n", "stderr": "", "duration_ms": 1, "truncated": False}
            if command == "cat":
                return {"args": args, "exit_code": 0, "stdout": "ID=ubuntu\nVERSION_ID=\"24.04\"\n", "stderr": "", "duration_ms": 1, "truncated": False}
            return {"args": args, "exit_code": 0, "stdout": "Filesystem 1K-blocks Used Available\n/dev/sda1 104857600 1048576 104857600\n", "stderr": "", "duration_ms": 1, "truncated": False}
        if command == "docker":
            return self.fake_docker(args[1:])
        return {"args": args, "exit_code": 0, "stdout": "", "stderr": "", "duration_ms": 1, "truncated": False}

    def fake_evalscope(self, argv: list[str]) -> dict[str, Any]:
        control = self.read_control()
        if argv == ["--version"]:
            if not control.get("evalscope_ok", True):
                return {"args": argv, "exit_code": 1, "stdout": "", "stderr": "evalscope: command not found\n", "duration_ms": 1, "truncated": False}
            return {"args": argv, "exit_code": 0, "stdout": control.get("evalscope_version", "1.10.0") + "\n", "stderr": "", "duration_ms": 1, "truncated": False}
        if argv[:1] == ["perf"]:
            output_dir = Path(argv[argv.index("--outputs-dir") + 1])
            output_dir.mkdir(parents=True, exist_ok=True)
            if control.get("empty_metrics"):
                (output_dir / "empty.json").write_text("{}", encoding="utf-8")
                return {"args": argv, "exit_code": 0, "stdout": "benchmark done\n", "stderr": "", "duration_ms": 1, "truncated": False}
            summary_report = {
                "successful requests": control.get("successful_requests", 98),
                "failed requests": control.get("failed_requests", 2),
                "total requests": control.get("total_requests", 100),
                "req throughput (req/s)": control.get("req_throughput", 12.5),
                "output token throughput": control.get("output_throughput", 320.0),
                "avg latency (s)": control.get("avg_latency_s", 0.42),
                "avg ttft (ms)": control.get("avg_ttft_ms", 55.2),
                "avg tpot (ms)": control.get("avg_tpot_ms", 21.1),
                "avg itl (ms)": control.get("avg_itl_ms", 3.2),
            }
            (output_dir / "raw_results.json").write_text(json.dumps(summary_report), encoding="utf-8")
            total = control.get("total_requests", 100)
            samples = {
                "ttft_ms": [control.get("sample_ttft_ms", 50) + (index % 10) for index in range(total)],
                "e2e_latency_ms": [control.get("sample_e2e_ms", 400) + (index % 10) for index in range(total)],
                "tpot_ms": [control.get("sample_tpot_ms", 20) + (index % 5) for index in range(total)],
                "itl_ms": [control.get("sample_itl_ms", 3) + (index % 3) for index in range(total)],
            }
            (output_dir / "per_requests.json").write_text(json.dumps({"per_requests": samples}), encoding="utf-8")
            from test_request_evidence import SCHEMA
            prefix = int(argv[argv.index("--prefix-length") + 1])
            input_tokens = int(argv[argv.index("--min-prompt-length") + 1]) + prefix
            output_tokens = int(argv[argv.index("--max-tokens") + 1])
            successes = control.get("successful_requests", 98)
            with sqlite3.connect(output_dir / "benchmark_data.db") as db:
                db.execute(SCHEMA)
                duration = successes / control.get("req_throughput", 12.5)
                for index in range(total):
                    success = index < successes
                    start = 10 + index * (duration - samples["e2e_latency_ms"][-1] / 1000) / max(1, total - 1)
                    row = (json.dumps({"prompt": [index % 32] * input_tokens}), start, json.dumps([samples["itl_ms"][index] / 1000]) if success else "[]", int(success), "", start + samples["e2e_latency_ms"][index] / 1000,
                           samples["e2e_latency_ms"][index] / 1000 if success else None,
                           samples["ttft_ms"][index] / 1000 if success else None,
                           input_tokens if success else None, output_tokens if success else None, None,
                           samples["tpot_ms"][index] / 1000 if success else None, None, int("--no-stream" not in argv))
                    db.execute("INSERT INTO result VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", row)
            return {"args": argv, "exit_code": 0, "stdout": "benchmark done\n", "stderr": "", "duration_ms": 1, "truncated": False}
        return {"args": argv, "exit_code": 2, "stdout": "", "stderr": "unexpected evalscope argv\n", "duration_ms": 1, "truncated": False}

    def fake_docker(self, argv: list[str]) -> dict[str, Any]:
        args = ["docker", *argv]
        control = self.read_control()
        ok = lambda: {"args": args, "exit_code": 0, "stdout": "", "stderr": "", "duration_ms": 1, "truncated": False}
        fail = lambda message, code=1: {"args": args, "exit_code": code, "stdout": "", "stderr": message, "duration_ms": 1, "truncated": False}
        if argv[:2] == ["version", "--format"]:
            return {"args": args, "exit_code": 0, "stdout": json.dumps(control.get("docker_version", {"Client": {"Version": "24.0.7"}, "Server": {"Version": "24.0.7"}})), "stderr": "", "duration_ms": 1, "truncated": False}
        if argv[:2] == ["info", "--format"]:
            return {"args": args, "exit_code": 0, "stdout": json.dumps(control.get("docker_info", {"ServerVersion": "24.0.7", "Driver": "overlay2", "Runtimes": {"runc": {}, "nvidia": {}}})), "stderr": "", "duration_ms": 1, "truncated": False}
        if argv[:2] == ["image", "inspect"]:
            if not control.get("image_ok", True):
                return fail("Error: No such image\n")
            digest = ("c" * 64) if "@" in (argv[2] if len(argv) > 2 else "") else ("c" * 64)
            return {
                "args": args,
                "exit_code": 0,
                "stdout": json.dumps({
                    "Id": control.get("image_id", "sha256:" + "a" * 64),
                    "RepoDigests": [f"{argv[2]}@sha256:{'b' * 64}"],
                    "Size": 1024,
                    "Descriptor": {"digest": "sha256:" + "c" * 64},
                    "Identity": {"Pull": [{"Repository": (argv[2] or "").split("@")[0]}]},
                }),
                "stderr": "",
                "duration_ms": 1,
                "truncated": False,
            }
        if argv[:2] == ["run", "--rm"]:
            if "--help" in argv:
                joined = " ".join(argv)
                return {"args": args, "exit_code": 0, "stdout": SGLANG_HELP if "sglang.launch_server" in joined else VLLM_HELP, "stderr": "", "duration_ms": 1, "truncated": False}
            return fail("unexpected --rm run\n")
        if argv[:2] == ["run", "-d"]:
            if not control.get("run_ok", True):
                return fail("Error response from daemon: no image or gpu\n", 125)
            return {"args": args, "exit_code": 0, "stdout": control.get("container_id", SERVICE_CONTAINER) + "\n", "stderr": "", "duration_ms": 1, "truncated": False}
        if argv[:2] == ["container", "inspect"]:
            payload = {
                "State": control.get("state", {"Status": "running", "Running": True, "ExitCode": 0, "OOMKilled": False}),
                "NetworkSettings": {"Ports": control.get("ports", {"8000/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(control.get("port", 45454))}]})},
                "Config": {"Labels": control.get("labels", {})},
            }
            return {"args": args, "exit_code": 0, "stdout": json.dumps(payload), "stderr": "", "duration_ms": 1, "truncated": False}
        if argv[:2] == ["container", "logs"]:
            return {"args": args, "exit_code": 0, "stdout": control.get("logs", "fake container log line\nanother line\n"), "stderr": "", "duration_ms": 1, "truncated": False}
        if argv[:2] == ["container", "stop"]:
            if not control.get("stop_ok", True):
                return fail("daemon error\n")
            self.control["state"] = {"Status": "exited", "Running": False, "ExitCode": 0, "OOMKilled": False}
            return {"args": args, "exit_code": 0, "stdout": control.get("container_id", SERVICE_CONTAINER) + "\n", "stderr": "", "duration_ms": 1, "truncated": False}
        if argv[:1] == ["ps"]:
            rows = control.get("ps_rows", [])
            stdout = "".join(json.dumps(row) + "\n" for row in rows)
            return {"args": args, "exit_code": 0, "stdout": stdout, "stderr": "", "duration_ms": 1, "truncated": False}
        return fail(f"fake docker: unexpected argv {argv!r}\n", 2)

    def request(self, handler, params: dict) -> dict:
        context = {
            "session_id": "session-1",
            "store": self.store,
            "cancellation": self.no_cancel,
            "emit_progress": lambda *args, **kwargs: None,
        }
        return handler(params, context)


def plan_create_request(snapshot_id: str | None) -> dict:
    return {
        "action": "create",
        "prior_source": "none",
        "goal": "serve a test model on two fake GPUs",
        "rationale": "fixture",
        "model_ref": {"schema_version": 1, "model_id": "Qwen/Qwen3-32B", "revision": "rev-0001"},
        "runtime_spec": {
            "schema_version": 1,
            "runtime_kind": "vllm",
            "image_repository": "docker.io/vllm/vllm-openai",
            "image_digest": "sha256:" + "c" * 64,
        },
        "serving_spec": {"tensor_parallel_size": 2},
        **( {"hardware_snapshot_id": snapshot_id} if snapshot_id else {}),
    }


class FakeDockerServiceLifecycleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp(prefix="bittune-fakedocker-"))
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
        result = self.core.request(inspect_environment, {})
        return result["data"]["hardware_snapshot"]["hardware_snapshot_id"]

    def frozen_plan(self, snapshot_id: str, serving_spec: dict | None = None) -> str:
        request = plan_create_request(snapshot_id)
        if serving_spec is not None:
            request["serving_spec"] = serving_spec
        created = self.core.request(plan_deployment, request)
        plan_id = created["data"]["plan"]["plan_id"]
        validated = self.core.request(plan_deployment, {"action": "validate", "plan_id": plan_id})
        self.assertEqual(validated["data"]["validation"]["state"], "valid", validated)
        frozen = self.core.request(plan_deployment, {"action": "freeze", "plan_id": plan_id})
        return plan_id

    def docker_calls(self) -> list[list[str]]:
        return [call for call in self.core.calls if call and call[0] == "docker"]

    def test_happy_path_start_ready_stop_with_labels(self) -> None:
        snapshot_id = self.snapshot_id()
        plan_id = self.frozen_plan(snapshot_id)
        server = MiniHttpServer(ready_routes())
        port = server.port
        self.addCleanup(server.stop)
        self.core.set_control(gpus=TWO_GPUS, image_ok=True, run_ok=True, stop_ok=True, container_id=SERVICE_CONTAINER, port=port)
        started = self.core.request(deploy_service, {"action": "start", "plan_id": plan_id, "ready_timeout_seconds": 30})
        self.assertIn("ready", started["data"]["service"]["observed_state"])
        service = started["data"]["service"]
        service_id = service["service_instance_id"]
        self.assertEqual(service["ownership"], "managed")
        self.assertEqual(service["endpoint"], f"http://127.0.0.1:{port}")
        # label double-proof is checked from the container on stop
        self.core.set_control(gpus=TWO_GPUS, image_ok=True, run_ok=True, stop_ok=True, container_id=SERVICE_CONTAINER, port=port, labels={"bittune.managed": "true", "bittune.service_id": service_id, "bittune.plan_id": plan_id})
        stopped = self.core.request(deploy_service, {"action": "stop", "service_instance_id": service_id})
        self.assertEqual(stopped["data"]["service"]["desired"], "stopped")
        self.assertEqual(stopped["data"]["service"]["observed_state"], "exited")
        run_calls = [call for call in self.docker_calls() if call[1:3] == ["run", "-d"]]
        self.assertEqual(len(run_calls), 1)
        argv = run_calls[0]
        self.assertIn("--pull=never", argv)
        self.assertIn("--label", argv)
        label_start = argv.index("--label")
        labels = argv[label_start : label_start + 6]
        self.assertIn("bittune.managed=true", labels)
        self.assertIn(f"bittune.service_id={service_id}", labels)
        self.assertIn(f"bittune.plan_id={plan_id}", labels)
        self.assertIn("--gpus", argv)
        self.assertEqual(argv[argv.index("--gpus") + 1], "all")
        joined = " ".join(argv)
        self.assertIn("HF_HUB_OFFLINE=1", joined)
        self.assertIn("/root/.cache/huggingface:ro", joined)

    def test_invalid_ready_timeout_is_rejected_before_container_creation(self) -> None:
        snapshot_id = self.snapshot_id()
        plan_id = self.frozen_plan(snapshot_id)
        with self.assertRaises(ContractError) as raised:
            self.core.request(deploy_service, {"action": "start", "plan_id": plan_id, "ready_timeout_seconds": 901})
        self.assertEqual(raised.exception.code, "invalid_input")
        self.assertEqual([call for call in self.docker_calls() if call[1:3] == ["run", "-d"]], [])

    def test_plan_label_mismatch_is_refused(self) -> None:
        snapshot_id = self.snapshot_id()
        plan_id = self.frozen_plan(snapshot_id)
        started = self.core.request(deploy_service, {"action": "start", "plan_id": plan_id, "ready_timeout_seconds": 0})
        service_id = started["data"]["service"]["service_instance_id"]
        self.core.set_control(gpus=TWO_GPUS, image_ok=True, run_ok=True, stop_ok=True, container_id=SERVICE_CONTAINER, labels={"bittune.managed": "true", "bittune.service_id": service_id, "bittune.plan_id": "plan-other"})
        with self.assertRaises(ContractError) as raised:
            self.core.request(deploy_service, {"action": "stop", "service_instance_id": service_id})
        self.assertEqual(raised.exception.code, "service_not_managed")

    def test_container_dies_start_fails_with_log_artifact(self) -> None:
        snapshot_id = self.snapshot_id()
        plan_id = self.frozen_plan(snapshot_id)
        self.core.set_control(gpus=TWO_GPUS, image_ok=True, run_ok=True, stop_ok=True, container_id=SERVICE_CONTAINER, state={"Status": "exited", "Running": False, "ExitCode": 1, "OOMKilled": False})
        with self.assertRaises(Exception) as raised:
            self.core.request(deploy_service, {"action": "start", "plan_id": plan_id, "ready_timeout_seconds": 0})
        self.assertEqual(raised.exception.code, "container_start_failed")
        self.assertIn("log_artifact_id", raised.exception.details)
        services = self.core.store.list_facts("service_instance")
        self.assertEqual(len(services), 1)

    def test_external_service_stop_and_recover_refused(self) -> None:
        external = {
            "schema_version": 1,
            "service_instance_id": "service-00000000-0000-4000-8000-000000000000",
            "ownership": "external",
            "provenance": "detected",
            "container_id": SERVICE_CONTAINER,
            "endpoint": "http://127.0.0.1:9999",
            "created_at": "2026-09-01T00:00:00Z",
        }
        self.core.store.put_service_instance(external, "run-00000000-0000-4000-8000-000000000000")
        stop_error = None
        try:
            self.core.request(deploy_service, {"action": "stop", "service_instance_id": external["service_instance_id"]})
        except Exception as error:
            stop_error = error
        self.assertEqual(stop_error.code, "service_not_managed")
        recover_error = None
        try:
            self.core.request(deploy_service, {"action": "recover", "service_instance_id": external["service_instance_id"]})
        except Exception as error:
            recover_error = error
        self.assertEqual(recover_error.code, "service_not_managed")
        stop_calls = [call for call in self.docker_calls() if call[1:3] == ["container", "stop"]]
        self.assertEqual(stop_calls, [])

    def test_label_mismatch_stop_refused(self) -> None:
        managed = {
            "schema_version": 1,
            "service_instance_id": "service-11111111-1111-4111-8111-111111111111",
            "plan_id": "plan-00000000-0000-4000-8000-000000000000",
            "ownership": "managed",
            "provenance": "measured",
            "container_id": SERVICE_CONTAINER,
            "endpoint": "http://127.0.0.1:9999",
            "created_at": "2026-09-01T00:00:00Z",
        }
        self.core.store.put_service_instance(managed, "run-00000000-0000-4000-8000-000000000000")
        self.core.set_control(gpus=TWO_GPUS, image_ok=True, run_ok=True, stop_ok=True, container_id=SERVICE_CONTAINER, labels={"bittune.managed": "false"})
        stop_error = None
        try:
            self.core.request(deploy_service, {"action": "stop", "service_instance_id": managed["service_instance_id"]})
        except Exception as error:
            stop_error = error
        self.assertEqual(stop_error.code, "service_not_managed")
        stop_calls = [call for call in self.docker_calls() if call[1:3] == ["container", "stop"]]
        self.assertEqual(stop_calls, [])

    def test_image_missing_aborts_before_run(self) -> None:
        snapshot_id = self.snapshot_id()
        created = self.core.request(plan_deployment, plan_create_request(snapshot_id))
        plan_id = created["data"]["plan"]["plan_id"]
        self.core.set_control(gpus=TWO_GPUS, image_ok=False, run_ok=True, stop_ok=True)
        validated = self.core.request(plan_deployment, {"action": "validate", "plan_id": plan_id})
        self.assertEqual(validated["data"]["validation"]["state"], "invalid")
        self.assertTrue(any(check["name"] == "image_available" and not check["ok"] for check in validated["data"]["validation"]["checks"]))
        freeze_error = None
        try:
            self.core.request(plan_deployment, {"action": "freeze", "plan_id": plan_id})
        except Exception as error:
            freeze_error = error
        self.assertEqual(freeze_error.code, "plan_not_attemptable")
        run_calls = [call for call in self.docker_calls() if call[1:3] == ["run", "-d"]]
        self.assertEqual(run_calls, [])

    def test_model_missing_fails_validate(self) -> None:
        os.environ["BITTUNE_MODEL_CACHE_ROOTS"] = str(self.work / "empty-cache")
        snapshot_id = self.snapshot_id()
        created = self.core.request(plan_deployment, plan_create_request(snapshot_id))
        plan_id = created["data"]["plan"]["plan_id"]
        validated = self.core.request(plan_deployment, {"action": "validate", "plan_id": plan_id})
        self.assertEqual(validated["data"]["validation"]["state"], "invalid")
        self.assertTrue(any(check["name"] == "model_available" and not check["ok"] for check in validated["data"]["validation"]["checks"]))

    def test_tensor_parallel_exceeds_topology_fails_validate(self) -> None:
        snapshot_id = self.snapshot_id()
        created = self.core.request(plan_deployment, plan_create_request(snapshot_id))
        created["data"]["plan"]["serving_spec"]["tensor_parallel_size"] = 4
        plan = created["data"]["plan"]
        plan_id = plan["plan_id"]
        self.core.store.put_deployment_plan(plan, "run-00000000-0000-4000-8000-000000000000")
        validated = self.core.request(plan_deployment, {"action": "validate", "plan_id": plan_id})
        self.assertEqual(validated["data"]["validation"]["state"], "invalid")
        self.assertTrue(any(check["name"] == "gpu_topology" and not check["ok"] for check in validated["data"]["validation"]["checks"]))

    def test_sglang_plan_uses_its_entrypoint(self) -> None:
        snapshot_id = self.snapshot_id()
        request = plan_create_request(snapshot_id)
        request["runtime_spec"]["runtime_kind"] = "sglang"
        request["serving_spec"] = {"tensor_parallel_size": 1}
        created = self.core.request(plan_deployment, request)
        plan_id = created["data"]["plan"]["plan_id"]
        validated = self.core.request(plan_deployment, {"action": "validate", "plan_id": plan_id})
        self.assertEqual(validated["data"]["validation"]["state"], "valid")
        frozen = self.core.request(plan_deployment, {"action": "freeze", "plan_id": plan_id})
        self.core.set_control(gpus=TWO_GPUS, image_ok=True, run_ok=True, stop_ok=True, container_id=SERVICE_CONTAINER, port=45001)
        started = self.core.request(deploy_service, {"action": "start", "plan_id": plan_id, "ready_timeout_seconds": 0})
        self.assertIn("sglang", started["data"]["service"]["runtime_spec"]["runtime_kind"])
        run_calls = [call for call in self.docker_calls() if call[1:3] == ["run", "-d"]]
        argv = run_calls[0]
        self.assertIn("--entrypoint", argv)
        self.assertIn("-m", argv)
        self.assertIn("sglang.launch_server", argv)


    def test_empty_inspect_does_not_run_deep_probes(self) -> None:
        self.core.calls.clear()
        result = self.core.request(inspect_environment, {})
        self.assertIn("hardware_snapshot", result["data"])
        joined = " ".join(" ".join(call) for call in self.core.calls)
        for banned in ("nvbandwidth", "nccl", "dcgm", "all_reduce_perf"):
            self.assertNotIn(banned, joined)

    def test_requested_probe_runs_fixed_command(self) -> None:
        self.core.calls.clear()
        result = self.core.request(inspect_environment, {"probes": ["nvbandwidth"]})
        self.assertIn("hardware_snapshot", result["data"])
        self.assertIn(["nvbandwidth"], self.core.calls)

    def test_missing_probe_is_recorded_and_inspect_still_succeeds(self) -> None:
        real = inspect_module.run_command

        def wrapped(args, **kwargs):
            if args and args[0] == "nvbandwidth":
                raise ContractError("unavailable", "nvbandwidth 不可用。")
            return real(args, **kwargs)

        with mock.patch.object(inspect_module, "run_command", wrapped):
            result = self.core.request(inspect_environment, {"probes": ["nvbandwidth"]})
        self.assertIn("hardware_snapshot", result["data"])
        labels = [row["label"] for row in self.core.store.db.execute("SELECT label FROM artifacts").fetchall()]
        self.assertIn("nvbandwidth-tool_missing", labels)

    def test_list_untracked_does_not_insert_a_service(self) -> None:
        stored_id = "a" * 64
        self.core.store.put_service_instance(
            {
                "schema_version": 1,
                "service_instance_id": "service-00000000-0000-4000-8000-000000000010",
                "ownership": "external",
                "provenance": "detected",
                "container_id": stored_id,
                "endpoint": "http://127.0.0.1:7000",
                "created_at": "2026-09-01T00:00:00Z",
            },
            "run-00000000-0000-4000-8000-000000000000",
        )
        vllm_id = "b" * 64
        sglang_id = "c" * 64
        self.core.set_control(
            ps_rows=[
                {"ID": stored_id, "Image": "vllm/vllm-openai:latest", "Command": "vllm serve", "Ports": "0.0.0.0:7000->8000/tcp"},
                {"ID": vllm_id, "Image": "vllm/vllm-openai:latest", "Command": "serve", "Ports": "0.0.0.0:8000->8000/tcp"},
                {"ID": sglang_id, "Image": "python:3.11", "Command": "python -m sglang.launch_server", "Ports": "127.0.0.1:30000->30000/tcp"},
                {"ID": "d" * 64, "Image": "nginx:alpine", "Command": "nginx", "Ports": "0.0.0.0:80->80/tcp"},
                {"ID": "e" * 64, "Image": "lmsysorg/sglang:latest", "Command": "python -m sglang.launch_server", "Ports": ""},
            ]
        )
        listed = self.core.request(inspect_service, {"action": "list"})
        untracked = listed["data"]["untracked"]
        self.assertEqual([item["container_id"] for item in untracked], [vllm_id, sglang_id])
        self.assertEqual(untracked[0]["runtime_kind"], "vllm")
        self.assertEqual(untracked[0]["endpoint"], "http://127.0.0.1:8000")
        self.assertEqual(untracked[1]["runtime_kind"], "sglang")
        self.assertEqual(untracked[1]["endpoint"], "http://127.0.0.1:30000")
        self.assertEqual(set(untracked[0]), {"container_id", "image", "endpoint", "runtime_kind"})
        self.assertEqual(len(listed["data"]["services"]), 1)
        self.assertEqual(len(self.core.store.list_facts("service_instance", limit=100)), 1)
        with self.assertRaises(ContractError) as raised:
            self.core.request(inspect_service, {"action": "get", "service_instance_id": vllm_id})
        self.assertEqual(raised.exception.code, "not_found")
        self.assertEqual(len(self.core.store.list_facts("service_instance", limit=100)), 1)

    def test_stop_untracked_container_id_does_not_stop_it(self) -> None:
        container_id = "f" * 64
        self.core.set_control(ps_rows=[{"ID": container_id, "Image": "vllm/vllm-openai", "Command": "vllm serve", "Ports": "0.0.0.0:8001->8000/tcp"}])
        listed = self.core.request(inspect_service, {"action": "list"})
        self.assertEqual(listed["data"]["untracked"][0]["container_id"], container_id)
        self.core.calls.clear()
        with self.assertRaises(ContractError) as raised:
            self.core.request(deploy_service, {"action": "stop", "service_instance_id": container_id})
        self.assertEqual(raised.exception.code, "invalid_input")
        self.assertEqual([call for call in self.core.calls if call[:3] == ["docker", "container", "stop"]], [])
        self.assertEqual(len(self.core.store.list_facts("service_instance", limit=100)), 0)


if __name__ == "__main__":
    unittest.main()
