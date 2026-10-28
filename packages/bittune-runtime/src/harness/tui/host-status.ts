import { COPY, PRODUCT_TAGLINE, PRODUCT_WORDMARK } from "./copy.ts";

export type DockerState = "ready" | "down" | "unknown";
export type ServiceKind = "unseen" | "none" | "running" | "not_ready" | "stopped";
export type TaskKind = "idle" | "awaiting_confirm" | "deploying" | "benchmarking" | "other_managed";
export type CollabPhase = "running" | "awaiting_confirm" | "done" | "failed";

export interface HostSegment {
	gpuText: string;
	docker: DockerState;
	coreDown?: boolean;
	/** Aggregate MiB across GPUs. Omit when the pulse or inspect did not see a number. */
	vramTotal?: number;
	vramUsed?: number;
	utilization?: number;
}

export interface ServiceSegment {
	kind: ServiceKind;
	engine?: string;
}

export interface TaskSegment {
	kind: TaskKind;
}

export interface CollabSlot {
	id: string;
	title: string;
	phase: CollabPhase;
}

export interface HostStatus {
	host: HostSegment;
	service: ServiceSegment;
	task: TaskSegment;
	collab: CollabSlot[];
}

const GPU_SHORT =
	/\b(H100|H200|A100|A800|L40S|L40|L4|T4|V100|A10|A30|A40|RTX\s?\d{4}(?:\s?Ti)?)\b/i;

export function createIdleHostStatus(): HostStatus {
	return {
		host: { gpuText: COPY.probing, docker: "unknown" },
		service: { kind: "unseen" },
		task: { kind: "idle" },
		collab: [],
	};
}

/** In-session view model. Banner and footer subscribe; probes and tool events patch. */
	export const COLLAB_HOLD_MS = 8000;

	export class HostStatusStore {
		private status: HostStatus = createIdleHostStatus();
		private readonly listeners = new Set<(status: HostStatus) => void>();
		private holdTimer: ReturnType<typeof setTimeout> | undefined;

	get(): HostStatus {
		return this.status;
	}

	set(next: HostStatus): void {
		this.status = next;
		this.emit();
	}

	patch(partial: Partial<HostStatus>): void {
		this.status = {
			host: partial.host ?? this.status.host,
			service: partial.service ?? this.status.service,
			task: partial.task ?? this.status.task,
			collab: partial.collab ?? this.status.collab,
		};
		this.emit();
	}

		subscribe(listener: (status: HostStatus) => void): () => void {
			this.listeners.add(listener);
			return () => {
				this.listeners.delete(listener);
			};
		}

			setCollab(id: string, patch: Partial<Pick<CollabSlot, "title" | "phase">>): void {
				const next = this.status.collab.slice();
				const index = next.findIndex((slot) => slot.id === id);
				if (index === -1) {
					next.push({ id, title: patch.title ?? "", phase: patch.phase ?? "running" });
				} else {
					next[index] = { ...next[index]!, ...patch };
				}
				this.patch({ collab: next });
				this.scheduleCollabHold();
			}

			clearSettledCollab(): void {
				this.clearHoldTimer();
				const live = this.status.collab.filter((slot) => slot.phase === "running" || slot.phase === "awaiting_confirm");
				if (live.length !== this.status.collab.length) this.patch({ collab: live });
			}

		private scheduleCollabHold(): void {
			this.clearHoldTimer();
			if (this.status.collab.some((slot) => slot.phase === "running" || slot.phase === "awaiting_confirm")) return;
			if (this.status.collab.length === 0) return;
			this.holdTimer = setTimeout(() => this.clearSettledCollab(), COLLAB_HOLD_MS);
			this.holdTimer.unref?.();
		}

		private clearHoldTimer(): void {
			if (!this.holdTimer) return;
			clearTimeout(this.holdTimer);
			this.holdTimer = undefined;
		}

		private emit(): void {
			for (const listener of this.listeners) listener(this.status);
		}
	}

export function shortenGpuName(name: string): string {
	const cleaned = name.replace(/^NVIDIA\s+/i, "").trim();
	const match = cleaned.match(GPU_SHORT);
	if (match) return match[1]!.replace(/\s+/g, " ").replace(/rtx/i, "RTX");
	return cleaned.split(/\s+/)[0] || "GPU";
}

