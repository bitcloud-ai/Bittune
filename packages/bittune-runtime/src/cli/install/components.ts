import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { VERSION } from "../../config.ts";
import { runCommand } from "../../utils/command-runner.ts";

/** Kept in sync with install/offline-manifest.env; the bootstrap shell embeds the same pair. */
export const NODE_VERSION = "v22.22.2";
export const NODE_SHA256 = "88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a";
const NODE_PLATFORM_DIR = "linux-x64";

type LogSink = (chunk: string) => void;

async function sh(command: string, args: string[], log: LogSink, timeoutMs = 120_000): Promise<Awaited<ReturnType<typeof runCommand>>> {
  const result = await runCommand(command, args, { timeoutMs, maxBytes: 512 * 1024 });
  log(`$ ${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function shOk(command: string, args: string[], log: LogSink, timeoutMs = 30_000): Promise<boolean> {
  try {
    return (await sh(command, args, log, timeoutMs)).exit_code === 0;
  } catch {
    return false;
  }
}

async function commandExists(command: string, log: LogSink): Promise<boolean> {
	return shOk("bash", ["-c", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], log);
}

async function detectPackageManager(log: LogSink): Promise<string | undefined> {
	for (const manager of ["apt-get", "dnf", "yum", "zypper", "pacman"] as const) {
		if (await commandExists(manager, log)) return manager;
	}
	return undefined;
}

async function installSystemPackages(packages: string[], log: LogSink): Promise<boolean> {
	const manager = await detectPackageManager(log);
	if (!manager) return false;
	if (manager === "apt-get") {
		const updated = await sh("apt-get", ["update"], log, 300_000);
		if (updated.exit_code !== 0) return false;
		return (await sh("apt-get", ["install", "-y", "--no-install-recommends", ...packages], log, 600_000)).exit_code === 0;
	}
	if (manager === "zypper") return (await sh("zypper", ["--non-interactive", "install", ...packages], log, 600_000)).exit_code === 0;
	if (manager === "pacman") return (await sh("pacman", ["-Sy", "--noconfirm", ...packages], log, 600_000)).exit_code === 0;
	return (await sh(manager, ["install", "-y", ...packages], log, 600_000)).exit_code === 0;
}

function firstErrorLine(stderr: string): string {
  return stderr.trim().split(/\r?\n/)[0]?.slice(0, 200) || "unknown error";
}

async function fileSha256(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolveHash(hash.digest("hex")))
      .on("error", rejectHash);
  });
}

function uniqueStamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 8);
}

/** A deliberate partial completion (tooling missing on this host class). Recorded as a warning, never fails the install. */
export class ComponentSkipped extends Error {}

export interface InstallContext {
  installRoot: string;
  targetUser: string;
  sourceKind: "network" | "bundle";
  /** Release tgz path (network) or offline bundle root directory (bundle). */
  payloadPath: string;
  /** Bootstrap-prepared agent staging directory (deps already installed); adopted when valid. */
  stageAgentDir?: string;
  /** Absolute path to the pinned Python requirements list shipped beside the entrypoint. */
  requirementsPath?: string;
  /** Directory holding the prebuilt bittune_core wheel shipped with the release. */
  coreWheelDir?: string;
  /** SHA-256 of the incoming agent dist, computed once from the payload. */
  incomingAgentDistSha?: string;
  /** SHA-256 of the incoming bittune_core wheel. */
  coreWheelSha?: string;
  appendLog: LogSink;
}

const INSTALL_MARKER = ".bittune-install.json";

interface InstallMarker {
  version: string;
  dist_sha256: string;
  core_wheel_sha256?: string;
}

export interface ComponentDescription {
  version: string;
  source: string;
}

export type DetectState = "satisfied" | "pending";

export interface ComponentDefinition {
  id: string;
  label: string;
  required: boolean;
  applies(ctx: InstallContext): boolean;
  describe(ctx: InstallContext): Promise<ComponentDescription>;
  detect(ctx: InstallContext): Promise<DetectState>;
  /** Returns a one-line outcome summary; may throw ComponentSkipped for an acceptable partial result. */
  install(ctx: InstallContext): Promise<string>;
  verify(ctx: InstallContext): Promise<string>;
  fixHints: ReadonlyArray<{ test: RegExp; advice: string }>;
}

function nodeRoot(ctx: InstallContext): string { return join(ctx.installRoot, "node"); }
function agentRoot(ctx: InstallContext): string { return join(ctx.installRoot, "agent"); }
function pyRoot(ctx: InstallContext): string { return join(ctx.installRoot, "py"); }
function backupPath(ctx: InstallContext, name: string): string {
  return join(ctx.installRoot, "backups", `${name}-${uniqueStamp()}`);
}

/** Locates the prebuilt bittune_core wheel inside the release payload. */
function findCoreWheel(ctx: InstallContext): string {
  const candidates = [
    ctx.coreWheelDir,
    join(resolve(ctx.payloadPath), "core-wheel"),
    join(agentRoot(ctx), "core-wheel"),
  ].filter((path): path is string => Boolean(path));
  for (const directory of candidates) {
    if (!existsSync(directory)) continue;
    const wheel = readdirSync(directory).find((name) => /^bittune_core-\d+\.\d+\.\d+-py3-none-any\.whl$/.test(name));
    if (wheel) return join(directory, wheel);
  }
  throw new Error(`安装源缺少 Python Core wheel（bittune_core-*.whl）；发行包不完整。`);
}

function coreWheelVersion(wheel: string): string {
  const match = /bittune_core-(\d+\.\d+\.\d+)-/.exec(basename(wheel));
  if (!match) throw new Error(`无法从 wheel 文件名解析 Python Core 版本：${basename(wheel)}`);
  return match[1]!;
}

/** Moves `source` to `destination`, archiving any existing directory into backups first. */
async function replaceDirectory(source: string, destination: string, makeBackup: () => string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  if (existsSync(destination)) {
    const backup = makeBackup();
    await mkdir(dirname(backup), { recursive: true });
    await renameOrPurge(destination, backup);
  }
  await renameOrPurge(source, destination);
}

async function renameOrPurge(from: string, to: string): Promise<void> {
  try {
    await import("node:fs/promises").then((fs) => fs.rename(from, to));
  } catch {
    // Cross-device or locked fallback is not worth bespoke handling here; the
    // original either moves by copy+delete semantics via cp in callers or dies
    // loudly in the verify phase.
    await sh("cp", ["-a", from, to], () => undefined, 600_000);
    await rm(from, { recursive: true, force: true });
  }
}

function launcherScript(ctx: InstallContext): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `export PATH="${join(nodeRoot(ctx), "bin")}:${pyRoot(ctx)}/bin:\${PATH}"`,
    `exec "${join(nodeRoot(ctx), "bin", "node")}" --disable-warning=ExperimentalWarning "${join(agentRoot(ctx), "dist", "bittune.js")}" "$@"`,
    "",
  ].join("\n");
}

export function expectedNodeVersion(): string {
  return NODE_VERSION;
}

async function extractReleasePackage(ctx: InstallContext, stage: string): Promise<void> {
  const extracted = await sh("tar", ["-xzf", resolve(ctx.payloadPath), "--strip-components=1", "-C", stage], ctx.appendLog);
  if (extracted.exit_code !== 0) throw new Error(`发行包解压失败（退出码 ${extracted.exit_code ?? "unknown"}）。`);
  if (!agentPayloadComplete(stage)) {
    throw new Error("发行包缺少 package.json、dist/bittune.js、photon vendor 或 skills/。");
  }
}

async function readInstallMarker(root: string): Promise<InstallMarker | undefined> {
  try {
    const parsed = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(root, INSTALL_MARKER), "utf8"))) as InstallMarker;
    return typeof parsed === "object" && parsed !== null && typeof parsed.version === "string" && typeof parsed.dist_sha256 === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeInstallMarker(ctx: InstallContext, updates: { distSha?: string; coreWheelSha?: string }): Promise<void> {
  const previous = await readInstallMarker(agentRoot(ctx));
  const coreWheelSha = updates.coreWheelSha ?? previous?.core_wheel_sha256;
  const marker: InstallMarker = {
    version: VERSION,
    dist_sha256: updates.distSha ?? previous?.dist_sha256 ?? "",
    ...(coreWheelSha ? { core_wheel_sha256: coreWheelSha } : {}),
  };
  await writeFile(join(agentRoot(ctx), INSTALL_MARKER), `${JSON.stringify(marker)}\n`, { mode: 0o644 });
}

const INCOMING_DIST_ENTRY = "package/dist/bittune.js";

/** GNU tar on Windows chokes on `C:\...` drive paths; forward slashes work. */
function pathForTar(value: string): string {
	const resolved = resolve(value);
	return process.platform === "win32" ? resolved.replace(/\\/g, "/") : resolved;
}

/**
 * Content-address the upgrade against the package being installed, never
 * against the installation itself: a healthy self-consistent install whose
 * package was rebuilt with the same version must still replace the previous
 * bytes. The digest is computed once per run and memoized on ctx.
 */
export async function resolveIncomingAgentDistSha(ctx: InstallContext): Promise<string> {
  if (ctx.incomingAgentDistSha) return ctx.incomingAgentDistSha;
  let digest: string;
  if (ctx.sourceKind === "bundle") {
    const dist = join(resolve(ctx.payloadPath), "agent", "dist", "bittune.js");
    if (!existsSync(dist)) throw new Error("离线包缺少 agent/dist/bittune.js。");
    digest = await fileSha256(dist);
  } else {
    const stage = ctx.stageAgentDir ? resolve(ctx.stageAgentDir) : "";
    if (stage && existsSync(join(stage, "dist", "bittune.js"))) {
      digest = await fileSha256(join(stage, "dist", "bittune.js"));
    } else {
      const archive = resolve(ctx.payloadPath);
      const temporary = join(ctx.installRoot, "staging", `payload-hash-${uniqueStamp()}`);
      await mkdir(temporary, { recursive: true });
      try {
        // cwd-relative archive path keeps tar working on drive-letter
        // platforms; the payload layout is identical on Linux.
        const extracted = await runCommand(
          "tar",
          ["-xzf", basename(archive), "-C", pathForTar(temporary), INCOMING_DIST_ENTRY],
          { cwd: dirname(archive), timeoutMs: 120_000, maxBytes: 512 * 1024 },
        );
        if (extracted.exit_code !== 0 || !existsSync(join(temporary, INCOMING_DIST_ENTRY))) {
          throw new Error("发行包缺少 package/dist/bittune.js，无法核对更新内容。");
        }
        digest = await fileSha256(join(temporary, INCOMING_DIST_ENTRY));
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  }
  ctx.incomingAgentDistSha = digest;
  return digest;
}

/** SHA-256 of the incoming Core wheel; memoized on ctx like the dist digest. */
export async function resolveCoreWheelSha(ctx: InstallContext): Promise<string> {
  if (ctx.coreWheelSha) return ctx.coreWheelSha;
  const digest = await fileSha256(findCoreWheel(ctx));
  ctx.coreWheelSha = digest;
  return digest;
}

/** Agent payload is complete only when dist, package.json, photon pair and a non-empty skills/ are all present. */
export function agentPayloadComplete(root: string): boolean {
  const photon = join(root, "dist", "node_modules", "@silvia-odwyer", "photon-node");
  const skills = join(root, "skills");
  if (!existsSync(join(root, "dist", "bittune.js")) || !existsSync(join(root, "package.json"))) return false;
  if (!existsSync(join(photon, "photon_rs.js")) || !existsSync(join(photon, "photon_rs_bg.wasm"))) return false;
  if (!existsSync(skills)) return false;
  try {
    return readdirSync(skills).length > 0;
  } catch {
    return false;
  }
}

/** Pure satisfiability predicate for the agent payload: marker, installed
 * bytes and incoming bytes must all agree. */
export function agentMarkerSatisfied(marker: InstallMarker | undefined, installedDistSha: string, incomingDistSha: string, version: string): boolean {
  return Boolean(marker) && marker!.version === version && marker!.dist_sha256 === installedDistSha && installedDistSha === incomingDistSha;
}

/** Pure satisfiability predicate for the Core wheel: installed version plus
 * the recorded wheel digest must match the incoming package. */
export function coreMarkerSatisfied(marker: InstallMarker | undefined, incomingWheelSha: string, installedVersionMatches: boolean): boolean {
  return installedVersionMatches && Boolean(marker) && marker!.core_wheel_sha256 === incomingWheelSha;
}

export const COMPONENTS: readonly ComponentDefinition[] = [
  {
    id: "system-base",
    label: "System base packages",
    required: true,
    applies: (ctx) => ctx.sourceKind === "network",
    async describe() {
      return { version: "tar/curl", source: "host distribution package manager" };
    },
    async detect(ctx) {
      return (await commandExists("tar", ctx.appendLog)) ? "satisfied" : "pending";
    },
    async install(ctx) {
      if (await commandExists("tar", ctx.appendLog)) return "tar is available";
      throw new Error("tar is required; install it with your distribution package manager and rerun the installer.");
    },
    async verify(ctx) {
      const ok = await commandExists("tar", ctx.appendLog);
      if (!ok) throw new Error("tar is unavailable after installation.");
      return "tar is available";
    },
    fixHints: [
      { test: /Failed to fetch|Temporary failure|resolv|^E: /i, advice: "apt 源不可达；检查网络/DNS 或 /etc/apt/sources.list 后重试。" },
      { test: /Could not get lock|Unable to lock/i, advice: "另一个 apt 进程正在运行；等待其结束后重试。" },
    ],
  },
  {
    id: "node-runtime",
    label: "Node.js runtime",
    required: true,
    applies: () => true,
    async describe(ctx) {
      return {
        version: NODE_VERSION,
        source: ctx.sourceKind === "bundle" ? `offline bundle (${basename(resolve(ctx.payloadPath))})` : "https://nodejs.org/dist（sha256 校验）",
      };
    },
    async detect(ctx) {
      const binary = join(nodeRoot(ctx), "bin", "node");
      if (!existsSync(binary)) return "pending";
      const check = await sh(binary, ["--version"], ctx.appendLog, 15_000);
      return check.exit_code === 0 && check.stdout.trim() === NODE_VERSION ? "satisfied" : "pending";
    },
    async install(ctx) {
      const temporary = join(ctx.installRoot, `.node-stage-${uniqueStamp()}`);
      await mkdir(temporary, { recursive: true });
      try {
        let archive: string;
        if (ctx.sourceKind === "bundle") {
          archive = join(resolve(ctx.payloadPath), `node-${NODE_VERSION}-${NODE_PLATFORM_DIR}.tar.xz`);
          if (!existsSync(archive)) throw new Error(`离线包缺少 ${basename(archive)}。`);
          const digest = await fileSha256(archive);
          if (digest !== NODE_SHA256) throw new Error(`离线包内 Node.js SHA-256 不匹配（期望 ${NODE_SHA256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…）。`);
        } else {
          archive = join(temporary, "node.tar.xz");
          const url = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${NODE_PLATFORM_DIR}.tar.xz`;
          const downloaded = await sh("curl", ["--fail", "--location", "--proto", "=https", "--tlsv1.2", url, "--output", archive], ctx.appendLog, 600_000);
          if (downloaded.exit_code !== 0) throw new Error(`下载 Node.js 失败：${firstErrorLine(downloaded.stderr) || url}`);
          const digest = await fileSha256(archive);
          if (digest !== NODE_SHA256) throw new Error(`Node.js 下载 SHA-256 校验失败（实际 ${digest.slice(0, 12)}…）。`);
        }
        const extracted = await sh("tar", ["-xJf", archive, "-C", temporary], ctx.appendLog, 300_000);
        if (extracted.exit_code !== 0) throw new Error("Node.js 解压失败。");
        const candidate = join(temporary, `node-${NODE_VERSION}-${NODE_PLATFORM_DIR}`);
        if (!existsSync(join(candidate, "bin", "node"))) throw new Error("Node.js 解压结果不完整。");
        await replaceDirectory(candidate, nodeRoot(ctx), () => backupPath(ctx, "node"));
        return `Node.js ${NODE_VERSION} 已就绪。`;
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
    async verify(ctx) {
      const check = await sh(join(nodeRoot(ctx), "bin", "node"), ["--version"], ctx.appendLog, 15_000);
      const version = check.exit_code === 0 ? check.stdout.trim() : "missing";
      if (version !== NODE_VERSION) throw new Error(`Node.js 验证失败：得到 ${version}，期望 ${NODE_VERSION}。`);
      return version;
    },
    fixHints: [
      { test: /Could not resolve|Connection timed out|curl: \(\d+\)/i, advice: "无法访问 nodejs.org；检查网络或代理（export HTTPS_PROXY=...），或改用离线包安装。" },
      { test: /SHA-256/i, advice: "下载内容校验失败；重新运行安装器会自动重新下载。" },
    ],
  },
  {
    id: "bittune-agent",
    label: "Bittune Runtime",
    required: true,
    applies: () => true,
    async describe(ctx) {
      return {
        version: VERSION,
        source: ctx.sourceKind === "bundle" ? `offline bundle (${basename(resolve(ctx.payloadPath))}/agent)` : `release package (${basename(resolve(ctx.payloadPath))})`,
      };
    },
    async detect(ctx) {
      const root = agentRoot(ctx);
      if (!agentPayloadComplete(root)) {
        return "pending";
      }
      const marker = await readInstallMarker(root);
      const installedDistSha = await fileSha256(join(root, "dist", "bittune.js"));
      const incomingDistSha = await resolveIncomingAgentDistSha(ctx);
      return agentMarkerSatisfied(marker, installedDistSha, incomingDistSha, VERSION) ? "satisfied" : "pending";
    },
    async install(ctx) {
      // Bootstrap hands over a prepared staging directory for online installs;
      // adopting it avoids a second extract + npm pass.
      const provided = ctx.stageAgentDir ? resolve(ctx.stageAgentDir) : "";
      if (provided && agentPayloadComplete(provided)) {
        await mkdir(join(ctx.installRoot, "backups"), { recursive: true });
        await replaceDirectory(provided, agentRoot(ctx), () => backupPath(ctx, "agent"));
        const launcherPath = "/usr/local/bin/bittune";
        await mkdir(dirname(launcherPath), { recursive: true }).catch(() => undefined);
        await writeFile(launcherPath, launcherScript(ctx), { mode: 0o755 });
        await writeInstallMarker(ctx, { distSha: await resolveIncomingAgentDistSha(ctx), coreWheelSha: await resolveCoreWheelSha(ctx) });
        return `Bittune ${VERSION} 已就绪（采用引导暂存目录），入口 ${launcherPath}。`;
      }
      const stage = join(ctx.installRoot, `.agent-install-${uniqueStamp()}`);
      await mkdir(stage, { recursive: true });
      try {
        if (ctx.sourceKind === "bundle") {
          const copied = await sh("cp", ["-a", `${join(resolve(ctx.payloadPath), "agent")}/.`, stage], ctx.appendLog, 300_000);
          if (copied.exit_code !== 0) throw new Error(`复制离线包内容失败：${firstErrorLine(copied.stderr)}`);
        } else {
          await extractReleasePackage(ctx, stage);
        }
        if (!agentPayloadComplete(stage)) {
          throw new Error("发行包不完整：缺少 package.json、dist/bittune.js、photon vendor 或 skills/。请换一份完整发行物。");
        }
        await mkdir(join(ctx.installRoot, "backups"), { recursive: true });
        await replaceDirectory(stage, agentRoot(ctx), () => backupPath(ctx, "agent"));
        const launcherPath = "/usr/local/bin/bittune";
        await mkdir(dirname(launcherPath), { recursive: true }).catch(() => undefined);
        await writeFile(launcherPath, launcherScript(ctx), { mode: 0o755 });
        await writeInstallMarker(ctx, { distSha: await resolveIncomingAgentDistSha(ctx), coreWheelSha: await resolveCoreWheelSha(ctx) });
        return `Bittune ${VERSION} 已就绪，入口 ${launcherPath}。`;
      } catch (error) {
        await rm(stage, { recursive: true, force: true });
        throw error;
      }
    },
    async verify(ctx) {
      const node = join(nodeRoot(ctx), "bin", "node");
      const binary = join(agentRoot(ctx), "dist", "bittune.js");
      const check = await sh(node, [binary, "version"], ctx.appendLog, 30_000);
      if (check.exit_code !== 0) throw new Error(`Bittune 自检失败：${firstErrorLine(check.stderr)}`);
      return check.stdout.trim().replace(/^Bittune\s*/i, "");
    },
    fixHints: [
      { test: /不完整|缺少 photon|缺少 package.json|缺少 dist\/bittune\.js/i, advice: "包不完整，换一份完整发行物。" },
      { test: /EACCES|permission denied|EACCES/i, advice: "请使用 sudo 运行安装器；/opt/bittune 需要管理员权限。" },
      { test: /ENOSPC|No space left/i, advice: "磁盘空间不足；清理后重试。" },
    ],
  },
  {
    id: "python-venv",
    label: "Python virtualenv",
    required: true,
    applies: () => true,
    async describe() {
      return { version: "python3 venv + pip", source: "host python3" };
    },
    async detect(ctx) {
      return existsSync(join(pyRoot(ctx), "bin", "pip")) || existsSync(join(pyRoot(ctx), "Scripts", "pip.exe")) ? "satisfied" : "pending";
    },
    async install(ctx) {
      if (!(await commandExists("python3", ctx.appendLog))) {
        const manager = await detectPackageManager(ctx.appendLog);
        const pythonPackages = manager === "pacman"
          ? ["python", "python-pip"]
          : manager === "dnf" || manager === "yum"
            ? ["python3", "python3-pip"]
            : ["python3", "python3-venv"];
        const installed = await installSystemPackages(pythonPackages, ctx.appendLog);
        if (!installed || !(await commandExists("python3", ctx.appendLog))) {
          throw new Error("宿主机缺少 python3 且自动安装失败；Bittune 运行需要 Python（Python Core 与压测工具）。");
        }
      }
      await rm(pyRoot(ctx), { recursive: true, force: true });
      const created = await sh("python3", ["-m", "venv", pyRoot(ctx)], ctx.appendLog, 300_000);
      const hasPip = existsSync(join(pyRoot(ctx), "bin", "pip")) || existsSync(join(pyRoot(ctx), "Scripts", "pip.exe"));
      if (created.exit_code !== 0 || !hasPip) {
        throw new Error("创建 Python 虚拟环境失败（通常缺少 venv 支持）；请安装发行版对应的 Python venv 包后重跑安装器。");
      }
      return "Python 虚拟环境已就绪。";
    },
    async verify(ctx) {
      const python = join(pyRoot(ctx), "bin", "python");
      const check = await sh(python, ["--version"], ctx.appendLog, 15_000).catch(() => null);
      if (!check || check.exit_code !== 0 || !check.stdout.trim()) throw new Error("Python 虚拟环境不可用。");
      return check.stdout.trim();
    },
    fixHints: [
      { test: /ensurepip|python3-venv|venv/i, advice: "请安装发行版对应的 Python venv/ensurepip 包后重跑安装器。" },
    ],
  },
  {
    id: "bittune-core",
    label: "Bittune Python Core",
    required: true,
    applies: () => true,
    async describe(ctx) {
      return { version: coreWheelVersion(findCoreWheel(ctx)), source: ctx.sourceKind === "bundle" ? `offline bundle (${basename(findCoreWheel(ctx))})` : `release package (${basename(findCoreWheel(ctx))})` };
    },
    async detect(ctx) {
      const python = join(pyRoot(ctx), "bin", "python");
      if (!existsSync(python)) return "pending";
      const check = await sh(python, ["-m", "bittune_core", "--version"], ctx.appendLog, 20_000).catch(() => null);
      if (!check || check.exit_code !== 0) return "pending";
      const versionMatches = check.stdout.includes(coreWheelVersion(findCoreWheel(ctx)));
      const marker = await readInstallMarker(agentRoot(ctx));
      return coreMarkerSatisfied(marker, await resolveCoreWheelSha(ctx), versionMatches) ? "satisfied" : "pending";
    },
    async install(ctx) {
      const wheel = findCoreWheel(ctx);
      const pip = join(pyRoot(ctx), "bin", "pip");
      const installed = await sh(pip, ["install", "--quiet", "--no-index", "--find-links", dirname(wheel), "--force-reinstall", wheel], ctx.appendLog, 300_000);
      if (installed.exit_code !== 0) {
        throw new Error(`Python Core wheel 安装失败：${firstErrorLine(installed.stderr)}`);
      }
      await writeInstallMarker(ctx, { coreWheelSha: await resolveCoreWheelSha(ctx) });
      return `Python Core ${coreWheelVersion(wheel)} 已装入虚拟环境。`;
    },
    async verify(ctx) {
      const python = join(pyRoot(ctx), "bin", "python");
      const check = await sh(python, ["-m", "bittune_core", "--version"], ctx.appendLog, 20_000);
      const expected = coreWheelVersion(findCoreWheel(ctx));
      if (check.exit_code !== 0 || !check.stdout.includes(expected)) {
        throw new Error(`Python Core 自检失败：期望 ${expected}，得到 ${check.stdout.trim() || "无输出"}。`);
      }
      return check.stdout.trim();
    },
    fixHints: [
      { test: /No matching distribution|no-index/i, advice: "发行包缺少 Python Core wheel；请重新下载完整发行包。" },
      { test: /pip/i, advice: "虚拟环境 pip 不可用；重跑安装器会重建虚拟环境。" },
    ],
  },
  {
    id: "python-tooling",
    label: "Python measurement tooling",
    required: false,
    applies: () => true,
    async describe() {
      return { version: "evalscope[perf]==1.10.0 · huggingface_hub[cli]==1.27.0", source: "PyPI（独立 venv）" };
    },
    async detect(ctx) {
      return existsSync(join(pyRoot(ctx), "bin", "evalscope")) && existsSync(join(pyRoot(ctx), "bin", "hf")) ? "satisfied" : "pending";
    },
    async install(ctx) {
      if (ctx.sourceKind === "bundle") {
        throw new ComponentSkipped("离线包未携带 Python wheelhouse；为保证离线安装不访问网络，EvalScope 测量工具需另行准备。")
      }
      if (!existsSync(join(pyRoot(ctx), "bin", "pip"))) {
        throw new ComponentSkipped("Python 虚拟环境缺失；请先修复 python-venv 组件后重跑安装器。");
      }
      const requirementCandidates = [ctx.requirementsPath, join(agentRoot(ctx), "requirements.txt")].filter((path): path is string => Boolean(path));
      const requirements = requirementCandidates.find((path) => existsSync(path));
      if (!requirements) {
        throw new ComponentSkipped("未找到 requirements.txt；请按指南手动准备钉版 evalscope/hf（pip install -r requirements.txt）。");
      }
      if (process.env.BITTUNE_INSTALL_OFFLINE === "1") {
        throw new ComponentSkipped("offline package has no Python wheelhouse; optional measurement tools were skipped.");
      }
      const pipBin = join(pyRoot(ctx), "bin", "pip");
      const installedTools = await sh(pipBin, ["install", "--quiet", "-r", requirements], ctx.appendLog, 1_800_000);
      if (installedTools.exit_code !== 0) {
        throw new ComponentSkipped(`工具栈安装失败；可手动重试：sudo ${pipBin} install -r ${requirements}`);
      }
      return "evalscope 与 Hugging Face CLI 已装入独立虚拟环境。";
    },
    async verify(ctx) {
      const broken: string[] = [];
      for (const [tool, args] of [["evalscope", ["--version"]], ["hf", ["version"]]] as const) {
        const check = await sh(join(pyRoot(ctx), "bin", tool), [...args], ctx.appendLog, 30_000).catch(() => null);
        if (!check || check.exit_code !== 0) broken.push(tool);
      }
      if (broken.length >= 2) throw new ComponentSkipped(`${broken.join("/")} 装后自检不可用；环境已保留，可通过 bittune doctor 观察。`);
      if (broken.length) throw new Error(`${broken.join("/")} 未成功。`);
      return "evalscope / hf 就绪";
    },
    fixHints: [
      { test: /pypi|ReadTimeout|Retry|proxy/i, advice: "PyPI 不可达；配置代理后重试（export HTTPS_PROXY=...）。" },
    ],
  },
];
