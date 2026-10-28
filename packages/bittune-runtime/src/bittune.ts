import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CoreClient, probeCore } from "./harness/core-client.ts";
import { createHarnessExtension } from "./harness/extension.ts";
import { MANAGED_TOOL_NAMES } from "./harness/managed-tools.ts";
import { BITTUNE_SYSTEM_PROMPT } from "./harness/system-prompt.ts";
import { createAgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "./core/agent-session-runtime.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./core/agent-session-services.ts";
import { createAgentSession } from "./core/sdk.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { DefaultResourceLoader } from "./core/resource-loader.ts";
import { assertValidSessionId, SessionManager } from "./core/session-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { parseBittuneCliArguments, type BittuneConfigureOptions } from "./cli/bittune-args.ts";
import { InteractiveMode } from "./modes/interactive/interactive-mode.ts";
import { getPackageDir, VERSION } from "./config.ts";

export interface BittunePaths {
	root: string;
	agent: string;
	sessions: string;
	state: string;
	/** Python Core home (SQLite + artifacts + staging); default ~/.bittune/core. */
	core: string;
	logs: string;
}

	export interface CreateBittuneRuntimeOptions {
	  cwd?: string;
	  paths?: Partial<BittunePaths>;
	  sessionId?: string;
	}

const AGENT_CONFIG_MARKER = "bittune-runtime.json";
const AGENT_CONFIG_SCHEMA_VERSION = 1;
const SESSION_BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write"];

/** Product Skill tree: next to src in dev, next to dist/agent payload after install. Never ~/.bittune/agent/skills. */
export function resolveProductSkillsDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const nextToModule = join(here, "..", "skills");
	if (existsSync(nextToModule)) return nextToModule;
	const nextToJs = join(here, "skills");
	if (existsSync(nextToJs)) return nextToJs;
	const fromPackage = join(getPackageDir(), "skills");
	if (existsSync(fromPackage)) return fromPackage;
	const fromRepo = join(getPackageDir(), "packages", "bittune-runtime", "skills");
	if (existsSync(fromRepo)) return fromRepo;
	return nextToModule;
}

function getEnvironmentPath(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value || undefined;
}

export function resolveBittunePaths(overrides: Partial<BittunePaths> = {}): BittunePaths {
	const root = overrides.root ?? getEnvironmentPath("BITTUNE_HOME") ?? join(homedir(), ".bittune");
	const agent =
		overrides.agent ??
		getEnvironmentPath("BITTUNE_AGENT_DIR") ??
		getEnvironmentPath("BITTUNE_CODING_AGENT_DIR") ??
		join(root, "agent");
	return {
		root,
		agent,
		sessions:
			overrides.sessions ?? getEnvironmentPath("BITTUNE_SESSION_DIR") ?? join(agent, "sessions"),
		state: overrides.state ?? getEnvironmentPath("BITTUNE_STATE_DIR") ?? join(root, "state"),
		core: overrides.core ?? getEnvironmentPath("BITTUNE_CORE_HOME") ?? join(root, "core"),
		logs: overrides.logs ?? getEnvironmentPath("BITTUNE_LOG_DIR") ?? join(root, "logs"),
	};
}

async function ensureDirectories(paths: BittunePaths): Promise<void> {
	await Promise.all([paths.agent, paths.sessions, paths.state, paths.core, paths.logs].map((path) => mkdir(path, { recursive: true })));
}

async function isBittuneAgentConfigurationInitialized(agentDir: string): Promise<boolean> {
	try {
		const marker = JSON.parse(await readFile(join(agentDir, AGENT_CONFIG_MARKER), "utf8")) as Record<string, unknown>;
		return marker.schema_version === AGENT_CONFIG_SCHEMA_VERSION;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw new Error(`Bittune Agent configuration marker is invalid: ${(error as Error).message}`);
	}
}

async function writeBittuneAgentConfigurationMarker(agentDir: string): Promise<void> {
	const markerPath = join(agentDir, AGENT_CONFIG_MARKER);
	await writeFile(
		markerPath,
		`${JSON.stringify({ schema_version: AGENT_CONFIG_SCHEMA_VERSION, initialized_at: new Date().toISOString() })}\n`,
		{ mode: 0o600 },
	);
	await chmod(markerPath, 0o600).catch(() => undefined);
}

