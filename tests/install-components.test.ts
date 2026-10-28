import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	agentMarkerSatisfied,
	coreMarkerSatisfied,
	resolveIncomingAgentDistSha,
	type InstallContext,
} from "../packages/bittune-runtime/src/cli/install/components.ts";

const sha = (content: string): string => createHash("sha256").update(content).digest("hex");

function makeMarker(over: Partial<{ version: string; dist_sha256: string; core_wheel_sha256: string }> = {}): Parameters<typeof agentMarkerSatisfied>[0] {
	return { version: "0.1.0", dist_sha256: sha("installed"), ...over };
}

function makeContext(over: Partial<InstallContext>): InstallContext {
	return {
		installRoot: join(over.payloadPath ?? "/tmp", "..", "opt"),
		targetUser: "root",
		sourceKind: "bundle",
		payloadPath: "",
		appendLog: () => undefined,
		...over,
	};
}

test("agentMarkerSatisfied：marker、已装字节、入包字节三方必须一致", () => {
	const installed = sha("installed");
	assert.equal(agentMarkerSatisfied(undefined, installed, installed, "0.1.0"), false);
	assert.equal(agentMarkerSatisfied(makeMarker(), installed, installed, "0.1.0"), true);
	// 同版本重打包：入包哈希不同 -> 必须重装（用户报告的静默跳过场景）
	assert.equal(agentMarkerSatisfied(makeMarker(), installed, sha("rebuilt"), "0.1.0"), false);
	// 版本升级 -> 重装
	assert.equal(agentMarkerSatisfied(makeMarker(), installed, installed, "0.2.0"), false);
	// 已装文件被改动：marker 与已装不符 -> 重装
	assert.equal(agentMarkerSatisfied(makeMarker(), sha("tampered"), installed, "0.1.0"), false);
});

test("coreMarkerSatisfied：已装版本与记录 wheel 哈希必须与入包一致", () => {
	const wheelSha = sha("wheel-v2");
	assert.equal(coreMarkerSatisfied(undefined, wheelSha, true), false);
	assert.equal(coreMarkerSatisfied(makeMarker({ core_wheel_sha256: wheelSha }), wheelSha, true), true);
	assert.equal(coreMarkerSatisfied(makeMarker({ core_wheel_sha256: sha("wheel-v1") }), wheelSha, true), false);
	assert.equal(coreMarkerSatisfied(makeMarker({ core_wheel_sha256: wheelSha }), wheelSha, false), false);
});

test("resolveIncomingAgentDistSha bundle 模式直接哈希离线包内的 dist", async () => {
	const root = await mkdtemp(join(tmpdir(), "bittune-install-"));
	try {
		const distDir = join(root, "bundle", "agent", "dist");
		await mkdir(distDir, { recursive: true });
		const content = `bundled bittune dist ${Math.random()}`;
		await writeFile(join(distDir, "bittune.js"), content);
		const ctx = makeContext({ sourceKind: "bundle", payloadPath: join(root, "bundle"), installRoot: join(root, "opt") });
		assert.equal(await resolveIncomingAgentDistSha(ctx), sha(content));
		assert.equal(ctx.incomingAgentDistSha, sha(content), "digest 必须被记忆到 ctx");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("resolveIncomingAgentDistSha network 模式从 tgz 提取 package/dist/bittune.js 再哈希", async () => {
	const root = await mkdtemp(join(tmpdir(), "bittune-install-"));
	try {
		const payloadDir = join(root, "payload");
		await mkdir(join(payloadDir, "package", "dist"), { recursive: true });
		const content = `tgz bittune dist ${Math.random()}`;
		await writeFile(join(payloadDir, "package", "dist", "bittune.js"), content);
		const archive = join(root, "payload.tar.gz");
		execFileSync(process.platform === "win32" ? "tar.exe" : "tar", ["-czf", "payload.tar.gz", "-C", "payload", "package"], { cwd: root });
		const ctx = makeContext({ sourceKind: "network", payloadPath: archive, installRoot: join(root, "opt") });
		assert.equal(await resolveIncomingAgentDistSha(ctx), sha(content));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});