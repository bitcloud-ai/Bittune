"""User-priced work-point estimate over a saved measurement; never a bill or capacity claim."""
import json
import math
from bittune_core.contracts import ContractError, claimable
from bittune_core.runs import ManagedRun
from bittune_core.store import utc_now


def token_cost(price, gpu_count, output_rate):
    if isinstance(price, bool) or not isinstance(price, (int,float)) or not math.isfinite(price) or price < 0:
        raise ContractError('invalid_input','请填写非负GPU小时单价。')
    if isinstance(gpu_count, bool) or not isinstance(gpu_count,int) or not 1 <= gpu_count <= 1024:
        raise ContractError('invalid_input','需要明确的工作点GPU张数。')
    if isinstance(output_rate,bool) or not isinstance(output_rate,(int,float)) or not math.isfinite(output_rate) or output_rate <= 0:
        raise ContractError('invalid_input','没有完整、正数的输出吞吐，不能估算成本。')
    value=price * gpu_count * 1_000_000 / (3600 * output_rate)
    if not math.isfinite(value):raise ContractError("invalid_input","估算金额超出可表示范围。")
    return value


def run_cost_planning(params,context):
    store=context['store']
    with ManagedRun(store,'benchmark_suite',params,context['session_id'],context) as run:
        fact=store.get_fact('suite_result',params.get('suite_result_id'))
        suite=fact['payload']
        rows=[r for r in suite.get('rows') or [] if r.get('scenario_id')==params.get('scenario_id') and r.get('concurrency')==params.get('concurrency') and r.get('repeat',1)==params.get('repeat',1)]
        if len(rows)!=1:raise ContractError('invalid_input','需要唯一的已保存工作点。')
        row=rows[0]
        if row.get('state') not in ('healthy','measured') or row.get('measurement_status') not in (None,'complete'):
            raise ContractError('invalid_input','工作点测量未完整，不能估算成本。')
        benchmark=store.get_fact('benchmark_result',row.get('benchmark_result_id'))
        if not claimable(benchmark['payload']):raise ContractError('invalid_input','来源不是受管实测。')
        currency=params.get('currency')
        if not isinstance(currency,str) or len(currency)!=3 or not currency.isascii() or not currency.isalpha() or currency!=currency.upper():
            raise ContractError('invalid_input','币种使用三位大写代码，例如CNY或USD；不做汇率转换。')
        rate=(row.get('metrics') or {}).get('output_tokens_per_second')
        estimate=token_cost(params.get('gpu_hourly_price'),params.get('gpu_count'),rate)
        payload={'schema_version':'bittune-token-cost-v1','estimated':True,'provenance':'derived','created_at':utc_now(),
            'source':{'suite_result_id':suite['suite_result_id'],'suite_content_hash':fact['content_hash'],'benchmark_result_id':row['benchmark_result_id'],'benchmark_content_hash':benchmark['content_hash'],'scenario_id':row['scenario_id'],'concurrency':row['concurrency'],'repeat':row.get('repeat',1)},
            'inputs':{'gpu_hourly_price':params['gpu_hourly_price'],'gpu_count':params['gpu_count'],'currency':currency,'output_tokens_per_second':rate},
            'formula':'gpu_hourly_price * gpu_count * 1000000 / (3600 * output_tokens_per_second)',
            'cost_per_million_output_tokens':estimate,
            'assumptions':['按用户填写的GPU张数和单价全时计费','按此实测工作点输出吞吐线性折算，不是生产容量','不含加载、空闲、网络、存储、税费，不作实际账单承诺']}
        run.artifact('token-cost-estimate',json.dumps(payload,ensure_ascii=False,indent=2),'application/json')
        return run.success('已根据保存的实测工作点与用户费率生成成本估算，未运行GPU。',{'cost_projection':payload})
