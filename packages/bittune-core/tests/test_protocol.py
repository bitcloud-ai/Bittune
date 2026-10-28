"""Subprocess-level protocol tests: round trip, cancellation, crash, restart."""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SRC_ROOT = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_ROOT))

PAYLOAD_CHARS = "abcdefgh"


class CoreProcess:
    def __init__(self, home: str, env_overrides: dict | None = None):
        env = dict(os.environ, BITTUNE_CORE_HOME=home, PYTHONPATH=str(SRC_ROOT))
        env.update(env_overrides or {})
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "bittune_core"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            encoding="utf-8",
            cwd=str(SRC_ROOT),
        )

    def send(self, message: dict) -> None:
        self.proc.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()

    def recv(self) -> dict:
        line = self.proc.stdout.readline()
        if not line:
            raise EOFError("core stdout closed before a result arrived")
        return json.loads(line)

    def recv_result(self) -> dict:
        message = self.recv()
        while message.get("type") == "progress":
            message = self.recv()
        return message

    def request(self, tool: str, params: dict, request_id: str = "req-1", session_id: str = "session-1") -> dict:
        self.send({"type": "request", "request_id": request_id, "session_id": session_id, "tool": tool, "params": params})
        return self.recv_result()

    def close(self) -> None:
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        self._drain_and_wait()
        for stream in (self.proc.stdout, self.proc.stderr):
            if stream:
                stream.close()

    def kill(self) -> None:
        self.proc.kill()
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        self._drain_and_wait()
        for stream in (self.proc.stdout, self.proc.stderr):
            if stream:
                stream.close()

    def _drain_and_wait(self) -> None:
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=10)


def write_evidence(home: str, session_id: str, name: str, outputs: list[dict], status: str = "completed") -> None:
    staging = Path(home) / "staging" / session_id
    staging.mkdir(parents=True, exist_ok=True)
    record = {"tool_name": "bash", "status": status, "summary": "bulk output", "input": {"command": "yes", "cwd": "/tmp"}, "outputs": outputs}
    (staging / name).write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")


def big_outputs(count: int, size: int) -> list[dict]:
    return [{"label": f"out-{index}", "content": PAYLOAD_CHARS * size, "media_type": "text/plain"} for index in range(count)]


class ProtocolTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = tempfile.mkdtemp(prefix="bittune-protocol-test-")
        self.core = CoreProcess(self.home)

    def tearDown(self) -> None:
        self.core.close()

    def test_round_trip_and_restart_persistence(self) -> None:
        write_evidence(self.home, "session-1", "ev-1.json", [{"label": "stdout", "content": "hello\n", "media_type": "text/plain"}])
        result = self.core.request("ingest_evidence", {"staging_file": "ev-1.json"})
        self.assertTrue(result["ok"], result)
        run_id = result["data"]["run_id"]
        self.core.close()
        reopened = CoreProcess(self.home)
        self.addCleanup(reopened.close)
        self.core = reopened
        run = self.core.request("inspect_records", {"kind": "run", "id": run_id})
        self.assertTrue(run["ok"], run)
        self.assertEqual(run["data"]["status"], "completed")
        self.assertEqual(run["data"]["observation"]["summary"], "bulk output")

    def test_unknown_tool_and_malformed_frame(self) -> None:
        unknown = self.core.request("publish_deployment_preset", {}, request_id="req-2")
        self.assertEqual(unknown["error"]["code"], "tool_not_found")
        self.core.send("{malformed json")
        malformed = self.core.recv()
        self.assertFalse(malformed["ok"])
        self.assertEqual(malformed["error"]["code"], "invalid_request")
        # a valid request after a bad frame still works
        listing = self.core.request("inspect_records", {"kind": "run"}, request_id="req-5")
        self.assertTrue(listing["ok"], listing)

    def test_invalid_params_are_reported_not_fabricated(self) -> None:
        result = self.core.request("ingest_evidence", {}, request_id="req-6")
        self.assertEqual(result["error"]["code"], "invalid_input")
        listing = self.core.request("inspect_records", {"kind": "run"}, request_id="req-7")
        self.assertEqual(listing["data"]["runs"], [])

    def test_cancel_interrupts_long_ingest(self) -> None:
        write_evidence(self.home, "session-1", "ev-big.json", big_outputs(8, 256 * 1024))
        self.core.send({"type": "request", "request_id": "req-cancel", "session_id": "session-1", "tool": "ingest_evidence", "params": {"staging_file": "ev-big.json"}})
        deadline = time.monotonic() + 30
        progress_seen = 0
        while progress_seen < 2 and time.monotonic() < deadline:
            message = self.core.recv()
            if message.get("type") == "progress":
                progress_seen += 1
            if message.get("type") == "result":
                self.fail(f"ingest finished before cancel could be issued: {message}")
        self.core.send({"type": "cancel", "request_id": "req-cancel"})
        result = self.core.recv()
        self.assertEqual(result.get("type"), "result")
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["error"]["code"], "cancelled")
        runs = self.core.request("inspect_records", {"kind": "run", "status": "cancelled"}, request_id="req-cancel-check")
        self.assertTrue(runs["ok"], runs)
        self.assertEqual(len(runs["data"]["runs"]), 1)

    def test_core_crash_marks_running_run_interrupted(self) -> None:
        write_evidence(self.home, "session-1", "ev-crash.json", big_outputs(8, 256 * 1024))
        self.core.send({"type": "request", "request_id": "req-crash", "session_id": "session-1", "tool": "ingest_evidence", "params": {"staging_file": "ev-crash.json"}})
        # wait for the first progress line, then kill the Core mid-request
        while True:
            message = self.core.recv()
            if message.get("type") == "progress":
                break
        self.core.kill()
        reopened = CoreProcess(self.home)
        self.addCleanup(reopened.close)
        self.core = reopened
        runs = self.core.request("inspect_records", {"kind": "run", "status": "interrupted"}, request_id="req-crash-check")
        self.assertTrue(runs["ok"], runs)
        self.assertEqual(len(runs["data"]["runs"]), 1)

    def test_eof_during_inflight_request_exits_process_promptly(self) -> None:
        """The Core lives and dies with the Runtime session: if stdin closes
        while a request is in flight, the process must stop by itself instead
        of hanging on the dead reader queue (regression for the eof pump)."""
        write_evidence(self.home, "session-1", "ev-eof.json", big_outputs(8, 2 * 1024 * 1024))
        self.core.send(
            {"type": "request", "request_id": "req-eof", "session_id": "session-1", "tool": "ingest_evidence", "params": {"staging_file": "ev-eof.json"}}
        )
        while True:
            message = self.core.recv()
            if message.get("type") == "progress":
                break
        self.core.proc.stdin.close()
        self.core.proc.wait(timeout=10)
        self.assertEqual(self.core.proc.returncode, 0)

    def test_clean_exit_on_stdin_close(self) -> None:
        self.core.close()
        self.assertEqual(self.core.proc.returncode, 0)

    def test_inspect_environment_succeeds_without_nvidia_smi(self) -> None:
        # Isolate the absence being tested, including on real GPU hosts.
        self.core.close()
        with tempfile.TemporaryDirectory() as empty_path:
            self.core = CoreProcess(self.home, {"PATH": empty_path})
            result = self.core.request("inspect_environment", {})
        self.assertTrue(result["ok"], result)
        snapshot = result["data"]["data"]["hardware_snapshot"]
        self.assertEqual(snapshot["gpus"], [])
        self.assertFalse(snapshot["nvidia_available"])


class ProcessContractTest(unittest.TestCase):
    def test_missing_probe_binary_is_unavailable_not_crash(self) -> None:
        from bittune_core.contracts import ContractError
        from bittune_core.process import run_command

        with self.assertRaises(ContractError) as raised:
            run_command(["definitely-not-a-bittune-probe-binary"], timeout_seconds=5)
        self.assertEqual(raised.exception.code, "unavailable")
        self.assertIn("不可用", raised.exception.message)


if __name__ == "__main__":
    unittest.main()
