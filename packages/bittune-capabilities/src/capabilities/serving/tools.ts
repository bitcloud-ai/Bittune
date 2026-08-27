import { Type } from "typebox";
import { relative } from "node:path";
import { BittuneError } from "../../shared/errors.ts";
import { newId } from "../../shared/identifiers.ts";
import { requireSuccess, runCommand } from "../../shared/process.ts";
import { RunRecorder } from "../../shared/run-recorder.ts";
import type { DeploymentPreset, ServiceManifest } from "../../shared/state-store.ts";
import { advanceManagedAttempt, bindAttemptToManagedService, cleanManagedAttempt, failAndCleanManagedAttempt, requireManagedAttempt, requireManagedAttemptCleanup } from "../../shared/optimization-attempt.ts";
import { createBittuneTool } from "../../shared/tool.ts";
import type { ServingConfiguration } from "../../shared/vllm-capabilities.ts";
import { inspectVllmCliProfile } from "../../shared/vllm-cli.ts";
import { resolveVllmImage } from "../../shared/vllm-image.ts";
import { compileRuntimeDockerGpuArgs, getRuntimeAdapter, type RuntimeKind } from "../../shared/runtime-adapter.ts";
import { inspectSglangCliProfile } from "../../shared/sglang-cli.ts";
import { requireRuntimeRepositoryAllowed } from "../../shared/runtime-policy.ts";

const Id = Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" });
const Version = Type.String({ pattern: "^v[1-9][0-9]*$" });
const Configuration = Type.Partial(Type.Object({
  dtype: Type.Union([Type.Literal("auto"), Type.Literal("bfloat16"), Type.Literal("float16"), Type.Literal("float32")]), tensor_parallel_size: Type.Integer({ minimum: 1 }), pipeline_parallel_size: Type.Integer({ minimum: 1 }),
  gpu_device_ids: Type.Array(Type.Integer({ minimum: 0 })), max_model_len: Type.Integer({ minimum: 1 }), max_num_seqs: Type.Integer({ minimum: 1 }), max_num_batched_tokens: Type.Integer({ minimum: 1 }),
  gpu_memory_utilization: Type.Number({ exclusiveMinimum: 0, maximum: 1 }), swap_space_gib: Type.Number({ minimum: 0 }), enforce_eager: Type.Boolean(), enable_prefix_caching: Type.Boolean(),
}));
const SglangConfiguration = Type.Partial(Type.Object({
  dtype: Type.Union([Type.Literal("auto"), Type.Literal("bfloat16"), Type.Literal("float16"), Type.Literal("float32")]), tensor_parallel_size: Type.Integer({ minimum: 1 }),
  gpu_device_ids: Type.Array(Type.Integer({ minimum: 0 })), context_length: Type.Integer({ minimum: 1 }), max_running_requests: Type.Integer({ minimum: 1 }), chunked_prefill_size: Type.Integer({ minimum: 1 }),
  mem_fraction_static: Type.Number({ exclusiveMinimum: 0, maximum: 1 }), disable_cuda_graph: Type.Boolean(), disable_radix_cache: Type.Boolean(),
}));
const RuntimeConfiguration = Type.Union([Configuration, SglangConfiguration]);

interface DockerServiceState {
  status: string;
  running: boolean;
  started_at?: string;
  finished_at?: string;
  exit_code?: number;
  oom_killed?: boolean;
  error?: string;
}

async function dockerServiceState(manifest: ServiceManifest, signal?: AbortSignal): Promise<DockerServiceState> {
  const result = await runCommand("docker", ["container", "inspect", manifest.container_id, "--format", "{{json .State}}"], { signal, timeoutMs: 15_000 });
  if (result.exit_code !== 0) return { status: "not_found", running: false, error: result.stderr.slice(0, 500) };
  const state = JSON.parse(result.stdout) as { Status?: string; Running?: boolean; StartedAt?: string; FinishedAt?: string; ExitCode?: number; OOMKilled?: boolean; Error?: string };
  return {
    status: state.Status ?? "unknown",
    running: Boolean(state.Running),
    ...(state.StartedAt ? { started_at: state.StartedAt } : {}),
    ...(state.FinishedAt ? { finished_at: state.FinishedAt } : {}),
    ...(state.ExitCode !== undefined ? { exit_code: state.ExitCode } : {}),
    ...(state.OOMKilled !== undefined ? { oom_killed: state.OOMKilled } : {}),
    ...(state.Error ? { error: state.Error } : {}),
  };
}

