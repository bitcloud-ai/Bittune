import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import type { ExtensionContext, ToolDefinition } from "../packages/bittune-runtime/src/core/extensions/types.ts";
import bittuneExtension, { createBittuneExtension } from "../packages/bittune-capabilities/src/index.ts";
import {
  CAPABILITY_TOOL_NAMES,
  HISTORICAL_EVIDENCE_TOOL_NAMES,
} from "../packages/bittune-capabilities/src/shared/capability-catalog.ts";
import { canonicalJson, sha256 } from "../packages/bittune-capabilities/src/shared/identifiers.ts";
import { ACTIVE_OPTIMIZATION_CONTEXT_SESSION_ENTRY } from "../packages/bittune-capabilities/src/shared/optimization-context.ts";
import { validateAttemptGpuConfiguration } from "../packages/bittune-capabilities/src/shared/optimization-attempt.ts";
import { StateStore, type ServiceManifest } from "../packages/bittune-capabilities/src/shared/state-store.ts";
import { VLLM_CAPABILITY_VERSION, compileVllmEngineArgs, materializeVllmConfiguration, vllmConfigurationFingerprint } from "../packages/bittune-capabilities/src/shared/vllm-capabilities.ts";
import { materializeBenchmarkWorkload, METRIC_NORMALIZER_VERSION, workloadFingerprint } from "../packages/bittune-capabilities/src/shared/benchmark-workload.ts";
import { SGLANG_CAPABILITY_VERSION, compileSglangEngineArgs, materializeSglangConfiguration, sglangConfigurationFingerprint } from "../packages/bittune-capabilities/src/shared/sglang-capabilities.ts";
import { BITTUNE_SYSTEM_PROMPT, BITTUNE_SYSTEM_PROMPT_MARKER } from "../packages/bittune-capabilities/src/shared/system-prompt.ts";
import { createToolRegistry } from "../packages/bittune-capabilities/src/tool-registry.ts";

const expectedNames = [
  "inspect_gpu", "inspect_linux_host", "inspect_container_runtime",
  "resolve_model_revision", "list_inference_runtimes", "inspect_inference_runtime", "list_local_model_artifacts", "list_inference_services", "inspect_inference_service", "probe_inference_endpoint",
  "derive_deployment_options",
  "publish_experiment_spec", "list_experiment_specs", "get_experiment_spec", "record_experiment_trial", "list_experiment_trials", "get_experiment_trial", "derive_experiment_comparison", "publish_experiment_comparison", "list_experiment_comparisons", "get_experiment_comparison",
  "resolve_optimization_context", "get_optimization_handoff", "create_optimization_context", "create_optimization_candidate", "reserve_optimization_attempt", "list_optimization_contexts", "list_optimization_candidates", "list_optimization_attempts", "recover_optimization_attempt",
  "inspect_runtime_policy", "discover_runtime_images", "list_deployment_presets", "get_deployment_preset", "publish_deployment_preset",
  "list_capacity_baselines", "get_capacity_baseline", "derive_capacity_baseline", "publish_capacity_baseline",
  "inspect_runtime_image", "pull_runtime_image", "inspect_model_snapshot", "download_model_snapshot",
  "observe_runtime_capability", "inspect_runtime_capabilities", "list_managed_services", "start_managed_service", "wait_for_managed_service_ready", "read_managed_service_logs", "inspect_managed_service", "probe_managed_endpoint", "stop_managed_service",
  "run_performance_test", "analyze_benchmark_artifact", "list_run_records", "get_run_record", "read_artifact_excerpt",
];

const model = { model_id: "acme/meteor-8b", model_revision: "0123456789abcdef0123456789abcdef01234567", runtime_image_repository: "registry.example/acme/vllm", runtime_image_digest: "sha256:" + "a".repeat(64) };
const configuration = materializeVllmConfiguration({ max_model_len: 4096, max_num_seqs: 4, max_num_batched_tokens: 4096, gpu_memory_utilization: 0.8, gpu_device_ids: [0] });
const workload = { mode: "closed_loop" as const, concurrency: 2, request_count: 4, input_tokens: 64, output_tokens: 16, request_timeout_seconds: 60 };

process.env.BITTUNE_RUNTIME_POLICY_FILE = join(process.cwd(), "tests", "fixtures", "runtime-policy.json");

async function invoke(root: string, name: string, params: Record<string, unknown>) {
  const tool = createToolRegistry(root).find((item) => item.name === name) as ToolDefinition;
  assert.ok(tool, `missing tool ${name}`);
  const result = await tool.execute("test-call", params as never, undefined, undefined, {} as ExtensionContext);
  const block = result.content.find((item) => item.type === "text");
  assert.ok(block && block.type === "text");
  const projection = JSON.parse(block.text) as { run_id?: string; status: "completed" | "failed" | "cancelled"; query_data?: Record<string, unknown> };
  if (!projection.run_id) {
    return { ok: projection.status === "completed", data: projection.query_data, run_id: "" };
  }
  const store = new StateStore(root);
  try {
    const { observation } = await store.getRun(projection.run_id);
    return { ok: observation.ok, data: observation.data as Record<string, unknown> | undefined, error: observation.error, run_id: projection.run_id };
  } finally {
    store.close();
  }
}

async function completedRun(store: StateStore, toolName: string, data: Record<string, unknown>, input: Record<string, unknown> = {}) {
  await store.initialize();
  const started = await store.startRun(toolName, input);
  const observation = { ok: true, summary: "fixture", provenance_type: "measured" as const, measured_at: new Date().toISOString(), run_id: started.run_id, data, warnings: [], artifacts: [] };
  await store.finishRun(started.run_id, { tool_name: toolName, started_at: started.started_at, status: "completed", provenance_type: "measured", input, artifacts: [], observation });
  return started.run_id;
}

