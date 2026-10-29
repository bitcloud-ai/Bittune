	import { Type, type TSchema } from "typebox";
	import { MANAGED_PARAMETERS, MANAGED_REPORT_REFERENCE_KEYS, MANAGED_ACCEPTANCE_SCHEMA } from "./managed-parameters.ts";
	import type { AgentToolResult } from "@earendil-works/pi-agent-core";
	import { Text } from "@earendil-works/pi-tui";
	import type { ExtensionContext, ToolDefinition } from "../core/extensions/types.ts";
	import { CoreClient, CoreError } from "./core-client.ts";
		import { COPY, humanizeUserText, toolLabel } from "./tui/copy.ts";
import { compactReportResult, type TaskScope } from "./task-scope.ts";

/**
 * The BitTune managed tools. Schemas carry only business references and
 * bounded configuration - no free shell, container IDs, URLs, image tags,
 * paths or EvalScope argv. The Python Core is the authority: every call here
 * is one Core request, and the Core re-validates ownership and prerequisites.
 */

export const MANAGED_TOOL_NAMES = [
	"inspect_environment",
	"inspect_service",
	"plan_deployment",
	"deploy_service",
	"benchmark_service",
	"benchmark_suite",
	"export_deliverable",
	"compare_results",
	"write_report",
	"inspect_records",
] as const;

export type ManagedToolName = (typeof MANAGED_TOOL_NAMES)[number];