function manifestData(manifest: ServiceManifest, state: unknown) { return { service: { ...manifest, current_container_state: state } }; }
function tailUtf8(value: string, maxBytes: number): string { const bytes = Buffer.from(value, "utf8"); return bytes.length <= maxBytes ? value : bytes.subarray(bytes.length - maxBytes).toString("utf8"); }

async function modelPathInContainer(snapshot: { cache_root: string; host_snapshot_path: string }): Promise<string> {
  const pathWithinCache = relative(snapshot.cache_root, snapshot.host_snapshot_path);
  if (!pathWithinCache || pathWithinCache === ".." || pathWithinCache.startsWith("..\\") || pathWithinCache.startsWith("../")) throw new BittuneError("provider_error", "Model snapshot is outside the configured cache root.", false);
  return `/root/.cache/huggingface/${pathWithinCache.replaceAll("\\", "/")}`;
}

function endpointUrl(manifest: ServiceManifest, path: string): string { return `${manifest.endpoint_url}${path}`; }

function requireOpenAiProbeResponse(body: string, manifest: ServiceManifest): { model: string; content: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new BittuneError("endpoint_invalid_response", "Endpoint returned HTTP success but not an OpenAI-compatible JSON response.", true);
  }
  const value = payload as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
  const model = typeof value.model === "string" ? value.model : "";
  const content = value.choices?.[0]?.message?.content;
  if (model !== manifest.model_id || typeof content !== "string" || !content.trim()) {
    throw new BittuneError("endpoint_invalid_response", "Endpoint response did not prove the managed model identity and a non-empty completion.", true, {
      expected_model_id: manifest.model_id,
      response_model_id: model || undefined,
      has_non_empty_choice: typeof content === "string" && Boolean(content.trim()),
    });
  }
  return { model, content };
}

async function readDockerLogs(manifest: ServiceManifest, signal?: AbortSignal, tailLines = 200): Promise<{ raw: string; available: boolean }> {
  const logs = await runCommand("docker", ["container", "logs", "--timestamps", "--tail", String(tailLines), manifest.container_id], { signal, timeoutMs: 15_000, maxBytes: 1024 * 1024 });
  const raw = `${logs.stdout}${logs.stderr ? `\n[stderr]\n${logs.stderr}` : ""}`;
  return { raw, available: logs.exit_code === 0 };
}

async function sleepWithAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => { clearTimeout(timer); reject(new BittuneError("cancelled", "Ready wait cancelled.", true)); };
    function done() { signal?.removeEventListener("abort", onAbort); resolve(); }
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function trialServiceName(attemptId: string): string {
  return `trial-${attemptId.replace(/[^a-z0-9]/g, "").slice(-16)}`;
}

async function runtimeCliProfile(kind: RuntimeKind, image: { image_reference: string; run_reference: string }, signal?: AbortSignal): Promise<{ version?: string; entrypoint: string; entrypointArgs: string[]; flags: string[]; diagnostics: string }> {
  if (kind === "vllm") {
    const profile = await inspectVllmCliProfile(image, signal);
    return { ...(profile.version ? { version: profile.version } : {}), entrypoint: "vllm", entrypointArgs: [], flags: profile.flags, diagnostics: profile.diagnostics };
  }
  const profile = await inspectSglangCliProfile(image, signal);
  return { ...(profile.version ? { version: profile.version } : {}), entrypoint: profile.python_executable, entrypointArgs: ["-m", "sglang.launch_server"], flags: profile.flags, diagnostics: profile.diagnostics };
}

async function dockerPublishedLoopbackPort(containerId: string, signal?: AbortSignal): Promise<number> {
  const result = requireSuccess(await runCommand("docker", ["container", "inspect", containerId, "--format", "{{json .NetworkSettings.Ports}}"], { signal, timeoutMs: 15_000, maxBytes: 64 * 1024 }));
  let ports: Record<string, Array<{ HostIp?: unknown; HostPort?: unknown }> | null>;
  try {
    ports = JSON.parse(result.stdout) as Record<string, Array<{ HostIp?: unknown; HostPort?: unknown }> | null>;
  } catch {
    throw new BittuneError("docker_port_unavailable", "Docker returned an unreadable published-port mapping for the Trial container.", true);
  }
  const bindings = ports["8000/tcp"];
  const binding = bindings?.find((item) => item.HostIp === "127.0.0.1" && typeof item.HostPort === "string");
  const port = Number(binding?.HostPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new BittuneError("docker_port_unavailable", "Docker did not assign a loopback TCP port for the Trial container.", true, { ports });
  }
  return port;
}

