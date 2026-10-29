"""Measurement contract invariants over fixed observations, no model/GPU."""
import json
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from bittune_core.measurement import MeasurementBuilder, METRIC_NAMES, judge, cache_context

POLICY = {'schema_version': 2, 'success_rate_min': 0.9, 'latency_comparison': 'raw_ms',
          'request_limits_ms': {'e2e': 500}, 'p99_limits_ms': {'e2e': 500},
          'stop_policy': {'throughput_drop_ratio': 0.2}}

class MeasurementTests(unittest.TestCase):
    def row(self, latency=.4, stream=True, success=True):
        return {'success': int(success), 'is_stream': int(stream), 'start_time': 10, 'completed_time': 12,
                'latency': latency if success else None, 'first_chunk_latency': .1 if stream else 0,
                'time_per_output_token': .15 if stream else 0, 'prompt_tokens': 16 if success else None,
                'completion_tokens': 3 if success else None, 'inter_token_latencies': [.1, .2] if stream else []}
    def build(self, rows, policy=POLICY):
        b=MeasurementBuilder(policy)
        for i,r in enumerate(rows): b.observe(r, json.dumps({'prompt':[i,2,3]}))
        return b.finish({'e2e_latency_ms':[r['latency']*1000 for r in rows if r['success']]}, 'complete')
    def test_per_request_goodput_is_not_whole_point_rps(self):
        result=self.build([self.row(.4),self.row(.8)])
        self.assertEqual(set(result['metrics']),set(METRIC_NAMES))
        self.assertEqual(result['metrics']['requests_per_second'],1)
        self.assertEqual(result['metrics']['goodput_req_per_s'],.5)
        self.assertEqual(result['metrics']['goodput_output_tokens_per_second'],1.5)
        self.assertFalse(result['slo']['passed'])
        self.assertEqual(result['metrics']['input_tokens_total'],32)
        self.assertEqual(result['metrics']['input_tokens_per_second'],16)
        self.assertAlmostEqual(result['metrics']['p99_e2e_latency_ms'],796)
    def test_unknown_failures_not_imputed_as_zero_timeout(self):
        result=self.build([self.row(),self.row(success=False)])
        self.assertIsNone(result['metrics']['timeout_requests'])
        self.assertEqual(result['metrics']['unknown_failure_requests'],1)
        self.assertIn('timeout_requests',result['unavailable_reasons'])
    def test_no_policy_and_nonstream_limit_are_explicit_unavailable(self):
        self.assertIsNone(self.build([self.row()],None)['metrics']['goodput_req_per_s'])
        policy={**POLICY,'request_limits_ms':{'ttft':500}}
        result=self.build([self.row(stream=False)],policy)
        self.assertIsNone(result['metrics']['goodput_req_per_s'])
        self.assertIsNone(result['metrics']['p99_ttft_ms'])
    def test_hash_is_multiset_preserves_duplicates_and_not_order_proof(self):
        b=MeasurementBuilder()
        for v in [1,2,1]: b.observe(self.row(),json.dumps({'prompt':[v]}))
        c=MeasurementBuilder()
        for v in [2,1,1]: c.observe(self.row(),json.dumps({'prompt':[v]}))
        x=b.finish({'e2e_latency_ms':[400]*3},'complete');y=c.finish({'e2e_latency_ms':[400]*3},'complete')
        self.assertEqual(x['dataset_input_sha256'],y['dataset_input_sha256'])
        self.assertEqual(x['input_order'],'not_recorded')
        d=MeasurementBuilder();d.observe(self.row(),'{"prompt":[1]}')
        self.assertNotEqual(x['dataset_input_sha256'],d.finish({'e2e_latency_ms':[400]},'complete')['dataset_input_sha256'])
    def test_floor_only_when_requested_and_raw_preserved(self):
        policy={**POLICY,'p99_limits_ms':{'tpot':50}}
        self.assertFalse(judge({'success_rate':1,'p99_tpot_ms':50.9},policy)['passed'])
        self.assertTrue(judge({'success_rate':1,'p99_tpot_ms':50.9},{**policy,'latency_comparison':'floor_ms'})['passed'])
    def test_nonfinite_policy_and_schema_drift_are_rejected(self):
        from bittune_core.measurement import validate_acceptance,validate_measurement
        from bittune_core.contracts import ContractError
        with self.assertRaises(ContractError):validate_acceptance({**POLICY,'success_rate_min':float('nan')})
        value=self.build([self.row()]);value['extra']='unknown'
        with self.assertRaises(Exception):validate_measurement(value)
    def test_serving_budget_rejects_nonfinite_values_in_core(self):
        from bittune_core.adapters import vllm,sglang
        from bittune_core.contracts import ContractError
        for adapter,field in ((vllm,'gpu_memory_utilization'),(sglang,'mem_fraction_static')):
            for number in (float('nan'),float('inf')):
                with self.subTest(field=field,number=number),self.assertRaises(ContractError):adapter.materialize({field:number})
    def test_no_gpu_poll_is_unknown_not_zero(self):
        from bittune_core.benchmark import _GpuSampler
        self.assertIsNone(_GpuSampler([],None).stop())
    def test_real_provider_subprocess_closes_both_pipes(self):
        import subprocess
        from unittest.mock import patch
        from bittune_core.process import run_command
        original=subprocess.Popen;children=[]
        def launch(*args,**kwargs):
            p=original(*args,**kwargs);children.append(p);return p
        with patch('bittune_core.process.subprocess.Popen',side_effect=launch):
            result=run_command([sys.executable,'-c','import sys; print("out"); print("err",file=sys.stderr)'])
        self.assertEqual(result['stdout'].strip(),'out')
        self.assertTrue(children[0].stdout.closed and children[0].stderr.closed)
    def test_cache_false_requires_actual_negative_flag(self):
        s={'service_instance_id':'service-fixture','plan_id':'plan-fixture','config_hash':'sha256:'+'c'*64,'ownership':'managed','runtime_spec':{'runtime_kind':'vllm'},'serving_spec':{'enable_prefix_caching':False}}
        self.assertEqual(cache_context(s)['mode'],'uncontrolled')
        self.assertEqual(cache_context({**s,'engine_args':['--no-enable-prefix-caching']})['mode'],'disabled')
