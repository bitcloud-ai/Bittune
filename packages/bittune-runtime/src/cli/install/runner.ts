import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { COMPONENTS, ComponentSkipped, installationLauncherPath, type ComponentDefinition, type InstallContext } from "./components.ts";
import {createSoftwareSnapshot,restoreSoftwareSnapshot,listSoftwareSnapshots,readSoftwareSnapshot,markSoftwareSnapshot,lockInstallation} from "./snapshots.ts";
import {TaskClient} from "../../workflows/task-client.ts";
import {resolveBittunePaths} from "../../core/bittune-paths.ts";
import {assertDataOutsideSoftware} from "./guard.ts";
import { runChecks, renderCheckLines, type CheckResult } from "./checks.ts";
import { runCommand } from "../../utils/command-runner.ts";

export const INSTALL_ROOT = process.env.BITTUNE_INSTALL_ROOT?.trim() || "/opt/bittune";

export interface InstallOptions {
  softwareOnly?:boolean;
  listBackups?: boolean;
  rollbackId?: string;
  checkOnly?: boolean;
  json?: boolean;
  yes?: boolean;
  user?: string;
  /** Release tgz (online) or offline bundle directory; exactly one is required for installs. */
  packagePath?: string;
  bundleDir?: string;
  /** Bootstrap-prepared agent staging directory, adopted by the agent component. */
  stageDir?: string;
  /** Pinned Python requirements list shipped beside the bootstrap entrypoint. */
  requirementsPath?: string;
  /** Directory holding the prebuilt bittune_core wheel shipped with the release. */
  coreWheelDir?: string;
}

type ExecutedStatus = "satisfied" | "installed" | "skipped" | "failed";

interface ExecutedEntry {
  id: string;
  label: string;
  status: ExecutedStatus;
  summary: string;
}

