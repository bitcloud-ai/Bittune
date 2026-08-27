import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBittuneCliArguments } from "../packages/bittune-runtime/src/cli/bittune-args.ts";

test("a session resume accepts an initial message", () => {
	const invocation = parseBittuneCliArguments(["--session", "01a040b8-ddd7-7e4f-91f4-c4e025308840", "继续上一轮调优"]);
	assert.equal(invocation.kind, "interactive");
	assert.equal(invocation.sessionId, "01a040b8-ddd7-7e4f-91f4-c4e025308840");
	assert.equal(invocation.message, "继续上一轮调优");
});

test("an initial message still works without a session id", () => {
	const invocation = parseBittuneCliArguments(["检查 GPU 并汇报"]);
	assert.equal(invocation.kind, "interactive");
	assert.equal(invocation.sessionId, undefined);
	assert.equal(invocation.message, "检查 GPU 并汇报");
});

test("a fresh experiment cannot resume a persisted session", () => {
	assert.throws(
		() => parseBittuneCliArguments(["--fresh", "--session", "01a040b8-ddd7-7e4f-91f4-c4e025308840"]),
		/fresh experiment cannot resume/,
	);
});

test("install parses staged installer flags", () => {
	const invocation = parseBittuneCliArguments(["install", "--package", "/tmp/b.tgz", "--user", "ops", "--yes", "--json"]);
	assert.equal(invocation.kind, "install");
	if (invocation.kind !== "install") return;
	assert.equal(invocation.options.checkOnly, false);
	assert.equal(invocation.options.yes, true);
	assert.equal(invocation.options.json, true);
	assert.equal(invocation.options.packagePath, "/tmp/b.tgz");
	assert.equal(invocation.options.user, "ops");
});

test("install check-only does not require a payload", () => {
	const invocation = parseBittuneCliArguments(["install", "--check-only"]);
	assert.equal(invocation.kind, "install");
	if (invocation.kind !== "install") return;
	assert.equal(invocation.options.checkOnly, true);
});

test("install rejects positional payloads and unknown flags", () => {
	assert.throws(() => parseBittuneCliArguments(["install", "/tmp/b.tgz"]), /Unknown option/);
	assert.throws(() => parseBittuneCliArguments(["install", "--wat"]), /Unknown option/);
});