async function assertBittuneAgentConfigurationInitialized(agentDir: string): Promise<void> {
	if (await isBittuneAgentConfigurationInitialized(agentDir)) return;
	throw new Error(
		"Bittune is not initialized for this Runtime. Run `bittune configure --base-url <url> --model-id <id>`; Bittune does not import previous Agent configuration.",
	);
}

function createRuntimeFactory(paths: BittunePaths): CreateAgentSessionRuntimeFactory {
	return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
		// The Core is session-scoped: same lifetime as this Runtime session,
		// no daemon, no listening port. It must be able to start before any
		// managed tool may exist in the session.
		const coreClient = await CoreClient.start({ coreHome: paths.core });
		let coreActive = true;
		const closeCore = async (): Promise<void> => {
			if (!coreActive) return;
			coreActive = false;
			await coreClient.stop();
		};
		try {
		const taskScope = process.env.BITTUNE_TASK_SCOPE_FILE
            ? (await coreClient.request("task_scope_status", {}, { sessionId: sessionManager.getSessionId() ?? "external" }) as { scope: import("./harness/task-scope.ts").TaskScope }).scope
            : null;
			const availableTools = [...SESSION_BUILTIN_TOOL_NAMES, ...MANAGED_TOOL_NAMES, "investigate"];
const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
				const modelRuntime = await ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: join(agentDir, "models.json"),
				refreshOnCreate: false,
				allowModelNetwork: false,
			});
			await modelRuntime.refresh({ allowNetwork: false });
			const providerId = settingsManager.getDefaultProvider();
			const modelId = settingsManager.getDefaultModel();
			const model = providerId && modelId ? modelRuntime.getModel(providerId, modelId) : undefined;
			if (!model) {
				throw new Error("No Bittune Agent model is selected. Run `bittune configure` before starting a session.");
			}

			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				extensionFactories: [
					{
						name: "bittune",
							factory: createHarnessExtension({
								// paths.core holds SQLite + artifacts
								// and staging; it is listed explicitly on top of
								// the umbrella root so the deny list never
								// depends on tree shape.
	protectedRoots: [paths.root, paths.core],
									cwd,
									coreHome: paths.core,
									client: () => (coreActive ? coreClient : undefined),
									taskScope: taskScope ?? undefined,
								closeClient: closeCore,
									// The approval preference is global-only: settings
									// never let a project file shadow it, and session
									// skip lives inside the extension's memory.
									approval: {
										get: () => settingsManager.getApprovalMode(),
										set: (mode) => settingsManager.setApprovalMode(mode),
									},
										quietStartup: settingsManager.getQuietStartup(),
										settingsManager,
										modelRuntime,
										agentDir,
								}),
							hidden: true,
						},
					],
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					staticOnly: true,
					additionalSkillPaths: [resolveProductSkillsDir()],
					systemPrompt: BITTUNE_SYSTEM_PROMPT + (taskScope ? `\n指定资源任务已启用（${taskScope.scope_hash}）。Core固定计划/服务/记录ID范围；inspect_records省略id时可检索授权集合内的事实（deployment_plan、service_instance、suite_result、benchmark_result、experiment、report等），支持各类型已有过滤字段；不会返回范围外记录。run/artifact仍需具体授权ID，不做运行时全局枚举。通用工具结果末尾的Bittune evidence提供已保存的run_id/artifact_refs，可直接作为报告来源。只读文件：${JSON.stringify(taskScope.read_paths)}。仅允许以下Bash原样查询：${JSON.stringify(taskScope.inventory_commands)}。不调用investigate。allow_execution=${taskScope.allow_execution}。报告用suite_selections覆盖全部点，修订用based_on_report_id保留全部引用。` : ""),
				});
			await resourceLoader.reload();

			const result = await createAgentSession({
				cwd,
				agentDir,
				modelRuntime,
				resourceLoader,
				settingsManager,
				sessionManager,
				model,
				// The static catalog is the trust boundary: 4 generic tools, 8 managed
				// Core tools, available from the first turn.
				availableTools,
				tools: availableTools,
				...(sessionStartEvent ? { sessionStartEvent } : {}),
			});
			const services: AgentSessionServices = { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics };
			return {
				session: result.session,
				extensionsResult: result.extensionsResult,
				services,
				diagnostics,
				...(result.modelFallbackMessage ? { modelFallbackMessage: result.modelFallbackMessage } : {}),
			};
		} catch (error) {
			await closeCore();
			throw error;
		}
	};
}

