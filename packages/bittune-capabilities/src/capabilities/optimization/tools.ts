import { Type } from "typebox";
import { BittuneError } from "../../shared/errors.ts";
import { materializeBenchmarkWorkload, workloadFingerprint } from "../../shared/benchmark-workload.ts";
import { activeOptimizationContextIdFromSessionEntries, optimizationTaskFingerprint } from "../../shared/optimization-context.ts";
import { canonicalJson, newId, sha256 } from "../../shared/identifiers.ts";
import { requireSuccess, runCommand } from "../../shared/process.ts";
import { getRuntimeAdapter } from "../../shared/runtime-adapter.ts";
import { validateAttemptGpuConfiguration } from "../../shared/optimization-attempt.ts";
import type { ExperimentWorkload, OptimizationAttemptState } from "../../shared/state-store.ts";
import { createBittuneTool } from "../../shared/tool.ts";
import { RunRecorder } from "../../shared/run-recorder.ts";
import type { ServingConfiguration } from "../../shared/vllm-capabilities.ts";

const Id = Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" });
const Version = Type.String({ pattern: "^v[1-9][0-9]*$" });
const RunId = Type.String({ pattern: "^run-[a-f0-9-]{36}$" });
const Workload = Type.Object({ mode: Type.Union([Type.Literal("closed_loop"), Type.Literal("open_loop")]), concurrency: Type.Integer({ minimum: 1 }), request_count: Type.Integer({ minimum: 1 }), input_tokens: Type.Integer({ minimum: 1 }), output_tokens: Type.Integer({ minimum: 1 }), request_rate: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), request_timeout_seconds: Type.Optional(Type.Integer({ minimum: 1 })), tokenizer_model_id: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })), chat_template: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), stream: Type.Optional(Type.Boolean()), ignore_eos: Type.Optional(Type.Boolean()), warmup_requests: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })), warmup_timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })) });
const Configuration = Type.Partial(Type.Object({ dtype: Type.Union([Type.Literal("auto"), Type.Literal("bfloat16"), Type.Literal("float16"), Type.Literal("float32")]), tensor_parallel_size: Type.Integer({ minimum: 1 }), pipeline_parallel_size: Type.Integer({ minimum: 1 }), gpu_device_ids: Type.Array(Type.Integer({ minimum: 0 })), max_model_len: Type.Integer({ minimum: 1 }), max_num_seqs: Type.Integer({ minimum: 1 }), max_num_batched_tokens: Type.Integer({ minimum: 1 }), gpu_memory_utilization: Type.Number({ exclusiveMinimum: 0, maximum: 1 }), swap_space_gib: Type.Number({ minimum: 0 }), enforce_eager: Type.Boolean(), enable_prefix_caching: Type.Boolean(), context_length: Type.Integer({ minimum: 1 }), max_running_requests: Type.Integer({ minimum: 1 }), chunked_prefill_size: Type.Integer({ minimum: 1 }), mem_fraction_static: Type.Number({ exclusiveMinimum: 0, maximum: 1 }), disable_cuda_graph: Type.Boolean(), disable_radix_cache: Type.Boolean() }));

async function selectedContextId(store: import("../../shared/state-store.ts").StateStore, input: { context_id?: string; title?: string; model_id?: string; runtime_kind?: "vllm" | "sglang"; objective_metric?: "requests_per_second" | "output_tokens_per_second" }, sessionEntries: readonly { type?: unknown; customType?: unknown; data?: unknown }[]): Promise<string> {
  if (input.context_id) return input.context_id;
  const hasSelectors = Boolean(input.title?.trim() || input.model_id || input.runtime_kind || input.objective_metric);
  if (!hasSelectors) {
    const restored = activeOptimizationContextIdFromSessionEntries(sessionEntries);
    if (restored) return restored;
  }
  const title = input.title?.trim().toLocaleLowerCase();
  const contexts = (await store.listOptimizationContexts()).filter((candidate) => {
    if (title && !candidate.title.toLocaleLowerCase().includes(title)) return false;
    if (input.model_id && candidate.model_id !== input.model_id) return false;
    if (input.runtime_kind && candidate.runtime_kind !== input.runtime_kind) return false;
    if (input.objective_metric && candidate.objective_metric !== input.objective_metric) return false;
    return true;
  });
  if (contexts.length === 1) return contexts[0].context_id;
  if (contexts.length > 1) {
    throw new BittuneError("optimization_context_ambiguous", "Multiple OptimizationContexts match the task fields; ask the user to distinguish them by title, model, runtime, or objective.", false, {
      candidates: contexts.map((candidate) => ({ title: candidate.title, model_id: candidate.model_id, runtime_kind: candidate.runtime_kind, objective_metric: candidate.objective_metric, updated_at: candidate.updated_at })),
    });
  }
  throw new BittuneError("optimization_context_not_found", "No OptimizationContext matches the provided task fields in this workspace.", false);
}

