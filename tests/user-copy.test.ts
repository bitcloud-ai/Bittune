/**
 * Phase 3 stage 1 user-copy regression tests: tool results and the system
 * prompt must stay in plain language. Raw Core payload JSON never becomes
 * the default user text, and internal protocol names do not leak into the
 * prompt the agent is told to speak from.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { COPY, GENERIC_TOOL_LABELS, humanizeUserText, toolLabel } from "../packages/bittune-runtime/src/harness/tui/copy.ts";
import { CoreError } from "../packages/bittune-runtime/src/harness/core-client.ts";
import { createManagedTools, MANAGED_TOOL_DESCRIPTIONS, summarizeManagedResult } from "../packages/bittune-runtime/src/harness/managed-tools.ts";
import { BITTUNE_SYSTEM_PROMPT, BITTUNE_SYSTEM_PROMPT_MARKER } from "../packages/bittune-runtime/src/harness/system-prompt.ts";
import { BUILTIN_SLASH_COMMANDS } from "../packages/bittune-runtime/src/core/slash-commands.ts";
import { createReadToolDefinition } from "../packages/bittune-runtime/src/core/tools/read.ts";
import { createBashToolDefinition } from "../packages/bittune-runtime/src/core/tools/bash.ts";
import { createEditToolDefinition } from "../packages/bittune-runtime/src/core/tools/edit.ts";
import { createWriteToolDefinition } from "../packages/bittune-runtime/src/core/tools/write.ts";

test("harness user copy: 受管工具默认文本来自 summary，而不是原始 JSON", () => {
	const envelope = {
		summary: "压测完成：1000 个请求，成功率 99.9%，RPS 512.4",
		run_id: "run_internal_id",
		artifact_refs: [],
		data: { benchmark_result: { benchmark_result_id: "brm_internal_id", metrics: { requests_per_second: 512.4 } } },
	};
	const text = summarizeManagedResult("benchmark_service", { service_instance_id: "svc-1" }, envelope);
	assert.ok(text.includes("压测完成：1000 个请求"), `summary must lead the text, got: ${text}`);
	assert.ok(!text.includes("brm_internal_id"), "internal ids must not surface in the user text");
	assert.ok(!text.includes("run_internal_id"), "run ids must not surface in the user text");
	// 默认 UI 摘要不显示内部 ID；模型上下文另保留结构化工具结果。
});

test("harness user copy: 无 summary 时给出可读标题而不是 JSON 直出", () => {
	const envelope = {
		run_id: "run-1",
		data: { benchmark_result: { metrics: { success_rate: 0.995, requests_per_second: 512.4, mean_e2e_latency_ms: 42.1 } } },
	};
	const text = summarizeManagedResult("benchmark_service", {}, envelope);
	assert.ok(text.includes("成功率 99.5%"), text);
	assert.ok(text.includes("512.4 req/s"), text);
	assert.ok(!text.includes("{"), "no raw JSON braces in user copy");
});

test("harness user copy: inspect_records 原生返回（无 run 封装）也能生成摘要", () => {
	assert.ok(summarizeManagedResult("inspect_records", {}, { runs: [{}, {}] }).includes("2 条 Run 记录"));
	const artifact = summarizeManagedResult("inspect_records", {}, { artifact_id: "artifact-1", label: "report.md" });
	assert.ok(artifact.includes("report.md"));
	});

		test("runtime prompt: 系统提示词不带内部协议术语且版本已冻结为 v13", () => {
			assert.ok(BITTUNE_SYSTEM_PROMPT.includes(BITTUNE_SYSTEM_PROMPT_MARKER));
			assert.equal(BITTUNE_SYSTEM_PROMPT_MARKER, "<!-- bittune-system-prompt:v13 -->");
			const internalTerms = [
				"plan_deployment",
				"cloud_preferred",
				"matching_rules-v1",
				"outbox",
				"freeze(",
				"account_history",
				"investigate",
			];
			for (const term of internalTerms) {
				assert.ok(!BITTUNE_SYSTEM_PROMPT.includes(term), `system prompt must not carry internal term: ${term}`);
			}
			assert.ok(BITTUNE_SYSTEM_PROMPT.includes("no mandatory step order"), "prompt must not prescribe a fixed workflow");
				assert.ok(BITTUNE_SYSTEM_PROMPT.includes("Parallel helpers and preparation"));
				assert.ok(BITTUNE_SYSTEM_PROMPT.includes("adopt them even when a helper stopped at a limit"));
				assert.ok(BITTUNE_SYSTEM_PROMPT.includes("do not scan the disk again"));
				assert.ok(BITTUNE_SYSTEM_PROMPT.includes("preparation skills first"));
			assert.ok(!BITTUNE_SYSTEM_PROMPT.includes("then prepare with the policy-constrained bash tool"));
			assert.ok(/only if no\s+matching skill exists/.test(BITTUNE_SYSTEM_PROMPT));
			assert.ok(!BITTUNE_SYSTEM_PROMPT.includes("ask Cloud for a shortlist or layout before creating"));
			assert.ok(!BITTUNE_SYSTEM_PROMPT.includes("Sweep numbers appear only through report references"));
			assert.ok(!BITTUNE_SYSTEM_PROMPT.includes("NVIDIA"));
			assert.ok(!BITTUNE_SYSTEM_PROMPT.includes("AISimulate"));
			assert.ok(!BITTUNE_SYSTEM_PROMPT.includes("aisimulate"));
			assert.ok(BITTUNE_SYSTEM_PROMPT.includes("Default acceptance is the short package"));
			assert.ok(BITTUNE_SYSTEM_PROMPT.includes("not a model failure"));
		});

	test("harness user copy: 受管结果不再提示内部 ID 诊断句", () => {
		const text = summarizeManagedResult("inspect_environment", {}, { summary: "已检查本机硬件。" });
		assert.ok(!text.includes("完整结果与内部 ID"), text);
		assert.ok(!text.includes("诊断详情"), text);
		assert.equal(text, "已检查本机硬件。");
	});

	test("harness user copy: 通用工具卡片标题为中文名", () => {
		assert.equal(createReadToolDefinition(".").label, GENERIC_TOOL_LABELS.read);
		assert.equal(createBashToolDefinition(".").label, GENERIC_TOOL_LABELS.bash);
		assert.equal(createEditToolDefinition(".").label, GENERIC_TOOL_LABELS.edit);
		assert.equal(createWriteToolDefinition(".").label, GENERIC_TOOL_LABELS.write);
	});

		test("harness user copy: Core 失败句与 inspect 警告不泄漏内部工具名", async () => {
			assert.equal(humanizeUserText("Core 未能完成 inspect_environment。"), "检查本机环境未能完成。");
			const envelope = {
				summary: "已生成不可变 HardwareSnapshot snapshot-uuid：0 张 GPU，Docker daemon 可用。",
				data: { hardware_snapshot: { gpus: [], docker: { daemon: true } } },
				warnings: ["nvidia-smi 未检测到 NVIDIA GPU；受管 GPU 部署将被校验拒绝，可用 Bash 准备环境后重新 inspect_environment。"],
			};
			const text = summarizeManagedResult("inspect_environment", {}, envelope);
			assert.ok(text.includes("已检查本机硬件：0 张 GPU"), text);
			assert.ok(!text.includes("inspect_environment"), text);
			assert.ok(!text.includes("snapshot-uuid"), text);
			assert.ok(text.includes("检查本机环境"), text);
			const managed = createManagedTools({
				client: () =>
					({
						request: async () => {
							throw new CoreError("internal", "Core 未能完成 inspect_environment。");
						},
					}) as never,
			});
			const tool = managed.find((item) => item.name === "inspect_environment");
			assert.ok(tool);
			const result = await tool.execute(
				"call-1",
				{},
				undefined,
				undefined,
				{ sessionManager: { getSessionId: () => "session-1" }, ui: {} } as never,
			);
			assert.equal(result.content[0]?.type, "text");
			assert.equal(result.content[0] && "text" in result.content[0] ? result.content[0].text : "", "检查本机环境未能完成。");
		});

		test("harness user copy: 确认标题与斜杠描述来自产品文案", () => {
		assert.equal(COPY.confirm.policy, "需要确认");
		assert.equal(COPY.confirm.managed, "将在本机执行");
		assert.equal(COPY.errors.unknownCommand, "这不是本产品提供的操作。");
			assert.equal(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "copy")?.description, COPY.slash.copy);
			assert.equal(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "quit")?.description, COPY.slash.quit);
		});
