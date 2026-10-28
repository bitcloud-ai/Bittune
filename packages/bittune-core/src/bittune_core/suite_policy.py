"""Small deterministic adapter for v2 confirmation/stop decisions, no executor."""

def decide(previous, row, acceptance):
    if row.get('measurement', {}).get('request_slo_status') != 'complete':
        return 'stop', 'request_slo_observation_unavailable'
    status = row['slo']['status']
    if status == 'passed':
        return 'continue', 'within_declared_slo'
    if status == 'unavailable':
        return 'stop', 'slo_observation_unavailable'
    last = previous[-1] if previous else None
    if last:
        old, new = last.get('metrics', {}).get('requests_per_second'), row['metrics'].get('requests_per_second')
        success_failed = row['metrics'].get('success_rate', 1) < acceptance['success_rate_min']
        drop = old is not None and new is not None and old > 0 and new < old * (1-acceptance['stop_policy']['throughput_drop_ratio'])
        if success_failed and drop:
            return 'stop', 'error_rate_and_throughput_drop'
        if last['concurrency'] == row['concurrency'] and last.get('slo', {}).get('status') == 'failed':
            return 'stop', 'confirmed_slo_failure'
    return 'confirm', 'one_bounded_confirmation'
