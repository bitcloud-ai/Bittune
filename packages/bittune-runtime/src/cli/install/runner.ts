import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { COMPONENTS, ComponentSkipped, type ComponentDefinition, type InstallContext } from "./components.ts";
import { runChecks, renderCheckLines, type CheckResult } from "./checks.ts";
import { runCommand } from "../../../../bittune-capabilities/src/shared/process.ts";

export const INSTALL_ROOT = process.env.BITTUNE_INSTALL_ROOT?.trim() || "/opt/bittune";

export interface InstallOptions {
  checkOnly?: boolean;
  json?: boolean;
  yes?: boolean;
  user?: string;
  /** Release tgz (online) or offline bundle directory; exactly one is required for installs. */
  packagePath?: string;
  bundleDir?: string;
  /** Bootstrap-prepared agent staging directory, adopted by the agent component. */
  stageDir?: string;
}

type ExecutedStatus = "satisfied" | "installed" | "skipped" | "failed";

interface ExecutedEntry {
  id: string;
  label: string;
  status: ExecutedStatus;
  summary: string;
}

export interface InstallReport {
  mode: "check-only" | "install";
  installRoot: string;
  /** Environment facts about this very invocation (arch, disk, target user). */
  environment: CheckResult[];
  /** Shared prerequisite catalog results (same source as `bittune doctor`). */
  preflight: CheckResult[];
  plan: Array<{ id: string; label: string; required: boolean; version: string; source: string }>;
  executed: ExecutedEntry[];
  verification: CheckResult[];
  warnings: string[];
  failure?: InstallFailure;
}

export interface InstallFailure {
  step: number;
  componentId: string;
  label: string;
  message: string;
  advice: string;
  logPath: string;
  retryCommand: string;
}

function fail(message: string): never {
  throw new Error(`bittune install: ${message}`);
}

async function shOk(command: string, args: string[]): Promise<boolean> {
  try {
    return (await runCommand(command, args, { timeoutMs: 15_000 })).exit_code === 0;
  } catch {
    return false;
  }
}

