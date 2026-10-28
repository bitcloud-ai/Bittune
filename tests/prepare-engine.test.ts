import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";

test("engine preparation passes an exact approved reference to Docker and rejects other repositories", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "bittune-prepare-"));
	try {
		const record = join(root, "args");
		await writeFile(join(root, "docker"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$BITTUNE_TEST_DOCKER_ARGS"\n', { mode: 0o755 });
		const script = resolve("packages/bittune-runtime/skills/prepare-engine/scripts/prepare-engine.sh");
		const env = { ...process.env, PATH: root + delimiter + process.env.PATH, BITTUNE_TEST_DOCKER_ARGS: record };
		const reference = `vllm/vllm-openai@sha256:${"a".repeat(64)}`;
		const valid = spawnSync("sh", [script, "vllm", reference], { env, encoding: "utf8" });
		assert.equal(valid.status, 0, valid.stderr);
		assert.equal(await readFile(record, "utf8"), `pull\n${reference}\n`);
		await rm(record);
		for (const invalid of [`other/repo@sha256:${"a".repeat(64)}`, "vllm/vllm-openai:latest", `vllm/vllm-openai@sha256:${"0".repeat(64)}`]) {
			const result = spawnSync("sh", [script, "vllm", invalid], { env, encoding: "utf8" });
			assert.equal(result.status, 2, invalid);
			assert.equal(existsSync(record), false, "Invalid reference reached Docker");
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
