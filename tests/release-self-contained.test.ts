import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distBundle = join(repoRoot, "dist", "bittune.js");
const photonVendor = join(repoRoot, "dist", "node_modules", "@silvia-odwyer", "photon-node");
const distSkills = join(repoRoot, "dist", "skills");
const coreSrc = join(repoRoot, "packages", "bittune-core", "src");

const INSTALL_SOURCES = [
	"install/bootstrap.sh",
	"install/build-offline-bundle.sh",
	"packages/bittune-runtime/src/cli/install/components.ts",
];

function spawnCaptured(
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`timed out:\n${stdout}\n${stderr}`));
		}, options.timeoutMs ?? 90_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ code, stdout, stderr });
		});
	});
}

function listen(server: Server): Promise<number> {
	return new Promise((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("test server did not expose a TCP port"));
				return;
			}
			resolveListen(address.port);
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
}

async function configureAgent(home: string, port: number): Promise<void> {
	const agent = join(home, "agent");
	await mkdir(agent, { recursive: true });
	await writeFile(
		join(agent, "models.json"),
		JSON.stringify({
			providers: {
				"bittune-test": {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "$BITTUNE_TEST_API_KEY",
					authHeader: true,
					models: [{ id: "test-agent-model", input: ["text"], reasoning: false }],
				},
			},
		}),
	);
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({ defaultProvider: "bittune-test", defaultModel: "test-agent-model" }),
	);
	await writeFile(join(agent, "bittune-runtime.json"), `${JSON.stringify({ schema_version: 1 })}\n`);
}

test("发行完全体：空目录 spawn dist 过解析 / 装配 / 会话三层门，安装脚本零 npm", async () => {
	assert.equal(existsSync(distBundle), true, "dist/bittune.js is missing; npm test should have built the shell first");
	assert.equal(existsSync(join(photonVendor, "photon_rs.js")), true);
	assert.equal(existsSync(join(photonVendor, "photon_rs_bg.wasm")), true);
	assert.equal(existsSync(join(distSkills, "prepare-model", "SKILL.md")), true);
	assert.equal(existsSync(join(repoRoot, "dist", "photon_rs_bg.wasm")), false);

	for (const file of INSTALL_SOURCES) {
		const text = await readFile(join(repoRoot, file), "utf8");
		assert.equal(/\bnpm\s+(install|ci)\b/.test(text), false, `${file} still mentions npm install`);
	}

	const sandbox = await mkdtemp(join(tmpdir(), "bittune-release-sandbox-"));
	const home = await mkdtemp(join(tmpdir(), "bittune-release-home-"));
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk.toString();
		});
		request.on("end", () => {
			const payload = JSON.parse(body || "{}") as { messages?: Array<{ role?: string }> };
			const hasTool = (payload.messages ?? []).some((message) => message.role === "tool");
			response.writeHead(200, {
				"content-type": "text/event-stream",
				connection: "keep-alive",
				"cache-control": "no-cache",
			});
			if (!hasTool) {
				response.write(
					'data: {"id":"release-read","object":"chat.completion.chunk","created":1,"model":"test-agent-model","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call-read-note","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"note.txt\\"}"}}]},"finish_reason":null}]}\n\n',
				);
				response.write(
					'data: {"id":"release-read","object":"chat.completion.chunk","created":1,"model":"test-agent-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
				);
			} else {
				response.write(
					'data: {"id":"release-done","object":"chat.completion.chunk","created":1,"model":"test-agent-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Release session read note.txt."},"finish_reason":null}]}\n\n',
				);
				response.write(
					'data: {"id":"release-done","object":"chat.completion.chunk","created":1,"model":"test-agent-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
				);
			}
			response.end("data: [DONE]\n\n");
		});
	});
	try {
		const port = await listen(server);
		await mkdir(join(sandbox, "dist", "node_modules", "@silvia-odwyer"), { recursive: true });
		await cp(distBundle, join(sandbox, "dist", "bittune.js"));
		await cp(photonVendor, join(sandbox, "dist", "node_modules", "@silvia-odwyer", "photon-node"), { recursive: true });
		await cp(distSkills, join(sandbox, "dist", "skills"), { recursive: true });
		await mkdir(join(sandbox, "dist", "modes", "interactive", "theme"), { recursive: true });
		await cp(
			join(repoRoot, "dist", "modes", "interactive", "theme"),
			join(sandbox, "dist", "modes", "interactive", "theme"),
			{ recursive: true },
		);
		await cp(join(repoRoot, "package.json"), join(sandbox, "package.json"));
		await writeFile(join(sandbox, "note.txt"), "self-contained release note\n");
		await configureAgent(home, port);

		const env: NodeJS.ProcessEnv = {
			...process.env,
			BITTUNE_HOME: home,
			BITTUNE_TEST_API_KEY: "test-key",
			BITTUNE_CORE_MODULE_PATHS: coreSrc,
			BITTUNE_HEADLESS: "1",
		};
		delete env.NODE_PATH;

		const bundle = join(sandbox, "dist", "bittune.js");

		const help = await spawnCaptured(process.execPath, [bundle, "--help"], { cwd: sandbox, env, timeoutMs: 20_000 });
		assert.equal(help.code, 0, help.stderr);
		assert.match(help.stdout, /\bBittune\b/);
		assert.doesNotMatch(help.stdout, /\bpi\b/i);

		const version = await spawnCaptured(process.execPath, [bundle, "version"], { cwd: sandbox, env, timeoutMs: 20_000 });
		assert.equal(version.code, 0, version.stderr);
		assert.match(version.stdout, /\bBittune\b/);

		const doctor = await spawnCaptured(process.execPath, [bundle, "doctor"], { cwd: sandbox, env, timeoutMs: 90_000 });
		const doctorOut = `${doctor.stdout}\n${doctor.stderr}`;
		assert.match(doctorOut, /Runtime assembled:/, doctorOut);
		assert.doesNotMatch(doctorOut, /Runtime assembled: failed/, doctorOut);
		assert.match(doctorOut, /Runtime assembled: 15 tools/, doctorOut);

		const session = await spawnCaptured(process.execPath, [bundle, "read note.txt"], {
			cwd: sandbox,
			env,
			timeoutMs: 90_000,
		});
		assert.equal(session.code, 0, `${session.stdout}\n${session.stderr}`);
	} finally {
		await closeServer(server).catch(() => undefined);
		await rm(sandbox, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
	}
});
