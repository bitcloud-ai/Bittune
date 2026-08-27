import { runCommand } from "../../../../bittune-capabilities/src/shared/process.ts";
import { readRuntimePolicy, runtimePolicyPath } from "../../../../bittune-capabilities/src/shared/runtime-policy.ts";

/**
 * One catalog drives both `bittune doctor` and the installer preflight so the
 * two surfaces can never drift: what the installer claims to satisfy is
 * exactly what the doctor later verifies.
 */
export type CheckState = "ok" | "missing" | "unavailable";

export interface CheckResult {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
}

export type CheckScope = "host" | "tooling" | "policy";

export interface CheckDefinition {
  id: string;
  label: string;
  /** Host prerequisites are never installed by Bittune; tooling is bootstrapped by the online installer. */
  scope: CheckScope;
  probe(): Promise<CheckResult>;
}

type ProbeOutcome = { ok: true; output: string } | { ok: false; error: string };

export async function probeCommand(command: string, args: string[], timeoutMs = 10_000): Promise<ProbeOutcome> {
  try {
    const result = await runCommand(command, args, { timeoutMs, maxBytes: 128 * 1024 });
    return result.exit_code === 0
      ? { ok: true, output: `${result.stdout}\n${result.stderr}`.trim() }
      : { ok: false, error: firstLine(result.stderr || result.stdout || `exit ${result.exit_code}`) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/)[0]!.slice(0, 160);
}

function outcome(value: ProbeOutcome): { ok: boolean; output: string; error: string } {
  return value.ok
    ? { ok: true, output: value.output, error: "" }
    : { ok: false, output: "", error: value.error };
}

const CHECKS: CheckDefinition[] = [
  {
    id: "docker-daemon",
    label: "Docker daemon",
    scope: "host",
    async probe() {
      const version = outcome(await probeCommand("docker", ["version", "--format", "{{json .}}"]));
      if (!version.ok) {
        return { id: "docker-daemon", label: this.label, state: "unavailable", detail: `unavailable (${firstLine(version.error)}); managed deployment cannot start` };
      }
      let serverVersion = "unknown";
      try { serverVersion = String((JSON.parse(version.output) as { Server?: { Version?: unknown } }).Server?.Version ?? "unknown"); } catch { /* report availability only */ }
      return { id: "docker-daemon", label: this.label, state: "ok", detail: `available (server ${serverVersion})` };
    },
  },
  {
    id: "nvidia-driver",
    label: "NVIDIA driver / GPUs",
    scope: "host",
    async probe() {
      const gpus = outcome(await probeCommand("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], 8_000));
      if (!gpus.ok || !gpus.output) {
        return { id: this.id, label: this.label, state: "missing", detail: "unavailable (nvidia-smi failed or not installed)" };
      }
      const names = gpus.output.split(/\r?\n/).filter(Boolean);
      return { id: this.id, label: this.label, state: "ok", detail: names.length === 1 ? names[0]! : `${names.length} detected (first: ${names[0]})` };
    },
  },
  {
    id: "nvidia-container-runtime",
    label: "NVIDIA container runtime",
    scope: "host",
    async probe() {
      const info = outcome(await probeCommand("docker", ["info", "--format", "{{json .}}"]));
      if (!info.ok) {
        return { id: this.id, label: this.label, state: "missing", detail: "unknown (docker daemon unavailable)" };
      }
      let runtimes: string[] = [];
      try { runtimes = Object.keys((JSON.parse(info.output) as { Runtimes?: Record<string, unknown> }).Runtimes ?? {}); } catch { /* unknown registration */ }
      return runtimes.includes("nvidia")
        ? { id: this.id, label: this.label, state: "ok", detail: "registered" }
        : { id: this.id, label: this.label, state: "missing", detail: "not registered; managed GPU containers will fail to start (install NVIDIA Container Toolkit)" };
    },
  },
  {
    id: "evalscope-cli",
    label: "EvalScope perf CLI",
    scope: "tooling",
    async probe() {
      const found = outcome(await probeCommand("evalscope", ["--version"], 15_000));
      if (!found.ok) {
        return { id: this.id, label: this.label, state: "missing", detail: `unavailable (${firstLine(found.error)}); benchmarks need it (pip install 'evalscope[perf]==1.10.0')` };
      }
      return { id: this.id, label: this.label, state: "ok", detail: found.output ? `available (${firstLine(found.output).slice(0, 80)})` : "available" };
    },
  },
  {
    id: "hf-cli",
    label: "Hugging Face CLI",
    scope: "tooling",
    async probe() {
      const found = outcome(await probeCommand("hf", ["version"], 15_000));
      if (!found.ok) {
        return { id: this.id, label: this.label, state: "missing", detail: `unavailable (${firstLine(found.error)}); model download needs it (pip install 'huggingface_hub[cli]==1.27.0')` };
      }
      return { id: this.id, label: this.label, state: "ok", detail: found.output ? `available (${firstLine(found.output).slice(0, 80)})` : "available" };
    },
  },
  {
    id: "runtime-policy",
    label: "Runtime policy",
    scope: "policy",
    async probe() {
      try {
        const policy = await readRuntimePolicy();
        return policy.unrestricted
          ? { id: this.id, label: this.label, state: "ok", detail: `not present at ${policy.path}; all local Runtime images are allowed` }
          : { id: this.id, label: this.label, state: "ok", detail: `${policy.path} allows ${policy.allowedRuntimeRepositories.length} repositories` };
      } catch (error) {
        return { id: this.id, label: this.label, state: "unavailable", detail: `invalid at ${runtimePolicyPath()}: ${firstLine(error instanceof Error ? error.message : String(error))}` };
      }
    },
  },
];

/** Ordered copy; callers must not mutate the catalog. */
export function checkCatalog(): readonly CheckDefinition[] {
  return CHECKS;
}

export async function runChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of CHECKS) results.push(await check.probe());
  return results;
}

/** Fixed-width lines for plain-text reports (doctor and installer share this shape). */
export function renderCheckLines(results: readonly CheckResult[]): string[] {
  return results.map((check) => `  ${check.label.padEnd(26)}${check.detail}`);
}
