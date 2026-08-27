import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BittuneError } from "./errors.ts";

export interface RuntimePolicyImage {
  repository: string;
  digest: string;
  runtime_kind?: "vllm" | "sglang";
}

export interface RuntimePolicy {
  allowedRuntimeRepositories: string[];
  runtimeImages: RuntimePolicyImage[];
  /** When true, no policy file was found and all local images are allowed. */
  unrestricted?: boolean;
}

function normalizeRepository(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:/-]{0,255}$/.test(value)) {
    throw new BittuneError("runtime_policy_invalid", "Runtime policy contains an invalid repository entry.", false);
  }
  return value;
}

function normalizeDigest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new BittuneError("runtime_policy_invalid", "Runtime policy contains an invalid image digest.", false);
  }
  return value;
}

export function runtimePolicyPath(): string {
  return process.env.BITTUNE_RUNTIME_POLICY_FILE?.trim() || join(process.env.BITTUNE_HOME?.trim() || join(homedir(), ".bittune"), "runtime-policy.json");
}

/** Runtime image authority is deliberately external to Agent-visible state. */
export async function readRuntimePolicy(): Promise<RuntimePolicy & { path: string }> {
  const path = runtimePolicyPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // No policy file: allow all local Runtime images without restriction.
      return { path, allowedRuntimeRepositories: [], runtimeImages: [], unrestricted: true };
    }
    throw new BittuneError("runtime_policy_unavailable", `Unable to read Runtime policy at ${path}: ${error instanceof Error ? error.message : String(error)}`, false);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BittuneError("runtime_policy_invalid", `Runtime policy at ${path} must contain valid JSON.`, false);
  }
  const allowed = (parsed as { allowedRuntimeRepositories?: unknown })?.allowedRuntimeRepositories;
  if (!Array.isArray(allowed) || !allowed.length) {
    throw new BittuneError("runtime_policy_invalid", "Runtime policy must define a non-empty allowedRuntimeRepositories list.", false);
  }
  const allowedRuntimeRepositories = [...new Set(allowed.map(normalizeRepository))].sort();
  const imagesRaw = (parsed as { runtimeImages?: unknown })?.runtimeImages;
  const runtimeImages = Array.isArray(imagesRaw)
    ? imagesRaw.map((item) => {
      if (!item || typeof item !== "object") throw new BittuneError("runtime_policy_invalid", "Runtime policy runtimeImages entries must be objects.", false);
      const value = item as { repository?: unknown; digest?: unknown; runtime_kind?: unknown };
      const repository = normalizeRepository(value.repository);
      if (!allowedRuntimeRepositories.includes(repository)) throw new BittuneError("runtime_policy_invalid", `Runtime policy image repository ${repository} is not allowed.`, false);
      if (value.runtime_kind !== undefined && value.runtime_kind !== "vllm" && value.runtime_kind !== "sglang") throw new BittuneError("runtime_policy_invalid", "Runtime policy image runtime_kind must be vllm or sglang.", false);
      const runtime_kind = value.runtime_kind as RuntimePolicyImage["runtime_kind"] | undefined;
      return { repository, digest: normalizeDigest(value.digest), ...(runtime_kind === undefined ? {} : { runtime_kind }) };
    })
    : [];
  return { path, allowedRuntimeRepositories, runtimeImages };
}

export async function requireRuntimeRepositoryAllowed(repository: string): Promise<void> {
  const policy = await readRuntimePolicy();
  if (policy.unrestricted) return;
  if (!policy.allowedRuntimeRepositories.includes(repository)) {
    throw new BittuneError("runtime_repository_not_allowed", `Runtime repository ${repository} is not allowed by the administrator policy.`, false, { repository, allowed_runtime_repositories: policy.allowedRuntimeRepositories });
  }
}
