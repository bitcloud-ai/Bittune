"""Versioned measurement semantics over existing provider observations, never a runner."""
import json
import math
from importlib import resources
from typing import Any

import jsonschema
from bittune_core.metric_stats import _statistics

CONTRACT = json.loads((resources.files('bittune_core') / 'data/measurement-contract.json').read_text())
METRIC_NAMES = tuple(CONTRACT['metrics'])
VERSION = CONTRACT['version']


def validate_acceptance(value):
    from bittune_core.contracts import ContractError
    schema = json.loads((resources.files('bittune_core') / 'data/schemas/acceptance-profile.schema.json').read_text())
    def finite(item):
        if isinstance(item, dict): return all(finite(v) for v in item.values())
        if isinstance(item, list): return all(finite(v) for v in item)
        return not isinstance(item, (int, float)) or isinstance(item, bool) or math.isfinite(item)
    if not finite(value):
        raise ContractError('invalid_profile', '接受条件必须是有限数字。')
    try:
        jsonschema.validate(value, schema)
    except (jsonschema.ValidationError, jsonschema.SchemaError) as error:
        raise ContractError('invalid_profile', '接受条件不符合版本化schema。', {'reason': error.message}) from None
    return value


def input_digest(text):
    """Hash only actual input, not responses, credentials, model or sampling values."""
    from bittune_core.contracts import sha256_canonical
    try:
        body = json.loads(text)
        prompt = body.get('prompt')
        if not isinstance(prompt, list) or not prompt or any(type(x) is not int or x < 0 for x in prompt):
            return None
        return sha256_canonical({'format': 'token_ids', 'prompt': prompt})
    except (ValueError, TypeError, AttributeError):
        return None


def cache_context(service):
    spec, args = service.get('serving_spec') or {}, service.get('engine_args') or []
    runtime = (service.get('runtime_spec') or {}).get('runtime_kind')
    proof_ids = all(isinstance(service.get(k), str) and service[k] for k in ('service_instance_id','plan_id','config_hash'))
    controlled = proof_ids and service.get('binding') != 'declared' and service.get('ownership') == 'managed' and (
        (runtime == 'vllm' and spec.get('enable_prefix_caching') is False and '--no-enable-prefix-caching' in args) or
        (runtime == 'sglang' and spec.get('disable_radix_cache') is True and '--disable-radix-cache' in args))
    return {'mode': 'disabled' if controlled else 'uncontrolled',
            'proof': {'service_instance_id': service.get('service_instance_id'), 'plan_id': service.get('plan_id'),
                      'config_hash': service.get('config_hash')} if controlled else None,
            'reason': None if controlled else 'No managed negative-cache CLI proof; no fair-comparison claim'}


def _under(value, limit, mode):
    return (math.floor(value) if mode == 'floor_ms' else value) <= limit


def request_slo(record, acceptance):
    if not acceptance or acceptance.get('schema_version') != 2:
        return None
    if not record['success']:
        return False
    values = {'e2e': record['latency'] * 1000 if record['latency'] is not None else None}
    if record['is_stream']:
        values.update(ttft=record['first_chunk_latency'] * 1000 if record['first_chunk_latency'] is not None else None,
                      tpot=record['time_per_output_token'] * 1000 if record['time_per_output_token'] is not None and (record['completion_tokens'] or 0) > 1 else None,
                      itl=max(record['inter_token_latencies']) * 1000 if record['inter_token_latencies'] else None)
    verdicts = []
    for name, threshold in acceptance['request_limits_ms'].items():
        value = values.get(name)
        if value is None:
            return None
        verdicts.append(_under(value, threshold, acceptance['latency_comparison']))
    return all(verdicts)


def judge(metrics, acceptance):
    if not acceptance or acceptance.get('schema_version') != 2:
        return {'version': 'request-slo-v2', 'status': 'not_configured', 'passed': None, 'checks': {}}
    names = {'ttft': 'p99_ttft_ms', 'tpot': 'p99_tpot_ms', 'itl': 'p99_itl_ms', 'e2e': 'p99_e2e_latency_ms'}
    success = metrics.get('success_rate')
    checks = {'success_rate': success >= acceptance['success_rate_min'] if success is not None else None}
    for name, threshold in acceptance['p99_limits_ms'].items():
        value = metrics.get(names[name])
        checks[names[name]] = _under(value, threshold, acceptance['latency_comparison']) if value is not None else None
    passed = None if None in checks.values() else all(checks.values())
    return {'version': 'request-slo-v2', 'status': 'unavailable' if passed is None else ('passed' if passed else 'failed'),
            'passed': passed, 'checks': checks, 'latency_comparison': acceptance['latency_comparison']}


