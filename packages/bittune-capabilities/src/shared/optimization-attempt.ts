import { BittuneError } from "./errors.ts";
import { canonicalJson } from "./identifiers.ts";
import { runCommand } from "./process.ts";
import { getRuntimeAdapter } from "./runtime-adapter.ts";
import type { ToolRunContext } from "./run-recorder.ts";
import type { DeploymentPreset, OptimizationAttempt, ServiceManifest } from "./state-store.ts";
import type { ServingConfiguration } from "./vllm-capabilities.ts";

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function isTerminal(state: OptimizationAttempt["state"]): boolean {
	return state === "measured" || state === "failed" || state === "cancelled" || state === "abandoned";
}

/**
 * Precondition failures must name the concrete next Tool call so the Agent
 * can recover without guessing the hidden attempt state machine.
 */
function nextAttemptAction(state: OptimizationAttempt["state"]): string {
  switch (state) {
    case "reserved": return "start_managed_service(deployment_preset_id=…, optimization_attempt_id=…)";
    case "starting": return "wait_for_managed_service_ready(instance_id=…, optimization_attempt_id=…)";
    case "ready": return "probe_managed_endpoint(instance_id=…, optimization_attempt_id=…)";
    case "probing": return "run_performance_test(instance_id=…, optimization_attempt_id=…)";
    case "benchmarking": return "record_experiment_trial(experiment_id=…, optimization_attempt_id=…)";
    default: return "recover_optimization_attempt(attempt_id=…, action='inspect')";
  }
}

type GpuObservation = { index?: unknown; uuid?: unknown };

export function validateAttemptGpuConfiguration(
  environmentData: unknown,
  configuration: ServingConfiguration,
  selectedGpuUuids: readonly string[],
): void {
  const observed = environmentData as { gpus?: GpuObservation[] } | undefined;
  const byIndex = new Map(
    (observed?.gpus ?? [])
      .filter((gpu): gpu is GpuObservation & { index: number; uuid: string } => Number.isInteger(gpu.index) && typeof gpu.uuid === "string")
      .map((gpu) => [gpu.index, gpu.uuid]),
  );
  const observedUuids = new Set(byIndex.values());
  for (const uuid of selectedGpuUuids) {
    if (!observedUuids.has(uuid)) throw new BittuneError("selected_gpu_not_observed", `GPU ${uuid} was not present in environment_run_id.`, false);
  }
  const configuredIds = configuration.gpu_device_ids;
  if (!Array.isArray(configuredIds) || !configuredIds.length) {
    throw new BittuneError("optimization_gpu_devices_required", "An OptimizationAttempt requires explicit serving_configuration.gpu_device_ids; Docker must not select all GPUs.", false);
  }
  const configuredUuids = configuredIds.map((index) => {
    const uuid = byIndex.get(index);
    if (!uuid) throw new BittuneError("configured_gpu_not_observed", `Configured GPU index ${String(index)} was not present in environment_run_id.`, false);
    return uuid;
  });
  const expected = [...configuredUuids].sort();
  const selected = [...selectedGpuUuids].sort();
  if (expected.length !== selected.length || expected.some((uuid, index) => uuid !== selected[index])) {
    throw new BittuneError("optimization_gpu_lease_mismatch", "selected_gpu_uuids must exactly match the GPU indexes in the Candidate serving_configuration.", false, {
      configured_gpu_device_ids: configuredIds,
      configured_gpu_uuids: configuredUuids,
      selected_gpu_uuids: selectedGpuUuids,
    });
  }
}

