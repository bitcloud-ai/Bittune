"""Host-selected resource scope. No shell execution or policy learned from prompts."""
import copy
import json
import os
from pathlib import Path
from importlib import resources
import jsonschema
from bittune_core.contracts import ContractError, sha256_canonical

INVENTORY_COMMANDS = [
    'nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv,noheader',
    'nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader',
]
FACT_IDS = {'hardware_snapshot_id','benchmark_result_id','suite_result_id','report_id','experiment_id','correctness_result_id','cache_pair_result_id','pd_estimate_id','artifact_id','run_id'}

class TaskScope:
    def __init__(self, document):
        schema=json.loads((resources.files('bittune_core')/'data/schemas/task-scope.schema.json').read_text())
        try: jsonschema.validate(document,schema)
        except jsonschema.ValidationError as error: raise ContractError('invalid_task_scope','任务范围配置不符合schema。',{'reason':error.message}) from None
        self.document=copy.deepcopy(document)
        self.plans=set(document['plan_ids']);self.services=set(document['service_instance_ids']);self.records=set(document['record_ids'])
        self.document['read_paths']=[str(Path(p).resolve(strict=True)) for p in document['read_paths']]
        if any(not Path(p).is_file() for p in self.document['read_paths']):
            raise ContractError('invalid_task_scope','read_paths只接受明确的已有文件，不能授权目录。')
        self.scope_hash=sha256_canonical(self.document)

    @classmethod
    def from_env(cls):
        path=os.environ.get('BITTUNE_TASK_SCOPE_FILE')
        if not path:return None
        try:return cls(json.loads(Path(path).read_text()))
        except (OSError,ValueError) as error:raise ContractError('invalid_task_scope',f'任务范围配置无法读取：{type(error).__name__}') from None

    def summary(self):
        return {**copy.deepcopy(self.document),'scope_hash':self.scope_hash,'inventory_commands':list(INVENTORY_COMMANDS)}

    def denied(self, reason):raise ContractError('task_scope_denied',reason,remediation='使用范围内的具体ID或紧凑报告选择；任务范围只能由宿主配置。')
    def allowed_record_ids(self, kind):
        if kind=='deployment_plan':return self.plans
        if kind=='service_instance':return self.services
        return self.records

    def record_allowed(self, kind, rid):
        if kind=='deployment_plan':return rid in self.plans
        if kind=='service_instance':return rid in self.services
        return rid in self.records

    def check(self, tool, params, store):
        if tool=='ingest_evidence':return
        if tool=='inspect_environment':
            if params.get('probes'):self.denied('指定资源任务不执行额外GPU深度探测。')
            return
        if tool=='inspect_records':
            if not params.get('id') and params.get('kind') in (
                    'hardware_snapshot','deployment_plan','service_instance','benchmark_result',
                    'suite_result','correctness_result','cache_pair_result','pd_estimate','experiment','report'):
                return  # Store applies the host ID set before filtering, ordering and LIMIT.
            if not self.record_allowed(params.get('kind'),params.get('id')):self.denied('该记录读取需要已授权的具体ID。')
            return
        if tool=='inspect_service':
            if params.get('action')!='get' or params.get('service_instance_id') not in self.services:self.denied('只允许按范围内服务ID观察，禁止全局服务枚举。')
            return
        if tool in ('plan_deployment','deploy_service','benchmark_service','benchmark_suite') and not self.document['allow_execution']:
            self.denied('本任务只复核已有事实，不部署、不运行模型测量。')
        if tool=='plan_deployment':
            if params.get('action')=='create':
                base=params.get('based_on_plan_id')
                if base not in self.plans:self.denied('创建计划必须继承范围内的已有计划。')
                plan=store.get_fact('deployment_plan',base)['payload']
                if 'model_ref' in params and params['model_ref']!=plan['model_ref']:
                    self.denied('派生计划不能替换已授权模型。')
                if ('runtime_spec' in params and params['runtime_spec']!=plan['runtime_spec'] and
                        params['runtime_spec'] not in self.document.get('runtime_specs',[])):
                    self.denied('派生计划只能使用继承或宿主明确授权的精确镜像。')
                if params.get('prior_source') not in ('user_specified',):self.denied('本任务仅继承已有本地计划。')
            elif params.get('plan_id') not in self.plans:self.denied('计划ID不在任务范围内。')
            return
        if tool=='deploy_service':
            if params.get('action')=='start':
                if params.get('plan_id') not in self.plans:self.denied('不能启动范围外计划。')
            elif params.get('service_instance_id') not in self.services:self.denied('不能操作范围外服务。')
            return
        if tool in ('benchmark_service','benchmark_suite','export_deliverable'):
            if 'endpoint' in params or params.get('service_instance_id') not in self.services:self.denied('本任务只接受范围内受管服务ID，不接受外部端点。')
            if params.get('profile_path') and str(Path(params['profile_path']).resolve()) not in self.document['read_paths']:self.denied('档案文件不在任务范围内。')
            if params.get('correctness_pack_path'):self.denied('本任务未授权额外正确性数据包。')
            for key in ('suite_result_id','cache_pair_result_id'):
                if params.get(key) and params[key] not in self.records:self.denied('引用的扫描/缓存记录不在范围内。')
            if any(b not in self.records for b in params.get('benchmark_result_ids',[])):self.denied('单点记录不在范围内。')
            if self.document.get('experiment_budget') and tool in ('benchmark_service','benchmark_suite'):
                self.suite_reservation(tool, params, store)
            return
        if tool in ('write_report','compare_results'):
            if params.get('based_on_report_id') and params['based_on_report_id'] not in self.records:self.denied('原报告不在范围内。')
            for entry in params.get('suite_points',[])+params.get('suite_selections',[]):
                if entry.get('suite_result_id') not in self.records:self.denied('扫描引用不在范围内。')
            if any(b not in self.records for b in params.get('benchmark_result_ids',[])):self.denied('比较实测记录不在范围内。')
            for kind, entries in (params.get('references') or {}).items():
                allowed=self.plans if kind=='plan_ids' else self.services if kind=='service_instance_ids' else self.records
                if any(rid not in allowed for rid in entries):self.denied('报告引用不在任务范围内。')
            for key, id_key in (('metric_claims','benchmark_result_id'),('suite_claims','suite_result_id'),('pd_claims','pd_estimate_id')):
                if any(c.get(id_key) not in self.records for c in params.get(key,[])):self.denied('报告断言来源不在任务范围内。')
            return
        self.denied('该操作不属于指定资源任务。')

    def suite_reservation(self, tool, params, store):
        from bittune_core.suite_profiles import load_profile
        budget = self.document['experiment_budget']
        if tool != 'benchmark_suite' or params.get('intent') != 'performance_sweep' or params.get('package','short') != 'short':
            self.denied('实验预算只允许冻结档案的performance_sweep短套件，不接受其它测量入口。')
        profile = load_profile(params.get('profile_path'))
        if profile['profile_hash'] != budget['profile_hash'] or profile['registry']['schema_version'] != 2:
            self.denied('实验档案与宿主冻结的profile_hash不一致。')
        per_suite = profile['registry']['budget']
        reservation = dict(points=per_suite['max_points'], requests=per_suite['max_requests'])
        usage = store.experiment_budget_usage(self.scope_hash)
        if (usage['suite_calls'] >= budget['max_suite_calls'] or
                usage['points'] + reservation['points'] > budget['max_points'] or
                usage['requests'] + reservation['requests'] > budget['max_requests']):
            raise ContractError('experiment_budget_exhausted','实验总预算不足，不开始新的套件。',
                                {'usage':usage,'reservation':reservation,'budget':budget})
        return reservation

    def register_result(self, tool, result):
        data=result.get('data') or {}
        if tool=='plan_deployment' and (data.get('plan') or {}).get('plan_id'):self.plans.add(data['plan']['plan_id'])
        # Only trusted execution results grant newly written record IDs, never an archive read's references.
        if tool in ('inspect_records','inspect_service'):return
        def visit(value):
            if isinstance(value,dict):
                for key,item in value.items():
                    if key in FACT_IDS and isinstance(item,str):self.records.add(item)
                    visit(item)
            elif isinstance(value,list):
                for item in value:visit(item)
        visit(result)

    def enforce(self, tool, params, context):
        from bittune_core.runs import ManagedRun
        try:self.check(tool, params, context['store'])
        except ContractError:
            # Preserve the rejected request, without calling any resource executor.
            with ManagedRun(context['store'],tool,params,context['session_id'],context):raise

    def bind(self, handler, store):
        def bound(params, context):
            context['store']=store;context['task_scope']=self
            self.enforce(handler.__name__,params,context)
            if handler.__name__ == 'benchmark_suite' and self.document.get('experiment_budget'):
                context['experiment_reservation']=self.suite_reservation(handler.__name__,params,store)
            try:
                result=handler(params,context)
                self.register_result(handler.__name__,result)
                return result
            finally:
                context.pop('experiment_reservation',None)
        return bound