class MeasurementBuilder:
    def __init__(self, acceptance=None):
        self.acceptance = validate_acceptance(acceptance) if acceptance is not None else None
        self.total = self.success = self.failed = self.passed = self.unknown_slo = self.passed_tokens = 0
        self.passed_tokens_unknown = False
        self.starts, self.ends, self.inputs, self.outputs, self.hashes = [], [], [], [], []
        self.window_missing = self.input_missing = False

    def observe(self, record, request_text):
        self.total += 1
        digest = input_digest(request_text)
        record['input_sha256'] = digest
        if digest is None:
            self.input_missing = True
        else:
            self.hashes.append(digest)
        a, b = record['start_time'], record['completed_time']
        if a is None or b is None or b < a:
            self.window_missing = True
        else:
            self.starts.append(a); self.ends.append(b)
        if record['success']:
            self.success += 1
            self.inputs.append(record['prompt_tokens']); self.outputs.append(record['completion_tokens'])
        else:
            self.failed += 1
        verdict = request_slo(record, self.acceptance)
        record['slo_passed'] = verdict
        self.passed += verdict is True
        if verdict is True:
            if record["completion_tokens"] is None: self.passed_tokens_unknown = True
            else: self.passed_tokens += record["completion_tokens"]
        self.unknown_slo += verdict is None

    def finish(self, samples, evidence_status):
        from bittune_core.contracts import sha256_canonical
        values = {name: None for name in METRIC_NAMES}
        reasons, sources = {}, {}
        def put(name, value, source='evalscope_sqlite.result'):
            values[name] = value
            if value is not None: sources[name] = source
        for name, value in (('total_requests', self.total), ('success_requests', self.success), ('failed_requests', self.failed),
                            ('timeout_requests', 0 if self.failed == 0 else None), ('unknown_failure_requests', self.failed)):
            put(name, value if evidence_status != 'absent' else None)
        duration = None if self.window_missing or not self.starts else max(self.ends) - min(self.starts)
        if duration is not None and duration <= 0:
            duration = None
        put('duration_seconds', duration, 'max(completed_time)-min(start_time), excludes warmup/connectivity')
        put('success_rate', self.success / self.total if self.total else None)
        put('error_rate', self.failed / self.total if self.total else None)
        for side, observed in (('input', self.inputs), ('output', self.outputs)):
            if observed and all(value is not None for value in observed):
                stats = _statistics(observed)
                put(f'{side}_tokens_total', sum(observed))
                for q in ('mean', 'p50', 'p90', 'p95', 'p99'):
                    put(f'{side}_tokens_{q}', stats[q])
        if values['input_tokens_total'] is not None and values['output_tokens_total'] is not None:
            put('total_tokens', values['input_tokens_total'] + values['output_tokens_total'])
        if duration:
            for name, numerator in (('requests_per_second', self.success), ('input_tokens_per_second', values['input_tokens_total']),
                                    ('output_tokens_per_second', values['output_tokens_total']), ('total_tokens_per_second', values['total_tokens'])):
                put(name, numerator / duration if numerator is not None else None, 'successful count/tokens divided by observed duration')
        for name in ('e2e_latency_ms', 'ttft_ms', 'tpot_ms', 'itl_ms'):
            stats = _statistics(samples.get(name, []))
            if stats:
                for q in ('mean', 'p50', 'p90', 'p95', 'p99'):
                    put(f'{q}_{name}', stats[q], 'provider request/chunk observations; linear_n_minus_1_v1')
                put(f'{name}_sample_count', stats['sample_count'])
                put(f'{name}_standard_deviation', stats['standard_deviation'])
        policy = self.acceptance if self.acceptance and self.acceptance.get('schema_version') == 2 else None
        if policy and not self.unknown_slo and duration:
            put('slo_passed_requests', self.passed)
            put('goodput_req_per_s', self.passed / duration, 'request_slo_pass_count/observed duration')
            if not self.passed_tokens_unknown:
                put('goodput_output_tokens_per_second', self.passed_tokens / duration, 'SLO-passed actual output tokens/observed duration')
        for name, value in values.items():
            if value is None:
                reasons[name] = ('provider does not classify failed requests' if name == 'timeout_requests' else
                                 'request SLO absent or required observation unavailable' if name in ('goodput_req_per_s', 'goodput_output_tokens_per_second', 'slo_passed_requests') else
                                 'not observed or not applicable; no zero imputation')
        identity = None if self.input_missing or not self.hashes else sha256_canonical(sorted(self.hashes))
        complete = evidence_status == 'complete' and duration is not None and values['input_tokens_total'] is not None and values['output_tokens_total'] is not None
        result = {'contract_version': VERSION, 'status': 'complete' if complete else 'invalid',
                  'metrics': values, 'metric_sources': sources, 'unavailable_reasons': reasons, 'unavailable_fields': sorted(reasons),
                  'percentile_algorithm': CONTRACT['percentile_algorithm'], 'token_scope': CONTRACT['token_scope'],
                  'dataset_input_sha256': identity, 'dataset_hash_method': 'unordered_multiset_sha256_v1',
                  'request_slo_status': 'complete' if policy and not self.unknown_slo else ('unavailable' if policy else 'not_configured'),
                  'input_order': 'not_recorded', 'cache_policy': {'mode':'uncontrolled','proof':None,'reason':'not recorded'}, 'acceptance': self.acceptance, 'slo': judge(values, self.acceptance)}
        validate_measurement(result)
        return result


