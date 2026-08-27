import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { BittuneError } from "../../shared/errors.ts";
import { METRIC_NORMALIZER_VERSION, materializeBenchmarkWorkload, workloadFingerprint, type BenchmarkWorkloadInput } from "../../shared/benchmark-workload.ts";
import { normalizeEvalscopeReports } from "../../shared/metric-normalizer.ts";
import { requireSuccess, runCommand } from "../../shared/process.ts";
import { RunRecorder } from "../../shared/run-recorder.ts";
import { createBittuneTool } from "../../shared/tool.ts";
import { advanceManagedAttempt, failAndCleanManagedAttempt, requireManagedAttempt } from "../../shared/optimization-attempt.ts";

const Id = Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" });
const RunId = Type.String({ pattern: "^run-[a-f0-9-]{36}$" });
const ArtifactId = Type.String({ pattern: "^artifact-[a-f0-9-]{36}$" });

async function findJsonFiles(directory: string, limit = 24): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => entry.isDirectory() ? findJsonFiles(join(directory, entry.name), limit) : entry.name.endsWith(".json") ? [join(directory, entry.name)] : []));
    return nested.flat().slice(0, limit);
  } catch { return []; }
}

async function sampleGpuMemory(selectedGpuIds: readonly number[], signal?: AbortSignal): Promise<number | undefined> {
  try {
    const result = await runCommand("nvidia-smi", ["--query-gpu=index,memory.used", "--format=csv,noheader,nounits"], { signal, timeoutMs: 5_000 });
    if (result.exit_code !== 0) return undefined;
    const selected = new Set(selectedGpuIds);
    const values = result.stdout.split(/\r?\n/).flatMap((line) => {
      const [index, memory] = line.split(",").map((value) => Number(value.trim()));
      return Number.isFinite(index) && Number.isFinite(memory) && (!selected.size || selected.has(index)) ? [memory] : [];
    });
    return values.length ? Math.max(...values) * 1024 * 1024 : undefined;
  } catch { return undefined; }
}

async function collectEvalscopeMetrics(outputDir: string): Promise<{ reports: unknown[]; files: Array<{ name: string; content: string }> }> {
  const files = await findJsonFiles(outputDir);
  const parsed = await Promise.all(files.map(async (path) => ({ path, content: await readFile(path, "utf8").catch(() => "") })));
  const reports = parsed.flatMap((file) => { try { return [JSON.parse(file.content) as unknown]; } catch { return []; } });
  return { reports, files: parsed.map((item) => ({ name: item.path.slice(outputDir.length + 1), content: item.content })).filter((item) => item.content.length > 0) };
}

