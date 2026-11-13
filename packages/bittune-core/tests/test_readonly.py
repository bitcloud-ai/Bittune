"""A live writer's records remain readable without changing its state."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))
from bittune_core.store import CoreStore
from bittune_core.lifecycle import CoreLease


class ReadOnlyTest(unittest.TestCase):
    def test_reader_does_not_recover_live_runs_or_accept_writes(self):
        with tempfile.TemporaryDirectory() as home:
            lease = CoreLease(home)
            writer = CoreStore(home)
            try:
                run_id, _ = writer.start_run("benchmark_suite", "managed", {}, "live-session")
                reader = CoreStore(home, read_only=True)
                try:
                    self.assertEqual(reader.get_run(run_id)["status"], "running")
                    with self.assertRaises(sqlite3.OperationalError):
                        reader.mark_interrupted_runs()
                finally:
                    reader.close()
                frames = [{"type":"request", "request_id":str(i), "session_id":"viewer", "tool":tool, "params":params}
                          for i, (tool, params) in enumerate([
                              ("inspect_records", {"kind":"run", "id":run_id}),
                              ("deploy_service", {"action":"stop", "service_instance_id":"not-executed"}),
                          ])]
                replies = []
                for frame in frames:
                    result = subprocess.run([sys.executable, "-m", "bittune_core", "--read-only"], input=json.dumps(frame)+"\n",
                                            env={**os.environ,"PYTHONPATH":str(SRC),"BITTUNE_CORE_HOME":home}, text=True, capture_output=True, timeout=20)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    replies.append(json.loads(result.stdout.splitlines()[-1]))
                self.assertEqual(replies[0]["data"]["status"], "running")
                self.assertEqual(replies[1]["error"]["code"], "tool_not_found")
                self.assertEqual(writer.get_run(run_id)["status"], "running")
            finally:
                writer.close()
                lease.close()
