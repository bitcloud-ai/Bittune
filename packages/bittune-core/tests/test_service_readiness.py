"""A stopped owned container must not consume the full HTTP-ready timeout."""
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from bittune_core.services import _wait_ready


class ReadyExitTests(unittest.TestCase):
    def test_exited_owned_container_returns_failure_and_logs_immediately(self):
        service = {"container_id": "owned-container", "service_instance_id": "service-owned", "plan_id": "plan-owned", "endpoint": "http://127.0.0.1:10000", "observed_state": "running"}
        state = {"status": "exited", "running": False, "exit_code": 1, "oom_killed": False, "labels": {"bittune.managed": "true", "bittune.service_id": "service-owned", "bittune.plan_id": "plan-owned"}}
        run = Mock()
        run.artifact.return_value = {"artifact_id": "artifact-log"}
        cancellation = Mock()
        with patch("time.monotonic", side_effect=[0, 0.1, 0.2, 601, 601]), \
             patch("bittune_core.services._inspect_container", return_value=state), \
             patch("bittune_core.services._docker_logs", return_value={"raw": "engine failed"}) as logs, \
             patch("bittune_core.services.urllib.request.urlopen", side_effect=URLError("refused")) as probe, \
             patch("bittune_core.services.wait_interval") as wait:
            elapsed, ready, error = _wait_ready(service, 600, run, cancellation)
        self.assertFalse(ready)
        self.assertLess(elapsed, 1)
        self.assertIn("exited", error)
        self.assertEqual(service["observed_state"], "exited")
        logs.assert_called_once_with("owned-container", cancellation)
        self.assertTrue(run.artifact.called)
        probe.assert_not_called()
        wait.assert_not_called()