const MODEL_ID = Type.String({ description: "模型业务标识/服务模型名，例如 org/model；不能填文件路径", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)?$" });
const MODEL_REF = Type.Union([
	Type.Object({
		schema_version: Type.Literal(1), model_id: MODEL_ID,
		revision: Type.String({ description: "本机 Hub 缓存中的精确 revision，不要猜测", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$" }),
		quantization: Type.Optional(Type.String()),
	}, { additionalProperties: false, description: "精确 Hub 缓存引用" }),
	Type.Object({
		schema_version: Type.Literal(1), model_id: MODEL_ID,
		local_path: Type.String({ minLength: 1, description: "用户指定的已有平铺 Transformers 模型目录的绝对路径；只读挂载，不复制/下载。Core 散列内容生成 revision，创建时省略 revision" }),
		revision: Type.Optional(Type.String({ pattern: "^local-[a-f0-9]{64}$", description: "仅复用 Core 已返回的内容 revision，不能自行构造" })),
		quantization: Type.Optional(Type.String()),
	}, { additionalProperties: false, description: "已有本地目录；identity 由 Core 生成" }),
]);
const RUNTIME_SPEC = Type.Object({
	schema_version: Type.Literal(1),
	runtime_kind: Type.Union([Type.Literal("vllm"), Type.Literal("sglang")]),
	image_repository: Type.String({ description: "已核验的本机镜像 repository，不含 tag 或 @digest", pattern: "^[a-z0-9][a-z0-9._:/-]{0,255}$" }),
	image_digest: Type.String({ description: "实际镜像 digest；不得用占位符探测接口", pattern: "^sha256:(?!0{64}$)[a-f0-9]{64}$" }),
	runtime_major: Type.Optional(Type.String({ pattern: "^[0-9]{1,16}$" })),
}, { additionalProperties: false });
const WORKLOAD_FIELDS = {
	schema_version: Type.Literal(2),
	concurrency: Type.Integer({ minimum: 1, maximum: 4096 }),
	request_count: Type.Integer({ minimum: 1, maximum: 1000000 }),
	input_tokens: Type.Integer({ minimum: 1, maximum: 1000000 }),
	output_tokens: Type.Integer({ minimum: 1, maximum: 1000000 }),
	request_timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 7200 })),
	warmup_requests: Type.Optional(Type.Integer({ minimum: 0 })),
	warmup_timeout_seconds: Type.Optional(Type.Integer({ minimum: 1 })),
	seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 4294967295, description: "EvalScope dataset RNG and OpenAI request sampling seed." })), stream: Type.Optional(Type.Boolean()),
	ignore_eos: Type.Optional(Type.Boolean()), temperature: Type.Optional(Type.Number({ minimum: 0 })), top_p: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
};
const WORKLOAD = Type.Union([
	Type.Object({ ...WORKLOAD_FIELDS, mode: Type.Literal("closed_loop") }, { additionalProperties: false }),
	Type.Object({ ...WORKLOAD_FIELDS, mode: Type.Literal("open_loop"), request_rate: Type.Number({ exclusiveMinimum: 0 }) }, { additionalProperties: false }),
], { description: "schema_version=2；固定 token-ID 合成负载，input_tokens 含前缀，需要 /v1/completions 支持 token IDs；Core 核验实际 token 数并冻结 workload hash" });
function adapterSchema(parameters: readonly { name: string; type: string; default: unknown; values?: readonly string[]; minimum?: number; maximum?: number; exclusive_minimum?: boolean; unit?: string }[], description: string) {
	const properties: Record<string, TSchema> = {};
	for (const parameter of parameters) {
		const options = { default: parameter.default, description: parameter.unit ? `单位：${parameter.unit}` : parameter.name };
		const bounds = { ...(parameter.minimum !== undefined ? { [parameter.exclusive_minimum ? "exclusiveMinimum" : "minimum"]: parameter.minimum } : {}), ...(parameter.maximum !== undefined ? { maximum: parameter.maximum } : {}) };
		let schema: TSchema;
		switch (parameter.type) {
			case "enum": schema = Type.Union(parameter.values!.map((value) => Type.Literal(value)), options); break;
			case "boolean": schema = Type.Boolean(options); break;
			case "integer": schema = Type.Integer({ ...options, ...bounds }); break;
			case "number": schema = Type.Number({ ...options, ...bounds }); break;
			case "integer_array": schema = Type.Array(Type.Integer(bounds), { ...options, uniqueItems: true }); break;
			default: throw new Error(`Unsupported Core parameter type: ${parameter.type}`);
		}
		properties[parameter.name] = Type.Optional(schema);
	}
	return Type.Object(properties, { additionalProperties: false, description });
}
const SERVING_SPEC = Type.Union([
	adapterSchema(MANAGED_PARAMETERS.vllm, "vLLM 当前受管参数；省略字段使用 Core 默认值"),
	adapterSchema(MANAGED_PARAMETERS.sglang, "SGLang 当前受管参数；省略字段使用 Core 默认值"),
]);
const LOOPBACK_ENDPOINT = Type.Object(
	{
		url: Type.String({ description: "本机回环地址，仅 http 或 https 的 127.0.0.1、localhost、::1" }),
		model_id: Type.String({ description: "端点上的模型 ID" }),
		revision: Type.Optional(Type.String({ description: "模型 revision" })),
	},
	{ additionalProperties: false, description: "仅用于外部回环端点；与 service_instance_id 二选一。已有受管服务 ID 时省略 endpoint" },
);
const SUITE_SUBJECT_FIELDS = {
	intent: Type.Union([Type.Literal("performance_sweep"), Type.Literal("correctness"), Type.Literal("cache_pair"), Type.Literal("pd_planning")]),
	profile_path: optionalString("自定义档案路径；省略则用内置短档案"),
	package: Type.Optional(Type.Union([Type.Literal("short"), Type.Literal("full")])),
	destructive: Type.Optional(Type.Boolean()),
	correctness_pack_path: optionalString("正确性数据包路径"),
	suite_result_id: optionalString("推算引用的扫描"),
	cache_pair_result_id: optionalString("推算引用的缓存对"),
};

type AnyToolDefinition = ToolDefinition<any, any, any>;

function optionalString(description: string) {
	return Type.Optional(Type.String({ description }));
}

