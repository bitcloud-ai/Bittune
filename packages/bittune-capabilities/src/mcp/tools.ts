import Ajv2020Import, { type ValidateFunction } from "ajv/dist/2020.js";
import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "../../../bittune-runtime/src/core/extensions/types.ts";
import type { McpExternalTool } from "../../../bittune-runtime/src/core/mcp/types.ts";
import type { McpArgumentBinding } from "../../../bittune-runtime/src/core/mcp/config.ts";
import { BittuneError } from "../shared/errors.ts";
import { RunRecorder } from "../shared/run-recorder.ts";
import { createBittuneTool } from "../shared/tool.ts";

const MAX_INPUT_DEPTH = 6;
const MAX_INPUT_PROPERTIES = 64;
const MAX_INPUT_ARRAY_ITEMS = 64;
const MAX_INPUT_STRING_CHARS = 8_000;
const MAX_RESULT_CHARS = 12_000;
const RECOMMENDATION_GPU_MAX_AGE_SECONDS = 300;
const Ajv2020 = Ajv2020Import.default;

export interface McpToolRegistrationResult {
  tools: ToolDefinition[];
  recommendationToolNames: string[];
  diagnostics: string[];
}

function agentToolName(tool: McpExternalTool): string {
  return `mcp_${tool.serverName.replaceAll("-", "_")}__${tool.remoteName.replaceAll("-", "_")}`;
}

function assertInputBounds(value: unknown, depth = 0): void {
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > MAX_INPUT_STRING_CHARS) throw new BittuneError("mcp_input_limit", `MCP input strings must not exceed ${MAX_INPUT_STRING_CHARS} characters.`, false);
    return;
  }
  if (depth >= MAX_INPUT_DEPTH) throw new BittuneError("mcp_input_limit", `MCP input nesting must not exceed ${MAX_INPUT_DEPTH} levels.`, false);
  if (Array.isArray(value)) {
    if (value.length > MAX_INPUT_ARRAY_ITEMS) throw new BittuneError("mcp_input_limit", `MCP input arrays must not exceed ${MAX_INPUT_ARRAY_ITEMS} items.`, false);
    for (const item of value) assertInputBounds(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") throw new BittuneError("mcp_invalid_arguments", "MCP input must be JSON data.", false);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_INPUT_PROPERTIES) throw new BittuneError("mcp_input_limit", `MCP input objects must not exceed ${MAX_INPUT_PROPERTIES} properties.`, false);
  for (const [, item] of entries) assertInputBounds(item, depth + 1);
}

function validateArguments(validator: ValidateFunction, params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new BittuneError("mcp_invalid_arguments", "MCP tool arguments must be an object.", false);
  }
  assertInputBounds(params);
  if (!validator(params)) {
    const issues = (validator.errors ?? []).slice(0, 8).map((error) => ({ path: error.instancePath || "/", keyword: error.keyword, message: error.message }));
    throw new BittuneError("mcp_invalid_arguments", "MCP tool arguments do not match the server schema.", false, { issues });
  }
  return params as Record<string, unknown>;
}

function resolveJsonPointer(value: unknown, pointer: string): unknown {
  if (!pointer) return value;
  let current = value;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || typeof current !== "object" || Array.isArray(current) && !/^\d+$/.test(segment)) {
      throw new BittuneError("mcp_binding_not_found", `The configured source data does not contain ${pointer}.`, false);
    }
    const next = (current as Record<string, unknown>)[segment];
    if (next === undefined) throw new BittuneError("mcp_binding_not_found", `The configured source data does not contain ${pointer}.`, false);
    current = next;
  }
  return current;
}

async function resolveBinding(binding: McpArgumentBinding, store: { listRuns: (filter: { tool_name: string; status: "completed"; limit: number }) => Promise<Array<{ run_id: string; finished_at: string }>>; getRun: (runId: string) => Promise<{ observation: { data?: unknown } }> }): Promise<unknown> {
  const [latest] = await store.listRuns({ tool_name: binding.toolName, status: "completed", limit: 1 });
  if (!latest) throw new BittuneError("mcp_binding_missing_observation", `Call ${binding.toolName} before using this external MCP tool.`, false);
  if (binding.maxAgeSeconds !== undefined) {
    const ageMs = Date.now() - Date.parse(latest.finished_at);
    if (!Number.isFinite(ageMs) || ageMs > binding.maxAgeSeconds * 1_000) {
      throw new BittuneError("mcp_binding_stale_observation", `The latest ${binding.toolName} observation is older than ${binding.maxAgeSeconds} seconds; refresh it before calling this external MCP tool.`, false);
    }
  }
  const { observation } = await store.getRun(latest.run_id);
  return resolveJsonPointer(observation.data, binding.dataPointer);
}

async function bindArguments(external: McpExternalTool, params: unknown, store: Parameters<typeof resolveBinding>[1]): Promise<Record<string, unknown>> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new BittuneError("mcp_invalid_arguments", "MCP tool arguments must be an object.", false);
  }
  assertInputBounds(params);
  const bound = { ...(params as Record<string, unknown>) };
  for (const [argumentName, binding] of Object.entries(external.argumentBindings)) {
    bound[argumentName] = await resolveBinding(binding, store);
  }
  assertInputBounds(bound);
  return bound;
}

