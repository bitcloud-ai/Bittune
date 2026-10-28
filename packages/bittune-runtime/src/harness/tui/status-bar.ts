import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { COPY } from "./copy.ts";
import { activeCollab, formatFooterLines, type HostStatus, type HostStatusStore } from "./host-status.ts";

/** Single-character busy pulse. Idle footer must not animate. */
export const FOOTER_PULSE_FRAMES = ["●", "◉"] as const;
const PULSE_INTERVAL_MS = 1_000;
const HOST_INNER_SEP = " · ";
const LAMP_ON = "●";
const LAMP_OFF = "○";

export function footerPulseGlyph(at = Date.now()): (typeof FOOTER_PULSE_FRAMES)[number] {
	return FOOTER_PULSE_FRAMES[Math.floor(at / PULSE_INTERVAL_MS) % FOOTER_PULSE_FRAMES.length]!;
}

export function paintFooterRule(width: number, theme: Pick<Theme, "fg">): string {
	return theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
}

export function paintFooterLine(
	line: string,
	theme: Pick<Theme, "fg">,
	options: { pulse?: string } = {},
): string {
	return line
		.split(COPY.footer.separator)
		.map((part) => paintFooterPart(part, theme, options.pulse))
		.join(COPY.footer.separator);
}

function paintFooterPart(part: string, theme: Pick<Theme, "fg">, pulse?: string): string {
	if (part.startsWith(`${COPY.footer.host} `) || part === COPY.footer.host) return paintHostPart(part, theme);
	if (part.startsWith(`${COPY.footer.service} `) || part === COPY.footer.service) return paintServicePart(part, theme);
	if (part.startsWith(`${COPY.footer.task} `) || part === COPY.footer.task) return paintTaskPart(part, theme, pulse);
	if (isCollabPart(part)) return paintCollabPart(part, theme, pulse);
	return part;
}

function isCollabPart(part: string): boolean {
	return (
		part.includes(COPY.collab.running) ||
		part.includes(COPY.collab.awaitingConfirm) ||
		part.startsWith(COPY.collab.compactPrefix) ||
		part.startsWith("排查")
	);
}

function paintHostPart(part: string, theme: Pick<Theme, "fg">): string {
	let painted = replaceLampToken(part, COPY.host.dockerDown, theme, "error", LAMP_ON);
	painted = replaceLampToken(painted, COPY.host.dockerReady, theme, "success", LAMP_ON);
	painted = replaceLampToken(painted, COPY.host.dockerUnknown, theme, "dim", LAMP_OFF);
	painted = replaceLampToken(painted, COPY.host.local, theme, "dim", LAMP_OFF);
	painted = replaceToken(painted, COPY.host.coreDown, theme, "error");
	painted = replaceToken(painted, COPY.probing, theme, "dim");
	painted = replaceToken(painted, COPY.host.noGpu, theme, "dim");
	painted = paintGpuName(painted, theme);
	return `${hostLeadLamp(part, theme)} ${painted}`;
}

function hostLeadLamp(part: string, theme: Pick<Theme, "fg">): string {
	if (part.includes(COPY.host.coreDown)) return theme.fg("error", LAMP_ON);
	if (part.includes(COPY.probing) || part.includes(COPY.host.noGpu)) return theme.fg("dim", LAMP_OFF);
	return theme.fg("success", LAMP_ON);
}

function paintGpuName(part: string, theme: Pick<Theme, "fg">): string {
	const prefix = `${COPY.footer.host} `;
	if (!part.startsWith(prefix)) return part;
	const after = part.slice(prefix.length);
	const gpuEnd = after.indexOf(HOST_INNER_SEP);
	const gpu = gpuEnd === -1 ? after : after.slice(0, gpuEnd);
	if (!gpu || isPainted(gpu)) return part;
	if (gpu === COPY.probing || gpu === COPY.host.noGpu || gpu === COPY.host.coreDown) return part;
	return prefix + theme.fg("success", gpu) + after.slice(gpu.length);
}

function paintServicePart(part: string, theme: Pick<Theme, "fg">): string {
	if (part.includes(COPY.service.notReady)) {
		return `${theme.fg("error", LAMP_ON)} ${replaceToken(part, COPY.service.notReady, theme, "error")}`;
	}
	if (part.includes(COPY.service.stopped)) {
		return `${theme.fg("error", LAMP_ON)} ${replaceToken(part, COPY.service.stopped, theme, "error")}`;
	}
	if (part.includes(COPY.service.unseen)) {
		return `${theme.fg("dim", LAMP_OFF)} ${replaceToken(part, COPY.service.unseen, theme, "dim")}`;
	}
	if (part.includes(COPY.service.none)) {
		return `${theme.fg("dim", LAMP_OFF)} ${replaceToken(part, COPY.service.none, theme, "dim")}`;
	}
	if (part.includes(COPY.service.ready)) {
		return `${theme.fg("success", LAMP_ON)} ${replaceToken(part, COPY.service.ready, theme, "success")}`;
	}
	return part;
}

