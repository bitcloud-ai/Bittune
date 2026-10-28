// Re-read the current Core facts and hash-checked artifacts. No legacy Store.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CoreClient } from "../packages/bittune-runtime/src/harness/core-client.ts";

assert.equal(process.platform, "linux", "Real acceptance must run on Linux");
const manifestPath = process.argv[2] || process.env.BITTUNE_ACCEPT_MANIFEST;
assert.ok(manifestPath, "Pass the JSON manifest from run-managed-gpu-smoke.mjs");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.equal(manifest.status, "completed", "The real loop did not complete");
assert.deepEqual(manifest.engines.map((engine) => engine.runtime_kind).sort(), ["sglang", "vllm"]);
const core = await CoreClient.start({ coreHome: manifest.config.core_home });
const sessionId = `verify-${Date.now()}`;
const inspect = (params) => core.request("inspect_records", params, { sessionId });
try {
	for (const step of manifest.steps.filter((step) => step.result?.run_id)) {
		const run = await inspect({ kind: "run", id: step.result.run_id });
		assert.equal(run.status, "completed");
		assert.equal(run.tool_name, step.tool);
		assert.equal(run.session_id, manifest.session_id);
		for (const artifact of run.artifacts) await inspect({ kind: "artifact", id: artifact.artifact_id });
	}
	for (const engine of manifest.engines) {
		assert.equal(engine.status, "completed");
		const plan = (await inspect({ kind: "deployment_plan", id: engine.plan_id })).payload;
		assert.equal(plan.status, "frozen");
		assert.equal(plan.runtime_spec.runtime_kind, engine.runtime_kind);
		await inspect({ kind: "hardware_snapshot", id: plan.hardware_snapshot_id });
		const service = (await inspect({ kind: "service_instance", id: engine.service_instance_id })).payload;
		assert.equal(service.plan_id, engine.plan_id);
		assert.equal(service.ownership, "managed");
		assert.equal(service.desired, "stopped");
		const observed = await core.request("inspect_service", { action: "get", service_instance_id: engine.service_instance_id }, { sessionId });
		assert.equal(observed.data.current_container_state.running, false, "Container is still running");
		const stop = await inspect({ kind: "run", id: engine.stop_run_id });
		assert.equal(stop.tool_name, "deploy_service");
		assert.equal(stop.input.action, "stop");
		assert.equal(stop.input.service_instance_id, engine.service_instance_id);
		assert.equal(stop.status, "completed");
		assert.equal(engine.benchmark_result_ids.length, 2);
		for (const id of engine.benchmark_result_ids) {
			const benchmark = (await inspect({ kind: "benchmark_result", id })).payload;
			assert.equal(benchmark.service_instance_id, engine.service_instance_id);
			assert.equal(benchmark.provenance, "measured");
			assert.equal(benchmark.provider.name, "evalscope");
			assert.equal(benchmark.metrics.success_rate, 1);
			assert.ok(benchmark.workload_hash);
		}
		const report = (await inspect({ kind: "report", id: engine.report_id })).payload;
		assert.deepEqual(report.references.benchmark_result_ids.map((entry) => entry.id), engine.benchmark_result_ids);
		assert.ok(report.artifact_ids.length);
		for (const id of report.artifact_ids) await inspect({ kind: "artifact", id });
	}
	console.log("Real Core evidence verified for vLLM and SGLang: frozen plans, managed services, EvalScope, reports, artifacts and stops.");
} finally {
	await core.stop();
}