const Schemas = {
	inspect_environment: Type.Object(
		{
			probes: Type.Optional(Type.Array(Type.Union([Type.Literal("nvbandwidth"), Type.Literal("nccl"), Type.Literal("dcgm")]), { description: "可选深度探测；省略则只做现有清点" })),
		},
		{ additionalProperties: false },
	),
	inspect_service: Type.Object(
		{
			action: Type.Union([Type.Literal("list"), Type.Literal("get")], { description: "list：列出现有服务观察；get：按 service_instance_id 重新观察" }),
			service_instance_id: optionalString("get 操作的服务 ID"),
		},
		{ additionalProperties: false },
	),
		plan_deployment: Type.Union([
			Type.Object(
				{
					action: Type.Literal("create"),
					prior_source: Type.Union([
						Type.Literal("user_specified"),
						Type.Literal("none"),
					], { description: "先验从哪来。仅 create 必填" }),
						based_on_plan_id: optionalString("把已有计划的模型、引擎和服务参数抄进新草稿。不修改原计划"),
					goal: optionalString("部署目标（一句话）"),
					rationale: optionalString("方案理由"),
					model_ref: Type.Optional(MODEL_REF),
						runtime_spec: Type.Optional(RUNTIME_SPEC),
						serving_spec: Type.Optional(SERVING_SPEC),
					hardware_snapshot_id: optionalString("引用的 HardwareSnapshot ID"),
					resource_choices: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "有限的资源选择（GPU 数/显存预算等），Core 校验后并入计划" })),
				},
				{ additionalProperties: false },
			),
			Type.Object(
				{
					action: Type.Union([Type.Literal("validate"), Type.Literal("freeze")]),
					plan_id: optionalString("validate/freeze 的计划 ID"),
				},
				{ additionalProperties: false },
			),
		]),
	deploy_service: Type.Object(
		{
			action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("recover")]),
			plan_id: optionalString("start 使用的 frozen plan ID"),
			service_instance_id: optionalString("stop/recover 的受管服务 ID"),
			ready_timeout_seconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 900, description: "start 后等待 Ready 的秒数（默认 300；0 表示启动即返回）" })),
		},
		{ additionalProperties: false },
	),
	benchmark_service: Type.Union([
		Type.Object(
			{
				service_instance_id: Type.String({ description: "ready 状态的 managed 服务 ID" }),
				workload: WORKLOAD,
				acceptance: Type.Optional(Type.Unsafe(MANAGED_ACCEPTANCE_SCHEMA)),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				endpoint: LOOPBACK_ENDPOINT,
				workload: WORKLOAD,
				acceptance: Type.Optional(Type.Unsafe(MANAGED_ACCEPTANCE_SCHEMA)),
			},
			{ additionalProperties: false },
		),
	]),
	benchmark_suite: Type.Union([
		Type.Object({ ...SUITE_SUBJECT_FIELDS, service_instance_id: Type.String({ description: "ready 状态的 managed 服务 ID" }) }, { additionalProperties: false }),
		Type.Object({ ...SUITE_SUBJECT_FIELDS, endpoint: LOOPBACK_ENDPOINT }, { additionalProperties: false }),
	]),
	export_deliverable: Type.Object(
		{
			intent: Type.Union([Type.Literal("result_workbook"), Type.Literal("evidence_pack")]),
			service_instance_id: Type.String({ description: "受管服务 ID" }),
			profile_id: optionalString("档案 id；省略则取该服务最新一组"),
			suite_result_id: optionalString("精确选择已有suite，与benchmark_result_ids二选一；不改事实"),
			benchmark_result_ids: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "导出该服务的指定单点实测；与suite_result_id二选一" })),
		},
		{ additionalProperties: false },
	),
	compare_results: Type.Union([
		Type.Object(
			{
				benchmark_result_ids: Type.Array(Type.String(), { minItems: 2, description: "要比较的单点结果 ID（至少两个）" }),
				objective: optionalString("比较目标（必须是已实测指标）"),
				hypothesis: optionalString("比较假设"),
				record: Type.Optional(Type.Boolean()),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				suite_points: Type.Array(Type.Object({
					suite_result_id: Type.String(),
					scenario_id: Type.String(),
					concurrency: Type.Integer({ minimum: 1 }),
					repeat: Type.Optional(Type.Integer({ minimum: 1 })),
				}, { additionalProperties: false }), { minItems: 2 }),
				objective: optionalString("比较目标"),
				hypothesis: optionalString("比较假设"),
				record: Type.Optional(Type.Boolean()),
			},
			{ additionalProperties: false },
		),
	]),
	write_report: Type.Object(
		{
			based_on_report_id: optionalString("原样保留已有报告全部引用，只修改文本；禁止重传引用数组"),
			suite_selections: Type.Optional(Type.Array(Type.Object({
				suite_result_id: Type.String(), metrics: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
			}, { additionalProperties: false }), { minItems: 1, description: "完整套件报告用此紧凑选择；Core覆盖全部行与重复点，不手抄suite_claims" })),
			title: Type.String({ description: "报告标题" }),
			scope: optionalString("范围：用户目标与实际尝试"),
			narrative: Type.String({ description: "叙述：解释与限制（含估算时显式标注 estimated）" }),
			conclusion: Type.String({ description: "结论" }),
			references: Type.Optional(Type.Object(Object.fromEntries(MANAGED_REPORT_REFERENCE_KEYS.map((key) => [key, Type.Optional(Type.Array(Type.String()))])), { additionalProperties: false, description: "使用 Core 支持的复数引用键；需要核验的完成动作应引用相应 Run 与事实" })),
				metric_claims: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown(), { description: "结构化性能断言；Core 只接受 BenchmarkResult 字段并在渲染时替换数值" }))),
				suite_claims: Type.Optional(Type.Array(Type.Object({
					suite_result_id: Type.String(),
					scenario_id: Type.String(),
					concurrency: Type.Integer({ minimum: 1 }),
					repeat: Type.Optional(Type.Integer({ minimum: 1 })),
					metric: Type.String(),
					label: optionalString("显示标签"),
				}, { additionalProperties: false }))),
				pd_claims: Type.Optional(Type.Array(Type.Object({
					pd_estimate_id: Type.String(),
					metric: Type.String(),
					label: optionalString("显示标签"),
				}, { additionalProperties: false }))),
			},
			{ additionalProperties: false },
		),
	inspect_records: Type.Object(
		{
			kind: Type.Union([
				Type.Literal("run"),
				Type.Literal("artifact"),
				Type.Literal("hardware_snapshot"),
				Type.Literal("deployment_plan"),
				Type.Literal("service_instance"),
				Type.Literal("benchmark_result"),
				Type.Literal("experiment"),
				Type.Literal("report"),
				Type.Literal("suite_result"),
				Type.Literal("correctness_result"),
				Type.Literal("cache_pair_result"),
				Type.Literal("pd_estimate"),
			], { description: "记录类型" }),
			id: optionalString("按 ID 读取"),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			tool_name: optionalString("run 过滤：工具名"),
			status: optionalString("run 过滤：completed/failed/cancelled/interrupted"),
			hardware_snapshot_id: optionalString("按硬件快照过滤"),
			model_id: optionalString("按模型 ID 过滤"),
			model_revision: optionalString("按模型 revision 过滤"),
			runtime_kind: optionalString("按 runtime_kind 过滤（vllm/sglang）"),
			workload_hash: optionalString("按 workload hash 过滤"),
			service_instance_id: optionalString("按服务实例过滤"),
			profile_id: optionalString("按档案 id 过滤扫描事实"),
			ownership: optionalString("服务过滤：managed/observed/external"),
			offset_bytes: Type.Optional(Type.Integer({ minimum: 0 })),
			max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 65536 })),
		},
		{ additionalProperties: false },
	),
} satisfies Record<ManagedToolName, unknown>;

