"""Store-level tests: schema, run lifecycle, hashes, artifacts, isolation."""

import sys
import tempfile
import unittest
from pathlib import Path

SRC_ROOT = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_ROOT))

from bittune_core.contracts import ContractError  # noqa: E402
from bittune_core.store import CoreStore  # noqa: E402

EXPECTED_TABLES = {
    "runs",
    "artifacts",
    "hardware_snapshots",
    "deployment_plans",
    "service_instances",
    "benchmark_results",
    "experiments",
    "reports",
}


class StoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = Path(tempfile.mkdtemp(prefix="bittune-store-test-"))
        self.store = CoreStore(self.home)

    def tearDown(self) -> None:
        self.store.close()

    def new_run(self, tool_name: str = "bash", status: str = "completed", session_id: str = "session-1") -> str:
        run_id, _ = self.store.start_run(tool_name, "generic", {"command": "true", "cwd": "/tmp"}, session_id)
        if status != "running":
            self.store.finish_run(run_id, status, {"summary": "ok", "warnings": [], "artifact_refs": []})
        return run_id

    def test_home_layout_has_eight_business_tables(self) -> None:
        self.assertTrue((self.home / "bittune.db").is_file())
        self.assertTrue((self.home / "artifacts").is_dir())
        self.assertTrue((self.home / "staging").is_dir())
        tables = {row[0] for row in self.store.db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        self.assertTrue(EXPECTED_TABLES.issubset(tables), tables)

    def test_run_lifecycle_and_readback(self) -> None:
        run_id = self.new_run()
        run = self.store.get_run(run_id)
        self.assertEqual(run["status"], "completed")
        self.assertEqual(run["tool_name"], "bash")
        self.assertEqual(run["action_path"], "generic")
        self.assertEqual(run["input"]["command"], "true")
        self.assertEqual(run["observation"]["summary"], "ok")
        self.assertEqual(self.store.list_runs(tool_name="bash")[0]["run_id"], run_id)
        self.assertEqual(self.store.list_runs(tool_name="edit"), [])

    def test_failed_run_preserves_error(self) -> None:
        run_id, _ = self.store.start_run("bash", "generic", {"command": "false"}, "session-1")
        self.store.finish_run(run_id, "failed", {"summary": "boom", "warnings": [], "artifact_refs": [], "error": {"code": "provider_error", "message": "boom"}})
        run = self.store.get_run(run_id)
        self.assertEqual(run["status"], "failed")
        self.assertEqual(run["observation"]["error"]["code"], "provider_error")

    def test_finish_twice_is_rejected(self) -> None:
        run_id = self.new_run()
        with self.assertRaises(ContractError) as raised:
            self.store.finish_run(run_id, "completed", {"summary": "again", "warnings": [], "artifact_refs": []})
        self.assertEqual(raised.exception.code, "state_conflict")

    def test_input_tamper_is_rejected(self) -> None:
        run_id = self.new_run()
        with self.store.db:
            self.store.db.execute("UPDATE runs SET input_json = ? WHERE run_id = ?", ('{"command": "evil"}', run_id))
        with self.assertRaises(ContractError) as raised:
            self.store.get_run(run_id)
        self.assertEqual(raised.exception.code, "state_conflict")

    def test_artifact_write_excerpt_and_hash(self) -> None:
        run_id, _ = self.store.start_run("bash", "generic", {"command": "true"}, "session-1")
        ref = self.store.write_artifact(run_id, "stdout", "line1\nline2\nline3\n")
        excerpt = self.store.read_artifact_excerpt(ref["artifact_id"], offset_bytes=6, max_bytes=12)
        self.assertEqual(excerpt["text"], "line2\nline3\n")
        self.assertEqual(excerpt["size_bytes"], len("line1\nline2\nline3\n"))
        self.assertFalse(excerpt["truncated"])
        partial = self.store.read_artifact_excerpt(ref["artifact_id"], offset_bytes=6, max_bytes=4)
        self.assertEqual(partial["text"], "line")
        self.assertTrue(partial["truncated"])
        self.assertEqual(self.store.get_run(run_id)["artifacts"][0]["artifact_id"], ref["artifact_id"])
        with self.assertRaises(ContractError) as raised:
            self.store.read_artifact_excerpt(ref["artifact_id"], max_bytes=10_000_000)
        self.assertEqual(raised.exception.code, "invalid_input")

    def test_artifact_tamper_is_rejected(self) -> None:
        run_id, _ = self.store.start_run("bash", "generic", {"command": "true"}, "session-1")
        ref = self.store.write_artifact(run_id, "stdout", "original\n")
        path = self.home / ref_relative_path(self.store, ref)
        path.write_text("tampered\n", encoding="utf-8")
        with self.assertRaises(ContractError) as raised:
            self.store.read_artifact_excerpt(ref["artifact_id"])
        self.assertEqual(raised.exception.code, "state_conflict")

    def test_bytes_artifact_is_redacted_when_utf8_and_size_limited(self) -> None:
        run_id, _ = self.store.start_run("bash", "generic", {"command": "true"}, "session-1")
        ref = self.store.write_artifact(run_id, "binary-looking", b"client_secret=top-secret\n")
        self.assertIn("[REDACTED]", self.store.read_artifact_excerpt(ref["artifact_id"])["text"])
        with self.assertRaises(ContractError) as raised:
            self.store.write_artifact(run_id, "too-large", b"x" * (8 * 1024 * 1024 + 1))
        self.assertEqual(raised.exception.code, "payload_too_large")

    def test_interrupted_sweep_on_reopen(self) -> None:
        run_id = self.new_run(status="running")
        self.store.close()
        reopened = CoreStore(self.home)
        self.addCleanup(reopened.close)
        reopened.mark_interrupted_runs()
        self.assertEqual(reopened.get_run(run_id)["status"], "interrupted")

    def test_staging_path_rejects_traversal(self) -> None:
        with self.assertRaises(ContractError):
            self.store.staging_path("session-1", "../outside.json")

    def test_fact_read_verifies_hash(self) -> None:
        payload = {"schema_version": 1, "kernel": "evidence"}
        from bittune_core.contracts import canonical_json, sha256_canonical

        content_hash = sha256_canonical(payload)
        self.store.db.execute(
            "INSERT INTO hardware_snapshots(hardware_snapshot_id, source_run_id, created_at, payload_json, content_hash) VALUES (?, ?, ?, ?, ?)",
            ("snapshot-x", "run-x", "2026-09-01T00:00:00Z", canonical_json(payload), content_hash),
        )
        self.store.db.commit()
        fact = self.store.get_fact("hardware_snapshot", "snapshot-x")
        self.assertEqual(fact["content_hash"], content_hash)
        self.store.db.execute("UPDATE hardware_snapshots SET payload_json = ? WHERE hardware_snapshot_id = ?", ("{}", "snapshot-x"))
        self.store.db.commit()
        with self.assertRaises(ContractError) as raised:
            self.store.get_fact("hardware_snapshot", "snapshot-x")
        self.assertEqual(raised.exception.code, "state_conflict")


def ref_relative_path(store: CoreStore, ref: dict) -> str:
    row = store.db.execute("SELECT relative_path FROM artifacts WHERE artifact_id = ?", (ref["artifact_id"],)).fetchone()
    return row["relative_path"]


if __name__ == "__main__":
    unittest.main()
