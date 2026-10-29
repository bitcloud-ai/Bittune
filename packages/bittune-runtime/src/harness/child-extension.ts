import type {
	BashToolCallEvent,
	ExtensionFactory,
	ToolCallEvent,
	ToolResultEvent,
} from "../core/extensions/types.ts";
import { buildEvidenceFromResult, stageEvidence, type GenericToolResultEvent } from "./generic-evidence.ts";
import { evaluateGenericCall } from "./runtime-policy.ts";
import { COPY } from "./tui/copy.ts";

export const INVESTIGATE_TOOL_LIMIT = 12;

	export interface ChildPolicyExtensionOptions {
		protectedRoots: readonly string[];
		cwd: string;
		coreHome: string;
		parentSessionId: string;
		confirm: (title: string, reason: string) => Promise<boolean>;
		onToolResult?: () => void;
		warn?: (message: string) => void;
		stagedEvidence?: string[];
	}

function commandOf(event: ToolCallEvent): string | undefined {
	return (event as BashToolCallEvent).input?.command;
}

function pathOf(event: ToolCallEvent): string | undefined {
	const input = event.input as { path?: string };
	return input?.path;
}

	/**
	 * Child-session factory: scout bash allowlist, evidence staged for the parent
	 * to ingest, no managed tools, no /approval, no Core shutdown.
	 */
export function createChildPolicyExtension(options: ChildPolicyExtensionOptions): ExtensionFactory {
	return (pi): void => {
		pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
			if (event.toolName !== "bash" && event.toolName !== "read") {
				return { block: true, reason: "排查只能读取文件或运行调查命令。", terminate: false };
			}
				const outcome = evaluateGenericCall({
					toolName: event.toolName,
					command: commandOf(event),
					path: pathOf(event),
					cwd: ctx.cwd || options.cwd,
					protectedRoots: options.protectedRoots,
					profile: "scout",
				});
				if (outcome.decision === "allow") return;
				if (outcome.decision === "ask") {
					const approved = await options.confirm(COPY.confirm.investigate, outcome.reason);
				return approved ? undefined : { block: true, reason: `用户未确认：${outcome.reason}`, terminate: false };
			}
			return { block: true, reason: outcome.reason, terminate: false };
		});

			pi.on("tool_result", async (event: ToolResultEvent) => {
				options.onToolResult?.();
				if (event.toolName !== "bash" && event.toolName !== "read") return;
				const status = event.isError ? "failed" : "completed";
				const filename = stageEvidence(buildEvidenceFromResult(event as GenericToolResultEvent, status), {
					coreHome: options.coreHome,
					sessionId: options.parentSessionId,
					warn: options.warn ?? (() => undefined),
				});
				if (filename) options.stagedEvidence?.push(filename);
			});

		pi.on("session_before_compact", () => ({ cancel: true }));
	};
}