export const MANAGED_TOOL_DESCRIPTIONS: Record<ManagedToolName, string> = {
	inspect_environment: "确定性地探测本机硬件与运行时环境，生成不可变 HardwareSnapshot（GPU、驱动、Docker、拓扑）。",
	inspect_service: "只观察服务状态：已记录的服务，以及本机已发布端口、镜像或命令能对上 vLLM/SGLang 的未跟踪容器。未跟踪观察不写入服务事实，也不能停止或恢复。",
	plan_deployment: "记录部署意图：create 保存 draft，validate 做确定性的前置校验，确认后 freeze 为不可变快照。",
	deploy_service: "受管 Docker 生命周期：start 只接受 frozen plan；stop/recover 只作用于 Core 拥有（label+本地记录双重证明）的服务。",
	benchmark_service: "单点低负载验证或规范化压测。受管服务只传 service_instance_id，省略 endpoint；外部回环端点只传 endpoint，省略 service_instance_id，二选一。生成带 workload hash 与原始 Artifact 的 BenchmarkResult；回环结果不能称为 BitTune 实测。",
	benchmark_suite: "用户选择了套件验收范围后按档案扫描、正确性、缓存或卡配推算。受管服务只传 service_instance_id；外部回环端点只传 endpoint，两者互斥。单点生成验证使用 benchmark_service，不扩展到套件；回环结果不能称为 BitTune 实测。",
	export_deliverable: "把已有扫描事实写成工作簿或证据包，不重新测量。",
	compare_results: "比较多个单点结果，或比较同一档案同一场景同一并发的扫描工作点。",
	write_report: "创建可追溯 Report：Core 校验叙述与事实引用、渲染指标、写出 Markdown Artifact。",
	inspect_records: "按 ID、硬件、模型、runtime_kind 或 workload hash 回查本地 Run、Artifact、扫描事实与报告。",
};

	export interface ManagedToolDependencies {
		/** Returns the session-scoped Core client; undefined while the Core is down. */
		client(): CoreClient | undefined;
	}

	export interface ManagedToolRuntimeOptions {
		taskScope?: TaskScope;
		/** Called before freeze/start/stop/recover; must show the object and impact. */
		askApproval?: (title: string, message: string) => Promise<boolean>;
		}

		function errorResult(error: Error): AgentToolResult<unknown> {
			const coreError = error instanceof CoreError ? error : new CoreError("core_error", error.message);
				const text =
					coreError.code === "core_busy"
						? COPY.errors.coreBusy
						: coreError.code === "core_unavailable"
							? COPY.errors.coreUnavailable
								: coreError.remediation
									? humanizeUserText(`${coreError.message}（${coreError.remediation}）`)
									: humanizeUserText(coreError.message);
			const details = { code: coreError.code, message: coreError.message, ...(coreError.remediation ? { remediation: coreError.remediation } : {}), ...(coreError.details ? { details: coreError.details } : {}) };
			return { content: [{ type: "text", text }, { type: "text", text: JSON.stringify({ error: details }) }], details };
		}

