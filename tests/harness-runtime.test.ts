import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import { CoreClient, CoreError, CORE_UNAVAILABLE } from "../packages/bittune-runtime/src/harness/core-client.ts";
import { buildEvidenceFromResult, submitEvidence } from "../packages/bittune-runtime/src/harness/generic-evidence.ts";
import { createManagedTools, MANAGED_TOOL_DESCRIPTIONS, MANAGED_TOOL_NAMES } from "../packages/bittune-runtime/src/harness/managed-tools.ts";
import { BITTUNE_SYSTEM_PROMPT, BITTUNE_SYSTEM_PROMPT_MARKER } from "../packages/bittune-runtime/src/harness/system-prompt.ts";
import { evaluateBash, evaluateFileAccess } from "../packages/bittune-runtime/src/harness/runtime-policy.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CORE_SRC = join(REPO_ROOT, "packages", "bittune-core", "src");

const bulk = (size: number) => "x".repeat(size);

const factRunId = "run-00000000-0000-4000-8000-000000000000";

test("managed results retain facts for the Agent while the collapsed TUI shows only a summary", async () => {
	const payload = { run_id: "run-content", data: { hardware_snapshot: { hardware_snapshot_id: "snapshot-content", gpus: [], docker: { daemon: false } } } };
	const client = { request: async () => payload } as unknown as CoreClient;
	const tool = createManagedTools({ client: () => client }).find((entry) => entry.name === "inspect_environment")!;
	const result = await tool.execute("call-content", {}, undefined, undefined, { sessionManager: { getSessionId: () => "test" } } as never);
	const text = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text");
	assert.equal(JSON.parse(text[1].text).data.hardware_snapshot.hardware_snapshot_id, "snapshot-content");
	const theme = { fg: (_color: string, value: string) => value } as never;
	const collapsed = tool.renderResult!(result, { expanded: false, isPartial: false }, theme, {} as never).render(100).join("\n");
	assert.ok(!collapsed.includes("snapshot-content"));
	const expanded = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, {} as never).render(100).join("\n");
	assert.ok(expanded.includes("snapshot-content"));
});

test("managed errors expose the Core's incompatible field to the Agent", async () => {
	const client = { request: async () => { throw new CoreError("unsupported_serving_parameter", "Unsupported parameter", undefined, { parameter: "kv_cache_dtype" }); } } as unknown as CoreClient;
	const tool = createManagedTools({ client: () => client }).find((entry) => entry.name === "inspect_environment")!;
	const result = await tool.execute("call-error", {}, undefined, undefined, { sessionManager: { getSessionId: () => "test" } } as never);
	const texts = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text");
	assert.equal(JSON.parse(texts[1].text).error.details.parameter, "kv_cache_dtype");
});

async function startClient(onProgress?: (message: string) => void): Promise<{ client: CoreClient; coreHome: string }> {
	const coreHome = await mkdtemp(join(tmpdir(), "bittune-harness-"));
	const client = await CoreClient.start({ coreHome, modulePaths: [CORE_SRC], ...(onProgress ? { onProgress } : {}) });
	return { client, coreHome };
}

async function writeBulkEvidence(coreHome: string, sessionId: string, filename: string, outputBytes: number, outputs: number): Promise<void> {
	const staging = join(coreHome, "staging", sessionId);
	await mkdir(staging, { recursive: true });
	await writeFile(
		join(staging, filename),
		JSON.stringify({
			tool_name: "bash",
			status: "completed",
			summary: "bulk",
			input: { command: "yes", cwd: "/tmp" },
			outputs: Array.from({ length: outputs }, (_, index) => ({
				label: `out-${index}`,
				content: bulk(outputBytes),
				media_type: "text/plain",
			})),
		}),
		"utf8",
	);
}

