import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	COPY,
	DEPLOY_ACTION_LABELS,
	GENERIC_TOOL_LABELS,
	INVESTIGATE_LABEL,
	MANAGED_TOOL_LABELS,
	PLAN_ACTION_LABELS,
	PRODUCT_TAGLINE,
	PRODUCT_WORDMARK,
	toolLabel,
} from "../packages/bittune-runtime/src/harness/tui/copy.ts";

const FORBIDDEN = [
	"minimal coding agent",
	"Tool observations",
	"Welcome to bittune",
	"This command is not available in Bittune",
	"Direct shell commands are not available in Bittune",
	"BitTune Runtime Policy",
	"What's New",
	"Use /changelog",
	"Free Kimi",
	"OpenCode",
	"pi has joined Earendil",
	"Extensions",
	"↑   ↓   CH",
		"core_busy:",
		"core_unavailable:",
		"inspect_environment",
		"plan_deployment",
		"inspect_records",
	];

function collectStringValues(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) collectStringValues(item, out);
	else if (value && typeof value === "object") {
		for (const item of Object.values(value as Record<string, unknown>)) collectStringValues(item, out);
	}
	return out;
}

test("product copy: 第 10 节对照表的使用者句子齐全", () => {
	assert.equal(PRODUCT_WORDMARK, "BITTUNE");
	assert.equal(PRODUCT_TAGLINE, "本机推理工程智能体");
	assert.equal(toolLabel("inspect_environment"), "检查本机环境");
	assert.equal(toolLabel("read"), "读取");
	assert.equal(toolLabel("bash"), "命令");
	assert.equal(toolLabel("edit"), "编辑");
	assert.equal(toolLabel("write"), "写入");
	assert.equal(toolLabel("plan_deployment"), "提出部署方案");
	assert.equal(toolLabel("plan_deployment", "validate"), "核对方案");
	assert.equal(toolLabel("plan_deployment", "freeze"), "固化方案");
	assert.equal(toolLabel("deploy_service"), "启动服务");
	assert.equal(toolLabel("deploy_service", "stop"), "停止服务");
	assert.equal(toolLabel("deploy_service", "recover"), "恢复服务");
	assert.equal(toolLabel("benchmark_service"), "压测服务");
	assert.equal(toolLabel("benchmark_suite"), "验收服务");
	assert.equal(toolLabel("export_deliverable"), "导出交接件");
	assert.equal(toolLabel("compare_results"), "对比结果");
	assert.equal(toolLabel("write_report"), "写报告");
	assert.equal(toolLabel("inspect_service"), "查看服务");
	assert.equal(toolLabel("inspect_records"), "查阅记录");
	assert.equal(toolLabel("investigate"), INVESTIGATE_LABEL);
		assert.equal(COPY.confirm.policy, "需要确认");
		assert.equal(COPY.confirm.investigate, "排查需要确认");
		assert.equal(COPY.confirm.managed, "将在本机执行");
		assert.equal(COPY.errors.coreBusy, "正在执行上一项本机操作，请稍候。");
		assert.equal(COPY.errors.coreUnavailable, "本机服务暂时不可用。");
	assert.equal(COPY.host.local, "仅本机");
		assert.equal(COPY.errors.unknownCommand, "这不是本产品提供的操作。");
		assert.equal(COPY.errors.investigateCancelled, "排查已取消。");
		assert.equal(COPY.errors.investigateFailed, "排查未能完成。");
			assert.equal(COPY.errors.investigateLimit, "排查已达到步数上限。");
			assert.equal(COPY.collab.done, "排查完成");
			assert.equal(COPY.collab.failed, "排查未能完成");
			assert.equal(COPY.collab.stepRunning, "进行中");
			assert.equal(COPY.collab.stepDone, "完成");
			assert.equal(COPY.collab.stepFailed, "未能完成");
		assert.equal(COPY.working, "正在处理…");
	assert.equal(COPY.thinking, "正在思考…");
	assert.equal(COPY.slash.copy, "复制上一条回复");
	assert.equal(GENERIC_TOOL_LABELS.read, "读取");
	assert.equal(PLAN_ACTION_LABELS.freeze, "固化方案");
	assert.equal(DEPLOY_ACTION_LABELS.start, "启动服务");
	assert.equal(MANAGED_TOOL_LABELS.inspect_environment, "检查本机环境");
});

test("product copy: 禁止列表不得出现在 copy 模块导出的字符串值里", () => {
	const exported = collectStringValues({
		PRODUCT_WORDMARK,
		PRODUCT_TAGLINE,
		COPY,
		GENERIC_TOOL_LABELS,
		MANAGED_TOOL_LABELS,
		PLAN_ACTION_LABELS,
		DEPLOY_ACTION_LABELS,
		INVESTIGATE_LABEL,
	});
	for (const banned of FORBIDDEN) {
		for (const value of exported) {
			assert.ok(!value.includes(banned), `copy export leaked forbidden text ${JSON.stringify(banned)} in ${JSON.stringify(value)}`);
		}
	}
});

	test("product copy: 产品面源码不再含阶段 3 禁词", () => {
		const files = [
			"packages/bittune-runtime/src/harness/extension.ts",
			"packages/bittune-runtime/src/harness/managed-tools.ts",
			"packages/bittune-runtime/src/harness/core-client.ts",
			"packages/bittune-runtime/src/core/slash-commands.ts",
			"packages/bittune-runtime/src/core/bittune-product-policy.ts",
			"packages/bittune-runtime/src/modes/interactive/interactive-mode.ts",
			"packages/bittune-runtime/src/modes/interactive/components/assistant-message.ts",
			"packages/bittune-runtime/src/modes/interactive/components/tool-execution.ts",
			"packages/bittune-runtime/src/core/tools/read.ts",
			"packages/bittune-runtime/src/core/tools/bash.ts",
			"packages/bittune-runtime/src/core/tools/edit.ts",
			"packages/bittune-runtime/src/core/tools/write.ts",
		];
		const surfaceForbidden = [
			"BitTune Runtime Policy",
			"BitTune 受管操作",
			"This command is not available in Bittune",
			"Direct shell commands are not available in Bittune",
			"完整结果与内部 ID 见展开的诊断详情。",
			"core_busy:",
			"core_unavailable:",
		];
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			for (const banned of surfaceForbidden) {
				assert.ok(!source.includes(banned), `${file} leaked ${JSON.stringify(banned)}`);
			}
		}
		const interactive = readFileSync("packages/bittune-runtime/src/modes/interactive/interactive-mode.ts", "utf8");
		assert.ok(interactive.includes("COPY.errors.unknownCommand"));
		assert.ok(interactive.includes("changelogMarkdown = undefined"));
		assert.ok(!interactive.includes("this.handleDaxnuts();"));
		assert.ok(interactive.includes("COPY.working"));
		assert.ok(interactive.includes("COPY.thinking"));
		const extension = readFileSync("packages/bittune-runtime/src/harness/extension.ts", "utf8");
		assert.ok(extension.includes("COPY.confirm.policy"));
		const managed = readFileSync("packages/bittune-runtime/src/harness/managed-tools.ts", "utf8");
		assert.ok(managed.includes("COPY.confirm.managed"));
		assert.ok(managed.includes("COPY.confirmBody"));
	});

	test("phase 5 基线：Pi 钉 0.84.1，不 rebase", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
	for (const name of ["pi-agent-core", "pi-ai", "pi-client", "pi-protocol", "pi-tui"]) {
		assert.equal(pkg.dependencies[`@earendil-works/${name}`], "0.84.1");
	}
});
