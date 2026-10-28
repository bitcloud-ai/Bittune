"""Benchmark, comparison and report fixtures against a fake EvalScope driver.

Every measured number in these tests flows from the fake raw EvalScope
reports through the real normalizer, into BenchmarkResult facts, and from
there into comparisons and rendered reports. Comparability refusals,
invalid metric claims, and failure/cancellation report paths are all
exercised without touching real GPUs or a real inference service.
"""

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TESTS_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_ROOT.parent / "src"))
sys.path.insert(0, str(TESTS_ROOT))

from bittune_core.contracts import ContractError  # noqa: E402
from bittune_core.benchmark import benchmark_service  # noqa: E402
from bittune_core.compare import compare_results  # noqa: E402
from bittune_core.reports import write_report  # noqa: E402
from bittune_core.store import CoreStore  # noqa: E402
from test_services_fake_docker import TWO_GPUS, FakeCore, MiniHttpServer, ready_routes  # noqa: E402

WORKLOAD = {"schema_version": 2, "mode": "closed_loop", "concurrency": 2, "request_count": 100, "input_tokens": 64, "output_tokens": 64, "warmup_requests": 0}

MODEL_REF = {"schema_version": 1, "model_id": "Qwen/Qwen3-32B", "revision": "rev-0001"}
RUNTIME_SPEC = {"schema_version": 1, "runtime_kind": "vllm", "image_repository": "docker.io/vllm/vllm-openai", "image_digest": "sha256:" + "c" * 64}


