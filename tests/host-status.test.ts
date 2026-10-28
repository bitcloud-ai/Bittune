import assert from "node:assert/strict";
import { test } from "node:test";
import { COPY } from "../packages/bittune-runtime/src/harness/tui/copy.ts";
import {
	COLLAB_HOLD_MS,
	columnWidth,
	createIdleHostStatus,
	formatCollabText,
	formatCompactHeader,
	formatFooterLine,
	formatFooterLines,
	formatGpuText,
	formatHostText,
	formatVramBar,
	formatVramText,
	formatServiceText,
	formatTaskText,
	hostFromDoctor,
	HostStatusStore,
	reduceHostStatus,
	serviceFromManagedRecords,
	taskFromFlight,
	type HostStatus,
} from "../packages/bittune-runtime/src/harness/tui/host-status.ts";

function status(over: Partial<HostStatus> = {}): HostStatus {
	return { ...createIdleHostStatus(), ...over };
}

test("host-status: 无 GPU、Docker down、仅本机", () => {
	const host = hostFromDoctor({ gpuNames: [], docker: "down" });
	assert.equal(formatHostText(host), "未检测到 GPU · Docker 未就绪 · 仅本机");
	assert.ok(!formatHostText(host).includes("本机服务暂时不可用"));
});

test("host-status: managed ready 与等待确认", () => {
	const service = serviceFromManagedRecords([
		{ ownership: "observed", runtime_kind: "vllm", observed_state: "ready" },
		{ ownership: "managed", runtime_kind: "vLLM", observed_state: "ready" },
	]);
	assert.equal(formatServiceText(service), "vLLM 就绪");
	assert.equal(formatTaskText(taskFromFlight({ confirming: true, toolName: "deploy_service" })), COPY.task.awaitingConfirm);
	assert.equal(formatTaskText(taskFromFlight({ toolName: "deploy_service" })), COPY.task.deploying);
	assert.equal(formatTaskText(taskFromFlight({ toolName: "benchmark_service" })), COPY.task.benchmarking);
});

test("host-status: observed 服务不进服务段；空列表是无受管服务", () => {
	assert.equal(formatServiceText(serviceFromManagedRecords(undefined)), COPY.service.unseen);
	assert.equal(formatServiceText(serviceFromManagedRecords([])), COPY.service.none);
	assert.equal(
		formatServiceText(serviceFromManagedRecords([{ ownership: "observed", runtime_kind: "vllm", observed_state: "ready" }])),
		COPY.service.none,
	);
});

test("host-status: GPU 名压缩为 2×H100", () => {
	assert.equal(formatGpuText(["NVIDIA H100 80GB HBM3", "NVIDIA H100 80GB HBM3"]), "2×H100");
});

	test("host-status: 1 个与 3 个 subagent 的页头协作槽", () => {
		assert.equal(formatCollabText([]), "协作 空闲");
		assert.equal(
			formatCollabText([{ id: "1", title: "看日志", phase: "running" }]),
			"看日志",
		);
		assert.equal(
			formatCollabText([
				{ id: "1", title: "a", phase: "running" },
				{ id: "2", title: "b", phase: "running" },
				{ id: "3", title: "c", phase: "running" },
			]),
			"排查中 3/3",
		);
		assert.equal(
			formatCollabText([
				{ id: "1", title: "a", phase: "running" },
				{ id: "2", title: "b", phase: "awaiting_confirm" },
			]),
			"排查 · 等待确认",
		);
		assert.equal(formatCollabText([{ id: "1", title: "a", phase: "done" }]), "排查完成");
		assert.equal(formatCollabText([{ id: "1", title: "a", phase: "failed" }]), "排查未能完成");
	});

		test("host-status: 完成槽保留到下次提交或 8 秒", async (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const store = new HostStatusStore();
			store.setCollab("one", { title: "日志", phase: "done" });
			assert.equal(formatCollabText(store.get().collab), "排查完成");
			t.mock.timers.tick(COLLAB_HOLD_MS - 1);
			assert.equal(formatCollabText(store.get().collab), "排查完成");
			t.mock.timers.tick(1);
			assert.equal(formatCollabText(store.get().collab), "协作 空闲");

			store.setCollab("two", { title: "报告", phase: "done" });
			assert.equal(formatCollabText(store.get().collab), "排查完成");
			store.clearSettledCollab();
			assert.equal(formatCollabText(store.get().collab), "协作 空闲");

			store.setCollab("live", { title: "日志", phase: "running" });
			store.setCollab("done", { title: "报告", phase: "done" });
			store.clearSettledCollab();
			assert.equal(formatCollabText(store.get().collab), "日志");
			assert.equal(store.get().collab.map((slot) => slot.id).join(","), "live");
		});

	test("host-status: core_unavailable 写入本机段，成功 inspect 清掉", () => {
		const local = status({
			host: hostFromDoctor({ gpuNames: ["H100"], docker: "ready" }),
		});
		const down = reduceHostStatus(local, {
			type: "tool_result",
			toolName: "inspect_environment",
			details: { code: "core_unavailable", message: "down" },
		});
		assert.equal(formatHostText(down.host), COPY.host.coreDown);

		const fromDeploy = reduceHostStatus(local, {
			type: "tool_result",
			toolName: "deploy_service",
			details: { code: "core_unavailable" },
		});
		assert.equal(formatHostText(fromDeploy.host), COPY.host.coreDown);

		const recovered = reduceHostStatus(down, {
			type: "tool_result",
			toolName: "inspect_environment",
			details: {
				data: {
					hardware_snapshot: {
						gpus: [{ name: "NVIDIA H100 80GB HBM3" }],
						docker: { daemon: true },
					},
				},
			},
		});
		assert.equal(formatHostText(recovered.host), "H100 · Docker 就绪 · 仅本机");
	});