function paintFooterDetailLine(line: string, theme: Pick<Theme, "fg">): string {
	if (line.includes(COPY.service.notReady)) return replaceToken(line, COPY.service.notReady, theme, "error");
	if (line.includes(COPY.service.ready)) return replaceToken(line, COPY.service.ready, theme, "success");
	return line;
}

function paintTaskPart(part: string, theme: Pick<Theme, "fg">, pulse?: string): string {
	if (part.includes(COPY.task.idle)) {
		return `${theme.fg("dim", LAMP_OFF)} ${replaceToken(part, COPY.task.idle, theme, "dim")}`;
	}
	let painted = part;
	let busy = false;
	for (const token of [COPY.task.deploying, COPY.task.benchmarking, COPY.task.other, COPY.task.awaitingConfirm]) {
		if (!painted.includes(token)) continue;
		busy = true;
		painted = replaceToken(painted, token, theme, "accent");
	}
	if (!busy) return `${theme.fg("dim", LAMP_OFF)} ${painted}`;
	return `${theme.fg("accent", pulse ?? LAMP_ON)} ${painted}`;
}

function paintCollabPart(part: string, theme: Pick<Theme, "fg">, pulse?: string): string {
	const lamp = theme.fg("accent", pulse ?? LAMP_ON);
	if (part.includes(COPY.collab.awaitingConfirm)) {
		return `${lamp} ${replaceToken(part, COPY.collab.awaitingConfirm, theme, "accent")}`;
	}
	if (part.includes(COPY.collab.running)) {
		return `${lamp} ${replaceToken(part, COPY.collab.running, theme, "accent")}`;
	}
	return `${lamp} ${theme.fg("accent", part)}`;
}

function replaceLampToken(
	text: string,
	token: string,
	theme: Pick<Theme, "fg">,
	color: "success" | "error" | "dim" | "accent",
	lamp: string,
): string {
	return text.includes(token) ? text.replaceAll(token, theme.fg(color, `${lamp} ${token}`)) : text;
}

function replaceToken(
	text: string,
	token: string,
	theme: Pick<Theme, "fg">,
	color: "success" | "error" | "dim" | "accent",
): string {
	return text.includes(token) ? text.replaceAll(token, theme.fg(color, token)) : text;
}

function isPainted(text: string): boolean {
	return text.includes("\u001b") || text.includes("<");
}

function footerBusy(status: HostStatus): boolean {
	return status.task.kind !== "idle";
}

function footerPulsing(status: HostStatus): boolean {
	return footerBusy(status) || activeCollab(status.collab).length > 0;
}

export class StatusBarComponent implements Component {
	private readonly unsub: () => void;
	private pulseTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly store: HostStatusStore,
	) {
		this.unsub = store.subscribe((status) => {
			this.syncPulse(status);
			tui.requestRender();
		});
		this.syncPulse(store.get());
	}

	dispose(): void {
		this.stopPulse();
		this.unsub();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const status = this.store.get();
		const pulse = footerPulsing(status) ? footerPulseGlyph() : undefined;
		const lines = formatFooterLines(status, width).map((line, index) =>
			index === 0 ? paintFooterLine(line, this.theme, { pulse }) : paintFooterDetailLine(line, this.theme),
		);
		return [
			paintFooterRule(width, this.theme),
			...lines.map((line) => (visibleWidth(line) <= width ? line : truncateToWidth(line, width, "…"))),
		];
	}

	private syncPulse(status: HostStatus): void {
		if (footerPulsing(status)) this.startPulse();
		else this.stopPulse();
	}

	private startPulse(): void {
		if (this.pulseTimer) return;
		this.pulseTimer = setInterval(() => {
			this.tui.requestRender();
		}, PULSE_INTERVAL_MS);
		this.pulseTimer.unref?.();
	}

	private stopPulse(): void {
		if (!this.pulseTimer) return;
		clearInterval(this.pulseTimer);
		this.pulseTimer = undefined;
	}
}

export function createStatusBarFactory(
	store: HostStatusStore,
): (tui: TUI, theme: Theme) => StatusBarComponent {
	return (tui, theme) => new StatusBarComponent(tui, theme, store);
}

export function createMinimalFooterFactory(store: HostStatusStore): (tui: TUI, theme: Theme) => Component {
	return (_tui, _theme) => ({
		render: (width: number) => formatFooterLines(store.get(), width),
		invalidate(): void {},
	});
}