test("CoreClient 往返：摄入通用工具证据并回读，敏感字段已脱敏", async () => {
	const { client, coreHome } = await startClient();
	try {
		await mkdir(join(coreHome, "staging", "session-1"), { recursive: true });
		await writeFile(
			join(coreHome, "staging", "session-1", "ev-1.json"),
			JSON.stringify({
				tool_name: "bash",
				status: "completed",
				summary: "probed",
				input: { command: "curl -H 'Authorization: Bearer sk-1'", cwd: "/tmp" },
				outputs: [{ label: "stdout", content: "Authorization: Bearer very-secret\n", media_type: "text/plain" }],
			}),
			"utf8",
		);
		const ingested = await client.request<{ run_id: string }>("ingest_evidence", { staging_file: "ev-1.json" }, { sessionId: "session-1" });
		const run = await client.request<{ status: string; input: { command: string } }>(
			"inspect_records",
			{ kind: "run", id: ingested.run_id },
			{ sessionId: "session-1" },
		);
		assert.equal(run.status, "completed");
		assert.equal(run.input.command, "curl -H 'Authorization: Bearer [REDACTED]'");
	} finally {
		await client.stop();
	}
});

test("Core 应用错误映射为带稳定码的 CoreError，不伪造成功", async () => {
	const { client } = await startClient();
	try {
		await assert.rejects(
			client.request("inspect_records", { kind: "run", id: factRunId }, { sessionId: "session-1" }),
			(error) => error instanceof CoreError && error.code === "not_found",
		);
		await assert.rejects(
			client.request("publish_deployment_preset", {}, { sessionId: "session-1" }),
			(error) => error instanceof CoreError && error.code === "tool_not_found",
		);
	} finally {
		await client.stop();
	}
});