function runtimeLaunchArgs(kind: RuntimeKind, modelPath: string, modelId: string, engineArgs: string[]): string[] {
  if (kind === "vllm") return ["--model", modelPath, "--served-model-name", modelId, ...engineArgs, "--host", "0.0.0.0", "--port", "8000"];
  return ["--model-path", modelPath, "--served-model-name", modelId, ...engineArgs, "--host", "0.0.0.0", "--port", "8000"];
}

export function createManagedServingTools(recorder: RunRecorder) {
  return [
    createBittuneTool({
      name: "observe_runtime_capability", label: "观察 Runtime 镜像能力", recorder,
      parameters: Type.Object({ deployment_preset_id: Id, deployment_preset_version: Type.Optional(Version), ttl_hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 168 })) }),
      description: "对一个本地、管理员允许的 Runtime 镜像记录精确 Image ID、OCI Entrypoint、CLI --help/版本和有限参数集合。该观察是启动受管服务的前置证据；它不启动模型服务。",
      async execute(params, context) {
        const input = params as { deployment_preset_id: string; deployment_preset_version?: string; ttl_hours?: number };
        const preset = await context.store.getRuntimePreset(input.deployment_preset_id, input.deployment_preset_version);
        await requireRuntimeRepositoryAllowed(preset.runtime_image_repository);
        const imageReference = `${preset.runtime_image_repository}@${preset.runtime_image_digest}`;
        const resolution = await resolveVllmImage({ repository: preset.runtime_image_repository, digest: preset.runtime_image_digest }, context.signal);
        await context.artifact("runtime-image-resolution", resolution.diagnostics);
        if (!resolution.image) throw new BittuneError("image_missing", `Runtime image ${imageReference} is not available locally.`, false);
        const oci = requireSuccess(await runCommand("docker", ["image", "inspect", resolution.image.run_reference, "--format", "{{json .Config.Entrypoint}}"], { signal: context.signal, timeoutMs: 15_000, maxBytes: 64 * 1024 }));
        const ociArtifact = await context.artifact("runtime-oci-entrypoint", `${oci.stdout}\n${oci.stderr}`, "application/json");
        const cli = await runtimeCliProfile(preset.runtime_kind, resolution.image, context.signal);
        const cliArtifact = await context.artifact(`${preset.runtime_kind}-cli-profile`, cli.diagnostics);
        const observedAt = new Date();
        const observation = await context.store.saveRuntimeCapabilityObservation({
          capability_id: newId("capability"), runtime_kind: preset.runtime_kind, runtime_image_repository: preset.runtime_image_repository,
          runtime_image_digest: preset.runtime_image_digest, runtime_image_id: resolution.image.image_id, runtime_capability_version: getRuntimeAdapter(preset.runtime_kind).capabilityVersion,
          ...(cli.version ? { cli_version: cli.version } : {}), entrypoint: cli.entrypoint, entrypoint_args: cli.entrypointArgs, supported_flags: cli.flags,
          observed_at: observedAt.toISOString(), expires_at: new Date(observedAt.getTime() + (input.ttl_hours ?? 24) * 60 * 60_000).toISOString(), source_run_id: context.run_id, artifact_ids: [ociArtifact.artifact_id, cliArtifact.artifact_id],
        });
        return { summary: `已记录 ${preset.runtime_kind} 镜像 ${imageReference} 的能力观察，${observation.expires_at} 前有效。`, provenance_type: "measured", data: observation, provider: { name: "docker-cli", ...(cli.version ? { version: cli.version } : {}) } };
      },
    }),
    createBittuneTool({
      name: "inspect_runtime_capabilities", label: "读取受管 Runtime 能力", recorder,
      parameters: Type.Object({ runtime_kind: Type.Union([Type.Literal("vllm"), Type.Literal("sglang")]), deployment_preset_id: Type.Optional(Id), deployment_preset_version: Type.Optional(Version) }),
      description: "读取指定受管 Runtime 的有限 Capability。若没有新鲜的镜像观察，只返回 Adapter 声明输入并标为 validation_required；不暴露任意 Engine flag。",
      async execute(params, context) {
        const input = params as { runtime_kind: RuntimeKind; deployment_preset_id?: string; deployment_preset_version?: string };
        const preset = input.deployment_preset_id ? await context.store.getRuntimePreset(input.deployment_preset_id, input.deployment_preset_version) : undefined;
        if (preset && preset.runtime_kind !== input.runtime_kind) throw new BittuneError("runtime_kind_mismatch", "DeploymentPreset runtime_kind does not match the requested Runtime Capability.", false);
        const adapter = getRuntimeAdapter(input.runtime_kind);
        const observations = preset ? (await context.store.listRuntimeCapabilityObservations()).filter((item) => item.runtime_kind === preset.runtime_kind && item.runtime_image_repository === preset.runtime_image_repository && item.runtime_image_digest === preset.runtime_image_digest && item.runtime_capability_version === adapter.capabilityVersion && Date.parse(item.expires_at) > Date.now()) : [];
        const observation = observations[0];
        return { summary: observation ? `${input.runtime_kind} Capability ${adapter.capabilityVersion} 已由本地镜像观察验证。` : `${input.runtime_kind} Capability ${adapter.capabilityVersion} 只有 Adapter 声明，仍需镜像观察验证。`, provenance_type: observation ? "measured" : "estimated", data: { ...adapter.capabilitySnapshot(preset ? { image_repository: preset.runtime_image_repository, image_digest: preset.runtime_image_digest } : undefined), verification_status: observation ? "verified" : "validation_required", ...(observation ? { runtime_capability_observation: observation } : {}) }, ...(observation ? {} : { warnings: ["请先执行 observe_runtime_capability，再启动该 Runtime 镜像。"] }), provider: { name: `bittune-${adapter.kind}-adapter`, version: adapter.capabilityVersion } };
      },
    }),
    createBittuneTool({
      name: "list_managed_services", label: "列出受管 Runtime 服务", recorder, parameters: Type.Object({ runtime_kind: Type.Optional(Type.Union([Type.Literal("vllm"), Type.Literal("sglang")])) }),
      description: "读取 Bittune 受管 ServiceInstance 并核对 Docker 当前状态。只读，不发送推理请求，不启动或停止服务。",
      async execute(params, context) {
        const input = params as { runtime_kind?: RuntimeKind };
        const manifests = (await context.store.listRuntimeServices()).filter((manifest) => !input.runtime_kind || manifest.runtime_kind === input.runtime_kind);
        const services = await Promise.all(manifests.map(async (manifest) => {
          const state = await dockerServiceState(manifest, context.signal);
          const observed = await context.store.recordRuntimeServiceObservation(manifest.instance_id, state.status, context.run_id);
          return { ...observed, current_container_state: state };
        }));
        return { summary: `发现 ${services.length} 个 Bittune 受管 Runtime 服务。`, provenance_type: "measured", data: { services }, provider: { name: "docker-cli" } };
      },
    }),
    createBittuneTool({
      name: "start_managed_service", label: "启动受管 Runtime 服务", recorder,
      parameters: Type.Object({ deployment_preset_id: Id, deployment_preset_version: Type.Optional(Version), service_name: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9-]{0,40}$" })), port: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535 })), serving_configuration: Type.Optional(RuntimeConfiguration), owner: Type.Optional(Type.Object({ experiment_id: Id, experiment_version: Version })), optimization_attempt_id: Type.Optional(Id) }),
      description: "从 DeploymentPreset 创建 Bittune 受管服务，可覆盖该 Runtime 的有限 serving configuration。不会拉镜像、下载模型或等待 Ready。",
      async execute(params, context) {
        const input = params as { deployment_preset_id: string; deployment_preset_version?: string; service_name?: string; port?: number; serving_configuration?: ServingConfiguration; owner?: { experiment_id: string; experiment_version: string }; optimization_attempt_id?: string };
        const serviceName = input.optimization_attempt_id ? trialServiceName(input.optimization_attempt_id) : (input.service_name ?? `service-${newId("service").replace(/[^a-z0-9]/g, "").slice(-16)}`);
        const requestedPort = input.optimization_attempt_id ? undefined : input.port;
        const preset = await context.store.getRuntimePreset(input.deployment_preset_id, input.deployment_preset_version);
        const adapter = getRuntimeAdapter(preset.runtime_kind);
        await requireRuntimeRepositoryAllowed(preset.runtime_image_repository);
        const imageReference = `${preset.runtime_image_repository}@${preset.runtime_image_digest}`;
        const image = await resolveVllmImage({ repository: preset.runtime_image_repository, digest: preset.runtime_image_digest }, context.signal);
        if (!image.image) throw new BittuneError("image_missing", `Runtime image ${imageReference} is not available locally.`, false);
        const snapshot = await context.store.resolveModelSnapshot(preset);
        if (!snapshot) throw new BittuneError("model_snapshot_missing", `Model snapshot ${preset.model_id}@${preset.model_revision} is not available locally.`, false);
        const capability = await context.store.getFreshRuntimeCapabilityObservation({ runtime_kind: preset.runtime_kind, runtime_image_repository: preset.runtime_image_repository, runtime_image_digest: preset.runtime_image_digest, runtime_image_id: image.image.image_id, runtime_capability_version: adapter.capabilityVersion });
        const cliProfile = { ...(capability.cli_version ? { version: capability.cli_version } : {}), entrypoint: capability.entrypoint, entrypointArgs: capability.entrypoint_args, flags: capability.supported_flags };
        const configuration = adapter.materializeConfiguration({ ...preset.serving_configuration, ...(input.serving_configuration ?? {}) });
        const attemptOwner = input.optimization_attempt_id ? await bindAttemptToManagedService(context, input.optimization_attempt_id, preset, configuration) : undefined;
        let manifest: ServiceManifest | undefined;
        try {
          const engineArgs = adapter.compileEngineArgs(configuration, cliProfile.flags);
          const instanceId = newId("service");
          const containerName = `bittune-${instanceId}`;
          const snapshotPath = await modelPathInContainer(snapshot);
          const entrypointArgs = preset.runtime_kind === "sglang" ? ["--entrypoint", cliProfile.entrypoint] : [];
          const args = [
            "run", "-d", "--pull=never", "--name", containerName, ...compileRuntimeDockerGpuArgs(preset.runtime_kind, configuration), "--ipc", "host", "-p", requestedPort ? `127.0.0.1:${requestedPort}:8000` : "127.0.0.1::8000",
            "-v", `${snapshot.cache_root}:/root/.cache/huggingface:ro`, "--env", "HF_HUB_OFFLINE=1", "--env", "TRANSFORMERS_OFFLINE=1", "--env", "HF_DATASETS_OFFLINE=1", "--env", "HF_HUB_DISABLE_TELEMETRY=1",
            ...entrypointArgs, image.image.run_reference, ...cliProfile.entrypointArgs, ...runtimeLaunchArgs(preset.runtime_kind, snapshotPath, preset.model_id, engineArgs),
          ];
          context.update(`正在启动受管 ${preset.runtime_kind} 容器 ${containerName}…`);
          const started = await runCommand("docker", args, { signal: context.signal, timeoutMs: 60_000, maxBytes: 1024 * 1024 });
          await context.artifact("docker-run", `${started.stdout}\n${started.stderr}`);
          requireSuccess(started);
          const containerId = started.stdout.trim();
          if (!/^[a-f0-9]{12,64}$/.test(containerId)) throw new BittuneError("provider_error", "Docker did not return a valid container ID.", true);
          // Persist a cleanup owner before inspecting runtime state or a Docker-assigned port.
          manifest = {
            schema_version: 3, instance_id: instanceId, service_name: serviceName, container_id: containerId, container_name: containerName,
            deployment_preset_id: preset.preset_id, deployment_preset_version: preset.version, model_id: preset.model_id, model_revision: preset.model_revision,
            runtime_kind: preset.runtime_kind, runtime_image_repository: preset.runtime_image_repository, runtime_image_digest: preset.runtime_image_digest, runtime_capability_version: adapter.capabilityVersion,
            runtime_cli_profile: { ...(cliProfile.version ? { version: cliProfile.version } : {}), entrypoint: `${cliProfile.entrypoint} ${cliProfile.entrypointArgs.join(" ")}`.trim(), supported_flags: cliProfile.flags }, runtime_engine_args: engineArgs,
            endpoint_url: "http://127.0.0.1:0", port: 0, serving_configuration: configuration,
            config_hash: adapter.configurationFingerprint(configuration), created_at: new Date().toISOString(),
            observation: { desired_state: "running", observed_state: "created", observed_at: new Date().toISOString(), freshness: "unknown", state_generation: 0 },
            ...(attemptOwner ? { owner: { kind: "experiment" as const, ...attemptOwner } } : input.owner ? { owner: { kind: "experiment" as const, ...input.owner } } : {}),
          };
          await context.store.saveRuntimeService(manifest);
          const port = requestedPort ?? await dockerPublishedLoopbackPort(containerId, context.signal);
          manifest = { ...manifest, endpoint_url: `http://127.0.0.1:${port}`, port };
          const state = await dockerServiceState(manifest, context.signal);
          await context.store.saveRuntimeService({ ...manifest, observation: { ...manifest.observation, observed_state: state.status } });
          const observed = await context.store.recordRuntimeServiceObservation(instanceId, state.status, context.run_id, "running");
          if (!state.running) {
            const logs = await readDockerLogs(observed, context.signal);
            const artifact = await context.artifact("docker-start-failure-logs", logs.raw);
            throw new BittuneError("container_start_failed", `Managed ${preset.runtime_kind} container ${instanceId} did not remain running.`, false, { instance_id: instanceId, container_state: state, log_artifact_id: artifact.artifact_id, log_excerpt: tailUtf8(logs.raw, 8 * 1024) });
          }
          return { summary: `已启动受管 ${preset.runtime_kind} 服务 ${instanceId}，等待 Ready 需单独调用 wait_for_managed_service_ready。`, provenance_type: "measured", data: manifestData(observed, state), provider: { name: "docker-cli", ...(cliProfile.version ? { version: cliProfile.version } : {}) } };
        } catch (error) {
          await failAndCleanManagedAttempt(context, manifest, input.optimization_attempt_id, "managed_service_start_failed");
          throw error;
        }
      },
    }),
    createBittuneTool({
      name: "wait_for_managed_service_ready", label: "等待受管 Runtime Ready", recorder,
      parameters: Type.Object({ instance_id: Id, timeout_seconds: Type.Integer({ minimum: 1, maximum: 600 }), poll_interval_seconds: Type.Optional(Type.Number({ minimum: 0.1, maximum: 30 })), optimization_attempt_id: Type.Optional(Id) }),
      description: "对 Bittune 受管 Runtime 服务执行有界 /v1/models Ready 等待。只读，不启动、修改或停止服务。",
      async execute(params, context) {
        const input = params as { instance_id: string; timeout_seconds: number; poll_interval_seconds?: number; optimization_attempt_id?: string };
        const manifest = await context.store.getRuntimeService(input.instance_id);
        const attempt = await requireManagedAttempt(context, manifest, input.optimization_attempt_id, "starting");
        const deadline = Date.now() + input.timeout_seconds * 1000;
        const interval = (input.poll_interval_seconds ?? 1) * 1000;
        let lastError = "";
        try {
          while (Date.now() < deadline) {
          const state = await dockerServiceState(manifest, context.signal);
          if (!state.running) {
            await context.store.recordRuntimeServiceObservation(manifest.instance_id, state.status, context.run_id, "running");
            const logs = await readDockerLogs(manifest, context.signal);
            const artifact = await context.artifact("docker-ready-failure-logs", logs.raw);
            await failAndCleanManagedAttempt(context, manifest, attempt?.attempt_id, "container_not_running");
            return { summary: `服务 ${manifest.instance_id} 在 Ready 前已停止。`, provenance_type: "measured", data: { instance_id: manifest.instance_id, runtime_kind: manifest.runtime_kind, ready: false, failure_kind: "container_not_running", container_state: state, log_excerpt: tailUtf8(logs.raw, 8 * 1024), log_artifact_id: artifact.artifact_id }, warnings: ["容器未运行；请依据 Docker State 和日志分析原因，不要在未改变前提时重复等待。"], provider: { name: "docker-cli" } };
          }
          try {
            const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
            const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
            const response = await fetch(endpointUrl(manifest, "/v1/models"), { signal, headers: { accept: "application/json" } });
            const body = await response.text();
            if (response.ok) {
              await context.store.recordRuntimeServiceObservation(manifest.instance_id, "ready", context.run_id, "running");
              await advanceManagedAttempt(context, attempt, "ready");
              return { summary: `服务 ${manifest.instance_id} 已 Ready。`, provenance_type: "measured", data: { instance_id: manifest.instance_id, runtime_kind: manifest.runtime_kind, ready: true, status_code: response.status, elapsed_ms: input.timeout_seconds * 1000 - Math.max(0, deadline - Date.now()) }, provider: { name: "openai-compatible-http" } };
            }
            lastError = `HTTP ${response.status}: ${body.slice(0, 200)}`;
          } catch (error) {
            if (context.signal?.aborted) throw new BittuneError("cancelled", "Ready wait cancelled.", true);
            lastError = error instanceof Error ? error.message : String(error);
          }
            await sleepWithAbort(Math.min(interval, Math.max(10, deadline - Date.now())), context.signal);
          }
          await context.store.recordRuntimeServiceObservation(manifest.instance_id, "not_ready", context.run_id, "running");
          await failAndCleanManagedAttempt(context, manifest, attempt?.attempt_id, "runtime_not_ready");
          return { summary: `服务 ${manifest.instance_id} 在 ${input.timeout_seconds}s 内未 Ready。`, provenance_type: "measured", data: { instance_id: manifest.instance_id, runtime_kind: manifest.runtime_kind, ready: false, timeout_seconds: input.timeout_seconds, last_error: lastError }, warnings: ["服务可能仍在加载模型；请读取日志或重新探测。"], provider: { name: "openai-compatible-http" } };
        } catch (error) {
          await failAndCleanManagedAttempt(context, manifest, attempt?.attempt_id, "runtime_ready_failed");
          throw error;
        }
      },
    }),
    createBittuneTool({
      name: "read_managed_service_logs", label: "读取受管 Runtime 服务日志", recorder, parameters: Type.Object({ instance_id: Id, tail_lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }),
      description: "读取 Bittune 受管 Runtime 服务的有限 Docker 日志。只读，完整日志保存为 Artifact。",
      async execute(params, context) {
        const input = params as { instance_id: string; tail_lines?: number };
        const manifest = await context.store.getRuntimeService(input.instance_id);
        const state = await dockerServiceState(manifest, context.signal);
        const logs = await runCommand("docker", ["container", "logs", "--timestamps", "--tail", String(input.tail_lines ?? 200), manifest.container_id], { signal: context.signal, timeoutMs: 15_000, maxBytes: 1024 * 1024 });
        const raw = `${logs.stdout}${logs.stderr ? `\n[stderr]\n${logs.stderr}` : ""}`;
        const artifact = await context.artifact("docker-logs", raw);
        await context.store.recordRuntimeServiceObservation(manifest.instance_id, state.status, context.run_id);
        if (logs.exit_code !== 0) throw new BittuneError("service_logs_unavailable", `Unable to read logs for ${manifest.instance_id}.`, true, { exit_code: logs.exit_code, status: state.status });
        return { summary: `已读取 ${manifest.instance_id} 的最近 ${input.tail_lines ?? 200} 行日志。`, provenance_type: "measured", data: { instance_id: manifest.instance_id, runtime_kind: manifest.runtime_kind, status: state.status, running: state.running, tail_lines: input.tail_lines ?? 200, log_excerpt: tailUtf8(raw, 8 * 1024), artifact_id: artifact.artifact_id }, provider: { name: "docker-cli" } };
      },
    }),
    createBittuneTool({
      name: "inspect_managed_service", label: "检查受管 Runtime 服务", recorder, parameters: Type.Object({ instance_id: Id }),
      description: "读取 Bittune 受管 ServiceInstance、Capability 配置和 Docker 当前状态。只读。",
      async execute(params, context) {
        const manifest = await context.store.getRuntimeService((params as { instance_id: string }).instance_id);
        const state = await dockerServiceState(manifest, context.signal);
        const observed = await context.store.recordRuntimeServiceObservation(manifest.instance_id, state.status, context.run_id);
        return { summary: `服务 ${manifest.instance_id} 当前状态为 ${state.status}。`, provenance_type: "measured", data: manifestData(observed, state), provider: { name: "docker-cli" } };
      },
    }),
    createBittuneTool({
      name: "probe_managed_endpoint", label: "探测受管 Runtime 端点", recorder, parameters: Type.Object({ instance_id: Id, timeout_seconds: Type.Optional(Type.Integer({ minimum: 1 })), optimization_attempt_id: Type.Optional(Id) }),
      description: "向指定受管 Runtime 端点发送一次最小 OpenAI-compatible 推理请求，判断目标模型是否可用。只读但消耗少量 GPU。",
      async execute(params, context) {
        const input = params as { instance_id: string; timeout_seconds?: number; optimization_attempt_id?: string };
        const manifest = await context.store.getRuntimeService(input.instance_id);
        const attempt = await requireManagedAttempt(context, manifest, input.optimization_attempt_id, "ready");
        await advanceManagedAttempt(context, attempt, "probing");
        const timeout = AbortSignal.timeout((input.timeout_seconds ?? 30) * 1000);
        const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
        const started = performance.now();
        try {
          const response = await fetch(endpointUrl(manifest, "/v1/chat/completions"), { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ model: manifest.model_id, messages: [{ role: "user", content: "Reply with only OK." }], max_tokens: 4, temperature: 0 }) });
          const body = await response.text();
          await context.artifact("managed-endpoint-probe", body, "application/json");
          if (!response.ok) {
            await context.store.recordRuntimeServiceObservation(manifest.instance_id, `http_${response.status}`, context.run_id, "running");
            throw new BittuneError("endpoint_unavailable", `Endpoint returned HTTP ${response.status}.`, true, { response: body.slice(0, 1000) });
          }
          const payload = requireOpenAiProbeResponse(body, manifest);
          await context.store.recordRuntimeServiceObservation(manifest.instance_id, "ready", context.run_id, "running");
          return { summary: `端点可用，最小推理耗时 ${Math.round(performance.now() - started)} ms。`, provenance_type: "measured", data: { instance_id: manifest.instance_id, runtime_kind: manifest.runtime_kind, endpoint_url: manifest.endpoint_url, reachable: true, response_model_id: payload.model, latency_ms: Math.round(performance.now() - started), response_excerpt: payload.content.slice(0, 200) }, provider: { name: `${manifest.runtime_kind}-openai-http` } };
        } catch (error) {
          const failureCode = context.signal?.aborted ? "endpoint_probe_cancelled" : "endpoint_probe_failed";
          await context.store.recordRuntimeServiceObservation(manifest.instance_id, "unreachable", context.run_id, "running").catch(() => undefined);
          await failAndCleanManagedAttempt(context, manifest, attempt?.attempt_id, failureCode);
          if (context.signal?.aborted) throw new BittuneError("cancelled", "Endpoint probe cancelled.", true);
          if (error instanceof BittuneError) throw error;
          throw new BittuneError("endpoint_unavailable", `Unable to connect to ${manifest.endpoint_url}.`, true, { cause: error instanceof Error ? error.message : String(error) });
        }
      },
    }),
    createBittuneTool({
      name: "stop_managed_service", label: "停止受管 Runtime 服务", recorder, parameters: Type.Object({ instance_id: Id, experiment_id: Type.Optional(Id), optimization_attempt_id: Type.Optional(Id) }),
      description: "停止一个 Bittune 受管 Runtime 容器。若服务归属于实验，自动化调用必须提供相同 experiment_id；不会操作外部服务。",
      async execute(params, context) {
        const input = params as { instance_id: string; experiment_id?: string; optimization_attempt_id?: string };
        const manifest = await context.store.getRuntimeService(input.instance_id);
        if (manifest.owner && input.experiment_id && manifest.owner.experiment_id !== input.experiment_id) throw new BittuneError("service_owner_mismatch", "This service belongs to another experiment and cannot be stopped in this scope.", false);
        if (manifest.owner && !input.experiment_id && !input.optimization_attempt_id) throw new BittuneError("service_owner_mismatch", "An experiment_id or the owning optimization_attempt_id is required to stop this service.", false);
        await requireManagedAttemptCleanup(context, manifest, input.optimization_attempt_id);
        const stopped = await runCommand("docker", ["container", "stop", "--time", "30", manifest.container_id], { signal: context.signal, timeoutMs: 45_000 });
        await context.artifact("docker-stop", `${stopped.stdout}\n${stopped.stderr}`);
        if (stopped.exit_code !== 0 && !/is not running/i.test(stopped.stderr)) requireSuccess(stopped);
        const state = await dockerServiceState(manifest, context.signal);
        const observed = await context.store.recordRuntimeServiceObservation(manifest.instance_id, state.status, context.run_id, "stopped");
        const removed = requireSuccess(await runCommand("docker", ["container", "rm", manifest.container_id], { signal: context.signal, timeoutMs: 30_000 }));
        await context.artifact("docker-remove", `${removed.stdout}\n${removed.stderr}`);
        await cleanManagedAttempt(context, manifest, input.optimization_attempt_id);
        return { summary: `已停止受管服务 ${manifest.instance_id}。`, provenance_type: "measured", data: manifestData(observed, state), provider: { name: "docker-cli" } };
      },
    }),
  ];
}
