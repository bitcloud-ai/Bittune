"""User-priced work-point estimate over a saved measurement; never a bill or capacity claim."""
import json
import math
import re
from bittune_core.contracts import ContractError, claimable, ARTIFACT_ID
from bittune_core.runs import ManagedRun
from bittune_core.store import utc_now


def token_cost(price, gpu_count, output_rate):
    if isinstance(price, bool) or not isinstance(price, (int,float)) or not math.isfinite(price) or price < 0:
        raise ContractError('invalid_input','请填写非负GPU小时单价。')
    if isinstance(gpu_count, bool) or not isinstance(gpu_count,int) or not 1 <= gpu_count <= 1024:
        raise ContractError('invalid_input','请填写本次测试使用的GPU张数。')
    if isinstance(output_rate,bool) or not isinstance(output_rate,(int,float)) or not math.isfinite(output_rate) or output_rate <= 0:
        raise ContractError('invalid_input','没有完整、正数的输出吞吐，不能估算成本。')
    value=price * gpu_count * 1_000_000 / (3600 * output_rate)
    if not math.isfinite(value):raise ContractError("invalid_input","估算金额超出可表示范围。")
    return value


def cost_estimates(params, context):
    """Read original, hash-checked cost Artifacts; no measurement or new facts."""
    store = context['store']
    ids = params.get('suite_result_ids')
    limit = params.get('limit', 50)
    before = params.get('before')
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ContractError('invalid_input', '成本历史每页数量须为1至100。')
    if ids is not None and (not isinstance(ids, list) or len(ids) > 100 or any(not isinstance(id, str) or not re.fullmatch(r'suite-[a-f0-9-]{36}', id) for id in ids)):
        raise ContractError('invalid_input', '成本历史需要有效的套件来源编号。')
    if before is not None and (not isinstance(before, str) or not ARTIFACT_ID.fullmatch(before)):
        raise ContractError('invalid_input', '成本历史游标无效。')
    rows = store.list_cost_artifacts(ids, limit + 1, before)
    page = rows[:limit]
    estimates, unavailable = [], []
    for row in page:
        try:
            artifact = store.read_artifact_text(row['artifact_id'])
            projection = json.loads(artifact['text'])
            source = projection.get('source') if isinstance(projection, dict) else None
            if not isinstance(source, dict) or projection.get('schema_version') != 'bittune-token-cost-v1' or source.get('suite_result_id') != row['source_suite']:
                raise ContractError('state_conflict', '成本工件格式或来源不匹配。')
            suite = store.get_fact('suite_result', source['suite_result_id'])
            benchmark = store.get_fact('benchmark_result', source['benchmark_result_id'])
            if suite['content_hash'] != source['suite_content_hash'] or benchmark['content_hash'] != source['benchmark_content_hash']:
                raise ContractError('state_conflict', '成本来源摘要不匹配。')
            estimates.append({'artifact_id': row['artifact_id'], 'artifact_sha256': row['sha256'], 'run_id': row['run_id'], 'created_at': row['created_at'], 'cost_projection': projection})
        except (ContractError, OSError, ValueError, KeyError, TypeError):
            unavailable.append({'artifact_id': row['artifact_id'], 'reason': '成本工件或来源暂不可核验，未展示估算金额。'})
    return {'estimates': estimates, 'unavailable': unavailable, 'next_cursor': page[-1]['artifact_id'] if len(rows) > limit else None}


def run_cost_planning(params,context):
    store=context['store']
    with ManagedRun(store,'benchmark_suite',params,context['session_id'],context) as run:
        fact=store.get_fact('suite_result',params.get('suite_result_id'))
        suite=fact['payload']
        rows=[r for r in suite.get('rows') or [] if r.get('scenario_id')==params.get('scenario_id') and r.get('concurrency')==params.get('concurrency') and r.get('repeat',1)==params.get('repeat',1)]
        if len(rows)!=1:raise ContractError('invalid_input','需要唯一的已保存测试结果。')
        row=rows[0]
        if row.get('state') not in ('healthy','measured') or row.get('measurement_status') not in (None,'complete'):
            raise ContractError('invalid_input','测试结果测量未完整，不能估算成本。')
        benchmark=store.get_fact('benchmark_result',row.get('benchmark_result_id'))
        if not claimable(benchmark['payload']):raise ContractError('invalid_input','来源不是受管实测。')
        currency=params.get('currency')
        if not isinstance(currency,str) or len(currency)!=3 or not currency.isascii() or not currency.isalpha() or currency!=currency.upper():
            raise ContractError('invalid_input','币种使用三位大写代码，例如CNY或USD；不做汇率转换。')
        normalized = (row.get('measurement') or {}).get('metrics')
        metrics = normalized if isinstance(normalized, dict) else row.get('metrics') or {}
        rate=metrics.get('output_tokens_per_second')
        estimate=token_cost(params.get('gpu_hourly_price'),params.get('gpu_count'),rate)
        payload={'schema_version':'bittune-token-cost-v1','estimated':True,'provenance':'derived','created_at':utc_now(),
            'source':{'suite_result_id':suite['suite_result_id'],'suite_content_hash':fact['content_hash'],'benchmark_result_id':row['benchmark_result_id'],'benchmark_content_hash':benchmark['content_hash'],'scenario_id':row['scenario_id'],'concurrency':row['concurrency'],'repeat':row.get('repeat',1)},
            'inputs':{'gpu_hourly_price':params['gpu_hourly_price'],'gpu_count':params['gpu_count'],'currency':currency,'output_tokens_per_second':rate},
            'formula':'gpu_hourly_price * gpu_count * 1000000 / (3600 * output_tokens_per_second)',
            'cost_per_million_output_tokens':estimate,
            'assumptions':['按用户填写的GPU张数和单价全时计费','按所选测试结果的输出吞吐线性折算，不是生产容量','不含加载、空闲、网络、存储、税费，不作实际账单承诺']}
        run.artifact('token-cost-estimate',json.dumps(payload,ensure_ascii=False,indent=2),'application/json')
        return run.success('已根据保存的测试结果与用户费率生成成本估算，未运行GPU。',{'cost_projection':payload})
