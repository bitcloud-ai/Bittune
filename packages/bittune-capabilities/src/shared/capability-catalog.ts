/**
 * Capability metadata groups the trusted domain tools for documentation and
 * maintenance. It is deliberately not a session-level tool visibility gate.
 */
export const BITTUNE_CAPABILITIES = ["deployment", "serving", "benchmark", "capacity", "experiment-setup", "experiment-results", "experiment-recovery"] as const;
export type BittuneCapability = (typeof BITTUNE_CAPABILITIES)[number];

/**
 * These tools can only read durable evidence from an earlier or current
 * session. A fresh experiment deliberately starts without that evidence.
 */
export const HISTORICAL_EVIDENCE_TOOL_NAMES = [
  "list_run_records",
  "get_run_record",
  "read_artifact_excerpt",
] as const;

export const CAPABILITY_TOOL_NAMES: Readonly<Record<BittuneCapability, readonly string[]>> = {
  deployment: [
    "inspect_runtime_policy",
    "discover_runtime_images",
    "derive_deployment_options",
    "list_deployment_presets",
    "get_deployment_preset",
    "publish_deployment_preset",
    "inspect_runtime_image",
    "pull_runtime_image",
    "inspect_model_snapshot",
    "download_model_snapshot",
  ],
  serving: [
    "observe_runtime_capability",
    "inspect_runtime_capabilities",
    "list_managed_services",
    "start_managed_service",
    "wait_for_managed_service_ready",
    "read_managed_service_logs",
    "inspect_managed_service",
    "probe_managed_endpoint",
    "stop_managed_service",
  ],
  benchmark: ["run_performance_test", "analyze_benchmark_artifact"],
  capacity: [
    "list_capacity_baselines",
    "get_capacity_baseline",
    "derive_capacity_baseline",
    "publish_capacity_baseline",
  ],
  "experiment-setup": [
    "publish_experiment_spec",
    "list_experiment_specs",
    "get_experiment_spec",
    "create_optimization_context",
    "resolve_optimization_context",
    "get_optimization_handoff",
    "create_optimization_candidate",
    "reserve_optimization_attempt",
    "list_optimization_contexts",
    "list_optimization_candidates",
    "list_optimization_attempts",
  ],
  "experiment-results": [
    "record_experiment_trial",
    "list_experiment_trials",
    "get_experiment_trial",
    "derive_experiment_comparison",
    "publish_experiment_comparison",
    "list_experiment_comparisons",
    "get_experiment_comparison",
  ],
  "experiment-recovery": ["recover_optimization_attempt"],
};