test("host-status: Core 挂了不是仅本机故障同义", () => {
	const down = hostFromDoctor({ gpuNames: ["H100"], docker: "ready", coreDown: true });
	assert.equal(formatHostText(down), COPY.host.coreDown);
	const local = hostFromDoctor({ gpuNames: ["H100"], docker: "ready" });
	assert.ok(formatHostText(local).includes("仅本机"));
	assert.ok(!formatHostText(local).includes(COPY.host.coreDown));
});

test("host-status: footer 三段宽屏完整、窄屏按服务→任务→本机截断", () => {
	const view = status({
		host: hostFromDoctor({ gpuNames: ["NVIDIA H100 80GB HBM3", "NVIDIA H100 80GB HBM3"], docker: "ready" }),
		service: { kind: "running", engine: "vLLM" },
		task: { kind: "idle" },
	});
	const wide = formatFooterLine(view, 120);
		assert.match(wide, /本机 2×H100 · Docker 就绪 · 仅本机/);
		assert.match(wide, /服务 vLLM 就绪/);
		assert.match(wide, /任务 空闲/);
		assert.ok(!wide.includes("排查"));

		const live = formatFooterLine(
			status({
				host: hostFromDoctor({ gpuNames: ["NVIDIA H100 80GB HBM3", "NVIDIA H100 80GB HBM3"], docker: "ready" }),
				service: { kind: "running", engine: "vLLM" },
				task: { kind: "idle" },
				collab: [
					{ id: "1", title: "日志", phase: "running" },
					{ id: "2", title: "报告", phase: "running" },
				],
			}),
			160,
		);
		assert.match(live, /任务 空闲/);
		assert.match(live, /排查中 2\/3/);
		assert.ok(!formatFooterLine(status({ collab: [{ id: "1", title: "日志", phase: "done" }] }), 160).includes("排查"));

	const dropService = formatFooterLine(view, columnWidth("本机 2×H100 · Docker 就绪 · 仅本机  ·  任务 空闲"));
	assert.ok(!dropService.includes("服务"));
	assert.match(dropService, /本机 2×H100/);
	assert.match(dropService, /任务 空闲/);

	const hostOnly = formatFooterLine(view, 18);
	assert.match(hostOnly, /本机/);
	assert.ok(!hostOnly.includes("服务"));
		assert.equal(columnWidth(hostOnly) <= 18, true);

		const wideLines = formatFooterLines(view, 120);
		assert.equal(wideLines.length, 2);
		assert.equal(wideLines[0], wide);
		assert.equal(wideLines[1], "vLLM 就绪");
		assert.equal(formatFooterLines(view, 80).length, 1);

		const withVram = status({
			host: hostFromDoctor({
				gpuNames: ["NVIDIA GeForce RTX 5090"],
				docker: "ready",
				vramTotal: 32607,
				vramUsed: 8396,
				utilization: 12,
			}),
			service: { kind: "running", engine: "vLLM" },
			task: { kind: "idle" },
		});
			assert.match(formatFooterLines(withVram, 120)[1]!, /vLLM 就绪  ███░░░░░░░  8\.2\/32G  12%/);
			assert.match(formatFooterLines(withVram, 160)[0]!, /RTX 5090 8\.2\/32G  ███░░░░░░░/);
			assert.equal(formatFooterLines(status({ service: { kind: "unseen" } }), 120).length, 1);
	});