async function requireFreshGpuObservation(store: {
  listRuns: (filter: { tool_name: string; status: "completed"; limit: number }) => Promise<Array<{ run_id: string; finished_at: string }>>;
  getRun: (runId: string) => Promise<{ observation: { ok: boolean } }>;
}): Promise<void> {
  const [latest] = await store.listRuns({ tool_name: "inspect_gpu", status: "completed", limit: 1 });
  if (!latest) throw new BittuneError("mcp_gpu_observation_required", "Call inspect_gpu before requesting model or deployment recommendations.", false);
  const ageMs = Date.now() - Date.parse(latest.finished_at);
  if (!Number.isFinite(ageMs) || ageMs > RECOMMENDATION_GPU_MAX_AGE_SECONDS * 1_000) {
    throw new BittuneError("mcp_gpu_observation_required", `Refresh inspect_gpu within ${RECOMMENDATION_GPU_MAX_AGE_SECONDS} seconds before requesting model or deployment recommendations.`, false);
  }
  if (!(await store.getRun(latest.run_id)).observation.ok) {
    throw new BittuneError("mcp_gpu_observation_required", "The latest inspect_gpu observation failed; refresh it before requesting model or deployment recommendations.", false);
  }
}

function boundedExternalResult(result: { content: unknown; structuredContent?: unknown }): { content: unknown; structuredContent?: unknown; truncated: boolean } {
  let serialized: string;
  try {
    serialized = JSON.stringify({ content: result.content, ...(result.structuredContent === undefined ? {} : { structured_content: result.structuredContent }) });
  } catch {
    serialized = "[External MCP result is not JSON-serializable.]";
  }
  if (serialized.length <= MAX_RESULT_CHARS) {
    return { content: result.content, ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }), truncated: false };
  }
  return {
    content: [{ type: "text", text: `${serialized.slice(0, MAX_RESULT_CHARS)}\n[External MCP result truncated.]` }],
    truncated: true,
  };
}

function createMcpTool(recorder: RunRecorder, external: McpExternalTool, validator: ValidateFunction): ToolDefinition<TSchema> {
  const name = agentToolName(external);
  const hint = external.hint ? ` ${external.hint}` : "";
  const purpose = external.purpose ?? "reference";
  return createBittuneTool({
    name,
    label: `MCP ${external.serverName}: ${external.remoteName}`,
    recording: "query",
    recorder,
    parameters: Type.Unsafe(external.inputSchema),
    description: `[external:mcp:${external.serverName};purpose:${purpose}] ${external.description} External reference only; it is not local evidence or execution authorization.${hint}`,
    async execute(params, context) {
      if (purpose === "model-recommendation" || purpose === "deployment-knowledge") await requireFreshGpuObservation(context.store);
      const input = validateArguments(validator, await bindArguments(external, params, context.store));
      const result = await external.call(input, context.signal);
      if (result.isError) {
        throw new BittuneError(
          "mcp_external_tool_error",
          `External MCP server ${external.serverName} reported an error for ${external.remoteName}.`,
          false,
          { server: external.serverName, tool: external.remoteName },
        );
      }
      const projection = boundedExternalResult(result);
      return {
        summary: `Retrieved external reference information from ${external.serverName}/${external.remoteName}.`,
        provenance_type: "estimated",
        data: {
          external_reference: true,
          server: external.serverName,
          tool: external.remoteName,
          is_error: false,
          content: projection.content,
          ...(projection.structuredContent === undefined ? {} : { structured_content: projection.structuredContent }),
        },
        warnings: [
          "External MCP results are reference information, not local machine evidence.",
          ...(projection.truncated ? [`External MCP result was truncated to ${MAX_RESULT_CHARS} characters.`] : []),
        ],
        provider: { name: `mcp:${external.serverName}` },
      };
    },
  });
}

export function createMcpTools(recorder: RunRecorder, externalTools: readonly McpExternalTool[]): McpToolRegistrationResult {
  const tools: ToolDefinition[] = [];
  const recommendationToolNames: string[] = [];
  const diagnostics: string[] = [];
  const names = new Set<string>();
  for (const external of externalTools) {
    const name = agentToolName(external);
    if (names.has(name)) {
      diagnostics.push(`Skipped ${external.serverName}/${external.remoteName}: generated tool name ${name} conflicts with another enabled MCP tool.`);
      continue;
    }
    try {
      const validator = new Ajv2020({ allErrors: true, strict: false }).compile(external.inputSchema);
      tools.push(createMcpTool(recorder, external, validator));
      if (external.purpose === "model-recommendation" || external.purpose === "deployment-knowledge") recommendationToolNames.push(name);
      names.add(name);
    } catch (error) {
      diagnostics.push(`Skipped ${external.serverName}/${external.remoteName}: invalid input schema (${error instanceof Error ? error.message : String(error)}).`);
    }
  }
  return { tools, recommendationToolNames, diagnostics };
}
