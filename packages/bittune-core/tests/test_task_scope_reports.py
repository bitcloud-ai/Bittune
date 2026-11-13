"""Real Core / fake executor coverage for M2's scope and 110-to-27 failures."""
import copy
import json
import unittest
import os
from pathlib import Path
from unittest.mock import patch
import test_m1_suite as fixture
from bittune_core.contracts import ContractError
from bittune_core.inspect import inspect_service
from bittune_core.services import deploy_service
from bittune_core.plans import plan_deployment
from bittune_core.reports import write_report
from bittune_core.task_scope import TaskScope
from bittune_core.evidence import ingest_evidence, inspect_records

class TaskScopeReportsTests(unittest.TestCase):
    setUp=fixture.M1SuiteTests.setUp
    tearDown=fixture.M1SuiteTests.tearDown
    run_suite=fixture.M1SuiteTests.run_suite

    def request(self, handler, params):
        try:return {'ok':True,**self.core.request(handler,params)}
        except ContractError as error:return {'ok':False,'error':{'code':error.code,'message':error.message}}

    def scope(self, execution=False):
        service=self.core.store.get_fact('service_instance',self.service_id)['payload']
        return TaskScope(dict(schema_version=1,allow_execution=execution,plan_ids=[service['plan_id']],service_instance_ids=[self.service_id],record_ids=[],read_paths=[]))

    def test_list_and_unknown_service_denied_before_any_executor(self):
        scope=self.scope();self.core.calls.clear()
        for params in ({'action':'list'},{'action':'get','service_instance_id':'service-outside'}):
            result=self.request(scope.bind(inspect_service,self.core.store),params)
            self.assertEqual(result['error']['code'],'task_scope_denied')
        self.assertEqual(self.core.calls,[])
        self.assertEqual(self.core.store.list_runs(limit=1)[0]['input']['_task_scope_hash'],scope.scope_hash)
        result=self.request(scope.bind(inspect_service,self.core.store),{'action':'get','service_instance_id':self.service_id})
        self.assertTrue(result['ok'])
        self.assertTrue(self.core.calls)
        self.assertFalse(any(c[:2]==['docker','ps'] for c in self.core.calls))

    def test_readonly_no_start_and_identity_override_rejected(self):
        scope=self.scope();plan=next(iter(scope.plans));self.core.calls.clear()
        result=self.request(scope.bind(deploy_service,self.core.store),{'action':'start','plan_id':plan})
        self.assertEqual(result['error']['code'],'task_scope_denied');self.assertEqual(self.core.calls,[])
        scope=self.scope(True)
        for change in ({'model_ref':{'local_path':'/forbidden'}},{'runtime_spec':{'image_digest':'sha256:'+'a'*64}}):
            result=self.request(scope.bind(plan_deployment,self.core.store),{'action':'create','based_on_plan_id':plan,'prior_source':'user_specified',**change})
            self.assertEqual(result['error']['code'],'task_scope_denied')
        self.assertEqual(self.core.calls,[])

    def test_failed_ready_service_can_be_cleaned_but_outside_cannot(self):
        scope=self.scope(True);plan=next(iter(scope.plans))
        with patch('bittune_core.services._wait_ready',return_value=(1,False,'fixture not ready')), patch('bittune_core.services.validate_plan',return_value={'state':'valid'}):
            result=self.request(scope.bind(deploy_service,self.core.store),{'action':'start','plan_id':plan,'ready_timeout_seconds':1})
        self.assertEqual(result['error']['code'],'runtime_not_ready')
        for artifact in self.core.store.list_run_artifacts(self.core.store.list_runs(limit=1)[0]['run_id']):
            self.assertIn(artifact['artifact_id'],scope.records)
        created=scope.services-{self.service_id}
        self.assertEqual(len(created),1)
        sid=created.pop()
        self.core.set_control(gpus=fixture.fixture.TWO_GPUS,image_ok=True,run_ok=True,stop_ok=True,labels={'bittune.managed':'true','bittune.service_id':sid,'bittune.plan_id':plan})
        self.core.calls.clear()
        result=self.request(scope.bind(deploy_service,self.core.store),{'action':'stop','service_instance_id':sid})
        self.assertTrue(result['ok'],result)
        result=self.request(scope.bind(deploy_service,self.core.store),{'action':'stop','service_instance_id':'service-outside'})
        self.assertEqual(result['error']['code'],'task_scope_denied')

    def test_derived_plan_granted_without_changing_allowed_model(self):
        scope=self.scope(True);base=next(iter(scope.plans))
        result=self.request(scope.bind(plan_deployment,self.core.store),{'action':'create','prior_source':'user_specified','based_on_plan_id':base,'goal':'scope fixture'})
        self.assertTrue(result['ok'],result)
        self.assertIn(result['data']['plan']['plan_id'],scope.plans)
        self.assertEqual(result['data']['plan']['model_ref'],self.core.store.get_fact('deployment_plan',base)['payload']['model_ref'])

    def test_authorized_history_discovery_applies_scope_before_limit(self):
        first=self.run_suite()
        second=self.run_suite()
        scope=self.scope();scope.records.add(first['suite_result_id'])
        self.core.calls.clear()
        result=self.request(scope.bind(inspect_records,self.core.store),{'kind':'suite_result','limit':1})
        self.assertEqual([r['id'] for r in result['records']],[first['suite_result_id']])
        self.assertNotIn(second['suite_result_id'],scope.records)
        self.assertEqual(self.core.calls,[])
        plans=self.request(scope.bind(inspect_records,self.core.store),{'kind':'deployment_plan'})
        self.assertEqual({r['id'] for r in plans['records']},scope.plans)
        services=self.request(scope.bind(inspect_records,self.core.store),{'kind':'service_instance'})
        self.assertEqual({r['id'] for r in services['records']},scope.services)

    def test_empty_history_and_non_fact_enumeration_stay_bounded(self):
        scope=self.scope()
        result=self.request(scope.bind(inspect_records,self.core.store),{'kind':'report'})
        self.assertEqual(result['records'],[])
        for params in ({'kind':'run'},{'kind':'artifact'},{'kind':'cloud_outbox'},{'kind':'report','id':'report-outside'}):
            result=self.request(scope.bind(inspect_records,self.core.store),params)
            self.assertEqual(result['error']['code'],'task_scope_denied')

    def test_suite_identity_filters_are_forwarded(self):
        suite=self.run_suite();source=self.core.store.get_fact('suite_result',suite['suite_result_id'])
        other=copy.deepcopy(suite);other['suite_result_id']='suite-other-revision'
        other['model_ref']['revision']='another-revision'
        self.core.store.put_suite_result(other,source['source_run_id'])
        params={key:suite[key] for key in ('hardware_snapshot_id','profile_id','service_instance_id')}
        params.update(model_id=suite['model_ref']['model_id'],model_revision=suite['model_ref']['revision'],runtime_kind=suite['runtime_spec']['runtime_kind'])
        result=self.request(inspect_records,{'kind':'suite_result',**params})
        self.assertTrue(result['ok'],result)
        self.assertEqual([r['id'] for r in result['records']],[suite['suite_result_id']])
        result=self.request(inspect_records,{'kind':'suite_result',**params,'model_revision':'missing-revision'})
        self.assertEqual(result['records'],[])

    def test_unsupported_suite_filter_is_explicit_error(self):
        result=self.request(inspect_records,{'kind':'suite_result','ownership':'managed'})
        self.assertEqual(result['error']['code'],'invalid_input')
        result=self.request(inspect_records,{'kind':'correctness_result','model_revision':'unsupported'})
        self.assertEqual(result['error']['code'],'invalid_input')

    def test_second_engine_requires_exact_host_runtime_and_same_model(self):
        config=self.scope(True).document
        runtime=dict(schema_version=1,runtime_kind='sglang',image_repository='lmsysorg/sglang',image_digest='sha256:'+'b'*64,runtime_major='0')
        config['runtime_specs']=[runtime];scope=TaskScope(config);base=next(iter(scope.plans))
        params=dict(action='create',prior_source='user_specified',based_on_plan_id=base,runtime_spec=runtime)
        wrong=self.request(scope.bind(plan_deployment,self.core.store),{**params,'runtime_spec':{**runtime,'image_digest':'sha256:'+'c'*64}})
        self.assertEqual(wrong['error']['code'],'task_scope_denied')
        good=self.request(scope.bind(plan_deployment,self.core.store),params)
        self.assertTrue(good['ok'],good)
        self.assertEqual(good['data']['plan']['runtime_spec'],runtime)
        self.assertEqual(good['data']['plan']['model_ref'],self.core.store.get_fact('deployment_plan',base)['payload']['model_ref'])

    def large_suite(self):
        suite=self.run_suite();fact=self.core.store.get_fact('suite_result',suite['suite_result_id'])
        rows=[]
        for n in range(4):
            for row in suite['rows']:
                rows.append({**copy.deepcopy(row),'scenario_id':f'scenario-{n}'})
        suite={**suite,'suite_result_id':'suite-large','rows':rows}
        self.core.store.put_suite_result(suite,fact['source_run_id'])
        return suite

    def test_compact_selection_covers_repeats_and_unrun_rows(self):
        suite=self.large_suite();source=self.core.store.get_fact('suite_result',suite['suite_result_id'])
        suite['rows'].append({'scenario_id':'skipped','concurrency':8,'repeat':1,'state':'not_run_budget','reason_code':'budget_exhausted'})
        suite['suite_result_id']='suite-with-skip';self.core.store.put_suite_result(suite,source['source_run_id'])
        metrics=['total_requests','duration_seconds','requests_per_second','output_tokens_per_second','goodput_req_per_s','p99_ttft_ms','p99_tpot_ms','p99_itl_ms','p99_e2e_latency_ms']
        result=self.request(write_report,dict(title='all rows',narrative='synthetic development evidence',conclusion='not GPU acceptance',suite_selections=[dict(suite_result_id=suite['suite_result_id'],metrics=metrics)]))
        self.assertTrue(result['ok'],result);report=result['data']['report']
        self.assertEqual(len(report['suite_claims']),108)
        self.assertEqual(len(report['coverage']['suites'][0]['rows']),13)
        self.assertEqual(report['coverage']['suites'][0]['rows'][-1]['numeric_claims'],0)

    def test_copy_keeps_110_and_rejects_27_override_without_mutation(self):
        suite=self.large_suite()
        metrics=['total_requests','duration_seconds','requests_per_second','output_tokens_per_second','goodput_req_per_s','p99_ttft_ms','p99_tpot_ms','p99_itl_ms','p99_e2e_latency_ms']
        claims=[dict(suite_result_id=suite['suite_result_id'],scenario_id=r['scenario_id'],concurrency=r['concurrency'],repeat=r['repeat'],metric=m) for r in suite['rows'] for m in metrics]
        claims.extend([{**claims[0],'metric':'slo_passed_requests'},{**claims[9],'metric':'slo_passed_requests'}])
        original=self.request(write_report,dict(title='source',narrative='fixture',conclusion='retained',references={'suite_result_ids':[suite['suite_result_id']]},suite_claims=claims))['data']['report']
        old=self.core.store.get_fact('report',original['report_id'])
        result=self.request(write_report,dict(title='copy',narrative='correct text only',conclusion='same facts',based_on_report_id=original['report_id']))
        self.assertTrue(result['ok'],result)
        self.assertEqual(len(result['data']['report']['suite_claims']),110)
        self.assertEqual(result['data']['report']['suite_claims'],original['suite_claims'])
        self.assertEqual(self.core.store.get_fact('report',original['report_id']),old)
        before=len(self.core.store.list_facts('report',limit=100))
        result=self.request(write_report,dict(title='bad copy',narrative='110',conclusion='not allowed',based_on_report_id=original['report_id'],suite_claims=claims[:27]))
        self.assertEqual(result['error']['code'],'report_coverage_mismatch')
        self.assertEqual(len(self.core.store.list_facts('report',limit=100)),before)

    def test_missing_selected_metric_is_not_success(self):
        suite=self.run_suite()
        result=self.request(write_report,dict(title='bad selection',narrative='all',conclusion='all',suite_selections=[dict(suite_result_id=suite['suite_result_id'],metrics=['made_up_metric'])]))
        self.assertEqual(result['error']['code'],'invalid_input')

    def test_unavailable_selected_value_keeps_reason_and_missing_reason_fails(self):
        suite=self.run_suite();source=self.core.store.get_fact('suite_result',suite['suite_result_id'])
        suite['suite_result_id']='suite-unavailable';row=suite['rows'][0]
        row['metrics']['timeout_requests']=None
        row['measurement']['unavailable_reasons']['timeout_requests']='provider does not classify failures'
        self.core.store.put_suite_result(suite,source['source_run_id'])
        params=dict(title='unknown timeout',narrative='fixture',conclusion='not zero',suite_selections=[dict(suite_result_id=suite['suite_result_id'],metrics=['timeout_requests'])])
        result=self.request(write_report,params);self.assertTrue(result['ok'],result)
        report=result['data']['report'];self.assertEqual(len(report['suite_claims']),0)
        self.assertIn('timeout_requests',report['coverage']['suites'][0]['rows'][0]['unavailable'])
        del row['measurement']['unavailable_reasons']['timeout_requests'];suite['suite_result_id']='suite-missing-reason'
        self.core.store.put_suite_result(suite,source['source_run_id'])
        params['suite_selections'][0]['suite_result_id']=suite['suite_result_id']
        result=self.request(write_report,params);self.assertEqual(result['error']['code'],'report_coverage_mismatch')

    def test_invalid_scope_never_falls_back_to_unrestricted(self):
        path=self.work/'invalid-scope.json';path.write_text('{"allow_execution":false}')
        with patch.dict(os.environ,{'BITTUNE_TASK_SCOPE_FILE':str(path)}):
            with self.assertRaises(ContractError) as caught:TaskScope.from_env()
            self.assertEqual(caught.exception.code,'invalid_task_scope')

    def test_generic_evidence_uses_core_scope_hash_not_staged_value(self):
        scope=self.scope();path=self.core.store.staging_path('session-1','scope-evidence.json')
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(json.dumps({'tool_name':'bash','status':'failed','summary':'policy rejected',
            'input':{'command':'docker ps','_task_scope_hash':'untrusted'},'outputs':[]}))
        result=self.request(scope.bind(ingest_evidence,self.core.store),{'staging_file':'scope-evidence.json'})
        self.assertTrue(result['ok'],result)
        row=self.core.store.get_run(result['run_id'])
        self.assertEqual(row['input']['_task_scope_hash'],scope.scope_hash)

if __name__=='__main__':unittest.main()