export async function assertAttemptGpuAvailability(attempt: OptimizationAttempt, signal?: AbortSignal): Promise<void> {
  const result = await runCommand("nvidia-smi", ["--query-compute-apps=gpu_uuid,pid,process_name,used_memory", "--format=csv,noheader,nounits"], { signal, timeoutMs: 10_000 });
  if (result.exit_code !== 0) {
    throw new BittuneError("gpu_observation_unavailable", "Cannot verify leased GPU process occupancy before starting the OptimizationAttempt.", false, { exit_code: result.exit_code, stderr: result.stderr.slice(0, 1000) });
  }
  const selected = new Set(attempt.selected_gpu_uuids);
  const occupied = result.stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const [gpuUuid, pid, processName, memory] = line.split(",").map((value) => value.trim());
    if (!gpuUuid || !selected.has(gpuUuid)) return [];
    return [{ gpu_uuid: gpuUuid, pid: Number(pid), process_name: processName || "unknown", memory_mib: Number(memory) }];
  });
  if (occupied.length) {
    throw new BittuneError("gpu_resource_occupied", "A leased GPU is occupied by an existing compute process; stop or move that workload before starting this Trial.", false, { occupied_processes: occupied });
  }
}

export async function bindAttemptToManagedService(
  context: ToolRunContext,
  attemptId: string,
  preset: DeploymentPreset,
  configuration: ServingConfiguration,
): Promise<{ experiment_id: string; experiment_version: string; optimization_attempt_id: string }> {
  const attempt = await context.store.getOptimizationAttempt(attemptId);
  const optimization = await context.store.getOptimizationContext(attempt.context_id);
  const candidate = await context.store.getOptimizationCandidate(attempt.candidate_id);
  if (attempt.state !== "reserved") throw new BittuneError("invalid_attempt_transition", `Attempt ${attemptId} must be reserved before starting a service.`, false);
  if (optimization.status !== "active" || candidate.context_id !== optimization.context_id) throw new BittuneError("optimization_context_mismatch", "Attempt does not belong to an active OptimizationContext.", false);
  if (preset.preset_id !== optimization.deployment_preset_id || preset.version !== optimization.deployment_preset_version || preset.runtime_kind !== optimization.runtime_kind || preset.runtime_image_digest !== optimization.runtime_image_digest || preset.model_id !== optimization.model_id || preset.model_revision !== optimization.model_revision || getRuntimeAdapter(preset.runtime_kind).capabilityVersion !== optimization.runtime_capability_version) {
    throw new BittuneError("evidence_conflict", "Managed service does not match the frozen OptimizationContext identity.", false);
  }
  if (!same(candidate.configuration, configuration)) throw new BittuneError("evidence_conflict", "Managed service configuration does not match the reserved Candidate.", false);
  const environment = await context.store.getRun(attempt.environment_run_id);
  if (environment.manifest.tool_name !== "inspect_gpu" || environment.manifest.status !== "completed" || !environment.observation.ok) throw new BittuneError("evidence_incomplete", "OptimizationAttempt environment evidence is no longer usable.", false);
  validateAttemptGpuConfiguration(environment.observation.data, candidate.configuration, attempt.selected_gpu_uuids);
  await assertAttemptGpuAvailability(attempt, context.signal);
  await context.store.updateOptimizationAttempt(attemptId, { state: "starting", run_ids: [context.run_id] });
  return { experiment_id: optimization.experiment_id, experiment_version: optimization.experiment_version, optimization_attempt_id: attemptId };
}

export async function requireManagedAttempt(
  context: ToolRunContext,
  service: ServiceManifest,
  attemptId: string | undefined,
  expectedState: OptimizationAttempt["state"],
): Promise<OptimizationAttempt | undefined> {
  const ownedAttemptId = service.owner?.optimization_attempt_id;
  if (!ownedAttemptId && !attemptId) return undefined;
  if (!ownedAttemptId || attemptId !== ownedAttemptId) throw new BittuneError("optimization_attempt_mismatch", "This service must be operated with its owning OptimizationAttempt.", false);
  const attempt = await context.store.getOptimizationAttempt(ownedAttemptId);
  const candidate = await context.store.getOptimizationCandidate(attempt.candidate_id);
  if (!same(candidate.configuration, service.serving_configuration)) throw new BittuneError("evidence_conflict", "Service configuration no longer matches its OptimizationCandidate.", false);
  if (attempt.state !== expectedState) {
    const nextAction = nextAttemptAction(attempt.state);
    throw new BittuneError(
      "invalid_attempt_transition",
      `Attempt ${attemptId} is '${attempt.state}', but this operation requires '${expectedState}'. Next step: ${nextAction}.`,
      false,
      { current_state: attempt.state, expected_state: expectedState, next_action: nextAction },
    );
  }
  await context.store.updateOptimizationAttempt(ownedAttemptId, { run_ids: [context.run_id] });
  return attempt;
}

