// Deterministic Harness acceptance, using the real managed tools and Core.
// Usage: node --import tsx scripts/run-managed-gpu-smoke.mjs config.json --execute
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { CoreClient } from "../packages/bittune-runtime/src/harness/core-client.ts";
import { createManagedTools } from "../packages/bittune-runtime/src/harness/managed-tools.ts";

assert.equal(process.platform, "linux", "Real GPU acceptance requires Linux");
assert.equal(process.argv[3], "--execute", "Pass --execute for the authorized deployment and stop");
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.ok(config.core_home && config.output && config.model_ref && config.runtimes?.length);
const core = await CoreClient.start({ coreHome: config.core_home });
const sessionId = `gpu-smoke-${Date.now()}`;
const record = { schema_version: 1, session_id: sessionId, config, steps: [], engines: [], status: "running" };
const persist = () => writeFileSync(config.output, JSON.stringify(record, null, 2) + "\n");
const tools = createManagedTools({ client: () => core }, {
	askApproval: async (title, message) => {
		record.steps.push({ authorization: "user-authorized --execute", title, message });
		persist();
		return true;
	},
});
async function call(name, params) {
	console.log(`${new Date().toISOString()} ${name} ${params.action ?? ""}`);
	const result = await tools.find((tool) => tool.name === name).execute(
		`smoke-${record.steps.length}`, params, undefined, undefined,
		{ sessionManager: { getSessionId: () => sessionId }, hasUI: false, ui: {} },
	);
	record.steps.push({ tool: name, params, result: result.details });
	persist();
	if (result.details?.code) throw new Error(JSON.stringify(result.details));
	return result.details;
}
async function waitForIdleGpu() {
	for (;;) {
		const probe = spawnSync("nvidia-smi", ["--query-compute-apps=pid", "--format=csv,noheader"], { encoding: "utf8" });
		assert.equal(probe.status, 0, probe.stderr);
		if (!probe.stdout.trim()) return;
		console.log("GPU occupied; waiting without stopping other processes");
		await new Promise((resolve) => setTimeout(resolve, 30_000));
	}
}
try {
	for (const runtime of config.runtimes) {
		await waitForIdleGpu();
		const engine = { runtime_kind: runtime.runtime_spec.runtime_kind, benchmark_result_ids: [] };
		record.engines.push(engine);
		try {
			const snapshot = (await call("inspect_environment", {})).data.hardware_snapshot;
			const plan = (await call("plan_deployment", {
				action: "create", prior_source: "user_specified", goal: "Takeover low-load lifecycle acceptance",
				model_ref: config.model_ref, hardware_snapshot_id: snapshot.hardware_snapshot_id,
				runtime_spec: runtime.runtime_spec, serving_spec: runtime.serving_spec,
			})).data.plan;
			engine.plan_id = plan.plan_id;
			const validation = await call("plan_deployment", { action: "validate", plan_id: plan.plan_id });
			assert.equal(validation.data.validation.state, "valid", JSON.stringify(validation.data.validation));
			await call("plan_deployment", { action: "freeze", plan_id: plan.plan_id });
			const service = (await call("deploy_service", { action: "start", plan_id: plan.plan_id, ready_timeout_seconds: 300 })).data.service;
			engine.service_instance_id = service.service_instance_id;
			assert.equal(service.observed_state, "ready");
			await call("inspect_service", { action: "get", service_instance_id: service.service_instance_id });
			for (let repeat = 0; repeat < 2; repeat++) {
				const benchmark = (await call("benchmark_service", { service_instance_id: service.service_instance_id, workload: config.workload })).data.benchmark_result;
				assert.equal(benchmark.provenance, "measured");
				assert.equal(benchmark.metrics.success_rate, 1, JSON.stringify(benchmark.metrics));
				engine.benchmark_result_ids.push(benchmark.benchmark_result_id);
			}
			const comparison = await call("compare_results", { benchmark_result_ids: engine.benchmark_result_ids, record: true });
			assert.equal(comparison.data.comparison.comparable, true);
			const report = await call("write_report", {
				title: `Takeover ${engine.runtime_kind} smoke`, scope: "Low-load Harness integration only",
				narrative: "Two identical workloads exercise the real managed path. These short runs do not establish production capacity or a tuning improvement.",
				conclusion: "Managed lifecycle, real measurement, comparison and report completed.",
				references: { plan_ids: [plan.plan_id], benchmark_result_ids: engine.benchmark_result_ids, service_instance_ids: [service.service_instance_id] },
				metric_claims: engine.benchmark_result_ids.map((id) => ({ benchmark_result_id: id, metric: "output_tokens_per_second" })),
			});
			engine.report_id = report.data.report.report_id;
			engine.status = "completed";
		} catch (error) {
			engine.status = "failed";
			engine.error = String(error);
		} finally {
			// A failed start can already have persisted a managed service. Clean
			// only this plan's records, using the same ownership checks as users.
			if (engine.plan_id) {
				const services = await core.request("inspect_records", { kind: "service_instance", plan_id: engine.plan_id }, { sessionId });
				for (const fact of services.records) {
					const stopped = await call("deploy_service", { action: "stop", service_instance_id: fact.payload.service_instance_id });
					engine.stop_run_id = stopped.run_id;
				}
			}
			persist();
		}
	}
	record.status = record.engines.every((engine) => engine.status === "completed") ? "completed" : "failed";
	if (record.status !== "completed") process.exitCode = 1;
} finally {
	persist();
	await core.stop();
}
