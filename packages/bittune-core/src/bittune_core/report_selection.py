"""Small selectors over stored facts; rendering remains in reports.py."""
import copy
from collections import Counter
from bittune_core.contracts import ContractError, SUITE_CLAIM_METRICS, sha256_canonical

CLAIM_FIELDS = {
    'metric_claims': ('benchmark_result_id', 'metric', 'label'),
    'suite_claims': ('suite_result_id', 'scenario_id', 'concurrency', 'repeat', 'metric', 'label'),
    'pd_claims': ('pd_estimate_id', 'metric', 'label'),
}

def prepare_report(params, store, row_claimable):
    params = copy.deepcopy(params)
    coverage = {'version': 'report-coverage-v1', 'mode': 'explicit_subset', 'suites': []}
    base = params.get('based_on_report_id')
    selections = params.get('suite_selections')
    if base is not None:
        if not isinstance(base, str) or not base:
            raise ContractError('invalid_input', 'based_on_report_id需要已有报告ID。')
        if any(key in params for key in (*CLAIM_FIELDS, 'references', 'suite_selections')):
            raise ContractError('report_coverage_mismatch', '继承报告禁止覆盖引用数组；只修改标题/范围/叙述/结论。')
        fact = store.get_fact('report', base)
        source = fact['payload']
        for key in ('title', 'scope', 'narrative', 'conclusion'):
            params.setdefault(key, source.get(key, ''))
        params['references'] = {key: [entry['id'] for entry in entries] for key, entries in source['references'].items()}
        for key, fields in CLAIM_FIELDS.items():
            params[key] = [{k: claim[k] for k in fields if k in claim} for claim in source.get(key, [])]
        coverage = copy.deepcopy(source.get('coverage') or coverage)
        for key in ('metric_claims', 'suite_claims'):
            recorded = coverage.get(key + '_count')
            if recorded is not None and recorded != len(params[key]):
                raise ContractError('report_coverage_mismatch', '原报告覆盖元数据与实际引用数量不符。')
        coverage.update(mode='copied_report', source_report_id=base, source_content_hash=fact['content_hash'])
    elif selections is not None:
        if not isinstance(selections, list) or not selections or 'suite_claims' in params:
            raise ContractError('invalid_input', 'suite_selections需要非空数组，且不能同时手写suite_claims。')
        coverage['mode'] = 'all_suite_rows'
        params['suite_claims'] = []
        refs = params.setdefault('references', {})
        ids = refs.setdefault('suite_result_ids', [])
        seen = set()
        for selection in selections:
            if not isinstance(selection, dict) or set(selection) != {'suite_result_id', 'metrics'}:
                raise ContractError('invalid_input', '扫描选择只接受suite_result_id和metrics。')
            sid, metrics = selection['suite_result_id'], selection['metrics']
            if not isinstance(sid, str) or sid in seen or not isinstance(metrics, list) or not metrics or any(not isinstance(m,str) or m not in SUITE_CLAIM_METRICS for m in metrics) or len(metrics)!=len(set(metrics)):
                raise ContractError('invalid_input', '扫描/指标选择重复、为空或不受支持。')
            seen.add(sid)
            fact = store.get_fact('suite_result', sid)
            suite = fact['payload']
            if sid not in ids: ids.append(sid)
            rows = []
            keys = set()
            for row in suite.get('rows') or []:
                key = (row['scenario_id'], row['concurrency'], row.get('repeat', 1))
                if key in keys:
                    raise ContractError('report_coverage_mismatch', '扫描行身份重复，无法唯一引用。')
                keys.add(key)
                identity = dict(suite_result_id=sid, scenario_id=key[0], concurrency=key[1], repeat=key[2])
                status = {**identity, 'state': row.get('state'), 'measurement_status': row.get('measurement_status'),
                          'slo_status': row.get('slo_status'), 'decision': row.get('decision'), 'unavailable': {}}
                if row.get('state') not in ('healthy', 'measured') or not row_claimable(store, suite, row):
                    status['reason'] = row.get('reason_code') or 'not_claimable'
                    status['numeric_claims'] = 0
                    rows.append(status)
                    continue
                before = len(params['suite_claims'])
                for metric in metrics:
                    value = row.get('goodput_req_per_s') if metric == 'goodput_req_per_s' else (row.get('metrics') or {}).get(metric)
                    if value is None:
                        reason = ((row.get('measurement') or {}).get('unavailable_reasons') or {}).get(metric)
                        if not reason:
                            raise ContractError('report_coverage_mismatch', '被选指标缺少数值和不可用来源。', {'metric': metric, **identity})
                        status['unavailable'][metric] = reason
                    else:
                        params['suite_claims'].append({**identity, 'metric': metric})
                status['numeric_claims'] = len(params['suite_claims'])-before
                rows.append(status)
            coverage['suites'].append({'suite_result_id': sid, 'source_content_hash': fact['content_hash'], 'metrics': metrics,
                'row_count':len(rows), 'numeric_claims':sum(r['numeric_claims'] for r in rows),
                'unavailable_metrics':sum(len(r['unavailable']) for r in rows),
                'state_counts':dict(Counter(r['state'] for r in rows)),
                'slo_status_counts':dict(Counter(r['slo_status'] or 'not_recorded' for r in rows)), 'rows': rows})
    for key in CLAIM_FIELDS:
        claims = params.get(key) or []
        coverage[key + '_count'] = len(claims)
        coverage[key + '_identity_hash'] = sha256_canonical([{k:v for k,v in c.items() if k!='label'} for c in claims])
    return params, coverage

def verify_rendered(coverage, rendered):
    for key, claims in rendered.items():
        identities = [{k:v for k,v in c.items() if k in CLAIM_FIELDS[key] and k!='label'} for c in claims]
        if len(claims) != coverage[key+'_count'] or sha256_canonical(identities) != coverage[key+'_identity_hash']:
            raise ContractError('report_coverage_mismatch', '渲染引用与请求覆盖不符，未生成报告。', {'claim_type':key})

def coverage_markdown(coverage):
    lines = ['\n## 引用覆盖\n', f"模式：{coverage['mode']}；单点引用 {coverage['metric_claims_count']}，扫描引用 {coverage['suite_claims_count']}。"]
    if coverage['mode']=='explicit_subset': lines.append('手写引用是显式子集，不宣称覆盖整个扫描。')
    if coverage.get('source_report_id'): lines.append(f"保留原报告 `{coverage['source_report_id']}` 的全部结构化引用；不根据叙述推定覆盖范围。")
    for suite in coverage['suites']:
        lines.append(f"\n扫描 `{suite['suite_result_id']}`：覆盖 {len(suite['rows'])} 行（含未测/不可用状态）。")
        for row in suite['rows']:
            lines.append(f"- {row['scenario_id']} c={row['concurrency']} repeat={row['repeat']}：{row['state']}；聚合SLO {row['slo_status']}；决定 {row['decision']}；数值引用 {row['numeric_claims']}；不可用 {row['unavailable']}" + (f"；原因 {row['reason']}" if row.get('reason') else ''))
    return '\n'.join(lines)+'\n'