test("CoreClient 一次只允许一个在途请求", async () => {
	const { client, coreHome } = await startClient();
	try {
		await writeBulkEvidence(coreHome, "session-1", "ev-big.json", 256 * 1024, 1);
		const first = client.request("ingest_evidence", { staging_file: "ev-big.json" }, { sessionId: "session-1" });
		await assert.rejects(
			client.request("inspect_records", { kind: "run" }, { sessionId: "session-1" }),
			(error) => error instanceof CoreError && error.code === "core_busy",
		);
			await first;
		} finally {
			await client.stop();
		}
	});

	test("CoreClient whenIdle 等到在途请求结束后才返回", async () => {
		const { client, coreHome } = await startClient();
		try {
			await writeBulkEvidence(coreHome, "session-1", "ev-idle.json", 256 * 1024, 1);
			const first = client.request("ingest_evidence", { staging_file: "ev-idle.json" }, { sessionId: "session-1" });
			let idle = false;
			const waiting = client.whenIdle().then(() => {
				idle = true;
			});
			await Promise.resolve();
			assert.equal(idle, false);
			await first;
			await waiting;
			assert.equal(idle, true);
			await client.whenIdle();
		} finally {
			await client.stop();
		}
	});

	test("submitEvidence 等 Core 空闲，core_busy 不告警", async () => {
		const coreHome = await mkdtemp(join(tmpdir(), "bittune-evidence-idle-"));
		const warnings: string[] = [];
		let pending = true;
		const waiters: Array<() => void> = [];
		const client = {
			whenIdle: async () => {
				if (!pending) return;
				await new Promise<void>((resolve) => {
					waiters.push(resolve);
				});
			},
			request: async () => {
				if (pending) throw new CoreError("core_busy", "正在执行上一项本机操作，请稍候。");
				return { run_id: "run-idle" };
			},
		} as unknown as CoreClient;
		const ingest = submitEvidence(
			{
				tool_name: "bash",
				status: "completed",
				summary: "echo",
				input: { command: "echo hi" },
				outputs: [],
			},
			{
				client,
				coreHome,
				sessionId: "session-idle",
				warn: (message) => warnings.push(message),
			},
		);
		const deadline = Date.now() + 2_000;
		while (waiters.length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setImmediate(resolve));
		}
		assert.equal(waiters.length > 0, true);
		assert.equal(warnings.length, 0);
		pending = false;
		for (const resolve of waiters.splice(0)) resolve();
		await ingest;
		assert.equal(warnings.length, 0);
	});

	test("取消：进度到达后 AbortSignal 经 cancel 抵达 Core，稳定回 cancelled", async () => {
	let progressCount = 0;
	const { client, coreHome } = await startClient(() => {
		progressCount += 1;
	});
	try {
		await writeBulkEvidence(coreHome, "session-1", "ev-cancel.json", 256 * 1024, 8);
		const controller = new AbortController();
		const request = client.request("ingest_evidence", { staging_file: "ev-cancel.json" }, { sessionId: "session-1", signal: controller.signal });
		const deadline = Date.now() + 30_000;
		while (progressCount < 2 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.ok(progressCount >= 2, "progress events must reach the client before cancel");
		controller.abort();
		await assert.rejects(request, (error) => error instanceof CoreError && error.code === "cancelled");
		const runs = await client.request<{ runs: Array<{ status: string }> }>(
			"inspect_records",
			{ kind: "run", status: "cancelled" },
			{ sessionId: "session-1" },
		);
		assert.equal(runs.runs.length, 1);
	} finally {
		await client.stop();
	}
});

test("Core 崩溃：pending 拒绝为 core_unavailable，重启后 Run 标记 interrupted", async () => {
	const coreHome = await mkdtemp(join(tmpdir(), "bittune-harness-"));
	let firstProgress: (() => void) | undefined;
	const progressed = new Promise<void>((resolveProgress) => {
		firstProgress = resolveProgress;
	});
	const client = await CoreClient.start({
		coreHome,
		modulePaths: [CORE_SRC],
		onProgress: () => firstProgress?.(),
	});
	await writeBulkEvidence(coreHome, "session-1", "ev-crash.json", 256 * 1024, 8);
	const request = client.request("ingest_evidence", { staging_file: "ev-crash.json" }, { sessionId: "session-1" });
	await progressed;
	const pid = client.pid;
	assert.ok(pid, "core pid must be visible");
	process.kill(pid, "SIGKILL");
	await assert.rejects(request, (error) => error instanceof CoreError && error.code === CORE_UNAVAILABLE);
	await client.stop();
	const reopened = await CoreClient.start({ coreHome, modulePaths: [CORE_SRC] });
	try {
		const runs = await reopened.request<{ runs: Array<{ status: string }> }>(
			"inspect_records",
			{ kind: "run", status: "interrupted" },
			{ sessionId: "session-1" },
		);
		assert.equal(runs.runs.length, 1);
		assert.equal(runs.runs[0]!.status, "interrupted");
	} finally {
		await reopened.stop();
	}
});

test("stop：Core 随客户端关闭退出，可再次启动访问同一 Store", async () => {
	const { client, coreHome } = await startClient();
	await client.stop();
	const second = await CoreClient.start({ coreHome, modulePaths: [CORE_SRC] });
	try {
		const listing = await second.request<{ runs: unknown[] }>("inspect_records", { kind: "run" }, { sessionId: "session-2" });
		assert.deepEqual(listing.runs, []);
	} finally {
		await second.stop();
	}
});

test("受管工具面：schema 只接受业务引用与有界配置", () => {
	const tools = createManagedTools({ client: () => undefined });
	assert.deepEqual(tools.map((tool) => tool.name), [...MANAGED_TOOL_NAMES]);
	const plan = tools.find((tool) => tool.name === "plan_deployment")!;
		assert.equal(Value.Check(plan.parameters, { action: "validate", plan_id: "plan-1" }), true);
		assert.equal(Value.Check(plan.parameters, { action: "create", prior_source: "none" }), true);
		assert.equal(Value.Check(plan.parameters, { action: "create" }), false);
		assert.equal(Value.Check(plan.parameters, { action: "validate", plan_id: "plan-1", prior_source: "none" }), false);
		assert.equal(Value.Check(plan.parameters, { action: "freeze", plan_id: "plan-1", based_on_plan_id: "plan-1" }), false);
		assert.equal(Value.Check(plan.parameters, { action: "create", docker_run: "docker run nginx" }), false);
	assert.equal(Value.Check(plan.parameters, {}), false);
	const runtime_spec = { schema_version: 1, runtime_kind: "vllm", image_repository: "vllm/vllm-openai", image_digest: `sha256:${"a".repeat(64)}` };
	const localPlan = { action: "create", prior_source: "user_specified", model_ref: { schema_version: 1, model_id: "org/model", local_path: "/models/checkpoint" }, runtime_spec };
	assert.equal(Value.Check(plan.parameters, localPlan), true);
	assert.equal(Value.Check(plan.parameters, { ...localPlan, serving_spec: { max_model_len: 32768, gpu_memory_utilization: 0.85 } }), true);
	assert.equal(Value.Check(plan.parameters, { ...localPlan, serving_spec: { kv_cache_dtype: "fp8_e4m3" } }), true);
	assert.equal(Value.Check(plan.parameters, { ...localPlan, serving_spec: { kv_cache_dtype: "unknown_dtype" } }), false);
	assert.equal(Value.Check(plan.parameters, { ...localPlan, serving_spec: { gpu_memory_utilization: 0 } }), false);
	assert.equal(Value.Check(plan.parameters, { ...localPlan, runtime_spec: { ...runtime_spec, image_tag: "probe" } }), false);
	assert.equal(Value.Check(plan.parameters, { ...localPlan, runtime_spec: { runtime_kind: "vllm" } }), false);
	assert.equal(Value.Check(plan.parameters, { ...localPlan, runtime_spec: { ...runtime_spec, image_digest: `sha256:${"0".repeat(64)}` } }), false);
	assert.equal(Value.Check(plan.parameters, { ...localPlan, model_ref: { schema_version: 1, model_id: "/models/checkpoint", revision: "main" } }), false);
	const deploy = tools.find((tool) => tool.name === "deploy_service")!;
	assert.equal(Value.Check(deploy.parameters, { action: "start", plan_id: "plan-1" }), true);
	assert.equal(Value.Check(deploy.parameters, { action: "start", plan_id: "plan-1", ready_timeout_seconds: 30 }), true);
	assert.equal(Value.Check(deploy.parameters, { action: "start", plan_id: "plan-1", ready_timeout_seconds: -1 }), false);
	assert.equal(Value.Check(deploy.parameters, { action: "stop", container_id: "abc123" }), false);
	const benchmark = tools.find((tool) => tool.name === "benchmark_service")!;
	const reportTool = tools.find((tool) => tool.name === "write_report")!;
	const reportInput = { title: "report", narrative: "scope", conclusion: "done" };
	assert.equal(Value.Check(reportTool.parameters, { ...reportInput, references: { plan_ids: ["plan-1"], benchmark_result_ids: ["bench-1"], run_ids: ["run-1"] } }), true);
	assert.equal(Value.Check(reportTool.parameters, { ...reportInput, references: { deployment_plan: ["plan-1"] } }), false);
	const boundInput = { service_instance_id: "service-1", workload: { schema_version: 2, mode: "closed_loop", concurrency: 1, request_count: 2, input_tokens: 128, output_tokens: 32 } };
	assert.equal(benchmark.prepareArguments!(boundInput), boundInput, "Preparation must preserve the selected subject and workload");
	assert.throws(() => benchmark.prepareArguments!({ ...boundInput, endpoint: { url: "http://127.0.0.1:9", model_id: "model" } }), /二选一/);
	assert.throws(() => benchmark.prepareArguments!({ workload: boundInput.workload }), /二选一/);
	assert.equal(Value.Check(benchmark.parameters, { service_instance_id: "service-1", workload: { schema_version: 1 } }), false);
		assert.equal(Value.Check(benchmark.parameters, { service_instance_id: "service-1", workload: { schema_version: 2, mode: "closed_loop", concurrency: 1, request_count: 8, input_tokens: 64, output_tokens: 32 } }), true);
		assert.equal(Value.Check(benchmark.parameters, { endpoint: { url: "http://127.0.0.1:9", model_id: "Qwen/Qwen3-32B" }, workload: { schema_version: 2, mode: "closed_loop", concurrency: 1, request_count: 8, input_tokens: 64, output_tokens: 32 } }), true);
		assert.equal(Value.Check(benchmark.parameters, { service_instance_id: "service-1", endpoint: { url: "http://127.0.0.1:9", model_id: "Qwen/Qwen3-32B" }, workload: { schema_version: 2, mode: "closed_loop", concurrency: 1, request_count: 8, input_tokens: 64, output_tokens: 32 } }), false);
		const suite = tools.find((tool) => tool.name === "benchmark_suite")!;
		assert.equal(Value.Check(suite.parameters, { intent: "performance_sweep", service_instance_id: "service-1" }), true);
		assert.equal(Value.Check(suite.parameters, { intent: "performance_sweep", endpoint: { url: "http://127.0.0.1:9", model_id: "Qwen/Qwen3-32B" } }), true);
		assert.equal(Value.Check(suite.parameters, { intent: "performance_sweep", service_instance_id: "service-1", endpoint: { url: "http://127.0.0.1:9", model_id: "m" } }), false);
		assert.equal(Value.Check(suite.parameters, { intent: "performance_sweep", service_instance_id: "service-1", base_url: "http://127.0.0.1" }), false);
	const acceptance = { schema_version: 2, success_rate_min: 0.99, latency_comparison: "raw_ms", request_limits_ms: { e2e: 1000 }, p99_limits_ms: { e2e: 1000 }, stop_policy: { throughput_drop_ratio: 0.2 } };
	assert.equal(Value.Check(benchmark.parameters, { ...boundInput, acceptance }), true);
	assert.equal(Value.Check(benchmark.parameters, { ...boundInput, acceptance: { ...acceptance, request_limits_ms: { e2e: 0 } } }), false);
	assert.equal(Value.Check(benchmark.parameters, { ...boundInput, acceptance: { ...acceptance, extra: true } }), false);
	const compare = tools.find((tool) => tool.name === "compare_results")!;
	assert.equal(Value.Check(compare.parameters, { benchmark_result_ids: ["a", "b"] }), true);
	assert.equal(Value.Check(compare.parameters, { suite_points: [{ suite_result_id: "s", scenario_id: "chat", concurrency: 1 }, { suite_result_id: "s", scenario_id: "chat", concurrency: 1 }] }), true);
	assert.equal(Value.Check(compare.parameters, { suite_points: [{ suite_result_id: "s", scenario_id: "chat", concurrency: 1, repeat: 1 }, { suite_result_id: "s", scenario_id: "chat", concurrency: 1, repeat: 2 }] }), true);
	assert.equal(Value.Check(compare.parameters, { benchmark_result_ids: ["a", "b"], suite_points: [{ suite_result_id: "s", scenario_id: "chat", concurrency: 1 }] }), false);
	assert.equal(Value.Check(compare.parameters, {}), false);
	const report = tools.find((tool) => tool.name === "write_report")!;
	assert.equal(Value.Check(report.parameters, { title: "t", narrative: "n", conclusion: "c", suite_claims: [{ suite_result_id: "s", scenario_id: "chat", concurrency: 1, metric: "goodput", value: 1 }] }), false);
	assert.equal(Value.Check(report.parameters, { title: "t", narrative: "n", conclusion: "c", suite_claims: [{ suite_result_id: "s", scenario_id: "chat", concurrency: 1, repeat: 2, metric: "goodput" }] }), true);
	const records = tools.find((tool) => tool.name === "inspect_records")!;
	assert.equal(Value.Check(records.parameters, { kind: "suite_result", profile_id: "bittune-default-v1" }), true);
	const inspect = tools.find((tool) => tool.name === "inspect_environment")!;
	assert.equal(Value.Check(inspect.parameters, {}), true);
	assert.equal(Value.Check(inspect.parameters, { probes: ["nvbandwidth"] }), true);
});

test("审计：Runtime 源码不引入 SQLite", async () => {
	const runtimeSrc = join(REPO_ROOT, "packages", "bittune-runtime", "src");
	const offenders: string[] = [];
	async function walk(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.name.endsWith(".ts")) {
				const source = await readFile(path, "utf8");
				if (/node:sqlite/.test(source)) offenders.push(path);
			}
		}
	}
	await walk(runtimeSrc);
	assert.deepEqual(offenders, []);
});

