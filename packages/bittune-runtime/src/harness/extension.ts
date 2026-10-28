import { VERSION } from "../config.ts";
	import { createManagedTools, MANAGED_TOOL_NAMES, type ManagedToolDependencies } from "./managed-tools.ts";
	import { evaluateGenericCall, type PolicyOutcome } from "./runtime-policy.ts";
import { evaluateScopedGeneric, type TaskScope } from "./task-scope.ts";
	import { buildEvidenceFromResult, submitEvidence, type GenericToolResultEvent } from "./generic-evidence.ts";
	import type { ApprovalMode, SettingsManager } from "../core/settings-manager.ts";
	import type { ModelRuntime } from "../core/model-runtime.ts";
		import type {
			BashToolCallEvent,
			ExtensionAPI,
			ExtensionFactory,
			ExtensionUIDialogOptions,
			ToolCallEvent,
			ToolResultEvent,
		} from "../core/extensions/types.ts";
	import { createInvestigateTool, InvestigateScheduler } from "./subagent.ts";
	import { createBannerFactory, type BannerComponent } from "./tui/banner.ts";
		import { bindManagedHostPulse, probeHostPulse } from "./tui/host-pulse.ts";
	import { HostStatusStore, reduceHostStatus } from "./tui/host-status.ts";
	import { createMinimalFooterFactory, createStatusBarFactory, type StatusBarComponent } from "./tui/status-bar.ts";
	import { COPY } from "./tui/copy.ts";

const GENERIC_TOOLS = ["bash", "read", "edit", "write"] as const;
type GenericToolName = (typeof GENERIC_TOOLS)[number];

export interface HarnessExtensionOptions {
	taskScope?: TaskScope;
	/** BitTune-owned roots the Agent must never touch through generic tools. */
	protectedRoots: readonly string[];
	cwd: string;
	coreHome: string;
	client(): import("./core-client.ts").CoreClient | undefined;
		/** Interactive confirmation shown before a managed action with host side effects. */
		askApproval?: (title: string, message: string) => Promise<boolean>;
	/** Closes the session Core when the session shuts down. */
	closeClient?: () => Promise<void>;
	warn?: (message: string) => void;
	/** Global confirmation preference backed by settings (global-only). */
	approval?: {
		get(): ApprovalMode;
		set(mode: ApprovalMode): void;
	};
		/** Quiet start skips the wide banner and opens on the compact identity row. */
		quietStartup?: boolean;
		/** Child investigate sessions reuse the parent settings (read-only). */
		settingsManager?: SettingsManager;
		/** Child investigate sessions reuse the parent model runtime (no network refresh). */
		modelRuntime?: ModelRuntime;
		agentDir?: string;
	}

/**
 * Pure skip decision: an ask may be skipped only when the policy classified
 * it `ordinary` AND the user chose session or global skip. Explicit asks,
 * allow and deny are never affected. Defaults interpret unknown modes as
 * `ask` so a corrupt settings file fails safe.
 */
export function resolveApprovalSkip(
	confirmation: PolicyOutcome["confirmation"],
	mode: ApprovalMode | undefined,
	sessionSkip: boolean,
): boolean {
	if (confirmation !== "ordinary") return false;
	if (mode !== "session_skip" && mode !== "always_skip") return false;
	return mode === "always_skip" || sessionSkip;
}

function isGenericTool(toolName: string): toolName is GenericToolName {
	return (GENERIC_TOOLS as readonly string[]).includes(toolName);
}

function isStatusTool(toolName: string): boolean {
	return (MANAGED_TOOL_NAMES as readonly string[]).includes(toolName);
}

function actionOf(event: ToolCallEvent): string | undefined {
	const action = (event.input as { action?: unknown } | undefined)?.action;
	return typeof action === "string" ? action : undefined;
}

function commandOf(event: ToolCallEvent): string | undefined {
	return (event as BashToolCallEvent).input?.command;
}

function pathOf(event: ToolCallEvent): string | undefined {
	const input = event.input as { path?: string };
	return input?.path;
}

