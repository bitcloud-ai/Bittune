import assert from "node:assert/strict";
import { test } from "node:test";
import { formatInstallFailure, INSTALL_ROOT, type InstallReport } from "../packages/bittune-runtime/src/cli/install/runner.ts";

function failingReport(): InstallReport {
	return {
		mode: "install",
		installRoot: INSTALL_ROOT,
		environment: [],
		preflight: [],
		plan: [],
		executed: [{ id: "node-runtime", label: "Node.js runtime", status: "failed", summary: "下载 Node.js 失败" }],
		verification: [],
		warnings: [],
		failure: {
			step: 2,
			componentId: "node-runtime",
			label: "Node.js runtime",
			message: "下载 Node.js 失败：Could not resolve host: nodejs.org",
			advice: "无法访问 nodejs.org；检查网络或代理，或改用离线包安装。",
			logPath: "/opt/bittune/install.log",
			retryCommand: "sudo ./bittune-bootstrap.sh --package /tmp/b.tgz ops --yes",
		},
	};
}

test("failure protocol states step, cause, advice, log and idempotent retry", () => {
	const text = formatInstallFailure(failingReport());
	assert.match(text, /^✗ 步骤 \[2\] Node\.js runtime 失败：/);
	assert.match(text, /建议：.*nodejs\.org/);
	assert.match(text, /完整日志：\/opt\/bittune\/install\.log/);
	assert.match(text, /重试：.*--package \/tmp\/b\.tgz ops --yes/);
	assert.match(text, /幂等，已完成组件会自动跳过/);
});

test("the failure renderer never loses the original message", () => {
	const report = failingReport();
	report.failure!.message = "SHA-256 校验失败（实际 abc123）。";
	const text = formatInstallFailure(report);
	assert.ok(text.includes("SHA-256 校验失败"));
});