/** Run.success wrapper keys produced by the Python Core (runs.py). */
interface CoreSuccessEnvelope {
	run_id?: string;
	artifact_refs?: unknown;
	summary?: unknown;
	data?: unknown;
	warnings?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exported for user-copy regression tests; polls the Core result envelope
 * into plain-language text while the full payload stays in `details`. */
export function summarizeManagedResult(toolName: ManagedToolName, params: Record<string, unknown>, raw: unknown): string {
	const envelope = isRecord(raw) ? raw : {};
	// Handlers returning raw dicts (inspect_records) have no run.wrapper:
	// `data` selects the nested payload, anything else is the payload itself.
		const payload = isRecord(envelope.data) ? envelope.data : envelope;
		const preferInspectHeadline = toolName === "inspect_environment" && isRecord(payload.hardware_snapshot);
		const head =
			!preferInspectHeadline && typeof envelope.summary === "string" && envelope.summary.trim().length > 0
				? envelope.summary
				: headlineOf(toolName, params, payload);
		const warnings = Array.isArray(envelope.warnings) && envelope.warnings.length > 0
			? `\n注意：${(envelope.warnings as unknown[]).join("；")}`
			: "";
			return humanizeUserText(`${head}${warnings}`);
	}

function headlineOf(toolName: ManagedToolName, params: Record<string, unknown>, payload: Record<string, unknown>): string {
	switch (toolName) {
		case "inspect_environment": {
			const snapshot = isRecord(payload.hardware_snapshot) ? payload.hardware_snapshot : {};
			const gpus = Array.isArray(snapshot.gpus) ? snapshot.gpus : [];
			const names = gpus.map((gpu) => (isRecord(gpu) && typeof gpu.name === "string" ? gpu.name : "未知型号")).join("、");
			const dockerReady = isRecord(snapshot.docker) && snapshot.docker.daemon === true;
			return `已检查本机硬件：${gpus.length} 张 GPU（${names || "未识别"}）${dockerReady ? "，Docker 可用" : "，Docker 不可用"}。`;
		}
		case "inspect_service": {
			if (Array.isArray(payload.services)) return `已检查服务记录：共 ${payload.services.length} 条。`;
			if (isRecord(payload.current_container_state)) {
				const status = isRecord(payload.current_container_state)
					? String(payload.current_container_state.status ?? "unknown")
					: "unknown";
				if (isRecord(payload.service)) {
					const service = payload.service;
					const endpoint = typeof service.endpoint === "string" && service.endpoint ? `（endpoint ${service.endpoint}）` : "";
					return `已检查服务状态：${status}${endpoint}。`;
				}
				return `已检查服务状态：${status}。`;
			}
			return "已检查服务。";
		}
		case "plan_deployment": {
			if (isRecord(payload.plan)) {
				const plan = payload.plan;
				const id = typeof plan.plan_id === "string" ? `#${plan.plan_id}` : "";
				const state = typeof plan.status === "string" ? `（${plan.status}）` : "";
				return `已记录部署计划 ${id}${state}。`;
			}
			return "已记录部署计划。";
		}
		case "deploy_service": {
			if (isRecord(payload.service)) {
				const service = payload.service;
				const state = typeof service.observed_state === "string" ? service.observed_state : "unknown";
				const endpoint = typeof service.endpoint === "string" && service.endpoint ? `，endpoint ${service.endpoint}` : "";
				return `受管服务当前状态：${state}${endpoint}。`;
			}
			return "受管服务操作已完成。";
		}
		case "benchmark_suite": {
			const fact = isRecord(payload.suite_result) ? payload.suite_result : isRecord(payload.correctness_result) ? payload.correctness_result : isRecord(payload.cache_pair_result) ? payload.cache_pair_result : isRecord(payload.pd_estimate) ? payload.pd_estimate : undefined;
			if (!fact) return "验收已记录。";
			if (Array.isArray(fact.rows)) return `验收已记录：${fact.rows.length} 档。`;
			const state = typeof fact.state === "string" ? fact.state : "";
			return state ? `验收已记录：${state}。` : "验收已记录。";
		}
		case "export_deliverable":
			return "交接件已写出。";
		case "benchmark_service": {
			if (isRecord(payload.benchmark_result)) {
				const metrics = isRecord(payload.benchmark_result.metrics) ? payload.benchmark_result.metrics : {};
				const parts: string[] = [];
				if (typeof metrics.success_rate === "number") parts.push(`成功率 ${(metrics.success_rate * 100).toFixed(1)}%`);
				if (typeof metrics.requests_per_second === "number") parts.push(`吞吐 ${metrics.requests_per_second.toFixed(1)} req/s`);
				if (typeof metrics.mean_e2e_latency_ms === "number") parts.push(`平均端到端延迟 ${metrics.mean_e2e_latency_ms.toFixed(1)} ms`);
				return parts.length > 0 ? `压测完成：${parts.join("，")}。` : "压测完成，指标见诊断详情。";
			}
			return "压测完成。";
		}
			case "compare_results": {
				if (isRecord(payload.comparison)) {
					if (payload.comparison.comparable === false) return COPY.compare.incomparable;
					if (payload.comparison.claimable === false) return COPY.compare.unclaimable;
					const deltas = Array.isArray(payload.comparison.deltas) ? payload.comparison.deltas : [];
					return `已完成确定性比较：共 ${deltas.length} 项对比结果。`;
				}
				return "已完成比较。";
			}
		case "write_report": {
			if (isRecord(payload.report) && typeof payload.report.report_id === "string") {
				const artifacts = Array.isArray(payload.report.artifact_ids) ? payload.report.artifact_ids.length : 0;
				return `报告已生成：#${payload.report.report_id}（${artifacts} 个 Markdown 产物）。`;
			}
			return "报告已生成。";
		}
		case "inspect_records": {
			if (Array.isArray(payload.runs)) return `共查到 ${payload.runs.length} 条 Run 记录。`;
			if (Array.isArray(payload.records)) return `共查到 ${payload.records.length} 条事实记录。`;
			if (typeof payload.artifact_id === "string") return `Artifact ${payload.artifact_id}${typeof payload.label === "string" ? `（${payload.label}）` : ""}。`;
			if (typeof payload.id === "string" && typeof payload.kind === "string") return `已读取 ${payload.kind} 记录 ${payload.id}。`;
			return "已读取记录。";
		}
	}
	return "操作已记录。";
}

