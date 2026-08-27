import { defineTool, type ExtensionContext, type ToolDefinition } from "../../../bittune-runtime/src/core/extensions/index.ts";
import type { TSchema } from "typebox";
import { RunRecorder, type RecordingPolicy, type ToolRunContext } from "./run-recorder.ts";
import type { DomainResult } from "./observation.ts";

const QUERY_TOOL_NAMES = new Set([
  "list_run_records", "get_run_record", "read_artifact_excerpt",
  "list_deployment_presets", "get_deployment_preset",
  "list_capacity_baselines", "get_capacity_baseline",
  "list_experiment_specs", "get_experiment_spec", "list_experiment_trials", "get_experiment_trial",
  "list_experiment_comparisons", "get_experiment_comparison",
  "list_optimization_contexts", "list_optimization_candidates", "list_optimization_attempts",
  "resolve_optimization_context", "get_optimization_handoff",
  "inspect_runtime_capabilities", "inspect_runtime_policy",
]);

const COMMAND_TOOL_NAMES = new Set([
  "publish_deployment_preset", "pull_runtime_image", "download_model_snapshot",
  "publish_capacity_baseline",
  "start_managed_service", "stop_managed_service",
  "publish_experiment_spec", "record_experiment_trial", "publish_experiment_comparison",
  "create_optimization_context", "create_optimization_candidate", "reserve_optimization_attempt",
  "recover_optimization_attempt",
  "observe_runtime_capability",
  "discover_runtime_images", "resolve_model_revision",
]);

function defaultRecordingPolicy(toolName: string): RecordingPolicy {
  if (COMMAND_TOOL_NAMES.has(toolName)) return "command";
  return QUERY_TOOL_NAMES.has(toolName) ? "query" : "evidence";
}

export function createBittuneTool<T extends TSchema>(args: {
  name: string;
  label: string;
  description: string;
  parameters: T;
  recorder: RunRecorder;
  /** Commands/evidence create durable Runs; query/session tools remain Session-only. */
  recording?: RecordingPolicy;
  execute: (params: unknown, context: ToolRunContext, piContext: ExtensionContext) => Promise<DomainResult<unknown>>;
}): ToolDefinition<T> {
  return defineTool({
    name: args.name,
    label: args.label,
    description: args.description,
    parameters: args.parameters,
    async execute(toolCallId, params, signal, onUpdate, context) {
      return args.recorder.execute(args.recording ?? defaultRecordingPolicy(args.name), args.name, toolCallId, params, signal, onUpdate, context, (runContext) => args.execute(params, runContext, context));
    },
  });
}