test("Runtime Policy：低影响调查放行，宿主动作要求确认", () => {
	const protectedRoots = ["/home/u/.bittune"];
	assert.equal(evaluateBash("nvidia-smi --query-gpu=name", "/work", protectedRoots).decision, "allow");
	assert.equal(evaluateBash("docker ps -a", "/work", protectedRoots).decision, "allow");
	assert.equal(evaluateBash("docker image inspect vllm/vllm-openai", "/work", protectedRoots).decision, "allow");
	assert.equal(evaluateBash("git status", "/work", protectedRoots).decision, "allow");
	assert.equal(evaluateBash("docker run -d --gpus all vllm/vllm-openai", "/work", protectedRoots).decision, "ask");
	assert.equal(evaluateBash("git push origin main", "/work", protectedRoots).decision, "ask");
	assert.equal(evaluateBash("curl -s -X POST https://example.test/upload", "/work", protectedRoots).decision, "ask");
	assert.equal(evaluateBash("curl -s https://example.test/status", "/work", protectedRoots).decision, "allow");
	assert.equal(evaluateBash("rm dist/", "/work", protectedRoots).decision, "ask");
	assert.equal(evaluateBash("sudo systemctl restart docker", "/work", protectedRoots).decision, "ask");
});

test("Runtime Policy：受管目录与破坏性系统命令被拒绝", () => {
	const protectedRoots = ["/home/u/.bittune"];
	assert.equal(evaluateBash("cat ~/.bittune/core/bittune.db", "/work", protectedRoots).decision, "deny");
	assert.equal(evaluateBash("sqlite3 $BITTUNE_HOME/core/bittune.db \"select * from runs\"", "/work", protectedRoots).decision, "deny");
	assert.equal(evaluateBash("sudo cat /root/.bittune/state/bittune.db", "/work", protectedRoots).decision, "deny");
	assert.equal(evaluateBash("rm -rf /usr/local", "/work", protectedRoots).decision, "deny");
	assert.equal(evaluateBash("", "/work", protectedRoots).decision, "deny");
});

