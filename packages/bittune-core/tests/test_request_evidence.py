"""Provider SQLite metric fixtures: collection, counts and units without a GPU."""

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from bittune_core.benchmark import normalize_reports
from bittune_core.request_evidence import collect_request_evidence
from bittune_core.runs import ManagedRun
from bittune_core.store import CoreStore

# Same fields/types as EvalScope 1.10.0 create_result_table. Payload fields are
# deliberately unreadable pickle text: the adapter must never deserialize them.
SCHEMA = """CREATE TABLE result (
    request TEXT, start_time REAL, inter_token_latencies TEXT, success INTEGER,
    response_messages TEXT, completed_time REAL, latency REAL, first_chunk_latency REAL,
    prompt_tokens INTEGER, completion_tokens INTEGER, max_gpu_memory_cost REAL,
    time_per_output_token REAL, request_id TEXT, is_stream INTEGER)"""


class RequestEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root / "output"
        self.output.mkdir()
        self.store = CoreStore(str(self.root / "core"))
        self.addCleanup(self.store.close)
        self.run = ManagedRun(self.store, "request-evidence-test", {}, "fixture", {})

    def database(self, rows):
        path = self.output / "benchmark_data.db"
        with sqlite3.connect(path) as connection:
            connection.execute(SCHEMA)
            connection.executemany("INSERT INTO result VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
        return path

    def success(self, latency=0.1, stream=1):
        return ("do not decode", 10, "[0.02, 0.03]" if stream else "[]", 1, "do not unpickle", 10 + latency,
                latency, 0.01 if stream else 0, 16, 3, 0, 0.045 if stream else 0, None, stream)

    def collect(self, expected=2, success=2, failed=0):
        return collect_request_evidence(self.output, self.run, expected, {"Total Requests": success + failed, "Success Requests": success, "Failed Requests": failed})

    def records(self):
        records = []
        for ref in self.run.artifact_refs:
            if ref["label"] == "evalscope-request-metrics":
                records.extend(json.loads(self.store.read_artifact_text(ref["artifact_id"])["text"])["records"])
        return records

    def test_complete_rows_preserve_null_id_and_normalize_seconds(self):
        path = self.database([self.success(), self.success(0.3)])
        before = path.read_bytes()
        result = self.collect()
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(result["metadata"]["status"], "complete")
        records = self.records()
        self.assertEqual([r["row_id"] for r in records], [1, 2])
        self.assertIsNone(records[0]["request_id"])
        self.assertNotIn("request", records[0])
        self.assertNotIn("response_messages", records[0])
        self.assertEqual(records[0]["latency"], 0.1)
        normalized = normalize_reports([], request_samples=result["samples"])
        self.assertTrue(normalized["request_samples_available"])
        self.assertEqual(normalized["distributions"]["e2e_latency_ms"]["sample_count"], 2)
        self.assertAlmostEqual(normalized["metrics"]["p99_e2e_latency_ms"], 298)
        self.assertEqual(normalized["distributions"]["itl_ms"]["sample_count"], 4)
        self.assertAlmostEqual(normalized["metrics"]["mean_ttft_ms"], 10)

    def test_failure_rows_keep_nulls_and_do_not_add_latency_samples(self):
        failure = ("x", 10, "[]", 0, "x", 11, None, None, None, None, None, None, "failed-id", 1)
        self.database([self.success(), failure])
        result = self.collect(success=1, failed=1)
        self.assertEqual(result["metadata"]["status"], "complete")
        self.assertEqual(result["samples"]["e2e_latency_ms"], [100])
        self.assertIsNone(self.records()[1]["prompt_tokens"])
        self.assertIsNone(self.records()[1]["latency"])

    def test_nonstream_has_e2e_but_no_fake_zero_ttft_or_tpot(self):
        self.database([self.success(stream=0), self.success(stream=0)])
        result = self.collect()
        self.assertEqual(set(result["samples"]), {"e2e_latency_ms"})

    def test_partial_and_wrong_summary_cannot_supply_complete_samples(self):
        self.database([self.success()])
        result = self.collect()
        self.assertEqual(result["metadata"]["status"], "invalid")
        self.assertEqual(result["samples"], {})
        self.assertEqual(len(self.records()), 1)
        self.assertIn("Request rows do not match planned request_count", result["metadata"]["errors"])
        result = self.collect(expected=1, success=0, failed=1)
        self.assertEqual(result["metadata"]["status"], "invalid")

    def test_absent_empty_and_corrupt_database_are_distinct(self):
        self.assertEqual(self.collect()["metadata"]["status"], "absent")
        path = self.database([])
        self.assertEqual(self.collect()["metadata"]["status"], "invalid")
        path.write_bytes(b"not a database")
        result = self.collect()
        self.assertEqual(result["metadata"]["status"], "invalid")
        self.assertEqual(result["samples"], {})
        self.assertTrue(result["metadata"]["source_sha256"].startswith("sha256:"))

    def test_invalid_intervals_do_not_become_measurements(self):
        row = list(self.success())
        row[2] = "[NaN]"
        self.database([tuple(row)])
        self.assertEqual(self.collect(expected=1, success=1)["metadata"]["status"], "invalid")

    def test_wrong_or_missing_token_counts_retain_rows_but_refuse_shape(self):
        good = self.success()
        for field, value in ((8, 15), (8, None), (9, 2)):
            row = list(good)
            row[field] = value
            path = self.database([tuple(row)])
            result = collect_request_evidence(self.output, self.run, 1, {"Total Requests": 1, "Success Requests": 1, "Failed Requests": 0}, expected_input_tokens=16, expected_output_tokens=3)
            self.assertEqual(result["metadata"]["shape_mismatch_count"], 1)
            self.assertEqual(result["metadata"]["status"], "invalid")
            self.assertEqual(result["samples"], {})
            path.unlink()

    def test_large_request_sets_are_archived_in_chunks(self):
        self.database([self.success()] * 1001)
        result = self.collect(expected=1001, success=1001)
        self.assertEqual(result["metadata"]["status"], "complete")
        self.assertEqual(len(result["metadata"]["artifact_ids"]), 2)
        self.assertEqual(len(self.records()), 1001)
