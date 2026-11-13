"""Focused workbench lifecycle/authority regression; never runs a GPU workload."""
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
from bittune_core.contracts import ContractError
from bittune_core.task_scope import TaskScope


class WorkbenchLifecycleTests(unittest.TestCase):
    def test_live_owner_is_not_recovered_and_dead_owner_is(self):
        with tempfile.TemporaryDirectory() as home:
            env = {**os.environ, "BITTUNE_CORE_HOME": home, "PYTHONPATH": str(SRC)}
            env.pop("BITTUNE_TASK_SCOPE_FILE", None)
            source = """from bittune_core.lifecycle import CoreLease
from bittune_core.store import CoreStore
import sys
lease=CoreLease()
store=CoreStore()
rid,_=store.start_run('inspect_environment','managed',{},'lease-owner')
print(rid,flush=True)
sys.stdin.read()
"""
            owner = subprocess.Popen([sys.executable, "-c", source], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                rid = owner.stdout.readline().strip()
                self.assertTrue(rid.startswith("run-"))
                busy = subprocess.run([sys.executable, "-m", "bittune_core"], env=env, input="", text=True, capture_output=True, timeout=15)
                self.assertEqual(busy.returncode, 2)
                self.assertIn("core_busy", busy.stderr)
                uri = (Path(home) / "bittune.db").as_uri() + "?mode=ro"
                with sqlite3.connect(uri, uri=True) as db:
                    self.assertEqual(db.execute("SELECT status FROM runs WHERE run_id=?", (rid,)).fetchone()[0], "running")
                owner.terminate()
                owner.wait(timeout=10)
                recovered = subprocess.run([sys.executable, "-m", "bittune_core"], env=env, input="", text=True, capture_output=True, timeout=15)
                self.assertEqual(recovered.returncode, 0, recovered.stderr)
                with sqlite3.connect(uri, uri=True) as db:
                    self.assertEqual(db.execute("SELECT status FROM runs WHERE run_id=?", (rid,)).fetchone()[0], "interrupted")
            finally:
                if owner.poll() is None:
                    owner.terminate()
                    owner.wait(timeout=10)
                owner.stdin.close()
                owner.stdout.close()
                owner.stderr.close()

    def test_service_action_and_start_budget_are_host_bound(self):
        doc = {"schema_version": 1, "allow_execution": True, "plan_ids": ["plan-owned"], "service_instance_ids": ["service-owned"], "record_ids": [], "read_paths": [], "tool_actions": {"deploy_service": ["stop"]}}
        scope = TaskScope(doc)
        scope.check("deploy_service", {"action": "stop", "service_instance_id": "service-owned"}, None)
        with self.assertRaises(ContractError):
            scope.check("deploy_service", {"action": "start", "plan_id": "plan-owned"}, None)
        doc.pop("tool_actions")
        doc["max_service_starts"] = 1
        with self.assertRaises(ContractError) as caught:
            TaskScope(doc).check("deploy_service", {"action": "start", "plan_id": "plan-owned"}, None)
        self.assertEqual(caught.exception.code, "experiment_budget_exhausted")

    def test_continue_counts_previous_failed_reservations(self):
        from bittune_core.store import CoreStore
        with tempfile.TemporaryDirectory() as home:
            store = CoreStore(home)
            base = {"schema_version":1,"allow_execution":True,"plan_ids":[],"service_instance_ids":[],"record_ids":[],"read_paths":[],"experiment_budget":{"profile_hash":"sha256:"+"a"*64,"max_suite_calls":2,"max_points":2,"max_requests":4}}
            first = TaskScope(base)
            rid, _ = store.start_run("benchmark_suite", "managed", {"_task_scope_hash":first.scope_hash,"_experiment_reservation":{"points":1,"requests":2}}, "same-session")
            store.finish_run(rid, "failed", {"summary":"fixture failure"})
            own_run = rid
            own_artifact = store.write_artifact(rid, "owned", "owned")["artifact_id"]
            other_run, _ = store.start_run("write_report", "managed", {"_task_scope_hash":first.scope_hash}, "other-session")
            outside = store.write_artifact(other_run, "outside", "outside")["artifact_id"]
            store.finish_run(other_run, "completed", {"summary":"outside"})
            store.put_report({"schema_version":1,"report_id":"report-owned","title":"owned","provenance":"derived","references":{"artifact_ids":[{"artifact_id":outside}]}}, own_run)

            base["experiment_budget"]["previous_scope_hashes"] = [first.scope_hash]
            resumed = TaskScope(base)
            rid, _ = store.start_run("benchmark_suite", "managed", {"_task_scope_hash":resumed.scope_hash,"_experiment_reservation":{"points":1,"requests":2}}, "same-session")
            store.finish_run(rid, "completed", {"summary":"fixture complete"})
            self.assertEqual(resumed.budget_usage(store), {"suite_calls":2,"points":2,"requests":4})
            resumed.restore_history(store, "same-session")
            self.assertTrue({own_run, own_artifact, "report-owned"}.issubset(resumed.records))
            self.assertNotIn(other_run, resumed.records)
            self.assertNotIn(outside, resumed.records, "reading an archive reference grants no authority")

            store.db.close()

            path = Path(home) / "scope.json"
            path.write_text(json.dumps(base))
            env = {**os.environ, "BITTUNE_CORE_HOME":home,"PYTHONPATH":str(SRC)}
            env.pop("BITTUNE_TASK_SCOPE_FILE",None)
            request = {"type":"request","request_id":"ledger-read","session_id":"same-session","tool":"scope_file_info","params":{"path":str(path)}}
            proc = subprocess.run([sys.executable,"-m","bittune_core"],input=json.dumps(request)+"\n",text=True,capture_output=True,env=env,timeout=15)
            result = next(json.loads(line) for line in proc.stdout.splitlines() if json.loads(line).get("type")=="result")
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["data"]["usage"], {"suite_calls":2,"points":2,"requests":4})
