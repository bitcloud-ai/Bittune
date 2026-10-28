"""Declared loopback measurements stay out of signed claims.

A loopback benchmark is measured provenance with binding declared. It does not
create a service row, and metric and suite claims reject it.
"""

import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

TESTS_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_ROOT.parent / "src"))
sys.path.insert(0, str(TESTS_ROOT))

from bittune_core.benchmark import benchmark_service, resolve_measure_subject  # noqa: E402
from bittune_core.cache_pair import _base as cache_base  # noqa: E402
from bittune_core.contracts import ContractError, claimable  # noqa: E402
from bittune_core.correctness import _base as correctness_base  # noqa: E402
from bittune_core.pd_capacity import _base as pd_base  # noqa: E402
from bittune_core.reports import write_report  # noqa: E402
from bittune_core.store import CoreStore  # noqa: E402
from bittune_core.suite import benchmark_suite  # noqa: E402
from test_services_fake_docker import TWO_GPUS, FakeCore, MiniHttpServer, ready_routes  # noqa: E402

WORKLOAD = {"schema_version": 2, "mode": "closed_loop", "concurrency": 2, "request_count": 100, "input_tokens": 64, "output_tokens": 64, "warmup_requests": 0}
MODEL_REF = {"schema_version": 1, "model_id": "Qwen/Qwen3-32B", "revision": "rev-0001"}
RUNTIME_SPEC = {"schema_version": 1, "runtime_kind": "vllm", "image_repository": "docker.io/vllm/vllm-openai", "image_digest": "sha256:" + "c" * 64}
ENDPOINT = {"url": "", "model_id": "Qwen/Qwen3-32B", "revision": "rev-0001"}
RUN_ID = "run-00000000-0000-4000-8000-000000000000"


def _metrics(success: float, rps: float) -> dict:
    return {
        "requests_per_second": rps,
        "output_tokens_per_second": rps * 10,
        "success_rate": success,
        "p99_e2e_latency_ms": 1000,
        "p99_ttft_ms": 100,
        "p50_ttft_ms": 40,
    }


class DeclaredMeasureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp(prefix="bittune-declared-"))
        self.core = FakeCore(self.work, str(self.work / "core"))
        self.core.set_control(gpus=TWO_GPUS, evalscope_ok=True)
        cache = self.work / "models"
        weights = cache / "models--Qwen--Qwen3-32B" / "snapshots" / "rev-0001"
        weights.mkdir(parents=True)
        (weights / "model.safetensors").write_bytes(b"\x00")
        os.environ["BITTUNE_MODEL_CACHE_ROOTS"] = str(cache)
        self.server = MiniHttpServer(ready_routes())
        self.addCleanup(self.server.stop)
        self.endpoint = {"url": f"http://127.0.0.1:{self.server.port}", "model_id": "Qwen/Qwen3-32B", "revision": "rev-0001"}

    def tearDown(self) -> None:
        self.core.close()
        os.environ.pop("BITTUNE_MODEL_CACHE_ROOTS", None)

    def _service_count(self) -> int:
        return self.core.store.db.execute("SELECT COUNT(*) AS n FROM service_instances").fetchone()["n"]

    def _seed_service(self, observed_state: str = "ready") -> str:
        plan_id = "plan-00000000-0000-4000-8000-000000000020"
        self.core.store.put_deployment_plan({
            "schema_version": 1,
            "plan_id": plan_id,
            "status": "frozen",
            "goal": "fixture",
            "rationale": "",
            "model_ref": MODEL_REF,
            "runtime_spec": RUNTIME_SPEC,
            "serving_spec": {"tensor_parallel_size": 1},
            "hardware_snapshot_id": None,
            "provenance": "declared",
            "created_at": "2026-09-01T00:00:00Z",
        }, RUN_ID)
        service_id = "service-22222222-2222-4222-8222-222222222220"
        self.core.store.put_service_instance({
            "schema_version": 1,
            "service_instance_id": service_id,
            "plan_id": plan_id,
            "ownership": "managed",
            "model_ref": MODEL_REF,
            "runtime_spec": RUNTIME_SPEC,
            "serving_spec": {"tensor_parallel_size": 1},
            "endpoint": f"http://127.0.0.1:{self.server.port}",
            "observed_state": observed_state,
            "provenance": "measured",
        }, RUN_ID)
        return service_id

    def _snapshot(self) -> None:
        self.core.store.put_hardware_snapshot({
            "schema_version": 1,
            "hardware_snapshot_id": "hw-00000000-0000-4000-8000-000000000001",
            "observed_at": "2026-09-01T00:00:00Z",
            "gpus": [
                {"name": "NVIDIA L40S", "compute_capability": "8.9", "memory_total_bytes": 48 * 1024**3},
                {"name": "NVIDIA L40S", "compute_capability": "8.9", "memory_total_bytes": 48 * 1024**3},
            ],
            "provenance": "measured",
        }, RUN_ID)

    def test_old_database_accepts_null_service_id(self) -> None:
        home = self.work / "old-core"
        home.mkdir()
        db = sqlite3.connect(home / "bittune.db")
        db.executescript(
            """
            CREATE TABLE benchmark_results (
              benchmark_result_id TEXT PRIMARY KEY,
              service_instance_id TEXT NOT NULL,
              workload_hash TEXT NOT NULL,
              hardware_snapshot_id TEXT,
              model_id TEXT,
              model_revision TEXT,
              runtime_kind TEXT,
              source_run_id TEXT NOT NULL,
              created_at TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              content_hash TEXT NOT NULL
            );
            CREATE TABLE suite_results (
              suite_result_id TEXT PRIMARY KEY,
              service_instance_id TEXT NOT NULL,
              profile_id TEXT NOT NULL,
              profile_hash TEXT NOT NULL,
              model_id TEXT,
              model_revision TEXT,
              runtime_kind TEXT,
              hardware_snapshot_id TEXT,
              source_run_id TEXT NOT NULL,
              created_at TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              content_hash TEXT NOT NULL
            );
            CREATE TABLE correctness_results (
              correctness_result_id TEXT PRIMARY KEY,
              service_instance_id TEXT NOT NULL,
              profile_id TEXT NOT NULL,
              source_run_id TEXT NOT NULL,
              created_at TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              content_hash TEXT NOT NULL
            );
            CREATE TABLE cache_pair_results (
              cache_pair_result_id TEXT PRIMARY KEY,
              service_instance_id TEXT NOT NULL,
              profile_id TEXT NOT NULL,
              source_run_id TEXT NOT NULL,
              created_at TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              content_hash TEXT NOT NULL
            );
            CREATE TABLE pd_estimates (
              pd_estimate_id TEXT PRIMARY KEY,
              service_instance_id TEXT NOT NULL,
              profile_id TEXT NOT NULL,
              source_run_id TEXT NOT NULL,
              created_at TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              content_hash TEXT NOT NULL
            );
            """
        )
        db.execute(
            "INSERT INTO benchmark_results VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)",
            ("bench-bound", "service-bound", "sha256:" + "a" * 64, RUN_ID, "2026-09-01T00:00:00Z", "{}", "hash"),
        )
        db.commit()
        db.close()
        store = CoreStore(home)
        self.addCleanup(store.close)
        for table in ("benchmark_results", "suite_results", "correctness_results", "cache_pair_results", "pd_estimates"):
            row = next(item for item in store.db.execute(f"PRAGMA table_info({table})") if item["name"] == "service_instance_id")
            self.assertEqual(row["notnull"], 0, table)
        kept = store.db.execute("SELECT service_instance_id FROM benchmark_results WHERE benchmark_result_id = ?", ("bench-bound",)).fetchone()
        self.assertEqual(kept["service_instance_id"], "service-bound")
        store.put_benchmark_result({"benchmark_result_id": "bench-null", "workload_hash": "sha256:" + "b" * 64, "provenance": "measured", "measured_at": "2026-09-01T00:00:00Z"}, RUN_ID)
        store.put_suite_result({"suite_result_id": "suite-null", "profile_id": "p", "profile_hash": "h", "provenance": "derived", "created_at": "2026-09-01T00:00:00Z"}, RUN_ID)
        store.put_correctness_result({"correctness_result_id": "correct-null", "profile_id": "p", "provenance": "derived", "created_at": "2026-09-01T00:00:00Z"}, RUN_ID)
        store.put_cache_pair_result({"cache_pair_result_id": "cache-null", "profile_id": "p", "provenance": "derived", "created_at": "2026-09-01T00:00:00Z"}, RUN_ID)
        store.put_pd_estimate({"pd_estimate_id": "pd-null", "profile_id": "p", "provenance": "derived", "created_at": "2026-09-01T00:00:00Z"}, RUN_ID)
        for table, column, fact_id in (
            ("benchmark_results", "benchmark_result_id", "bench-null"),
            ("suite_results", "suite_result_id", "suite-null"),
            ("correctness_results", "correctness_result_id", "correct-null"),
            ("cache_pair_results", "cache_pair_result_id", "cache-null"),
            ("pd_estimates", "pd_estimate_id", "pd-null"),
        ):
            stored = store.db.execute(f"SELECT service_instance_id FROM {table} WHERE {column} = ?", (fact_id,)).fetchone()
            self.assertIsNone(stored["service_instance_id"])

    def test_declared_benchmark_omits_service_and_is_not_claimable(self) -> None:
        before = self._service_count()
        payload = self.core.request(benchmark_service, {"endpoint": self.endpoint, "workload": WORKLOAD})["data"]["benchmark_result"]
        self.assertEqual(self._service_count(), before)
        self.assertEqual(payload["binding"], "declared")
        self.assertEqual(payload["provenance"], "measured")
        self.assertNotIn("service_instance_id", payload)
        self.assertNotIn("plan_id", payload)
        self.assertNotIn("hardware_snapshot_id", payload)
        self.assertNotIn("hardware_fingerprint", payload)
        self.assertEqual(payload["endpoint"]["url"], self.endpoint["url"])
        self.assertFalse(claimable(payload))
        column = self.core.store.db.execute(
            "SELECT service_instance_id FROM benchmark_results WHERE benchmark_result_id = ?",
            (payload["benchmark_result_id"],),
        ).fetchone()
        self.assertIsNone(column["service_instance_id"])
        self.assertEqual(self.core.store.list_facts("hardware_snapshot"), [])

    def test_declared_benchmark_keeps_client_fingerprint_when_a_snapshot_exists(self) -> None:
        self._snapshot()
        payload = self.core.request(benchmark_service, {"endpoint": self.endpoint, "workload": WORKLOAD})["data"]["benchmark_result"]
        self.assertEqual(payload["hardware_fingerprint"], {
            "source": "client",
            "family": "L40S",
            "gpu_count": 2,
            "vram_gib": 48,
            "gpu_arch": "Ada",
        })

    def test_bound_success_stays_claimable_and_not_ready_still_refuses(self) -> None:
        service_id = self._seed_service()
        payload = self.core.request(benchmark_service, {"service_instance_id": service_id, "workload": WORKLOAD})["data"]["benchmark_result"]
        self.assertEqual(payload["binding"], "bound")
        self.assertEqual(payload["service_instance_id"], service_id)
        self.assertTrue(claimable(payload))
        report = self.core.request(write_report, {
            "title": "bound",
            "narrative": "n",
            "conclusion": "c",
            "references": {"benchmark_result_ids": [payload["benchmark_result_id"]]},
            "metric_claims": [{"benchmark_result_id": payload["benchmark_result_id"], "metric": "success_rate"}],
        })
        self.assertEqual(report["data"]["report"]["metric_claims"][0]["metric"], "success_rate")

        stopped = self._seed_service("stopped")
        with self.assertRaises(ContractError) as raised:
            self.core.request(benchmark_service, {"service_instance_id": stopped, "workload": WORKLOAD})
        self.assertEqual(raised.exception.code, "service_not_ready")

    def test_bad_subject_creates_no_service(self) -> None:
        before = self._service_count()
        cases = [
            {"endpoint": {"url": "http://example.com", "model_id": "Qwen/Qwen3-32B"}, "workload": WORKLOAD},
            {"endpoint": {"url": "http://169.254.169.254/", "model_id": "Qwen/Qwen3-32B"}, "workload": WORKLOAD},
            {"endpoint": {"url": "file:///tmp/x", "model_id": "Qwen/Qwen3-32B"}, "workload": WORKLOAD},
            {"endpoint": {"url": "http://user:pass@127.0.0.1/", "model_id": "Qwen/Qwen3-32B"}, "workload": WORKLOAD},
            {"service_instance_id": "service-1", "endpoint": self.endpoint, "workload": WORKLOAD},
            {"approved": True, "endpoint": self.endpoint, "workload": WORKLOAD},
            {"endpoint": {**self.endpoint, "approved": True}, "workload": WORKLOAD},
        ]
        for params in cases:
            with self.assertRaises(ContractError) as raised:
                self.core.request(benchmark_service, params)
            self.assertEqual(raised.exception.code, "invalid_input", params)
        self.assertEqual(self._service_count(), before)
        with self.assertRaises(ContractError) as approved:
            resolve_measure_subject({"approved": True}, self.core.store, self.core.no_cancel)
        self.assertIn("确认不能作为参数传入", approved.exception.message)

    def test_missing_tokenizer_does_not_say_deploy(self) -> None:
        os.environ["BITTUNE_MODEL_CACHE_ROOTS"] = str(self.work / "empty")
        with self.assertRaises(ContractError) as raised:
            self.core.request(benchmark_service, {"endpoint": self.endpoint, "workload": WORKLOAD})
        self.assertEqual(raised.exception.code, "model_snapshot_missing")
        self.assertNotIn("部署", raised.exception.message)
        self.assertNotIn("部署", raised.exception.remediation or "")

    def test_claims_reject_declared_benchmark(self) -> None:
        payload = self.core.request(benchmark_service, {"endpoint": self.endpoint, "workload": WORKLOAD})["data"]["benchmark_result"]
        benchmark_id = payload["benchmark_result_id"]
        with self.assertRaises(ContractError) as claimed:
            self.core.request(write_report, {
                "title": "declared",
                "narrative": "n",
                "conclusion": "c",
                "references": {"benchmark_result_ids": [benchmark_id]},
                "metric_claims": [{"benchmark_result_id": benchmark_id, "metric": "success_rate"}],
            })
        self.assertEqual(claimed.exception.code, "invalid_input")
        self.assertIn("不是产品签字的实测", claimed.exception.message)
        report = self.core.request(write_report, {
            "title": "declared",
            "narrative": "n",
            "conclusion": "c",
            "references": {"benchmark_result_ids": [benchmark_id]},
        })["data"]["report"]

    def test_declared_suite_shares_the_resolver_and_cannot_be_claimed(self) -> None:
        source = Path(TESTS_ROOT.parent / "src" / "bittune_core" / "suite.py").read_text(encoding="utf-8")
        self.assertNotIn("urlparse", source)
        self.assertNotIn("127.0.0.1", source)
        before = self._service_count()

        def fake_execute(*_args, **_kwargs):
            return {
                "ok": True,
                "workload": {"concurrency": 1},
                "workload_hash": "sha256:" + "a" * 64,
                "metrics": _metrics(1, 10),
                "distributions": {},
                "normalizer_version": "evalscope-normalizer-v3",
                "request_samples_available": True,
                "observed_gpu_memory_peak_bytes": 0,
                "summary_artifact": {"artifact_id": "artifact-00000000-0000-4000-8000-000000000099"},
                "provider_version": "1.10.0",
            }

        with patch("bittune_core.benchmark._endpoint_ready", return_value=True), patch("bittune_core.suite._smoke_blocked", return_value=False), patch("bittune_core.suite.execute_workload", fake_execute):
            result = self.core.request(benchmark_suite, {"intent": "performance_sweep", "endpoint": self.endpoint})
        suite = result["data"]["suite_result"]
        self.assertEqual(self._service_count(), before)
        self.assertNotIn("service_instance_id", suite)
        self.assertEqual(suite["binding"], "declared")
        self.assertTrue(suite["rows"])
        self.assertTrue(all(row["binding"] == "declared" for row in suite["rows"]))
        healthy = next(row for row in suite["rows"] if row["state"] == "healthy")
        benchmark = self.core.store.get_fact("benchmark_result", healthy["benchmark_result_id"])["payload"]
        self.assertNotIn("service_instance_id", benchmark)
        self.assertEqual(benchmark["binding"], "declared")
        self.assertFalse(claimable(benchmark))
        stored = self.core.store.db.execute(
            "SELECT service_instance_id FROM suite_results WHERE suite_result_id = ?",
            (suite["suite_result_id"],),
        ).fetchone()
        self.assertIsNone(stored["service_instance_id"])
        with self.assertRaises(ContractError) as claimed:
            self.core.request(write_report, {
                "title": "suite",
                "narrative": "n",
                "conclusion": "c",
                "references": {"suite_result_ids": [suite["suite_result_id"]]},
                "suite_claims": [{
                    "suite_result_id": suite["suite_result_id"],
                    "scenario_id": healthy["scenario_id"],
                    "concurrency": healthy["concurrency"],
                    "metric": "requests_per_second",
                }],
            })
        self.assertIn("不是产品签字的实测", claimed.exception.message)

    def test_other_declared_facts_do_not_create_a_service(self) -> None:
        before = self._service_count()
        subject = resolve_measure_subject({"endpoint": self.endpoint}, self.core.store, self.core.no_cancel)
        profile = {"profile_id": "profile-1"}
        correctness = correctness_base(subject, profile, "evidence_insufficient", "pack_missing", "没有包。")
        cache = cache_base(subject, profile, "not_applicable", "runtime_unsupported", "无 flush。")
        suite = {
            "suite_result_id": "suite-declared",
            "profile_id": "profile-1",
            "binding": subject["binding"],
            "endpoint": subject["endpoint_record"],
            "model_ref": subject["model_ref"],
            "runtime_spec": {},
        }
        estimate = pd_base(suite, "evidence_insufficient", "anchor_missing", "缺少锚点。")
        self.core.store.put_correctness_result(correctness, RUN_ID)
        self.core.store.put_cache_pair_result(cache, RUN_ID)
        self.core.store.put_pd_estimate(estimate, RUN_ID)
        self.assertEqual(self._service_count(), before)
        for table, column, fact_id in (
            ("correctness_results", "correctness_result_id", correctness["correctness_result_id"]),
            ("cache_pair_results", "cache_pair_result_id", cache["cache_pair_result_id"]),
            ("pd_estimates", "pd_estimate_id", estimate["pd_estimate_id"]),
        ):
            stored = self.core.store.db.execute(f"SELECT service_instance_id FROM {table} WHERE {column} = ?", (fact_id,)).fetchone()
            self.assertIsNone(stored["service_instance_id"])
            self.assertNotIn("service_instance_id", {"correctness": correctness, "cache": cache, "pd": estimate}[{"correctness_results": "correctness", "cache_pair_results": "cache", "pd_estimates": "pd"}[table]])


if __name__ == "__main__":
    unittest.main()