async function publishGenericPreset(root: string) {
  const result = await invoke(root, "publish_deployment_preset", {
    preset_id: "meteor-vllm", model_id: model.model_id, model_revision: model.model_revision, runtime_kind: "vllm", runtime_image_repository: model.runtime_image_repository, runtime_image_digest: model.runtime_image_digest,
    serving_configuration: { max_model_len: 4096, max_num_seqs: 4, max_num_batched_tokens: 4096, gpu_memory_utilization: 0.8, gpu_device_ids: [0] },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data as { preset_id: string; version: string };
}

async function publishSglangPreset(root: string) {
  const result = await invoke(root, "publish_deployment_preset", {
    preset_id: "meteor-sglang", model_id: model.model_id, model_revision: model.model_revision, runtime_kind: "sglang", runtime_image_repository: "registry.example/acme/sglang", runtime_image_digest: model.runtime_image_digest,
    serving_configuration: { context_length: 4096, max_running_requests: 4, chunked_prefill_size: 4096, mem_fraction_static: 0.8, gpu_device_ids: [0] },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data as { preset_id: string; version: string };
}

async function installExitedDockerFixture(root: string): Promise<{ bin: string; log: string }> {
  const bin = join(root, "fake-docker-bin");
  const log = join(root, "fake-docker-commands.jsonl");
  const driver = join(root, "fake-docker.mjs");
  await mkdir(bin, { recursive: true });
  await writeFile(driver, `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.BITTUNE_TEST_FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
const print = (value) => process.stdout.write(value + "\\n");
if (args[0] === "image" && args[1] === "inspect") print(JSON.stringify({ Id: "sha256:${"a".repeat(64)}", RepoDigests: [] }));
else if (args[0] === "run" && args.includes("--help") && args.includes("sglang.launch_server")) print("--model-path PATH --served-model-name NAME --host HOST --port PORT --dtype DTYPE --tp-size SIZE --context-length LENGTH --max-running-requests COUNT --chunked-prefill-size SIZE --mem-fraction-static FRACTION --disable-cuda-graph --disable-radix-cache");
else if (args[0] === "run" && args.includes("--help")) print("--model MODEL --served-model-name NAME --host HOST --port PORT --dtype DTYPE --tensor-parallel-size SIZE --pipeline-parallel-size SIZE --max-model-len LENGTH --max-num-seqs COUNT --max-num-batched-tokens COUNT --gpu-memory-utilization FRACTION --enable-prefix-caching");
else if (args[0] === "run" && args.includes("-c")) print("0.5.0");
else if (args[0] === "run" && args.includes("--version")) print("vLLM version 0.27.1");
else if (args[0] === "container" && args[1] === "ls") print("");
else if (args[0] === "run" && args.includes("-d")) print("${"b".repeat(64)}");
else if (args[0] === "container" && args[1] === "inspect") print(JSON.stringify({ Status: "exited", Running: false, StartedAt: "2026-08-19T00:00:00Z", FinishedAt: "2026-08-19T00:00:01Z", ExitCode: 2, OOMKilled: false, Error: "" }));
else if (args[0] === "container" && args[1] === "logs") print("vLLM failed while loading the model");
else if (args[0] === "container" && args[1] === "top") print("PID\\n1234");
else { process.stderr.write("unexpected docker call: " + JSON.stringify(args)); process.exitCode = 1; }
`);
  if (process.platform === "win32") {
    await writeFile(join(bin, "docker.cmd"), `@echo off\r\n"${process.execPath}" "${driver}" %*\r\n`);
  } else {
    const shim = join(bin, "docker");
    await writeFile(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(driver)} "$@"\n`);
    await chmod(shim, 0o755);
  }
  return { bin, log };
}

function serviceManifest(instanceId: string, port: number, servingConfiguration = configuration, owner?: ServiceManifest["owner"]): ServiceManifest {
  return {
    schema_version: 3, instance_id: instanceId, service_name: instanceId, container_id: (instanceId + "000000000000000000000000000000000000000000000000000000000000").slice(0, 12), container_name: `bittune-${instanceId}`,
    deployment_preset_id: "meteor-vllm", deployment_preset_version: "v1", model_id: model.model_id, model_revision: model.model_revision,
    runtime_kind: "vllm", runtime_image_repository: model.runtime_image_repository, runtime_image_digest: model.runtime_image_digest, runtime_capability_version: VLLM_CAPABILITY_VERSION,
    endpoint_url: `http://127.0.0.1:${port}`, port, serving_configuration: servingConfiguration,
    config_hash: sha256(canonicalJson({ instanceId, servingConfiguration })), created_at: new Date().toISOString(), observation: { desired_state: "running", observed_state: "running", observed_at: new Date().toISOString(), freshness: "fresh", state_generation: 1 }, ...(owner ? { owner } : {}),
  };
}

function sglangServiceManifest(instanceId: string, port: number, servingConfiguration = materializeSglangConfiguration({ context_length: 4096, max_running_requests: 4, chunked_prefill_size: 4096, mem_fraction_static: 0.8, gpu_device_ids: [0] }), owner?: ServiceManifest["owner"]): ServiceManifest {
  return {
    schema_version: 3, instance_id: instanceId, service_name: instanceId, container_id: (instanceId + "000000000000000000000000000000000000000000000000000000000000").slice(0, 12), container_name: `bittune-${instanceId}`,
    deployment_preset_id: "meteor-sglang", deployment_preset_version: "v1", model_id: model.model_id, model_revision: model.model_revision,
    runtime_kind: "sglang", runtime_image_repository: "registry.example/acme/sglang", runtime_image_digest: model.runtime_image_digest, runtime_capability_version: SGLANG_CAPABILITY_VERSION,
    endpoint_url: `http://127.0.0.1:${port}`, port, serving_configuration: servingConfiguration,
    config_hash: sglangConfigurationFingerprint(servingConfiguration), created_at: new Date().toISOString(), observation: { desired_state: "running", observed_state: "running", observed_at: new Date().toISOString(), freshness: "fresh", state_generation: 1 }, ...(owner ? { owner } : {}),
  };
}

test("registry exposes generic atomic tools", () => {
  const tools = createToolRegistry(join(tmpdir(), "bittune-registry-test"));
  assert.deepEqual(tools.map((tool) => tool.name), expectedNames);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, expectedNames.length);
  assert.equal(tools.some((tool) => /qwen|5090/i.test(tool.name)), false);
  assert.equal(CAPABILITY_TOOL_NAMES.serving.includes("observe_runtime_capability"), true);
  assert.equal(CAPABILITY_TOOL_NAMES.deployment.includes("observe_runtime_capability"), false);
  for (const names of Object.values(CAPABILITY_TOOL_NAMES)) {
    assert.ok(JSON.stringify(tools.filter((tool) => names.includes(tool.name)).map((tool) => ({ description: tool.description, parameters: tool.parameters }))).length < 16_000);
  }
});

test("vLLM engine arguments follow the selected image CLI profile", () => {
  const defaults = materializeVllmConfiguration({});
  assert.deepEqual({ max_model_len: defaults.max_model_len, max_num_seqs: defaults.max_num_seqs, max_num_batched_tokens: defaults.max_num_batched_tokens, gpu_memory_utilization: defaults.gpu_memory_utilization }, { max_model_len: 8192, max_num_seqs: 4, max_num_batched_tokens: 4096, gpu_memory_utilization: 0.8 });
  const modernImageFlags = ["--model", "--served-model-name", "--host", "--port", "--dtype", "--tensor-parallel-size", "--pipeline-parallel-size", "--max-model-len", "--max-num-seqs", "--max-num-batched-tokens", "--gpu-memory-utilization", "--enable-prefix-caching"];
  const args = compileVllmEngineArgs(defaults, modernImageFlags);
  assert.equal(args.includes("--swap-space"), false);
  assert.equal(args.includes("--enable-prefix-caching"), true);

  const legacyImageFlags = [...modernImageFlags, "--swap-space", "--enforce-eager"];
  assert.equal(compileVllmEngineArgs(defaults, legacyImageFlags).includes("--swap-space"), true);
  assert.throws(() => compileVllmEngineArgs(materializeVllmConfiguration({ swap_space_gib: 8 }), modernImageFlags), (error: unknown) => (error as { stable?: { code?: string } }).stable?.code === "runtime_cli_incompatible");
  assert.throws(() => compileVllmEngineArgs(materializeVllmConfiguration({ enforce_eager: true }), modernImageFlags), (error: unknown) => (error as { stable?: { code?: string } }).stable?.code === "runtime_cli_incompatible");
});

test("OptimizationAttempt requires an exact observed GPU index to UUID mapping", () => {
  const environment = { gpus: [{ index: 0, uuid: "GPU-zero" }, { index: 1, uuid: "GPU-one" }] };
  validateAttemptGpuConfiguration(environment, configuration, ["GPU-zero"]);
  assert.throws(() => validateAttemptGpuConfiguration(environment, configuration, ["GPU-one"]), (error: unknown) => (error as { stable?: { code?: string } }).stable?.code === "optimization_gpu_lease_mismatch");
  assert.throws(() => validateAttemptGpuConfiguration(environment, materializeVllmConfiguration({}), ["GPU-zero"]), (error: unknown) => (error as { stable?: { code?: string } }).stable?.code === "optimization_gpu_devices_required");
});

test("SGLang configuration remains runtime-specific and follows the selected image CLI profile", async () => {
  const defaults = materializeSglangConfiguration({});
  const supportedFlags = ["--model-path", "--served-model-name", "--host", "--port", "--dtype", "--tp-size", "--context-length", "--max-running-requests", "--chunked-prefill-size", "--mem-fraction-static", "--disable-radix-cache"];
  const args = compileSglangEngineArgs(defaults, supportedFlags);
  assert.equal(args.includes("--disable-cuda-graph"), false);
  assert.equal(args.includes("--disable-radix-cache"), false);
  assert.throws(() => compileSglangEngineArgs(materializeSglangConfiguration({ disable_cuda_graph: true }), supportedFlags), (error: unknown) => (error as { stable?: { code?: string } }).stable?.code === "runtime_cli_incompatible");
  assert.throws(() => materializeSglangConfiguration({ max_num_seqs: 4 }), (error: unknown) => (error as { stable?: { code?: string } }).stable?.code === "unsupported_serving_parameter");

  const root = await mkdtemp(join(tmpdir(), "bittune-sglang-preset-"));
  try {
    const preset = await publishSglangPreset(root);
    assert.equal((preset as Record<string, unknown>).preset_id, "meteor-sglang");
    const capability = await invoke(root, "inspect_runtime_capabilities", { runtime_kind: "sglang", deployment_preset_id: "meteor-sglang" });
    assert.equal(capability.ok, true);
    assert.equal(capability.data?.runtime_kind, "sglang");
    assert.equal(capability.data?.capability_version, SGLANG_CAPABILITY_VERSION);
    assert.equal(createToolRegistry(root).some((tool) => tool.name.includes("_vllm_")), false);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("serving fails fast with Docker evidence when a container exits before Ready", { skip: process.platform === "win32" ? "Docker CLI shims cannot be spawned without a native executable on Windows." : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "bittune-serving-docker-"));
  const cacheRoot = join(root, "cache");
  const previousPath = process.env.PATH;
  const previousCacheRoots = process.env.BITTUNE_MODEL_CACHE_ROOTS;
  const previousDockerLog = process.env.BITTUNE_TEST_FAKE_DOCKER_LOG;
  try {
    const docker = await installExitedDockerFixture(root);
    process.env.PATH = `${docker.bin}${delimiter}${previousPath ?? ""}`;
    process.env.BITTUNE_MODEL_CACHE_ROOTS = cacheRoot;
    process.env.BITTUNE_TEST_FAKE_DOCKER_LOG = docker.log;
    const snapshot = join(cacheRoot, "hub", "models--acme--meteor-8b", "snapshots", model.model_revision);
    await mkdir(snapshot, { recursive: true });
    await writeFile(join(snapshot, "model.safetensors"), "fixture");
    await publishGenericPreset(root);

    const unobserved = await invoke(root, "start_managed_service", { deployment_preset_id: "meteor-vllm", service_name: "meteor", port: 18080 });
    assert.equal(unobserved.ok, false);
    assert.equal(unobserved.error?.code, "runtime_capability_observation_required");
    const capabilityObservation = await invoke(root, "observe_runtime_capability", { deployment_preset_id: "meteor-vllm" });
    assert.equal(capabilityObservation.ok, true, JSON.stringify(capabilityObservation));
    const started = await invoke(root, "start_managed_service", { deployment_preset_id: "meteor-vllm", service_name: "meteor", port: 18080 });
    assert.equal(started.ok, false);
    assert.equal(started.error?.code, "container_start_failed", await readFile(docker.log, "utf8"));
    const store = new StateStore(root);
    const [service] = await store.listRuntimeServices();
    assert.ok(service);
    assert.equal(service.observation.observed_state, "exited");
    assert.equal(service.runtime_cli_profile?.version, "0.27.1");
    assert.equal(service.runtime_engine_args?.includes("--swap-space"), false);
    const { observation } = await store.getRun(started.run_id);
    assert.equal(observation.artifacts.some((artifact) => artifact.label === "docker-start-failure-logs"), true);

    const readyStarted = Date.now();
    const ready = await invoke(root, "wait_for_managed_service_ready", { instance_id: service.instance_id, timeout_seconds: 30 });
    assert.equal(ready.ok, true);
    assert.equal(ready.data?.ready, false);
    assert.equal(ready.data?.failure_kind, "container_not_running");
    assert.ok(Date.now() - readyStarted < 2_000);
    const dockerCalls = (await readFile(docker.log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    const launch = dockerCalls.find((args) => args[0] === "run" && args.includes("-d"));
    assert.ok(launch);
    assert.equal(launch.includes("--swap-space"), false);

    await publishSglangPreset(root);
    const sglangCapabilityObservation = await invoke(root, "observe_runtime_capability", { deployment_preset_id: "meteor-sglang" });
    assert.equal(sglangCapabilityObservation.ok, true, JSON.stringify(sglangCapabilityObservation));
    const sglangStarted = await invoke(root, "start_managed_service", { deployment_preset_id: "meteor-sglang", service_name: "meteor-sglang", port: 18081 });
    assert.equal(sglangStarted.ok, false);
    assert.equal(sglangStarted.error?.code, "container_start_failed", await readFile(docker.log, "utf8"));
    const sglangService = (await store.listRuntimeServices()).find((service) => service.runtime_kind === "sglang");
    assert.ok(sglangService);
    assert.equal(sglangService.runtime_cli_profile?.version, "0.5.0");
    assert.equal(sglangService.runtime_cli_profile?.entrypoint, "python3 -m sglang.launch_server");
    const genericReady = await invoke(root, "wait_for_managed_service_ready", { instance_id: sglangService.instance_id, timeout_seconds: 30 });
    assert.equal(genericReady.ok, true);
    assert.equal(genericReady.data?.ready, false);
    const allDockerCalls = (await readFile(docker.log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    const sglangLaunch = allDockerCalls.find((args) => args[0] === "run" && args.includes("-d") && args.includes("sglang.launch_server"));
    assert.ok(sglangLaunch);
    const entrypointIndex = sglangLaunch.indexOf("--entrypoint");
    assert.deepEqual(sglangLaunch.slice(entrypointIndex, entrypointIndex + 5), ["--entrypoint", "python3", `registry.example/acme/sglang@${model.runtime_image_digest}`, "-m", "sglang.launch_server"]);
    assert.equal(sglangLaunch.includes("--tp-size"), true);
    store.close();
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousCacheRoots === undefined) delete process.env.BITTUNE_MODEL_CACHE_ROOTS; else process.env.BITTUNE_MODEL_CACHE_ROOTS = previousCacheRoots;
    if (previousDockerLog === undefined) delete process.env.BITTUNE_TEST_FAKE_DOCKER_LOG; else process.env.BITTUNE_TEST_FAKE_DOCKER_LOG = previousDockerLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("static capability entry registers the generic tool registry", async () => {
  const registered: string[] = [];
  bittuneExtension({ registerTool: (tool: ToolDefinition) => registered.push(tool.name), on: () => undefined } as never);
  assert.deepEqual(registered, expectedNames);
});

test("unknown Bash changes invalidate managed service observations without creating a Run", async () => {
  const root = await mkdtemp(join(tmpdir(), "bittune-bash-state-"));
  let store: StateStore | undefined;
  try {
    store = new StateStore(root);
    const service = { ...serviceManifest("service-bash-state", 18002), observation: { desired_state: "running" as const, observed_state: "running", observed_at: new Date().toISOString(), freshness: "fresh" as const, state_generation: 1 } };
    await store.saveRuntimeService(service);
    let toolResult: ((event: unknown) => Promise<unknown>) | undefined;
    createBittuneExtension({ stateRoot: root })({
      registerTool: () => undefined,
      setActiveTools: () => undefined,
      appendEntry: () => undefined,
      on: (event: string, handler: (event: unknown) => Promise<unknown>) => { if (event === "tool_result") toolResult = handler; },
    } as never);
    assert.ok(toolResult);
    await toolResult!({ type: "tool_result", toolName: "bash", toolCallId: "readonly", input: { command: "nvidia-smi" }, content: [], details: undefined, isError: false });
    assert.equal((await store.getRuntimeService(service.instance_id)).observation?.freshness, "fresh");
    await toolResult!({ type: "tool_result", toolName: "bash", toolCallId: "mutating", input: { command: "docker container stop external-service" }, content: [], details: undefined, isError: false });
    assert.equal((await store.getRuntimeService(service.instance_id)).observation?.freshness, "stale");
    assert.deepEqual(await store.listRuns({ tool_name: "bash" }), []);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("canonical system prompt is tool-set independent and defers availability to Tool definitions", () => {
  assert.equal(BITTUNE_SYSTEM_PROMPT.includes(BITTUNE_SYSTEM_PROMPT_MARKER), true);
  assert.match(BITTUNE_SYSTEM_PROMPT, /conversational inference-engineering Agent/);
  assert.match(BITTUNE_SYSTEM_PROMPT, /External MCP knowledge is optional/);
  assert.match(BITTUNE_SYSTEM_PROMPT, /do not require a user-facing workflow or capability switch/);
  assert.doesNotMatch(BITTUNE_SYSTEM_PROMPT, /Bash Run Record/);
  assert.doesNotMatch(BITTUNE_SYSTEM_PROMPT, /activate_capability/);
});

test("OptimizationContext binds to the Session and supplies optional internal context IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "bittune-optimization-session-binding-"));
  try {
    const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
    let toolCall: ((event: { toolName: string; input: Record<string, unknown> }, context: { sessionManager: { getBranch: () => readonly unknown[] } }) => Promise<void>) | undefined;
    let toolResult: ((event: unknown) => Promise<void>) | undefined;
    createBittuneExtension({ stateRoot: root })({
      registerTool: () => undefined,
      setActiveTools: () => undefined,
      appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
      on: (event: string, handler: never) => {
        if (event === "tool_call") toolCall = handler as typeof toolCall;
        if (event === "tool_result") toolResult = handler as typeof toolResult;
      },
    } as never);
    assert.ok(toolResult); assert.ok(toolCall);
    await toolResult!({ type: "tool_result", toolName: "create_optimization_context", toolCallId: "created", input: { context_id: "bound-context" }, content: [], details: undefined, isError: false });
    assert.equal(entries.at(-1)?.customType, ACTIVE_OPTIMIZATION_CONTEXT_SESSION_ENTRY);
    const call = { toolName: "create_optimization_candidate", input: { candidate_id: "candidate" } as Record<string, unknown> };
    await toolCall!(call, { sessionManager: { getBranch: () => entries } });
    assert.equal(call.input.context_id, "bound-context");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("all trusted domain tools remain available throughout a conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "bittune-capability-catalog-"));
  try {
    type SessionStartHandler = (event: unknown, context: { sessionManager: { getBranch: () => readonly unknown[] } }) => Promise<void>;
    const registered = new Map<string, ToolDefinition>();
    const activeToolSets: string[][] = [];
    let sessionStart: SessionStartHandler | undefined;
    bittuneExtension({
      registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool),
      setActiveTools: (names: string[]) => activeToolSets.push(names),
      on: (event: string, handler: SessionStartHandler) => {
        if (event === "session_start") sessionStart = handler;
      },
    } as never);

    assert.ok(sessionStart);
    await sessionStart!({ type: "session_start" }, { sessionManager: { getBranch: () => [] } });
    assert.deepEqual([...registered.keys()], expectedNames);
    assert.deepEqual(activeToolSets.at(-1), ["read", "bash", ...expectedNames]);
    assert.equal(registered.has("activate_capability"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model discovery accepts contained Hugging Face cache symlinks and rejects escaped targets", { skip: process.platform === "win32" ? "Creating cache symlinks requires elevated Windows privileges." : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "bittune-model-symlink-"));
  const cacheRoot = join(root, "cache");
  const hubRoot = join(cacheRoot, "hub");
  const revision = "1".repeat(40);
  const previousCacheRoots = process.env.BITTUNE_MODEL_CACHE_ROOTS;
  try {
    const blobs = join(cacheRoot, "hub", "models--acme--meteor-8b", "blobs");
    const snapshot = join(cacheRoot, "hub", "models--acme--meteor-8b", "snapshots", revision);
    await mkdir(blobs, { recursive: true });
    await mkdir(snapshot, { recursive: true });
    const weights = join(blobs, "weights");
    const config = join(blobs, "config");
    await writeFile(weights, "weights");
    await writeFile(config, JSON.stringify({ architectures: ["MeteorForCausalLM"] }));
    await symlink(weights, join(snapshot, "model.safetensors"));
    await symlink(config, join(snapshot, "config.json"));

    const escapedSnapshot = join(cacheRoot, "hub", "models--acme--escaped", "snapshots", revision);
    const escapedWeights = join(root, "outside.safetensors");
    await mkdir(escapedSnapshot, { recursive: true });
    await writeFile(escapedWeights, "outside");
    await symlink(escapedWeights, join(escapedSnapshot, "model.safetensors"));

    process.env.BITTUNE_MODEL_CACHE_ROOTS = hubRoot;
    const discovered = await invoke(root, "list_local_model_artifacts", {});
    assert.equal(discovered.ok, true, JSON.stringify(discovered));
    const artifacts = discovered.data?.artifacts as Array<Record<string, unknown>>;
    assert.equal(artifacts.some((artifact) => artifact.model_id === "acme/meteor-8b" && artifact.revision === revision && artifact.cache_kind === "huggingface"), true);
    assert.equal(artifacts.some((artifact) => artifact.model_id === "acme/escaped"), false);
    const store = new StateStore(root);
    try {
      const preset = {
        schema_version: 3 as const, preset_id: "symlink-snapshot", version: "v1", model_id: "acme/meteor-8b", model_revision: revision,
        runtime_kind: "vllm" as const, runtime_image_repository: model.runtime_image_repository, runtime_image_digest: model.runtime_image_digest,
        serving_configuration: configuration, source_run_ids: [], created_at: new Date().toISOString(), source: "published" as const, content_hash: "",
      };
      assert.deepEqual(await store.resolveModelSnapshot(preset), { cache_root: hubRoot, host_snapshot_path: snapshot });
      assert.equal(await store.resolveModelSnapshot({ ...preset, preset_id: "escaped-snapshot", model_id: "acme/escaped" }), undefined);
    } finally {
      store.close();
    }
  } finally {
    if (previousCacheRoots === undefined) delete process.env.BITTUNE_MODEL_CACHE_ROOTS; else process.env.BITTUNE_MODEL_CACHE_ROOTS = previousCacheRoots;
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh extension preserves ordinary planning while blocking historical evidence readers", async () => {
  const root = await mkdtemp(join(tmpdir(), "bittune-fresh-extension-"));
  try {
    type Handler = (event: { toolName?: string; input?: Record<string, unknown> }, context: { sessionManager: { getBranch: () => readonly unknown[] } }) => Promise<unknown>;
    const activeToolSets: string[][] = [];
    let sessionStart: Handler | undefined;
    let toolCall: Handler | undefined;
    createBittuneExtension({ stateRoot: root, freshExperiment: true })({
      registerTool: () => undefined,
      setActiveTools: (names: string[]) => activeToolSets.push(names),
      appendEntry: () => undefined,
      on: (event: string, handler: Handler) => {
        if (event === "session_start") sessionStart = handler;
        if (event === "tool_call") toolCall = handler;
      },
    } as never);
    assert.ok(sessionStart); assert.ok(toolCall);
    await sessionStart!({}, { sessionManager: { getBranch: () => [] } });
    assert.deepEqual(activeToolSets.at(-1), ["read", "bash", ...expectedNames.filter((name) => !HISTORICAL_EVIDENCE_TOOL_NAMES.includes(name as typeof HISTORICAL_EVIDENCE_TOOL_NAMES[number]))]);
    const blocked = await toolCall!({ toolName: "list_run_records", input: {} }, { sessionManager: { getBranch: () => [] } });
    assert.deepEqual(blocked, { block: true, reason: "This fresh experiment does not read prior Run records or Artifact excerpts. Use evidence created in this session and pass the returned IDs directly.", terminate: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("benchmark preflight fails precisely when EvalScope cannot report a version", async () => {
  const root = await mkdtemp(join(tmpdir(), "bittune-evalscope-preflight-"));
  let store: StateStore | undefined;
  const previousPath = process.env.PATH;
  try {
    await publishGenericPreset(root); store = new StateStore(root); await store.saveRuntimeService(serviceManifest("evalscope-preflight", 18091));
    process.env.PATH = "";
    const result = await invoke(root, "run_performance_test", { instance_id: "evalscope-preflight", ...workload });
    assert.equal(result.ok, false); assert.equal(result.error?.code, "evalscope_unavailable");
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    store?.close(); await rm(root, { recursive: true, force: true });
  }
});

test("generic DeploymentPreset persists finite configuration and rejects unknown settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "bittune-preset-"));
  try {
    const listed = await invoke(root, "list_deployment_presets", {});
    assert.deepEqual(listed.data?.presets, []);
    const published = await publishGenericPreset(root);
    assert.equal(published.version, "v1");
    const preset = await invoke(root, "get_deployment_preset", { preset_id: "meteor-vllm" });
    assert.equal(preset.data?.model_id, model.model_id);
    assert.equal((preset.data?.serving_configuration as Record<string, unknown>).max_num_seqs, 4);
    const invalid = await invoke(root, "publish_deployment_preset", { preset_id: "unsafe", model_id: "acme/test", model_revision: model.model_revision, runtime_kind: "vllm", runtime_image_repository: model.runtime_image_repository, runtime_image_digest: model.runtime_image_digest, serving_configuration: { arbitrary_engine_arg: "--unsafe" } });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error?.code, "unsupported_serving_parameter");
    const denied = await invoke(root, "publish_deployment_preset", { preset_id: "denied", model_id: "acme/test", model_revision: model.model_revision, runtime_kind: "vllm", runtime_image_repository: "registry.invalid/acme/vllm", runtime_image_digest: model.runtime_image_digest });
    assert.equal(denied.ok, false);
    assert.equal(denied.error?.code, "runtime_repository_not_allowed");
    const multiGpu = await invoke(root, "publish_deployment_preset", { preset_id: "many-gpu", model_id: "acme/many-gpu", model_revision: "main", runtime_kind: "vllm", runtime_image_repository: "registry.example:5000/acme/vllm", runtime_image_digest: model.runtime_image_digest, serving_configuration: { tensor_parallel_size: 12, gpu_device_ids: Array.from({ length: 12 }, (_, index) => index), max_model_len: 524288, max_num_batched_tokens: 524288 } });
    assert.equal(multiGpu.ok, true, JSON.stringify(multiGpu));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("publish_deployment_preset succeeds without a Runtime policy file", async () => {
  const root = await mkdtemp(join(tmpdir(), "bittune-no-policy-"));
  const previous = process.env.BITTUNE_RUNTIME_POLICY_FILE;
  process.env.BITTUNE_RUNTIME_POLICY_FILE = join(root, "nonexistent-policy.json");
  try {
    const result = await invoke(root, "publish_deployment_preset", {
      preset_id: "no-policy-test", model_id: model.model_id, model_revision: model.model_revision,
      runtime_kind: "vllm", runtime_image_repository: "custom-registry/my-vllm",
      runtime_image_digest: model.runtime_image_digest,
      serving_configuration: { max_model_len: 4096, gpu_device_ids: [0] },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((result.data as Record<string, unknown>).version, "v1");
  } finally {
    process.env.BITTUNE_RUNTIME_POLICY_FILE = previous;
    await rm(root, { recursive: true, force: true });
  }
});
test("inspect_runtime_policy reports unrestricted when no policy file exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "bittune-no-policy-"));
  const previous = process.env.BITTUNE_RUNTIME_POLICY_FILE;
  process.env.BITTUNE_RUNTIME_POLICY_FILE = join(root, "nonexistent-policy.json");
  try {
    const result = await invoke(root, "inspect_runtime_policy", {});
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((result.data as Record<string, unknown>).unrestricted, true);
  } finally {
    process.env.BITTUNE_RUNTIME_POLICY_FILE = previous;
    await rm(root, { recursive: true, force: true });
  }
});
test("Capability is explicit and local model discovery parses only allowed metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "bittune-discovery-"));
  const cacheRoot = join(root, "cache"); const previous = process.env.BITTUNE_MODEL_CACHE_ROOTS; process.env.BITTUNE_MODEL_CACHE_ROOTS = cacheRoot;
  try {
    const snapshot = join(cacheRoot, "hub", "models--acme--meteor-8b", "snapshots", model.model_revision);
    await mkdir(snapshot, { recursive: true }); await writeFile(join(snapshot, "model.safetensors"), "fixture");
    await writeFile(join(snapshot, "config.json"), JSON.stringify({ architectures: ["MeteorForCausalLM"], torch_dtype: "bfloat16", max_position_embeddings: 32768, quantization_config: { quant_method: "awq" } }));
    await writeFile(join(snapshot, "tokenizer_config.json"), JSON.stringify({ tokenizer_class: "MeteorTokenizer", chat_template: "{{ messages }}", token: "must-not-leak" }));
    await writeFile(join(snapshot, "generation_config.json"), JSON.stringify({ max_new_tokens: 512 })); await writeFile(join(snapshot, "model.safetensors.index.json"), JSON.stringify({ weight_map: { "a": "model.safetensors" } }));
    const artifacts = await invoke(root, "list_local_model_artifacts", {}); const artifact = (artifacts.data?.artifacts as Array<Record<string, unknown>>)[0]!;
    assert.equal(artifact.model_id, model.model_id); assert.equal((artifact.metadata as Record<string, unknown>).architecture, "MeteorForCausalLM"); assert.equal((artifact.metadata as Record<string, unknown>).quantization, "awq"); assert.equal((artifact.metadata as Record<string, unknown>).chat_template_available, true); assert.equal(JSON.stringify(artifact).includes("must-not-leak"), false); assert.match(String(artifact.metadata_fingerprint), /^sha256:/);
    const secondRevision = "f".repeat(40); const secondSnapshot = join(cacheRoot, "hub", "models--acme--meteor-8b", "snapshots", secondRevision);
    await mkdir(secondSnapshot, { recursive: true }); await writeFile(join(secondSnapshot, "model.safetensors"), "fixture");
    const selected = await invoke(root, "list_local_model_artifacts", { model_id: model.model_id, model_revision: secondRevision });
    assert.equal((selected.data?.artifacts as Array<Record<string, unknown>>).length, 1); assert.equal((selected.data?.artifacts as Array<Record<string, unknown>>)[0]?.revision, secondRevision);
    const preset = await publishGenericPreset(root);
    const snapshotStore = new StateStore(root);
    const resolved = await snapshotStore.resolveModelSnapshot({
      schema_version: 3, preset_id: preset.preset_id, version: preset.version, model_id: model.model_id, model_revision: model.model_revision,
      runtime_kind: "vllm", runtime_image_repository: model.runtime_image_repository, runtime_image_digest: model.runtime_image_digest,
      serving_configuration: configuration, source_run_ids: [], created_at: new Date().toISOString(), source: "published", content_hash: "",
    });
    snapshotStore.close();
    assert.deepEqual(resolved, { cache_root: cacheRoot, host_snapshot_path: snapshot });
    const capability = await invoke(root, "inspect_runtime_capabilities", { runtime_kind: "vllm" }); assert.equal(capability.ok, true); assert.equal(capability.data?.capability_version, VLLM_CAPABILITY_VERSION); assert.ok(Array.isArray(capability.data?.parameters));
  } finally { if (previous === undefined) delete process.env.BITTUNE_MODEL_CACHE_ROOTS; else process.env.BITTUNE_MODEL_CACHE_ROOTS = previous; await rm(root, { recursive: true, force: true }); }
});

test("managed endpoint probe rejects malformed, wrong-model, and empty completions", async () => {
  const root = await mkdtemp(join(tmpdir(), "bittune-probe-validation-"));
  let mode: "malformed" | "wrong-model" | "empty" = "malformed";
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    if (mode === "malformed") response.end("not-json");
    else if (mode === "wrong-model") response.end(JSON.stringify({ model: "other-model", choices: [{ message: { content: "OK" } }] }));
    else response.end(JSON.stringify({ model: model.model_id, choices: [{ message: { content: "" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const port = (address as { port: number }).port;
  try {
    const store = new StateStore(root);
    await store.saveRuntimeService(serviceManifest("probe-validation", port));
    for (const expected of ["malformed", "wrong-model", "empty"] as const) {
      mode = expected;
      const result = await invoke(root, "probe_managed_endpoint", { instance_id: "probe-validation" });
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, "endpoint_invalid_response");
    }
    store.close();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("capacity derivation publishes an evidence-backed operating point without a maximum claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "bittune-capacity-"));
  try {
    await publishGenericPreset(root); const store = new StateStore(root); const service = serviceManifest("service-reference", 18000); await store.saveRuntimeService(service);
    const environment = { host_id: "gpu-fixture", gpus: [{ uuid: "GPU-any", name: "Any NVIDIA GPU", driver_version: "600.0", compute_capability: "9.0", memory_total_bytes: 48 * 1024 ** 3 }], compute_processes: [] };
    const envRun = await completedRun(store, "inspect_gpu", environment); const serviceRun = await completedRun(store, "inspect_managed_service", { service: { ...service, current_container_state: { status: "running", running: true } } }); const probeRun = await completedRun(store, "probe_managed_endpoint", { instance_id: service.instance_id, response_model_id: model.model_id }); const benchmarkRun = await completedRun(store, "run_performance_test", { service_instance_id: service.instance_id, requested: workload, metrics: { success_rate: 1, requests_per_second: 18 }, observed_gpu_memory_peak_bytes: 12 * 1024 ** 3 });
    const candidate = await invoke(root, "derive_capacity_baseline", { deployment_preset_id: "meteor-vllm", source_run_ids: [envRun, serviceRun, probeRun, benchmarkRun] }); assert.equal(candidate.ok, true, JSON.stringify(candidate)); const operatingPoint = (candidate.data?.operating_points as Array<Record<string, unknown>> | undefined)?.[0]; assert.equal(operatingPoint?.verification_status, "verified");
    const published = await invoke(root, "publish_capacity_baseline", { candidate_run_id: candidate.run_id, candidate_hash: candidate.data?.candidate_hash }); assert.equal(published.ok, true, JSON.stringify(published)); assert.equal((published.data?.operating_points as Array<unknown>).length, 1); assert.equal("validated_max_context_tokens" in (published.data ?? {}), false);
    const duplicateEnvironment = await completedRun(store, "inspect_gpu", environment); const duplicateEvidence = await invoke(root, "derive_capacity_baseline", { deployment_preset_id: "meteor-vllm", source_run_ids: [envRun, duplicateEnvironment, serviceRun, probeRun, benchmarkRun] }); assert.equal(duplicateEvidence.ok, false); assert.equal(duplicateEvidence.error?.code, "evidence_conflict");
    const insufficientBenchmark = await completedRun(store, "run_performance_test", { service_instance_id: service.instance_id, requested: workload, metrics: { success_rate: 0.9, requests_per_second: 18 } }); const insufficient = await invoke(root, "derive_capacity_baseline", { deployment_preset_id: "meteor-vllm", source_run_ids: [envRun, serviceRun, probeRun, insufficientBenchmark] }); assert.equal(insufficient.data?.operating_points && (insufficient.data.operating_points as Array<Record<string, unknown>>)[0]?.verification_status, "validation_required"); const rejected = await invoke(root, "publish_capacity_baseline", { candidate_run_id: insufficient.run_id, candidate_hash: insufficient.data?.candidate_hash }); assert.equal(rejected.ok, false); assert.equal(rejected.error?.code, "evidence_incomplete"); store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SGLang uses generic managed-service evidence for capacity and experiment trials", async () => {
  const root = await mkdtemp(join(tmpdir(), "bittune-sglang-evidence-"));
  let store: StateStore | undefined;
  try {
    await publishSglangPreset(root);
    store = new StateStore(root);
    const activeStore = store;
    const reference = sglangServiceManifest("sglang-reference", 18010);
    await activeStore.saveRuntimeService(reference);
    const environment = { host_id: "gpu-fixture", gpus: [{ uuid: "GPU-any", name: "Any GPU", driver_version: "600.0", compute_capability: "9.0", memory_total_bytes: 48 * 1024 ** 3 }], compute_processes: [] as Array<{ gpu_uuid: string; pid: number; process_name: string; memory_bytes: number }> };
    const baseline = await completedRun(activeStore, "inspect_gpu", environment);
    const serviceRun = await completedRun(activeStore, "inspect_managed_service", { service: { ...reference, current_container_state: { status: "running", running: true } } });
    const probe = await completedRun(activeStore, "probe_managed_endpoint", { instance_id: reference.instance_id, response_model_id: model.model_id });
    const benchmark = await completedRun(activeStore, "run_performance_test", { service_instance_id: reference.instance_id, requested: workload, metrics: { success_rate: 1, requests_per_second: 10 }, observed_gpu_memory_peak_bytes: 10 * 1024 ** 3 });
    const capacity = await invoke(root, "derive_capacity_baseline", { deployment_preset_id: "meteor-sglang", source_run_ids: [baseline, serviceRun, probe, benchmark] });
    assert.equal(capacity.ok, true, JSON.stringify(capacity));
    const point = (capacity.data?.operating_points as Array<Record<string, unknown>>)[0]!;
    assert.equal(point.configuration_fingerprint, sglangConfigurationFingerprint(reference.serving_configuration));

    const invalidSpec = await invoke(root, "publish_experiment_spec", { experiment_id: "sglang-invalid", experiment_kind: "runtime_tuning", deployment_preset_id: "meteor-sglang", deployment_preset_version: "v1", reference_service_instance_id: reference.instance_id, baseline_environment_run_id: baseline, objective_metric: "requests_per_second", constraints: {}, workload, allowed_parameters: { pipeline_parallel_size: { minimum: 1, maximum: 2 } }, budget: { max_trials: 2, max_total_duration_seconds: 600, max_failures: 1 }, minimum_improvement_percent: 5, required_repetitions: 1 });
    assert.equal(invalidSpec.ok, false);
    assert.equal(invalidSpec.error?.code, "unsupported_serving_parameter");

    const spec = await invoke(root, "publish_experiment_spec", { experiment_id: "sglang-tuning", experiment_kind: "runtime_tuning", deployment_preset_id: "meteor-sglang", deployment_preset_version: "v1", reference_service_instance_id: reference.instance_id, baseline_environment_run_id: baseline, objective_metric: "requests_per_second", constraints: { min_success_rate: 0.95 }, workload, allowed_parameters: { max_running_requests: { minimum: 4, maximum: 8 } }, budget: { max_trials: 2, max_total_duration_seconds: 600, max_failures: 1 }, minimum_improvement_percent: 5, required_repetitions: 1 });
    assert.equal(spec.ok, true, JSON.stringify(spec));
    const candidateConfiguration = materializeSglangConfiguration({ ...reference.serving_configuration, max_running_requests: 8 });
    const candidate = sglangServiceManifest("sglang-candidate", 18011, candidateConfiguration, { kind: "experiment", experiment_id: "sglang-tuning", experiment_version: "v1" });
    await activeStore.saveRuntimeService(candidate);
    const pre = await completedRun(activeStore, "inspect_gpu", environment);
    const post = await completedRun(activeStore, "inspect_gpu", environment);
    const candidateServiceRun = await completedRun(activeStore, "start_managed_service", { service: { ...candidate, current_container_state: { status: "running", running: true } } });
    const candidateProbe = await completedRun(activeStore, "probe_managed_endpoint", { instance_id: candidate.instance_id, response_model_id: model.model_id });
    const candidateBenchmark = await completedRun(activeStore, "run_performance_test", { service_instance_id: candidate.instance_id, requested: workload, metrics: { success_rate: 1, requests_per_second: 12 }, observed_gpu_memory_peak_bytes: 10 * 1024 ** 3 });
    const trial = await invoke(root, "record_experiment_trial", { experiment_id: "sglang-tuning", serving_configuration: { max_running_requests: 8 }, workload, pre_environment_run_id: pre, post_environment_run_id: post, service_run_id: candidateServiceRun, probe_run_id: candidateProbe, benchmark_run_id: candidateBenchmark });
    assert.equal(trial.ok, true, JSON.stringify(trial));
    assert.equal(trial.data?.result_class, "valid");
    assert.equal(trial.data?.configuration_hash, sglangConfigurationFingerprint(candidateConfiguration));
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v3 optimization ledger enforces evaluation and GPU leases without hidden execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "bittune-optimization-ledger-"));
  let store: StateStore | undefined;
  try {
    await publishGenericPreset(root); store = new StateStore(root); const activeStore = store; const reference = serviceManifest("ledger-reference", 18020); await activeStore.saveRuntimeService(reference);
    const environment = { host_id: "gpu-fixture", gpus: [{ index: 0, uuid: "GPU-ledger", name: "Any GPU", driver_version: "600.0", compute_capability: "9.0", memory_total_bytes: 48 * 1024 ** 3 }], compute_processes: [] as Array<{ gpu_uuid: string; pid: number; process_name: string; memory_bytes: number }> }; const baseline = await completedRun(activeStore, "inspect_gpu", environment);
    const spec = await invoke(root, "publish_experiment_spec", { experiment_id: "ledger-experiment", experiment_kind: "runtime_tuning", deployment_preset_id: "meteor-vllm", deployment_preset_version: "v1", reference_service_instance_id: reference.instance_id, baseline_environment_run_id: baseline, objective_metric: "requests_per_second", constraints: {}, workload, allowed_parameters: { max_num_seqs: { minimum: 4, maximum: 8 } }, budget: { max_trials: 3, max_total_duration_seconds: 600, max_failures: 1 }, minimum_improvement_percent: 5, required_repetitions: 1 }); assert.equal(spec.ok, true, JSON.stringify(spec));
    const context = await invoke(root, "create_optimization_context", { context_id: "ledger-context", title: "Ledger smoke", experiment_id: "ledger-experiment", experiment_version: "v1" }); assert.equal(context.ok, true, JSON.stringify(context));
    const candidate = await invoke(root, "create_optimization_candidate", { context_id: "ledger-context", candidate_id: "ledger-candidate", serving_configuration: { max_num_seqs: 8 }, workload }); assert.equal(candidate.ok, true, JSON.stringify(candidate));
    const frozenParameter = await invoke(root, "create_optimization_candidate", { context_id: "ledger-context", candidate_id: "ledger-invalid", serving_configuration: { max_num_seqs: 8, gpu_memory_utilization: 0.7 }, workload }); assert.equal(frozenParameter.ok, false); assert.equal(frozenParameter.error?.code, "candidate_parameter_not_allowed");
    const expiry = new Date(Date.now() + 60_000).toISOString(); const attemptInput = { attempt_id: "ledger-attempt", context_id: "ledger-context", candidate_id: "ledger-candidate", environment_run_id: baseline, selected_gpu_uuids: ["GPU-ledger"], lease_id: "ledger-lease", lease_expires_at: expiry };
    const reserved = await invoke(root, "reserve_optimization_attempt", attemptInput); assert.equal(reserved.ok, true, JSON.stringify(reserved)); assert.equal(reserved.data?.state, "reserved");
    const expectedEnvironmentFingerprint = sha256(canonicalJson({ host_id: "gpu-fixture", gpus: [{ uuid: "GPU-ledger", name: "Any GPU", driver_version: "600.0", compute_capability: "9.0", memory_total_bytes: 48 * 1024 ** 3 }] }));
    assert.equal(reserved.data?.environment_fingerprint, expectedEnvironmentFingerprint);
    assert.equal(reserved.data?.evaluation_key, sha256(canonicalJson({ configuration_hash: candidate.data?.configuration_hash, environment_fingerprint: expectedEnvironmentFingerprint, workload_fingerprint: candidate.data?.workload_fingerprint })));
    const missingGpu = await invoke(root, "reserve_optimization_attempt", { ...attemptInput, attempt_id: "ledger-missing-gpu", selected_gpu_uuids: ["GPU-not-observed"], lease_id: "ledger-missing-gpu-lease" }); assert.equal(missingGpu.ok, false); assert.equal(missingGpu.error?.code, "selected_gpu_not_observed");
    const duplicate = await invoke(root, "reserve_optimization_attempt", { ...attemptInput, attempt_id: "ledger-attempt-two" }); assert.equal(duplicate.ok, false); assert.equal(duplicate.error?.code, "optimization_attempt_in_progress");
    const cleaned = await activeStore.updateOptimizationAttempt("ledger-attempt", { state: "cancelled", cleanup_status: "cleaned", run_ids: [baseline], failure_code: "user_cancelled" }); assert.equal(cleaned.cleanup_status, "cleaned");
    const measured = await invoke(root, "reserve_optimization_attempt", { ...attemptInput, attempt_id: "ledger-measured", lease_id: "ledger-measured-lease" }); assert.equal(measured.ok, true, JSON.stringify(measured));
    for (const state of ["starting", "ready", "probing", "benchmarking", "measured"] as const) { const result = await activeStore.updateOptimizationAttempt("ledger-measured", { state, ...(state === "measured" ? { cleanup_status: "cleaned" } : {}) }); assert.equal(result.state, state); }
    const retestBlocked = await invoke(root, "reserve_optimization_attempt", { ...attemptInput, attempt_id: "ledger-retest-blocked", lease_id: "ledger-retest-blocked-lease" }); assert.equal(retestBlocked.ok, false); assert.equal(retestBlocked.error?.code, "retest_reason_required");
    const retest = await invoke(root, "reserve_optimization_attempt", { ...attemptInput, attempt_id: "ledger-retest", lease_id: "ledger-retest-lease", retest_reason: "Validate a suspected thermal variance." }); assert.equal(retest.ok, true, JSON.stringify(retest));
    const cleanupPending = await activeStore.updateOptimizationAttempt("ledger-retest", { state: "starting" }); assert.equal(cleanupPending.state, "starting"); const failed = await activeStore.updateOptimizationAttempt("ledger-retest", { state: "failed", failure_code: "fixture_failure" }); assert.equal(failed.cleanup_status, "cleanup_pending");
    const blockedByCleanup = await invoke(root, "reserve_optimization_attempt", { ...attemptInput, attempt_id: "ledger-after-failure", lease_id: "ledger-after-failure-lease", retest_reason: "Attempt after cleanup." }); assert.equal(blockedByCleanup.ok, false); assert.equal(blockedByCleanup.error?.code, "optimization_cleanup_pending");
    const recovered = await invoke(root, "recover_optimization_attempt", { attempt_id: "ledger-retest", action: "stop_owned_service" }); assert.equal(recovered.ok, true, JSON.stringify(recovered)); assert.equal((recovered.data?.attempt as Record<string, unknown>).cleanup_status, "cleaned");
    const secondCandidate = await invoke(root, "create_optimization_candidate", { context_id: "ledger-context", candidate_id: "ledger-second-candidate", serving_configuration: { max_num_seqs: 6 }, workload }); assert.equal(secondCandidate.ok, true, JSON.stringify(secondCandidate));
    const overBudgetReservation = await invoke(root, "reserve_optimization_attempt", { ...attemptInput, attempt_id: "ledger-over-budget", candidate_id: "ledger-second-candidate", lease_id: "ledger-over-budget-lease" }); assert.equal(overBudgetReservation.ok, false); assert.equal(overBudgetReservation.error?.code, "budget_exhausted");
  } finally { store?.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test("optimization Attempt binds managed evidence to its Trial and requires cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "bittune-attempt-evidence-"));
  let store: StateStore | undefined;
  try {
    await publishGenericPreset(root); store = new StateStore(root); const activeStore = store;
    const reference = serviceManifest("attempt-reference", 18030); await activeStore.saveRuntimeService(reference);
    const environment = { host_id: "gpu-fixture", gpus: [{ index: 0, uuid: "GPU-attempt", name: "Any GPU", driver_version: "600.0", compute_capability: "9.0", memory_total_bytes: 48 * 1024 ** 3 }], compute_processes: [] as Array<{ gpu_uuid: string; pid: number; process_name: string; memory_bytes: number }> };
    const baseline = await completedRun(activeStore, "inspect_gpu", environment);
    const spec = await invoke(root, "publish_experiment_spec", { experiment_id: "attempt-evidence", experiment_kind: "runtime_tuning", deployment_preset_id: "meteor-vllm", deployment_preset_version: "v1", reference_service_instance_id: reference.instance_id, baseline_environment_run_id: baseline, objective_metric: "requests_per_second", constraints: {}, workload, allowed_parameters: { max_num_seqs: { minimum: 4, maximum: 8 } }, budget: { max_trials: 2, max_total_duration_seconds: 600, max_failures: 1 }, minimum_improvement_percent: 5, required_repetitions: 1 }); assert.equal(spec.ok, true, JSON.stringify(spec));
    const optimization = await invoke(root, "create_optimization_context", { context_id: "attempt-context", title: "Attempt evidence", experiment_id: "attempt-evidence", experiment_version: "v1" }); assert.equal(optimization.ok, true, JSON.stringify(optimization));
    const candidate = await invoke(root, "create_optimization_candidate", { context_id: "attempt-context", candidate_id: "attempt-candidate", serving_configuration: { max_num_seqs: 8 }, workload }); assert.equal(candidate.ok, true, JSON.stringify(candidate));
    const reserved = await invoke(root, "reserve_optimization_attempt", { attempt_id: "attempt-evidence-run", context_id: "attempt-context", candidate_id: "attempt-candidate", environment_run_id: baseline, selected_gpu_uuids: ["GPU-attempt"], lease_id: "attempt-evidence-lease", lease_expires_at: new Date(Date.now() + 60_000).toISOString() }); assert.equal(reserved.ok, true, JSON.stringify(reserved));
    const candidateService = serviceManifest("attempt-candidate-service", 18031, candidate.data?.configuration as typeof configuration, { kind: "experiment", experiment_id: "attempt-evidence", experiment_version: "v1", optimization_attempt_id: "attempt-evidence-run" }); await activeStore.saveRuntimeService(candidateService);
    const pre = await completedRun(activeStore, "inspect_gpu", environment); const post = await completedRun(activeStore, "inspect_gpu", environment);
    const serviceRun = await completedRun(activeStore, "start_managed_service", { service: { ...candidateService, current_container_state: { status: "running", running: true } } });
    const probeRun = await completedRun(activeStore, "probe_managed_endpoint", { instance_id: candidateService.instance_id, response_model_id: model.model_id });
    const benchmarkRun = await completedRun(activeStore, "run_performance_test", { service_instance_id: candidateService.instance_id, requested: workload, optimization_attempt_id: "attempt-evidence-run", metrics: { success_rate: 1, requests_per_second: 12 }, observed_gpu_memory_peak_bytes: 10 * 1024 ** 3 });
    for (const [state, runIds] of [["starting", [serviceRun]], ["ready", []], ["probing", [probeRun]], ["benchmarking", [benchmarkRun]]] as const) { const updated = await activeStore.updateOptimizationAttempt("attempt-evidence-run", { state, run_ids: [...runIds] }); assert.equal(updated.state, state); }
    const trial = await invoke(root, "record_experiment_trial", { experiment_id: "attempt-evidence", serving_configuration: { max_num_seqs: 8 }, workload, pre_environment_run_id: pre, post_environment_run_id: post, service_run_id: serviceRun, probe_run_id: probeRun, benchmark_run_id: benchmarkRun, optimization_attempt_id: "attempt-evidence-run" }); assert.equal(trial.ok, true, JSON.stringify(trial));
    const attempt = await activeStore.getOptimizationAttempt("attempt-evidence-run"); assert.equal(attempt.state, "measured"); assert.equal(attempt.cleanup_status, "cleanup_pending"); assert.equal(attempt.trial_id, trial.data?.trial_id); assert.ok(attempt.run_ids.includes(serviceRun)); assert.ok(attempt.run_ids.includes(probeRun)); assert.ok(attempt.run_ids.includes(benchmarkRun));
    const blocked = await invoke(root, "reserve_optimization_attempt", { attempt_id: "attempt-after-trial", context_id: "attempt-context", candidate_id: "attempt-candidate", environment_run_id: baseline, selected_gpu_uuids: ["GPU-attempt"], lease_id: "attempt-after-trial-lease", lease_expires_at: new Date(Date.now() + 60_000).toISOString(), retest_reason: "Should remain blocked until cleanup." }); assert.equal(blocked.ok, false); assert.equal(blocked.error?.code, "optimization_cleanup_pending");
  } finally { store?.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test("experiment comparison requires repeated reference evidence and protects owned candidate services", async () => {
  const root = await mkdtemp(join(tmpdir(), "bittune-experiment-"));
  let store: StateStore | undefined;
  try {
    await publishGenericPreset(root); store = new StateStore(root); const activeStore = store; const reference = serviceManifest("service-reference", 18000); const candidateConfiguration = materializeVllmConfiguration({ ...configuration, max_num_seqs: 8 }); const candidate = serviceManifest("service-candidate", 18001, candidateConfiguration, { kind: "experiment", experiment_id: "tuning", experiment_version: "v1" }); await activeStore.saveRuntimeService(reference); await activeStore.saveRuntimeService(candidate);
    const environment = { host_id: "gpu-fixture", gpus: [{ uuid: "GPU-any", name: "Any GPU", driver_version: "600.0", compute_capability: "9.0", memory_total_bytes: 48 * 1024 ** 3 }], compute_processes: [] as Array<{ gpu_uuid: string; pid: number; process_name: string; memory_bytes: number }> }; const baseline = await completedRun(activeStore, "inspect_gpu", environment);
    const spec = await invoke(root, "publish_experiment_spec", { experiment_id: "tuning", experiment_kind: "runtime_tuning", deployment_preset_id: "meteor-vllm", deployment_preset_version: "v1", reference_service_instance_id: reference.instance_id, baseline_environment_run_id: baseline, objective_metric: "requests_per_second", constraints: { min_success_rate: 0.95 }, workload, allowed_parameters: { max_num_seqs: { minimum: 4, maximum: 8 } }, budget: { max_trials: 7, max_total_duration_seconds: 600, max_failures: 2 }, minimum_improvement_percent: 5, required_repetitions: 2 }); assert.equal(spec.ok, true, JSON.stringify(spec));
    async function record(service: ServiceManifest, rps: number, configurationInput: Record<string, unknown>, preEnvironment = environment, postEnvironment = environment) {
      const pre = await completedRun(activeStore, "inspect_gpu", preEnvironment); const post = await completedRun(activeStore, "inspect_gpu", postEnvironment); const serviceRun = await completedRun(activeStore, "inspect_managed_service", { service: { ...service, current_container_state: { status: "running" } } }); const probe = await completedRun(activeStore, "probe_managed_endpoint", { instance_id: service.instance_id, response_model_id: model.model_id }); const benchmark = await completedRun(activeStore, "run_performance_test", { service_instance_id: service.instance_id, requested: workload, metric_normalizer_version: METRIC_NORMALIZER_VERSION, request_samples_available: true, metrics: { success_rate: 1, requests_per_second: rps }, observed_gpu_memory_peak_bytes: 10 * 1024 ** 3 }); return invoke(root, "record_experiment_trial", { experiment_id: "tuning", serving_configuration: configurationInput, workload, pre_environment_run_id: pre, post_environment_run_id: post, service_run_id: serviceRun, probe_run_id: probe, benchmark_run_id: benchmark });
    }
    assert.equal((await record(reference, 10, {})).data?.result_class, "valid"); const beforeReferenceRepeat = await invoke(root, "derive_experiment_comparison", { experiment_id: "tuning" }); assert.equal(beforeReferenceRepeat.data?.status, "validation_required");
    assert.equal((await record(reference, 10, {})).data?.result_class, "valid"); assert.equal((await record(candidate, 12, { max_num_seqs: 8 })).data?.result_class, "valid"); assert.equal((await record(candidate, 12, { max_num_seqs: 8 })).data?.result_class, "valid"); const comparison = await invoke(root, "derive_experiment_comparison", { experiment_id: "tuning" }); assert.equal(comparison.data?.status, "objective_met");
    if (process.platform !== "win32") {
      const fixture = await installExitedDockerFixture(root); const previousPath = process.env.PATH; const previousDockerLog = process.env.BITTUNE_TEST_FAKE_DOCKER_LOG;
      process.env.PATH = `${fixture.bin}${delimiter}${previousPath ?? ""}`; process.env.BITTUNE_TEST_FAKE_DOCKER_LOG = fixture.log;
      try {
        const ownProcessEnvironment = { ...environment, compute_processes: [{ gpu_uuid: "GPU-any", pid: 1234, process_name: "VLLM::EngineCore", memory_bytes: 1024 }] };
        assert.equal((await record(candidate, 12, { max_num_seqs: 8 }, ownProcessEnvironment, ownProcessEnvironment)).data?.result_class, "valid");
        const externalAlongsideTrial = { ...ownProcessEnvironment, compute_processes: [...ownProcessEnvironment.compute_processes, { gpu_uuid: "GPU-any", pid: 9001, process_name: "external-worker", memory_bytes: 1024 }] };
        assert.equal((await record(candidate, 12, { max_num_seqs: 8 }, ownProcessEnvironment, externalAlongsideTrial)).data?.result_class, "invalid_resource_contention");
      } finally {
        process.env.PATH = previousPath; if (previousDockerLog === undefined) delete process.env.BITTUNE_TEST_FAKE_DOCKER_LOG; else process.env.BITTUNE_TEST_FAKE_DOCKER_LOG = previousDockerLog;
      }
    }
    const competingEnvironment = { ...environment, compute_processes: [{ gpu_uuid: "GPU-any", pid: 9001, process_name: "external-worker", memory_bytes: 1024 }] }; const contention = await record(reference, 10, {}, environment, competingEnvironment); assert.equal(contention.data?.result_class, "invalid_resource_contention");
  } finally { store?.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test("versioned comparison enforces sample evidence and objective CV stability", async () => {
  const root = await mkdtemp(join(tmpdir(), "bittune-versioned-comparison-"));
  let store: StateStore | undefined;
  try {
    await publishGenericPreset(root);
    store = new StateStore(root);
    const reference = serviceManifest("versioned-reference", 18110);
    const candidateConfiguration = materializeVllmConfiguration({ ...configuration, max_num_seqs: 8 });
    const candidate = serviceManifest("versioned-candidate", 18111, candidateConfiguration, { kind: "experiment", experiment_id: "versioned-comparison", experiment_version: "v1" });
    await store.saveRuntimeService(reference); await store.saveRuntimeService(candidate);
    const environment = { host_id: "gpu-fixture", gpus: [{ uuid: "GPU-versioned", name: "Any GPU", driver_version: "600.0", compute_capability: "9.0", memory_total_bytes: 48 * 1024 ** 3 }], compute_processes: [] };
    const environmentRun = await completedRun(store, "inspect_gpu", environment);
    const versionedWorkload = { ...workload, workload_schema_version: 1 as const, provider_version: "0.5.0", random_seed: 7, tokenizer_model_id: model.model_id, chat_template: "default", stream: true, ignore_eos: true };
    const spec = await invoke(root, "publish_experiment_spec", { experiment_id: "versioned-comparison", experiment_kind: "runtime_tuning", deployment_preset_id: "meteor-vllm", deployment_preset_version: "v1", reference_service_instance_id: reference.instance_id, baseline_environment_run_id: environmentRun, objective_metric: "requests_per_second", constraints: {}, workload: versionedWorkload, allowed_parameters: { max_num_seqs: { minimum: 4, maximum: 8 } }, budget: { max_trials: 6, max_total_duration_seconds: 600, max_failures: 1 }, minimum_improvement_percent: 5, required_repetitions: 2, max_objective_cv_percent: 5 });
    assert.equal(spec.ok, true, JSON.stringify(spec));
    const serviceRun = await completedRun(store, "inspect_managed_service", { service: { ...reference, current_container_state: { status: "running" } } });
    const probeRun = await completedRun(store, "probe_managed_endpoint", { instance_id: reference.instance_id, response_model_id: model.model_id });
    const benchmarkRun = await completedRun(store, "run_performance_test", { service_instance_id: reference.instance_id });
    const workloadFingerprintValue = workloadFingerprint(materializeBenchmarkWorkload(versionedWorkload, model.model_id));
    async function addTrial(trialId: string, service: ServiceManifest, value: number, complete = true) {
      await store!.saveRuntimeExperimentTrial({ trial_id: trialId, experiment_id: "versioned-comparison", experiment_version: "v1", configuration: service.serving_configuration, configuration_hash: vllmConfigurationFingerprint(service.serving_configuration), workload: versionedWorkload, workload_fingerprint: workloadFingerprintValue, ...(complete ? { metric_normalizer_version: METRIC_NORMALIZER_VERSION, request_samples_available: true } : {}), pre_environment_run_id: environmentRun, post_environment_run_id: environmentRun, service_run_id: serviceRun, probe_run_id: probeRun, benchmark_run_id: benchmarkRun, result_class: "valid", constraint_failures: [], metrics: { success_rate: 1, requests_per_second: value }, evidence_duration_seconds: 1 });
    }
    await addTrial("versioned-reference-one", reference, 10); await addTrial("versioned-reference-two", reference, 10);
    await addTrial("versioned-candidate-one", candidate, 15); await addTrial("versioned-candidate-two", candidate, 30);
    const unstable = await invoke(root, "derive_experiment_comparison", { experiment_id: "versioned-comparison" });
    const ranking = unstable.data?.ranking as Array<Record<string, unknown>>;
    const candidateRank = ranking.find((item) => item.configuration_hash === vllmConfigurationFingerprint(candidateConfiguration));
    assert.equal(candidateRank?.stable, false);
    assert.ok(Number(candidateRank?.objective_cv_percent) > 5);
    await addTrial("versioned-missing-samples", candidate, 20, false);
    const incomplete = await invoke(root, "derive_experiment_comparison", { experiment_id: "versioned-comparison" });
    assert.equal(incomplete.data?.status, "validation_required");
  } finally { store?.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test("base distribution is runtime-free and does not mutate GPU providers", async () => {
  const [build, bootstrap, manifest, components] = await Promise.all([
    readFile("install/build-offline-bundle.sh", "utf8"),
    readFile("install/bootstrap.sh", "utf8"),
    readFile("install/offline-manifest.env", "utf8"),
    readFile("packages/bittune-runtime/src/cli/install/components.ts", "utf8"),
  ]);
  assert.match(build, /runtime_selection=runtime-free/);
  // The `bittune` launcher written by the agent component keeps warning suppression.
  assert.match(components, /--disable-warning=ExperimentalWarning/);
  assert.match(components, /\/usr\/local\/bin\/bittune/);
  assert.doesNotMatch(bootstrap, /nvidia-ctk|docker-ce|systemctl restart docker|apt-get install -y --no-install-recommends docker/i);
  assert.doesNotMatch(build, /docker pull|nvidia-container-toolkit/);
  assert.doesNotMatch(manifest, /^VLLM_IMAGE=/m);
});
