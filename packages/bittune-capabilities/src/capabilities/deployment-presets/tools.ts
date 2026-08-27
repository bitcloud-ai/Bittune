import { Type } from "typebox";
import { RunRecorder } from "../../shared/run-recorder.ts";
import { createBittuneTool } from "../../shared/tool.ts";
import { getRuntimeAdapter, type RuntimeKind } from "../../shared/runtime-adapter.ts";
import { readRuntimePolicy, requireRuntimeRepositoryAllowed } from "../../shared/runtime-policy.ts";
import { runCommand } from "../../shared/process.ts";
import { resolveVllmImage } from "../../shared/vllm-image.ts";
import type { ServingConfiguration } from "../../shared/vllm-capabilities.ts";

/** Detect if a Docker image repository looks like a known inference Runtime. */
function detectRuntimeKind(repository: string): RuntimeKind | undefined {
  const normalized = repository.toLowerCase();
  if (normalized.includes("vllm")) return "vllm";
  if (normalized.includes("sglang")) return "sglang";
  return undefined;
}

function isRuntimeImageRepository(repository: string, filterKind?: RuntimeKind): boolean {
  const kind = detectRuntimeKind(repository);
  if (!kind) return false;
  if (filterKind && kind !== filterKind) return false;
  return true;
}

const Id = Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" });
const Version = Type.String({ pattern: "^v[1-9][0-9]*$" });
const Revision = Type.String({ pattern: "^[a-f0-9]{40}$" });
const Digest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const ModelId = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)?$", maxLength: 256 });
const Repository = Type.String({ pattern: "^[a-z0-9][a-z0-9._:/-]{0,255}$", maxLength: 256 });
const VllmServingConfiguration = Type.Partial(Type.Object({
  dtype: Type.Union([Type.Literal("auto"), Type.Literal("bfloat16"), Type.Literal("float16"), Type.Literal("float32")]),
  tensor_parallel_size: Type.Integer({ minimum: 1 }), pipeline_parallel_size: Type.Integer({ minimum: 1 }),
  gpu_device_ids: Type.Array(Type.Integer({ minimum: 0 })), max_model_len: Type.Integer({ minimum: 1 }),
  max_num_seqs: Type.Integer({ minimum: 1 }), max_num_batched_tokens: Type.Integer({ minimum: 1 }),
  gpu_memory_utilization: Type.Number({ exclusiveMinimum: 0, maximum: 1 }), swap_space_gib: Type.Number({ minimum: 0 }),
  enforce_eager: Type.Boolean(), enable_prefix_caching: Type.Boolean(),
}));
const SglangServingConfiguration = Type.Partial(Type.Object({
  dtype: Type.Union([Type.Literal("auto"), Type.Literal("bfloat16"), Type.Literal("float16"), Type.Literal("float32")]),
  tensor_parallel_size: Type.Integer({ minimum: 1 }), gpu_device_ids: Type.Array(Type.Integer({ minimum: 0 })),
  context_length: Type.Integer({ minimum: 1 }), max_running_requests: Type.Integer({ minimum: 1 }), chunked_prefill_size: Type.Integer({ minimum: 1 }),
  mem_fraction_static: Type.Number({ exclusiveMinimum: 0, maximum: 1 }), disable_cuda_graph: Type.Boolean(), disable_radix_cache: Type.Boolean(),
}));
const ServingConfiguration = Type.Union([VllmServingConfiguration, SglangServingConfiguration]);
const RunId = Type.String({ pattern: "^run-[a-f0-9-]{36}$" });

