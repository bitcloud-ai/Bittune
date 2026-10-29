"""Regression from real EvalScope 1.10.0 GPU output, not a fake provider."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from bittune_core.benchmark import normalize_reports, _metrics_complete


class EvalScopeRealFormatTests(unittest.TestCase):
    def test_summary_and_percentiles_keep_units_and_throughput_identity(self):
        root = Path(__file__).parent / "fixtures" / "evalscope-1.10.0"
        reports = [json.loads((root / name).read_text()) for name in ("benchmark_summary.json", "benchmark_percentile.json")]
        result = normalize_reports(reports)
        metrics = result["metrics"]
        self.assertTrue(_metrics_complete(metrics))
        self.assertEqual(metrics["success_rate"], 1)
        self.assertEqual(metrics["requests_per_second"], 3.1922)
        self.assertEqual(metrics["output_tokens_per_second"], 102.1491)
        self.assertAlmostEqual(metrics["mean_e2e_latency_ms"], 312.9)
        self.assertEqual(metrics["p99_e2e_latency_ms"], 320)
        self.assertEqual(metrics["p99_ttft_ms"], 37.68)
        self.assertEqual(metrics["p99_tpot_ms"], 9.2)
        self.assertFalse(result["request_samples_available"])
        self.assertEqual(result["distributions"], {})

    def test_missing_provider_percentiles_are_not_invented(self):
        result = normalize_reports([{"Total Requests": 8, "Success Requests": 8, "Req Throughput (req/s)": 3.2, "Output Throughput (tok/s)": 102}])
        self.assertEqual(result["metrics"]["success_rate"], 1)
        self.assertFalse(_metrics_complete(result["metrics"]))