test("Runtime Policy：未知命令默认确认，重定向与管道写入受控面", () => {
	const protectedRoots = ["/home/u/.bittune"];
	// unknown first words default to confirmation instead of the old allow
	assert.equal(evaluateBash("./tune.sh", "/work", protectedRoots).decision, "ask");
	assert.equal(evaluateBash("dd if=/dev/zero of=/dev/sdb", "/work", protectedRoots).decision, "ask");
	assert.equal(evaluateBash("tee /etc/hosts", "/work", protectedRoots).decision, "ask");
	assert.equal(evaluateBash("shred -u /etc/passwd", "/work", protectedRoots).decision, "ask");
	// redirections confined to the workspace stay allowed for innocent words
	assert.equal(evaluateBash("echo hi > notes.txt", "/work", protectedRoots).decision, "allow");
	assert.equal(evaluateBash(`echo hi > ${join(tmpdir(), "notes.txt")}`, "/work", protectedRoots).decision, "allow");
	assert.equal(evaluateBash("echo done > /dev/null", "/work", protectedRoots).decision, "allow");
	// redirections writing outside the workspace ask, incl. block devices
	assert.equal(evaluateBash("echo x >> /etc/cron.d/p", "/work", protectedRoots).decision, "ask");
	assert.equal(evaluateBash("echo hi > /var/log/x", "/work", protectedRoots).decision, "ask");
	assert.equal(evaluateBash("echo hi > ../outside.txt", "/work", protectedRoots).decision, "ask");
	// pipes / substitutions smuggling confirmation-gated commands ask
	assert.equal(evaluateBash("nvidia-smi | grep GPU", "/work", protectedRoots).decision, "allow");
	assert.equal(evaluateBash("sort a.txt | tee /etc/hosts", "/work", protectedRoots).decision, "ask");
	assert.equal(evaluateBash('printf "%s" "$(sudo id)"', "/work", protectedRoots).decision, "ask");
});

