import { spawnSync } from "node:child_process";
import { StateStore } from "../packages/bittune-capabilities/src/shared/state-store.ts";

if (process.platform !== "linux") {
  console.error("validation_required: real Runtime acceptance must run on Linux with NVIDIA GPU access.");
  process.exit(2);
}

for (const [command, args] of [["nvidia-smi", ["--query-gpu=uuid,name", "--format=csv,noheader"]], ["docker", ["version", "--format", "{{.Server.Version}}"]], ["evalscope", ["perf", "--help"]]]) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    console.error(`validation_required: ${command} ${args.join(" ")} must succeed.`);
    process.exit(2);
  }
}

const stateRoot = process.env.BITTUNE_STATE_DIR?.trim();
const required = [
  ["vLLM", "BITTUNE_ACCEPT_VLLM_OBSERVE_RUN", "observe_runtime_capability", false],
  ["vLLM", "BITTUNE_ACCEPT_VLLM_START_RUN", "start_managed_service", false],
  ["vLLM", "BITTUNE_ACCEPT_VLLM_READY_RUN", "wait_for_managed_service_ready", false],
  ["vLLM", "BITTUNE_ACCEPT_VLLM_PROBE_RUN", "probe_managed_endpoint", false],
  ["vLLM", "BITTUNE_ACCEPT_VLLM_BENCHMARK_RUN", "run_performance_test", true],
  ["vLLM", "BITTUNE_ACCEPT_VLLM_STOP_RUN", "stop_managed_service", false],
  ["SGLang", "BITTUNE_ACCEPT_SGLANG_OBSERVE_RUN", "observe_runtime_capability", false],
  ["SGLang", "BITTUNE_ACCEPT_SGLANG_START_RUN", "start_managed_service", false],
  ["SGLang", "BITTUNE_ACCEPT_SGLANG_READY_RUN", "wait_for_managed_service_ready", false],
  ["SGLang", "BITTUNE_ACCEPT_SGLANG_PROBE_RUN", "probe_managed_endpoint", false],
  ["SGLang", "BITTUNE_ACCEPT_SGLANG_BENCHMARK_RUN", "run_performance_test", true],
  ["SGLang", "BITTUNE_ACCEPT_SGLANG_STOP_RUN", "stop_managed_service", false],
];
if (!stateRoot || required.some(([, name]) => !process.env[name]?.trim())) {
  console.error("validation_required: set BITTUNE_STATE_DIR and all BITTUNE_ACCEPT_<RUNTIME>_<STEP>_RUN values after executing both managed Runtime flows.");
  process.exit(2);
}

const store = new StateStore(stateRoot);
try {
  for (const [runtime, variable, toolName, needsArtifact] of required) {
    const runId = process.env[variable];
    const { manifest, observation } = await store.getRun(runId);
    if (manifest.tool_name !== toolName || manifest.status !== "completed" || !observation.ok || (observation.data?.runtime_kind !== undefined && observation.data.runtime_kind !== runtime.toLowerCase())) {
      throw new Error(`${variable} is not a successful ${runtime} ${toolName} Run.`);
    }
    if (needsArtifact && manifest.artifacts.length === 0) throw new Error(`${variable} has no Benchmark Artifact.`);
  }
  console.log("Real GPU acceptance evidence is complete for vLLM and SGLang.");
} finally {
  store.close();
}
