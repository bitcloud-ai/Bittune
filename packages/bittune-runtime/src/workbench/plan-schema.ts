import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum, validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/** The Web execution scope permits managed subjects and saved suite points only. */
export function exposeWorkbenchTool(tool: AgentTool): AgentTool {
  tool = compactLifecycleTool(tool);
  if (!["benchmark_service", "benchmark_suite", "compare_results", "export_deliverable"].includes(tool.name)) return exposePlanActions(tool);
  const original = tool.parameters;
  const branch = (original as any).anyOf[["compare_results", "export_deliverable"].includes(tool.name) ? 1 : 0];
  const parameters = tool.name === "compare_results" ? {
    ...branch, properties: { ...branch.properties,
      objective: Type.Optional(StringEnum(["output_tokens_per_second", "mean_ttft_ms", "goodput_req_per_s"])) },
  } : branch;
  return { ...tool, parameters, prepareArguments(args) {
    const checked = validateToolArguments({ ...tool, parameters: original }, {
      type: "toolCall", id: "web-subject-validation", name: tool.name, arguments: args as Record<string, unknown>,
    });
    return tool.prepareArguments ? tool.prepareArguments(checked) : checked;
  } };
}

/** Limit model-facing context while retaining the complete Core receipt for task evidence. */
function compactLifecycleTool(tool: AgentTool): AgentTool {
  if (!["inspect_environment", "inspect_records", "inspect_service", "plan_deployment", "deploy_service", "benchmark_suite"].includes(tool.name)) return tool;
  return { ...tool, async execute(id, args, signal, onUpdate) {
    const result = await tool.execute(id, args, signal, onUpdate);
    const details = result.details as { code?: string; summary?: string; data?: Record<string, any>;
      kind?: string; id?: string; payload?: Record<string, any> } | undefined;
    if (!details || details.code) return result;
    const { hardware_snapshot: snapshot, plan: updated, service, suite_result: measured } = details.data || {};
    const lookedUpPlan = details.kind === "deployment_plan" ? details.payload : undefined;
    const plan = updated || lookedUpPlan;
    const suite = measured || (details.kind === "suite_result" ? details.payload : undefined);
    const brief = snapshot ? {
      hardware_snapshot_id: snapshot.hardware_snapshot_id,
      gpus: snapshot.gpus.map(({ index, name, memory_total_bytes, memory_free_bytes, utilization_percent }: Record<string, unknown>) =>
        ({ index, name, memory_total_bytes, memory_free_bytes, utilization_percent })),
    } : plan ? {
      plan_id: plan.plan_id, status: plan.status, hardware_snapshot_id: plan.hardware_snapshot_id,
      validation: { state: plan.validation?.state, errors: plan.validation?.errors },
      ...(lookedUpPlan ? { serving_spec: plan.serving_spec, model_id: plan.model_ref?.model_id, runtime_kind: plan.runtime_spec?.runtime_kind } : {}),
    } : service ? {
      service_instance_id: service.service_instance_id, plan_id: service.plan_id,
      observed_state: service.observed_state, desired: service.desired, endpoint: service.endpoint,
      current_container_state: details.data?.current_container_state && {
        running: details.data.current_container_state.running, status: details.data.current_container_state.status,
      },
    } : suite && Array.isArray(suite.rows) ? {
      suite_result_id: suite.suite_result_id,
      rows: suite.rows.map((row: Record<string, any>) => ({
        scenario_id: row.scenario_id, concurrency: row.concurrency, repeat: row.repeat,
        state: row.state, measurement_status: row.measurement_status, benchmark_result_id: row.benchmark_result_id,
        output_tokens_per_second: row.metrics?.output_tokens_per_second, mean_ttft_ms: row.metrics?.mean_ttft_ms,
      })),
    } : undefined;
    if (!brief) return result;
    return { ...result, content: [{ type: "text", text: JSON.stringify({ summary: details.summary, ...brief }) }] };
  }};
}

/** Web provider projection only. Execution still validates the original action union. */
export function exposePlanActions(tool: AgentTool): AgentTool {
  if (tool.name !== "plan_deployment") return tool;
  const original = tool.parameters;
  const [create, existing] = (original as any).anyOf;
  return {
    ...tool,
    parameters: Type.Object(
      {
        ...create.properties,
        ...existing.properties,
        action: StringEnum(["create", "validate", "freeze"]),
        prior_source: Type.Optional(create.properties.prior_source),
      },
      { additionalProperties: false },
    ),
    prepareArguments(args) {
      return validateToolArguments(
        { ...tool, parameters: original },
        {
          type: "toolCall",
          id: "web-plan-validation",
          name: tool.name,
          arguments: args as Record<string, unknown>,
        },
      );
    },
  };
}

/** Completing a Web deployment does not authorize a service shutdown. */
export function retainDeployedService(tool: AgentTool, intermediateTuningStep: () => boolean): AgentTool {
  if (tool.name !== "deploy_service") return tool;
  return { ...tool, async execute(id, args, signal, onUpdate) {
    if ((args as Record<string, unknown>).action === "stop" && !intermediateTuningStep()) {
      throw new Error("任务结束后运行时应保持运行。请继续整理结果；停止服务请由用户在运行时管理中主动发起。只有继续下一个调优候选时才允许停止中间运行时。");
    }
    return tool.execute(id, args, signal, onUpdate);
  }};
}
