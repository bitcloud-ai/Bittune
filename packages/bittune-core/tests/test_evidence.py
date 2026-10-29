"""Redaction rules and evidence intake validation/handler tests."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

SRC_ROOT = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_ROOT))

from bittune_core.contracts import ContractError  # noqa: E402
from bittune_core.evidence import _validate_evidence_record, ingest_evidence  # noqa: E402
from bittune_core.redaction import redact, redact_text  # noqa: E402
from bittune_core.store import CoreStore  # noqa: E402


class RedactionTest(unittest.TestCase):
    def test_text_patterns(self) -> None:
        self.assertEqual(redact_text("Authorization: Bearer abc.def"), "Authorization: Bearer [REDACTED]")
        self.assertEqual(redact_text("--api-key sk-1234 --token x"), "--api-key [REDACTED] --token [REDACTED]")
        self.assertEqual(redact_text("password= hunter2; next"), "password= [REDACTED]; next")
        self.assertEqual(redact_text("api_key: \"quoted-secret\""), "api_key: [REDACTED]")

    def test_structured_keys(self) -> None:
        value = {"api_key": "sk-1", "nested": {"token": "t"}, "keep": "x", "Authorization": "Bearer z"}
        self.assertEqual(redact(value), {"api_key": "[REDACTED]", "nested": {"token": "[REDACTED]"}, "keep": "x", "Authorization": "[REDACTED]"})

    def test_passthrough(self) -> None:
        self.assertEqual(redact_text("nvidia-smi --query-gpu=name"), "nvidia-smi --query-gpu=name")
        self.assertEqual(redact(42), 42)


def make_record(**overrides) -> dict:
    record = {
        "tool_name": "bash",
        "status": "completed",
        "summary": "inspected",
        "input": {"command": "docker ps", "cwd": "/tmp"},
    }
    record.update(overrides)
    return record


class EvidenceIntakeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = Path(tempfile.mkdtemp(prefix="bittune-evidence-test-"))
        self.store = CoreStore(self.home)
        self.context = {"session_id": "session-1", "store": self.store, "cancellation": type("NoCancel", (), {"raise_if_requested": lambda self: None})(), "emit_progress": lambda *a, **k: None}

    def tearDown(self) -> None:
        self.store.close()

    def staging(self, name: str, record: dict) -> None:
        path = self.store.staging_path("session-1", name)
        path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")

    def test_ingest_persists_redacted_run_and_artifacts(self) -> None:
        self.staging("ev-1.json", make_record(outputs=[{"label": "stdout", "content": "secret Bearer abc\nok\n", "media_type": "text/plain"}]))
        result = ingest_evidence({"staging_file": "ev-1.json"}, self.context)
        run = self.store.get_run(result["run_id"])
        self.assertEqual(run["status"], "completed")
        self.assertEqual(run["input"]["command"], "docker ps")
        self.assertEqual(run["artifacts"][0]["size_bytes"], len("secret Bearer [REDACTED]\nok\n"))
        excerpt = self.store.read_artifact_excerpt(run["artifacts"][0]["artifact_id"])
        self.assertEqual(excerpt["text"], "secret Bearer [REDACTED]\nok\n")
        self.assertFalse(self.store.staging_path("session-1", "ev-1.json").exists())

    def test_failed_record_keeps_run_failed_and_consumes_staging(self) -> None:
        self.staging("ev-fail.json", make_record(status="failed", error={"code": "timeout", "message": "timed out"}))
        result = ingest_evidence({"staging_file": "ev-fail.json"}, self.context)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(self.store.get_run(result["run_id"])["observation"]["error"]["code"], "timeout")
        # ingestion succeeded; the staging record is consumed, the Run keeps the failure.
        self.assertFalse(self.store.staging_path("session-1", "ev-fail.json").exists())

    def test_cancelled_record_keeps_run_cancelled(self) -> None:
        self.staging("ev-cancel.json", make_record(status="cancelled", summary="user aborted"))
        result = ingest_evidence({"staging_file": "ev-cancel.json"}, self.context)
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(self.store.get_run(result["run_id"])["status"], "cancelled")

    def test_validation_rejects_unknown_tool_and_status(self) -> None:
        with self.assertRaises(ContractError) as raised:
            _validate_evidence_record(make_record(tool_name="deploy_service"))
        self.assertEqual(raised.exception.code, "invalid_input")
        with self.assertRaises(ContractError):
            _validate_evidence_record(make_record(status="running"))

    def test_missing_staging_file_is_not_fabricated(self) -> None:
        with self.assertRaises(ContractError) as raised:
            ingest_evidence({"staging_file": "absent.json"}, self.context)
        self.assertEqual(raised.exception.code, "not_found")
        self.assertEqual(self.store.list_runs(), [])

    def test_invalid_json_record_fails_and_keeps_file(self) -> None:
        path = self.store.staging_path("session-1", "broken.json")
        path.write_text("{not json", encoding="utf-8")
        with self.assertRaises(ContractError):
            ingest_evidence({"staging_file": "broken.json"}, self.context)
        self.assertTrue(path.exists())


if __name__ == "__main__":
    unittest.main()