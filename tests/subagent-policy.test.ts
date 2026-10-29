	import assert from "node:assert/strict";
	import type { Dirent } from "node:fs";
	import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "../packages/bittune-runtime/src/core/model-runtime.ts";
import { SettingsManager } from "../packages/bittune-runtime/src/core/settings-manager.ts";
import type { ExtensionContext } from "../packages/bittune-runtime/src/core/extensions/types.ts";
import type { CoreClient } from "../packages/bittune-runtime/src/harness/core-client.ts";
import { BITTUNE_SYSTEM_PROMPT_MARKER } from "../packages/bittune-runtime/src/harness/system-prompt.ts";
				import {
					collabTitleFromSteps,
					createChildSession,
					createInvestigateTool,
					formatInvestigateCallTitle,
					formatInvestigateSteps,
					formatScoutContextPack,
					INVESTIGATE_SYSTEM_PROMPT,
					investigateTitle,
					InvestigateScheduler,
					resolveScoutModel,
					type CreateChildSessionOptions,
				} from "../packages/bittune-runtime/src/harness/subagent.ts";
	import { ingestStagedEvidenceSerial } from "../packages/bittune-runtime/src/harness/generic-evidence.ts";
	import { COPY } from "../packages/bittune-runtime/src/harness/tui/copy.ts";
	import { formatCollabText, hostFromDoctor, HostStatusStore } from "../packages/bittune-runtime/src/harness/tui/host-status.ts";

interface EvidenceCall {
	tool: string;
	params: unknown;
	opts?: { sessionId?: string };
}

interface ChildHarness {
	root: string;
	cwd: string;
	agentDir: string;
	coreHome: string;
	protectedRoot: string;
	parentSessionId: string;
	store: HostStatusStore;
	collabId: string;
	confirms: Array<{ title: string; reason: string }>;
	confirmImpl: (title: string, reason: string) => Promise<boolean>;
		evidenceCalls: EvidenceCall[];
		stagedEvidence: string[];
		client: CoreClient;
	settingsManager: SettingsManager;
	modelRuntime: ModelRuntime;
	child: Awaited<ReturnType<typeof createChildSession>>;
}

type AgentHooks = {
	beforeToolCall?: (input: {
		toolCall: { name: string; id: string };
		args: Record<string, unknown>;
	}) => Promise<{ block?: boolean; reason?: string } | undefined>;
	afterToolCall?: (input: {
		toolCall: { name: string; id: string };
		args: Record<string, unknown>;
		result: { content: unknown; details?: unknown; usage?: unknown };
		isError: boolean;
	}) => Promise<unknown>;
};

function hooksOf(child: ChildHarness["child"]): AgentHooks {
	return child.agent as unknown as AgentHooks;
}