async function runWarmup(service: { endpoint_url: string; model_id: string }, workload: ReturnType<typeof materializeBenchmarkWorkload>, signal: AbortSignal | undefined): Promise<{ completed: number; failures: string[] }> {
  const failures: string[] = [];
  for (let index = 0; index < workload.warmup.requests; index += 1) {
    const timeout = AbortSignal.timeout(workload.warmup.timeout_seconds * 1000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(`${service.endpoint_url}/v1/chat/completions`, { method: "POST", signal: requestSignal, headers: { "content-type": "application/json" }, body: JSON.stringify({ model: service.model_id, messages: [{ role: "user", content: "Warm up." }], max_tokens: 1, temperature: 0, stream: workload.generation.stream }) });
      if (!response.ok) failures.push(`warmup_${index + 1}: HTTP ${response.status}`);
      else await response.arrayBuffer();
    } catch (error) {
      failures.push(`warmup_${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { completed: workload.warmup.requests - failures.length, failures };
}

function validateExecutableWorkload(input: BenchmarkWorkloadInput, modelId: string): void {
  if (input.tokenizer_model_id !== undefined && input.tokenizer_model_id !== modelId) throw new BittuneError("benchmark_workload_unsupported", "The fixed EvalScope argv profile only supports the managed model tokenizer.", false);
  if (input.chat_template !== undefined && input.chat_template !== "provider-default") throw new BittuneError("benchmark_workload_unsupported", "The fixed EvalScope random workload only supports the provider-default chat template.", false);
}

export function createBenchmarkTools(recorder: RunRecorder) {
  return [
    createBittuneTool({
      name: "run_performance_test", label: "运行性能压测", recorder,
      parameters: Type.Object({
        instance_id: Id,
        mode: Type.Union([Type.Literal("closed_loop"), Type.Literal("open_loop")]),
        concurrency: Type.Integer({ minimum: 1 }),
        request_count: Type.Integer({ minimum: 1 }),
        input_tokens: Type.Integer({ minimum: 1 }),
        output_tokens: Type.Integer({ minimum: 1 }),
        request_rate: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
        request_timeout_seconds: Type.Optional(Type.Integer({ minimum: 1 })),
        tokenizer_model_id: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })), chat_template: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), stream: Type.Optional(Type.Boolean()), ignore_eos: Type.Optional(Type.Boolean()), warmup_requests: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })), warmup_timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
        optimization_attempt_id: Type.Optional(Id),
      }),
      description: "对一个明确的 Bittune 受管 Runtime 服务运行一次 EvalScope perf 压测，返回已归一化的吞吐、成功率、E2E、TTFT、TPOT、ITL 与采样显存指标。该操作消耗 GPU；只接受有限领域参数，不接受任意 EvalScope argv、路径或环境变量，不发布 CapacityBaseline。",
      async execute(params, context) {
        const input = params as BenchmarkWorkloadInput & { instance_id: string; optimization_attempt_id?: string };
        const { optimization_attempt_id: attemptId, ...workload } = input;
        if (workload.mode === "open_loop" && !workload.request_rate) throw new BittuneError("invalid_input", "open_loop 压测必须提供 request_rate。", false);
        const service = await context.store.getRuntimeService(input.instance_id);
        const attempt = await requireManagedAttempt(context, service, attemptId, "probing");
        // Host-side preflight runs BEFORE the Attempt is advanced. Missing host
        // tooling must not consume Trial budget or tear down a Ready service;
        // after installing prerequisites the Agent can re-enter this Tool.
        await context.store.ensureArtifactCapacity();
        validateExecutableWorkload(workload, service.model_id);
        let versionResult;
        try {
          versionResult = await runCommand("evalscope", ["--version"], { signal: context.signal, timeoutMs: 10_000 });
        } catch (error) {
          await context.artifact("evalscope-preflight", error instanceof Error ? error.message : String(error)).catch(() => undefined);
          throw new BittuneError("evalscope_unavailable", "EvalScope is unavailable: `evalscope --version` could not be executed.", false, { cause: error instanceof Error ? error.message : String(error), remediation: "Install EvalScope on this host (`pip install 'evalscope[perf]'`), then retry run_performance_test with the same instance_id; the managed service and its OptimizationAttempt are untouched." });
        }
        await context.artifact("evalscope-preflight", `${versionResult.stdout}\n${versionResult.stderr}`);
        const providerVersion = versionResult.exit_code === 0 ? versionResult.stdout.trim() : "";
        if (!providerVersion) throw new BittuneError("evalscope_unavailable", "EvalScope is unavailable: `evalscope --version` returned no usable version.", false, { exit_code: versionResult.exit_code, stderr: versionResult.stderr.slice(0, 1000), remediation: "Reinstall EvalScope (`pip install 'evalscope[perf]'`) until `evalscope --version` prints a version, then retry run_performance_test; the managed service remains untouched." });
        try {
          await advanceManagedAttempt(context, attempt, "benchmarking");
          const preset = await context.store.getRuntimePreset(service.deployment_preset_id, service.deployment_preset_version);
          const snapshot = await context.store.resolveModelSnapshot(preset);
          if (!snapshot) throw new BittuneError("model_snapshot_missing", `Model snapshot ${service.model_id}@${service.model_revision} is not available locally for EvalScope tokenizer resolution.`, false);
          const materialized = materializeBenchmarkWorkload(workload, service.model_id, providerVersion);
        const warmup = await runWarmup(service, materialized, context.signal);
        await context.artifact("benchmark-workload", JSON.stringify({ workload: materialized, workload_fingerprint: workloadFingerprint(materialized), metric_normalizer_version: METRIC_NORMALIZER_VERSION, warmup }, null, 2), "application/json");
        if (warmup.failures.length) throw new BittuneError("benchmark_warmup_failed", "One or more fixed warmup requests failed.", true, { warmup });
          const outputDir = join(context.store.runRoot, context.run_id, "artifacts", "evalscope-output");
          await mkdir(outputDir, { recursive: true });
          const args = [
          "perf", "--url", `${service.endpoint_url}/v1/chat/completions`, "--api", "openai", "--model", service.model_id,
          "--parallel", String(materialized.concurrency), "--number", String(materialized.request_count), "--enable-progress-tracker",
          "--outputs-dir", outputDir, "--dataset", "random", "--tokenizer-path", snapshot.host_snapshot_path,
          "--max-tokens", String(materialized.output_tokens), "--min-tokens", String(materialized.output_tokens), "--prefix-length", "0",
          "--min-prompt-length", String(materialized.input_tokens), "--max-prompt-length", String(materialized.input_tokens), "--extra-args", JSON.stringify({ ignore_eos: materialized.generation.ignore_eos }),
          "--total-timeout", String(materialized.request_timeout_seconds),
          ];
          if (materialized.generation.stream) args.push("--stream");
          if (materialized.mode === "open_loop") args.push("--open-loop", "--rate", String(materialized.request_rate));
          context.update(`正在以 ${materialized.mode} 模式运行 EvalScope perf（${materialized.request_count} requests）…`);
          const selectedGpuIds = Array.isArray(service.serving_configuration.gpu_device_ids) ? service.serving_configuration.gpu_device_ids.filter((id): id is number => typeof id === "number" && Number.isInteger(id)) : [];
          let peakBytes = await sampleGpuMemory(selectedGpuIds, context.signal) ?? 0;
          let sampling = false;
          const sample = async () => {
            if (sampling) return;
            sampling = true;
            try { peakBytes = Math.max(peakBytes, await sampleGpuMemory(selectedGpuIds, context.signal) ?? 0); } finally { sampling = false; }
          };
          const timer = setInterval(() => { void sample(); }, 500);
          let result;
          const evalscopeEnvironment = { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_DATASETS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" };
          try {
            result = await runCommand("evalscope", args, { signal: context.signal, timeoutMs: materialized.request_timeout_seconds * 1000 + 120_000, maxBytes: 2 * 1024 * 1024, env: evalscopeEnvironment });
          } finally {
            clearInterval(timer);
            await sample();
          }
          await context.artifact("evalscope-cli", `${result!.stdout}\n${result!.stderr}`);
          requireSuccess(result!);
          const collected = await collectEvalscopeMetrics(outputDir);
          for (const file of collected.files) await context.artifact(`evalscope:${file.name}`, file.content, "application/json");
          const normalized = normalizeEvalscopeReports(collected.reports);
          const summaryArtifact = await context.artifact("evalscope-summary", JSON.stringify({ metrics: normalized.metrics, distributions: normalized.distributions, metric_normalizer_version: normalized.normalizer_version, request_samples_available: normalized.request_samples_available, observed_gpu_memory_peak_bytes: peakBytes, workload: materialized, workload_fingerprint: workloadFingerprint(materialized), warmup }, null, 2), "application/json");
          const warnings = [
          ...(Object.keys(normalized.metrics).length ? [] : ["No recognized EvalScope metrics were found in the raw report."]),
          ...(normalized.request_samples_available ? [] : ["EvalScope output did not include per-request latency samples or an equivalent histogram; comparison requires validation."]),
          ];
          return { summary: `EvalScope 压测完成：${materialized.request_count} 个请求，成功率 ${String(normalized.metrics.success_rate ?? "未知")}，RPS ${String(normalized.metrics.requests_per_second ?? "未知")}。`, provenance_type: "measured", data: { service_instance_id: service.instance_id, deployment_preset_id: service.deployment_preset_id, deployment_preset_version: service.deployment_preset_version, model_id: service.model_id, model_revision: service.model_revision, runtime_kind: service.runtime_kind, runtime_image_digest: service.runtime_image_digest, runtime_capability_version: service.runtime_capability_version, serving_configuration: service.serving_configuration, requested: materialized, workload_fingerprint: workloadFingerprint(materialized), metric_normalizer_version: normalized.normalizer_version, metric_distributions: normalized.distributions, request_samples_available: normalized.request_samples_available, ...(attemptId ? { optimization_attempt_id: attemptId } : {}), metrics: normalized.metrics, observed_gpu_memory_peak_bytes: peakBytes, summary_artifact_id: summaryArtifact.artifact_id }, warnings, provider: { name: "evalscope", version: providerVersion } };
        } catch (error) {
          await failAndCleanManagedAttempt(context, service, attempt?.attempt_id, "benchmark_failed");
          throw error;
        }
      },
    }),
    createBittuneTool({
      name: "analyze_benchmark_artifact", label: "分析压测证据", recorder,
      parameters: Type.Object({ benchmark_run_id: RunId, artifact_id: ArtifactId }),
      description: "读取明确 benchmark_run_id + artifact_id 指向的已登记 EvalScope Artifact，归一并解释 TTFT、TPOT、ITL、吞吐、成功率和错误线索。只接受 Run Store 中的 ArtifactRef；不接受任意路径、不重新压测，也不发布 CapacityBaseline。",
      async execute(params, context) {
        const input = params as { benchmark_run_id: string; artifact_id: string };
        const run = await context.store.getRun(input.benchmark_run_id);
        if (run.manifest.tool_name !== "run_performance_test") throw new BittuneError("invalid_input", "benchmark_run_id 必须是 run_performance_test 的 Run Record。", false);
        const artifact = await context.store.readArtifact(input.benchmark_run_id, input.artifact_id, 0, 65_536);
        let parsed: unknown;
        try { parsed = JSON.parse(artifact.text); } catch { parsed = { raw_excerpt: artifact.text }; }
        const normalized = normalizeEvalscopeReports([parsed]);
        const warnings = artifact.truncated ? ["Artifact 已按 64 KiB 上限截断；完整内容仍保存在受管 Run Store。"] : [];
        return { summary: `已分析 EvalScope Artifact：成功率 ${String(normalized.metrics.success_rate ?? "未识别")}，RPS ${String(normalized.metrics.requests_per_second ?? "未识别")}，TTFT ${String(normalized.metrics.mean_ttft_ms ?? "未识别")}。`, provenance_type: "derived", data: { benchmark_run_id: input.benchmark_run_id, artifact_id: input.artifact_id, metrics: normalized.metrics, metric_distributions: normalized.distributions, metric_normalizer_version: normalized.normalizer_version, request_samples_available: normalized.request_samples_available, total_artifact_bytes: artifact.total_bytes }, warnings, provider: { name: "evalscope-artifact-analyzer" } };
      },
    }),
  ];
}
