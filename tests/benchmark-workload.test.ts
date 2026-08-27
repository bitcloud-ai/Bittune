import assert from "node:assert/strict";
import test from "node:test";
import { materializeBenchmarkWorkload, workloadFingerprint } from "../packages/bittune-capabilities/src/shared/benchmark-workload.ts";
import { normalizeEvalscopeReports } from "../packages/bittune-capabilities/src/shared/metric-normalizer.ts";
import { ACTIVE_OPTIMIZATION_CONTEXT_SESSION_ENTRY, activeOptimizationContextIdFromSessionEntries } from "../packages/bittune-capabilities/src/shared/optimization-context.ts";

const input = {
  mode: "closed_loop" as const,
  concurrency: 4,
  request_count: 20,
  input_tokens: 128,
  output_tokens: 64,
  workload_schema_version: 1 as const,
  provider_version: "0.5.0",
  random_seed: 7,
  tokenizer_model_id: "acme/model",
  chat_template: "chatml",
  stream: true,
  ignore_eos: true,
  warmup_requests: 2,
};

test("materialized Benchmark workload fingerprints every comparability input", () => {
  const baseline = materializeBenchmarkWorkload(input, "acme/model");
  const baselineFingerprint = workloadFingerprint(baseline);
  assert.equal(workloadFingerprint(materializeBenchmarkWorkload({ ...input, random_seed: 8 }, "acme/model")), baselineFingerprint);
  assert.notEqual(workloadFingerprint(materializeBenchmarkWorkload({ ...input, tokenizer_model_id: "acme/other" }, "acme/model")), baselineFingerprint);
  assert.notEqual(workloadFingerprint(materializeBenchmarkWorkload({ ...input, chat_template: "llama3" }, "acme/model")), baselineFingerprint);
  assert.notEqual(workloadFingerprint(materializeBenchmarkWorkload({ ...input, ignore_eos: false }, "acme/model")), baselineFingerprint);
  assert.notEqual(workloadFingerprint(materializeBenchmarkWorkload({ ...input, provider_version: "0.5.1" }, "acme/model")), baselineFingerprint);
});

test("EvalScope normalizer calculates latency distributions from request samples", () => {
  const normalized = normalizeEvalscopeReports([{
    summary: { success_rate: 1, requests_per_second: 12, output_tokens_per_second: 768 },
    request_metrics: { ttft_ms: [10, 20, 30], e2e_latency_ms: [100, 200, 300], tpot_ms: [2, 4, 6], itl_ms: [1, 3, 5] },
  }]);
  assert.equal(normalized.request_samples_available, true);
  assert.deepEqual(normalized.distributions.ttft_ms, { sample_count: 3, mean: 20, p50: 20, p95: 29, standard_deviation: Math.sqrt(200 / 3) });
  assert.equal(normalized.metrics.p95_e2e_latency_ms, 290);
  assert.equal(normalized.metrics.itl_ms_sample_count, 3);
});

test("EvalScope 1.10 presentation metrics normalize into comparable scalars", () => {
  const normalized = normalizeEvalscopeReports([{
    "Total Requests": 3,
    "Success Requests": 3,
    "Failed Requests": 0,
    "Req Throughput (req/s)": 12.7663,
    "Output Throughput (tok/s)": 204.2607,
    "Avg Latency (s)": 0.0782,
    "Avg TTFT (ms)": 21.25,
    "Avg TPOT (ms)": 3.79,
    "Avg ITL (ms)": 3.56,
  }]);
  assert.equal(normalized.metrics.success_rate, 1);
  assert.equal(normalized.metrics.requests_per_second, 12.7663);
  assert.equal(normalized.metrics.output_tokens_per_second, 204.2607);
  assert.equal(normalized.metrics.mean_e2e_latency_ms, 78.2);
  assert.equal(normalized.metrics.mean_ttft_ms, 21.25);
  assert.equal(normalized.metrics.mean_tpot_ms, 3.79);
  assert.equal(normalized.metrics.mean_itl_ms, 3.56);
});

test("active optimization context restores from the latest custom Session entry", () => {
  const entries = [
    { type: "custom", customType: ACTIVE_OPTIMIZATION_CONTEXT_SESSION_ENTRY, data: { context_id: "first-context" } },
    { type: "custom", customType: "unrelated", data: {} },
    { type: "custom", customType: ACTIVE_OPTIMIZATION_CONTEXT_SESSION_ENTRY, data: { context_id: "latest-context" } },
  ];
  assert.equal(activeOptimizationContextIdFromSessionEntries(entries), "latest-context");
});
