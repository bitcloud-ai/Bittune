import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentSession } from "../core/agent-session.ts";
import type { ExtensionContext, ToolDefinition } from "../core/extensions/types.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import { DefaultResourceLoader } from "../core/resource-loader.ts";
import { createAgentSession } from "../core/sdk.ts";
import { SessionManager } from "../core/session-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { createChildPolicyExtension, INVESTIGATE_TOOL_LIMIT } from "./child-extension.ts";
import type { CoreClient } from "./core-client.ts";
import { ingestStagedEvidenceSerial } from "./generic-evidence.ts";
	import { COPY, GENERIC_TOOL_LABELS, INVESTIGATE_LABEL } from "./tui/copy.ts";
	import {
		formatServiceText,
		formatVramText,
		HostStatusStore,
		truncateColumns,
		type HostSegment,
		type HostStatus,
		type ServiceSegment,
	} from "./tui/host-status.ts";

export const INVESTIGATE_SYSTEM_PROMPT = `你是 Bittune 的本机排查助手。只做只读调查：读日志、列目录、对照已有报告。
不要部署、不要压测、不要写报告、不要上传、不要改文件。
把发现写成简短结论交给核心 Agent。不要对用户直接说话。`;

	export const INVESTIGATE_TURN_LIMIT = 16;

	const HINT_PATH = /(?:[A-Za-z]:)?(?:\/|\\)[^\s"'`]+/g;

	function scoutHostLine(host: HostSegment): string | undefined {
		if (host.coreDown) return undefined;
		if (host.gpuText === COPY.probing) return undefined;
		const docker =
			host.docker === "ready" ? COPY.host.dockerReady : host.docker === "down" ? COPY.host.dockerDown : undefined;
		const vram = formatVramText(host);
		const gpu = vram ? `${host.gpuText} ${vram}` : host.gpuText;
		const parts = [gpu];
		if (docker) parts.push(docker);
		return `本机 ${parts.join(" · ")}`;
	}

	function scoutServiceLine(service: ServiceSegment): string | undefined {
		if (service.kind === "unseen") return undefined;
		return `受管服务 ${formatServiceText(service)}`;
	}

	function scoutHintPaths(hint?: string): string | undefined {
		if (!hint?.trim()) return undefined;
		const paths = hint.match(HINT_PATH);
		if (!paths || paths.length === 0) return undefined;
		const unique = [...new Set(paths)].map((path) => truncateColumns(path, 80));
		return `线索路径 ${unique.join(" ")}`;
	}

	/** Short host facts for scout. Empty when the pulse has not seen hardware yet. */
	export function formatScoutContextPack(
		status: Pick<HostStatus, "host" | "service">,
		hint?: string,
	): string {
		return [scoutHostLine(status.host), scoutServiceLine(status.service), scoutHintPaths(hint)].filter(Boolean).join("\n");
	}

	type ScoutModelRef = { provider: string; id: string; contextWindow?: number };

	function scoutModelKey(model: ScoutModelRef | undefined): string | undefined {
		return model ? `${model.provider}/${model.id}` : undefined;
	}

	function scoutModelSize(model: ScoutModelRef): number {
		return typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
			? model.contextWindow
			: Number.POSITIVE_INFINITY;
	}

	function lookupEnabledScoutModel(
		pattern: string,
		catalog: readonly ScoutModelRef[],
	): ScoutModelRef | undefined {
		const trimmed = pattern.trim();
		if (!trimmed) return undefined;
		const lower = trimmed.toLowerCase();
		const matches = catalog.filter(
			(model) => model.id.toLowerCase() === lower || `${model.provider}/${model.id}`.toLowerCase() === lower,
		);
		return matches.length === 1 ? matches[0] : undefined;
	}

	/** Use a second already-resolved model for scout when one exists; otherwise keep the parent. */
	export function resolveScoutModel(input: {
		parent?: ScoutModelRef;
		scopedModels?: ReadonlyArray<{ model?: ScoutModelRef }>;
		enabledModels?: readonly string[];
		catalog?: readonly ScoutModelRef[];
	}): ScoutModelRef | undefined {
		const parentKey = scoutModelKey(input.parent);
		const fromScoped = (input.scopedModels ?? [])
			.map((entry) => entry.model)
			.filter((model): model is ScoutModelRef => !!model);
		const catalog = input.catalog ?? [];
			const fromEnabled = (input.enabledModels ?? [])
				.map((pattern) => lookupEnabledScoutModel(pattern, catalog))
				.filter((model): model is ScoutModelRef => !!model);
		const unique: ScoutModelRef[] = [];
		const seen = new Set<string>();
		for (const model of [...fromScoped, ...fromEnabled]) {
			const key = scoutModelKey(model);
			if (!key || key === parentKey || seen.has(key)) continue;
			seen.add(key);
			unique.push(model);
		}
		if (unique.length === 0) return input.parent;
		unique.sort((a, b) => {
			const size = scoutModelSize(a) - scoutModelSize(b);
			if (size !== 0) return size;
			return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
		});
		return unique[0] ?? input.parent;
	}

	function scoutModelForInvestigate(
		parent: ExtensionContext["model"] | undefined,
		scoped: ExtensionContext["scopedModels"] | undefined,
		settingsManager: SettingsManager,
		modelRuntime: ModelRuntime,
	): ExtensionContext["model"] | undefined {
		try {
			const resolved = resolveScoutModel({
				parent,
				scopedModels: scoped,
				enabledModels: settingsManager.getEnabledModels?.() ?? [],
				catalog: modelRuntime.getModels?.() ?? [],
			});
			if (!resolved) return parent;
			if (scoutModelKey(resolved) === scoutModelKey(parent)) return parent;
			return resolved as ExtensionContext["model"];
		} catch {
			return parent;
		}
	}

export class InvestigateScheduler {
	private readonly active = new Map<string, { abort?: () => void }>();
	private readonly aborted = new Set<string>();

	get size(): number {
		return this.active.size;
	}

	tryAcquire(id: string): boolean {
		this.aborted.delete(id);
		if (this.active.size >= COPY.collab.capacity) return false;
		this.active.set(id, {});
		return true;
	}

	setAbort(id: string, abort: () => void): void {
		if (this.aborted.has(id) || !this.active.has(id)) {
			abort();
			return;
		}
		const handle = this.active.get(id);
		if (handle) handle.abort = abort;
	}

	wasAborted(id: string): boolean {
		return this.aborted.has(id);
	}

	release(id: string): void {
		this.active.delete(id);
		this.aborted.delete(id);
	}

	abortAll(): void {
		const entries = [...this.active.entries()];
		for (const [id, handle] of entries) {
			this.aborted.add(id);
			handle.abort?.();
		}
		this.active.clear();
	}
}

export interface CreateChildSessionOptions {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	modelRuntime: ModelRuntime;
	model?: ExtensionContext["model"];
	protectedRoots: readonly string[];
		coreHome: string;
		parentSessionId: string;
		confirm: (title: string, reason: string) => Promise<boolean>;
		store?: HostStatusStore;
		collabId?: string;
		warn?: (message: string) => void;
		onLimit?: () => void;
		stagedEvidence?: string[];
	}

export async function createChildSession(options: CreateChildSessionOptions): Promise<AgentSession> {
	const handle: { abort?: () => void; toolCount: number } = { toolCount: 0 };
		const confirm = async (title: string, reason: string): Promise<boolean> => {
			if (options.store && options.collabId) {
				options.store.setCollab(options.collabId, { phase: "awaiting_confirm" });
			}
			const approved = await options.confirm(title, reason);
			if (options.store && options.collabId) {
				options.store.setCollab(options.collabId, { phase: approved ? "running" : "failed" });
			}
			return approved;
		};
	const childLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager: options.settingsManager,
		extensionFactories: [
			{
				name: "bittune-child",
				hidden: true,
				factory: createChildPolicyExtension({
					protectedRoots: options.protectedRoots,
					cwd: options.cwd,
					coreHome: options.coreHome,
						parentSessionId: options.parentSessionId,
						confirm,
						warn: options.warn,
						stagedEvidence: options.stagedEvidence,
					onToolResult: () => {
						handle.toolCount += 1;
						if (handle.toolCount >= INVESTIGATE_TOOL_LIMIT) {
							options.onLimit?.();
							handle.abort?.();
						}
					},
				}),
			},
		],
		staticOnly: true,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: INVESTIGATE_SYSTEM_PROMPT,
	});
	await childLoader.reload();
	const { session: child } = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		modelRuntime: options.modelRuntime,
		model: options.model,
		thinkingLevel: "off",
		tools: ["read", "bash"],
		availableTools: ["read", "bash"],
		resourceLoader: childLoader,
		settingsManager: options.settingsManager,
		sessionManager: SessionManager.inMemory(options.cwd),
	});
	handle.abort = () => {
		void child.abort();
	};
		let turns = 0;
		child.subscribe((event) => {
			if (event.type === "compaction_start") void child.abort();
			if (event.type === "turn_end") {
				turns += 1;
				if (turns >= INVESTIGATE_TURN_LIMIT) {
					options.onLimit?.();
					handle.abort?.();
				}
			}
		});
	return child;
}