test("Runtime Policy：文件工具按路径做 allow/ask/deny", () => {
	const protectedRoots = ["/home/u/.bittune"];
	const readModel = (path: string) => evaluateFileAccess({ toolName: "read", path, cwd: "/work/project", protectedRoots });
	assert.equal(readModel("config.json").decision, "allow");
	assert.equal(readModel("/var/log/syslog").decision, "allow");
	assert.equal(readModel("/home/u/.bittune/agent/auth.json").decision, "deny");
	const writeModel = (path: string) => evaluateFileAccess({ toolName: "write", path, cwd: "/work/project", protectedRoots });
	assert.equal(writeModel("notes.md").decision, "allow");
	assert.equal(writeModel("../outside.txt").decision, "ask");
	assert.equal(writeModel("/etc/profile").decision, "ask");
	assert.equal(writeModel("/home/u/.bittune/state/nope").decision, "deny");
});

test("证据构造：Bash 保留结果与完整输出，文件工具不复制文件内容", async () => {
	const bashEvent = {
		type: "tool_result",
		toolCallId: "call-bash-1",
		toolName: "bash",
		isError: false,
		input: { command: "echo ok" },
		content: [{ type: "text", text: "ok\n" }],
		details: undefined,
	};
	const typed = (event: unknown) => event as import("../packages/bittune-runtime/src/harness/generic-evidence.ts").GenericToolResultEvent;
	const record = buildEvidenceFromResult(typed(bashEvent), "completed");
	assert.equal(record.tool_name, "bash");
	assert.equal(record.status, "completed");
	assert.ok(record.outputs.some((output) => output.label === "result"));

	const failed = buildEvidenceFromResult(
		typed({ ...bashEvent, isError: true, content: [{ type: "text", text: "bash: nope: command not found\n" }] }),
		"failed",
	);
	assert.equal(failed.status, "failed");
	assert.equal(failed.error?.code, "tool_error");
	assert.equal(failed.summary, "bash: nope: command not found");

	const writeEvent = {
		type: "tool_result",
		toolCallId: "call-write-1",
		toolName: "write",
		isError: false,
		input: { path: "notes.md", content: "secret plan" },
		content: [{ type: "text", text: "Wrote notes.md" }],
		details: undefined,
	};
	const writeRecord = buildEvidenceFromResult(typed(writeEvent), "completed");
	assert.deepEqual(writeRecord.outputs, []);
	assert.equal(writeRecord.summary.includes("secret plan"), false);
});

