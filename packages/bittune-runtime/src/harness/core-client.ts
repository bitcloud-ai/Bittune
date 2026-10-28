import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { COPY } from "./tui/copy.ts";

/**
 * Client for the local Python Core (`python -m bittune_core`) over UTF-8
 * JSONL stdin/stdout. One Request per session may be in flight, matching the
 * Agent's serial tool model. The Core is not a daemon: it dies with this
 * client, it never opens the SQLite Store from Node, and a dead Core is
 * always reported as `core_unavailable` - never as a fabricated success.
 */

export const CORE_UNAVAILABLE = "core_unavailable";

export class CoreError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly remediation?: string,
		public readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "CoreError";
	}
}

export interface CoreClientOptions {
	python?: string;
	coreHome?: string;
	/** Extra PYTHONPATH entries (dev/test; production installs the package). */
	modulePaths?: string[];
	onProgress?: (message: string, data?: unknown) => void;
}

interface Pending {
	requestId: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	cancelled: boolean;
	cancelGuard?: NodeJS.Timeout;
	signalCleanup?: () => void;
	onProgress?: (message: string, data?: unknown) => void;
}

interface WireMessage {
	type: string;
	request_id?: string;
	message?: string;
	ok?: boolean;
	data?: unknown;
	error?: { code?: string; message?: string; remediation?: string; details?: Record<string, unknown> };
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** PYTHONPATH entries for the Core package: configured via
 * BITTUNE_CORE_MODULE_PATHS, or the bittune-core/src sibling in a source
 * checkout. Installed releases put the package in the site-packages of the
 * selected Python and need neither. */
	export function coreModulePaths(): string[] {
		const configured = process.env.BITTUNE_CORE_MODULE_PATHS?.split(delimiter).map((entry) => entry.trim()).filter(Boolean);
		if (configured && configured.length > 0) return configured;
		const here = dirname(fileURLToPath(import.meta.url));
		const candidates = [
			join(here, "..", "..", "..", "..", "packages", "bittune-core", "src"),
			join(here, "..", "packages", "bittune-core", "src"),
			join(here, "packages", "bittune-core", "src"),
		];
		for (const candidate of candidates) {
			if (existsSync(join(candidate, "bittune_core", "__main__.py"))) return [candidate];
		}
		return [];
	}

/** Environment for the Core child: isolated Core home plus the module path. */
export function buildCoreEnv(options: CoreClientOptions): NodeJS.ProcessEnv {
	const coreHome = options.coreHome ?? process.env.BITTUNE_CORE_HOME?.trim() ?? join(homedir(), ".bittune", "core");
	const env: NodeJS.ProcessEnv = { ...process.env, BITTUNE_CORE_HOME: coreHome };
	const modulePaths = options.modulePaths ?? coreModulePaths();
	if (modulePaths.length > 0) {
		env.PYTHONPATH = [env.PYTHONPATH, ...modulePaths].filter(Boolean).join(delimiter);
	}
	return env;
}

/** Verifies the selected Python can import the Core before a session starts;
 * a missing Core is a clear startup error, never a silent `core_unavailable`. */
export function probeCore(options: CoreClientOptions = {}): { python: string; version: string } {
	const python = resolvePython(options);
	const result = spawnSync(python, ["-m", "bittune_core", "--version"], {
		encoding: "utf8",
		windowsHide: true,
		timeout: 20_000,
		env: buildCoreEnv(options),
	});
	if (result.status !== 0) {
		const tail = (result.stderr || result.stdout || "").trim().split(/\r?\n/).at(-1)?.slice(0, 200) ?? "无输出";
		throw new Error(`Bittune Core 不可用：${python} -m bittune_core --version 失败：${tail}（可用 BITTUNE_CORE_PYTHON / BITTUNE_CORE_MODULE_PATHS 覆盖，或重跑 bittune install。）`);
	}
	return { python, version: result.stdout.trim() };
}

function resolvePython(options: CoreClientOptions): string {
	const candidates = [
		options.python,
		process.env.BITTUNE_CORE_PYTHON?.trim(),
		...(process.platform === "win32" ? ["python", "py"] : ["python3", "python"]),
	].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) {
		try {
			const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
			if (probe.status === 0 && /\d/.test(probe.stdout)) return candidate;
		} catch {
			// keep probing
		}
	}
	throw new Error("无法定位 Python 解释器；请设置 BITTUNE_CORE_PYTHON 指向安装 Bittune Core 的 Python。");
}

	export class CoreClient {
		private readonly child: ChildProcessWithoutNullStreams;
		private pending: Pending | undefined;
		private dead = false;
		private stderrTail = "";
		private readonly idleWaiters: Array<() => void> = [];

	private constructor(
		child: ChildProcessWithoutNullStreams,
		private readonly options: CoreClientOptions,
	) {
		this.child = child;
	}

	static async start(options: CoreClientOptions = {}): Promise<CoreClient> {
		const probe = probeCore(options);
		const child = spawn(probe.python, ["-m", "bittune_core"], {
			env: buildCoreEnv(options),
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const client = new CoreClient(child, options);
		const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
		lines.on("line", (line) => client.onLine(line));
		child.stderr.on("data", (chunk: Buffer) => {
			client.stderrTail = (client.stderrTail + chunk.toString("utf8")).slice(-4096);
		});
		child.on("error", (error) => client.onExit(error));
		child.on("exit", () => client.onExit());
		return client;
	}

		/**
		 * Evidence-only waiter. Resolves when no request is in flight, or when the
		 * Core process is already dead. Managed tools must still call `request`
		 * and accept `core_busy`; this is not a request queue.
		 */
		whenIdle(): Promise<void> {
			if (this.dead || !this.pending) return Promise.resolve();
			return new Promise((resolve) => {
				this.idleWaiters.push(resolve);
			});
		}

		/**
		 * Sends one request. Exactly one request may be in flight; the optional
		 * AbortSignal maps to a protocol `cancel`, and the Core answers with a
		 * stable `cancelled` error.
		 */
		request<T>(tool: string, params: Record<string, unknown>, options: { sessionId: string; signal?: AbortSignal; onProgress?: (message: string, data?: unknown) => void }): Promise<T> {
				if (this.dead) return Promise.reject(new CoreError(CORE_UNAVAILABLE, COPY.errors.coreUnavailable));
				if (this.pending) return Promise.reject(new CoreError("core_busy", COPY.errors.coreBusy));
		const requestId = randomUUID();
		return new Promise<T>((resolve, reject) => {
			const pending: Pending = { requestId, resolve: resolve as (value: unknown) => void, reject, cancelled: false, onProgress: options.onProgress };
			this.pending = pending;
			const onAbort = () => {
				if (pending.cancelled || this.dead) return;
				pending.cancelled = true;
				this.sendLine({ type: "cancel", request_id: requestId });
				pending.cancelGuard = setTimeout(() => {
					// The Core must answer cancellations promptly; silence means it is stuck.
					this.kill();
					this.failPending(new CoreError(CORE_UNAVAILABLE, "Bittune Core did not answer the cancellation."));
				}, 15_000);
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });
			pending.signalCleanup = () => options.signal?.removeEventListener("abort", onAbort);
			this.sendLine({ type: "request", request_id: requestId, session_id: options.sessionId, tool, params });
		});
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	private onLine(line: string): void {
		let message: WireMessage;
		try {
			message = JSON.parse(line) as WireMessage;
		} catch {
			return;
		}
		if (message.type === "progress") {
			if (this.pending && message.request_id === this.pending.requestId) {
				this.options.onProgress?.(message.message ?? "", message.data);
				this.pending.onProgress?.(message.message ?? "", message.data);
			}
			return;
		}
			if (message.type !== "result") return;
			const pending = this.pending;
			this.pending = undefined;
			this.flushIdle();
			if (!pending) return;
			this.finishPending(pending);
		if (message.ok) {
			pending.resolve(message.data);
			return;
		}
		pending.reject(
			new CoreError(
				message.error?.code ?? "core_error",
				message.error?.message ?? "Bittune Core 未说明原因地拒绝了请求。",
				message.error?.remediation,
				message.error?.details,
			),
		);
	}

	private onExit(error?: Error): void {
		if (this.dead) return;
		this.dead = true;
		for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
			stream.destroy();
		}
		const detail = error?.message ?? this.stderrTail.trim().split(/\r?\n/).pop();
		this.failPending(
			new CoreError(
				CORE_UNAVAILABLE,
				"Bittune Core 进程已退出；本次请求未完成且未写入 Store。",
				"重新启动会话后会重新打开本地 Store。",
				detail ? { detail } : undefined,
			),
		);
	}

		private failPending(error: Error): void {
			const pending = this.pending;
			this.pending = undefined;
			this.flushIdle();
			if (pending) this.finishPending(pending);
			pending?.reject(error);
		}

		private flushIdle(): void {
			if (this.pending) return;
			const waiters = this.idleWaiters.splice(0);
			for (const resolve of waiters) resolve();
		}

	private finishPending(pending: Pending): void {
		if (pending.cancelGuard) clearTimeout(pending.cancelGuard);
		pending.signalCleanup?.();
	}

	/** Closes the session: stdin EOF makes the Core commit and exit cleanly. */
	async stop(): Promise<void> {
		if (this.dead) return;
		if (this.child.stdin.writable) this.child.stdin.end();
		const exitedGracefully = await this.waitExit(3_000);
		if (!exitedGracefully) {
			this.kill();
			await this.waitExit(3_000);
		}
	}

	private kill(): void {
		try {
			this.child.kill("SIGTERM");
		} catch {
			/* already gone */
		}
		setTimeout(() => {
			try {
				this.child.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		}, 1_000).unref();
	}

	private async waitExit(timeoutMs: number): Promise<boolean> {
		try {
			await once(this.child, "exit", { signal: AbortSignal.timeout(timeoutMs) });
			return true;
		} catch {
			return false;
		}
	}

	private sendLine(message: Record<string, unknown>): void {
		if (this.dead || !this.child.stdin.writable) return;
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}
}