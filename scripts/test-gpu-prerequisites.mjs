import { spawnSync } from "node:child_process";

if (process.platform !== "linux") {
  console.error("validation_required: real GPU acceptance must run on a Linux host with NVIDIA GPU access.");
  process.exitCode = 2;
} else {
  const result = spawnSync("nvidia-smi", ["--query-gpu=uuid,name,driver_version", "--format=csv,noheader"], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    console.error("validation_required: nvidia-smi must be available and expose at least one NVIDIA GPU.");
    if (result.stderr.trim()) console.error(result.stderr.trim());
    process.exitCode = 2;
  } else {
    console.log(`GPU prerequisite available:\n${result.stdout.trim()}`);
  }
}