test("阶段 4：提示词、工具描述和用户文档不再把缺口写成下一步", async () => {
	assert.equal(BITTUNE_SYSTEM_PROMPT_MARKER, "<!-- bittune-system-prompt:v13 -->");
	assert.equal(BITTUNE_SYSTEM_PROMPT.includes("ask Cloud for a shortlist or layout before creating"), false);
	assert.equal(BITTUNE_SYSTEM_PROMPT.includes("Sweep numbers appear only through report references"), false);
	assert.equal(BITTUNE_SYSTEM_PROMPT.includes("continue with a local plan"), false);
	assert.match(BITTUNE_SYSTEM_PROMPT, /claimable/);
	assert.match(BITTUNE_SYSTEM_PROMPT, /binding/);
	for (const name of ["benchmark_service", "benchmark_suite"] as const) {
		const text = MANAGED_TOOL_DESCRIPTIONS[name];
		assert.equal(text.includes("不接受地址"), false, text);
		assert.match(text, /回环结果不能称为 BitTune 实测/);
	}
	const skill = await readFile(join(REPO_ROOT, "packages/bittune-runtime/skills/benchmark-suite/SKILL.md"), "utf8");
	assert.equal(skill.includes("验收已部署的本机推理服务"), false);
	assert.equal(skill.includes("回到部署"), false);
	assert.equal(skill.includes("不要给用户一个地址"), false);
	assert.equal(skill.includes("数字只通过报告引用出现"), false);
	const readme = await readFile(join(REPO_ROOT, "README.md"), "utf8");
	assert.equal(readme.includes("8 个受管工具"), false);
	const guide = await readFile(join(REPO_ROOT, "guide/README.md"), "utf8");
	assert.equal(guide.includes("参数调优"), false);
	assert.match(guide, /部署草稿/);
	assert.match(guide, /bound/);
	assert.match(guide, /指纹/);
	const operations = await readFile(join(REPO_ROOT, "guide/operations.md"), "utf8");
	assert.equal(operations.includes("ownership=observed"), false);
	assert.match(operations, /未跟踪/);
});