async function withChild(
	fn: (harness: ChildHarness) => Promise<void>,
	options: { confirmImpl?: ChildHarness["confirmImpl"] } = {},
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "bittune-subagent-"));
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	const coreHome = join(root, "core");
	const protectedRoot = join(root, "protected");
	const previousKey = process.env.BITTUNE_TEST_API_KEY;
	process.env.BITTUNE_TEST_API_KEY = "test-key";
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await mkdir(coreHome, { recursive: true });
	await mkdir(protectedRoot, { recursive: true });
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"bittune-test": {
					baseUrl: "http://127.0.0.1:18000/v1",
					api: "openai-completions",
					apiKey: "$BITTUNE_TEST_API_KEY",
					authHeader: true,
					models: [{ id: "test-agent-model", input: ["text"], reasoning: false }],
				},
			},
		}),
	);
	const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
	const modelRuntime = await ModelRuntime.create({
		modelsPath: join(agentDir, "models.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	await modelRuntime.refresh({ allowNetwork: false });
	const model = modelRuntime.getModel("bittune-test", "test-agent-model");
	const evidenceCalls: EvidenceCall[] = [];
	const client = {
		request: async (tool: string, params: unknown, opts?: { sessionId?: string }) => {
			evidenceCalls.push({ tool, params, opts });
			return {};
		},
	} as CoreClient;
		const store = new HostStatusStore();
		const collabId = "inv-1";
		const stagedEvidence: string[] = [];
		store.setCollab(collabId, { title: "看日志", phase: "running" });
	const confirms: Array<{ title: string; reason: string }> = [];
	const confirmImpl =
		options.confirmImpl ??
		(async (title: string, reason: string) => {
			confirms.push({ title, reason });
			return false;
		});
	const childOptions: CreateChildSessionOptions = {
		cwd,
		agentDir,
		settingsManager,
		modelRuntime,
		model,
		protectedRoots: [protectedRoot],
			coreHome,
			parentSessionId: "parent-sess-1",
			store,
			collabId,
			stagedEvidence,
			confirm: async (title, reason) => {
			confirms.push({ title, reason });
			return confirmImpl(title, reason);
		},
	};
	const child = await createChildSession(childOptions);
	const harness: ChildHarness = {
		root,
		cwd,
		agentDir,
		coreHome,
		protectedRoot,
		parentSessionId: "parent-sess-1",
		store,
		collabId,
		confirms,
		confirmImpl,
			evidenceCalls,
			stagedEvidence,
			client,
		settingsManager,
		modelRuntime,
		child,
	};
	try {
		await fn(harness);
	} finally {
		child.dispose();
		if (previousKey === undefined) delete process.env.BITTUNE_TEST_API_KEY;
		else process.env.BITTUNE_TEST_API_KEY = previousKey;
		await rm(root, { recursive: true, force: true });
	}
}

async function jsonlFiles(root: string): Promise<string[]> {
	const found: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
			let entries: Dirent[] = [];
			try {
				entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) stack.push(path);
			else if (entry.name.endsWith(".jsonl")) found.push(path);
		}
	}
	return found;
}

	test("spike: child bash deny is intercepted by child factory", async () => {
		await withChild(async ({ child }) => {
			const result = await hooksOf(child).beforeToolCall?.({
				toolCall: { name: "bash", id: "deny-1" },
				args: { command: "rm -rf /" },
			});
			assert.equal(result?.block, true);
			assert.equal(typeof result?.reason, "string");
			assert.match(result?.reason ?? "", /破坏宿主|受管目录|排查不能运行/);
		});
	});

	test("spike: scout keeps docker ps and nvidia-smi silent, asks python and git fetch, denies rm", async () => {
		await withChild(async ({ child, confirms }) => {
			for (const command of ["docker ps", "docker info", "nvidia-smi"]) {
				const result = await hooksOf(child).beforeToolCall?.({
					toolCall: { name: "bash", id: command },
					args: { command },
				});
				assert.equal(result, undefined, command);
			}
			const python = await hooksOf(child).beforeToolCall?.({
				toolCall: { name: "bash", id: "py" },
				args: { command: "python" },
			});
			assert.equal(python?.block, true);
			assert.equal(confirms.at(-1)?.title, COPY.confirm.investigate);
			const fetch = await hooksOf(child).beforeToolCall?.({
				toolCall: { name: "bash", id: "fetch" },
				args: { command: "git fetch" },
			});
			assert.equal(fetch?.block, true);
			const rm = await hooksOf(child).beforeToolCall?.({
				toolCall: { name: "bash", id: "rm" },
				args: { command: "rm dist/cache.bin" },
			});
			assert.equal(rm?.block, true);
			assert.match(rm?.reason ?? "", /排查不能运行 rm/);
			const dockerRm = await hooksOf(child).beforeToolCall?.({
				toolCall: { name: "bash", id: "drm" },
				args: { command: "docker rm abc" },
			});
			assert.equal(dockerRm?.block, true);
			assert.equal(confirms.at(-1)?.title, COPY.confirm.investigate);
		});
	});

	test("spike: child ask uses parent confirm titled 排查需要确认 and collab awaiting_confirm", async () => {
	let release!: (value: boolean) => void;
	const gate = new Promise<boolean>((resolve) => {
		release = resolve;
	});
	await withChild(
		async ({ child, store, collabId, confirms }) => {
			const pending = hooksOf(child).beforeToolCall?.({
				toolCall: { name: "bash", id: "ask-1" },
				args: { command: "sudo ls" },
			});
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(store.get().collab.find((slot) => slot.id === collabId)?.phase, "awaiting_confirm");
			assert.equal(formatCollabText(store.get().collab), COPY.collab.awaitingConfirm);
				assert.equal(confirms[0]?.title, COPY.confirm.investigate);
			release(true);
			const result = await pending;
				assert.equal(result, undefined);
				assert.equal(store.get().collab.find((slot) => slot.id === collabId)?.phase, "running");
				assert.equal(formatCollabText(store.get().collab), "看日志");
		},
		{ confirmImpl: async () => gate },
	);
});

	test("spike: evidence is recorded on the parent sessionId", async () => {
		await withChild(async ({ child, evidenceCalls, parentSessionId, stagedEvidence, coreHome, client }) => {
			const allow = await hooksOf(child).beforeToolCall?.({
				toolCall: { name: "bash", id: "echo-1" },
				args: { command: "echo hello" },
			});
			assert.equal(allow, undefined);
			await hooksOf(child).afterToolCall?.({
				toolCall: { name: "bash", id: "echo-1" },
				args: { command: "echo hello" },
				result: { content: [{ type: "text", text: "hello" }], details: {}, usage: undefined },
				isError: false,
			});
			assert.equal(evidenceCalls.length, 0);
			assert.equal(stagedEvidence.length, 1);
			await ingestStagedEvidenceSerial(stagedEvidence, {
				client,
				coreHome,
				sessionId: parentSessionId,
				warn: () => undefined,
			});
			assert.equal(evidenceCalls.length, 1);
			assert.equal(evidenceCalls[0]?.tool, "ingest_evidence");
			assert.equal(evidenceCalls[0]?.opts?.sessionId, parentSessionId);
		});
	});

	test("spike: two child results ingest serially after the scout returns", async () => {
		await withChild(async ({ child, evidenceCalls, parentSessionId, stagedEvidence, coreHome, client }) => {
			let pending = 0;
			let maxPending = 0;
			(client as { request: CoreClient["request"] }).request = async (tool, params, opts) => {
				pending += 1;
				maxPending = Math.max(maxPending, pending);
				evidenceCalls.push({ tool, params, opts });
				await Promise.resolve();
				pending -= 1;
				return {} as never;
			};
			await hooksOf(child).afterToolCall?.({
				toolCall: { name: "bash", id: "ps" },
				args: { command: "docker ps" },
				result: { content: [{ type: "text", text: "ps" }], details: {}, usage: undefined },
				isError: false,
			});
			await hooksOf(child).afterToolCall?.({
				toolCall: { name: "bash", id: "info" },
				args: { command: "docker info" },
				result: { content: [{ type: "text", text: "info" }], details: {}, usage: undefined },
				isError: false,
			});
			assert.equal(evidenceCalls.length, 0);
			assert.equal(stagedEvidence.length, 2);
			await ingestStagedEvidenceSerial(stagedEvidence, {
				client,
				coreHome,
				sessionId: parentSessionId,
				warn: () => undefined,
			});
			assert.equal(evidenceCalls.length, 2);
			assert.equal(maxPending, 1);
		});
	});

