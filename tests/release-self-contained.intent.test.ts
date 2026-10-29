import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentPayloadComplete } from "../packages/bittune-runtime/src/cli/install/components.ts";

/** Phase 6 will enforce these layout facts. Phase 0 only freezes the intent. */
export const PHASE5_RELEASE_LAYOUT = {
	bundle: "dist/bittune.js",
	skills: "skills/",
	photonVendorDir: "dist/node_modules/@silvia-odwyer/photon-node",
	photonJs: "dist/node_modules/@silvia-odwyer/photon-node/photon_rs.js",
	photonWasm: "dist/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
	forbiddenRootWasm: "dist/photon_rs_bg.wasm",
} as const;

test("发行完全体基线意图：photon 整包 vendor，wasm 与 photon_rs.js 同目录", () => {
	assert.equal(PHASE5_RELEASE_LAYOUT.photonJs, `${PHASE5_RELEASE_LAYOUT.photonVendorDir}/photon_rs.js`);
	assert.equal(PHASE5_RELEASE_LAYOUT.photonWasm, `${PHASE5_RELEASE_LAYOUT.photonVendorDir}/photon_rs_bg.wasm`);
	assert.notEqual(PHASE5_RELEASE_LAYOUT.photonWasm, PHASE5_RELEASE_LAYOUT.forbiddenRootWasm);
		assert.equal(PHASE5_RELEASE_LAYOUT.skills, "skills/");
		assert.equal(PHASE5_RELEASE_LAYOUT.bundle, "dist/bittune.js");
	});

	test("安装器载荷门：detect/adopt/extract 都要求 skills 与 photon", () => {
		const root = mkdtempSync(join(tmpdir(), "bittune-payload-"));
		try {
			assert.equal(agentPayloadComplete(root), false);
			mkdirSync(join(root, "dist"), { recursive: true });
			writeFileSync(join(root, "package.json"), "{}");
			writeFileSync(join(root, "dist", "bittune.js"), "console.log(1)");
			assert.equal(agentPayloadComplete(root), false);
			const photon = join(root, "dist", "node_modules", "@silvia-odwyer", "photon-node");
			mkdirSync(photon, { recursive: true });
			writeFileSync(join(photon, "photon_rs.js"), "module.exports = {}");
			writeFileSync(join(photon, "photon_rs_bg.wasm"), "wasm");
			assert.equal(agentPayloadComplete(root), false);
			mkdirSync(join(root, "skills"), { recursive: true });
			assert.equal(agentPayloadComplete(root), false);
			writeFileSync(join(root, "skills", "prepare-model.md"), "# skill");
			assert.equal(agentPayloadComplete(root), true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
