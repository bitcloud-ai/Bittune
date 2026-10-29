import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const npmCli = process.env.npm_execpath;
const npmInvocation = npmCli ? [process.execPath, [npmCli, "pack", "--dry-run", "--json"]] : [npmCommand, ["pack", "--dry-run", "--json"]];
const packed = JSON.parse(
	execFileSync(npmInvocation[0], npmInvocation[1], {
		encoding: "utf8",
		shell: process.platform === "win32" && !npmCli,
	}),
)[0];
const paths = packed.files.map(({ path }) => path).sort();
const requiredPaths = [
	"LICENSE",
	"README.en.md",
	"README.md",
	"ROADMAP.en.md",
	"ROADMAP.md",
	"THIRD_PARTY_NOTICES.md",
	"dist/bittune.js",
	"dist/modes/interactive/theme/dark.json",
	"dist/modes/interactive/theme/light.json",
	"dist/skills/prepare-engine/SKILL.md",
	"dist/skills/prepare-engine/scripts/prepare-engine.sh",
	"dist/skills/prepare-model/SKILL.md",
	"dist/skills/prepare-model/scripts/prepare-model.sh",
	"dist/node_modules/@silvia-odwyer/photon-node/package.json",
	"dist/node_modules/@silvia-odwyer/photon-node/photon_rs.js",
	"dist/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
	"guide/README.md",
	"guide/benchmark-contract.md",
	"guide/task-scope-and-reporting.md",
	"guide/examples/m1-profile-v2.json",
	"guide/getting-started.md",
	"guide/operations.md",
	"install/bootstrap.sh",
	"install/build-offline-bundle.sh",
	"install/offline-manifest.env",
	"install/requirements.txt",
	"install/core-requirements.txt",
	"package.json",
];
const allowedPrefixes = ["dist/skills/", "dist/node_modules/@silvia-odwyer/photon-node/"];

for (const required of requiredPaths) {
	if (!paths.includes(required)) {
		throw new Error(`Release package is missing required file: ${required}\nActual: ${paths.join(", ")}`);
	}
}
const unexpected = paths.filter(
	(path) => !requiredPaths.includes(path) && !allowedPrefixes.some((prefix) => path.startsWith(prefix)),
);
if (unexpected.length > 0) {
	throw new Error("Unexpected release package contents:\n" + unexpected.join("\n"));
}
if (paths.includes("dist/photon_rs_bg.wasm")) {
	throw new Error("Photon wasm must sit beside photon_rs.js in the vendor tree, not at dist/.");
}
if (packageJson.bin?.bittune !== "dist/bittune.js" || Object.keys(packageJson.bin ?? {}).length !== 1) {
	throw new Error("Release package must expose exactly the Bittune CLI entrypoint.");
}
if (packageJson.piConfig || packageJson.name !== "@bittune/runtime") {
	throw new Error("Release package contains an upstream product configuration surface.");
}

const forbiddenAisim = /aisimulate|aisim-service/i;
for (const packedPath of paths) {
	if (forbiddenAisim.test(packedPath)) {
		throw new Error(`Release package must not contain aisim: ${packedPath}`);
	}
}
const installerRequirements = await readFile("install/requirements.txt", "utf8");
if (forbiddenAisim.test(installerRequirements)) {
	throw new Error("install/requirements.txt must not pin the aisimulate wheel.");
}

const installSources = [
	"install/bootstrap.sh",
	"install/build-offline-bundle.sh",
	"packages/bittune-runtime/src/cli/install/components.ts",
];
for (const file of installSources) {
	const text = await readFile(file, "utf8");
	if (/\bnpm\s+(install|ci)\b/.test(text)) {
		throw new Error(`${file} still installs agent dependencies with npm.`);
	}
}

const help = execFileSync(process.execPath, [resolve("dist/bittune.js"), "--help"], { encoding: "utf8" });
if (!/\bBittune\b/.test(help) || /\bpi\b/i.test(help)) {
	throw new Error("Bittune help contains an unexpected product surface:\n" + help);
}

const version = execFileSync(process.execPath, [resolve("dist/bittune.js"), "version"], { encoding: "utf8" });
if (!/\bBittune\b/.test(version)) {
	throw new Error("Bittune version did not print a product version:\n" + version);
}

// The release bundle must not carry the pre-Harness domain surface: no legacy
// tool names, no Node-side SQLite, no capabilities package imports.
const bundle = await readFile(resolve("dist/bittune.js"), "utf8");
const forbiddenSymbols = ["list_deployment_presets", "run_performance_test", "createToolRegistry", "bittune.db", "bittune-capabilities", "createMcpTools"];
for (const symbol of forbiddenSymbols) {
	if (bundle.includes(symbol)) throw new Error(`Release bundle contains a legacy symbol: ${symbol}`);
}

try {
	execFileSync(process.execPath, [resolve("dist/bittune.js"), "--session-dir", "/tmp/unsupported"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	throw new Error("Unsupported --session-dir unexpectedly succeeded.");
} catch (error) {
	if (!(error && typeof error === "object" && "status" in error && error.status !== 0)) {
		throw error;
	}
	const output = String(error.stdout ?? "") + "\n" + String(error.stderr ?? "");
	if (!/Unknown option|Bittune/i.test(output) || /pi-coding-agent|pi\.dev/i.test(output)) {
		throw new Error("Unsupported option did not produce a Bittune-only error:\n" + output);
	}
}

console.log("Release boundary passed for " + packed.id + ": " + paths.length + " files.");