test("host-status: compact header 左身份右协作，窄屏先丢产品句", () => {
	const idle = formatCompactHeader({ version: "0.1.0", collab: [], width: 72 });
	assert.match(idle, /BITTUNE  v0.1.0  本机推理工程智能体/);
	assert.match(idle, /协作 空闲/);

	const busy = formatCompactHeader({
		version: "0.1.0",
		collab: [
			{ id: "1", title: "日志", phase: "running" },
			{ id: "2", title: "报告", phase: "running" },
		],
		width: 72,
	});
	assert.match(busy, /排查中 2\/3/);

	const narrow = formatCompactHeader({ version: "0.1.0", collab: [], width: 28 });
	assert.ok(!narrow.includes("本机推理工程智能体"));
	assert.match(narrow, /BITTUNE  v0.1.0/);
});

test("host-status: inspect_environment 成功后本机段改用 GPU 名", () => {
	const next = reduceHostStatus(status(), {
		type: "tool_result",
		toolName: "inspect_environment",
		details: {
			summary: "ok",
			data: {
				hardware_snapshot: {
					gpus: [{ name: "NVIDIA H100 80GB HBM3" }, { name: "NVIDIA H100 80GB HBM3" }],
					docker: { daemon: true },
				},
			},
		},
	});
		assert.equal(formatHostText(next.host), "2×H100 · Docker 就绪 · 仅本机");
		assert.equal(next.host.vramTotal, undefined);
		assert.equal(next.task.kind, "idle");
		assert.equal(next.service.kind, "unseen");
	});

	test("host-status: inspect 投影显存，有数据才画 8.2/32G 和十格条", () => {
		const next = reduceHostStatus(status(), {
			type: "tool_result",
			toolName: "inspect_environment",
			details: {
				data: {
					hardware_snapshot: {
						gpus: [
							{
								name: "NVIDIA GeForce RTX 5090",
								memory_total_bytes: 32607 * 1024 * 1024,
								memory_free_bytes: 24210 * 1024 * 1024,
								utilization_percent: 12,
							},
						],
						docker: { daemon: true },
					},
				},
			},
		});
		assert.equal(next.host.gpuText, "RTX 5090");
		assert.equal(formatVramText(next.host), "8.2/32G");
		assert.match(formatHostText(next.host), /RTX 5090 8\.2\/32G · Docker 就绪/);
		assert.equal(formatVramBar(next.host.vramUsed!, next.host.vramTotal!), "███░░░░░░░");
		assert.equal(next.host.utilization, 12);
		assert.equal(formatVramText({}), undefined);
		assert.equal(formatVramBar(0, 0), "");
	});

test("host-status: deploy_service start 进行中正在部署，完成后服务段为引擎+状态", () => {
	const calling = reduceHostStatus(status(), {
		type: "tool_call",
		toolName: "deploy_service",
		action: "start",
	});
	assert.equal(formatTaskText(calling.task), COPY.task.deploying);

	const done = reduceHostStatus(calling, {
		type: "tool_result",
		toolName: "deploy_service",
		details: {
			data: {
				service: {
					ownership: "managed",
					runtime_spec: { runtime_kind: "vLLM" },
					observed_state: "ready",
				},
			},
		},
	});
	assert.equal(formatTaskText(done.task), COPY.task.idle);
	assert.equal(formatServiceText(done.service), "vLLM 就绪");
});

test("host-status: inspect_service 的 observed 记录不进服务段", () => {
	const next = reduceHostStatus(status(), {
		type: "tool_result",
		toolName: "inspect_service",
		details: {
			data: {
				services: [
					{
						service: { ownership: "observed", runtime_spec: { runtime_kind: "vllm" }, observed_state: "ready" },
						current_container_state: { status: "running", running: true },
					},
				],
			},
		},
	});
	assert.equal(formatServiceText(next.service), COPY.service.none);
});

	test("host-status: 无工具名的确认不改任务段", () => {
		const open = reduceHostStatus(status(), { type: "confirm", open: true });
		assert.equal(formatTaskText(open.task), COPY.task.idle);
		assert.equal(formatTaskText(taskFromFlight({ confirming: true })), COPY.task.idle);
	});

	test("host-status: 确认框弹出任务=等待确认，关闭后恢复正在部署", () => {
	const calling = reduceHostStatus(status(), {
		type: "tool_call",
		toolName: "deploy_service",
		action: "start",
	});
	const open = reduceHostStatus(calling, {
		type: "confirm",
		open: true,
		toolName: "deploy_service",
		action: "start",
	});
	assert.equal(formatTaskText(open.task), COPY.task.awaitingConfirm);
	assert.equal(formatCollabText(open.collab), COPY.collab.idle);

	const closed = reduceHostStatus(open, {
		type: "confirm",
		open: false,
		toolName: "deploy_service",
		action: "start",
	});
	assert.equal(formatTaskText(closed.task), COPY.task.deploying);
});