class BenchmarkReportTest(unittest.TestCase):
    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp(prefix="bittune-bench-"))
        self.core = FakeCore(self.work, str(self.work / "core"))
        self.core.set_control(gpus=TWO_GPUS, image_ok=True, run_ok=True, stop_ok=True, evalscope_ok=True)
        cache = self.work / "models"
        weights = cache / "models--Qwen--Qwen3-32B" / "snapshots" / "rev-0001"
        weights.mkdir(parents=True)
        (weights / "model-00001-of-00002.safetensors").write_bytes(b"\x00" * 64)
        os.environ["BITTUNE_MODEL_CACHE_ROOTS"] = str(cache)
        os.environ["BITTUNE_HOME"] = str(self.work / "core")
        self.server = MiniHttpServer(ready_routes())
        self.endpoint_port = self.server.port
        self.addCleanup(self.server.stop)

    def tearDown(self) -> None:
        self.core.close()
        os.environ.pop("BITTUNE_MODEL_CACHE_ROOTS", None)
        os.environ.pop("BITTUNE_HOME", None)

    def seed_plan_and_service(self, observed_state: str = "ready") -> tuple[str, str]:
        snapshot_id = "snapshot-bench-0000-0000-4000-8000-000000000001"
        self.core.store.put_hardware_snapshot({
            "schema_version": 1,
            "hardware_snapshot_id": snapshot_id,
            "observed_at": "2026-09-01T00:00:00Z",
            "provenance": "detected",
            "gpus": [{"name": "NVIDIA L40S", "compute_capability": "8.9", "memory_total_bytes": 48 * 1024 ** 3}],
        }, "run-00000000-0000-4000-8000-000000000000")
        plan = {
            "schema_version": 1,
            "plan_id": "plan-00000000-0000-4000-8000-000000000000",
            "status": "frozen",
            "goal": "fixture",
            "rationale": "",
            "model_ref": MODEL_REF,
            "runtime_spec": RUNTIME_SPEC,
            "serving_spec": {"tensor_parallel_size": 1},
            "hardware_snapshot_id": snapshot_id,
            "provenance": "declared",
            "created_at": "2026-09-01T00:00:00Z",
        }
        self.core.store.put_deployment_plan(plan, "run-00000000-0000-4000-8000-000000000000")
        service_id = "service-22222222-2222-4222-8222-222222222222"
        service = {
            "schema_version": 1,
            "service_instance_id": service_id,
            "plan_id": plan["plan_id"],
            "ownership": "managed",
            "model_ref": MODEL_REF,
            "runtime_spec": RUNTIME_SPEC,
            "serving_spec": {"tensor_parallel_size": 1, "enable_prefix_caching": False},
            "engine_args": ["--no-enable-prefix-caching"],
            "config_hash": "sha256:" + "c" * 64,
            "endpoint": f"http://127.0.0.1:{self.endpoint_port}",
            "port": self.endpoint_port,
            "container_id": "aaaa1111aaaa1111aaaa1111aaaa1111",
            "desired": "running",
            "observed_state": observed_state,
            "last_observed_at": "2026-09-01T00:00:00Z",
            "created_at": "2026-09-01T00:00:00Z",
            "provenance": "measured",
        }
        self.core.store.put_service_instance(service, "run-00000000-0000-4000-8000-000000000000")
        return service_id, "run-00000000-0000-4000-8000-000000000000"

    def test_benchmark_success_writes_measured_fact(self) -> None:
        service_id, _ = self.seed_plan_and_service()
        result = self.core.request(benchmark_service, {"service_instance_id": service_id, "workload": WORKLOAD})
        payload = result["data"]["benchmark_result"]
        metrics = payload["metrics"]
        self.assertAlmostEqual(metrics["success_rate"], 0.98)
        self.assertAlmostEqual(metrics["requests_per_second"], 12.5)
        self.assertAlmostEqual(metrics["output_tokens_per_second"], 800.0)
        self.assertAlmostEqual(metrics["mean_ttft_ms"], sum(50 + i % 10 for i in range(98)) / 98)
        self.assertTrue(payload["request_samples_available"])
        self.assertTrue(payload["workload_hash"].startswith("sha256:"))
        self.assertEqual(payload["schema_version"], 2)
        self.assertEqual(payload["workload"]["request_source"]["seed"], 0)
        self.assertEqual(payload["workload"]["generation"]["temperature"], 0)
        self.assertIn("p99_ttft_ms", metrics)
        self.assertEqual(payload["provenance"], "measured")
        # raw reports and summary are artifacts; facts survive reads with hashes
        stored = self.core.store.get_fact("benchmark_result", payload["benchmark_result_id"])
        self.assertEqual(stored["payload"]["metrics"]["success_rate"], 0.98)
        self.assertGreaterEqual(len(payload["artifact_ids"]), 3)  # preflight + cli + summary + raw files
        notes = self.core.store.db.execute("SELECT artifact_id FROM artifacts WHERE label = ?", ("benchmark-argv-notes",)).fetchone()
        recorded = json.loads(self.core.store.read_artifact_excerpt(notes["artifact_id"], max_bytes=2000)["text"])
        self.assertEqual(recorded["not_sent"], {})
        self.assertEqual(recorded["cli_parameters"]["seed"], 0)

    def test_sampling_parameters_reach_evalscope_argv(self) -> None:
        service_id, _ = self.seed_plan_and_service()
        for seed, temperature, top_p, stream in ((0, 0, 1, True), (17, 0.7, 0.8, False)):
            with self.subTest(seed=seed, stream=stream), mock.patch(
                "bittune_core.benchmark.run_command", wraps=self.core.fake_run_command
            ) as command:
                result = self.core.request(benchmark_service, {
                    "service_instance_id": service_id,
                    "workload": {**WORKLOAD, "seed": seed, "temperature": temperature, "top_p": top_p, "stream": stream},
                })
                argv = next(call.args[0] for call in command.call_args_list if call.args[0][:2] == ["evalscope", "perf"])
                self.assertEqual(argv[argv.index("--seed") + 1], str(seed))
                self.assertEqual(argv[argv.index("--temperature") + 1], str(temperature))
                self.assertEqual(argv[argv.index("--top-p") + 1], str(top_p))
                self.assertIn("--stream" if stream else "--no-stream", argv)
                self.assertEqual(json.loads(argv[argv.index("--extra-args") + 1]), {"ignore_eos": True})
                self.assertEqual(result["data"]["benchmark_result"]["workload"]["argv_profile_version"], "evalscope-perf-openai-random-v3")

    def test_missing_database_or_wrong_usage_does_not_create_fixed_shape_fact(self) -> None:
        service_id, _ = self.seed_plan_and_service()
        original = self.core.fake_evalscope
        for defect, code in (("missing", "benchmark_no_metrics"), ("wrong_input", "benchmark_token_shape_mismatch"), ("wrong_output", "benchmark_token_shape_mismatch")):
            def driver(argv):
                result = original(argv)
                if argv[:1] == ["perf"]:
                    path = Path(argv[argv.index("--outputs-dir") + 1]) / "benchmark_data.db"
                    if defect == "missing":
                        path.unlink()
                    else:
                        with sqlite3.connect(path) as db:
                            column = "prompt_tokens" if defect == "wrong_input" else "completion_tokens"
                            db.execute(f"UPDATE result SET {column}=63 WHERE success=1")
                return result
            with self.subTest(defect=defect), mock.patch.object(self.core, "fake_evalscope", side_effect=driver):
                with self.assertRaises(ContractError) as raised:
                    self.core.request(benchmark_service, {"service_instance_id": service_id, "workload": WORKLOAD})
                self.assertEqual(raised.exception.code, code)
                self.assertEqual(self.core.store.list_facts("benchmark_result"), [])

    def test_partial_database_never_creates_fact_and_failure_keeps_rows(self) -> None:
        from test_request_evidence import SCHEMA
        service_id, _ = self.seed_plan_and_service()
        original = self.core.fake_evalscope
        for outcome in ("completed", "failed", "timeout", "cancelled"):
            def driver(argv):
                result = original(argv)
                if argv[:1] == ["perf"]:
                    directory = Path(argv[argv.index("--outputs-dir") + 1])
                    with sqlite3.connect(directory / "benchmark_data.db") as db:
                        db.execute("DROP TABLE IF EXISTS result")
                        db.execute(SCHEMA)
                        db.execute("INSERT INTO result (success,is_stream,latency,inter_token_latencies) VALUES (1,1,0.1,'[]')")
                    if outcome == "failed":
                        result["exit_code"] = 1
                    elif outcome in ("timeout", "cancelled"):
                        raise ContractError(outcome, "fixture interruption")
                return result
            with self.subTest(outcome=outcome), mock.patch.object(self.core, "fake_evalscope", side_effect=driver):
                with self.assertRaises(ContractError):
                    self.core.request(benchmark_service, {"service_instance_id": service_id, "workload": WORKLOAD})
                self.assertEqual(self.core.store.list_facts("benchmark_result"), [])
        evidence = self.core.store.db.execute("SELECT artifact_id FROM artifacts WHERE label='evalscope-request-evidence'").fetchall()
        self.assertEqual(len(evidence), 4)
        for row in evidence:
            metadata = json.loads(self.core.store.read_artifact_text(row[0])["text"])
            self.assertEqual(metadata["status"], "invalid")
            self.assertEqual(metadata["row_count"], 1)
            self.assertEqual(len(metadata["artifact_ids"]), 1)

    def test_missing_evalscope_leaves_only_failed_run(self) -> None:
        service_id, _ = self.seed_plan_and_service()
        self.core.set_control(gpus=TWO_GPUS, evalscope_ok=False)
        with self.assertRaises(ContractError) as raised:
            self.core.request(benchmark_service, {"service_instance_id": service_id, "workload": WORKLOAD})
        self.assertEqual(raised.exception.code, "evalscope_unavailable")
        self.assertEqual(self.core.store.list_facts("benchmark_result"), [])
        failed_runs = [run for run in self.core.store.list_runs(status="failed") if run["tool_name"] == "benchmark_service"]
        self.assertEqual(len(failed_runs), 1)

    def test_empty_evalscope_reports_do_not_create_measured_fact(self) -> None:
        service_id, _ = self.seed_plan_and_service()
        self.core.set_control(gpus=TWO_GPUS, evalscope_ok=True, empty_metrics=True)
        with self.assertRaises(ContractError) as raised:
            self.core.request(benchmark_service, {"service_instance_id": service_id, "workload": WORKLOAD})
        self.assertEqual(raised.exception.code, "benchmark_no_metrics")
        self.assertEqual(self.core.store.list_facts("benchmark_result"), [])

    def test_non_ready_service_refused(self) -> None:
        service_id, _ = self.seed_plan_and_service(observed_state="starting")
        with self.assertRaises(ContractError) as raised:
            self.core.request(benchmark_service, {"service_instance_id": service_id, "workload": WORKLOAD})
        self.assertEqual(raised.exception.code, "service_not_ready")

    def test_comparison_and_experiment_recording(self) -> None:
        service_id, _ = self.seed_plan_and_service()
        first = self.core.request(benchmark_service, {"service_instance_id": service_id, "workload": WORKLOAD})["data"]["benchmark_result"]
        second_payload = dict(first)
        second_payload["benchmark_result_id"] = "bench-33333333-3333-4333-8333-333333333333"
        second_payload["metrics"] = {**first["metrics"], "requests_per_second": 15.0}
        self.core.store.put_benchmark_result(second_payload, "run-00000000-0000-4000-8000-000000000000")
        comparison = self.core.request(
            compare_results,
            {"benchmark_result_ids": [first["benchmark_result_id"], second_payload["benchmark_result_id"]], "objective": "requests_per_second", "hypothesis": "更大批处理提升吞吐", "record": True},
        )
        conclusion = comparison["data"]["comparison"]
        self.assertTrue(conclusion["comparable"])
        best = max(conclusion["deltas"], key=lambda item: item["delta_percent"])
        self.assertEqual(best["benchmark_result_id"], second_payload["benchmark_result_id"])
        experiment = comparison["data"]["experiment"]
        self.assertEqual(experiment["objective"], "requests_per_second")
        self.assertEqual(self.core.store.get_fact("experiment", experiment["experiment_id"])["payload"]["provenance"], "derived")
        # record absent -> transient conclusion only
        before = len(self.core.store.list_facts("experiment"))
        self.core.request(compare_results, {"benchmark_result_ids": [first["benchmark_result_id"], second_payload["benchmark_result_id"]]})
        self.assertEqual(len(self.core.store.list_facts("experiment")), before)

    def test_incomparable_results_refused(self) -> None:
        service_id, _ = self.seed_plan_and_service()
        first = self.core.request(benchmark_service, {"service_instance_id": service_id, "workload": WORKLOAD})["data"]["benchmark_result"]
        different_workload = dict(first)
        different_workload["benchmark_result_id"] = "bench-44444444-4444-4444-8444-444444444444"
        different_workload["workload"] = {**first["workload"], "concurrency": 8}
        different_workload["workload_hash"] = "sha256:" + "d" * 64
        self.core.store.put_benchmark_result(different_workload, "run-00000000-0000-4000-8000-000000000000")
        comparison = self.core.request(compare_results, {"benchmark_result_ids": [first["benchmark_result_id"], different_workload["benchmark_result_id"]], "record": True})
        self.assertFalse(comparison["data"]["comparison"]["comparable"])
        self.assertNotIn("deltas", comparison["data"]["comparison"])
        self.assertEqual(self.core.store.list_facts("experiment"), [])

    def test_comparison_refuses_missing_objective_and_zero_baseline(self) -> None:
        service_id, _ = self.seed_plan_and_service()
        first = self.core.request(benchmark_service, {"service_instance_id": service_id, "workload": WORKLOAD})["data"]["benchmark_result"]
        missing = dict(first)
        missing["benchmark_result_id"] = "bench-66666666-6666-4666-8666-666666666666"
        missing["metrics"] = {"success_rate": 0.9}
        self.core.store.put_benchmark_result(missing, "run-00000000-0000-4000-8000-000000000000")
        with self.assertRaises(ContractError) as raised:
            self.core.request(compare_results, {"benchmark_result_ids": [first["benchmark_result_id"], missing["benchmark_result_id"]], "objective": "requests_per_second"})
        self.assertEqual(raised.exception.code, "invalid_input")

        zero = dict(first)
        zero["benchmark_result_id"] = "bench-77777777-7777-4777-8777-777777777777"
        zero["metrics"] = {**first["metrics"], "requests_per_second": 0}
        self.core.store.put_benchmark_result(zero, "run-00000000-0000-4000-8000-000000000000")
        with self.assertRaises(ContractError) as raised:
            self.core.request(compare_results, {"benchmark_result_ids": [zero["benchmark_result_id"], first["benchmark_result_id"]], "objective": "requests_per_second"})
        self.assertEqual(raised.exception.code, "invalid_input")

    def test_report_renders_measured_claims_and_rejects_invented_ones(self) -> None:
        service_id, _ = self.seed_plan_and_service()
        benchmark = self.core.request(benchmark_service, {"service_instance_id": service_id, "workload": WORKLOAD})["data"]["benchmark_result"]
        snapshot = {
            "schema_version": 1,
            "hardware_snapshot_id": "snapshot-abcdef00-1111-4111-8111-abcdef012345",
            "observed_at": "2026-09-01T00:00:00Z",
            "host_id": "GPU-uuid-0",
            "provenance": "detected",
            "gpus": [{"name": "Fake RTX 4090", "driver_version": "550.54.15"}],
            "topology": {"gpu_count": 2},
            "kernel": "Linux fakehost",
        }
        self.core.store.put_hardware_snapshot(snapshot, "run-00000000-0000-4000-8000-000000000000")
        report_result = self.core.request(
            write_report,
            {
                "title": "压测报告",
                "scope": "验证 fixture 服务吞吐",
                "narrative": "仅有叙述性估算 estimated 可在此出现。",
                "conclusion": "吞吐符合预期。",
                "references": {
                    "hardware_snapshot_ids": [snapshot["hardware_snapshot_id"]],
                    "benchmark_result_ids": [benchmark["benchmark_result_id"]],
                    "service_instance_ids": [service_id],
                },
                "metric_claims": [
                    {"benchmark_result_id": benchmark["benchmark_result_id"], "metric": "requests_per_second", "label": "吞吐"},
                    {"benchmark_result_id": benchmark["benchmark_result_id"], "metric": "success_rate", "label": "成功率"},
                ],
            },
        )
        report = report_result["data"]["report"]
        self.assertEqual(report["provenance"], "derived")
        markdown = self.core.store.read_artifact_excerpt(report["artifact_ids"][0], max_bytes=65536)["text"]
        self.assertIn("12.5 req/s", markdown)
        self.assertIn("98.00 %", markdown)
        self.assertIn(benchmark["benchmark_result_id"], markdown)
        self.assertIn("估算", markdown)
        self.assertIn("## 环境", markdown)
        self.assertIn("2×GPU", markdown)
        self.assertIn(snapshot["hardware_snapshot_id"], markdown)
        with self.assertRaises(ContractError) as raised:
            self.core.request(write_report, {
                "title": "坏报告",
                "conclusion": "x",
                "metric_claims": [{"benchmark_result_id": benchmark["benchmark_result_id"], "metric": "gpu_clock_hz"}],
            })
        self.assertEqual(raised.exception.code, "invalid_metric_claim")

    def test_metric_claim_must_be_in_report_references(self) -> None:
        service_id, _ = self.seed_plan_and_service()
        benchmark = self.core.request(benchmark_service, {"service_instance_id": service_id, "workload": WORKLOAD})["data"]["benchmark_result"]
        with self.assertRaises(ContractError) as raised:
            self.core.request(write_report, {
                "title": "缺少引用",
                "conclusion": "x",
                "metric_claims": [{"benchmark_result_id": benchmark["benchmark_result_id"], "metric": "requests_per_second"}],
            })
        self.assertEqual(raised.exception.code, "invalid_metric_claim")

    def test_unknown_reference_names_are_not_silently_dropped(self) -> None:
        with self.assertRaises(ContractError) as raised:
            self.core.request(write_report, {"title": "reference contract", "narrative": "No measurements.", "conclusion": "incomplete", "references": {"deployment_plan": ["plan-placeholder"]}})
        self.assertEqual(raised.exception.code, "invalid_input")
        self.assertIn("plan_ids", raised.exception.details["supported_fields"])
        self.assertEqual(self.core.store.list_facts("report"), [])

    def test_failure_report_without_benchmarks_uses_run_evidence(self) -> None:
        service_id, _ = self.seed_plan_and_service()
        self.core.set_control(gpus=TWO_GPUS, evalscope_ok=False)
        try:
            self.core.request(benchmark_service, {"service_instance_id": service_id, "workload": WORKLOAD})
        except ContractError:
            pass
        failed_runs = [run for run in self.core.store.list_runs(status="failed") if run["tool_name"] == "benchmark_service"]
        self.assertEqual(len(failed_runs), 1)
        report_result = self.core.request(
            write_report,
            {
                "title": "失败部署报告",
                "scope": "尝试压测，EvalScope 缺失",
                "narrative": "工具链缺失导致压测无法执行。",
                "conclusion": "环境准备不完整，压测未产生实测结果。",
                "references": {"run_ids": [failed_runs[0]["run_id"]], "service_instance_ids": [service_id]},
            },
        )
        report = report_result["data"]["report"]
        self.assertEqual(report["metric_claims"], [])
        self.assertEqual(self.core.store.get_fact("report", report["report_id"])["payload"]["provenance"], "derived")

    def test_no_gain_report_references_experiment(self) -> None:
        service_id, _ = self.seed_plan_and_service()
        first = self.core.request(benchmark_service, {"service_instance_id": service_id, "workload": WORKLOAD})["data"]["benchmark_result"]
        same = dict(first)
        same["benchmark_result_id"] = "bench-55555555-5555-4555-8555-555555555555"
        same["metrics"] = {**first["metrics"], "requests_per_second": first["metrics"]["requests_per_second"] * 1.002}
        self.core.store.put_benchmark_result(same, "run-00000000-0000-4000-8000-000000000000")
        comparison = self.core.request(compare_results, {"benchmark_result_ids": [first["benchmark_result_id"], same["benchmark_result_id"]], "objective": "requests_per_second", "record": True})
        experiment = comparison["data"]["experiment"]
        verdicts = [item["verdict"] for item in comparison["data"]["comparison"]["deltas"]]
        self.assertEqual(verdicts, ["within_1pct"])
        interpretation = comparison["data"]["comparison"]["interpretation"]
        self.assertIn("不是统计显著性检验", interpretation)
        report_result = self.core.request(
            write_report,
            {
                "title": "无增益报告",
                "scope": "候选配置没有可测增益",
                "narrative": "delta 在 ±1% 阈值内，数值比较 verdict 为 within_1pct。",
                "conclusion": "该候选无增益，保留基线配置。",
                "references": {"experiment_ids": [experiment["experiment_id"]], "benchmark_result_ids": [first["benchmark_result_id"], same["benchmark_result_id"]]},
                "metric_claims": [{"benchmark_result_id": first["benchmark_result_id"], "metric": "requests_per_second", "label": "基线吞吐"}],
            },
        )
        markdown = self.core.store.read_artifact_excerpt(report_result["data"]["report"]["artifact_ids"][0], max_bytes=65536)["text"]
        self.assertIn("比较", markdown)
        self.assertIn(experiment["experiment_id"], markdown)


if __name__ == "__main__":
    unittest.main()
