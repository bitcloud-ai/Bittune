import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { VERSION } from "../../config.ts";
import { runCommand } from "../../../../bittune-capabilities/src/shared/process.ts";

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
  appendLog: LogSink;
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
    `export PATH="${join(nodeRoot(ctx), "bin")}:${pyRoot(ctx)}/bin:${join(agentRoot(ctx), "node_modules", ".bin")}:\${PATH}"`,
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
  if (!existsSync(join(stage, "package.json")) || !existsSync(join(stage, "dist", "bittune.js"))) {
    throw new Error("发行包缺少 package.json 或 dist/bittune.js。");
  }
}

export const COMPONENTS: readonly ComponentDefinition[] = [
  {
    id: "system-base",
    label: "System base packages",
    required: true,
    applies: (ctx) => ctx.sourceKind === "network",
    async describe() {
      return { version: "apt ca-certificates/curl", source: "apt repositories" };
    },
    async detect(ctx) {
      return (await commandExists("curl", ctx.appendLog)) && (await commandExists("tar", ctx.appendLog)) ? "satisfied" : "pending";
    },
    async install(ctx) {
      for (const command of ["apt-get", "curl", "tar"]) {
        if (!(await commandExists(command, ctx.appendLog))) throw new Error(`缺少基础命令：${command}；请先安装系统基础工具。`);
      }
      await sh("apt-get", ["update"], ctx.appendLog, 300_000);
      const installed = await sh("apt-get", ["install", "-y", "--no-install-recommends", "ca-certificates", "curl"], ctx.appendLog, 600_000);
      if (installed.exit_code !== 0) throw new Error(`apt 安装基础依赖失败：${firstErrorLine(installed.stderr)}`);
      return "ca-certificates 与 curl 就绪。";
    },
    async verify(ctx) {
      const ok = (await commandExists("curl", ctx.appendLog)) && (await commandExists("tar", ctx.appendLog));
      if (!ok) throw new Error("curl/tar 在装后仍不可用。");
      return "curl / tar 可用";
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
      return existsSync(join(root, "dist", "bittune.js")) && existsSync(join(root, "package.json")) && existsSync(join(root, "node_modules"))
        ? "satisfied"
        : "pending";
    },
    async install(ctx) {
      const stage = join(ctx.installRoot, `.agent-install-${uniqueStamp()}`);
      await mkdir(stage, { recursive: true });
      try {
        if (ctx.sourceKind === "bundle") {
          const copied = await sh("cp", ["-a", join(resolve(ctx.payloadPath), "agent"), stage], ctx.appendLog, 300_000);
          if (copied.exit_code !== 0) throw new Error(`复制离线包内容失败：${firstErrorLine(copied.stderr)}`);
        } else {
          await extractReleasePackage(ctx, stage);
        }
        if (!existsSync(join(stage, "package.json")) || !existsSync(join(stage, "dist", "bittune.js"))) {
          throw new Error("安装源缺少 package.json 或 dist/bittune.js。");
        }
        if (!existsSync(join(stage, "node_modules"))) {
          const npmBin = join(nodeRoot(ctx), "bin", "npm");
          const installed = await sh(npmBin, ["install", "--omit=dev", "--ignore-scripts", "--prefix", stage], ctx.appendLog, 900_000);
          if (installed.exit_code !== 0) throw new Error(`npm 安装运行依赖失败：${firstErrorLine(installed.stderr)}`);
        }
        await mkdir(join(ctx.installRoot, "backups"), { recursive: true });
        await replaceDirectory(stage, agentRoot(ctx), () => backupPath(ctx, "agent"));
        const launcherPath = "/usr/local/bin/bittune";
        await mkdir(dirname(launcherPath), { recursive: true }).catch(() => undefined);
        await writeFile(launcherPath, launcherScript(ctx), { mode: 0o755 });
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
      { test: /npmjs|registry|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i, advice: "npm 源不可达；配置代理后重试（export HTTPS_PROXY=...），或改用离线包安装。" },
      { test: /EACCES|permission denied|EACCES/i, advice: "请使用 sudo 运行安装器；/opt/bittune 需要管理员权限。" },
      { test: /ENOSPC|No space left/i, advice: "磁盘空间不足；清理后重试。" },
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
      if (!(await commandExists("python3", ctx.appendLog))) {
        if (ctx.sourceKind !== "network") {
          throw new ComponentSkipped("离线主机未检测到 python3；请手动安装后重跑，或改用在线安装器。");
        }
        const installed = await sh("apt-get", ["install", "-y", "--no-install-recommends", "python3", "python3-venv"], ctx.appendLog, 600_000);
        if (installed.exit_code !== 0) throw new ComponentSkipped(`宿主机缺少 python3 且自动安装失败：${firstErrorLine(installed.stderr)}`);
      }
      if (!existsSync(join(pyRoot(ctx), "bin", "pip"))) {
        await rm(pyRoot(ctx), { recursive: true, force: true });
        const created = await sh("python3", ["-m", "venv", pyRoot(ctx)], ctx.appendLog, 300_000);
        if (created.exit_code !== 0 || !existsSync(join(pyRoot(ctx), "bin", "pip"))) {
          throw new ComponentSkipped("创建 Python 虚拟环境失败（通常缺少 python3-venv）：sudo apt-get install -y python3-venv 后重跑安装器。");
        }
      }
      const requirements = join(agentRoot(ctx), "requirements.txt");
      if (!existsSync(requirements)) throw new ComponentSkipped("发行包缺少 requirements.txt；请按指南手动准备 evalscope/hf。");
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
      { test: /ensurepip|python3-venv|venv/i, advice: "sudo apt-get install -y python3-venv 后重跑安装器。" },
    ],
  },
];
