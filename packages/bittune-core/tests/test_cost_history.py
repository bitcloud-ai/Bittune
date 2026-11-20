"""CPU-only development fixtures; none of these values are model measurements."""
import hashlib
import json
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from bittune_core.store import CoreStore
from bittune_core.cost_projection import cost_estimates, run_cost_planning
from bittune_core.contracts import ContractError


def seed_cost_source(store, normalized_metrics=None):
    source, _ = store.start_run('synthetic-development-fixture', 'managed', {'fixture_only': True}, 'fixture')
    benchmark_id, suite_id = 'bench-' + str(uuid.uuid4()), 'suite-' + str(uuid.uuid4())
    store.put_benchmark_result({'benchmark_result_id': benchmark_id, 'workload_hash': 'sha256:' + hashlib.sha256(b'synthetic-development-only').hexdigest(), 'provenance': 'measured', 'binding': 'bound', 'fixture_only': True, 'model_ref': {'model_id': 'fixture/NOT-A-MODEL'}}, source)
    store.put_suite_result({'suite_result_id': suite_id, 'profile_id': 'synthetic-development-only', 'profile_hash': 'sha256:' + hashlib.sha256(b'synthetic-profile').hexdigest(), 'provenance': 'measured', 'fixture_only': True, 'model_ref': {'model_id': 'fixture/NOT-A-MODEL'}, 'rows': [
        {'scenario_id': 'synthetic-development-only', 'concurrency': 1, 'repeat': 1, 'state': 'measured', 'measurement_status': 'complete', 'benchmark_result_id': benchmark_id, 'metrics': {'output_tokens_per_second': 999}, 'measurement': {'metrics': {'output_tokens_per_second': 100} if normalized_metrics is None else normalized_metrics}}
    ]}, source)
    store.finish_run(source, 'completed', {'fixture_only': True})
    return suite_id


def estimate(store, suite_id, price=10, currency='CNY'):
    return run_cost_planning({'intent': 'cost_planning', 'suite_result_id': suite_id, 'scenario_id': 'synthetic-development-only', 'concurrency': 1, 'repeat': 1, 'gpu_hourly_price': price, 'gpu_count': 2, 'currency': currency}, {'store': store, 'session_id': 'cpu-only-fixture'})


class CostHistoryTests(unittest.TestCase):
    def test_history_survives_reopen_filters_and_paginates_without_new_runs(self):
        with tempfile.TemporaryDirectory() as root:
            home = Path(root)
            store = CoreStore(home)
            suite = seed_cost_source(store)
            other = seed_cost_source(store)
            results = [estimate(store, suite, 0), estimate(store, suite, 10), estimate(store, suite, 10, 'USD')]
            estimate(store, other, 20)
            self.assertAlmostEqual(results[1]['data']['cost_projection']['cost_per_million_output_tokens'], 55.55555555555556)
            self.assertEqual(results[1]['data']['cost_projection']['inputs']['output_tokens_per_second'], 100)
            empty = seed_cost_source(store, {})
            with self.assertRaises(ContractError):
                estimate(store, empty)
            generic, _ = store.start_run('benchmark_suite', 'generic', {'intent': 'cost_planning', 'suite_result_id': suite}, 'fixture')
            store.write_artifact(generic, 'token-cost-estimate', json.dumps(results[0]['data']['cost_projection']), 'application/json')
            store.finish_run(generic, 'completed', {})
            count = len(store.list_runs(limit=100))
            store.close()
            before = hashlib.sha256((home / 'bittune.db').read_bytes()).hexdigest()
            store = CoreStore(home, read_only=True)
            try:
                first = cost_estimates({'suite_result_ids': [suite], 'limit': 2}, {'store': store})
                second = cost_estimates({'suite_result_ids': [suite], 'limit': 2, 'before': first['next_cursor']}, {'store': store})
                rows = first['estimates'] + second['estimates']
                self.assertEqual(len({r['artifact_id'] for r in rows}), 3)
                self.assertEqual({r['cost_projection']['source']['suite_result_id'] for r in rows}, {suite})
                self.assertTrue(any(r['cost_projection']['cost_per_million_output_tokens'] == 0 for r in rows))
                self.assertEqual({r['cost_projection']['inputs']['currency'] for r in rows}, {'CNY', 'USD'})
                self.assertIsNone(second['next_cursor'])
                self.assertEqual(first['unavailable'], [])
                self.assertEqual(len(store.list_runs(limit=100)), count)
            finally:
                store.close()
            self.assertEqual(hashlib.sha256((home / 'bittune.db').read_bytes()).hexdigest(), before)

    def test_unverifiable_artifact_is_identified_without_hiding_other_estimates(self):
        with tempfile.TemporaryDirectory() as root:
            store = CoreStore(root)
            try:
                suite = seed_cost_source(store)
                valid = estimate(store, suite)
                damaged = estimate(store, suite, 20)
                artifact = store.list_run_artifacts(damaged['run_id'])[0]
                (Path(root) / artifact['relative_path']).write_text('damaged fixture')
                result = cost_estimates({'suite_result_ids': [suite]}, {'store': store})
                self.assertEqual([e['artifact_id'] for e in result['estimates']], [valid['artifact_refs'][0]['artifact_id']])
                self.assertEqual([e['artifact_id'] for e in result['unavailable']], [artifact['artifact_id']])
                self.assertNotIn('cost_per_million_output_tokens', json.dumps(result['unavailable']))
            finally:
                store.close()


if __name__ == '__main__':
    unittest.main()
