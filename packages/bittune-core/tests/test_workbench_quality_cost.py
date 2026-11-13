import sys
import unittest
from pathlib import Path
from unittest.mock import patch
TESTS=Path(__file__).resolve().parent
sys.path.insert(0,str(TESTS.parent/'src'));sys.path.insert(0,str(TESTS))
from bittune_core.correctness import correctness_pack_info
from bittune_core.cost_projection import token_cost
from bittune_core.suite import benchmark_suite
from bittune_core.contracts import ContractError
from test_suite_sweep import SweepTests

class ProjectionTests(unittest.TestCase):
    def test_user_price_projection_has_explicit_units_and_rejects_missing_rate(self):
        self.assertAlmostEqual(token_cost(10,2,100),55.55555555555556)
        self.assertEqual(token_cost(0,1,100),0)
        for rate in (None,0,-1,float('nan')):
            with self.assertRaises(ContractError):token_cost(10,1,rate)

class QualityBudgetTests(SweepTests):
    def test_pack_budget_blocks_before_quality_http_and_does_not_expose_oracle(self):
        info=correctness_pack_info({}, {})
        self.assertEqual(info['sample_count'],5)
        self.assertNotIn('messages',info);self.assertNotIn('expected',info)
        with patch('bittune_core.benchmark._endpoint_ready',return_value=True),patch('bittune_core.correctness._chat') as chat:
            with self.assertRaises(ContractError):
                self.core.request(benchmark_suite,{'intent':'correctness','service_instance_id':self.service_id,'correctness_pack_path':info['path'],'correctness_pack_hash':info['pack_hash'],'correctness_max_samples':4})
            chat.assert_not_called()