export function formatGpuText(names: readonly string[]): string {
	if (names.length === 0) return COPY.host.noGpu;
	const counts = new Map<string, number>();
	for (const name of names) {
		const short = shortenGpuName(name);
		counts.set(short, (counts.get(short) ?? 0) + 1);
	}
	return [...counts.entries()].map(([label, count]) => (count > 1 ? `${count}×${label}` : label)).join(" ");
}

export function hostFromDoctor(input: {
	gpuNames: readonly string[];
	docker: DockerState;
	coreDown?: boolean;
	vramTotal?: number;
	vramUsed?: number;
	utilization?: number;
}): HostSegment {
	return {
		gpuText: formatGpuText(input.gpuNames),
		docker: input.docker,
		...(input.coreDown ? { coreDown: true } : {}),
		...(input.vramTotal != null && input.vramTotal > 0 ? { vramTotal: input.vramTotal } : {}),
		...(input.vramUsed != null && input.vramUsed >= 0 ? { vramUsed: input.vramUsed } : {}),
		...(input.utilization != null && input.utilization >= 0 ? { utilization: input.utilization } : {}),
	};
}

export function serviceFromManagedRecords(
	records: ReadonlyArray<{ ownership?: string; runtime_kind?: string; observed_state?: string }> | undefined,
): ServiceSegment {
	if (records === undefined) return { kind: "unseen" };
	const managed = records.filter((record) => record.ownership === "managed");
	if (managed.length === 0) return { kind: "none" };
	const ranked = managed.map((record) => ({
		engine: record.runtime_kind || "服务",
		kind: mapObservedState(record.observed_state),
	}));
	const ready = ranked.find((item) => item.kind === "running");
	if (ready) return { kind: "running", engine: ready.engine };
	const notReady = ranked.find((item) => item.kind === "not_ready");
	if (notReady) return { kind: "not_ready", engine: notReady.engine };
	return { kind: "stopped", engine: ranked[0]!.engine };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

const MIB = 1024 * 1024;

function mibFromBytes(bytes: number): number {
	return bytes / MIB;
}

function unwrapPayload(details: unknown): Record<string, unknown> | undefined {
	const envelope = asRecord(details);
	if (!envelope) return undefined;
	return asRecord(envelope.data) ?? envelope;
}

/** Successful inspect_environment → GPU names + docker.daemon; retains local host status. */
export function hostFromInspect(details: unknown, current: HostSegment): HostSegment | undefined {
	const payload = unwrapPayload(details);
	const snapshot = payload ? asRecord(payload.hardware_snapshot) : undefined;
	if (!snapshot) return undefined;
	const gpus = Array.isArray(snapshot.gpus) ? snapshot.gpus : [];
	const names = gpus
		.map((gpu) => asString(asRecord(gpu)?.name))
		.filter((name): name is string => Boolean(name));
	const dockerObj = asRecord(snapshot.docker);
	const docker: DockerState = dockerObj ? (dockerObj.daemon === true ? "ready" : "down") : current.docker;
	return hostFromDoctor({ gpuNames: names, docker, ...vramFromInspectGpus(gpus) });
}

function vramFromInspectGpus(gpus: unknown[]): Pick<HostSegment, "vramTotal" | "vramUsed" | "utilization"> {
	let vramTotal = 0;
	let vramUsed = 0;
	let usedKnown = 0;
	let utilSum = 0;
	let utilKnown = 0;
	let totalKnown = 0;
	for (const row of gpus) {
		const gpu = asRecord(row);
		if (!gpu) continue;
		const totalBytes = asNumber(gpu.memory_total_bytes);
		if (totalBytes == null || totalBytes <= 0) continue;
		vramTotal += mibFromBytes(totalBytes);
		totalKnown += 1;
		const freeBytes = asNumber(gpu.memory_free_bytes);
		if (freeBytes != null && freeBytes >= 0) {
			vramUsed += mibFromBytes(Math.max(0, totalBytes - freeBytes));
			usedKnown += 1;
		}
		const util = asNumber(gpu.utilization_percent);
		if (util != null && util >= 0) {
			utilSum += util;
			utilKnown += 1;
		}
	}
	return {
		...(totalKnown > 0 ? { vramTotal } : {}),
		...(usedKnown > 0 ? { vramUsed } : {}),
		...(utilKnown > 0 ? { utilization: Math.round(utilSum / utilKnown) } : {}),
	};
}

export function recordsFromServiceResult(
	details: unknown,
): Array<{ ownership?: string; runtime_kind?: string; observed_state?: string }> | undefined {
	const payload = unwrapPayload(details);
	if (!payload) return undefined;
	if (Array.isArray(payload.services)) return payload.services.map(flattenServiceObservation);
	if (asRecord(payload.service)) return [flattenServiceObservation(payload)];
	return undefined;
}

function flattenServiceObservation(row: unknown): { ownership?: string; runtime_kind?: string; observed_state?: string } {
	const wrap = asRecord(row) ?? {};
	const service = asRecord(wrap.service) ?? wrap;
	const container = asRecord(wrap.current_container_state);
	const spec = asRecord(service.runtime_spec);
	const observed =
		asString(service.observed_state) === "ready" ? "ready" : (asString(container?.status) ?? asString(service.observed_state));
	return {
		ownership: asString(service.ownership),
		runtime_kind: asString(service.runtime_kind) ?? asString(spec?.runtime_kind),
		observed_state: observed,
	};
}

export type HostStatusEvent =
	| { type: "tool_call"; toolName: string; action?: string }
	| { type: "confirm"; open: boolean; toolName?: string; action?: string }
	| { type: "tool_result"; toolName: string; details: unknown };

export function reduceHostStatus(status: HostStatus, event: HostStatusEvent): HostStatus {
	if (event.type === "tool_call") {
		return { ...status, task: taskFromFlight({ toolName: event.toolName, action: event.action }) };
	}
	if (event.type === "confirm") {
		return {
			...status,
			task: taskFromFlight({ confirming: event.open, toolName: event.toolName, action: event.action }),
		};
	}
		let next: HostStatus = { ...status, task: taskFromFlight({}) };
		if (detailsCode(event.details) === "core_unavailable") {
			next = { ...next, host: { ...status.host, coreDown: true } };
		}
		if (event.toolName === "inspect_environment") {
			const host = hostFromInspect(event.details, status.host);
			if (host) next = { ...next, host };
		}
	if (event.toolName === "inspect_service" || event.toolName === "deploy_service") {
		const records = recordsFromServiceResult(event.details);
		if (records !== undefined) next = { ...next, service: serviceFromManagedRecords(records) };
	}
	return next;
}

	function detailsCode(details: unknown): string | undefined {
		const envelope = asRecord(details);
		return envelope ? asString(envelope.code) : undefined;
	}

	function mapObservedState(state: string | undefined): Exclude<ServiceKind, "unseen" | "none"> {
	const value = (state ?? "").toLowerCase();
	if (value === "ready") return "running";
	if (value === "stopped" || value === "not_running" || value === "exited" || value === "dead") return "stopped";
	return "not_ready";
}

	export function taskFromFlight(input: { confirming?: boolean; toolName?: string; action?: string }): TaskSegment {
		if (input.confirming && input.toolName) return { kind: "awaiting_confirm" };
		if (!input.toolName) return { kind: "idle" };
	if (input.toolName === "deploy_service" && (input.action === undefined || input.action === "start")) return { kind: "deploying" };
	if (input.toolName === "benchmark_service") return { kind: "benchmarking" };
	return { kind: "other_managed" };
}

export function columnWidth(text: string): number {
	let width = 0;
	for (const char of text) width += isWideChar(char) ? 2 : 1;
	return width;
}

function isWideChar(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe10 && code <= 0xfe19) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x3000 && code <= 0x303e) ||
		(code >= 0x3040 && code <= 0x30ff) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0x20000 && code <= 0x2fffd)
	);
}

