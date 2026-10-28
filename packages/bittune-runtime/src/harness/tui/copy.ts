/**
 * User-visible product copy. TUI surfaces must import strings from here
 * instead of scattering English leftovers in components.
 */

export const PRODUCT_WORDMARK = "BITTUNE";
export const PRODUCT_TAGLINE = "本机推理工程智能体";

/** Static block wordmark. Do not generate this at runtime. */
export const BANNER_ART = [
	"██████╗ ██╗████████╗████████╗██╗   ██╗███╗   ██╗███████╗",
	"██╔══██╗██║╚══██╔══╝╚══██╔══╝██║   ██║████╗  ██║██╔════╝",
	"██████╔╝██║   ██║      ██║   ██║   ██║██╔██╗ ██║█████╗  ",
	"██╔══██╗██║   ██║      ██║   ██║   ██║██║╚██╗██║██╔══╝  ",
	"██████╔╝██║   ██║      ██║   ╚██████╔╝██║ ╚████║███████╗",
	"╚═════╝ ╚═╝   ╚═╝      ╚═╝    ╚═════╝ ╚═╝  ╚═══╝╚══════╝",
] as const;

export const COPY = {
	probing: "正在查看本机…",
	host: {
		noGpu: "未检测到 GPU",
		dockerReady: "Docker 就绪",
		dockerDown: "Docker 未就绪",
		dockerUnknown: "Docker 未知",
		local: "仅本机",
		coreDown: "本机服务暂时不可用",
	},
	service: {
		unseen: "未查看服务",
		none: "无受管服务",
		ready: "就绪",
		notReady: "未就绪",
		stopped: "已停止",
	},
	task: {
		idle: "空闲",
		awaitingConfirm: "等待确认",
		deploying: "正在部署",
		benchmarking: "正在压测",
		other: "正在执行",
	},
		collab: {
			idle: "协作 空闲",
			running: "排查中",
			awaitingConfirm: "排查 · 等待确认",
			done: "排查完成",
			failed: "排查未能完成",
			compactPrefix: "排查 ×",
			capacity: 3,
			stepRunning: "进行中",
			stepDone: "完成",
			stepFailed: "未能完成",
		},
		confirm: {
			policy: "需要确认",
			investigate: "排查需要确认",
			managed: "将在本机执行",
		yes: "确认",
		no: "取消",
	},
	confirmBody: {
		freeze: "将把当前方案固化，之后按该方案在本机部署。",
		start: "将按已确认的方案在本机启动服务，占用所选 GPU。",
		stop: "将停止本机受管服务。",
		recover: "将把本机受管服务与实际容器状态重新对齐。",
			destructive: "将按档案跑极限压测，可能占满这张卡并影响同机服务。",
			loopback: "结果不能成为实测。",
		},
		compare: {
			incomparable: "这两次不能比较，没有百分比。",
			unclaimable: "数字可以并列，这次比较不能称为实测。",
		},
				errors: {
					coreBusy: "正在执行上一项本机操作，请稍候。",
					coreUnavailable: "本机服务暂时不可用。",
					unknownCommand: "这不是本产品提供的操作。",
					investigateBusy: "已有 3 个排查在进行",
					investigateCancelled: "排查已取消。",
					investigateFailed: "排查未能完成。",
					investigateLimit: "排查已达到步数上限。",
				},
	working: "正在处理…",
	thinking: "正在思考…",
	footer: {
		host: "本机",
		service: "服务",
		task: "任务",
		separator: "  ·  ",
	},
	slash: {
		copy: "复制上一条回复",
		name: "设置会话显示名",
		session: "查看会话信息",
		hotkeys: "查看快捷键",
		fork: "从一条先前的用户消息分出新会话",
		clone: "复制当前会话",
		tree: "切换会话分支",
		new: "开始新会话",
		compact: "压缩当前会话上下文",
		resume: "切换到另一会话",
		quit: "退出 Bittune",
		approval: "设置普通确认偏好",
	},
	skills: {
		prepareModel: "准备本机模型权重",
		prepareEngine: "准备引擎镜像",
	},
} as const;

export const GENERIC_TOOL_LABELS: Record<"read" | "bash" | "edit" | "write", string> = {
	read: "读取",
	bash: "命令",
	edit: "编辑",
	write: "写入",
};

export const MANAGED_TOOL_LABELS: Record<string, string> = {
	inspect_environment: "检查本机环境",
	inspect_service: "查看服务",
	plan_deployment: "提出部署方案",
	deploy_service: "启动服务",
	benchmark_service: "压测服务",
	benchmark_suite: "验收服务",
	export_deliverable: "导出交接件",
	compare_results: "对比结果",
	write_report: "写报告",
	inspect_records: "查阅记录",
};

export const PLAN_ACTION_LABELS: Record<string, string> = {
	create: "提出部署方案",
	validate: "核对方案",
	freeze: "固化方案",
};

export const DEPLOY_ACTION_LABELS: Record<string, string> = {
	start: "启动服务",
	stop: "停止服务",
	recover: "恢复服务",
};

export const INVESTIGATE_LABEL = "排查";

export function toolLabel(name: string, action?: string): string {
	if (name === "plan_deployment" && action && PLAN_ACTION_LABELS[action]) return PLAN_ACTION_LABELS[action]!;
	if (name === "deploy_service" && action && DEPLOY_ACTION_LABELS[action]) return DEPLOY_ACTION_LABELS[action]!;
	return (
		GENERIC_TOOL_LABELS[name as keyof typeof GENERIC_TOOL_LABELS] ??
		MANAGED_TOOL_LABELS[name] ??
		(name === "investigate" ? INVESTIGATE_LABEL : name)
	);
}

const TOOL_NAME_TOKENS = [
	...Object.keys(MANAGED_TOOL_LABELS),
	"investigate",
].sort((left, right) => right.length - left.length);

/** Replace internal tool names in user-visible Core/Runtime sentences. */
export function humanizeUserText(text: string): string {
	const failed = text.match(/^Core 未能完成 ([A-Za-z_]+)。$/);
	if (failed) return `${toolLabel(failed[1]!)}未能完成。`;
	let out = text;
	for (const name of TOOL_NAME_TOKENS) {
		if (out.includes(name)) out = out.split(name).join(toolLabel(name));
	}
	return out;
}
