"""Phase 7 stage 1: sweep rows stay even when one rung fails."""

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

TESTS_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_ROOT.parent / "src"))
sys.path.insert(0, str(TESTS_ROOT))

from bittune_core.benchmark import _GpuSampler  # noqa: E402
from bittune_core.contracts import ContractError  # noqa: E402
from bittune_core.suite import benchmark_suite, smoke_chat  # noqa: E402
from test_services_fake_docker import TWO_GPUS, FakeCore  # noqa: E402

MODEL_REF = {"schema_version": 1, "model_id": "Qwen/Qwen3-32B", "revision": "rev-0001"}
RUNTIME_SPEC = {"schema_version": 1, "runtime_kind": "vllm", "image_repository": "docker.io/vllm/vllm-openai", "image_digest": "sha256:" + "c" * 64}


def _metrics(success: float, rps: float) -> dict:
    return {
        "requests_per_second": rps,
        "output_tokens_per_second": rps * 10,
        "success_rate": success,
        "p99_e2e_latency_ms": 1000,
        "p99_ttft_ms": 100,
        "p50_ttft_ms": 40,
    }


class SweepTests(unittest.TestCase):
    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp(prefix="bittune-suite-"))
        self.core = FakeCore(self.work, str(self.work / "core"))
        self.core.set_control(gpus=TWO_GPUS, evalscope_ok=True)
        cache = self.work / "models"
        weights = cache / "models--Qwen--Qwen3-32B" / "snapshots" / "rev-0001"
        weights.mkdir(parents=True)
        (weights / "model.safetensors").write_bytes(b"\x00")
        os.environ["BITTUNE_MODEL_CACHE_ROOTS"] = str(cache)
        self.service_id = self._seed()

    def tearDown(self) -> None:
        self.core.close()
        os.environ.pop("BITTUNE_MODEL_CACHE_ROOTS", None)

    def _seed(self, serving: dict | None = None) -> str:
        plan_id = "plan-00000000-0000-4000-8000-000000000010"
        self.core.store.put_deployment_plan({
            "schema_version": 1,
            "plan_id": plan_id,
            "status": "frozen",
            "goal": "fixture",
            "rationale": "",
            "model_ref": MODEL_REF,
            "runtime_spec": RUNTIME_SPEC,
            "serving_spec": serving or {"max_model_len": 32768},
            "hardware_snapshot_id": None,
            "provenance": "declared",
            "created_at": "2026-09-01T00:00:00Z",
        }, "run-00000000-0000-4000-8000-000000000000")
        service_id = "service-22222222-2222-4222-8222-222222222210"
        self.core.store.put_service_instance({
            "schema_version": 1,
            "service_instance_id": service_id,
            "plan_id": plan_id,
            "ownership": "managed",
            "model_ref": MODEL_REF,
            "runtime_spec": RUNTIME_SPEC,
            "serving_spec": serving or {"max_model_len": 32768},
            "endpoint": "http://127.0.0.1:9",
            "observed_state": "ready",
            "provenance": "measured",
        }, "run-00000000-0000-4000-8000-000000000000")
        return service_id

    def _run(self, outcomes: list[dict], **params) -> dict:
        calls = {"n": 0}

        def fake_execute(*_args, **_kwargs):
            item = outcomes[min(calls["n"], len(outcomes) - 1)]
            calls["n"] += 1
            if not item.get("ok", True):
                failed = {"ok": False, "kind": item.get("kind", "process_failed")}
                if "exit_code" in item:
                    failed["exit_code"] = item["exit_code"]
                return failed
            result = {
                "ok": True,
                "timed_out": item.get("timed_out", False),
                "workload": {"concurrency": 1},
                "workload_hash": "sha256:" + "a" * 64,
                "metrics": item["metrics"],
                "distributions": {},
                "normalizer_version": "evalscope-normalizer-v3",
                "request_samples_available": True,
                "observed_gpu_memory_peak_bytes": 0,
                "summary_artifact": {"artifact_id": "artifact-00000000-0000-4000-8000-000000000099"},
                "provider_version": "1.10.0",
            }
            if "gpu_memory_samples" in item:
                result["gpu_memory_samples"] = item["gpu_memory_samples"]
            return result

        with patch("bittune_core.benchmark._endpoint_ready", return_value=True), patch("bittune_core.suite._smoke_blocked", return_value=False), patch("bittune_core.suite.execute_workload", fake_execute):
            body = {"intent": "performance_sweep", "service_instance_id": self.service_id}
            body.update(params)
            return self.core.request(benchmark_suite, body)

    def test_one_bad_rung_keeps_the_other_eight(self) -> None:
        outcomes = [{"ok": True, "metrics": _metrics(1, 10)}] * 9
        outcomes[2] = {"ok": False, "kind": "process_failed"}
        result = self._run(outcomes)
        rows = result["data"]["suite_result"]["rows"]
        self.assertEqual(len(rows), 9)
        self.assertEqual(sum(row["state"] == "invalid_measurement" for row in rows), 1)
        self.assertEqual(sum(row["state"] == "healthy" for row in rows), 8)

    def test_two_failing_signals_stop_the_scenario(self) -> None:
        outcomes = [
            {"ok": True, "metrics": _metrics(0.5, 10)},
            {"ok": True, "metrics": _metrics(0.4, 4)},
            {"ok": True, "metrics": _metrics(1, 9)},
        ]
        rows = self._run(outcomes)["data"]["suite_result"]["rows"]
        chat = [row for row in rows if row["scenario_id"] == "short-chat"]
        self.assertEqual([row["state"] for row in chat], ["healthy", "healthy", "not_run_early_stop"])
        self.assertEqual(chat[0]["goodput_req_per_s"], None)
        artifact_id = self.core.store.list_facts("suite_result")[0]["payload"]["early_stop_artifact_id"]
        text = self.core.store.read_artifact_excerpt(artifact_id, max_bytes=4000)["text"]
        self.assertIn("early-stop-v1", text)
        self.assertIn(chat[0]["benchmark_result_id"], text)
        self.assertIn(chat[1]["benchmark_result_id"], text)
        self.assertIn('"second_signal": "requests_per_second"', text)
        body = json.loads(text)
        self.assertEqual([item["scenario_id"] for item in body["stops"]], ["short-chat"])

    def test_two_scenarios_keep_both_early_stops(self) -> None:
        outcomes = [
            {"ok": True, "metrics": _metrics(0.5, 10)},
            {"ok": True, "metrics": _metrics(0.4, 4)},
            {"ok": True, "metrics": _metrics(0.5, 10)},
            {"ok": True, "metrics": _metrics(0.4, 4)},
            {"ok": True, "metrics": _metrics(1, 9)},
        ]
        result = self._run(outcomes)["data"]["suite_result"]
        rows = result["rows"]
        chat = [row for row in rows if row["scenario_id"] == "short-chat"]
        rag = [row for row in rows if row["scenario_id"] == "short-rag"]
        self.assertEqual([row["state"] for row in chat], ["healthy", "healthy", "not_run_early_stop"])
        self.assertEqual([row["state"] for row in rag], ["healthy", "healthy"])
        artifacts = self.core.store.db.execute("SELECT artifact_id FROM artifacts WHERE label = ?", ("early-stop",)).fetchall()
        self.assertEqual(len(artifacts), 1)
        self.assertEqual(result["early_stop_artifact_id"], artifacts[0]["artifact_id"])
        text = self.core.store.read_artifact_excerpt(artifacts[0]["artifact_id"], max_bytes=8000)["text"]
        body = json.loads(text)
        self.assertEqual([item["scenario_id"] for item in body["stops"]], ["short-chat", "short-rag"])
        self.assertEqual(body["stops"][0]["benchmark_result_id"], chat[1]["benchmark_result_id"])
        self.assertEqual(body["stops"][1]["benchmark_result_id"], rag[1]["benchmark_result_id"])

    def test_signal_kill_stops_only_that_scenario(self) -> None:
        outcomes = [{"ok": False, "kind": "process_failed", "exit_code": -9}] + [{"ok": True, "metrics": _metrics(1, 10)}] * 8
        calls = {"n": 0}

        def fake_execute(*_args, **_kwargs):
            item = outcomes[min(calls["n"], len(outcomes) - 1)]
            calls["n"] += 1
            if not item.get("ok", True):
                return {"ok": False, "kind": item["kind"], "exit_code": item["exit_code"]}
            return {
                "ok": True,
                "workload": {"concurrency": 1},
                "workload_hash": "sha256:" + "a" * 64,
                "metrics": item["metrics"],
                "distributions": {},
                "normalizer_version": "evalscope-normalizer-v3",
                "request_samples_available": True,
                "observed_gpu_memory_peak_bytes": 0,
                "summary_artifact": {"artifact_id": "artifact-00000000-0000-4000-8000-000000000099"},
                "provider_version": "1.10.0",
            }

        with patch("bittune_core.benchmark._endpoint_ready", return_value=True), patch("bittune_core.suite._smoke_blocked", return_value=False), patch("bittune_core.suite.execute_workload", fake_execute):
            rows = self.core.request(benchmark_suite, {"intent": "performance_sweep", "service_instance_id": self.service_id})["data"]["suite_result"]["rows"]
        chat = [row for row in rows if row["scenario_id"] == "short-chat"]
        self.assertEqual([row["reason_code"] for row in chat], ["process_killed", "safety_stop", "safety_stop"])
        self.assertTrue(all(row["state"] == "not_run_safety_stop" for row in chat))
        rag = [row for row in rows if row["scenario_id"] == "short-rag"]
        self.assertTrue(all(row["state"] == "healthy" for row in rag))
        self.assertEqual(calls["n"], 7)

    def test_endpoint_drop_sends_no_further_request(self) -> None:
        ready = {"n": 0}

        def endpoint(*_args, **_kwargs):
            ready["n"] += 1
            return ready["n"] == 1

        with patch("bittune_core.benchmark._endpoint_ready", side_effect=endpoint), patch("bittune_core.suite._smoke_blocked", return_value=False), patch("bittune_core.suite.execute_workload") as execute:
            rows = self.core.request(benchmark_suite, {"intent": "performance_sweep", "service_instance_id": self.service_id})["data"]["suite_result"]["rows"]
        execute.assert_not_called()
        self.assertTrue(all(row["state"] == "not_run_safety_stop" for row in rows))
        first = {}
        for row in rows:
            first.setdefault(row["scenario_id"], row["reason_code"])
        self.assertEqual(set(first.values()), {"service_not_ready"})

    def test_missing_gpu_sends_no_request(self) -> None:
        self.core.set_control(gpus=[], evalscope_ok=True)
        with patch("bittune_core.benchmark._endpoint_ready", return_value=True), patch("bittune_core.suite._smoke_blocked", return_value=False), patch("bittune_core.suite.execute_workload") as execute:
            rows = self.core.request(benchmark_suite, {"intent": "performance_sweep", "service_instance_id": self.service_id})["data"]["suite_result"]["rows"]
        execute.assert_not_called()
        self.assertTrue(all(row["state"] == "not_run_safety_stop" for row in rows))
        first = {}
        for row in rows:
            first.setdefault(row["scenario_id"], row["reason_code"])
        self.assertEqual(set(first.values()), {"gpu_missing"})

    def test_one_signal_does_not_stop(self) -> None:
        outcomes = [
            {"ok": True, "metrics": _metrics(0.5, 4)},
            {"ok": True, "metrics": _metrics(0.4, 8)},
            {"ok": True, "metrics": _metrics(1, 9)},
        ]
        rows = self._run(outcomes)["data"]["suite_result"]["rows"]
        chat = [row for row in rows if row["scenario_id"] == "short-chat"]
        self.assertEqual([row["state"] for row in chat], ["healthy", "healthy", "healthy"])

    def test_context_over_limit_sends_no_request(self) -> None:
        self.core.close()
        self.core = FakeCore(self.work, str(self.work / "core-short"))
        self.service_id = self._seed({"max_model_len": 100})
        with patch("bittune_core.benchmark._endpoint_ready", return_value=True), patch("bittune_core.suite._smoke_blocked", return_value=False), patch("bittune_core.suite.execute_workload") as execute:
            result = self.core.request(benchmark_suite, {"intent": "performance_sweep", "service_instance_id": self.service_id})
        execute.assert_not_called()
        states = {row["state"] for row in result["data"]["suite_result"]["rows"]}
        self.assertIn("unsupported_context_length", states)

    def test_timeout_with_complete_metrics_stays_healthy(self) -> None:
        outcomes = [{"ok": True, "timed_out": True, "metrics": _metrics(1, 8)}] * 9
        rows = self._run(outcomes)["data"]["suite_result"]["rows"]
        self.assertTrue(all(row["state"] == "healthy" for row in rows))

    def test_timeout_without_metrics_is_invalid(self) -> None:
        outcomes = [{"ok": False, "kind": "timed_out_partial"}] * 9
        rows = self._run(outcomes)["data"]["suite_result"]["rows"]
        self.assertTrue(all(row["state"] == "invalid_measurement" for row in rows))
        self.assertTrue(all(row["reason_code"] == "timed_out_partial" for row in rows))

    def test_missing_evalscope_writes_no_suite(self) -> None:
        self.core.set_control(gpus=TWO_GPUS, evalscope_ok=False)
        with patch("bittune_core.benchmark._endpoint_ready", return_value=True), self.assertRaises(ContractError) as raised:
            self.core.request(benchmark_suite, {"intent": "performance_sweep", "service_instance_id": self.service_id})
        self.assertEqual(raised.exception.code, "evalscope_unavailable")
        self.assertEqual(self.core.store.list_facts("suite_result"), [])

    def test_smoke_accepts_status_without_reading_a_stream(self) -> None:
        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        with patch("bittune_core.suite.urllib.request.urlopen", return_value=Response()):
            self.assertTrue(smoke_chat("http://127.0.0.1:9", "model", True))

    def _write_profile(self, registry: dict) -> str:
        path = self.work / "profile.json"
        path.write_text(json.dumps({
            "registry": registry,
            "acceptance": {"schema_version": 1, "success_rate_min": 0.99, "p99_e2e_latency_ms_max": 30000, "p99_ttft_ms_max": 5000},
        }), encoding="utf-8")
        return str(path)

    def test_adaptive_doubles_until_max_and_ignores_the_ladder(self) -> None:
        path = self._write_profile({
            "schema_version": 1,
            "profile_id": "adaptive-fixture",
            "concurrency_mode": "adaptive",
            "min_probe": 1,
            "max_probe": 4,
            "scenarios": [{
                "scenario_id": "short-chat",
                "input_tokens": 128,
                "output_tokens": 32,
                "concurrency": [99],
                "request_count": 2,
                "closed_loop": True,
                "stream": True,
                "ignore_eos": True,
                "temperature": 0,
                "seed": 7,
                "warmup_requests": 1,
                "request_timeout_seconds": 120,
                "representative": True,
            }],
        })
        rows = self._run([{"ok": True, "metrics": _metrics(1, 10)}] * 3, profile_path=path)["data"]["suite_result"]["rows"]
        self.assertEqual([row["concurrency"] for row in rows], [1, 2, 4])
        self.assertTrue(all(row.get("representative") is True for row in rows))
        self.assertNotIn(99, [row["concurrency"] for row in rows])
        artifact = self.core.store.db.execute("SELECT artifact_id FROM artifacts WHERE label = ?", ("adaptive-candidates",)).fetchone()
        text = self.core.store.read_artifact_excerpt(artifact["artifact_id"], max_bytes=4000)["text"]
        self.assertIn("healthy_times_two", text)
        self.assertIn("at_max_probe", text)

    def test_adaptive_unhealthy_rung_does_not_jump(self) -> None:
        path = self._write_profile({
            "schema_version": 1,
            "profile_id": "adaptive-fixture",
            "concurrency_mode": "adaptive",
            "min_probe": 1,
            "max_probe": 8,
            "scenarios": [{
                "scenario_id": "short-chat",
                "input_tokens": 128,
                "output_tokens": 32,
                "concurrency": [99],
                "request_count": 2,
                "closed_loop": True,
                "stream": True,
                "ignore_eos": True,
                "temperature": 0,
                "seed": 0,
                "warmup_requests": 1,
                "request_timeout_seconds": 120,
            }],
        })
        calls = {"n": 0}

        def fake_execute(*_args, **_kwargs):
            calls["n"] += 1
            return {"ok": False, "kind": "process_failed"}

        with patch("bittune_core.benchmark._endpoint_ready", return_value=True), patch("bittune_core.suite._smoke_blocked", return_value=False), patch("bittune_core.suite.execute_workload", fake_execute):
            rows = self.core.request(benchmark_suite, {
                "intent": "performance_sweep",
                "service_instance_id": self.service_id,
                "profile_path": path,
            })["data"]["suite_result"]["rows"]
        self.assertEqual(calls["n"], 1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["state"], "invalid_measurement")
        artifact = self.core.store.db.execute("SELECT artifact_id FROM artifacts WHERE label = ?", ("adaptive-candidates",)).fetchone()
        text = self.core.store.read_artifact_excerpt(artifact["artifact_id"], max_bytes=4000)["text"]
        self.assertIn("no_healthy_anchor", text)
        self.assertNotIn("healthy_times_two", text)

    def test_full_package_stability_uses_the_named_shape(self) -> None:
        path = self._write_profile({
            "schema_version": 1,
            "profile_id": "stability-fixture",
            "concurrency_mode": "ladder",
            "scenarios": [{
                "scenario_id": "long-shape",
                "scenario": "rag",
                "input_tokens": 16384,
                "output_tokens": 4096,
                "concurrency": [1],
                "request_count": 2,
                "closed_loop": True,
                "stream": True,
                "ignore_eos": True,
                "temperature": 0,
                "seed": 0,
                "warmup_requests": 1,
                "request_timeout_seconds": 120,
            }],
            "stability": {"scenario_id": "long-shape", "repeats": 2, "request_count": 4, "concurrency": 2},
        })
        series = {"interval_seconds": 0.5, "samples": [{"elapsed_ms": 0, "used_bytes": 1048576}]}
        outcomes = [
            {"ok": True, "metrics": _metrics(1, 10)},
            {"ok": True, "metrics": _metrics(1, 10), "gpu_memory_samples": series},
            {"ok": True, "metrics": _metrics(1, 10), "gpu_memory_samples": series},
        ]
        rows = self._run(outcomes, profile_path=path, package="full")["data"]["suite_result"]["rows"]
        stable = [row for row in rows if "repeat" in row]
        self.assertEqual([row["repeat"] for row in stable], [1, 2])
        self.assertEqual(stable[0]["projection"]["input_bucket"], "8193-32768")
        self.assertEqual(stable[0]["projection"]["output_bucket"], "2049-8192")
        self.assertEqual(stable[0]["concurrency"], 2)
        ladder = [row for row in rows if "repeat" not in row]
        self.assertEqual(len(ladder), 1)
        self.assertNotIn("gpu_memory_samples_artifact_id", ladder[0])
        self.assertIn("gpu_memory_samples_artifact_id", stable[0])
        self.assertIn("gpu_memory_samples_artifact_id", stable[1])
        self.assertNotEqual(stable[0]["gpu_memory_samples_artifact_id"], stable[1]["gpu_memory_samples_artifact_id"])
        text = self.core.store.read_artifact_excerpt(stable[0]["gpu_memory_samples_artifact_id"], max_bytes=4000)["text"]
        self.assertIn('"interval_seconds": 0.5', text)
        self.assertIn('"used_bytes": 1048576', text)

    def test_sampler_keeps_selected_device_polls(self) -> None:
        sampler = _GpuSampler([0], None, record_samples=True)
        sampler.started = 1000.0
        with patch("bittune_core.benchmark.time.monotonic", return_value=1000.5), patch(
            "bittune_core.benchmark.run_command",
            return_value={"exit_code": 0, "stdout": "0, 10\n1, 30\n", "stderr": ""},
        ):
            sampler._read()
        series = sampler.series()
        self.assertEqual(series["interval_seconds"], 0.5)
        self.assertEqual(series["samples"], [{"elapsed_ms": 500, "used_bytes": 10 * 1024 * 1024}])
        self.assertEqual(sampler.peak, 10 * 1024 * 1024)
        with patch("bittune_core.benchmark.run_command", return_value={"exit_code": 3, "stdout": "", "stderr": ""}):
            sampler._read()
        self.assertEqual(len(sampler.samples), 1)
        copied = sampler.series()["samples"]
        sampler.samples.append({"elapsed_ms": 9, "used_bytes": 1})
        self.assertEqual(copied, [{"elapsed_ms": 500, "used_bytes": 10 * 1024 * 1024}])
        quiet = _GpuSampler([], None)
        self.assertEqual(quiet.samples, [])

    def test_sampler_keeps_polling_after_one_failure(self) -> None:
        calls = {"n": 0}
        sampler = _GpuSampler([0], None, record_samples=True)

        def fake(*_args, **_kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                raise ContractError("timeout", "nvidia-smi 超时。")
            if calls["n"] >= 3:
                sampler._stop.set()
            return {"exit_code": 0, "stdout": "0, 8\n", "stderr": ""}

        with patch("bittune_core.benchmark.run_command", fake):
            sampler.start()
            sampler._thread.join(timeout=3)
        self.assertFalse(sampler._thread.is_alive())
        self.assertGreaterEqual(len(sampler.samples), 1)
        self.assertEqual(sampler.peak, 8 * 1024 * 1024)

    def test_stop_waits_for_the_poll_in_flight(self) -> None:
        entered = threading.Event()
        release = threading.Event()

        def fake(*_args, **_kwargs):
            entered.set()
            release.wait(2)
            return {"exit_code": 0, "stdout": "0, 4\n", "stderr": ""}

        sampler = _GpuSampler([0], None, record_samples=True)
        with patch("bittune_core.benchmark.run_command", fake):
            sampler.start()
            self.assertTrue(entered.wait(1))
            threading.Thread(target=lambda: (time.sleep(0.2), release.set()), daemon=True).start()
            peak = sampler.stop()
        self.assertEqual(peak, 4 * 1024 * 1024)
        self.assertEqual(len(sampler.series()["samples"]), 1)

    def test_stability_missing_scenario_is_invalid_profile(self) -> None:
        path = self._write_profile({
            "schema_version": 1,
            "profile_id": "stability-fixture",
            "concurrency_mode": "ladder",
            "scenarios": [{
                "scenario_id": "short-chat",
                "input_tokens": 128,
                "output_tokens": 32,
                "concurrency": [1],
                "request_count": 2,
                "closed_loop": True,
                "stream": True,
                "ignore_eos": True,
                "temperature": 0,
                "seed": 0,
                "warmup_requests": 1,
                "request_timeout_seconds": 120,
            }],
            "stability": {"scenario_id": "missing", "repeats": 1, "request_count": 2, "concurrency": 1},
        })
        with patch("bittune_core.benchmark._endpoint_ready", return_value=True), self.assertRaises(ContractError) as raised:
            self.core.request(benchmark_suite, {
                "intent": "performance_sweep",
                "service_instance_id": self.service_id,
                "profile_path": path,
                "package": "full",
            })
        self.assertEqual(raised.exception.code, "invalid_profile")
        self.assertEqual(self.core.store.list_facts("suite_result"), [])


if __name__ == "__main__":
    unittest.main()