export interface CreateInvestigateToolOptions {
	cwd: string;
	agentDir: string;
	protectedRoots: readonly string[];
	coreHome: string;
	settingsManager: SettingsManager;
	modelRuntime: ModelRuntime;
	client(): CoreClient | undefined;
	store: HostStatusStore;
	scheduler: InvestigateScheduler;
	warn?: (message: string) => void;
		createSession?: (options: CreateChildSessionOptions) => Promise<AgentSession>;
	}

	export type InvestigateStepStatus = "running" | "done" | "failed";

	export interface InvestigateStep {
		id: string;
		name: "read" | "bash";
		target: string;
		status: InvestigateStepStatus;
	}

		export function investigateTitle(goal: string): string {
			const trimmed = goal.trim();
			return trimmed ? `${INVESTIGATE_LABEL} · ${trimmed}` : INVESTIGATE_LABEL;
		}

		export function formatInvestigateCallTitle(goal: string, stepCount: number, inProgress: boolean): string {
			const title = investigateTitle(goal);
			if (!inProgress) return title;
			const n = Number.isFinite(stepCount) && stepCount > 0 ? Math.floor(stepCount) : 0;
			return `${title}  ${COPY.collab.stepRunning} ${n}/${INVESTIGATE_TOOL_LIMIT}`;
		}

		export function formatInvestigateSteps(steps: readonly InvestigateStep[]): string {
			return steps
				.map((step) => {
					const label = step.name === "read" ? GENERIC_TOOL_LABELS.read : GENERIC_TOOL_LABELS.bash;
					const target = step.target ? `  ${truncateColumns(step.target, 80)}` : "";
					const status =
						step.status === "running"
							? COPY.collab.stepRunning
							: step.status === "failed"
								? COPY.collab.stepFailed
								: COPY.collab.stepDone;
					return ` · ${label}${target}  ${status}`;
				})
				.join("\n");
		}

		export function collabTitleFromSteps(goal: string, steps: readonly InvestigateStep[]): string {
			const live = [...steps].reverse().find((step) => step.status === "running") ?? steps.at(-1);
			if (!live) return truncateColumns(goal, 16);
			const label = live.name === "read" ? GENERIC_TOOL_LABELS.read : GENERIC_TOOL_LABELS.bash;
			const text = live.target ? `${label} ${live.target}` : label;
			return truncateColumns(text, 16);
		}

		function investigateSteps(details: unknown): readonly InvestigateStep[] {
			if (!details || typeof details !== "object") return [];
			const steps = (details as { steps?: unknown }).steps;
			return Array.isArray(steps) ? (steps as InvestigateStep[]) : [];
		}

		function investigateConclusion(result: AgentToolResult<unknown>): string {
			return result.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
				.map((part) => part.text)
				.join("\n")
				.trim();
		}

	function childStepTarget(name: string, args: unknown): string {
		const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
		if (name === "read") return String(input.path ?? "");
		return String(input.command ?? "");
	}

	const INVESTIGATE_PARAMETERS = Type.Object({
		goal: Type.String({ description: "一句话排查任务" }),
		hint: Type.Optional(Type.String({ description: "路径或日志线索" })),
	}, { additionalProperties: false });

	export function createInvestigateTool(options: CreateInvestigateToolOptions): ToolDefinition<typeof INVESTIGATE_PARAMETERS> {
		return {
			name: "investigate",
			label: INVESTIGATE_LABEL,
			description: "并行只读排查：读日志、扫目录、对照已有报告。不要用它部署或压测。",
			parameters: INVESTIGATE_PARAMETERS,
				executionMode: "parallel",
					renderCall(args, theme, context) {
						const state = context.state as InvestigateRenderState;
						const text = state.title ?? (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
						state.title = text;
						const goal = typeof args.goal === "string" ? args.goal : "";
						text.setText(
							theme.fg(
								"toolTitle",
								theme.bold(formatInvestigateCallTitle(goal, state.stepCount ?? 0, context.isPartial)),
							),
						);
						return text;
					},
					renderResult(result, options, theme, context) {
						const state = context.state as InvestigateRenderState;
						const steps = investigateSteps(result.details);
						state.stepCount = steps.length;
						const goal = typeof context.args.goal === "string" ? context.args.goal : "";
						if (state.title) {
							state.title.setText(
								theme.fg(
									"toolTitle",
									theme.bold(formatInvestigateCallTitle(goal, steps.length, options.isPartial)),
								),
							);
						}
						const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
						const stepText = formatInvestigateSteps(steps);
						const conclusion = options.isPartial ? "" : investigateConclusion(result);
						const body = [stepText, conclusion].filter(Boolean).join("\n");
						text.setText(body ? theme.fg("toolOutput", body) : "");
						return text;
					},
			execute: async (toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<unknown>> => {
				const input = params as Record<string, unknown>;
				const id = toolCallId || randomUUID();
				if (!options.scheduler.tryAcquire(id)) {
					return { content: [{ type: "text", text: COPY.errors.investigateBusy }], details: {} };
				}
				const goal = typeof input.goal === "string" ? input.goal : "";
				const parentSessionId = ctx.sessionManager.getSessionId() ?? "external";
				const stagedEvidence: string[] = [];
				const steps: InvestigateStep[] = [];
				const warn = options.warn ?? (() => undefined);
					const emitSteps = (): void => {
						const text = formatInvestigateSteps(steps);
						if (!text) return;
						options.store.setCollab(id, { title: collabTitleFromSteps(goal, steps) });
						onUpdate?.({ content: [{ type: "text", text }], details: { steps: steps.map((step) => ({ ...step })) } });
					};
				const applyChildEvent = (event: {
					type: string;
					toolCallId?: string;
					toolName?: string;
					args?: unknown;
					isError?: boolean;
				}): void => {
					if (event.toolName !== "bash" && event.toolName !== "read") return;
					const stepId = event.toolCallId || randomUUID();
					const existing = steps.find((step) => step.id === stepId);
					if (event.type === "tool_execution_start") {
						const target = childStepTarget(event.toolName, event.args);
						if (existing) {
							existing.status = "running";
							existing.target = target;
						} else {
							steps.push({ id: stepId, name: event.toolName, target, status: "running" });
						}
						emitSteps();
						return;
					}
					if (event.type !== "tool_execution_end") return;
					if (existing) {
						existing.status = event.isError ? "failed" : "done";
					} else {
						steps.push({
							id: stepId,
							name: event.toolName,
							target: childStepTarget(event.toolName, event.args),
							status: event.isError ? "failed" : "done",
						});
					}
					emitSteps();
				};
				options.store.setCollab(id, { title: truncateColumns(goal, 16), phase: "running" });
				let child: AgentSession | undefined;
				let cancelled = false;
				let limited = false;
				const abortChild = (): void => {
					cancelled = true;
					void child?.abort();
				};
				options.scheduler.setAbort(id, abortChild);
				if (signal?.aborted || options.scheduler.wasAborted(id)) {
					options.store.setCollab(id, { phase: "failed" });
					options.scheduler.release(id);
					return { content: [{ type: "text", text: COPY.errors.investigateCancelled }], details: {} };
				}
				const onAbort = (): void => abortChild();
				signal?.addEventListener("abort", onAbort);
				try {
						child = await (options.createSession ?? createChildSession)({
							cwd: options.cwd,
							agentDir: options.agentDir,
							settingsManager: options.settingsManager,
							modelRuntime: options.modelRuntime,
							model: scoutModelForInvestigate(
								ctx.model,
								ctx.scopedModels,
								options.settingsManager,
								options.modelRuntime,
							),
						protectedRoots: options.protectedRoots,
						coreHome: options.coreHome,
						parentSessionId,
						warn,
						store: options.store,
						collabId: id,
						stagedEvidence,
						confirm: (title, reason) => ctx.ui.confirm(title, reason),
						onLimit: () => {
							limited = true;
							void child?.abort();
						},
					});
					if (typeof child.subscribe === "function") {
						child.subscribe((event) => applyChildEvent(event));
					}
					options.scheduler.setAbort(id, abortChild);
						if (cancelled || limited || signal?.aborted || options.scheduler.wasAborted(id)) {
							void child.abort();
							options.store.setCollab(id, { phase: "failed" });
							return limited
								? limitedInvestigateResult(child, steps)
								: { content: [{ type: "text", text: COPY.errors.investigateCancelled }], details: {} };
						}
							const hint = typeof input.hint === "string" ? input.hint : "";
							const pack = formatScoutContextPack(options.store.get(), hint);
							const task = hint ? `${goal}\n${hint}` : goal;
							await child.prompt(pack ? `${pack}\n${task}` : task);
						if (limited) {
							options.store.setCollab(id, { phase: "failed" });
							return limitedInvestigateResult(child, steps);
						}
						if (cancelled || signal?.aborted || options.scheduler.wasAborted(id)) {
							options.store.setCollab(id, { phase: "failed" });
							return { content: [{ type: "text", text: COPY.errors.investigateCancelled }], details: {} };
						}
						options.store.setCollab(id, { phase: "done" });
						return { content: [{ type: "text", text: summarizeChild(child) }], details: { steps } };
					} catch {
						options.store.setCollab(id, { phase: "failed" });
						if (limited) return limitedInvestigateResult(child, steps);
						const text =
							cancelled || signal?.aborted || options.scheduler.wasAborted(id)
								? COPY.errors.investigateCancelled
								: COPY.errors.investigateFailed;
						return { content: [{ type: "text", text }], details: {} };
					} finally {
					signal?.removeEventListener("abort", onAbort);
					const client = options.client();
					if (client && stagedEvidence.length > 0) {
						await ingestStagedEvidenceSerial(stagedEvidence, {
							client,
							coreHome: options.coreHome,
							sessionId: parentSessionId,
							warn,
						});
					}
					child?.dispose();
					options.scheduler.release(id);
				}
			},
		};
	}

			const EMPTY_INVESTIGATE = "排查未返回结论。";

			type InvestigateRenderState = {
				title?: Text;
				stepCount?: number;
			};

		function limitedInvestigateResult(
			child: AgentSession | undefined,
			steps: InvestigateStep[],
		): AgentToolResult<unknown> {
			return {
				content: [{ type: "text", text: limitedInvestigateText(child) }],
				details: { steps },
			};
		}

		function limitedInvestigateText(child: AgentSession | undefined): string {
			if (!child) return COPY.errors.investigateLimit;
			const findings = summarizeChild(child);
			if (!findings || findings === EMPTY_INVESTIGATE) return COPY.errors.investigateLimit;
			return `${COPY.errors.investigateLimit}\n${findings}`;
		}

		function summarizeChild(child: AgentSession): string {
			const conclusions: string[] = [];
			const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
			const summaries: string[] = [];
			for (const message of child.messages) {
				if (message.role === "assistant") {
					const text = contentText(message.content);
					if (text.trim()) conclusions.push(text.trim());
					for (const part of message.content) {
						if (part.type !== "toolCall") continue;
						calls.set(part.id, {
							name: part.name,
							args: (part.arguments ?? {}) as Record<string, unknown>,
						});
					}
				} else if (message.role === "toolResult") {
					const call = calls.get(message.toolCallId);
					if (!call || (call.name !== "read" && call.name !== "bash")) continue;
					const target =
						call.name === "read" ? String(call.args.path ?? "") : String(call.args.command ?? "");
					const label = call.name === "read" ? GENERIC_TOOL_LABELS.read : GENERIC_TOOL_LABELS.bash;
					const head = target ? `${label} ${truncateColumns(target, 80)}` : label;
					summaries.push(head);
				}
			}
				const parts = [...conclusions, ...summaries];
				return parts.join("\n") || EMPTY_INVESTIGATE;
			}