async function optimizationHandoff(store: import("../../shared/state-store.ts").StateStore, contextId: string) {
  const context = await store.getOptimizationContext(contextId);
  const [candidates, attempts, allTrials] = await Promise.all([
    store.listOptimizationCandidates(context.context_id),
    store.listOptimizationAttempts(context.context_id),
    store.listRuntimeExperimentTrials(context.experiment_id),
  ]);
  const trials = allTrials.filter((trial) => trial.experiment_version === context.experiment_version);
  const runIds = new Set<string>();
  for (const attempt of attempts) for (const runId of attempt.run_ids) runIds.add(runId);
  for (const trial of trials) for (const runId of [trial.pre_environment_run_id, trial.post_environment_run_id, trial.service_run_id, trial.probe_run_id, trial.benchmark_run_id]) runIds.add(runId);
  const runIndex = (await Promise.all([...runIds].sort().map(async (runId) => {
    try {
      const run = await store.getRun(runId);
      return { run_id: runId, tool_name: run.manifest.tool_name, status: run.manifest.status, finished_at: run.manifest.finished_at };
    } catch {
      return { run_id: runId, status: "unavailable" as const };
    }
  }))).sort((left, right) => left.run_id.localeCompare(right.run_id));
  const budgetCount = attempts.filter((attempt) => attempt.budget_counted).length;
  const failureCount = attempts.filter((attempt) => attempt.state === "failed").length;
  return {
    context: { context_id: context.context_id, title: context.title, status: context.status, created_at: context.created_at, updated_at: context.updated_at },
    spec: {
      experiment_id: context.experiment_id, experiment_version: context.experiment_version,
      deployment_preset_id: context.deployment_preset_id, deployment_preset_version: context.deployment_preset_version,
      runtime_kind: context.runtime_kind, runtime_image_digest: context.runtime_image_digest, runtime_capability_version: context.runtime_capability_version,
      model_id: context.model_id, model_revision: context.model_revision, experiment_kind: context.experiment_kind, objective_metric: context.objective_metric,
      constraints: context.constraints, workload: context.workload, allowed_workload: context.allowed_workload, allowed_parameters: context.allowed_parameters,
      required_repetitions: context.required_repetitions, max_objective_cv_percent: context.max_objective_cv_percent,
    },
    budget: { ...context.budget, counted_attempts: budgetCount, remaining_trials: Math.max(0, context.budget.max_trials - budgetCount), failures: failureCount, remaining_failures: Math.max(0, context.budget.max_failures - failureCount) },
    fingerprints: { task: optimizationTaskFingerprint(context), workload: workloadFingerprint(materializeBenchmarkWorkload(context.workload, context.model_id)) },
    candidates: candidates.map((candidate) => ({ candidate_id: candidate.candidate_id, configuration_hash: candidate.configuration_hash, workload_fingerprint: candidate.workload_fingerprint, created_at: candidate.created_at })),
    attempts: attempts.map((attempt) => ({ attempt_id: attempt.attempt_id, candidate_id: attempt.candidate_id, evaluation_key: attempt.evaluation_key, state: attempt.state, cleanup_status: attempt.cleanup_status, trial_id: attempt.trial_id, run_ids: attempt.run_ids, failure_code: attempt.failure_code, updated_at: attempt.updated_at })),
    trials: trials.map((trial) => ({ trial_id: trial.trial_id, configuration_hash: trial.configuration_hash, workload_fingerprint: trial.workload_fingerprint, result_class: trial.result_class, service_run_id: trial.service_run_id, probe_run_id: trial.probe_run_id, benchmark_run_id: trial.benchmark_run_id, created_at: trial.created_at })),
    run_index: runIndex,
  };
}

type GpuObservation = { uuid?: unknown; name?: unknown; driver_version?: unknown; compute_capability?: unknown; memory_total_bytes?: unknown };

