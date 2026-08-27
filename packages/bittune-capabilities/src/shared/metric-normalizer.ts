import { METRIC_NORMALIZER_VERSION } from "./benchmark-workload.ts";

export interface MetricStatistics { sample_count: number; mean: number; p50: number; p95: number; standard_deviation: number; }
export interface NormalizedMetrics {
  normalizer_version: string;
  metrics: Record<string, number | string | boolean | null>;
  distributions: Partial<Record<"ttft_ms" | "e2e_latency_ms" | "tpot_ms" | "itl_ms", MetricStatistics>>;
  request_samples_available: boolean;
}

type MetricMap = Record<string, number | string | boolean | null>;

function numberValue(value: number | string | boolean | null | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function unitAdjustedMilliseconds(key: string, value: number): number {
  return /(?:\(|_|\b)ms(?:\)|_|\b)/i.test(key) ? value : /(?:\(|_|\b)s(?:\)|_|\b)/i.test(key) ? value * 1000 : value;
}

function scalarMetrics(value: unknown, prefix = "", output: MetricMap = {}): MetricMap {
  if (Array.isArray(value)) return output;
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value as Record<string, unknown>)) scalarMetrics(child, prefix ? `${prefix}.${key}` : key, output);
  else if (["number", "string", "boolean"].includes(typeof value) || value === null) {
    const normalized = prefix.toLowerCase();
    if (/(ttft|tpot|itl|throughput|rps|tps|success|latency|e2e|request|token)/.test(normalized)) output[prefix] = value as number | string | boolean | null;
  }
  return output;
}

function normalizedScalars(raw: MetricMap): MetricMap {
  const aliases: Array<[string, RegExp]> = [
    ["success_rate", /success.*rate|success_rate/], ["requests_per_second", /(^|\.)rps$|request.*per.*second/],
    ["output_tokens_per_second", /(^|\.)tps$|output.*token.*per.*second|throughput/], ["mean_e2e_latency_ms", /avg.*(latency|e2e)|mean.*(latency|e2e)/],
    ["mean_ttft_ms", /avg.*ttft|mean.*ttft/], ["mean_tpot_ms", /avg.*tpot|mean.*tpot/], ["mean_itl_ms", /avg.*itl|mean.*itl/],
  ];
  const output: MetricMap = { ...raw };
  for (const [target, expression] of aliases) {
    const entry = Object.entries(raw).find(([key]) => expression.test(key.toLowerCase()));
    if (entry) output[target] = entry[1];
  }
  const entries = Object.entries(raw);
  const firstNumber = (expression: RegExp): [string, number] | undefined => {
    const entry = entries.find(([key, value]) => expression.test(key.toLowerCase()) && numberValue(value) !== undefined);
    const value = entry ? numberValue(entry[1]) : undefined;
    return entry && value !== undefined ? [entry[0], value] : undefined;
  };

  // EvalScope 1.10.0 emits presentation labels such as "Req Throughput (req/s)"
  // and "Avg Latency (s)" rather than the JSON-style names used by older releases.
  const successRequests = firstNumber(/(?:^|\.)success(?:ful)?\s*requests?$/);
  const failedRequests = firstNumber(/(?:^|\.)failed\s*requests?$/);
  const totalRequests = firstNumber(/(?:^|\.)(?:total|all)\s*requests?$/);
  if (output.success_rate === undefined && successRequests) {
    const total = totalRequests?.[1] ?? (failedRequests ? successRequests[1] + failedRequests[1] : undefined);
    if (total && total > 0) output.success_rate = successRequests[1] / total;
  }

  const reqThroughput = firstNumber(/(?:^|\.)(?:req|request)\s+throughput(?:\s*\([^)]*req\s*\/\s*s[^)]*\))?$/);
  if (reqThroughput) output.requests_per_second = reqThroughput[1];
  const outputThroughput = firstNumber(/(?:^|\.)(?:output\s+)?(?:token|tok)\s+throughput|(?:^|\.)output\s+throughput/);
  if (outputThroughput) output.output_tokens_per_second = outputThroughput[1];

  const latency = firstNumber(/(?:^|\.)(?:avg|average|mean)\s+(?:e2e\s+)?latency/);
  if (latency) output.mean_e2e_latency_ms = unitAdjustedMilliseconds(latency[0], latency[1]);
  const ttft = firstNumber(/(?:^|\.)(?:avg|average|mean)\s+(?:ttft|time\s+to\s+first\s+token)/);
  if (ttft) output.mean_ttft_ms = unitAdjustedMilliseconds(ttft[0], ttft[1]);
  const tpot = firstNumber(/(?:^|\.)(?:avg|average|mean)\s+tpot/);
  if (tpot) output.mean_tpot_ms = unitAdjustedMilliseconds(tpot[0], tpot[1]);
  const itl = firstNumber(/(?:^|\.)(?:avg|average|mean)\s+itl/);
  if (itl) output.mean_itl_ms = unitAdjustedMilliseconds(itl[0], itl[1]);
  return output;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position); const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function statistics(values: number[]): MetricStatistics | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { sample_count: values.length, mean, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), standard_deviation: Math.sqrt(variance) };
}

function metricName(key: string): "ttft_ms" | "e2e_latency_ms" | "tpot_ms" | "itl_ms" | undefined {
  const name = key.toLowerCase();
  if (/(^|[_\.])ttft([_\.]|$)/.test(name) || name.includes("time_to_first")) return "ttft_ms";
  if (/(^|[_\.])tpot([_\.]|$)/.test(name)) return "tpot_ms";
  if (/(^|[_\.])itl([_\.]|$)/.test(name)) return "itl_ms";
  if (name.includes("e2e") || name.includes("latency")) return "e2e_latency_ms";
  return undefined;
}

function collectSamples(value: unknown, output: Partial<Record<"ttft_ms" | "e2e_latency_ms" | "tpot_ms" | "itl_ms", number[]>> = {}): typeof output {
  if (Array.isArray(value)) {
    for (const item of value) collectSamples(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const name = metricName(key);
    if (name && Array.isArray(child)) {
      const values = child.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
      if (values.length) output[name] = [...(output[name] ?? []), ...values];
    }
    collectSamples(child, output);
  }
  return output;
}

export function normalizeEvalscopeReports(reports: unknown[]): NormalizedMetrics {
  const raw = reports.reduce<MetricMap>((all, report) => scalarMetrics(report, "", all), {});
  const samples = reports.reduce<Partial<Record<"ttft_ms" | "e2e_latency_ms" | "tpot_ms" | "itl_ms", number[]>>>((all, report) => collectSamples(report, all), {});
  const distributions = Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, statistics(values!)]).filter(([, value]) => value !== undefined)) as NormalizedMetrics["distributions"];
  const metrics = normalizedScalars(raw);
  for (const [key, value] of Object.entries(distributions)) {
    metrics[`mean_${key}`] = value.mean;
    metrics[`p50_${key}`] = value.p50;
    metrics[`p95_${key}`] = value.p95;
    metrics[`${key}_sample_count`] = value.sample_count;
    metrics[`${key}_standard_deviation`] = value.standard_deviation;
  }
  return { normalizer_version: METRIC_NORMALIZER_VERSION, metrics, distributions, request_samples_available: Object.keys(distributions).length > 0 };
}
