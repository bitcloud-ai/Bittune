import { BittuneError } from "./errors.ts";
import { runCommand } from "./process.ts";

export interface SglangCliProfile {
  image_reference: string;
  python_executable: "python3" | "python";
  version?: string;
  flags: string[];
  diagnostics: string;
}

function extractFlags(help: string): string[] {
  return Array.from(new Set(help.match(/--[a-z][a-z0-9-]*/gi) ?? [])).sort();
}

function extractVersion(value: string): string | undefined {
  return /(?:sglang(?:\s*,?\s*version)?|version)\s*[:=]?\s*(v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?)/i.exec(value)?.[1];
}

const REQUIRED_FLAGS = ["--model-path", "--served-model-name", "--host", "--port"];

/**
 * SGLang images do not share a stable Docker entrypoint contract. The adapter
 * only tries two fixed Python executables and uses the selected image help as
 * the authority for every non-default launch argument.
 */
export async function inspectSglangCliProfile(input: { image_reference: string; run_reference: string }, signal?: AbortSignal): Promise<SglangCliProfile> {
  const attempts: Array<{ executable: "python3" | "python"; result: Awaited<ReturnType<typeof runCommand>> }> = [];
  for (const executable of ["python3", "python"] as const) {
    const result = await runCommand("docker", ["run", "--rm", "--pull=never", "--entrypoint", executable, input.run_reference, "-m", "sglang.launch_server", "--help"], { signal, timeoutMs: 60_000, maxBytes: 2 * 1024 * 1024 });
    attempts.push({ executable, result });
    const flags = extractFlags(`${result.stdout}\n${result.stderr}`);
    if (result.exit_code !== 0 || !REQUIRED_FLAGS.every((flag) => flags.includes(flag))) continue;
    const version = await runCommand("docker", ["run", "--rm", "--pull=never", "--entrypoint", executable, input.run_reference, "-c", "from sglang import __version__; print(__version__)"], { signal, timeoutMs: 60_000, maxBytes: 64 * 1024 });
    const diagnostics = `${attempts.map((attempt) => `$ ${attempt.executable} -m sglang.launch_server --help\n${attempt.result.stdout}\n${attempt.result.stderr}`).join("\n")}\n$ ${executable} -c 'from sglang import __version__; print(__version__)'\n${version.stdout}\n${version.stderr}`;
    const detectedVersion = extractVersion(`${version.stdout}\n${version.stderr}\n${result.stdout}\n${result.stderr}`);
    return { image_reference: input.image_reference, python_executable: executable, ...(detectedVersion ? { version: detectedVersion } : {}), flags, diagnostics };
  }
  const diagnostics = attempts.map((attempt) => `$ ${attempt.executable} -m sglang.launch_server --help\n${attempt.result.stdout}\n${attempt.result.stderr}`).join("\n");
  throw new BittuneError("runtime_cli_incompatible", `Runtime image ${input.image_reference} does not expose the required SGLang launch_server flags.`, false, { image_reference: input.image_reference, required_flags: REQUIRED_FLAGS, diagnostics: diagnostics.slice(-8_000) });
}
