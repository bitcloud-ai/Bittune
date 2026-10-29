/**
 * Phase 3 stage 1 regression tests: the confirmation classification of the
 * Runtime policy, the approval skip decision, and the global-only approval
 * setting. Ordinary asks may honor session/global skip; explicit asks
 * (dangerous shell, network/dependency writes, managed lifecycle, uploads)
 * never may.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemorySettingsStorage, SettingsManager } from "../packages/bittune-runtime/src/core/settings-manager.ts";
import { resolveApprovalSkip } from "../packages/bittune-runtime/src/harness/extension.ts";
import { evaluateBash, evaluateGenericCall } from "../packages/bittune-runtime/src/harness/runtime-policy.ts";

const protectedRoots = ["/root/.bittune"] as const;

test("policy: 低影响调查与普通 ask 的分类", () => {
	assert.equal(evaluateBash("nvidia-smi --query-gpu=name", "/work", protectedRoots).decision, "allow");
	// Unknown commands are routine asks and may be skipped.
	const unknown = evaluateBash("./tune.sh", "/work", protectedRoots);
	assert.equal(unknown.decision, "ask");
	assert.equal(unknown.confirmation, "ordinary");
	// File writes outside the workspace are routine asks.
	const fileWrite = evaluateGenericCall({ toolName: "write", path: "/etc/notes.txt", cwd: "/work", protectedRoots });
	assert.equal(fileWrite.decision, "ask");
	assert.equal(fileWrite.confirmation, "ordinary");
});

test("policy: 危险 shell、网络写入和依赖准备是显式确认，永不被跳过", () => {
	const explicit = [
		"docker run -d --gpus all vllm/vllm-openai",
		"curl -s -d 'x=1' https://example.test/upload",
		"npm install express",
		"pip install torch",
		"git push origin main",
		"sudo systemctl restart docker",
		"rm dist/cache.bin",
		"dd if=/dev/zero of=/dev/sdb",
		"sort a.txt | tee /etc/hosts",
		'printf "%s" "$(sudo id)"',
		"echo hi > /etc/cron.d/p",
		"wget https://example.test/model.bin",
	];
	for (const command of explicit) {
		const outcome = evaluateBash(command, "/work", protectedRoots);
		assert.equal(outcome.decision, "ask", `expected ask for: ${command}`);
		assert.equal(outcome.confirmation, "explicit", `expected explicit confirmation for: ${command}`);
	}
});

	test("policy: scout 收紧只读，父表保持 python 与 git fetch allow", () => {
		assert.equal(evaluateBash("python", "/work", protectedRoots).decision, "allow");
		assert.equal(evaluateBash("git fetch", "/work", protectedRoots).decision, "allow");
		assert.equal(evaluateBash("docker ps", "/work", protectedRoots, "scout").decision, "allow");
		assert.equal(evaluateBash("docker info", "/work", protectedRoots, "scout").decision, "allow");
		assert.equal(evaluateBash("nvidia-smi", "/work", protectedRoots, "scout").decision, "allow");
		const python = evaluateBash("python", "/work", protectedRoots, "scout");
		assert.equal(python.decision, "ask");
		assert.equal(python.confirmation, "explicit");
		const fetch = evaluateBash("git fetch", "/work", protectedRoots, "scout");
		assert.equal(fetch.decision, "ask");
		assert.equal(fetch.confirmation, "explicit");
		const pip = evaluateBash("pip install torch", "/work", protectedRoots, "scout");
		assert.equal(pip.decision, "ask");
		assert.equal(pip.confirmation, "explicit");
		const dockerRm = evaluateBash("docker rm abc", "/work", protectedRoots, "scout");
		assert.equal(dockerRm.decision, "ask");
		assert.equal(dockerRm.confirmation, "explicit");
		assert.equal(evaluateBash("rm dist/cache.bin", "/work", protectedRoots, "scout").decision, "deny");
		assert.equal(evaluateBash("rm -rf /usr/local", "/work", protectedRoots, "scout").decision, "deny");
	});

	test("policy: deny 不携带 confirmation 分类", () => {
	const deny = evaluateBash("rm -rf /usr/local", "/work", protectedRoots);
	assert.equal(deny.decision, "deny");
	assert.equal(deny.confirmation, undefined);
	const privateRoot = evaluateBash("cat ~/.bittune/core/bittune.db", "/work", protectedRoots);
	assert.equal(privateRoot.decision, "deny");
});

test("policy: 确认跳过只作用于 ordinary 且仅在有偏好时生效", () => {
	assert.equal(resolveApprovalSkip("ordinary", "ask", false), false);
	assert.equal(resolveApprovalSkip("ordinary", "always_skip", false), true);
	assert.equal(resolveApprovalSkip("ordinary", "always_skip", true), true);
	assert.equal(resolveApprovalSkip("ordinary", "session_skip", true), true);
	assert.equal(resolveApprovalSkip("ordinary", "session_skip", false), false);
	assert.equal(resolveApprovalSkip("ordinary", undefined, true), false);
	// Explicit asks are never skipped, whatever the preference.
	assert.equal(resolveApprovalSkip("explicit", "always_skip", true), false);
	// allow/deny never pass through the skip path.
	assert.equal(resolveApprovalSkip(undefined, "always_skip", true), false);
});

test("policy settings: 确认偏好默认为 ask，写入全局文件并可恢复", async () => {
	const manager = SettingsManager.inMemory();
	assert.equal(manager.getApprovalMode(), "ask");
	manager.setApprovalMode("always_skip");
	await manager.flush();
	const reloaded = SettingsManager.inMemory({
		harness: { approvalMode: "always_skip" },
	});
	assert.equal(reloaded.getApprovalMode(), "always_skip");
	reloaded.setApprovalMode("ask");
	await reloaded.flush();
	assert.equal(reloaded.getApprovalMode(), "ask");
});

test("policy settings: session_skip 只属于会话内存，落入文件时回退为 ask", () => {
	// The extension stores session skip in memory only; a hand-edited file
	// carrying session_skip must not make future sessions skip.
	const manager = SettingsManager.inMemory({ harness: { approvalMode: "session_skip" } });
	assert.equal(manager.getApprovalMode(), "ask");
	const corrupt = SettingsManager.inMemory({});
	assert.equal(corrupt.getApprovalMode(), "ask");
});

test("policy settings: 项目设置永远不能覆盖全局确认偏好", () => {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () => JSON.stringify({ harness: { approvalMode: "always_skip" } }));
	storage.withLock("project", () => JSON.stringify({ harness: { approvalMode: "ask" } }));
	const manager = SettingsManager.fromStorage(storage);
	assert.equal(manager.getApprovalMode(), "always_skip");
});

test("runtime: 确认跳过后 ex、危险场景仍逐一核对", () => {
	const blocked = evaluateBash("echo x | sudo tee /etc/hosts", "/work", protectedRoots);
	assert.equal(blocked.confirmation, "explicit");
	assert.equal(resolveApprovalSkip(blocked.confirmation, "always_skip", false), false);
});