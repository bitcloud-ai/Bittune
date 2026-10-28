"""Card-fingerprint comparison. No GPU and no EvalScope: facts are inserted directly."""

import sys
import tempfile
import unittest
from pathlib import Path

TESTS_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_ROOT.parent / "src"))
sys.path.insert(0, str(TESTS_ROOT))

from bittune_core.compare import compare_results  # noqa: E402
from test_services_fake_docker import FakeCore  # noqa: E402

RUN = "run-00000000-0000-4000-8000-000000000000"
MODEL_REF = {"schema_version": 1, "model_id": "Qwen/Qwen3-32B", "revision": "rev-0001"}
RUNTIME_SPEC = {
    "schema_version": 1,
    "runtime_kind": "vllm",
    "image_repository": "docker.io/vllm/vllm-openai",
    "image_digest": "sha256:" + "c" * 64,
}
WORKLOAD = {
    "mode": "closed_loop",
    "concurrency": 2,
    "input_tokens": 64,
    "output_tokens": 64,
    "generation": {"temperature": 0, "top_p": 1},
    "request_source": {"seed": 0},
    "tokenizer": {"revision": "tok-1"},
    "provider": {"version": "1.0.0"},
}
GIB = 1024 ** 3


class FingerprintCompareTest(unittest.TestCase):
    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp(prefix="bittune-fp-"))
        self.core = FakeCore(self.work, str(self.work / "core"))

    def tearDown(self) -> None:
        self.core.close()

    def snapshot(self, snapshot_id: str, name: str, capability: str = "8.9", memory: int = 48 * GIB, count: int = 1, driver: str = "550.54.15", cuda: str = "12.4") -> None:
        self.core.store.put_hardware_snapshot({
            "schema_version": 1,
            "hardware_snapshot_id": snapshot_id,
            "observed_at": "2026-09-01T00:00:00Z",
            "provenance": "detected",
            "cuda_version": cuda,
            "gpus": [
                {"name": name, "compute_capability": capability, "memory_total_bytes": memory, "driver_version": driver}
                for _ in range(count)
            ],
        }, RUN)

    def result(self, result_id: str, snapshot_id: str | None, requests_per_second: float = 10.0, **extra) -> str:
        payload = {
            "schema_version": 2,
            "benchmark_result_id": result_id,
            "binding": "bound",
            "provenance": "measured",
            "workload_hash": "sha256:" + "a" * 64,
            "model_ref": MODEL_REF,
            "runtime_spec": RUNTIME_SPEC,
            "workload": WORKLOAD,
            "metrics": {"requests_per_second": requests_per_second},
        }
        if snapshot_id is not None:
            payload["hardware_snapshot_id"] = snapshot_id
        payload.update(extra)
        if "workload" in extra:
            payload["workload"] = {**WORKLOAD, **extra["workload"]}
        self.core.store.put_benchmark_result(payload, RUN)
        return result_id

    def compare(self, left: str, right: str, **params) -> dict:
        return self.core.request(compare_results, {"benchmark_result_ids": [left, right], "objective": "requests_per_second", **params})["data"]["comparison"]

    def test_same_card_different_snapshot_row_is_claimable(self) -> None:
        self.snapshot("snapshot-left", "NVIDIA L40S", driver="550.54.15", cuda="12.4")
        self.snapshot("snapshot-right", "NVIDIA L40S", driver="560.35.03", cuda="12.8")
        comparison = self.compare(
            self.result("bench-00000000-0000-4000-8000-000000000001", "snapshot-left", 10),
            self.result("bench-00000000-0000-4000-8000-000000000002", "snapshot-right", 12),
            record=True,
        )
        self.assertTrue(comparison["comparable"])
        self.assertTrue(comparison["claimable"])
        self.assertEqual(comparison["deltas"][0]["delta_percent"], 20)
        self.assertEqual(len(self.core.store.list_facts("experiment")), 1)

    def test_h100_sxm_and_pcie_share_a_family(self) -> None:
        self.snapshot("snapshot-sxm", "NVIDIA H100 80GB HBM3", capability="9.0", memory=80 * GIB, driver="550.54.15")
        self.snapshot("snapshot-pcie", "NVIDIA H100 PCIe", capability="9.0", memory=80 * GIB, driver="535.129.03")
        comparison = self.compare(
            self.result("bench-00000000-0000-4000-8000-000000000011", "snapshot-sxm", 10),
            self.result("bench-00000000-0000-4000-8000-000000000012", "snapshot-pcie", 12),
        )
        self.assertTrue(comparison["comparable"])
        self.assertTrue(comparison["claimable"])
        self.assertIn("delta_percent", comparison["deltas"][0])

    def test_any_fingerprint_field_blocks_a_percentage(self) -> None:
        self.snapshot("snapshot-base", "NVIDIA L40S")
        cases = (
            ("family", dict(name="NVIDIA GeForce RTX 4090")),
            ("gpu_count", dict(count=2)),
            ("vram_gib", dict(memory=80 * GIB)),
            ("gpu_arch", dict(capability="9.0")),
        )
        for field, kwargs in cases:
            with self.subTest(field=field):
                snapshot_id = f"snapshot-{field}"
                self.snapshot(snapshot_id, kwargs.pop("name", "NVIDIA L40S"), **kwargs)
                comparison = self.compare(
                    self.result(f"bench-base-{field}", "snapshot-base", 10),
                    self.result(f"bench-other-{field}", snapshot_id, 12),
                )
                self.assertFalse(comparison["comparable"])
                self.assertEqual(comparison["reason"]["field"], field)
                self.assertNotIn("delta_percent", str(comparison))
                self.assertNotIn("deltas", comparison)

    def test_different_binding_is_incomparable(self) -> None:
        self.snapshot("snapshot-bound", "NVIDIA L40S")
        comparison = self.compare(
            self.result("bench-00000000-0000-4000-8000-000000000021", "snapshot-bound", 10),
            self.result(
                "bench-00000000-0000-4000-8000-000000000022",
                None,
                12,
                binding="declared",
                hardware_fingerprint={"source": "client", "family": "L40S", "gpu_count": 1, "vram_gib": 48, "gpu_arch": "Ada"},
            ),
        )
        self.assertFalse(comparison["comparable"])
        self.assertEqual(comparison["reason"]["field"], "binding")
        self.assertEqual(comparison["reason"]["left"], "bound")
        self.assertEqual(comparison["reason"]["right"], "declared")
        self.assertNotIn("delta_percent", str(comparison))

    def test_old_and_forwarded_sampling_profiles_are_not_signable(self) -> None:
        self.snapshot("snapshot-profile", "NVIDIA L40S")
        old = self.result("bench-00000000-0000-4000-8000-000000000041", "snapshot-profile", workload={"argv_profile_version": "evalscope-perf-openai-random-v1"})
        new = self.result("bench-00000000-0000-4000-8000-000000000042", "snapshot-profile", workload={"argv_profile_version": "evalscope-perf-openai-random-v2"})
        comparison = self.compare(old, new, record=True)
        self.assertFalse(comparison["claimable"])
        self.assertEqual(comparison["reason"]["field"], "argv_profile_version")
        self.assertNotIn("deltas", comparison)
        self.assertEqual(self.core.store.list_facts("experiment"), [])

    def test_changed_percentile_method_is_not_signable(self) -> None:
        self.snapshot("snapshot-method", "NVIDIA L40S")
        old = self.result("bench-00000000-0000-4000-8000-000000000051", "snapshot-method", metric_normalizer_version="evalscope-normalizer-v4")
        new = self.result("bench-00000000-0000-4000-8000-000000000052", "snapshot-method", metric_normalizer_version="evalscope-normalizer-v5")
        comparison = self.compare(old, new, record=True)
        self.assertFalse(comparison["claimable"])
        self.assertEqual(comparison["reason"]["field"], "metric_normalizer_version")
        self.assertNotIn("deltas", comparison)

    def test_seed_or_evalscope_version_is_listed_not_signed(self) -> None:
        self.snapshot("snapshot-context", "NVIDIA L40S")
        baseline = self.result("bench-00000000-0000-4000-8000-000000000031", "snapshot-context", 10)
        seed = self.result(
            "bench-00000000-0000-4000-8000-000000000032",
            "snapshot-context",
            12,
            workload={"request_source": {"seed": 7}},
        )
        version = self.result(
            "bench-00000000-0000-4000-8000-000000000033",
            "snapshot-context",
            12,
            workload={"provider": {"version": "1.2.0"}},
        )
        for other, field in ((seed, "seed"), (version, "evalscope_version")):
            with self.subTest(field=field):
                comparison = self.compare(baseline, other, record=True)
                self.assertTrue(comparison["comparable"])
                self.assertFalse(comparison["claimable"])
                self.assertEqual(comparison["reason"]["field"], field)
                self.assertEqual(len(comparison["values"]), 2)
                self.assertNotIn("deltas", comparison)
        self.assertEqual(self.core.store.list_facts("experiment"), [])