export async function createBittuneRuntime(options: CreateBittuneRuntimeOptions = {}) {
	const cwd = resolve(options.cwd ?? process.cwd());
	const paths = resolveBittunePaths(options.paths);
	await ensureDirectories(paths);
	await assertBittuneAgentConfigurationInitialized(paths.agent);
	let sessionManager: SessionManager;
	if (options.sessionId) {
		assertValidSessionId(options.sessionId);
		const matches = (await readdir(paths.sessions)).filter((entry) => entry.endsWith(`_${options.sessionId}.jsonl`));
		if (matches.length !== 1) throw new Error(`Bittune session not found: ${options.sessionId}`);
		sessionManager = SessionManager.open(join(paths.sessions, matches[0]!), paths.sessions);
	} else {
		sessionManager = SessionManager.create(cwd, paths.sessions);
	}
	const runtime = await createAgentSessionRuntime(createRuntimeFactory(paths), {
		cwd,
		agentDir: paths.agent,
		sessionManager,
	});
	return { runtime, paths };
}

function printHelp(): void {
	console.log(`Bittune ${VERSION}

Usage:
  bittune [message]
  bittune --session <id> [message]
  bittune install --package <tgz> | --offline <bundle-dir> [options]
  bittune configure --base-url <url> --model-id <id> [options]
  bittune doctor
  bittune version

Commands:
  install     Install/upgrade the Bittune runtime on this host
              --check-only   Preflight report; modifies nothing
              --offline DIR  Install from an offline bundle directory
              --user NAME    Linux user that will run Bittune
              --yes          Non-interactive: accept the printed plan
              --json         Machine-readable plan/report
  configure   Configure the Bittune Agent LLM
  doctor      Check Bittune runtime, Python Core and local configuration
  version     Print the Bittune version

Options:
  --base-url <url>       OpenAI-compatible endpoint base URL
  --model-id <id>        Agent model ID
  --provider-id <id>     Provider ID (default: bittune-agent)
  --api-key-env <name>   Environment variable containing the API key
  --session <id>         Resume a persisted Bittune session, optionally with an initial message
  --help                 Show this help`);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

async function configure(options: BittuneConfigureOptions): Promise<void> {
	const baseUrl = options.baseUrl?.trim();
	const modelId = options.modelId?.trim();
	const providerId = (options.providerId ?? "bittune-agent").trim();
	const apiKeyEnv = (options.apiKeyEnv ?? "BITTUNE_AGENT_LLM_API_KEY").trim();
	if (!baseUrl) throw new Error("--base-url is required.");
	let configuredBaseUrl: URL;
	try {
		configuredBaseUrl = new URL(baseUrl);
	} catch {
		throw new Error("--base-url must be an http(s) URL.");
	}
	if (!configuredBaseUrl.hostname || !["http:", "https:"].includes(configuredBaseUrl.protocol)) {
		throw new Error("--base-url must be an http(s) URL.");
	}
	if (!modelId) throw new Error("--model-id is required.");
	if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(providerId)) throw new Error("--provider-id is invalid.");
	if (!/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv)) throw new Error("--api-key-env must be an environment variable name.");

	const paths = resolveBittunePaths();
	await ensureDirectories(paths);
	const modelsPath = join(paths.agent, "models.json");
	const settingsPath = join(paths.agent, "settings.json");
	const hasCurrentConfiguration = await isBittuneAgentConfigurationInitialized(paths.agent);
	const config = hasCurrentConfiguration ? await readJson(modelsPath) : {};
	const providers =
		config.providers && typeof config.providers === "object" && !Array.isArray(config.providers)
			? (config.providers as Record<string, unknown>)
			: {};
	providers[providerId] = {
		baseUrl: configuredBaseUrl.toString().replace(/\/$/, ""),
		api: "openai-completions",
		apiKey: `$${apiKeyEnv}`,
		authHeader: true,
		models: [{ id: modelId, name: "Bittune Agent Model", input: ["text"], reasoning: false }],
	};
	await writeFile(modelsPath, `${JSON.stringify({ ...config, providers }, null, 2)}\n`, { mode: 0o600 });
	await chmod(modelsPath, 0o600).catch(() => undefined);
	const settings = hasCurrentConfiguration ? await readJson(settingsPath) : {};
	await writeFile(
		settingsPath,
		`${JSON.stringify({ ...settings, defaultProvider: providerId, defaultModel: modelId }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	await chmod(settingsPath, 0o600).catch(() => undefined);
	await writeBittuneAgentConfigurationMarker(paths.agent);
	console.log(`Bittune Agent model configured. Export ${apiKeyEnv} in the current shell before running bittune.`);
}

async function doctor(): Promise<void> {
	const paths = resolveBittunePaths();
	await ensureDirectories(paths);
	if (!(await isBittuneAgentConfigurationInitialized(paths.agent))) {
		console.log(`Bittune ${VERSION}`);
		console.log(`Agent directory: ${paths.agent}`);
		console.log("Agent configuration: not initialized");
		console.log("Run `bittune configure --base-url <url> --model-id <id>`; previous Agent configuration is not imported.");
		process.exitCode = 1;
		return;
	}
	const settingsManager = SettingsManager.create(process.cwd(), paths.agent, { projectTrusted: false });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(paths.agent, "auth.json"),
		modelsPath: join(paths.agent, "models.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	await modelRuntime.refresh({ allowNetwork: false });
	const providerId = settingsManager.getDefaultProvider();
	const modelId = settingsManager.getDefaultModel();
	const model = providerId && modelId ? modelRuntime.getModel(providerId, modelId) : undefined;
	console.log(`Bittune ${VERSION}`);
	console.log(`Agent directory: ${paths.agent}`);
	console.log(`State directory: ${paths.state}`);
	console.log(`Core directory: ${paths.core}`);
	console.log(`Agent model selection: ${model && providerId ? `${providerId}/${model.id}` : "missing"}`);
	console.log(`Agent authentication: ${model && modelRuntime.hasConfiguredAuth(model.provider) ? "available" : "missing"}`);
	const approvalLabel = settingsManager.getApprovalMode() === "ask" ? "ask（逐次确认）" : `${settingsManager.getApprovalMode()}（普通确认跳过）`;
	console.log(`Confirmation preference: ${approvalLabel}（用 /approval 修改；显式确认始终不跳过）`);
	if (!model) {
		console.log("Python Core: skipped (Agent model not initialized).");
	} else {
		try {
			const coreProbe = probeCore({ coreHome: paths.core });
			console.log(`Python Core: ${coreProbe.version} @ ${paths.core}`);
		} catch (error) {
			console.log(`Python Core: unavailable (${error instanceof Error ? error.message : String(error)})`);
			process.exitCode = 1;
		}
	}
	if (!model || !modelRuntime.hasConfiguredAuth(model.provider)) process.exitCode = 1;
		console.log("Domain prerequisites (needed only when the goal touches them):");
		const { runChecks, renderCheckLines } = await import("./cli/install/checks.ts");
		for (const line of renderCheckLines(await runChecks())) console.log(line);
		if (!model) return;
		try {
			const { runtime } = await createBittuneRuntime({ paths });
			try {
				const toolNames = runtime.session.agent.state.tools.map((tool) => tool.name);
				console.log(`Runtime assembled: ${toolNames.length} tools (${toolNames.join(", ")})`);
			} finally {
				await runtime.dispose();
			}
		} catch (error) {
			console.log(`Runtime assembled: failed (${error instanceof Error ? error.message : String(error)})`);
			process.exitCode = 1;
		}
	}

export async function runBittuneCli(argv: string[]): Promise<void> {
	const invocation = parseBittuneCliArguments(argv);
	if (invocation.kind === "help") {
		printHelp();
		return;
	}
	if (invocation.kind === "version") {
		console.log(`Bittune ${VERSION}`);
		return;
	}
	if (invocation.kind === "configure") {
		await configure(invocation.options);
		return;
	}
	if (invocation.kind === "doctor") {
		await doctor();
		return;
	}
	if (invocation.kind === "install") {
		const { runInstallCommand } = await import("./cli/install/runner.ts");
		process.exitCode = await runInstallCommand(invocation.options);
		return;
	}

		if (invocation.sessionId) assertValidSessionId(invocation.sessionId);
		const { runtime } = await createBittuneRuntime({ ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}) });
		if (process.env.BITTUNE_HEADLESS === "1") {
			try {
				if (invocation.message) await runtime.session.prompt(invocation.message);
			} finally {
				await runtime.dispose();
			}
			return;
		}
		const mode = new InteractiveMode(runtime, invocation.message ? { initialMessage: invocation.message } : undefined);
		await mode.run();
	}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
	await runBittuneCli(process.argv.slice(2)).catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`bittune: ${message}`);
		process.exitCode = 1;
	});
}