export function truncateColumns(text: string, max: number, ellipsis = "…"): string {
	if (max <= 0) return "";
	if (columnWidth(text) <= max) return text;
	const ellipsisWidth = columnWidth(ellipsis);
	if (max <= ellipsisWidth) return ellipsis;
	let out = "";
	let width = 0;
	for (const char of text) {
		const next = isWideChar(char) ? 2 : 1;
		if (width + next + ellipsisWidth > max) break;
		out += char;
		width += next;
	}
	return `${out}${ellipsis}`;
}

export function formatGib(mib: number, kind: "total" | "used" = "total"): string {
	const gib = mib / 1024;
	if (kind === "total" && Math.abs(gib - Math.round(gib)) < 0.4) return `${Math.round(gib)}G`;
	const rounded = Math.round(gib * 10) / 10;
	if (Number.isInteger(rounded)) return `${rounded}G`;
	return `${rounded.toFixed(1)}G`;
}

/** Compact occupancy, e.g. `8.2/32G`. Undefined when the pulse/inspect has no total. */
export function formatVramText(host: Pick<HostSegment, "vramTotal" | "vramUsed">): string | undefined {
	if (host.vramTotal == null || host.vramTotal <= 0) return undefined;
	const total = formatGib(host.vramTotal, "total");
	if (host.vramUsed == null || host.vramUsed < 0) return total;
	const used = formatGib(host.vramUsed, "used").replace(/G$/, "");
	return `${used}/${total}`;
}