export async function requireManagedAttemptCleanup(context: ToolRunContext, service: ServiceManifest, attemptId: string | undefined): Promise<void> {
  const ownedAttemptId = service.owner?.optimization_attempt_id;
  if (!ownedAttemptId && !attemptId) return;
  if (!ownedAttemptId || ownedAttemptId !== attemptId) throw new BittuneError("optimization_attempt_mismatch", "This service must be stopped by its owning OptimizationAttempt.", false);
  await context.store.getOptimizationAttempt(ownedAttemptId);
}

export async function advanceManagedAttempt(context: ToolRunContext, attempt: OptimizationAttempt | undefined, state: OptimizationAttempt["state"]): Promise<void> {
  if (!attempt) return;
  await context.store.updateOptimizationAttempt(attempt.attempt_id, { state, run_ids: [context.run_id] });
}

export async function failManagedAttempt(context: ToolRunContext, attemptId: string | undefined, failureCode: string): Promise<void> {
  if (!attemptId) return;
  try {
    const attempt = await context.store.getOptimizationAttempt(attemptId);
    if (attempt.state === "reserved" || isTerminal(attempt.state)) return;
    await context.store.updateOptimizationAttempt(attemptId, { state: "failed", run_ids: [context.run_id], failure_code: failureCode });
  } catch {
    // Preserve the original provider error. Recovery will inspect the durable Run.
  }
}

export async function failAndCleanManagedAttempt(context: ToolRunContext, service: ServiceManifest | undefined, attemptId: string | undefined, failureCode: string): Promise<void> {
  if (!attemptId) return;
  await failManagedAttempt(context, attemptId, failureCode);
  if (service) {
    try {
      const removed = await runCommand("docker", ["container", "rm", "--force", service.container_id], { signal: context.signal, timeoutMs: 45_000 });
      await context.artifact("docker-automatic-cleanup", `${removed.stdout}\n${removed.stderr}`).catch(() => undefined);
      if (removed.exit_code === 0 || /No such container|not found/i.test(removed.stderr)) await context.store.deleteRuntimeService(service.instance_id);
      else return;
    } catch {
      return;
    }
  }
  try {
    const attempt = await context.store.getOptimizationAttempt(attemptId);
    if (isTerminal(attempt.state)) await context.store.updateOptimizationAttempt(attemptId, { cleanup_status: "cleaned", run_ids: [context.run_id] });
  } catch {
    // The original failure remains the primary diagnostic; a pending cleanup blocks another Trial.
  }
}

export async function cleanManagedAttempt(context: ToolRunContext, service: ServiceManifest, attemptId: string | undefined): Promise<void> {
  const ownedAttemptId = service.owner?.optimization_attempt_id;
  if (!ownedAttemptId && !attemptId) return;
  if (!ownedAttemptId || ownedAttemptId !== attemptId) throw new BittuneError("optimization_attempt_mismatch", "This service must be stopped by its owning OptimizationAttempt.", false);
  const attempt = await context.store.getOptimizationAttempt(ownedAttemptId);
  if (isTerminal(attempt.state)) {
    await context.store.updateOptimizationAttempt(ownedAttemptId, { cleanup_status: "cleaned", run_ids: [context.run_id] });
    return;
  }
  await context.store.updateOptimizationAttempt(ownedAttemptId, { state: "abandoned", cleanup_status: "cleaned", run_ids: [context.run_id], failure_code: "service_stopped_before_measurement" });
}
