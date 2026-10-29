import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BANNER_ART, COPY, PRODUCT_TAGLINE, PRODUCT_WORDMARK } from "../packages/bittune-runtime/src/harness/tui/copy.ts";
import { decideBannerMode, renderBanner } from "../packages/bittune-runtime/src/harness/tui/banner.ts";
import { bindManagedHostPulse, gpuNamesFromNvidiaSmi, gpusFromNvidiaSmi } from "../packages/bittune-runtime/src/harness/tui/host-pulse.ts";
import {
	createIdleHostStatus,
		formatFooterLine,
		formatHostText,
		hostFromDoctor,
	HostStatusStore,
} from "../packages/bittune-runtime/src/harness/tui/host-status.ts";
import { paintFooterLine, paintFooterRule, StatusBarComponent } from "../packages/bittune-runtime/src/harness/tui/status-bar.ts";

const FORBIDDEN = ["Tool observations", "minimal coding agent", "↑", "CH", "Welcome to bittune"];

function idle() {
	return createIdleHostStatus();
}

test("banner: 宽屏先看到块字标和产品句，没有快捷键表", () => {
	const lines = renderBanner({ mode: "wide", status: idle(), version: "0.1.0", width: 80 });
	assert.equal(lines[0], BANNER_ART[0]);
	assert.ok(lines.includes(PRODUCT_TAGLINE));
	assert.ok(lines.some((line) => line.includes(COPY.probing)));
	assert.ok(lines.some((line) => line.includes("v0.1.0")));
	assert.equal(lines.length, BANNER_ART.length + 2);
	const joined = lines.join("\n");
	for (const banned of FORBIDDEN) assert.ok(!joined.includes(banned), banned);
	assert.ok(!joined.includes("ctrl+"));
});

