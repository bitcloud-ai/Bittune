import { canonicalJson, sha256 } from "./identifiers.ts";
import type { ExperimentWorkload } from "./state-store.ts";

export const BENCHMARK_WORKLOAD_SCHEMA_VERSION = 1;
export const EVALSCOPE_ARGV_PROFILE_VERSION = "evalscope-perf-openai-random-v1";
export const METRIC_NORMALIZER_VERSION = "evalscope-normalizer-v2";

export interface MaterializedBenchmarkWorkload {
  schema_version: 1;
  provider: { name: "evalscope"; version: string };
  argv_profile_version: string;
  mode: "closed_loop" | "open_loop";
  concurrency: number;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  request_rate?: number;
  request_timeout_seconds: number;
  request_source: { kind: "random"; seed: "provider-uncontrolled" };
  tokenizer: { model_id: string; chat_template: string };
  generation: { stream: boolean; ignore_eos: boolean };
  warmup: { requests: number; timeout_seconds: number };
}

export interface BenchmarkWorkloadInput extends ExperimentWorkload {
  workload_schema_version?: 1;
  provider_version?: string;
  argv_profile_version?: string;
  tokenizer_model_id?: string;
  chat_template?: string;
  stream?: boolean;
  ignore_eos?: boolean;
  warmup_requests?: number;
  warmup_timeout_seconds?: number;
}

export function materializeBenchmarkWorkload(input: BenchmarkWorkloadInput, modelId: string, providerVersion?: string): MaterializedBenchmarkWorkload {
  return {
    schema_version: BENCHMARK_WORKLOAD_SCHEMA_VERSION,
    provider: { name: "evalscope", version: providerVersion ?? input.provider_version ?? "unknown" },
    argv_profile_version: input.argv_profile_version ?? EVALSCOPE_ARGV_PROFILE_VERSION,
    mode: input.mode,
    concurrency: input.concurrency,
    request_count: input.request_count,
    input_tokens: input.input_tokens,
    output_tokens: input.output_tokens,
    ...(input.request_rate !== undefined ? { request_rate: input.request_rate } : {}),
    request_timeout_seconds: input.request_timeout_seconds ?? 600,
    request_source: { kind: "random", seed: "provider-uncontrolled" },
    tokenizer: { model_id: input.tokenizer_model_id ?? modelId, chat_template: input.chat_template ?? "provider-default" },
    generation: { stream: input.stream ?? true, ignore_eos: input.ignore_eos ?? true },
    warmup: { requests: input.warmup_requests ?? 0, timeout_seconds: input.warmup_timeout_seconds ?? input.request_timeout_seconds ?? 600 },
  };
}

export function workloadFingerprint(workload: MaterializedBenchmarkWorkload): string {
  return sha256(canonicalJson(workload));
}

export function isMaterializedBenchmarkWorkload(value: unknown): value is MaterializedBenchmarkWorkload {
  return Boolean(value && typeof value === "object" && (value as { schema_version?: unknown }).schema_version === BENCHMARK_WORKLOAD_SCHEMA_VERSION && (value as { provider?: { name?: unknown } }).provider?.name === "evalscope");
}