export function createDeploymentPresetTools(recorder: RunRecorder) {
  return [
    createBittuneTool({
      name: "inspect_runtime_policy", label: "Inspect Runtime policy", recorder, parameters: Type.Object({}),
      description: "Read the administrator-managed Runtime policy path and allowed image repositories. When no policy file exists, all local Runtime images are allowed without restriction.",
      async execute() {
        const policy = await readRuntimePolicy();
        if (policy.unrestricted) {
          return { summary: "No Runtime policy configured; all local Runtime images are allowed.", provenance_type: "stored", data: { path: policy.path, unrestricted: true, allowedRuntimeRepositories: [], runtimeImages: [] }, provider: { name: "runtime-policy" } };
        }
        return { summary: `Runtime policy permits ${policy.allowedRuntimeRepositories.length} repository entries.`, provenance_type: "stored", data: policy, provider: { name: "runtime-policy" } };
      },
    }),
    createBittuneTool({
      name: "discover_runtime_images", label: "发现本地 Runtime 镜像", recorder, parameters: Type.Object({ runtime_kind: Type.Optional(Type.Union([Type.Literal("vllm"), Type.Literal("sglang")])) }),
      description: "发现本机 Docker 中可用的 Runtime 镜像（repository、digest、image ID）。当管理员 policy 存在时只返回白名单镜像；无 policy 时发现所有 vllm/sglang 类镜像。不会启动或拉取镜像。",
      async execute(params, context) {
        const input = params as { runtime_kind?: RuntimeKind };
        const policy = await readRuntimePolicy();
        const candidates: Array<Record<string, unknown>> = [];
        // When a policy with pre-declared images exists, resolve each one.
        if (!policy.unrestricted) {
          for (const configured of policy.runtimeImages) {
            if (input.runtime_kind && configured.runtime_kind && configured.runtime_kind !== input.runtime_kind) continue;
            const resolution = await resolveVllmImage({ repository: configured.repository, digest: configured.digest }, context.signal);
            candidates.push({ runtime_kind: configured.runtime_kind, repository: configured.repository, digest: configured.digest, available: Boolean(resolution.image), ...(resolution.image ? { image_id: resolution.image.image_id, image_reference: resolution.image.image_reference, run_reference: resolution.image.run_reference, source: resolution.image.source } : {}), diagnostics: resolution.diagnostics.slice(0, 4000) });
          }
        }
        const listed = await runCommand("docker", ["image", "ls", "--format", "{{json .}}"], { signal: context.signal, timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 });
        await context.artifact("docker-runtime-image-discovery", `${listed.stdout}\n${listed.stderr}`);
        if (listed.exit_code === 0) {
          for (const line of listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
            let item: { Repository?: string; Tag?: string; ID?: string };
            try { item = JSON.parse(line) as typeof item; } catch { continue; }
            const repository = item.Repository;
            if (!repository) continue;
            // In restricted mode, only allow policy-listed repositories.
            // In unrestricted mode, match known runtime image name patterns.
            if (!policy.unrestricted && !policy.allowedRuntimeRepositories.includes(repository)) continue;
            if (policy.unrestricted && !isRuntimeImageRepository(repository, input.runtime_kind)) continue;
            const tag = item.Tag && item.Tag !== "<none>" ? item.Tag : undefined;
            const reference = tag ? `${repository}:${tag}` : repository;
            const inspected = await runCommand("docker", ["image", "inspect", reference, "--format", "{{json .}}"], { signal: context.signal, timeoutMs: 15_000, maxBytes: 512 * 1024 });
            if (inspected.exit_code !== 0) continue;
            try {
              const image = JSON.parse(inspected.stdout) as { Id?: string; RepoDigests?: string[] };
              for (const repoDigest of image.RepoDigests ?? []) {
                const at = repoDigest.lastIndexOf("@"); const digest = at > 0 ? repoDigest.slice(at + 1) : undefined;
                const repo = at > 0 ? repoDigest.slice(0, at) : repository;
                if (!digest || candidates.some((candidate) => candidate.repository === repo && candidate.digest === digest)) continue;
                if (!policy.unrestricted && !policy.allowedRuntimeRepositories.includes(repo)) continue;
                const detectedKind = detectRuntimeKind(repo);
                if (input.runtime_kind && detectedKind && detectedKind !== input.runtime_kind) continue;
                candidates.push({ ...(detectedKind ? { runtime_kind: detectedKind } : {}), repository: repo, digest, image_id: image.Id, image_reference: repoDigest, run_reference: repoDigest, available: true, source: "repo_digest" });
              }
            } catch { /* Ignore an unreadable individual image; other candidates remain usable. */ }
          }
        }
        return { summary: `发现 ${candidates.length} 个${policy.unrestricted ? "本地" : "受 policy 约束的"} Runtime 镜像候选。`, provenance_type: "measured", data: { policy_path: policy.path, unrestricted: Boolean(policy.unrestricted), candidates }, warnings: listed.exit_code === 0 ? [] : [listed.stderr.slice(0, 500) || "Docker image list failed."], provider: { name: "docker-runtime-image-discovery" } };
      },
    }),
    createBittuneTool({
      name: "list_deployment_presets", label: "列出部署定义", recorder, parameters: Type.Object({}),
      description: "列出 Bittune 已保存的 Runtime DeploymentPreset 不可变版本。",
      async execute(_params, context) {
        const presets = await context.store.listRuntimePresets();
        return { summary: `发现 ${presets.length} 个 Runtime DeploymentPreset 版本。`, provenance_type: "stored", data: { presets }, provider: { name: "file-run-store" } };
      },
    }),
    createBittuneTool({
      name: "get_deployment_preset", label: "读取部署定义", recorder, parameters: Type.Object({ preset_id: Id, version: Type.Optional(Version) }),
      description: "读取指定 v3 Runtime DeploymentPreset 的模型身份、Runtime 身份和有限 serving_configuration。只读，不检查本机资产。",
      async execute(params, context) {
        const input = params as { preset_id: string; version?: string };
        const preset = await context.store.getRuntimePreset(input.preset_id, input.version);
        return { summary: `读取 Runtime DeploymentPreset ${preset.preset_id}/${preset.version}。`, provenance_type: "stored", data: preset, provider: { name: "file-run-store" } };
      },
    }),
    createBittuneTool({
      name: "publish_deployment_preset", label: "发布部署定义", recorder,
      parameters: Type.Object({
        preset_id: Id, expected_parent_version: Type.Optional(Version), model_id: ModelId, model_revision: Revision,
        artifact_fingerprint: Type.Optional(Digest), runtime_kind: Type.Union([Type.Literal("vllm"), Type.Literal("sglang")]), runtime_image_repository: Repository,
        runtime_image_digest: Digest, serving_configuration: Type.Optional(ServingConfiguration), source_run_ids: Type.Optional(Type.Array(RunId, { maxItems: 32 })),
      }),
      description: "在管理员 Runtime repository 策略允许的范围内追加一个 v3 Runtime DeploymentPreset。只保存定义，不下载、部署、探测或声称已验证。",
      async execute(params, context) {
        const input = params as { preset_id: string; expected_parent_version?: string; model_id: string; model_revision: string; artifact_fingerprint?: string; runtime_kind: RuntimeKind; runtime_image_repository: string; runtime_image_digest: string; serving_configuration?: ServingConfiguration; source_run_ids?: string[] };
        const adapter = getRuntimeAdapter(input.runtime_kind);
        await requireRuntimeRepositoryAllowed(input.runtime_image_repository);
        const preset = await context.store.publishRuntimePreset({
          preset_id: input.preset_id, ...(input.expected_parent_version === undefined ? {} : { expected_parent_version: input.expected_parent_version }),
          model_id: input.model_id, model_revision: input.model_revision, ...(input.artifact_fingerprint ? { artifact_fingerprint: input.artifact_fingerprint } : {}),
          runtime_kind: input.runtime_kind, runtime_image_repository: input.runtime_image_repository, runtime_image_digest: input.runtime_image_digest,
          serving_configuration: input.serving_configuration ?? {}, source_run_ids: input.source_run_ids ?? [],
        });
        return { summary: `已发布 Runtime DeploymentPreset ${preset.preset_id}/${preset.version}。`, provenance_type: "stored", data: preset, provider: { name: `bittune-${adapter.kind}-adapter`, version: adapter.capabilityVersion } };
      },
    }),
  ];
}