async function dfAvailableBytes(path: string): Promise<number | undefined> {
  try {
    const result = await runCommand("df", ["-B1", "--output=avail", path], { timeoutMs: 10_000 });
    if (result.exit_code !== 0) return undefined;
    const value = Number(result.stdout.trim().split(/\r?\n/)[1]?.trim());
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function environmentChecks(targetUser: string | undefined): Promise<CheckResult[]> {
  const rows: CheckResult[] = [];
  const freeBytes = await dfAvailableBytes(resolve(INSTALL_ROOT, ".."));
  const gibFree = freeBytes === undefined ? undefined : freeBytes / 1024 ** 3;
  rows.push({
    id: "env-arch",
    label: "Architecture",
    state: process.arch === "x64" ? "ok" : "unavailable",
    detail: process.arch === "x64" ? "x86_64" : `${process.arch}；发行包仅含 linux-x64 运行时`,
  });
  rows.push({
    id: "env-disk",
    label: "Disk space",
    state: gibFree !== undefined && gibFree < 10 ? "missing" : "ok",
    detail: gibFree !== undefined ? `${gibFree.toFixed(1)} GiB available @ ${resolve(INSTALL_ROOT, "..")}` : "无法读取可用空间",
  });
  if (targetUser) {
    const known = await shOk("id", ["-u", targetUser]);
    rows.push({
      id: "env-user",
      label: "Target user",
      state: known ? "ok" : "unavailable",
      detail: known ? targetUser : `用户不存在：${targetUser}`,
    });
  }
  return rows;
}

function resolvePayload(options: InstallOptions): { sourceKind: "network" | "bundle"; payloadPath: string } {
  if (options.packagePath && options.bundleDir) fail("--package 与 --offline 只能提供一个。");
  if (options.bundleDir) {
    const bundleDir = resolve(options.bundleDir);
    if (!existsSync(join(bundleDir, "agent", "dist", "bittune.js"))) fail(`离线包缺少 ${join(bundleDir, "agent", "dist", "bittune.js")}。`);
    return { sourceKind: "bundle", payloadPath: bundleDir };
  }
  if (options.packagePath) {
    const packagePath = resolve(options.packagePath);
    if (!existsSync(packagePath)) fail(`发行包不存在或不可读：${packagePath}`);
    return { sourceKind: "network", payloadPath: packagePath };
  }
  fail("安装模式需要提供 --package <tgz> 或 --offline <bundle目录>。");
}

function applicableComponents(sourceKind: "network" | "bundle"): readonly ComponentDefinition[] {
  return COMPONENTS.filter((component) =>
    component.applies({ installRoot: INSTALL_ROOT, targetUser: "", sourceKind, payloadPath: "", appendLog: () => undefined }),
  );
}

function adviceFor(component: ComponentDefinition, message: string): string {
  const matched = component.fixHints.find((hint) => hint.test.test(message));
  return matched?.advice ?? "查看日志文件中的完整命令输出以定位原因。";
}

function retryCommand(context: InstallContext, options: InstallOptions): string {
  const flag = context.sourceKind === "bundle" ? `--offline ${context.payloadPath}` : `--package ${context.payloadPath}`;
  return ["sudo ./bittune-bootstrap.sh", flag, context.targetUser, ...(options.yes ? ["--yes"] : [])].join(" ");
}

export function formatInstallFailure(report: InstallReport): string {
  const failure = report.failure!;
  return [
    `✗ 步骤 [${failure.step}] ${failure.label} 失败：${failure.message}`,
    `  建议：${failure.advice}`,
    `  完整日志：${failure.logPath}`,
    `  重试：${failure.retryCommand}   # 幂等，已完成组件会自动跳过`,
  ].join("\n");
}

function emit(lines: readonly string[]): void {
  for (const line of lines) console.log(line);
}

function renderEnvironment(rows: readonly CheckResult[]): string[] {
  return ["[环境]", ...renderCheckLines(rows)];
}

function confirmPlan(): Promise<boolean> {
  if (!process.stdout.isTTY) return Promise.resolve(false);
  return new Promise((resolveAnswer) => {
    const iface = createInterface({ input: process.stdin, output: process.stdout });
    iface.question("按以上计划执行安装？[y/N] ", (value) => {
      iface.close();
      resolveAnswer(value.trim().toLowerCase() === "y" || value.trim().toLowerCase() === "yes");
    });
  });
}

function finishJson(enabled: boolean, report: InstallReport): void {
  if (enabled) console.log(JSON.stringify(report, null, 2));
}

function tally(entries: readonly ExecutedEntry[]): { satisfied: number; installed: number; skipped: number } {
  const counts = { satisfied: 0, installed: 0, skipped: 0 };
  for (const entry of entries) {
    if (entry.status === "satisfied" || entry.status === "installed" || entry.status === "skipped") counts[entry.status] += 1;
  }
  return counts;
}

export async function runInstallCommand(options: InstallOptions): Promise<number> {
  const checkOnly = Boolean(options.checkOnly);
  const jsonMode = Boolean(options.json);
  try {
    let sourceKind: "network" | "bundle" | undefined;
    let payloadPath: string | undefined;
    if (!checkOnly) {
      const uid = typeof process.getuid === "function" ? process.getuid() : -1;
      if (uid !== 0) fail("请使用 sudo 运行安装器（写入 /opt/bittune 与 /usr/local/bin 需要 root）。");
      ({ sourceKind, payloadPath } = resolvePayload(options));
    }

    const targetUser = options.user ?? process.env.SUDO_USER ?? "";
    if (!checkOnly && !targetUser) fail("未识别目标用户；请追加 --user <user> 指定运行 Bittune 的普通 Linux 用户。");

    mkdirSync(INSTALL_ROOT, { recursive: true });
    const logPath = join(INSTALL_ROOT, "install.log");
    let appendLog: (chunk: string) => void = () => undefined;
    if (!checkOnly) {
      appendFileSync(logPath, `\n===== bittune install ${new Date().toISOString()} mode=${sourceKind} user=${targetUser || "-"} =====\n`);
      appendLog = (chunk) => {
        try { appendFileSync(logPath, chunk.endsWith("\n") ? chunk : `${chunk}\n`); } catch { /* logging must never fail the run */ }
      };
    }

    const environment = await environmentChecks(checkOnly ? targetUser || undefined : targetUser);
    const invalidEnv = environment.find((row) => row.state === "unavailable");
    if (!checkOnly && invalidEnv) fail(invalidEnv.detail);

    const preflight = await runChecks();
    const activeComponents = sourceKind ? applicableComponents(sourceKind) : [];
    const installContext: InstallContext = {
      installRoot: INSTALL_ROOT,
      targetUser,
      sourceKind: sourceKind ?? "network",
      payloadPath: payloadPath ?? "",
      ...(options.stageDir ? { stageAgentDir: options.stageDir } : {}),
      appendLog,
    };

    const plan: InstallReport["plan"] = [];
    for (const component of activeComponents) {
      const description = await component.describe(installContext);
      plan.push({ id: component.id, label: component.label, required: component.required, version: description.version, source: description.source });
    }

    const report: InstallReport = {
      mode: checkOnly ? "check-only" : "install",
      installRoot: INSTALL_ROOT,
      environment,
      preflight,
      plan,
      executed: [],
      verification: [],
      warnings: [],
    };

    emit([`Bittune 安装器${checkOnly ? "（仅体检，不修改系统）" : ""}`, ...renderEnvironment(environment)]);
    emit(["[阶段 1/5] Preflight 前置检查", ...renderCheckLines(preflight)]);

    if (checkOnly) {
      emit(["体检完成：本次未对系统做任何修改。"]);
      finishJson(jsonMode, report);
      return 0;
    }

    emit(["", "[阶段 2/5] 安装计划"]);
    emit(plan.map((entry, index) => `[${index + 1}/${plan.length}] ${entry.label} —— ${entry.version}（来源：${entry.source}）${entry.required ? "" : " [可选]"}`));

    if (!options.yes && !(await confirmPlan())) {
      emit(["已取消：未做任何修改。非交互或自动安装请追加 --yes。"]);
      finishJson(jsonMode, report);
      return 0;
    }

    emit(["", "[阶段 3/5] 执行安装"]);
    for (let index = 0; index < activeComponents.length; index += 1) {
      const component = activeComponents[index]!;
      const tag = `[${index + 1}/${activeComponents.length}]`;
      let entry: ExecutedEntry;
      try {
        if ((await component.detect(installContext)) === "satisfied") {
          entry = { id: component.id, label: component.label, status: "satisfied", summary: "已满足，跳过" };
          emit([`${tag} ${component.label} …… 跳过（已满足）`]);
        } else {
          const summary = await component.install(installContext);
          entry = { id: component.id, label: component.label, status: "installed", summary };
          emit([`${tag} ${component.label} …… 完成（${summary}）`]);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof ComponentSkipped && !component.required) {
          report.warnings.push(`${component.label}：${message}`);
          emit([`${tag} ${component.label} …… 跳过（可选：${message}）`]);
          continue;
        }
        report.executed.push({ id: component.id, label: component.label, status: "failed", summary: message });
        report.failure = {
          step: index + 1,
          componentId: component.id,
          label: component.label,
          message,
          advice: adviceFor(component, message),
          logPath,
          retryCommand: retryCommand(installContext, options),
        };
        emit(["", "[阶段终止]", "", formatInstallFailure(report)]);
        finishJson(jsonMode, report);
        return 1;
      }
      report.executed.push(entry);
    }

    if (!(await shOk("chown", ["-R", `${targetUser}:${targetUser}`, INSTALL_ROOT]))) {
      report.warnings.push(`目录归属设置失败；请手动执行 chown -R ${targetUser}:${targetUser} ${INSTALL_ROOT}`);
    }

    emit(["", "[阶段 4/5] 装后自检（前置项复查）"]);
    report.verification = await runChecks();
    emit(renderCheckLines(report.verification));

    const counts = tally(report.executed);
    emit([
      "",
      "[阶段 5/5] 完成",
      `结果：${counts.satisfied} 已满足 · ${counts.installed} 新装 · ${counts.skipped} 跳过${report.warnings.length ? ` · ${report.warnings.length} 条警告` : ""}`,
      ...report.warnings.map((warning) => `  ⚠ ${warning}`),
      "",
      "下一步（切换到目标用户后执行）：",
      `  export BITTUNE_AGENT_LLM_API_KEY='你的 Agent 模型密钥'`,
      "  bittune configure --base-url https://endpoint/v1 --model-id your-tool-capable-model",
      "  bittune doctor",
      "  bittune",
    ]);
    finishJson(jsonMode, report);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