	const CONFIRMED_ACTIONS: Record<string, string> = {
		"plan_deployment.freeze": COPY.confirmBody.freeze,
		"deploy_service.start": COPY.confirmBody.start,
		"deploy_service.stop": COPY.confirmBody.stop,
		"deploy_service.recover": COPY.confirmBody.recover,
	};

function makeExecute(
	toolName: ManagedToolName,
	schema: AnyToolDefinition["parameters"],
	deps: ManagedToolDependencies,
	runtimeOptions: ManagedToolRuntimeOptions,
) {
	return async (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((update: { content: { type: "text"; text: string }[]; details: unknown }) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>> => {
			try {
				const client = deps.client();
				if (!client) throw new CoreError("core_unavailable", COPY.errors.coreUnavailable);
				if (runtimeOptions.taskScope) {
					await client.request("check_task_scope", { tool: toolName, params }, { sessionId: ctx.sessionManager.getSessionId() ?? "external", ...(signal ? { signal } : {}) });
				}
				const actionKey = toolName === "plan_deployment" || toolName === "deploy_service"
					? `${toolName}.${String(params.action ?? "")}`
					: "";
				const confirmMessage = CONFIRMED_ACTIONS[actionKey];
				if (confirmMessage) {
					const approved = runtimeOptions.askApproval
						? await runtimeOptions.askApproval(COPY.confirm.managed, confirmMessage)
						: await ctx.ui.confirm(COPY.confirm.managed, confirmMessage);
					if (!approved) {
						return { content: [{ type: "text", text: "已取消：用户未确认该受管操作，未调用 Core。" }], details: { code: "user_declined" } };
					}
				}
						const requestParams = { ...params };
						const endpoint = isRecord(params.endpoint) ? params.endpoint : undefined;
						const loopbackUrl = typeof endpoint?.url === "string" ? endpoint.url : "";
						const destructiveSuite = toolName === "benchmark_suite" && params.destructive === true;
						const loopbackMeasure = (toolName === "benchmark_service" || toolName === "benchmark_suite") && loopbackUrl !== "";
						if (loopbackMeasure || destructiveSuite) {
							const message = [
								loopbackMeasure ? `${COPY.confirmBody.loopback}\n${loopbackUrl}` : "",
								destructiveSuite ? COPY.confirmBody.destructive : "",
							].filter(Boolean).join("\n");
							const approved = runtimeOptions.askApproval
								? await runtimeOptions.askApproval(COPY.confirm.managed, message)
								: await ctx.ui.confirm(COPY.confirm.managed, message);
							if (!approved) {
								return { content: [{ type: "text", text: "已取消：用户未确认该受管操作，未调用 Core。" }], details: { code: "user_declined" } };
							}
						}
						if (toolName === "benchmark_suite") {
							requestParams.destructive_authorized = destructiveSuite;
						}
					const sessionId = ctx.sessionManager.getSessionId() ?? "external";
					const data = await client.request(toolName, requestParams, {
					sessionId,
					...(signal ? { signal } : {}),
					onProgress: (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: {} }),
				});
				const text = summarizeManagedResult(toolName, params, data);
					const response = toolName === "write_report" && (params.based_on_report_id || params.suite_selections) ? compactReportResult(data) : data;
					return { content: [{ type: "text", text }, { type: "text", text: JSON.stringify(response) }], details: response };
			} catch (error) {
				return errorResult(error instanceof Error ? error : new Error(String(error)));
			}
	};
}

function prepareMeasurementArguments(args: unknown) {
	if (!isRecord(args)) throw new Error("测量参数必须是对象。");
	if (("service_instance_id" in args) === ("endpoint" in args)) {
		throw new Error("测量对象必须二选一：受管服务只传 service_instance_id 并省略 endpoint；外部回环端点只传 endpoint 并省略 service_instance_id。不要同时提交两者。");
	}
	return args;
}

		export function createManagedTools(deps: ManagedToolDependencies, runtimeOptions: ManagedToolRuntimeOptions = {}): AnyToolDefinition[] {
	return MANAGED_TOOL_NAMES.map((toolName) => {
		const schema = Schemas[toolName];
			return {
				name: toolName,
				label: toolLabel(toolName),
				description: MANAGED_TOOL_DESCRIPTIONS[toolName],
			parameters: schema,
				executionMode: "sequential",
				...((toolName === "benchmark_service" || toolName === "benchmark_suite") ? { prepareArguments: prepareMeasurementArguments } : {}),
			execute: makeExecute(toolName, schema, deps, runtimeOptions),
				renderResult(result, options, theme) {
					const texts = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text);
					return new Text(theme.fg("toolOutput", options.expanded ? texts.join("\n") : texts[0] ?? ""), 0, 0);
				},
		};
	}) as AnyToolDefinition[];
}
