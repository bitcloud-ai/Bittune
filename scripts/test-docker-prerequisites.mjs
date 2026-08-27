import { spawnSync } from "node:child_process";

const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", windowsHide: true });
if (result.error || result.status !== 0 || !result.stdout.trim()) {
  console.error("validation_required: Docker CLI and a reachable Docker daemon are required for Docker integration acceptance.");
  if (result.stderr.trim()) console.error(result.stderr.trim());
  process.exitCode = 2;
} else {
  console.log(`Docker prerequisite available: server ${result.stdout.trim()}`);
}