def measurement_schema():
    nullable_number = {'type': ['number', 'null'], 'minimum': 0}
    maps = {'type':'object','additionalProperties':False,'properties':{name:{'type':'string'} for name in METRIC_NAMES}}
    acceptance = json.loads((resources.files('bittune_core')/'data/schemas/acceptance-profile.schema.json').read_text())
    properties = {
        'contract_version': {'const': VERSION}, 'status': {'enum':['complete','invalid']},
        'metrics': {'type':'object','additionalProperties':False,'required':list(METRIC_NAMES),
                    'properties':{name:({'type':['integer','null'],'minimum':0} if name.endswith('_requests') or name.endswith('_sample_count') or name in ('input_tokens_total','output_tokens_total','total_tokens') else {**nullable_number,**({'maximum':1} if name in ('success_rate','error_rate') else {})}) for name in METRIC_NAMES}},
        'metric_sources':maps, 'unavailable_reasons':maps,
        'unavailable_fields':{'type':'array','uniqueItems':True,'items':{'enum':list(METRIC_NAMES)}},
        'percentile_algorithm':{'const':CONTRACT['percentile_algorithm']},'token_scope':{'const':CONTRACT['token_scope']},
        'dataset_input_sha256':{'type':['string','null'],'pattern':'^sha256:[a-f0-9]{64}$'},
        'dataset_hash_method':{'const':'unordered_multiset_sha256_v1'},'input_order':{'const':'not_recorded'},
        'request_slo_status':{'enum':['complete','unavailable','not_configured']},
        'acceptance':{'anyOf':[{'type':'null'},*acceptance['anyOf']]},
        'cache_policy':{'type':'object','additionalProperties':False,'required':['mode','proof','reason'],
                        'properties':{'mode':{'enum':['disabled','uncontrolled']},'proof':{'type':['object','null']},'reason':{'type':['string','null']}}},
        'slo':{'type':'object','additionalProperties':False,'required':['version','status','passed','checks'],
               'properties':{'version':{'const':'request-slo-v2'},'status':{'enum':['passed','failed','unavailable','not_configured']},
                             'passed':{'type':['boolean','null']},'checks':{'type':'object','additionalProperties':{'type':['boolean','null']}},
                             'latency_comparison':{'enum':['raw_ms','floor_ms']}}}}
    return {'type':'object','additionalProperties':False,'required':list(properties),'properties':properties}


def validate_measurement(value):
    jsonschema.validate(value, measurement_schema())
    if set(value['unavailable_fields']) != {name for name, number in value['metrics'].items() if number is None}:
        raise ValueError('Unavailable field list does not match null metrics')
    for name, number in value['metrics'].items():
        if number is None:
            if name not in value['unavailable_reasons']:
                raise ValueError(f'Missing unavailable reason: {name}')
        elif not math.isfinite(number) or name not in value['metric_sources']:
            raise ValueError(f'Nonfinite or missing source: {name}')