export interface InstallReport {
  software_only?:boolean;
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
  backup_id?: string;
  recovery?: {status:string;snapshot_id:string};
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

function renderEnvironment(rows: readonly CheckResult[]): string[] {
  return ["[环境]", ...renderCheckLines(rows)];
}

function confirmPlan(jsonMode = false): Promise<boolean> {
  const output = jsonMode ? process.stderr : process.stdout;
  if (!output.isTTY) return Promise.resolve(false);
  return new Promise((resolveAnswer) => {
    const iface = createInterface({ input: process.stdin, output });
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

async function quiesceCurrentWorkspace(){
  await assertDataOutsideSoftware(INSTALL_ROOT,Object.values(resolveBittunePaths()));
  let client:TaskClient|undefined;
  try{
    client=await TaskClient.connect(false,false);
    const status=await client.request("engine_status",{});
    if(status.active||status.inflight)throw new Error("当前工作区仍有任务或请求，软件尚未变更；请等待任务结束再安装或回退。");
    await client.request("engine_shutdown",{});
  }catch(error){if(!["ENOENT","ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code || ""))throw error;}
  finally{client?.close();}
  const core=resolveBittunePaths().core;
  if(existsSync(join(core,"core.lock"))){
    // Probe the same OS flock as CoreLease without depending on a healthy old Core install.
    const result=await runCommand("python3",["-c","import fcntl,sys;f=open(sys.argv[1],'rb');fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)",join(core,"core.lock")],{timeoutMs:15000});
    if(result.exit_code!==0)throw new Error("当前工作区的Core仍在使用或无法确认空闲，软件尚未变更；请结束原会话后重试。");
  }
}
async function runRollbackCommand(options:InstallOptions){
  const launcher=installationLauncherPath();
  if(options.listBackups){
    const backups=await listSoftwareSnapshots(INSTALL_ROOT);
    console.log(options.json?JSON.stringify({install_root:INSTALL_ROOT,backups}):backups.map(s=>`${s.id}  ${s.status}  ${"created_at" in s?s.created_at:""}`).join("\n") || "当前没有可用的软件备份。");
    return 0;
  }
  const id=options.rollbackId!,snapshot=await readSoftwareSnapshot(INSTALL_ROOT,id,launcher);
  if(options.checkOnly){console.log(JSON.stringify({mode:"rollback-preview",snapshot_id:id,created_at:snapshot.created_at,components:snapshot.components,data_directories_changed:false,hardware_checks:false}));return 0;}
  if(process.getuid?.()!==0)fail("系统软件回退需要sudo；可用--check-only只读预览。");
  if(!options.json)console.log(`回退软件备份 ${id}；恢复Agent、Python环境、Node和CLI入口。账号、任务/报告、模型和Docker数据不回退。`);
  if(!options.yes&&!await confirmPlan(Boolean(options.json)))return 0;
  const release=await lockInstallation(INSTALL_ROOT);
  try{await quiesceCurrentWorkspace();const result=await restoreSoftwareSnapshot(INSTALL_ROOT,id,launcher,name=>{if(!options.json)console.log(`正在恢复软件组件：${name}`);});console.log(options.json?JSON.stringify(result):`软件已恢复，备份编号：${id}。请按原部署方式重新启动应用。`);return 0;}
  finally{await release();}
}

export async function runInstallCommand(options: InstallOptions): Promise<number> {
  const checkOnly = Boolean(options.checkOnly);
  const jsonMode = Boolean(options.json);
  const emit = (lines: readonly string[]) => { for (const line of lines) (jsonMode ? console.error : console.log)(line); };
  let release:(()=>Promise<void>)|undefined,snapshotId:string|undefined,finished=false,recoveryAttempted=false;
  let report:InstallReport|undefined;
  async function recover(){
    if(!snapshotId||finished||recoveryAttempted)return;
    recoveryAttempted=true;
    try{await restoreSoftwareSnapshot(INSTALL_ROOT,snapshotId,installationLauncherPath());if(report)report.recovery={status:"restored",snapshot_id:snapshotId};console.error(`安装未完成，已恢复整套原软件；备份编号：${snapshotId}`);}
    catch(error){if(report)report.recovery={status:"failed",snapshot_id:snapshotId};console.error(`自动恢复未完成，请保留备份 ${snapshotId}：${error instanceof Error?error.message:String(error)}`);}
  }
  try {
    if(options.listBackups||options.rollbackId)return await runRollbackCommand(options);
    let sourceKind: "network" | "bundle" | undefined;
    let payloadPath: string | undefined;
    if (!checkOnly) {
      const uid = typeof process.getuid === "function" ? process.getuid() : -1;
      if (uid !== 0) fail("请使用 sudo 运行安装器（写入 /opt/bittune 与 /usr/local/bin 需要 root）。");
      ({ sourceKind, payloadPath } = resolvePayload(options));
    }

    const targetUser = options.user || "root";

    if(!checkOnly)mkdirSync(INSTALL_ROOT, { recursive: true });
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

    const preflight = await runChecks({softwareOnly:options.softwareOnly});
    const activeComponents = sourceKind ? applicableComponents(sourceKind) : [];
    const installContext: InstallContext = {
      installRoot: INSTALL_ROOT,
      targetUser,
      sourceKind: sourceKind ?? "network",
      payloadPath: payloadPath ?? "",
      ...(options.stageDir ? { stageAgentDir: options.stageDir } : {}),
      ...(options.requirementsPath ? { requirementsPath: options.requirementsPath } : {}),
      ...(options.coreWheelDir ? { coreWheelDir: options.coreWheelDir } : {}),
      appendLog,
    };

    const plan: InstallReport["plan"] = [];
    for (const component of activeComponents) {
      const description = await component.describe(installContext);
      plan.push({ id: component.id, label: component.label, required: component.required, version: description.version, source: description.source });
    }

    report = {
      software_only:!!options.softwareOnly,
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

    if (!options.yes && !(await confirmPlan(jsonMode))) {
      emit(["已取消：未做任何修改。非交互或自动安装请追加 --yes。"]);
      finishJson(jsonMode, report);
      return 0;
    }

    emit(["", "[阶段 3/5] 执行安装"]);
    release=await lockInstallation(INSTALL_ROOT);
    for (let index = 0; index < activeComponents.length; index += 1) {
      const component = activeComponents[index]!;
      const tag = `[${index + 1}/${activeComponents.length}]`;
      let entry: ExecutedEntry;
      try {
        if ((await component.detect(installContext)) === "satisfied") {
          entry = { id: component.id, label: component.label, status: "satisfied", summary: "已满足，跳过" };
          emit([`${tag} ${component.label} …… 跳过（已满足）`]);
        } else {
          if(!snapshotId){await quiesceCurrentWorkspace();const snapshot=await createSoftwareSnapshot(INSTALL_ROOT,installationLauncherPath());snapshotId=snapshot.id;report.backup_id=snapshotId;emit([`原软件备份：${snapshotId}`]);}
          const summary = await component.install(installContext);
          await component.verify(installContext);
          entry = { id: component.id, label: component.label, status: "installed", summary };
          emit([`${tag} ${component.label} …… 完成（${summary}）`]);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof ComponentSkipped && !component.required) {
          report.executed.push({id:component.id,label:component.label,status:"skipped",summary:message});
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
        await recover();
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
    // Optional tooling may change Python dependencies after Core was installed.
    for(const component of activeComponents.filter(c=>c.required))await component.verify(installContext);
    report.verification = await runChecks({softwareOnly:options.softwareOnly});
    emit(renderCheckLines(report.verification));

    const counts = tally(report.executed);
    if(snapshotId)await markSoftwareSnapshot(INSTALL_ROOT,snapshotId,"installed");
    finished=true;
    emit([
      "",
      "[阶段 5/5] 完成",
      `结果：${counts.satisfied} 已满足 · ${counts.installed} 新装 · ${counts.skipped} 跳过${report.warnings.length ? ` · ${report.warnings.length} 条警告` : ""}`,
      ...report.warnings.map((warning) => `  ⚠ ${warning}`),
      "",
      `下一步（以 ${targetUser} 身份执行）：`,
      `  export BITTUNE_AGENT_LLM_API_KEY='你的 Agent 模型密钥'`,
      "  bittune configure --base-url https://endpoint/v1 --model-id your-tool-capable-model",
      "  bittune doctor",
      "  bittune",
    ]);
    finishJson(jsonMode, report);
    return 0;
  } catch (error) {
    await recover();
    console.error(error instanceof Error ? error.message : String(error));
    if(report)finishJson(jsonMode,report);
    return 1;
  } finally {
    await release?.();
  }
}
