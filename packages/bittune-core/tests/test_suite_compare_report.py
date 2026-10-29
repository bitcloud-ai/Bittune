"""Phase 7 stage 2: suite points compare separately from single-point hashes."""

import sys
import unittest
from pathlib import Path

TESTS_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_ROOT.parent / "src"))
sys.path.insert(0, str(TESTS_ROOT))

from bittune_core.compare import compare_results  # noqa: E402
from bittune_core.contracts import ContractError  # noqa: E402
from bittune_core.reports import write_report  # noqa: E402
from bittune_core.store import utc_now  # noqa: E402
from test_suite_sweep import MODEL_REF, RUNTIME_SPEC, SweepTests  # noqa: E402

PROJECTION = {"scenario": "chat", "input_bucket": "0-2048", "output_bucket": "0-2048", "load_bucket": "1"}


class CompareReportTests(SweepTests):
    def _suite(self, suite_id: str, concurrency: int, goodput: float, serving: dict | None = None, rows: list[dict] | None = None) -> None:
        try:
            self.core.store.get_fact("hardware_snapshot", "snapshot-same")
        except ContractError:
            self.core.store.put_hardware_snapshot({
                "schema_version": 1,
                "hardware_snapshot_id": "snapshot-same",
                "observed_at": "2026-09-01T00:00:00Z",
                "provenance": "detected",
                "gpus": [{"name": "NVIDIA L40S", "compute_capability": "8.9", "memory_total_bytes": 48 * 1024 ** 3}],
            }, "run-00000000-0000-4000-8000-000000000000")
        self.core.store.put_suite_result({
            "schema_version": 1,
            "suite_result_id": suite_id,
            "profile_id": "bittune-default-v1",
            "profile_hash": "sha256:" + "c" * 64,
            "service_instance_id": self.service_id,
            "model_ref": MODEL_REF,
            "runtime_spec": RUNTIME_SPEC,
            "serving_spec": serving or {"max_num_seqs": 16},
            "hardware_snapshot_id": "snapshot-same",
            "rows": rows or [{
                "scenario_id": "short-chat",
                "projection": PROJECTION,
                "concurrency": concurrency,
                "state": "healthy",
                "reason_code": "ok",
                "reason_detail": "fixture",
                "benchmark_result_id": f"bench-{suite_id[-4:]}",
                "goodput_req_per_s": goodput,
                "metrics": {"requests_per_second": goodput, "goodput_req_per_s": goodput},
            }],
            "created_at": utc_now(),
            "provenance": "derived",
        }, "run-00000000-0000-4000-8000-000000000000")

    def test_same_point_yields_a_delta(self) -> None:
        self._suite("suite-00000000-0000-4000-8000-000000000001", 4, 10)
        self._suite("suite-00000000-0000-4000-8000-000000000002", 4, 12, {"max_num_seqs": 32})
        comparison = self.core.request(compare_results, {"suite_points": [
            {"suite_result_id": "suite-00000000-0000-4000-8000-000000000001", "scenario_id": "short-chat", "concurrency": 4},
            {"suite_result_id": "suite-00000000-0000-4000-8000-000000000002", "scenario_id": "short-chat", "concurrency": 4},
        ]})["data"]["comparison"]
        self.assertEqual(comparison["comparison_method"], "suite-points-v1")
        self.assertEqual(comparison["deltas"][0]["delta_percent"], 20)

    def test_context_difference_is_listed_not_signed(self) -> None:
        workload = {
            "mode": "closed_loop",
            "concurrency": 4,
            "input_tokens": 64,
            "output_tokens": 64,
            "generation": {"temperature": 0, "top_p": 1},
            "request_source": {"seed": 0},
            "tokenizer": {"revision": "tok-1"},
            "provider": {"version": "1.0.0"},
        }
        run_id = "run-00000000-0000-4000-8000-000000000000"
        left = "bench-00000000-0000-4000-8000-000000000041"
        seed = "bench-00000000-0000-4000-8000-000000000042"
        version = "bench-00000000-0000-4000-8000-000000000043"
        for result_id, extra in (
            (left, {}),
            (seed, {"request_source": {"seed": 7}}),
            (version, {"provider": {"version": "1.2.0"}}),
        ):
            self.core.store.put_benchmark_result({
                "schema_version": 2,
                "benchmark_result_id": result_id,
                "binding": "bound",
                "provenance": "measured",
                "workload_hash": "sha256:" + "a" * 64,
                "model_ref": MODEL_REF,
                "runtime_spec": RUNTIME_SPEC,
                "workload": {**workload, **extra},
                "metrics": {"requests_per_second": 10 if result_id == left else 12},
                "hardware_snapshot_id": "snapshot-same",
            }, run_id)
        self._suite("suite-00000000-0000-4000-8000-000000000031", 4, 10, rows=[self._point(4, 10, benchmark_result_id=left)])
        self._suite("suite-00000000-0000-4000-8000-000000000032", 4, 12, rows=[self._point(4, 12, benchmark_result_id=seed)])
        self._suite("suite-00000000-0000-4000-8000-000000000033", 4, 12, rows=[self._point(4, 12, benchmark_result_id=version)])
        for suite_id, field in (
            ("suite-00000000-0000-4000-8000-000000000032", "seed"),
            ("suite-00000000-0000-4000-8000-000000000033", "evalscope_version"),
        ):
            with self.subTest(field=field):
                comparison = self.core.request(compare_results, {
                    "suite_points": [
                        {"suite_result_id": "suite-00000000-0000-4000-8000-000000000031", "scenario_id": "short-chat", "concurrency": 4},
                        {"suite_result_id": suite_id, "scenario_id": "short-chat", "concurrency": 4},
                    ],
                    "record": True,
                })["data"]["comparison"]
                self.assertTrue(comparison["comparable"])
                self.assertFalse(comparison["claimable"])
                self.assertEqual(comparison["reason"]["field"], field)
                self.assertEqual(len(comparison["values"]), 2)
                self.assertNotIn("deltas", comparison)
                self.assertNotIn("delta_percent", str(comparison))
        self.assertEqual(self.core.store.list_facts("experiment"), [])

    def test_different_concurrency_is_refused(self) -> None:
        self._suite("suite-00000000-0000-4000-8000-000000000003", 1, 10)
        self._suite("suite-00000000-0000-4000-8000-000000000004", 4, 12)
        comparison = self.core.request(compare_results, {"suite_points": [
            {"suite_result_id": "suite-00000000-0000-4000-8000-000000000003", "scenario_id": "short-chat", "concurrency": 1},
            {"suite_result_id": "suite-00000000-0000-4000-8000-000000000004", "scenario_id": "short-chat", "concurrency": 4},
        ]})["data"]["comparison"]
        self.assertFalse(comparison["comparable"])
        self.assertEqual(comparison["reason"]["field"], "concurrency")
        self.assertNotIn("delta_percent", str(comparison))

    def _point(self, concurrency: int, goodput: float, **extra) -> dict:
        row = {
            "scenario_id": "short-chat",
            "projection": PROJECTION,
            "concurrency": concurrency,
            "state": "healthy",
            "reason_code": "ok",
            "reason_detail": "fixture",
            "benchmark_result_id": f"bench-{concurrency}-{goodput}",
            "goodput_req_per_s": goodput,
            "metrics": {"requests_per_second": goodput, "goodput_req_per_s": goodput},
        }
        row.update(extra)
        return row

    def test_representative_rows_may_differ_in_concurrency(self) -> None:
        self._suite("suite-00000000-0000-4000-8000-000000000011", 1, 10, rows=[
            self._point(1, 10, representative=True, projection={**PROJECTION, "load_bucket": "1"}),
        ])
        self._suite("suite-00000000-0000-4000-8000-000000000012", 4, 12, rows=[
            self._point(4, 12, representative=True, projection={**PROJECTION, "load_bucket": "2-8"}),
        ])
        comparison = self.core.request(compare_results, {"suite_points": [
            {"suite_result_id": "suite-00000000-0000-4000-8000-000000000011", "scenario_id": "short-chat", "concurrency": 1},
            {"suite_result_id": "suite-00000000-0000-4000-8000-000000000012", "scenario_id": "short-chat", "concurrency": 4},
        ]})["data"]["comparison"]
        self.assertEqual(comparison["deltas"][0]["delta_percent"], 20)
        self._suite("suite-00000000-0000-4000-8000-000000000013", 4, 12, rows=[
            self._point(4, 12, representative=True, projection={**PROJECTION, "load_bucket": "2-8", "input_bucket": "8193-32768"}),
        ])
        comparison = self.core.request(compare_results, {"suite_points": [
            {"suite_result_id": "suite-00000000-0000-4000-8000-000000000011", "scenario_id": "short-chat", "concurrency": 1},
            {"suite_result_id": "suite-00000000-0000-4000-8000-000000000013", "scenario_id": "short-chat", "concurrency": 4},
        ]})["data"]["comparison"]
        self.assertFalse(comparison["comparable"])
        self.assertEqual(comparison["reason"]["field"], "projection")
        self.assertNotIn("deltas", comparison)

    def test_repeat_selects_one_stability_row(self) -> None:
        suite_id = "suite-00000000-0000-4000-8000-000000000021"
        first = self._point(4, 10, repeat=1)
        second = self._point(4, 14, repeat=2)
        self._suite(suite_id, 4, 10, rows=[first, second])
        with self.assertRaises(ContractError) as missing:
            self.core.request(compare_results, {"suite_points": [
                {"suite_result_id": suite_id, "scenario_id": "short-chat", "concurrency": 4},
                {"suite_result_id": suite_id, "scenario_id": "short-chat", "concurrency": 4, "repeat": 2},
            ]})
        self.assertEqual(missing.exception.code, "not_found")
        comparison = self.core.request(compare_results, {"suite_points": [
            {"suite_result_id": suite_id, "scenario_id": "short-chat", "concurrency": 4, "repeat": 1},
            {"suite_result_id": suite_id, "scenario_id": "short-chat", "concurrency": 4, "repeat": 2},
        ]})["data"]["comparison"]
        self.assertEqual(comparison["deltas"][0]["delta_percent"], 40)
        report = self.core.request(write_report, {
            "title": "扫描",
            "conclusion": "重复轮次。",
            "references": {"suite_result_ids": [suite_id]},
            "suite_claims": [{"suite_result_id": suite_id, "scenario_id": "short-chat", "concurrency": 4, "repeat": 2, "metric": "goodput_req_per_s"}],
        })["data"]["report"]
        self.assertEqual(report["suite_claims"][0]["value"], 14)
        self.assertEqual(report["suite_claims"][0]["repeat"], 2)

    def test_suite_claim_rejects_handwritten_value_and_missing_metric(self) -> None:
        suite_id = "suite-00000000-0000-4000-8000-000000000005"
        self._suite(suite_id, 4, 10)
        with self.assertRaises(ContractError) as handwritten:
            self.core.request(write_report, {
                "title": "扫描",
                "conclusion": "x",
                "references": {"suite_result_ids": [suite_id]},
                "suite_claims": [{"suite_result_id": suite_id, "scenario_id": "short-chat", "concurrency": 4, "metric": "goodput_req_per_s", "value": 99}],
            })
        self.assertEqual(handwritten.exception.code, "invalid_metric_claim")
        with self.assertRaises(ContractError) as missing:
            self.core.request(write_report, {
                "title": "扫描",
                "conclusion": "x",
                "references": {"suite_result_ids": [suite_id]},
                "suite_claims": [{"suite_result_id": suite_id, "scenario_id": "short-chat", "concurrency": 4, "metric": "p99_ttft_ms"}],
            })
        self.assertEqual(missing.exception.code, "invalid_metric_claim")
        report = self.core.request(write_report, {
            "title": "扫描",
            "conclusion": "引用扫描行。",
            "references": {"suite_result_ids": [suite_id]},
            "suite_claims": [{"suite_result_id": suite_id, "scenario_id": "short-chat", "concurrency": 4, "metric": "goodput_req_per_s", "label": "有效吞吐"}],
        })["data"]["report"]
        self.assertEqual(report["suite_claims"][0]["value"], 10)
        self.assertEqual(report["metric_claims"], [])


if __name__ == "__main__":
    unittest.main()