export function formatVramBar(used: number, total: number, cells = 10): string {
	if (!(total > 0) || cells <= 0) return "";
	const filled = Math.max(0, Math.min(cells, Math.round((Math.max(0, used) / total) * cells)));
	return `${"█".repeat(filled)}${"░".repeat(cells - filled)}`;
}

	export function formatHostText(host: HostSegment): string {
		return formatHostParts(host).join(" · ");
	}

	function formatHostParts(host: HostSegment, options: { vramBar?: boolean } = {}): string[] {
		if (host.coreDown) return [COPY.host.coreDown];
		const docker =
			host.docker === "ready" ? COPY.host.dockerReady : host.docker === "down" ? COPY.host.dockerDown : COPY.host.dockerUnknown;
		const vram = formatVramText(host);
		const bar =
			options.vramBar && host.vramTotal != null && host.vramTotal > 0 && host.vramUsed != null && host.vramUsed >= 0
				? formatVramBar(host.vramUsed, host.vramTotal)
				: "";
		const gpu = vram ? (bar ? `${host.gpuText} ${vram}  ${bar}` : `${host.gpuText} ${vram}`) : host.gpuText;
		const parts = host.gpuText === COPY.probing && host.docker === "unknown" ? [COPY.probing] : [gpu, docker];
		parts.push(COPY.host.local);
		return parts;
	}

	function formatFooterHost(host: HostSegment): string {
		return formatHostParts(host, { vramBar: true }).join(" · ");
	}

	/** Live scouts only. Idle footer never adds 协作 空闲. */
	export function formatFooterCollab(collab: readonly CollabSlot[]): string | undefined {
		const live = activeCollab(collab);
		if (live.length === 0) return undefined;
		if (collab.some((slot) => slot.phase === "awaiting_confirm")) return COPY.collab.awaitingConfirm;
		return `${COPY.collab.running} ${live.length}/${COPY.collab.capacity}`;
	}

export function formatServiceText(service: ServiceSegment): string {
	if (service.kind === "unseen") return COPY.service.unseen;
	if (service.kind === "none") return COPY.service.none;
	const engine = service.engine || "服务";
	if (service.kind === "running") return `${engine} ${COPY.service.ready}`;
	if (service.kind === "not_ready") return `${engine} ${COPY.service.notReady}`;
	return `${engine} ${COPY.service.stopped}`;
}