function configurationFingerprint(optimization: Awaited<ReturnType<import("../../shared/state-store.ts").StateStore["getOptimizationContext"]>>, configuration: ServingConfiguration): string {
  return sha256(canonicalJson({
    runtime_kind: optimization.runtime_kind,
    runtime_image_digest: optimization.runtime_image_digest,
    model_id: optimization.model_id,
    model_revision: optimization.model_revision,
    runtime_capability_version: optimization.runtime_capability_version,
    configuration,
  }));
}

function environmentFingerprint(data: unknown, selectedGpuUuids: string[]): string {
  const observation = data as { host_id?: unknown; gpus?: GpuObservation[] } | undefined;
  const byUuid = new Map((observation?.gpus ?? []).filter((gpu): gpu is GpuObservation & { uuid: string } => typeof gpu.uuid === "string").map((gpu) => [gpu.uuid, gpu]));
  if (!byUuid.size) throw new BittuneError("evidence_incomplete", "Environment Run lacks GPU observations.", false);
  const selected = selectedGpuUuids.map((uuid) => {
    const gpu = byUuid.get(uuid);
    if (!gpu) throw new BittuneError("selected_gpu_not_observed", `GPU ${uuid} was not present in environment_run_id.`, false);
    return {
      uuid,
      name: typeof gpu.name === "string" ? gpu.name : "unknown",
      driver_version: typeof gpu.driver_version === "string" ? gpu.driver_version : "unknown",
      compute_capability: typeof gpu.compute_capability === "string" ? gpu.compute_capability : "unknown",
      memory_total_bytes: typeof gpu.memory_total_bytes === "number" ? gpu.memory_total_bytes : "unknown",
    };
  }).sort((left, right) => left.uuid.localeCompare(right.uuid));
  return sha256(canonicalJson({ host_id: typeof observation?.host_id === "string" ? observation.host_id : "unknown", gpus: selected }));
}

function terminalAttempt(state: OptimizationAttemptState): boolean {
  return state === "measured" || state === "failed" || state === "cancelled" || state === "abandoned";
}

async function inspectRecoveryService(containerId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const result = await runCommand("docker", ["container", "inspect", containerId, "--format", "{{json .State}}"], { signal, timeoutMs: 15_000 });
  if (result.exit_code !== 0) return { status: "not_found", running: false, stderr: result.stderr.slice(0, 500) };
  try {
    const state = JSON.parse(result.stdout) as { Status?: unknown; Running?: unknown; ExitCode?: unknown; OOMKilled?: unknown };
    return { status: typeof state.Status === "string" ? state.Status : "unknown", running: Boolean(state.Running), ...(typeof state.ExitCode === "number" ? { exit_code: state.ExitCode } : {}), ...(typeof state.OOMKilled === "boolean" ? { oom_killed: state.OOMKilled } : {}) };
  } catch {
    return { status: "unparseable", running: false, raw: result.stdout.slice(0, 500) };
  }
}