/**
 * The single Runtime assembly for Bittune sessions: the four generic tools
 * stay native, the ten managed tools are Core requests, policy runs at the
 * true execution point, and every generic call feeds the evidence intake.
 */
export function createHarnessExtension(options: HarnessExtensionOptions): ExtensionFactory {
		const dependencies: ManagedToolDependencies = { client: options.client };
	// Session-scoped in-memory skip; a new session starts fresh by design.
	let sessionSkip = false;
		const store = new HostStatusStore();
		const scheduler = new InvestigateScheduler();
			let banner: BannerComponent | undefined;
			let statusBar: StatusBarComponent | undefined;
			let stopManagedPulse: (() => void) | undefined;
		let inFlight: { toolName: string; action?: string } | undefined;
		let wrappedConfirmUi: { confirm: unknown } | undefined;
	const apply = (event: Parameters<typeof reduceHostStatus>[1]): void => {
		store.set(reduceHostStatus(store.get(), event));
	};
			const withConfirmStatus = (confirm: (title: string, message: string, opts?: ExtensionUIDialogOptions) => Promise<boolean>) => {
				return async (title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> => {
					if (inFlight?.toolName) {
						apply({ type: "confirm", open: true, toolName: inFlight.toolName, action: inFlight.action });
					}
					try {
						return await confirm(title, message, opts);
					} finally {
						if (inFlight?.toolName) {
							apply({ type: "confirm", open: false, toolName: inFlight.toolName, action: inFlight.action });
						}
					}
				};
			};
		return (pi: ExtensionAPI): void => {
			let notifyWarn: ((message: string) => void) | undefined;
			const warn = (message: string): void => {
				if (options.warn) {
					options.warn(message);
					return;
				}
				notifyWarn?.(message);
			};
			const askApproval = options.askApproval ? withConfirmStatus(options.askApproval) : undefined;
					const managedTools = createManagedTools(dependencies, {
						taskScope: options.taskScope,
						...(askApproval ? { askApproval } : {}),
					});
				const managedToolNames = managedTools.map((tool) => tool.name);
				for (const tool of managedTools) pi.registerTool(tool);
				const investigate =
					!options.taskScope && options.settingsManager && options.modelRuntime && options.agentDir
						? createInvestigateTool({
								cwd: options.cwd,
								agentDir: options.agentDir,
								protectedRoots: options.protectedRoots,
								coreHome: options.coreHome,
								settingsManager: options.settingsManager,
								modelRuntime: options.modelRuntime,
								client: options.client,
								store,
								scheduler,
								warn,
							})
						: undefined;
			if (investigate) pi.registerTool(investigate);

		const approvalLabel = (): string => {
			if (options.approval?.get() === "always_skip") return "确认偏好：始终跳过普通确认（/approval ask 恢复）";
			if (sessionSkip) return "确认偏好：本次会话跳过普通确认（/approval ask 恢复）";
			return "确认偏好：逐次确认";
		};

		pi.registerCommand("approval", {
			description: "设置普通确认偏好：ask（逐次确认）/ session（本次会话跳过）/ always（全局始终跳过）",
			handler: async (args, ctx) => {
				const mode = args.trim().toLowerCase();
				if (mode === "session") {
					sessionSkip = true;
				} else if (mode === "always") {
					sessionSkip = false;
					options.approval?.set("always_skip");
				} else if (mode === "ask" || mode === "") {
					sessionSkip = false;
					options.approval?.set("ask");
				} else {
					ctx.ui.notify("用法：/approval ask | session | always。", "warning");
					return;
				}
				ctx.ui.notify(`已设置：${approvalLabel()}。显式确认（危险命令、网络写入、受管操作、上传发布）始终不会被跳过。`, "info");
				ctx.ui.setStatus("bittune-approval", approvalLabel());
			},
		});

			pi.on("session_start", async (event, ctx) => {
					notifyWarn = (message) => ctx.ui.notify(message, "warning");
					pi.setActiveTools([
					...GENERIC_TOOLS,
					...managedToolNames,
					...(investigate ? [investigate.name] : []),
				]);
			ctx.ui.setStatus("bittune-approval", approvalLabel());
			if (wrappedConfirmUi !== ctx.ui) {
				const original = ctx.ui.confirm.bind(ctx.ui);
				(ctx.ui as { confirm: typeof ctx.ui.confirm }).confirm = withConfirmStatus(original);
				wrappedConfirmUi = ctx.ui;
			}
			if (ctx.mode === "tui") {
				const compact =
					event.reason === "new"
						? false
						: Boolean(options.quietStartup) || event.reason === "resume" || event.reason === "fork";
				ctx.ui.setHeader(
					createBannerFactory({
						store,
						version: VERSION,
						compact,
						onCreate: (next) => {
							banner?.dispose();
							banner = next;
						},
					}),
				);
				try {
					ctx.ui.setFooter((tui, theme) => {
						statusBar?.dispose();
						statusBar = createStatusBarFactory(store)(tui, theme);
						return statusBar;
					});
				} catch {
					statusBar?.dispose();
					ctx.ui.setFooter(createMinimalFooterFactory(store));
				}
					stopManagedPulse?.();
					stopManagedPulse = bindManagedHostPulse(store);
					void probeHostPulse()
						.then((host) => store.patch({ host }))
						.catch(() => undefined);
			}
		});

			pi.on("before_agent_start", async (_event, ctx) => {
				banner?.collapse();
				store.clearSettledCollab();

		});

		pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
			if (isStatusTool(event.toolName)) {
				inFlight = { toolName: event.toolName, action: actionOf(event) };
				apply({ type: "tool_call", toolName: event.toolName, action: inFlight.action });
				return;
			}
			if (!isGenericTool(event.toolName)) return;
			const policyInput = {
				toolName: event.toolName,
				command: commandOf(event),
				path: pathOf(event),
				cwd: ctx.cwd || options.cwd,
				protectedRoots: options.protectedRoots,
			};
			const defaultOutcome = evaluateGenericCall(policyInput);
			const outcome = defaultOutcome.decision === "deny" || !options.taskScope ? defaultOutcome : evaluateScopedGeneric(policyInput, options.taskScope);
			if (outcome.decision === "allow") return;
			// Ordinary asks may honor the session/global skip preference;
			// explicit asks and denies always reach the user.
			if (outcome.decision === "ask" && resolveApprovalSkip(outcome.confirmation, options.approval?.get(), sessionSkip)) {
				return;
			}
			const reason = formatPolicyBlock(outcome);
			if (outcome.decision === "ask" && ctx.hasUI) {
					const approved = await ctx.ui.confirm(COPY.confirm.policy, outcome.reason);
				return approved ? undefined : { block: true, reason, terminate: false };
			}
			return { block: true, reason, terminate: false };
		});

		pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
				if (isStatusTool(event.toolName)) {
					apply({
						type: "tool_result",
						toolName: event.toolName,
						details: event.details,
					});
					inFlight = undefined;
					return;
				}
				if (!isGenericTool(event.toolName)) return;
				const client = options.client();
				if (!client) return;
				const status = event.isError ? "failed" : "completed";
				const evidence = buildEvidenceFromResult(event as GenericToolResultEvent, status);
				const sessionId = ctx.sessionManager.getSessionId() ?? "external";
				const receipt = await submitEvidence(evidence, {
					client,
					coreHome: options.coreHome,
					sessionId,
					warn,
				});
				return {
					content: [...event.content, {
						type: "text" as const,
						text: receipt ? `Bittune evidence: ${JSON.stringify(receipt)}` : "Bittune evidence: not saved; no source IDs available.",
					}],
					details: { ...(event as GenericToolResultEvent).details, evidence: receipt ?? { status: "not_saved" } },
				};
		});

				pi.on("session_shutdown", async () => {
					scheduler.abortAll();
					stopManagedPulse?.();
					stopManagedPulse = undefined;
					banner?.dispose();
					statusBar?.dispose();
					banner = undefined;
					statusBar = undefined;
				await options.closeClient?.();
			});
	};
}

function formatPolicyBlock(outcome: PolicyOutcome): string {
	return outcome.decision === "ask" ? `用户未确认：${outcome.reason}` : outcome.reason;
}
