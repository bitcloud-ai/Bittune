"""Phase 7 stage 2: a missing pack is a fact, not a tool failure."""

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

TESTS_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_ROOT.parent / "src"))
sys.path.insert(0, str(TESTS_ROOT))

from bittune_core.suite import benchmark_suite  # noqa: E402
from bittune_core.suite_profiles import load_profile  # noqa: E402
from test_suite_sweep import SweepTests  # noqa: E402


class CorrectnessTests(SweepTests):
    def test_missing_pack_writes_insufficient_evidence(self) -> None:
        before = len(self.core.store.list_facts("suite_result"))
        with patch("bittune_core.benchmark._endpoint_ready", return_value=True):
            result = self.core.request(benchmark_suite, {"intent": "correctness", "service_instance_id": self.service_id})
        fact = result["data"]["correctness_result"]
        self.assertEqual(fact["state"], "evidence_insufficient")
        self.assertNotIn("accuracy", fact)
        self.assertEqual(len(self.core.store.list_facts("suite_result")), before)
        stored = self.core.store.get_fact("correctness_result", fact["correctness_result_id"])["payload"]
        self.assertNotIn("expected.text", json.dumps(stored))
        self.assertEqual(fact["profile_id"], "bittune-default-v1")

    def test_pack_fact_omits_expected_text(self) -> None:
        pack = self.work / "pack.json"
        secret = "oracle-phrase-should-stay-in-the-file"
        pack.write_text(json.dumps({
            "schema_version": 1,
            "pack_id": "pack-local",
            "samples": [{
                "sample_id": "s1",
                "messages": [{"role": "user", "content": "say the phrase"}],
                "expected": {"kind": "contains", "text": secret},
            }],
        }), encoding="utf-8")

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps({"choices": [{"message": {"content": f"yes {secret}"}}]}).encode()

        with patch("bittune_core.benchmark._endpoint_ready", return_value=True), patch("urllib.request.urlopen", return_value=Response()):
            result = self.core.request(benchmark_suite, {
                "intent": "correctness",
                "service_instance_id": self.service_id,
                "correctness_pack_path": str(pack),
            })
        fact = result["data"]["correctness_result"]
        blob = json.dumps(fact, ensure_ascii=False)
        self.assertEqual(fact["accuracy"], 1)
        self.assertNotIn(secret, blob)
        self.assertNotIn("say the phrase", blob)
        self.assertEqual(fact["samples"][0]["passed"], True)
        self.assertTrue(fact["samples"][0]["request_id_missing"])
        self.assertNotIn("chat-", blob)

    def test_unmapped_sample_has_no_accuracy(self) -> None:
        pack = self.work / "pack.json"
        pack.write_text(json.dumps({
            "schema_version": 1,
            "pack_id": "pack-local",
            "samples": [{
                "sample_id": "s1",
                "messages": [{"role": "user", "content": "ping"}],
                "expected": {"kind": "exact", "text": "ok"},
            }],
        }), encoding="utf-8")

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b"{}"

        with patch("bittune_core.benchmark._endpoint_ready", return_value=True), patch("urllib.request.urlopen", return_value=Response()):
            result = self.core.request(benchmark_suite, {
                "intent": "correctness",
                "service_instance_id": self.service_id,
                "correctness_pack_path": str(pack),
            })
        fact = result["data"]["correctness_result"]
        self.assertEqual(fact["state"], "aggregate_blocked")
        self.assertNotIn("accuracy", fact)
        self.assertEqual(fact["samples"][0]["sample_id"], "s1")
        self.assertEqual(fact["samples"][0]["error"], "unmapped")
        self.assertTrue(fact["samples"][0]["request_id_missing"])
        self.assertNotIn("chat-", json.dumps(fact))
        self.assertNotIn("messages", json.dumps(fact["samples"]))

    def test_failed_request_keeps_the_sample_and_continues(self) -> None:
        pack = self.work / "pack.json"
        pack.write_text(json.dumps({
            "schema_version": 1,
            "pack_id": "pack-local",
            "samples": [
                {"sample_id": "s1", "messages": [{"role": "user", "content": "one"}], "expected": {"kind": "exact", "text": "ok"}},
                {"sample_id": "s2", "messages": [{"role": "user", "content": "two"}], "expected": {"kind": "exact", "text": "ok"}},
            ],
        }), encoding="utf-8")

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps({"id": "req-2", "choices": [{"message": {"content": "ok"}}]}).encode()

        calls = {"n": 0}

        def fake_open(*_args, **_kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                raise OSError("down")
            return Response()

        with patch("bittune_core.benchmark._endpoint_ready", return_value=True), patch("urllib.request.urlopen", fake_open):
            fact = self.core.request(benchmark_suite, {
                "intent": "correctness",
                "service_instance_id": self.service_id,
                "correctness_pack_path": str(pack),
            })["data"]["correctness_result"]
        self.assertEqual(fact["state"], "aggregate_blocked")
        self.assertNotIn("accuracy", fact)
        self.assertEqual(fact["samples"][0]["error"], "request_failed")
        self.assertEqual(fact["samples"][1]["request_id"], "req-2")
        self.assertTrue(fact["samples"][1]["passed"])
        self.assertNotIn("chat-", json.dumps(fact))
        self.assertNotIn("one", json.dumps(fact))

    def test_custom_profile_id_is_the_loaded_profile(self) -> None:
        profile = {
            "registry": {
                "schema_version": 1,
                "profile_id": "ignored-by-the-hash",
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
            },
            "acceptance": {"schema_version": 1, "success_rate_min": 0.99, "p99_e2e_latency_ms_max": 30000, "p99_ttft_ms_max": 5000},
        }
        path = self.work / "profile.json"
        path.write_text(json.dumps(profile), encoding="utf-8")
        with patch("bittune_core.benchmark._endpoint_ready", return_value=True):
            fact = self.core.request(benchmark_suite, {
                "intent": "correctness",
                "service_instance_id": self.service_id,
                "profile_path": str(path),
            })["data"]["correctness_result"]
        self.assertEqual(fact["profile_id"], load_profile(str(path))["profile_id"])
        self.assertNotEqual(fact["profile_id"], "bittune-default-v1")


if __name__ == "__main__":
    unittest.main()