export function createOptimizationTools(recorder: RunRecorder) {
  return [
    createBittuneTool({
      name: "resolve_optimization_context", label: "Resolve optimization context", recorder,
      parameters: Type.Object({ context_id: Type.Optional(Id), title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })), model_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), runtime_kind: Type.Optional(Type.Union([Type.Literal("vllm"), Type.Literal("sglang")])), objective_metric: Type.Optional(Type.Union([Type.Literal("requests_per_second"), Type.Literal("output_tokens_per_second")])) }),
      description: "返回已选择或由用户可见任务字段唯一匹配的 OptimizationContext 事实交接。多个候选会返回可读歧义信息；不启动服务、创建 Candidate、续租或决定下一步。",
      async execute(params, context) {
        const input = params as { context_id?: string; title?: string; model_id?: string; runtime_kind?: "vllm" | "sglang"; objective_metric?: "requests_per_second" | "output_tokens_per_second" };
        const contextId = await selectedContextId(context.store, input, context.session_entries);
        const handoff = await optimizationHandoff(context.store, contextId);
        return { summary: `Resolved OptimizationContext ${handoff.context.context_id}: ${handoff.context.title}.`, provenance_type: "stored", data: handoff, provider: { name: "file-run-store", version: "optimization-handoff-v1" } };
      },
    }),
    createBittuneTool({
      name: "get_optimization_handoff", label: "Get optimization handoff", recorder,
      parameters: Type.Object({ context_id: Type.Optional(Id), title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })), model_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), runtime_kind: Type.Optional(Type.Union([Type.Literal("vllm"), Type.Literal("sglang")])), objective_metric: Type.Optional(Type.Union([Type.Literal("requests_per_second"), Type.Literal("output_tokens_per_second")])) }),
      description: "Read a bounded Optimization Handoff: title, frozen Spec, budget, fingerprints, and Candidate/Attempt/Trial/Run indexes. It never returns reasoning, workflow instructions, or raw provider output.",
      async execute(params, context) {
        const input = params as { context_id?: string; title?: string; model_id?: string; runtime_kind?: "vllm" | "sglang"; objective_metric?: "requests_per_second" | "output_tokens_per_second" };
        const contextId = await selectedContextId(context.store, input, context.session_entries);
        const handoff = await optimizationHandoff(context.store, contextId);
        return { summary: `Read Optimization Handoff for ${handoff.context.context_id}.`, provenance_type: "stored", data: handoff, provider: { name: "file-run-store", version: "optimization-handoff-v1" } };
      },
    }),
    createBittuneTool({
      name: "create_optimization_context", label: "创建调优上下文", recorder,
      parameters: Type.Object({ context_id: Id, title: Type.String({ minLength: 1, maxLength: 160 }), experiment_id: Id, experiment_version: Version }),
      description: "从已发布 ExperimentSpec 创建独立 v3 OptimizationContext。只写账本，不启动服务、探测或压测。",
      async execute(params, context) {
        const input = params as { context_id: string; title: string; experiment_id: string; experiment_version: string }; const spec = await context.store.getRuntimeExperimentSpec(input.experiment_id, input.experiment_version); const preset = await context.store.getRuntimePreset(spec.deployment_preset_id, spec.deployment_preset_version);
        const record = await context.store.saveOptimizationContext({ context_id: input.context_id, title: input.title, status: "active", experiment_id: spec.experiment_id, experiment_version: spec.version, deployment_preset_id: preset.preset_id, deployment_preset_version: preset.version, runtime_kind: preset.runtime_kind, runtime_image_digest: preset.runtime_image_digest, model_id: preset.model_id, model_revision: preset.model_revision, runtime_capability_version: spec.runtime_capability_version, experiment_kind: spec.experiment_kind, objective_metric: spec.objective_metric, constraints: spec.constraints, workload: spec.workload, ...(spec.allowed_workload ? { allowed_workload: spec.allowed_workload } : {}), allowed_parameters: spec.allowed_parameters, budget: spec.budget, required_repetitions: spec.required_repetitions, max_objective_cv_percent: spec.max_objective_cv_percent ?? 10, reference_service_configuration: spec.reference_service_configuration });
        return { summary: `已创建 OptimizationContext ${record.context_id}。`, provenance_type: "stored", data: record, provider: { name: "file-run-store", version: "optimization-v3" } };
      },
    }),
    createBittuneTool({
      name: "create_optimization_candidate", label: "创建调优候选", recorder,
      parameters: Type.Object({ context_id: Type.Optional(Id), candidate_id: Id, serving_configuration: Configuration, workload: Workload }),
      description: "在 Capability 和冻结 ExperimentSpec 范围内登记一个候选配置。只计算哈希，不启动服务。",
      async execute(params, context) {
        const input = params as { context_id?: string; candidate_id: string; serving_configuration: ServingConfiguration; workload: ExperimentWorkload }; const contextId = await selectedContextId(context.store, input, context.session_entries); const optimization = await context.store.getOptimizationContext(contextId); const preset = await context.store.getRuntimePreset(optimization.deployment_preset_id, optimization.deployment_preset_version); const adapter = getRuntimeAdapter(preset.runtime_kind); const reference = adapter.materializeConfiguration(optimization.reference_service_configuration); const configuration = adapter.materializeConfiguration({ ...reference, ...input.serving_configuration }); for (const [name, value] of Object.entries(configuration)) { const bound = optimization.allowed_parameters[name]; if (!bound) { if (canonicalJson(value) !== canonicalJson(reference[name])) throw new BittuneError("candidate_parameter_not_allowed", `${name} is frozen by the OptimizationContext.`, false); continue; } if (bound.values && !bound.values.some((candidateValue) => canonicalJson(candidateValue) === canonicalJson(value))) throw new BittuneError("candidate_out_of_bounds", `${name} is outside allowed values.`, false); if (typeof value === "number" && ((bound.minimum !== undefined && value < bound.minimum) || (bound.maximum !== undefined && value > bound.maximum))) throw new BittuneError("candidate_out_of_bounds", `${name} is outside allowed range.`, false); } if (optimization.experiment_kind === "runtime_tuning" && canonicalJson(input.workload) !== canonicalJson(optimization.workload)) throw new BittuneError("candidate_workload_mismatch", "runtime_tuning candidates must use the frozen workload.", false); if (optimization.experiment_kind === "capacity_exploration") { const range = optimization.allowed_workload; if (range?.concurrency && (input.workload.concurrency < range.concurrency.minimum || input.workload.concurrency > range.concurrency.maximum)) throw new BittuneError("candidate_workload_out_of_bounds", "Candidate concurrency is outside the allowed range.", false); if (input.workload.mode === "open_loop" && range?.request_rate && (input.workload.request_rate === undefined || input.workload.request_rate < range.request_rate.minimum || input.workload.request_rate > range.request_rate.maximum)) throw new BittuneError("candidate_workload_out_of_bounds", "Candidate request_rate is outside the allowed range.", false); } const candidate = await context.store.saveOptimizationCandidate({ candidate_id: input.candidate_id, context_id: contextId, configuration, configuration_hash: configurationFingerprint(optimization, configuration), workload: input.workload, workload_fingerprint: workloadFingerprint(materializeBenchmarkWorkload(input.workload, optimization.model_id)) }); return { summary: `已登记 Candidate ${candidate.candidate_id}。`, provenance_type: "stored", data: candidate, provider: { name: "file-run-store", version: "optimization-v3" } };
      },
    }),
    createBittuneTool({
      name: "reserve_optimization_attempt", label: "预约调优 Attempt", recorder,
      parameters: Type.Object({ attempt_id: Id, context_id: Type.Optional(Id), candidate_id: Id, environment_run_id: RunId, selected_gpu_uuids: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1 }), lease_id: Id, lease_expires_at: Type.String(), retest_reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), }),
      description: "在同一事务中预约 evaluation key 与 GPU lease，并计入 Trial 预算。不会启动 Provider 操作。",
      async execute(params, context) {
        const input = params as { attempt_id: string; context_id?: string; candidate_id: string; environment_run_id: string; selected_gpu_uuids: string[]; lease_id: string; lease_expires_at: string; retest_reason?: string }; const contextId = await selectedContextId(context.store, input, context.session_entries); const expires = Date.parse(input.lease_expires_at); if (!Number.isFinite(expires) || expires <= Date.now()) throw new BittuneError("invalid_input", "lease_expires_at must be a future timestamp.", false); if (new Set(input.selected_gpu_uuids).size !== input.selected_gpu_uuids.length) throw new BittuneError("invalid_input", "selected_gpu_uuids must be unique.", false); const environment = await context.store.getRun(input.environment_run_id); if (environment.manifest.tool_name !== "inspect_gpu" || environment.manifest.status !== "completed" || !environment.observation.ok) throw new BittuneError("evidence_incomplete", "environment_run_id must refer to a successful inspect_gpu Run.", false); const candidate = await context.store.getOptimizationCandidate(input.candidate_id); if (candidate.context_id !== contextId) throw new BittuneError("optimization_context_mismatch", "Candidate does not belong to the OptimizationContext.", false); validateAttemptGpuConfiguration(environment.observation.data, candidate.configuration, input.selected_gpu_uuids); const fingerprint = environmentFingerprint(environment.observation.data, input.selected_gpu_uuids); const evaluationKey = sha256(canonicalJson({ configuration_hash: candidate.configuration_hash, environment_fingerprint: fingerprint, workload_fingerprint: candidate.workload_fingerprint })); const attempt = await context.store.reserveOptimizationAttempt({ ...input, context_id: contextId, evaluation_key: evaluationKey, environment_fingerprint: fingerprint }); return { summary: `已预约 Attempt ${attempt.attempt_id}，状态为 reserved。`, provenance_type: "stored", data: attempt, provider: { name: "file-run-store", version: "optimization-v3" } };
      },
    }),
    createBittuneTool({ name: "list_optimization_contexts", label: "列出调优上下文", recorder, parameters: Type.Object({}), description: "读取 v3 OptimizationContext 账本。", async execute(_params, context) { const contexts = await context.store.listOptimizationContexts(); return { summary: `找到 ${contexts.length} 个 OptimizationContext。`, provenance_type: "stored", data: { contexts }, provider: { name: "file-run-store", version: "optimization-v3" } }; } }),
    createBittuneTool({ name: "list_optimization_candidates", label: "列出调优候选", recorder, parameters: Type.Object({ context_id: Id }), description: "读取指定上下文的不可变 Candidate 配置与 workload fingerprint。", async execute(params, context) { const candidates = await context.store.listOptimizationCandidates((params as { context_id: string }).context_id); return { summary: `找到 ${candidates.length} 个 Candidate。`, provenance_type: "stored", data: { candidates }, provider: { name: "file-run-store", version: "optimization-v3" } }; } }),
    createBittuneTool({ name: "list_optimization_attempts", label: "列出调优 Attempt", recorder, parameters: Type.Object({ context_id: Id }), description: "读取指定上下文的 Attempt、lease 和清理状态。", async execute(params, context) { const attempts = await context.store.listOptimizationAttempts((params as { context_id: string }).context_id); return { summary: `找到 ${attempts.length} 个 Attempt。`, provenance_type: "stored", data: { attempts }, provider: { name: "file-run-store", version: "optimization-v3" } }; } }),
    createBittuneTool({
      name: "recover_optimization_attempt", label: "Recover optimization Attempt", recorder,
      parameters: Type.Object({ attempt_id: Id, action: Type.Union([Type.Literal("inspect"), Type.Literal("stop_owned_service")]) }),
      description: "Inspect an expired or terminal OptimizationAttempt and its Bittune-owned Docker service. stop_owned_service is limited to the service carrying the same optimization_attempt_id, then marks cleanup complete; it never starts a Candidate, service, probe, or benchmark.",
      async execute(params, context) {
        const input = params as { attempt_id: string; action: "inspect" | "stop_owned_service" };
        const attempt = await context.store.getOptimizationAttempt(input.attempt_id);
        const leaseExpired = Date.parse(attempt.lease_expires_at) <= Date.now();
        const services = (await context.store.listRuntimeServices()).filter((service) => service.owner?.optimization_attempt_id === attempt.attempt_id);
        const inspected = await Promise.all(services.map(async (service) => ({ instance_id: service.instance_id, container_id: service.container_id, state: await inspectRecoveryService(service.container_id, context.signal) })));
        await context.artifact("optimization-recovery-inspection", JSON.stringify({ attempt_id: attempt.attempt_id, lease_expired: leaseExpired, services: inspected }, null, 2), "application/json");
        if (input.action === "inspect") return { summary: `Inspected Attempt ${attempt.attempt_id}; cleanup remains ${attempt.cleanup_status}.`, provenance_type: "measured", data: { attempt, lease_expired: leaseExpired, services: inspected }, provider: { name: "docker-cli", version: "optimization-recovery-v1" } };
        if (!leaseExpired && !terminalAttempt(attempt.state)) throw new BittuneError("optimization_recovery_not_allowed", "A nonterminal Attempt may be recovered only after its GPU lease expires.", false);
        for (const service of services) {
          const state = inspected.find((item) => item.instance_id === service.instance_id)?.state;
          if (state?.running !== true) continue;
          const stopped = await runCommand("docker", ["container", "stop", "--time", "30", service.container_id], { signal: context.signal, timeoutMs: 45_000 });
          await context.artifact("optimization-recovery-stop", `${service.instance_id}\n${stopped.stdout}\n${stopped.stderr}`);
          if (stopped.exit_code !== 0 && !/is not running/i.test(stopped.stderr)) requireSuccess(stopped);
        }
        const after = await Promise.all(services.map(async (service) => ({ instance_id: service.instance_id, state: await inspectRecoveryService(service.container_id, context.signal) })));
        if (after.some((service) => service.state.running === true)) throw new BittuneError("optimization_cleanup_incomplete", "An owned service is still running after recovery stop.", true, { services: after });
        const recovered = terminalAttempt(attempt.state)
          ? await context.store.updateOptimizationAttempt(attempt.attempt_id, { cleanup_status: "cleaned", run_ids: [context.run_id] })
          : await context.store.updateOptimizationAttempt(attempt.attempt_id, { state: "abandoned", cleanup_status: "cleaned", failure_code: "recovered_after_expired_lease", run_ids: [context.run_id] });
        return { summary: `Recovered Attempt ${recovered.attempt_id}; cleanup is cleaned.`, provenance_type: "measured", data: { attempt: recovered, lease_expired: leaseExpired, services: after }, provider: { name: "docker-cli", version: "optimization-recovery-v1" } };
      },
    }),
  ];
}