async function evidenceResultHook(client: CoreClient, coreHome: string, warnings: string[]) {
	const { createHarnessExtension } = await import("../packages/bittune-runtime/src/harness/extension.ts");
	let hook: (event: unknown, ctx: unknown) => Promise<any>;
	createHarnessExtension({ client: () => client, coreHome, cwd: coreHome, protectedRoots: [], warn: (message) => warnings.push(message) })({
		registerTool() {}, registerCommand() {},
		on(event: string, handler: typeof hook) { if (event === "tool_result") hook = handler; },
	} as never);
	return (event: unknown) => hook(event, { sessionManager: { getSessionId: () => "receipt-session" } });
}

test("generic result hook returns persisted Run and Artifact IDs to the Agent", async () => {
	const { client, coreHome } = await startClient();
	try {
		const warnings: string[] = [];
		const hook = await evidenceResultHook(client, coreHome, warnings);
		const content = [{ type: "text", text: "receipt output" }];
		const result = await hook({ type: "tool_result", toolName: "bash", toolCallId: "receipt", input: { command: "echo receipt" }, content, details: {}, isError: false });
		assert.deepEqual(result.content[0], content[0]);
		const receipt = JSON.parse(result.content[1].text.slice("Bittune evidence: ".length));
		assert.equal(receipt.run_id, result.details.evidence.run_id);
		const run = await client.request<any>("inspect_records", { kind: "run", id: receipt.run_id }, { sessionId: "receipt-session" });
		assert.equal(run.status, "completed");
		const excerpt = await client.request<any>("inspect_records", { kind: "artifact", id: receipt.artifact_refs[0].artifact_id }, { sessionId: "receipt-session" });
		assert.equal(excerpt.text, "receipt output");
		assert.deepEqual(warnings, []);
	} finally { await client.stop(); }
});

test("generic result hook preserves output and staging when evidence intake fails", async () => {
	const coreHome = await mkdtemp(join(tmpdir(), "bittune-receipt-failed-"));
	const warnings: string[] = [];
	const client = { request: async () => { throw new CoreError("core_unavailable", "fixture unavailable"); } } as unknown as CoreClient;
	const hook = await evidenceResultHook(client, coreHome, warnings);
	const content = [{ type: "text", text: "original result" }];
	const result = await hook({ type: "tool_result", toolName: "read", toolCallId: "receipt-failed", input: { path: "fixture.txt" }, content, details: {}, isError: false });
	assert.deepEqual(result.content[0], content[0]);
	assert.equal(result.details.evidence.status, "not_saved");
	assert.ok(!result.content[1].text.includes("run_id"));
	assert.equal(warnings.length, 1);
	const { readdir } = await import("node:fs/promises");
	assert.equal((await readdir(join(coreHome, "staging", "receipt-session"))).length, 1);
});
