import { canonicalJson, sha256 } from "./identifiers.ts";
import type { OptimizationContext } from "./state-store.ts";

export const ACTIVE_OPTIMIZATION_CONTEXT_SESSION_ENTRY = "bittune.active-optimization-context";

type SessionEntryLike = { type?: unknown; customType?: unknown; data?: unknown };

export function activeOptimizationContextIdFromSessionEntries(entries: readonly SessionEntryLike[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== ACTIVE_OPTIMIZATION_CONTEXT_SESSION_ENTRY || !entry.data || typeof entry.data !== "object") continue;
    const contextId = (entry.data as { context_id?: unknown }).context_id;
    if (typeof contextId === "string" && /^[a-z][a-z0-9-]{0,62}$/.test(contextId)) return contextId;
  }
  return undefined;
}

/** Stable task identity deliberately excludes mutable Attempt state and LLM text. */
export function optimizationTaskFingerprint(context: OptimizationContext): string {
  return sha256(canonicalJson({
    model_id: context.model_id,
    model_revision: context.model_revision,
    runtime_kind: context.runtime_kind,
    runtime_image_digest: context.runtime_image_digest,
    runtime_capability_version: context.runtime_capability_version,
    experiment_kind: context.experiment_kind,
    objective_metric: context.objective_metric,
    constraints: context.constraints,
    workload: context.workload,
    allowed_workload: context.allowed_workload,
    allowed_parameters: context.allowed_parameters,
    reference_service_configuration: context.reference_service_configuration,
  }));
}
