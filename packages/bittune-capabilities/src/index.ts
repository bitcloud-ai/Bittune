import type { ExtensionAPI, ExtensionFactory, ToolDefinition, ToolResultEvent } from "../../bittune-runtime/src/core/extensions/types.ts";
import { HISTORICAL_EVIDENCE_TOOL_NAMES } from "./shared/capability-catalog.ts";
import { ACTIVE_OPTIMIZATION_CONTEXT_SESSION_ENTRY, activeOptimizationContextIdFromSessionEntries } from "./shared/optimization-context.ts";
import { StateStore } from "./shared/state-store.ts";
import { createToolRegistry } from "./tool-registry.ts";

const SESSION_BUILTIN_TOOL_NAMES = ["read", "bash"];

export interface BittuneExtensionOptions {
  stateRoot?: string;
  namespaceId?: string;
  /** Read-only MCP tools prepared by the controlled runtime before session creation. */
  externalTools?: readonly ToolDefinition[];
  /** Closes connections backing externally registered tools on session shutdown. */
  closeExternalTools?: () => Promise<void>;
  /** A new evidence namespace that must not read prior session evidence. */
  freshExperiment?: boolean;
}

function optimizationContextIdFromToolResult(event: ToolResultEvent): string | undefined {
  if (event.isError) return undefined;
  if (event.toolName === "create_optimization_context") {
    const contextId = event.input.context_id;
    return typeof contextId === "string" ? contextId : undefined;
  }
  if (event.toolName !== "resolve_optimization_context") return undefined;
  const text = event.content.find((item): item is { type: "text"; text: string } => item.type === "text")?.text;
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as { query_data?: { context?: { context_id?: unknown } } };
    const contextId = value.query_data?.context?.context_id;
    return typeof contextId === "string" ? contextId : undefined;
  } catch {
    return undefined;
  }
}

function bashMayHaveChangedManagedState(event: ToolResultEvent): boolean {
  const command = typeof event.input.command === "string" ? event.input.command.trim() : "";
  if (!command || /[;&|`\n]/.test(command)) return true;
  return !/^(?:nvidia-smi|docker\s+(?:ps|container\s+(?:ls|inspect|logs)|image\s+inspect|version|info)|(?:cat|ls|grep|find|df|free|uname|lscpu|pwd|which)\b)/.test(command);
}

export function createBittuneExtension(options: BittuneExtensionOptions = {}): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    const domainTools = createToolRegistry(options.stateRoot, options.namespaceId);
    const externalToolNames = (options.externalTools ?? []).map((tool) => tool.name);
    const activeToolNames = () => [
      ...SESSION_BUILTIN_TOOL_NAMES,
      ...domainTools
        .map((tool) => tool.name)
        .filter((name) => !options.freshExperiment || !HISTORICAL_EVIDENCE_TOOL_NAMES.includes(name as typeof HISTORICAL_EVIDENCE_TOOL_NAMES[number])),
      ...externalToolNames,
    ];

    for (const tool of [...domainTools, ...(options.externalTools ?? [])]) pi.registerTool(tool);
    pi.on("session_start", async () => {
      // All trusted domain tools are available in every conversation. Individual
      // tools enforce their own evidence and resource prerequisites.
      pi.setActiveTools(activeToolNames());
    });
    pi.on("session_shutdown", async () => {
      await options.closeExternalTools?.();
    });
    // Context IDs are internal plumbing. A binding made by create/resolve is
    // injected only for Tools that already accept an optional context_id.
    pi.on("tool_call", async (event, context) => {
      const input = event.input as Record<string, unknown>;
      if (options.freshExperiment && HISTORICAL_EVIDENCE_TOOL_NAMES.includes(event.toolName as typeof HISTORICAL_EVIDENCE_TOOL_NAMES[number])) {
        return {
          block: true,
          reason: "This fresh experiment does not read prior Run records or Artifact excerpts. Use evidence created in this session and pass the returned IDs directly.",
          terminate: false,
        };
      }
      if (["create_optimization_candidate", "reserve_optimization_attempt"].includes(event.toolName) && input.context_id === undefined) {
        const contextId = activeOptimizationContextIdFromSessionEntries(context.sessionManager.getBranch());
        if (contextId) input.context_id = contextId;
      }
    });
    pi.on("tool_result", async (event: ToolResultEvent) => {
      const contextId = optimizationContextIdFromToolResult(event);
      if (contextId) pi.appendEntry(ACTIVE_OPTIMIZATION_CONTEXT_SESSION_ENTRY, { context_id: contextId, bound_at: new Date().toISOString() });
      if (event.toolName !== "bash" || !bashMayHaveChangedManagedState(event)) return;
      const store = new StateStore(options.stateRoot, options.namespaceId);
      try {
        await store.markRuntimeServicesStale();
      } finally {
        store.close();
      }
    });
  };
}

export default function bittune(pi: ExtensionAPI): void {
  createBittuneExtension()(pi);
}