test("banner: 窄屏三行 BITTUNE + 产品句 + 脉搏；安静启动是紧凑身份行", () => {
	assert.equal(decideBannerMode({ compact: false, width: 80 }), "wide");
	assert.equal(decideBannerMode({ compact: false, width: 40 }), "narrow");
	assert.equal(decideBannerMode({ compact: false, width: 80, term: "dumb" }), "narrow");
	assert.equal(decideBannerMode({ compact: true, width: 80 }), "compact");

	const narrow = renderBanner({ mode: "narrow", status: idle(), version: "0.1.0", width: 40 });
	assert.deepEqual(narrow, [PRODUCT_WORDMARK, PRODUCT_TAGLINE, `${COPY.probing} · ${COPY.host.local}`]);

		const compact = renderBanner({ mode: "compact", status: idle(), version: "0.1.0", width: 72 });
		assert.equal(compact.length, 1);
		assert.match(compact[0]!, /BITTUNE  v0.1.0  本机推理工程智能体/);
		assert.match(compact[0]!, /协作 空闲/);
	});

	test("banner: 紧凑页头 live 协作灯按上色后宽度对齐，不撑破终端", () => {
		const paint = {
			wordmark: (text: string) => text,
			tagline: (text: string) => text,
			pulse: (text: string) => text,
			version: (text: string) => text,
			local: (text: string) => text,
			collab: (text: string) => text,
		};
		const live = {
			...idle(),
			collab: [
				{ id: "1", title: "查 docker", phase: "running" as const },
				{ id: "2", title: "查硬件", phase: "running" as const },
			],
		};
		const line = renderBanner({
			mode: "compact",
			status: live,
			version: "0.1.0",
			width: 168,
			paint,
			pulse: "●",
		})[0]!;
		assert.ok(visibleWidth(line) <= 168, `compact header ${visibleWidth(line)} > 168: ${line}`);
		assert.match(line, /● 排查中 2\/3/);
		assert.match(line, /BITTUNE  v0.1.0  本机推理工程智能体/);
	});

	test("status-bar: 默认三段本机/服务/任务，空闲协作不进页脚", () => {
		const line = formatFooterLine(idle(), 120);
		assert.match(line, /本机 正在查看本机…/);
		assert.match(line, /服务 未查看服务/);
		assert.match(line, /任务 空闲/);
		assert.ok(!line.includes("协作"));
		assert.ok(!line.includes("排查"));
		assert.ok(!line.includes("↑"));
		assert.ok(!line.includes("CH"));

		const ready = formatFooterLine(
			{
				host: hostFromDoctor({ gpuNames: ["NVIDIA H100 80GB HBM3", "NVIDIA H100 80GB HBM3"], docker: "ready" }),
				service: { kind: "unseen" },
				task: { kind: "idle" },
				collab: [],
			},
			120,
		);
		assert.match(ready, /本机 2×H100 · Docker 就绪 · 仅本机/);
		assert.match(ready, /服务 未查看服务/);
		assert.match(ready, /任务 空闲/);

		const live = formatFooterLine(
			{
				host: hostFromDoctor({
					gpuNames: ["NVIDIA GeForce RTX 5090"],
					docker: "ready",
					vramTotal: 32607,
					vramUsed: 512,
				}),
				service: { kind: "unseen" },
				task: { kind: "idle" },
				collab: [
					{ id: "1", title: "查 docker", phase: "running" },
					{ id: "2", title: "查硬件", phase: "running" },
				],
			},
			160,
		);
		assert.match(live, /任务 空闲/);
		assert.match(live, /排查中 2\/3/);
		assert.match(live, /RTX 5090 0\.5\/32G  /);
		assert.match(live, /[█░]{10}/);
	});

	test("status-bar: 就绪 success，空闲 dim，忙 accent，挂 error", () => {
		const theme = {
			fg(color: string, text: string) {
				return `<${color}>${text}</${color}>`;
			},
		};
				const idle = paintFooterLine("本机 2×H100 · Docker 就绪 · 仅本机  ·  服务 未查看服务  ·  任务 空闲", theme);
				assert.match(idle, /<success>●<\/success> 本机 <success>2×H100<\/success>/);
				assert.match(idle, /<success>● Docker 就绪<\/success>/);
				assert.match(idle, /<dim>○ 仅本机<\/dim>/);
				assert.match(idle, /<dim>○<\/dim> 服务 <dim>未查看服务<\/dim>/);
				assert.match(idle, /<dim>○<\/dim> 任务 <dim>空闲<\/dim>/);

				const busy = paintFooterLine("本机 2×H100 · Docker 就绪  ·  服务 vLLM 就绪  ·  任务 正在压测", theme);
				assert.match(busy, /<success>就绪<\/success>/);
				assert.match(busy, /<accent>正在压测<\/accent>/);
				assert.match(
					paintFooterLine("本机 2×H100 · Docker 就绪  ·  服务 vLLM 就绪  ·  任务 正在压测", theme, { pulse: "●" }),
					/<accent>●<\/accent> 任务 <accent>正在压测<\/accent>/,
				);
				assert.match(
					paintFooterLine("本机 2×H100 · Docker 就绪  ·  服务 vLLM 未就绪  ·  任务 空闲", theme),
					/<error>●<\/error> 服务 vLLM <error>未就绪<\/error>/,
				);
				assert.match(
					paintFooterLine("本机 本机服务暂时不可用  ·  服务 未查看服务  ·  任务 空闲", theme),
					/<error>●<\/error> 本机 <error>本机服务暂时不可用<\/error>/,
				);
				assert.match(
					paintFooterLine("本机 2×H100 · Docker 就绪 · 仅本机  ·  服务 未查看服务  ·  任务 空闲  ·  排查中 2/3", theme, {
						pulse: "◉",
					}),
					/<accent>◉<\/accent> <accent>排查中<\/accent> 2\/3/,
				);
			assert.equal(paintFooterRule(4, theme), "<borderMuted>────</borderMuted>");
		});

		test("status-bar: footer 顶一条分隔，空闲不脉冲", () => {
			const theme = {
				fg(color: string, text: string) {
					return `<${color}>${text}</${color}>`;
				},
			};
			const store = new HostStatusStore();
			const tui = { requestRender() {} };
			const bar = new StatusBarComponent(tui as never, theme as never, store);
				try {
					const lines = bar.render(40);
					assert.equal(lines.length, 2);
					assert.equal(lines[0], paintFooterRule(40, theme));
					assert.ok(lines[1]!.includes("○"));
					assert.ok(!lines[1]!.includes("◉"));
				} finally {
				bar.dispose();
			}
		});

		test("status-bar: 上色后的页脚不超出终端宽度", () => {
			const theme = {
				fg(_color: string, text: string) {
					return `\x1b[32m${text}\x1b[39m`;
				},
			};
			const store = new HostStatusStore();
			const tui = { requestRender() {} };
			const bar = new StatusBarComponent(tui as never, theme as never, store);
			try {
				store.setCollab("one", { title: "查 docker", phase: "running" });
				store.setCollab("two", { title: "查硬件", phase: "running" });
				store.patch({
					host: hostFromDoctor({
						gpuNames: ["NVIDIA GeForce RTX 5090"],
						docker: "ready",
						vramTotal: 32607,
						vramUsed: 512,
					}),
				});
					for (const width of [40, 168]) {
						const painted = bar.render(width);
						for (const line of painted) {
							assert.ok(visibleWidth(line) <= width, `footer ${visibleWidth(line)} > ${width}: ${line}`);
						}
					}
					const wide = bar.render(168)[1]!;
					assert.match(wide, /排查中/);
					assert.match(wide, /2\/3/);
			} finally {
				bar.dispose();
			}
		});

	test("host-pulse: nvidia-smi 输出按行取 GPU 名；空输出是无 GPU", () => {
		assert.deepEqual(gpuNamesFromNvidiaSmi("NVIDIA H100 80GB HBM3\nNVIDIA H100 80GB HBM3\n"), [
			"NVIDIA H100 80GB HBM3",
			"NVIDIA H100 80GB HBM3",
		]);
		assert.deepEqual(gpuNamesFromNvidiaSmi("   \n"), []);
	});

	test("host-pulse: nvidia-smi 带显存列时投影总量与占用，缺列不编造", () => {
		assert.deepEqual(gpusFromNvidiaSmi("NVIDIA GeForce RTX 5090, 32607, 8396, 12"), [
			{ name: "NVIDIA GeForce RTX 5090", vramTotal: 32607, vramUsed: 8396, utilization: 12 },
		]);
		assert.deepEqual(gpusFromNvidiaSmi("NVIDIA H100 80GB HBM3"), [{ name: "NVIDIA H100 80GB HBM3" }]);
		const host = hostFromDoctor({
			gpuNames: ["NVIDIA GeForce RTX 5090"],
			docker: "ready",
			vramTotal: 32607,
			vramUsed: 8396,
			utilization: 12,
		});
		assert.match(formatHostText(host), /RTX 5090 8\.2\/32G/);
	});

	test("host-pulse: 仅受管 running 才周期性刷新显存，空闲不查 nvidia-smi", async () => {
		const store = new HostStatusStore();
		let calls = 0;
		const stop = bindManagedHostPulse(store, {
			intervalMs: 20,
			probe: async () => {
				calls += 1;
				return [{ name: "NVIDIA GeForce RTX 5090", vramTotal: 32607, vramUsed: 8396, utilization: 12 }];
			},
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(calls, 0);
			store.patch({ service: { kind: "running", engine: "vLLM" } });
			await new Promise((resolve) => setTimeout(resolve, 55));
			assert.ok(calls >= 1);
			assert.match(formatHostText(store.get().host), /RTX 5090 8\.2\/32G/);
			const after = calls;
			store.patch({ service: { kind: "unseen" } });
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(calls, after);
		} finally {
			stop();
		}
	});

test("HostStatusStore: patch 后订阅者收到新状态", () => {
	const store = new HostStatusStore();
	const seen: string[] = [];
	store.subscribe((status) => seen.push(status.host.gpuText));
	store.patch({ host: hostFromDoctor({ gpuNames: ["H100"], docker: "ready" }) });
	assert.equal(store.get().service.kind, "unseen");
	assert.equal(store.get().task.kind, "idle");
	assert.equal(store.get().collab.length, 0);
	assert.equal(seen.at(-1), "H100");
});
