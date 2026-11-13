import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum, validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/** The Web execution scope permits managed subjects and saved suite points only. */
export function exposeWorkbenchTool(tool: AgentTool): AgentTool {
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
