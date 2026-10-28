/**
 * Doctor-level host pulse for the product banner / footer.
 * Must not call inspect_environment — that would create a Run.
 */
import { probeCommand } from "../../cli/install/checks.ts";
import { hostFromDoctor, type DockerState, type HostSegment, type HostStatusStore } from "./host-status.ts";

const PULSE_TIMEOUT_MS = 8_000;
export const MANAGED_PULSE_MS = 8_000;
const GPU_QUERY = ["--query-gpu=name,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits"];

export interface PulseGpu {
	name: string;
	vramTotal?: number;
	vramUsed?: number;
	utilization?: number;
}

export async function probeHostPulse(): Promise<HostSegment> {
	const fallback = hostFromDoctor({ gpuNames: [], docker: "down" });
	const work = Promise.all([probeGpus(), probeDocker()]).then(([gpus, docker]) =>
		hostFromDoctor({
			gpuNames: gpus.map((gpu) => gpu.name),
			docker,
			...aggregateVram(gpus),
		}),
	);
	return Promise.race([work, sleep(PULSE_TIMEOUT_MS, fallback)]).catch(() => fallback);
}

export function gpuNamesFromNvidiaSmi(output: string): string[] {
	return gpusFromNvidiaSmi(output).map((gpu) => gpu.name);
}

export function gpusFromNvidiaSmi(output: string): PulseGpu[] {
	return output
		.split(/\r?\n/)
		.map((line) => parseGpuLine(line.trim()))
		.filter((gpu): gpu is PulseGpu => Boolean(gpu));
}

function parseGpuLine(line: string): PulseGpu | undefined {
	if (!line) return undefined;
	const fields = line.split(",").map((field) => field.trim());
	const name = fields[0];
	if (!name) return undefined;
	const vramTotal = parseSmiNumber(fields[1]);
	const vramUsed = parseSmiNumber(fields[2]);
	const utilization = parseSmiNumber(fields[3]);
	return {
		name,
		...(vramTotal != null && vramTotal > 0 ? { vramTotal } : {}),
		...(vramUsed != null && vramUsed >= 0 ? { vramUsed } : {}),
		...(utilization != null && utilization >= 0 ? { utilization } : {}),
	};
}

function parseSmiNumber(field: string | undefined): number | undefined {
	if (!field || /^\[?n\/a\]?$/i.test(field)) return undefined;
	const match = field.match(/^(\d+(?:\.\d+)?)/);
	if (!match) return undefined;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : undefined;
}

function aggregateVram(gpus: readonly PulseGpu[]): Pick<HostSegment, "vramTotal" | "vramUsed" | "utilization"> {
	let vramTotal = 0;
	let vramUsed = 0;
	let usedKnown = 0;
	let utilSum = 0;
	let utilKnown = 0;
	let totalKnown = 0;
	for (const gpu of gpus) {
		if (gpu.vramTotal == null || gpu.vramTotal <= 0) continue;
		vramTotal += gpu.vramTotal;
		totalKnown += 1;
		if (gpu.vramUsed != null && gpu.vramUsed >= 0) {
			vramUsed += gpu.vramUsed;
			usedKnown += 1;
		}
		if (gpu.utilization != null && gpu.utilization >= 0) {
			utilSum += gpu.utilization;
			utilKnown += 1;
		}
	}
	return {
		...(totalKnown > 0 ? { vramTotal } : {}),
		...(usedKnown > 0 ? { vramUsed } : {}),
		...(utilKnown > 0 ? { utilization: Math.round(utilSum / utilKnown) } : {}),
	};
}

export function mergePulseGpus(current: HostSegment, gpus: readonly PulseGpu[]): HostSegment {
	if (gpus.length === 0) return current;
	const vram = aggregateVram(gpus);
	return hostFromDoctor({
		gpuNames: gpus.map((gpu) => gpu.name),
		docker: current.docker,
		coreDown: current.coreDown,
		vramTotal: vram.vramTotal ?? current.vramTotal,
		vramUsed: vram.vramUsed ?? current.vramUsed,
		utilization: vram.utilization ?? current.utilization,
	});
}

/** Light nvidia-smi while a managed service is running. Idle / unseen machines stay quiet. */
export function bindManagedHostPulse(
	store: HostStatusStore,
	options: { intervalMs?: number; probe?: () => Promise<PulseGpu[]> } = {},
): () => void {
	const intervalMs = options.intervalMs ?? MANAGED_PULSE_MS;
	const probe = options.probe ?? probeGpus;
	let timer: ReturnType<typeof setInterval> | undefined;
	let inFlight = false;

	const stop = (): void => {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	};

	const tick = async (): Promise<void> => {
		if (inFlight || store.get().service.kind !== "running") {
			if (store.get().service.kind !== "running") stop();
			return;
		}
		inFlight = true;
		try {
			const gpus = await probe();
			if (gpus.length === 0 || store.get().service.kind !== "running") return;
			store.patch({ host: mergePulseGpus(store.get().host, gpus) });
		} catch {
			return;
		} finally {
			inFlight = false;
		}
	};

	const start = (): void => {
		if (timer) return;
		timer = setInterval(() => {
			void tick();
		}, intervalMs);
		timer.unref?.();
	};

	const sync = (): void => {
		if (store.get().service.kind === "running") start();
		else stop();
	};

	const unsub = store.subscribe(sync);
	sync();
	return () => {
		unsub();
		stop();
	};
}

async function probeGpus(): Promise<PulseGpu[]> {
	try {
		const result = await probeCommand("nvidia-smi", GPU_QUERY, PULSE_TIMEOUT_MS);
		if (!result.ok || !result.output) return [];
		return gpusFromNvidiaSmi(result.output);
	} catch {
		return [];
	}
}

async function probeDocker(): Promise<DockerState> {
	try {
		const result = await probeCommand("docker", ["version", "--format", "{{json .}}"], PULSE_TIMEOUT_MS);
		return result.ok ? "ready" : "down";
	} catch {
		return "down";
	}
}

function sleep<T>(ms: number, value: T): Promise<T> {
	return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}