test("spike: child dispose does not stop parent Core", async () => {
	await withChild(async ({ child, client }) => {
		child.dispose();
		const seen = await (client as unknown as { request: (tool: string, params: unknown) => Promise<unknown> }).request(
			"inspect_environment",
			{},
		);
		assert.deepEqual(seen, {});
	});
});

test("spike: child tools are only read and bash", async () => {
	await withChild(async ({ child }) => {
		assert.deepEqual(new Set(child.getActiveToolNames()), new Set(["read", "bash"]));
		const names = child.getAllTools().map((tool) => tool.name);
		assert.deepEqual(new Set(names), new Set(["read", "bash"]));
		assert.equal(names.includes("write"), false);
		assert.equal(names.includes("edit"), false);
		assert.equal(names.includes("investigate"), false);
		assert.equal(names.includes("deploy_service"), false);
		assert.equal(names.includes("cloud_device"), false);
	});
});

test("spike: child system prompt is the scout prompt, not parent v5", async () => {
	await withChild(async ({ child }) => {
		assert.equal(child.resourceLoader.getSystemPrompt(), INVESTIGATE_SYSTEM_PROMPT);
		assert.equal(child.resourceLoader.getSystemPrompt()?.includes(BITTUNE_SYSTEM_PROMPT_MARKER), false);
	});
});