export function formatTaskText(task: TaskSegment): string {
	if (task.kind === "awaiting_confirm") return COPY.task.awaitingConfirm;
	if (task.kind === "deploying") return COPY.task.deploying;
	if (task.kind === "benchmarking") return COPY.task.benchmarking;
	if (task.kind === "other_managed") return COPY.task.other;
	return COPY.task.idle;
}

	export function activeCollab(collab: readonly CollabSlot[]): CollabSlot[] {
		return collab.filter((slot) => slot.phase === "running" || slot.phase === "awaiting_confirm");
	}

		export function formatCollabText(collab: readonly CollabSlot[], compact = false): string {
			if (collab.some((slot) => slot.phase === "awaiting_confirm")) return COPY.collab.awaitingConfirm;
			const live = activeCollab(collab);
			if (live.length > 0) {
				if (compact) return `${COPY.collab.compactPrefix}${live.length}`;
				if (live.length === 1 && live[0]!.title) return truncateColumns(live[0]!.title, 16);
				return `${COPY.collab.running} ${live.length}/${COPY.collab.capacity}`;
			}
			if (collab.length === 0) return compact ? COPY.task.idle : COPY.collab.idle;
			if (collab.some((slot) => slot.phase === "failed")) return COPY.collab.failed;
			return COPY.collab.done;
		}

export const FOOTER_WIDE_MIN = 120;

	export function formatFooterLine(status: HostStatus, width: number): string {
		const host = `${COPY.footer.host} ${formatFooterHost(status.host)}`;
		const service = `${COPY.footer.service} ${formatServiceText(status.service)}`;
		const task = `${COPY.footer.task} ${formatTaskText(status.task)}`;
		const collab = formatFooterCollab(status.collab);
		const sep = COPY.footer.separator;
		const full = (collab ? [host, service, task, collab] : [host, service, task]).join(sep);
		if (columnWidth(full) <= width) return full;

		const withoutService = (collab ? [host, task, collab] : [host, task]).join(sep);
		if (columnWidth(withoutService) <= width) return withoutService;

		if (collab) {
			const hostCollab = [host, collab].join(sep);
			if (columnWidth(hostCollab) <= width) return hostCollab;
			const remainingForCollab = width - columnWidth(host) - columnWidth(sep);
			if (remainingForCollab >= 4) return `${host}${sep}${truncateColumns(collab, remainingForCollab)}`;
			return truncateColumns(host, width);
		}

		const remainingForTask = width - columnWidth(host) - columnWidth(sep);
		if (remainingForTask >= 4) return `${host}${sep}${truncateColumns(task, remainingForTask)}`;
		return truncateColumns(host, width);
	}

/** Engine + occupancy bar. Only for managed running on a wide terminal. */
export function formatManagedServiceLine(status: HostStatus): string | undefined {
	if (status.service.kind !== "running") return undefined;
	const engine = status.service.engine || "服务";
	const parts = [`${engine} ${COPY.service.ready}`];
	if (status.host.vramTotal != null && status.host.vramTotal > 0 && status.host.vramUsed != null && status.host.vramUsed >= 0) {
		parts.push(formatVramBar(status.host.vramUsed, status.host.vramTotal));
		const vram = formatVramText(status.host);
		if (vram) parts.push(vram);
		if (status.host.utilization != null && status.host.utilization >= 0) parts.push(`${status.host.utilization}%`);
	}
	return parts.join("  ");
}

export function formatFooterLines(status: HostStatus, width: number): string[] {
	const first = formatFooterLine(status, width);
	if (width < FOOTER_WIDE_MIN) return [first];
	const second = formatManagedServiceLine(status);
	return second ? [first, second] : [first];
}

export function formatCompactHeader(input: { version: string; collab: readonly CollabSlot[]; width: number }): string {
	const wordmark = `${PRODUCT_WORDMARK}  v${input.version}`;
	const right = formatCollabText(input.collab);
	const compactRight = formatCollabText(input.collab, true);
	const withTagline = `${wordmark}  ${PRODUCT_TAGLINE}`;
	return (
		align(withTagline, right, input.width) ??
		align(wordmark, right, input.width) ??
		align(wordmark, compactRight, input.width) ??
		truncateColumns(`${wordmark}  ${compactRight}`, input.width)
	);
}

function align(left: string, right: string, width: number): string | undefined {
	const gap = width - columnWidth(left) - columnWidth(right);
	if (gap < 2) return undefined;
	return `${left}${" ".repeat(gap)}${right}`;
}
