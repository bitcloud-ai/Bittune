"""M1 integration through real Core + provider fixture (no GPU or model)."""
import copy
import io
import json
import sys
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
sys.path.insert(0,str(Path(__file__).resolve().parent))
import test_benchmark_report as fixture
from bittune_core.suite import benchmark_suite
from bittune_core.deliverable import export_deliverable
from bittune_core.compare import compare_results
from bittune_core.reports import write_report
from bittune_core.measurement import METRIC_NAMES
from bittune_core.contracts import WORKBOOK_DETAIL_COLUMNS_V2, sha256_bytes, sha256_canonical, ContractError
from bittune_core.adapters import vllm
from openpyxl import load_workbook

class M1SuiteTests(unittest.TestCase):
    def setUp(self):
        fixture.BenchmarkReportTest.setUp(self)
        self.service_id,_=fixture.BenchmarkReportTest.seed_plan_and_service(self)
        builtin=json.loads((Path(__file__).resolve().parents[1]/'src/bittune_core/data/bittune-default-v1.json').read_text())
        scenario={**builtin['registry']['scenarios'][0],'scenario_id':'m1-short','scenario':'chat','concurrency':[1,2,4],'request_count':100}
        self.document={'registry':{'schema_version':2,'profile_id':'m1-test','concurrency_mode':'ladder','scenarios':[scenario],
            'budget':{'max_points':8,'max_requests':800,'max_duration_seconds':120,'max_artifact_bytes':8*1024*1024}},
            'acceptance':{'schema_version':2,'success_rate_min':.9,'latency_comparison':'raw_ms',
                'request_limits_ms':{'e2e':1000,'ttft':1000},'p99_limits_ms':{'e2e':1000,'ttft':1000},
                'stop_policy':{'throughput_drop_ratio':.2}}}
    def tearDown(self):
        fixture.BenchmarkReportTest.tearDown(self)
    def run_suite(self):
        path=self.work/'profile.json';path.write_text(json.dumps(self.document))
        with patch('bittune_core.suite._smoke_blocked',return_value=False), patch('bittune_core.suite._safety_block',return_value=None):
            return self.core.request(benchmark_suite,{'intent':'performance_sweep','service_instance_id':self.service_id,'profile_path':str(path)})['data']['suite_result']
    def test_multi_point_contract_isolation_and_real_goodput(self):
        suite=self.run_suite();rows=suite['rows']
        self.assertEqual(suite['schema_version'],2)
        self.assertEqual([r['state'] for r in rows],['measured']*3)
        self.assertEqual([r['slo_status'] for r in rows],['passed']*3)
        self.assertEqual([r['metrics']['total_requests'] for r in rows],[100]*3)
        self.assertEqual(len({r['measurement']['dataset_input_sha256'] for r in rows}),1)
        scopes=[];ids=[]
        for row in rows:
            result=self.core.store.get_fact('benchmark_result',row['benchmark_result_id'])['payload']
            scopes.append(result['request_evidence']['source_path'])
            self.assertAlmostEqual(row['goodput_req_per_s'],12.5)
            self.assertEqual(set(row['metrics']),set(METRIC_NAMES))
            self.assertEqual(result['measurement'],row['measurement'])
            ids.append(set(result['artifact_ids']))
        self.assertEqual(len(set(scopes)),3)
        self.assertFalse(ids[0]&ids[1])
    def test_slo_failure_confirmed_once_then_stops(self):
        self.document['acceptance']['request_limits_ms']={'e2e':100}
        self.document['acceptance']['p99_limits_ms']={'e2e':100}
        rows=self.run_suite()['rows']
        measured=[r for r in rows if r['state']=='measured']
        self.assertEqual([r['decision'] for r in measured],['confirm','stop'])
        self.assertEqual([r['repeat'] for r in measured],[1,2])
        self.assertTrue(all(r['goodput_req_per_s']==0 for r in measured))
        self.assertTrue(all(r['state']=='not_run_early_stop' for r in rows[2:]))
    def test_suite_comparison_record_persists_experiment_with_original_points(self):
        first=self.run_suite();second=self.run_suite()
        points=[dict(suite_result_id=s['suite_result_id'],scenario_id='m1-short',concurrency=1,repeat=1) for s in (first,second)]
        params=dict(suite_points=points,objective='goodput_req_per_s',record=True,hypothesis='same fixture workload')
        data=self.core.request(compare_results,params)['data']
        self.assertTrue(data['comparison']['claimable'])
        experiment=data['experiment']
        stored=self.core.store.get_fact('experiment',experiment['experiment_id'])['payload']
        self.assertEqual(stored,experiment)
        self.assertEqual(stored['suite_points'],points)
        self.assertEqual(stored['comparison_method'],'suite-points-v1')
        self.assertEqual(stored['compared_benchmark_result_ids'],[s['rows'][0]['benchmark_result_id'] for s in (first,second)])
    def test_budget_does_not_start_extra_points(self):
        self.document['registry']['budget']['max_requests']=100
        rows=self.run_suite()['rows']
        self.assertEqual([r['state'] for r in rows],['measured','not_run_budget','not_run_budget'])
        self.assertEqual(set(rows[1]['metrics']),set(METRIC_NAMES))
        self.assertTrue(all(value is None for value in rows[1]['metrics'].values()))
    def test_report_workbook_zip_and_hashes_are_same_source(self):
        suite=self.run_suite();row=suite['rows'][0]
        report=self.core.request(write_report,{'title':'M1','narrative':'development fixture','conclusion':'contract verified',
            'references':{'suite_result_ids':[suite['suite_result_id']]},
            'suite_claims':[{'suite_result_id':suite['suite_result_id'],'scenario_id':row['scenario_id'],'concurrency':1,'repeat':1,'metric':'input_tokens_total'}]})['data']['report']
        self.assertEqual(report['suite_claims'][0]['value'],row['metrics']['input_tokens_total'])
        for kind in ('result_workbook','evidence_pack'):
            result=self.core.request(export_deliverable,{'intent':kind,'service_instance_id':self.service_id,'profile_id':suite['profile_id']})
            data=self.core.store.read_artifact_bytes(result['data']['artifact']['artifact_id'])
            if kind=='result_workbook':
                book=load_workbook(io.BytesIO(data));sheet=book['全量明细']
                self.assertEqual([c.value for c in sheet[1]],list(WORKBOOK_DETAIL_COLUMNS_V2))
                col=WORKBOOK_DETAIL_COLUMNS_V2.index('input_tokens_total')+1
                self.assertEqual(sheet.cell(2,col).value,row['metrics']['input_tokens_total'])
                self.assertIn('契约与来源',book.sheetnames)
            else:
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    manifest=json.loads(archive.read('manifest.json'))
                    self.assertTrue(any(f['path'].startswith('artifacts/') for f in manifest['files']))
                    for source in manifest['facts']:
                        self.assertEqual(sha256_canonical(json.loads(archive.read(source['path']))),source['export_content_hash'])
                    for item in manifest['files']:
                        raw=archive.read(item['path']);self.assertEqual(sha256_bytes(raw),item['sha256'])
                        self.assertEqual(len(raw),item['size_bytes'])
    def test_cache_uncontrolled_refuses_signed_comparison(self):
        suite=self.run_suite();rows=suite['rows']
        ids=[r['benchmark_result_id'] for r in rows[:2]]
        # Different concurrency still has the original identity refusal.
        same=copy.deepcopy(self.core.store.get_fact('benchmark_result',ids[0])['payload'])
        same['benchmark_result_id']='bench-00000000-0000-4000-8000-000000000077'
        same['measurement']['cache_policy']={'mode':'uncontrolled'}
        self.core.store.put_benchmark_result(same,'run-00000000-0000-4000-8000-000000000000')
        result=self.core.request(compare_results,{'benchmark_result_ids':[ids[0],same['benchmark_result_id']]})['data']['comparison']
        self.assertFalse(result['claimable']);self.assertNotIn('deltas',result)
    def test_explicit_single_selection_exports_without_synthetic_suite_fact(self):
        suite=self.run_suite();bid=suite['rows'][0]['benchmark_result_id']
        result=self.core.request(export_deliverable,{'intent':'evidence_pack','service_instance_id':self.service_id,'benchmark_result_ids':[bid]})
        with zipfile.ZipFile(io.BytesIO(self.core.store.read_artifact_bytes(result['data']['artifact']['artifact_id']))) as z:
            self.assertIn('selection.json',z.namelist())
            value=json.loads(z.read(f'facts/benchmarks/{bid}.json'))
            self.assertEqual(value['benchmark_result_id'],bid)
            self.assertEqual(json.loads(z.read('facts/suite_result.json'))['state'],'未测')
        self.assertEqual(len(self.core.store.list_facts('suite_result')),1)
    def test_tampered_artifact_bytes_block_export(self):
        suite=self.run_suite();value=self.core.store.get_fact('benchmark_result',suite['rows'][0]['benchmark_result_id'])['payload']
        aid=value['artifact_ids'][0]
        row=self.core.store.db.execute('SELECT relative_path FROM artifacts WHERE artifact_id=?',(aid,)).fetchone()
        (self.core.store.home/row[0]).write_bytes(b'changed')
        with self.assertRaises(ContractError) as error:
            self.core.request(export_deliverable,{'intent':'evidence_pack','service_instance_id':self.service_id})
        self.assertEqual(error.exception.code,'state_conflict')
    def test_missing_request_slo_observation_stops_without_fake_goodput(self):
        self.document['registry']['scenarios'][0]['stream']=False
        rows=self.run_suite()['rows']
        self.assertEqual(rows[0]['decision'],'stop')
        self.assertIsNone(rows[0]['goodput_req_per_s'])
        self.assertEqual(rows[0]['request_slo_status'],'unavailable')
        self.assertEqual(rows[1]['state'],'not_run_early_stop')
    def test_same_inputs_controlled_cache_compare_but_changed_set_does_not(self):
        suite=self.run_suite();value=self.core.store.get_fact('benchmark_result',suite['rows'][0]['benchmark_result_id'])['payload']
        clone=copy.deepcopy(value);clone['benchmark_result_id']='bench-00000000-0000-4000-8000-000000000078'
        self.core.store.put_benchmark_result(clone,'run-00000000-0000-4000-8000-000000000000')
        args={'benchmark_result_ids':[value['benchmark_result_id'],clone['benchmark_result_id']]}
        self.assertTrue(self.core.request(compare_results,args)['data']['comparison']['claimable'])
        clone['benchmark_result_id']='bench-00000000-0000-4000-8000-000000000079'
        args['benchmark_result_ids'][1]=clone['benchmark_result_id']
        clone['measurement']['dataset_input_sha256']='sha256:'+'b'*64
        self.core.store.put_benchmark_result(clone,'run-00000000-0000-4000-8000-000000000000')
        result=self.core.request(compare_results,args)['data']['comparison']
        self.assertFalse(result['claimable']);self.assertNotIn('deltas',result)
    def test_disabled_cache_is_an_explicit_supported_flag(self):
        args=vllm.compile_engine_args({'enable_prefix_caching':False})
        self.assertIn('--no-enable-prefix-caching',args)
        with self.assertRaises(ContractError):
            vllm.compile_engine_args({'enable_prefix_caching':False},['--enable-prefix-caching'])
