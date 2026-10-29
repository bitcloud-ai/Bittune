"""Phase 7 stage 2: P/D caps come only from two healthy anchors."""

import sys
import unittest
from pathlib import Path

TESTS_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_ROOT.parent / "src"))
sys.path.insert(0, str(TESTS_ROOT))

from bittune_core.contracts import ContractError  # noqa: E402
from bittune_core.plans import plan_deployment  # noqa: E402
from bittune_core.store import utc_now  # noqa: E402
from bittune_core.suite import benchmark_suite  # noqa: E402
from test_suite_sweep import MODEL_REF, RUNTIME_SPEC, SweepTests  # noqa: E402


def _row(scenario_id: str, projection: dict, goodput) -> dict:
    return {
        "scenario_id": scenario_id,
        "projection": projection,
        "concurrency": 1,
        "state": "healthy",
        "reason_code": "ok",
        "reason_detail": "fixture",
        "output_tokens": 4096 if scenario_id == "short-batch" else 256,
        "goodput_req_per_s": goodput,
        "metrics": {"output_tokens_per_second": 80.0, "requests_per_second": goodput or 0},
    }


class PdTests(SweepTests):
    def _suite(self, rows: list[dict]) -> str:
        suite_id = "suite-00000000-0000-4000-8000-0000000000aa"
        self.core.store.put_suite_result({
            "schema_version": 1,
            "suite_result_id": suite_id,
            "profile_id": "bittune-default-v1",
            "profile_hash": "sha256:" + "b" * 64,
            "service_instance_id": self.service_id,
            "model_ref": MODEL_REF,
            "runtime_spec": RUNTIME_SPEC,
            "rows": rows,
            "created_at": utc_now(),
            "provenance": "derived",
        }, "run-00000000-0000-4000-8000-000000000000")
        return suite_id

    def test_missing_suite_id_is_invalid_input(self) -> None:
        with self.assertRaises(ContractError) as raised:
            self.core.request(benchmark_suite, {"intent": "pd_planning", "service_instance_id": self.service_id})
        self.assertEqual(raised.exception.code, "invalid_input")

    def test_missing_anchor_writes_no_caps(self) -> None:
        suite_id = self._suite([_row("short-chat", {"scenario": "chat", "input_bucket": "0-2048", "output_bucket": "0-2048", "load_bucket": "1"}, 5)])
        fact = self.core.request(benchmark_suite, {"intent": "pd_planning", "service_instance_id": self.service_id, "suite_result_id": suite_id})["data"]["pd_estimate"]
        self.assertEqual(fact["state"], "evidence_insufficient")
        self.assertNotIn("p_cap_req_per_s", fact)
        self.assertNotIn("d_cap_tok_per_s", fact)
        self.assertEqual(fact["evidence_boundary"], "no_cache_check")

    def test_anchors_are_derived_and_do_not_enter_plans(self) -> None:
        suite_id = self._suite([
            _row("short-rag", {"scenario": "rag", "input_bucket": "8193-32768", "output_bucket": "0-2048", "load_bucket": "1"}, 4),
            _row("short-batch", {"scenario": "batch", "input_bucket": "0-2048", "output_bucket": "2049-8192", "load_bucket": "1"}, 2),
        ])
        fact = self.core.request(benchmark_suite, {"intent": "pd_planning", "service_instance_id": self.service_id, "suite_result_id": suite_id})["data"]["pd_estimate"]
        self.assertEqual(fact["provenance"], "derived")
        self.assertNotEqual(fact["provenance"], "measured")
        self.assertEqual(fact["p_cap_req_per_s"], 4)
        self.assertEqual(fact["d_cap_tok_per_s"], 80.0)
        self.assertEqual(fact["ratio_p_to_d"], 4 / (80.0 / 4096))
        self.assertIn("anchor_prefill.goodput_req_per_s", fact["formula"])
        plan = self.core.request(plan_deployment, {
            "action": "create",
            "prior_source": "none",
            "goal": "unchanged serving",
            "rationale": "fixture",
            "model_ref": MODEL_REF,
            "runtime_spec": RUNTIME_SPEC,
            "serving_spec": {"max_model_len": 32768},
        })["data"]["plan"]
        self.assertTrue({"p_cap_req_per_s", "d_cap_tok_per_s", "ratio_p_to_d"}.isdisjoint(plan["serving_spec"]))

    def test_incomplete_cache_pair_blocks_caps(self) -> None:
        suite_id = self._suite([
            _row("short-rag", {"scenario": "rag", "input_bucket": "8193-32768", "output_bucket": "0-2048", "load_bucket": "1"}, 4),
            _row("short-batch", {"scenario": "batch", "input_bucket": "0-2048", "output_bucket": "2049-8192", "load_bucket": "1"}, 2),
        ])
        pair_id = "cache-00000000-0000-4000-8000-0000000000bb"
        self.core.store.put_cache_pair_result({
            "schema_version": 1,
            "cache_pair_result_id": pair_id,
            "service_instance_id": self.service_id,
            "profile_id": "bittune-default-v1",
            "state": "evidence_insufficient",
            "cold_healthy": False,
            "hot_healthy": True,
            "created_at": utc_now(),
            "provenance": "derived",
        }, "run-00000000-0000-4000-8000-000000000000")
        fact = self.core.request(benchmark_suite, {
            "intent": "pd_planning",
            "service_instance_id": self.service_id,
            "suite_result_id": suite_id,
            "cache_pair_result_id": pair_id,
        })["data"]["pd_estimate"]
        self.assertEqual(fact["reason_code"], "pairs_incomplete")
        self.assertNotIn("p_cap_req_per_s", fact)

    def test_custom_scenario_with_the_right_bucket_is_an_anchor(self) -> None:
        prefill = _row("custom-prefill", {"scenario": "rag", "input_bucket": "8193-32768", "output_bucket": "0-2048", "load_bucket": "1"}, 9)
        decode = _row("custom-decode", {"scenario": "batch", "input_bucket": "0-2048", "output_bucket": "2049-8192", "load_bucket": "1"}, 3)
        decode["output_tokens"] = 4096
        suite_id = self._suite([
            _row("short-rag", {"scenario": "rag", "input_bucket": "8193-32768", "output_bucket": "0-2048", "load_bucket": "1"}, 4),
            prefill,
            decode,
        ])
        fact = self.core.request(benchmark_suite, {"intent": "pd_planning", "service_instance_id": self.service_id, "suite_result_id": suite_id})["data"]["pd_estimate"]
        self.assertEqual(fact["p_cap_req_per_s"], 9)
        self.assertEqual(fact["d_cap_tok_per_s"], 80.0)


if __name__ == "__main__":
    unittest.main()
