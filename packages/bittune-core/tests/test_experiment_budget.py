"""Real Core admissions and provider fixture; no inference server."""
import copy
import json
import unittest
from unittest.mock import patch
import test_m1_suite as fixture
from bittune_core.benchmark import benchmark_service
from bittune_core.contracts import ContractError
from bittune_core.suite import benchmark_suite
from bittune_core.suite_profiles import load_profile
from bittune_core.task_scope import TaskScope


class ExperimentBudgetTests(unittest.TestCase):
    setUp = fixture.M1SuiteTests.setUp
    tearDown = fixture.M1SuiteTests.tearDown

    def prepare(self):
        self.document['registry']['budget'].update(max_points=6, max_requests=384)
        self.path = self.work / 'profile.json'
        self.path.write_text(json.dumps(self.document))
        self.params = dict(intent='performance_sweep', service_instance_id=self.service_id, profile_path=str(self.path))
        service = self.core.store.get_fact('service_instance', self.service_id)['payload']
        self.config = dict(schema_version=1, allow_execution=True, plan_ids=[service['plan_id']],
                           service_instance_ids=[self.service_id], record_ids=[], read_paths=[str(self.path)],
                           experiment_budget=dict(profile_hash=load_profile(str(self.path))['profile_hash'],
                                                  max_suite_calls=3, max_points=18, max_requests=1152))
        return TaskScope(self.config)

    def call(self, scope, params=None, handler=benchmark_suite):
        with patch('bittune_core.suite._smoke_blocked', return_value=False), patch('bittune_core.suite._safety_block', return_value=None):
            return self.core.request(scope.bind(handler, self.core.store), params or self.params)

    def test_three_suites_then_fourth_denied_before_executor(self):
        scope = self.prepare()
        for _ in range(3):
            # SDK preflight is read-only and does not consume a reservation.
            scope.check('benchmark_suite', self.params, self.core.store)
            self.assertIn('suite_result', self.call(scope)['data'])
        self.core.calls.clear()
        with self.assertRaises(ContractError) as caught:
            self.call(TaskScope(self.config))
        self.assertEqual(caught.exception.code, 'experiment_budget_exhausted')
        self.assertEqual(self.core.calls, [])
        self.assertEqual(self.core.store.experiment_budget_usage(scope.scope_hash), dict(suite_calls=3, points=18, requests=1152))

    def test_failure_reserves_budget_and_request_total_can_block(self):
        scope = self.prepare()
        self.config['experiment_budget']['max_requests'] = 384
        scope = TaskScope(self.config)
        with patch('bittune_core.suite._ready_managed', side_effect=ContractError('fixture_failure', 'failed preflight')):
            with self.assertRaises(ContractError):
                self.call(scope)
        self.assertEqual(self.core.store.experiment_budget_usage(scope.scope_hash), dict(suite_calls=1, points=6, requests=384))
        with self.assertRaises(ContractError) as caught:
            self.call(TaskScope(self.config))
        self.assertEqual(caught.exception.code, 'experiment_budget_exhausted')

    def test_other_entry_and_changed_profile_denied_without_reservation(self):
        scope = self.prepare()
        for params, handler in ((self.params, benchmark_service),
                                ({**self.params, 'intent':'correctness'}, benchmark_suite),
                                ({**self.params, 'package':'full'}, benchmark_suite)):
            with self.assertRaises(ContractError) as caught:
                self.call(scope, params, handler)
            self.assertEqual(caught.exception.code, 'task_scope_denied')
        changed = copy.deepcopy(self.document)
        changed['registry']['budget']['max_requests'] += 1
        self.path.write_text(json.dumps(changed))
        with self.assertRaises(ContractError) as caught:
            self.call(scope)
        self.assertEqual(caught.exception.code, 'task_scope_denied')
        self.assertEqual(self.core.store.experiment_budget_usage(scope.scope_hash)['suite_calls'], 0)


if __name__ == '__main__':
    unittest.main()
