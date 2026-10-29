import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { GenericPolicyInput, PolicyOutcome } from "./runtime-policy.ts";
import { CoreError } from "./core-client.ts";

/** Validated by the Core's shared JSON schema, never supplied by tool arguments. */
export interface TaskScope {
	schema_version: 1;
	allow_execution: boolean;
	runtime_specs?: Array<Record<string, unknown>>;
	preparation_commands?: string[];
	experiment_budget?: { profile_hash: string; max_suite_calls: number; max_points: number; max_requests: number };
	plan_ids: string[];
	service_instance_ids: string[];
	record_ids: string[];
	read_paths: string[];
	inventory_commands: string[];
	scope_hash: string;
}

export function evaluateScopedGeneric(input: GenericPolicyInput, scope: TaskScope): PolicyOutcome {
	if (input.toolName === "bash" && scope.allow_execution && scope.preparation_commands?.includes(input.command ?? "")) {
		return { decision: "ask", reason: "宿主授权的精确准备命令；确认后执行镜像准备及网络写入。" };
	}
	if (input.toolName === "bash" && scope.inventory_commands.includes(input.command ?? "")) {
		return { decision: "allow", reason: "任务范围内固定的GPU占用查询。" };
	}
	if (input.toolName === "read" && input.path) {
		try {
			const target = realpathSync(resolve(input.cwd, input.path));
			for (const root of input.protectedRoots) {
				let canonical = resolve(root);
				try { canonical = realpathSync(canonical); } catch { /* A not-yet-created protected root still applies. */ }
				if (target === canonical || target.startsWith(canonical + sep)) {
					return { decision: "deny", reason: "task_scope_denied：受管配置/证据目录不可通过文件工具读取。" };
				}
			}
			if (scope.read_paths.includes(target) && statSync(target).isFile()) {
				return { decision: "allow", reason: "任务范围内明确授权的文件。" };
			}
		} catch { /* Nonexistent paths are not authorized. */ }
	}
	return { decision: "deny", reason: "task_scope_denied：指定资源任务只允许精确文件读取和固定GPU占用查询；任意shell、全局枚举和文件修改均未授权。" };
}

export function compactReportResult(value: unknown): unknown {
	const result = value as { data?: { report?: Record<string, unknown> } };
	const report = result?.data?.report;
	if (!report) return value;
	const coverage = report.coverage as Record<string, unknown>;
	if (coverage?.version !== "report-coverage-v1" || !Number.isInteger(coverage.metric_claims_count) || !Number.isInteger(coverage.suite_claims_count)) {
		throw new CoreError("report_coverage_mismatch", "Core未返回可核对的覆盖记录，不能报告完成；请核对Runtime/Core版本。");
	}
	const suites = (coverage?.suites ?? []) as Array<Record<string, unknown>>;
	return { ...result, data: { ...result.data, report: {
		report_id: report.report_id, title: report.title, artifact_ids: report.artifact_ids,
		coverage: { ...coverage, suites: suites.map(({ rows: _rows, ...summary }) => summary) },
	} } };
}