test("spike: child session has no jsonl on disk", async () => {
	await withChild(async ({ child, root }) => {
		assert.equal(child.sessionFile, undefined);
		assert.deepEqual(await jsonlFiles(root), []);
	});
});

test("spike: fourth investigate fails before the first await", async () => {
	const scheduler = new InvestigateScheduler();
	assert.equal(scheduler.tryAcquire("a"), true);
	assert.equal(scheduler.tryAcquire("b"), true);
	assert.equal(scheduler.tryAcquire("c"), true);
	assert.equal(scheduler.tryAcquire("d"), false);

	const tool = createInvestigateTool({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		protectedRoots: [],
		coreHome: process.cwd(),
		settingsManager: null as unknown as SettingsManager,
		modelRuntime: null as unknown as ModelRuntime,
		client: () => {
			throw new Error("client must not be used when the slot is full");
		},
		store: new HostStatusStore(),
		scheduler,
	});
	const result = await tool.execute("fourth", { goal: "多余排查" }, undefined, undefined, null as never);
	assert.equal(result.content[0] && "text" in result.content[0] ? result.content[0].text : "", COPY.errors.investigateBusy);
});

	test("spike: parent abortAll aborts children and leaves no slots", async () => {
		await withChild(async ({ child, client }) => {
			const scheduler = new InvestigateScheduler();
			assert.equal(scheduler.tryAcquire("live"), true);
			let aborted = false;
			scheduler.setAbort("live", () => {
				aborted = true;
				void child.abort();
			});
			scheduler.abortAll();
			assert.equal(aborted, true);
			assert.equal(scheduler.size, 0);
			const seen = await (client as unknown as { request: (tool: string) => Promise<unknown> }).request("inspect_environment");
			assert.deepEqual(seen, {});
		});
	});

	test("spike: setAbort after abortAll still fires", () => {
		const scheduler = new InvestigateScheduler();
		assert.equal(scheduler.tryAcquire("live"), true);
		scheduler.abortAll();
		let fired = false;
		scheduler.setAbort("live", () => {
			fired = true;
		});
		assert.equal(fired, true);
		assert.equal(scheduler.wasAborted("live"), true);
	});

	test("spike: abort during createChildSession never prompts", async () => {
		const scheduler = new InvestigateScheduler();
		const store = new HostStatusStore();
		let prompted = 0;
		const tool = createInvestigateTool({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			protectedRoots: [],
			coreHome: process.cwd(),
			settingsManager: null as unknown as SettingsManager,
			modelRuntime: null as unknown as ModelRuntime,
			client: () => undefined,
			store,
			scheduler,
			createSession: async () => {
				scheduler.abortAll();
				return {
					prompt: async () => {
						prompted += 1;
					},
					abort: async () => undefined,
					dispose: () => undefined,
					messages: [],
				} as never;
			},
		});
		const ctx = {
			model: undefined,
			sessionManager: { getSessionId: () => "parent" },
			ui: { confirm: async () => true },
		} as unknown as ExtensionContext;
		const result = await tool.execute("live", { goal: "看日志" }, undefined, undefined, ctx);
		assert.equal(prompted, 0);
		assert.equal(result.content[0] && "text" in result.content[0] ? result.content[0].text : "", COPY.errors.investigateCancelled);
		assert.equal(store.get().collab.find((slot) => slot.id === "live")?.phase, "failed");
		assert.equal(scheduler.size, 0);
	});

	function mockInvestigateCtx() {
		return {
			model: undefined,
			sessionManager: { getSessionId: () => "parent" },
			ui: { confirm: async () => true },
		} as unknown as ExtensionContext;
	}

	test("spike: child failure copy is not the cancel sentence", async () => {
		const tool = createInvestigateTool({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			protectedRoots: [],
			coreHome: process.cwd(),
			settingsManager: null as unknown as SettingsManager,
			modelRuntime: null as unknown as ModelRuntime,
			client: () => undefined,
			store: new HostStatusStore(),
			scheduler: new InvestigateScheduler(),
			createSession: async () => {
				throw new Error("child exploded");
			},
		});
		const result = await tool.execute("boom", { goal: "看日志" }, undefined, undefined, mockInvestigateCtx());
		assert.equal(result.content[0] && "text" in result.content[0] ? result.content[0].text : "", COPY.errors.investigateFailed);
	});

	test("spike: tool-limit copy is distinct from cancel", async () => {
		const tool = createInvestigateTool({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			protectedRoots: [],
			coreHome: process.cwd(),
			settingsManager: null as unknown as SettingsManager,
			modelRuntime: null as unknown as ModelRuntime,
			client: () => undefined,
			store: new HostStatusStore(),
			scheduler: new InvestigateScheduler(),
			createSession: async (options) => {
				options.onLimit?.();
				return {
					prompt: async () => undefined,
					abort: async () => undefined,
					dispose: () => undefined,
					messages: [],
				} as never;
			},
		});
				const result = await tool.execute("limit", { goal: "看日志" }, undefined, undefined, mockInvestigateCtx());
				assert.equal(result.content[0] && "text" in result.content[0] ? result.content[0].text : "", COPY.errors.investigateLimit);
			});

		test("spike: tool-limit after prompt returns existing findings", async () => {
			const store = new HostStatusStore();
			const tool = createInvestigateTool({
				cwd: process.cwd(),
				agentDir: process.cwd(),
				protectedRoots: [],
				coreHome: process.cwd(),
				settingsManager: null as unknown as SettingsManager,
				modelRuntime: null as unknown as ModelRuntime,
				client: () => undefined,
				store,
				scheduler: new InvestigateScheduler(),
				createSession: async (options) =>
					({
						prompt: async () => {
							options.onLimit?.();
						},
						abort: async () => undefined,
						dispose: () => undefined,
						messages: [
							{ role: "assistant", content: [{ type: "text", text: "显存占用 0.5/32G。" }] },
							{
								role: "assistant",
								content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "nvidia-smi" } }],
							},
							{
								role: "toolResult",
								toolCallId: "b1",
								content: [{ type: "text", text: "RTX 5090" }],
							},
						],
					}) as never,
			});
			const result = await tool.execute("limit-findings", { goal: "查硬件" }, undefined, undefined, mockInvestigateCtx());
			const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
				assert.match(text, /^排查已达到步数上限。/);
				assert.match(text, /显存占用 0\.5\/32G。/);
				assert.match(text, /命令 nvidia-smi/);
				assert.equal(text.includes("RTX 5090"), false, text);
				assert.equal(store.get().collab.find((slot) => slot.id === "limit-findings")?.phase, "failed");
		});

					test("spike: investigate card title includes the goal and projects child bash steps", async () => {
					assert.equal(investigateTitle("查 docker 信息"), "排查 · 查 docker 信息");
					assert.equal(formatInvestigateCallTitle("查 docker 信息", 0, true), "排查 · 查 docker 信息  进行中 0/12");
					assert.equal(formatInvestigateCallTitle("查 docker 信息", 2, true), "排查 · 查 docker 信息  进行中 2/12");
					assert.equal(formatInvestigateCallTitle("查 docker 信息", 2, false), "排查 · 查 docker 信息");
				assert.match(
					formatInvestigateSteps([{ id: "ps", name: "bash", target: "docker ps", status: "running" }]),
					/命令\s+docker ps\s+进行中/,
				);
				assert.equal(
					collabTitleFromSteps("查 docker 信息", [{ id: "ps", name: "bash", target: "docker ps", status: "running" }]),
					"命令 docker ps",
				);
				assert.equal(collabTitleFromSteps("查 docker 信息", []), "查 docker 信息");
				const updates: Array<{ text: string; steps: unknown }> = [];
				const listeners: Array<(event: unknown) => void> = [];
				const store = new HostStatusStore();
				const liveTitles: string[] = [];
				const tool = createInvestigateTool({
					cwd: process.cwd(),
					agentDir: process.cwd(),
					protectedRoots: [],
					coreHome: process.cwd(),
					settingsManager: null as unknown as SettingsManager,
					modelRuntime: null as unknown as ModelRuntime,
					client: () => undefined,
					store,
					scheduler: new InvestigateScheduler(),
					createSession: async () =>
						({
							prompt: async () => {
								for (const listener of listeners) {
									listener({ type: "tool_execution_start", toolCallId: "ps", toolName: "bash", args: { command: "docker ps" } });
								}
								liveTitles.push(formatCollabText(store.get().collab));
								for (const listener of listeners) {
									listener({
										type: "tool_execution_end",
										toolCallId: "ps",
										toolName: "bash",
										args: { command: "docker ps" },
										isError: false,
									});
								}
							},
							abort: async () => undefined,
							dispose: () => undefined,
							subscribe: (listener: (event: unknown) => void) => {
								listeners.push(listener);
								return () => undefined;
							},
							messages: [],
						}) as never,
				});
				const result = await tool.execute(
					"card",
					{ goal: "查 docker 信息" },
					undefined,
					(update) => {
						const text = update.content[0] && "text" in update.content[0] ? String(update.content[0].text) : "";
						updates.push({ text, steps: (update.details as { steps?: unknown })?.steps });
					},
					mockInvestigateCtx(),
				);
				assert.equal(result.content[0] && "text" in result.content[0] ? result.content[0].text : "", "排查未返回结论。");
				assert.equal(updates.length >= 2, true);
				assert.match(updates[0]?.text ?? "", /命令\s+docker ps\s+进行中/);
				assert.match(updates.at(-1)?.text ?? "", /命令\s+docker ps\s+完成/);
				assert.equal(liveTitles[0], "命令 docker ps");
			});

			test("spike: scout prompt gets a short host pack before the goal", async () => {
				const pack = formatScoutContextPack(
					{
						host: hostFromDoctor({
							gpuNames: ["NVIDIA GeForce RTX 5090"],
							docker: "ready",
							vramTotal: 32607,
							vramUsed: 8397,
						}),
						service: { kind: "running", engine: "vLLM" },
					},
					"看 /var/log/bittune.log",
				);
				assert.match(pack, /本机 RTX 5090 8\.2\/32G · Docker 就绪/);
				assert.match(pack, /受管服务 vLLM 就绪/);
				assert.match(pack, /线索路径 \/var\/log\/bittune\.log/);
				assert.equal(formatScoutContextPack({ host: { gpuText: COPY.probing, docker: "unknown" }, service: { kind: "unseen" } }), "");
				const prompts: string[] = [];
				const store = new HostStatusStore();
				store.patch({
					host: hostFromDoctor({
						gpuNames: ["NVIDIA GeForce RTX 5090"],
						docker: "ready",
						vramTotal: 32607,
					}),
					service: { kind: "none" },
				});
				const tool = createInvestigateTool({
					cwd: process.cwd(),
					agentDir: process.cwd(),
					protectedRoots: [],
					coreHome: process.cwd(),
					settingsManager: null as unknown as SettingsManager,
					modelRuntime: null as unknown as ModelRuntime,
					client: () => undefined,
					store,
					scheduler: new InvestigateScheduler(),
					createSession: async () =>
						({
							prompt: async (text: string) => {
								prompts.push(text);
							},
							abort: async () => undefined,
							dispose: () => undefined,
							messages: [],
						}) as never,
				});
				await tool.execute("pack", { goal: "查 docker 信息", hint: "看 /var/log/bittune.log" }, undefined, undefined, mockInvestigateCtx());
				assert.equal(prompts.length, 1);
					assert.match(prompts[0] ?? "", /^本机 RTX 5090 32G · Docker 就绪\n受管服务 无受管服务\n线索路径 \/var\/log\/bittune\.log\n查 docker 信息\n看 \/var\/log\/bittune\.log$/);
				});

			test("spike: scout uses a second scoped model and keeps parent when none exists", async () => {
				const parent = { provider: "bittune-test", id: "test-agent-model", contextWindow: 128000 } as ExtensionContext["model"] & { provider: string; id: string; contextWindow: number };
				const small = { ...parent, id: "scout-small", contextWindow: 8000 };
				const large = { ...parent, id: "scout-large", contextWindow: 32000 };
				assert.equal(resolveScoutModel({ parent, scopedModels: [{ model: parent }] }), parent);
				assert.equal(resolveScoutModel({ parent }), parent);
				assert.equal(
					resolveScoutModel({
						parent,
						scopedModels: [{ model: parent }, { model: large }, { model: small }],
					}),
					small,
				);
				assert.equal(
					resolveScoutModel({
						parent,
						enabledModels: ["scout-small"],
						catalog: [parent, small],
					}),
					small,
				);
				const models: Array<{ provider?: string; id?: string }> = [];
				const tool = createInvestigateTool({
					cwd: process.cwd(),
					agentDir: process.cwd(),
					protectedRoots: [],
					coreHome: process.cwd(),
					settingsManager: { getEnabledModels: () => undefined } as unknown as SettingsManager,
					modelRuntime: { getModels: () => [] } as unknown as ModelRuntime,
					client: () => undefined,
					store: new HostStatusStore(),
					scheduler: new InvestigateScheduler(),
					createSession: async (options) => {
						models.push({ provider: options.model?.provider, id: options.model?.id });
						return {
							prompt: async () => undefined,
							abort: async () => undefined,
							dispose: () => undefined,
							messages: [],
						} as never;
					},
				});
				await tool.execute("scout-model", { goal: "查 docker 信息" }, undefined, undefined, {
					...mockInvestigateCtx(),
					model: parent,
					scopedModels: [{ model: parent }, { model: small }],
				});
				assert.deepEqual(models, [{ provider: "bittune-test", id: "scout-small" }]);
				await tool.execute("scout-parent", { goal: "查 docker 信息" }, undefined, undefined, {
					...mockInvestigateCtx(),
					model: parent,
					scopedModels: [{ model: parent }],
				});
				assert.deepEqual(models.at(-1), { provider: "bittune-test", id: "test-agent-model" });
			});

			test("spike: summarizeChild joins all assistant texts", async () => {
			const tool = createInvestigateTool({
				cwd: process.cwd(),
				agentDir: process.cwd(),
				protectedRoots: [],
				coreHome: process.cwd(),
				settingsManager: null as unknown as SettingsManager,
				modelRuntime: null as unknown as ModelRuntime,
				client: () => undefined,
				store: new HostStatusStore(),
				scheduler: new InvestigateScheduler(),
				createSession: async () =>
					({
						prompt: async () => undefined,
						abort: async () => undefined,
						dispose: () => undefined,
						messages: [
							{ role: "assistant", content: [{ type: "text", text: "日志里有 OOM。" }] },
							{ role: "assistant", content: [{ type: "text", text: "上次报告写过同一错误。" }] },
						],
					}) as never,
			});
			const result = await tool.execute("sum", { goal: "看日志" }, undefined, undefined, mockInvestigateCtx());
			assert.equal(
				result.content[0] && "text" in result.content[0] ? result.content[0].text : "",
				"日志里有 OOM。\n上次报告写过同一错误。",
			);
		});

		test("spike: summarizeChild appends read and bash summaries", async () => {
			const tool = createInvestigateTool({
				cwd: process.cwd(),
				agentDir: process.cwd(),
				protectedRoots: [],
				coreHome: process.cwd(),
				settingsManager: null as unknown as SettingsManager,
				modelRuntime: null as unknown as ModelRuntime,
				client: () => undefined,
				store: new HostStatusStore(),
				scheduler: new InvestigateScheduler(),
				createSession: async () =>
					({
						prompt: async () => undefined,
						abort: async () => undefined,
						dispose: () => undefined,
						messages: [
							{
								role: "assistant",
								content: [
									{ type: "toolCall", id: "r1", name: "read", arguments: { path: "/var/log/app.log" } },
								],
							},
							{
								role: "toolResult",
								toolCallId: "r1",
								content: [{ type: "text", text: "OOM killer invoked" }],
							},
							{
								role: "assistant",
								content: [{ type: "text", text: "日志里有 OOM。" }],
							},
							{
								role: "assistant",
								content: [
									{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls /var/log" } },
								],
							},
							{
								role: "toolResult",
								toolCallId: "b1",
								content: [{ type: "text", text: "app.log\nboot.log" }],
							},
						],
					}) as never,
			});
			const result = await tool.execute("sum-tools", { goal: "看日志" }, undefined, undefined, mockInvestigateCtx());
			const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
				assert.ok(text.startsWith("日志里有 OOM。"), text);
				assert.match(text, /读取 \/var\/log\/app\.log/);
				assert.equal(text.includes("OOM killer invoked"), false, text);
				assert.match(text, /命令 ls \/var\/log/);
				assert.equal(text.includes("boot.log"), false, text);
		});

		test("spike: summarizeChild keeps tool summaries when there is no conclusion", async () => {
			const tool = createInvestigateTool({
				cwd: process.cwd(),
				agentDir: process.cwd(),
				protectedRoots: [],
				coreHome: process.cwd(),
				settingsManager: null as unknown as SettingsManager,
				modelRuntime: null as unknown as ModelRuntime,
				client: () => undefined,
				store: new HostStatusStore(),
				scheduler: new InvestigateScheduler(),
				createSession: async () =>
					({
						prompt: async () => undefined,
						abort: async () => undefined,
						dispose: () => undefined,
						messages: [
							{
								role: "assistant",
								content: [
									{ type: "toolCall", id: "r1", name: "read", arguments: { path: "report.md" } },
								],
							},
							{
								role: "toolResult",
								toolCallId: "r1",
								content: [{ type: "text", text: "上次压测失败" }],
							},
						],
					}) as never,
			});
			const result = await tool.execute("sum-only-tools", { goal: "看报告" }, undefined, undefined, mockInvestigateCtx());
			const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
				assert.ok(!text.includes("排查未返回结论。"), text);
				assert.match(text, /读取 report\.md/);
				assert.equal(text.includes("上次压测失败"), false, text);
		});

	test("spike: child confirm does not set footer task awaiting_confirm", async () => {
		let release!: (value: boolean) => void;
		const gate = new Promise<boolean>((resolve) => {
			release = resolve;
		});
		await withChild(
			async ({ child, store, collabId }) => {
				const pending = hooksOf(child).beforeToolCall?.({
					toolCall: { name: "bash", id: "ask-footer" },
					args: { command: "sudo ls" },
				});
				await new Promise((resolve) => setImmediate(resolve));
				assert.equal(store.get().collab.find((slot) => slot.id === collabId)?.phase, "awaiting_confirm");
				assert.equal(store.get().task.kind, "idle");
					release(false);
					await pending;
					assert.equal(store.get().task.kind, "idle");
					assert.equal(store.get().collab.find((slot) => slot.id === collabId)?.phase, "failed");
					assert.equal(formatCollabText(store.get().collab), COPY.collab.failed);
				},
				{ confirmImpl: async () => gate },
			);
		});

test("spike: child compact emits compaction_start and parent Core stays usable", async () => {
	await withChild(async ({ child, client }) => {
		let sawCompact = false;
		child.subscribe((event) => {
			if (event.type === "compaction_start") sawCompact = true;
		});
		await assert.rejects(() => child.compact(), /Nothing to compact|Compaction cancelled|No API key|not configured/i);
		assert.equal(sawCompact, true);
		const seen = await (client as unknown as { request: (tool: string) => Promise<unknown> }).request("inspect_environment");
		assert.deepEqual(seen, {});
	});
});

test("header collab: two running slots read 排查中 2/3", () => {
	const store = new HostStatusStore();
	store.setCollab("one", { title: "日志", phase: "running" });
	store.setCollab("two", { title: "报告", phase: "running" });
	assert.equal(formatCollabText(store.get().collab), `${COPY.collab.running} 2/${COPY.collab.capacity}`);
});
