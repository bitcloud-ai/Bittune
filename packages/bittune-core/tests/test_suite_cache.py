"""Phase 7 stage 3: cache pairs do not pretend a cold run without flush."""

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

TESTS_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_ROOT.parent / "src"))
sys.path.insert(0, str(TESTS_ROOT))

from bittune_core.suite import benchmark_suite  # noqa: E402
from test_suite_sweep import SweepTests  # noqa: E402


def _metrics_text(hit: float, prompt: float) -> bytes:
    return f"sglang:cache_hit_tokens {hit}\nsglang:prompt_tokens {prompt}\n".encode()


class _Body:
    def __init__(self, status: int, body: bytes):
        self.status = status
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self._body


class CachePairTests(unittest.TestCase):
    def setUp(self) -> None:
        self._host = SweepTests()
        self._host.setUp()
        self.core = self._host.core
        self.work = self._host.work
        self.service_id = self._host.service_id

        service = self.core.store.get_fact("service_instance", self.service_id)["payload"]
        service["runtime_spec"] = {**service["runtime_spec"], "runtime_kind": "sglang"}
        self.core.store.put_service_instance(service, "run-00000000-0000-4000-8000-000000000000")
        profile = {
            "registry": {
                "schema_version": 1,
                "profile_id": "cache-fixture",
                "concurrency_mode": "ladder",
                "scenarios": [{
                    "scenario_id": "cache-chat",
                    "scenario": "chat",
                    "input_tokens": 100,
                    "output_tokens": 16,
                    "concurrency": [1],
                    "request_count": 2,
                    "closed_loop": True,
                    "stream": True,
                    "ignore_eos": True,
                    "temperature": 0,
                    "seed": 0,
                    "warmup_requests": 1,
                    "request_timeout_seconds": 120,
                    "prefix_length": 40,
                }],
            },
            "acceptance": {"schema_version": 1, "success_rate_min": 0.99, "p99_e2e_latency_ms_max": 30000, "p99_ttft_ms_max": 5000},
        }
        self.profile_path = self.work / "profile.json"
        self.profile_path.write_text(json.dumps(profile), encoding="utf-8")

    def tearDown(self) -> None:
        self._host.tearDown()

    def _run(self, responses: list[_Body], outcomes: list[dict] | None = None) -> dict:
        calls = {"n": 0, "prefix": [], "warmup": []}

        def fake_execute(*args, **kwargs):
            calls["prefix"].append(kwargs.get("prefix_length"))
            calls["warmup"].append(args[0].get("warmup_requests") if args else None)
            item = (outcomes or [{"ok": True}])[min(calls["n"], len(outcomes or [{"ok": True}]) - 1)]
            calls["n"] += 1
            workload = {"input_tokens": 100, "prefix_length": kwargs.get("prefix_length"), "output_tokens": 16}
            if not item.get("ok", True):
                return {"ok": False, "kind": "no_metrics", "workload": workload}
            outcome = {"ok": True, "workload": workload, "workload_hash": "sha256:" + "d" * 64, "metrics": {"requests_per_second": 1}}
            if isinstance(item.get("prompt_sha256"), str):
                outcome["prompt_sha256"] = item["prompt_sha256"]
            return outcome

        queue = list(responses)

        def fake_open(request, timeout=10):
            if not queue:
                raise AssertionError(request.full_url)
            return queue.pop(0)

        with patch("bittune_core.benchmark._endpoint_ready", return_value=True), patch("bittune_core.cache_pair.execute_workload", fake_execute), patch("urllib.request.urlopen", fake_open):
            result = self.core.request(benchmark_suite, {
                "intent": "cache_pair",
                "service_instance_id": self.service_id,
                "profile_path": str(self.profile_path),
            })
        result["prefixes"] = calls["prefix"]
        result["warmups"] = calls["warmup"]
        return result

    def test_vllm_does_not_send_business_requests(self) -> None:
        service = self.core.store.get_fact("service_instance", self.service_id)["payload"]
        service["runtime_spec"] = {**service["runtime_spec"], "runtime_kind": "vllm"}
        self.core.store.put_service_instance(service, "run-00000000-0000-4000-8000-000000000000")
        with patch("bittune_core.benchmark._endpoint_ready", return_value=True), patch("bittune_core.cache_pair.execute_workload") as execute:
            fact = self.core.request(benchmark_suite, {"intent": "cache_pair", "service_instance_id": self.service_id})["data"]["cache_pair_result"]
        execute.assert_not_called()
        self.assertEqual(fact["state"], "not_applicable")
        self.assertEqual(len(self.core.store.list_facts("benchmark_result")), 0)

    def test_failed_flush_is_not_applicable(self) -> None:
        result = self._run([_Body(500, b"")])
        fact = result["data"]["cache_pair_result"]
        self.assertEqual(fact["state"], "not_applicable")
        self.assertEqual(fact["reason_code"], "flush_failed")
        self.assertEqual(result["prefixes"], [])

    def test_hit_rate_warning_does_not_fail_the_pair(self) -> None:
        # Constructed is 0.40. The cold window stays 0 and must not decide the band.
        # The hot window is 10/100 = 0.10, then the retried hot window is 0.50.
        bodies = [_Body(200, b"{}")]
        for hit, prompt in ((0, 0), (0, 100), (0, 100), (10, 200)):
            bodies.append(_Body(200, _metrics_text(hit, prompt)))
        bodies.append(_Body(200, b"{}"))
        for hit, prompt in ((0, 0), (0, 100), (0, 100), (50, 200)):
            bodies.append(_Body(200, _metrics_text(hit, prompt)))
        result = self._run(bodies)
        fact = result["data"]["cache_pair_result"]
        self.assertEqual(fact["state"], "healthy")
        self.assertEqual(fact["data_quality"], "hit_rate_out_of_band")
        self.assertEqual(fact["observed_hit_rate"], 0.5)
        self.assertEqual(fact["cold_window_hit_rate"], 0)
        self.assertTrue(fact["cold_healthy"] and fact["hot_healthy"])
        self.assertNotIn("slo_pass", fact)
        self.assertEqual(result["prefixes"][0], 40)
        self.assertEqual(result["prefixes"][-1], 10)
        self.assertEqual(fact["input_identity"], "shape_only")
        self.assertNotIn("dataset_input_sha256", fact)
        self.assertEqual(result["warmups"], [0, 1, 1, 0, 1, 1])

    def test_different_input_sha_is_not_healthy(self) -> None:
        def flipping(*_args, **kwargs):
            prefix = kwargs.get("prefix_length")
            # Cold keeps the requested prefix. Hot reports a different one, so the two input hashes differ.
            reported = prefix if flipping.calls % 3 == 0 else prefix + 1
            flipping.calls += 1
            return {"ok": True, "workload": {"input_tokens": 100, "prefix_length": reported}, "workload_hash": "x"}

        flipping.calls = 0

        with patch("bittune_core.benchmark._endpoint_ready", return_value=True), patch("bittune_core.cache_pair.execute_workload", flipping), patch("urllib.request.urlopen", return_value=_Body(200, b"{}")):
            fact = self.core.request(benchmark_suite, {
                "intent": "cache_pair",
                "service_instance_id": self.service_id,
                "profile_path": str(self.profile_path),
            })["data"]["cache_pair_result"]
        self.assertEqual(fact["state"], "invalid_measurement")
        self.assertFalse(fact["cold_healthy"])
        self.assertFalse(fact["hot_healthy"])

    def test_prompt_bytes_are_the_only_dataset_digest(self) -> None:
        digest = "a" * 64
        bodies = [_Body(200, b"{}")]
        for hit, prompt in ((0, 0), (0, 100), (0, 100), (40, 200)):
            bodies.append(_Body(200, _metrics_text(hit, prompt)))
        result = self._run(bodies, [{"ok": True, "prompt_sha256": digest}])
        fact = result["data"]["cache_pair_result"]
        self.assertEqual(fact["state"], "healthy")
        self.assertEqual(fact["input_identity"], "bytes")
        self.assertEqual(fact["dataset_input_sha256"], digest)
        self.assertEqual(fact["sides"]["cold"]["input_sha256"], digest)


if __name__ == "__main__":
    unittest.main()
