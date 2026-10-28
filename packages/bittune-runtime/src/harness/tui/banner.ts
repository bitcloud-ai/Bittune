import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { BANNER_ART, COPY, PRODUCT_TAGLINE, PRODUCT_WORDMARK } from "./copy.ts";
import {
	activeCollab,
	columnWidth,
	formatCollabText,
	formatCompactHeader,
	formatHostText,
	truncateColumns,
	type HostStatus,
	type HostStatusStore,
} from "./host-status.ts";
import { footerPulseGlyph } from "./status-bar.ts";

const WIDE_MIN_COLUMNS = 72;

export type BannerMode = "wide" | "narrow" | "compact";

	export interface BannerPaint {
		wordmark(text: string): string;
		tagline(text: string): string;
		pulse(text: string): string;
		version(text: string): string;
		local(text: string): string;
		collab(text: string): string;
	}

	const IDENTITY_PAINT: BannerPaint = {
		wordmark: (text) => text,
		tagline: (text) => text,
		pulse: (text) => text,
		version: (text) => text,
		local: (text) => text,
		collab: (text) => text,
	};

export function decideBannerMode(input: { compact: boolean; width: number; term?: string }): BannerMode {
	if (input.compact) return "compact";
	if ((input.term ?? "") === "dumb" || input.width < WIDE_MIN_COLUMNS) return "narrow";
	return "wide";
}

	export function renderBanner(input: {
		mode: BannerMode;
		status: HostStatus;
		version: string;
		width: number;
		paint?: BannerPaint;
		pulse?: string;
	}): string[] {
		const paint = input.paint ?? IDENTITY_PAINT;
		if (input.mode === "compact") {
			if (paint === IDENTITY_PAINT) {
				return [formatCompactHeader({ version: input.version, collab: input.status.collab, width: input.width })];
			}
			return [clampLine(renderCompact(input.status, input.version, input.width, paint, input.pulse), input.width)];
		}
	if (input.mode === "narrow") return renderNarrow(input.status, paint);
	return renderWide(input.status, input.version, input.width, paint);
}

function renderWide(status: HostStatus, version: string, width: number, paint: BannerPaint): string[] {
	const art = BANNER_ART.map((line) => paint.wordmark(line));
	const hostText = formatHostText(status.host);
	const pulse = paintPulse(hostText, paint);
	const ver = paint.version(`v${version}`);
	const pulseLine =
		alignPlain(hostText, `v${version}`, pulse, ver, width) ?? `${pulse} ${ver}`;
	return [...art, paint.tagline(PRODUCT_TAGLINE), pulseLine];
}

function renderNarrow(status: HostStatus, paint: BannerPaint): string[] {
	return [paint.wordmark(PRODUCT_WORDMARK), paint.tagline(PRODUCT_TAGLINE), paintPulse(formatHostText(status.host), paint)];
}

	function renderCompact(
		status: HostStatus,
		version: string,
		width: number,
		paint: BannerPaint,
		pulse?: string,
	): string {
		const wordmark = `${PRODUCT_WORDMARK}  v${version}`;
		const right = formatCollabText(status.collab);
		const compactRight = formatCollabText(status.collab, true);
		const paintedRight = paintCollabText(right, status.collab, paint, pulse);
		const paintedCompactRight = paintCollabText(compactRight, status.collab, paint, pulse);
		const withTagline = `${wordmark}  ${PRODUCT_TAGLINE}`;
		const paintedWordmark = `${paint.wordmark(PRODUCT_WORDMARK)}  ${paint.version(`v${version}`)}`;
		const paintedTagline = `${paintedWordmark}  ${paint.tagline(PRODUCT_TAGLINE)}`;
		return (
			alignPlain(withTagline, right, paintedTagline, paintedRight, width) ??
			alignPlain(wordmark, right, paintedWordmark, paintedRight, width) ??
			alignPlain(wordmark, compactRight, paintedWordmark, paintedCompactRight, width) ??
			truncateColumns(`${wordmark}  ${compactRight}`, width)
		);
	}

	function paintCollabText(
		text: string,
		collab: HostStatus["collab"],
		paint: BannerPaint,
		pulse?: string,
	): string {
		if (text === COPY.collab.idle || text === COPY.task.idle) return paint.local(text);
		const live = activeCollab(collab).length > 0;
		const lamp = live ? `${pulse ?? "●"} ` : "";
		return paint.collab(`${lamp}${text}`);
	}

function paintPulse(hostText: string, paint: BannerPaint): string {
	const local = COPY.host.local;
	if (!hostText.endsWith(local)) return paint.pulse(hostText);
	const prefix = hostText.slice(0, hostText.length - local.length);
	return `${paint.pulse(prefix)}${paint.local(local)}`;
}

	function alignPlain(
		leftPlain: string,
		rightPlain: string,
		leftPainted: string,
		rightPainted: string,
		width: number,
	): string | undefined {
		const left = Math.max(columnWidth(leftPlain), visibleWidth(leftPainted));
		const right = Math.max(columnWidth(rightPlain), visibleWidth(rightPainted));
		const gap = width - left - right;
		if (gap < 2) return undefined;
		return `${leftPainted}${" ".repeat(gap)}${rightPainted}`;
	}

	function clampLine(line: string, width: number): string {
		return visibleWidth(line) <= width ? line : truncateToWidth(line, width, "…");
	}

	export class BannerComponent implements Component {
		private compact: boolean;
		private readonly unsub: () => void;
		private pulseTimer: ReturnType<typeof setInterval> | undefined;

		constructor(
			private readonly tui: TUI,
			private readonly theme: Theme,
			private readonly store: HostStatusStore,
			private readonly version: string,
			compact: boolean,
		) {
			this.compact = compact;
			this.unsub = store.subscribe((status) => {
				this.syncPulse(status);
				tui.requestRender();
			});
			this.syncPulse(store.get());
		}

	collapse(): void {
		this.compact = true;
		this.tui.requestRender();
	}

	expand(): void {
		this.compact = false;
		this.tui.requestRender();
	}

		dispose(): void {
			this.stopPulse();
			this.unsub();
		}

		invalidate(): void {}

		render(width: number): string[] {
			const status = this.store.get();
			const live = activeCollab(status.collab).length > 0;
			return renderBanner({
				mode: decideBannerMode({ compact: this.compact, width, term: process.env.TERM }),
				status,
				version: this.version,
				width,
				pulse: live ? footerPulseGlyph() : undefined,
				paint: {
					wordmark: (text) => this.theme.bold(this.theme.fg("accent", text)),
					tagline: (text) => text,
					pulse: (text) => this.theme.fg("dim", text),
					version: (text) => this.theme.fg("dim", text),
					local: (text) => this.theme.fg("dim", text),
					collab: (text) => this.theme.fg("accent", text),
				},
			}).map((line) => clampLine(line, width));
		}

		private syncPulse(status: HostStatus): void {
			if (activeCollab(status.collab).length > 0) this.startPulse();
			else this.stopPulse();
		}

		private startPulse(): void {
			if (this.pulseTimer) return;
			this.pulseTimer = setInterval(() => {
				this.tui.requestRender();
			}, 1_000);
			this.pulseTimer.unref?.();
		}

		private stopPulse(): void {
			if (!this.pulseTimer) return;
			clearInterval(this.pulseTimer);
			this.pulseTimer = undefined;
		}
}

export function createBannerFactory(options: {
	store: HostStatusStore;
	version: string;
	compact: boolean;
	onCreate?: (banner: BannerComponent) => void;
}): (tui: TUI, theme: Theme) => BannerComponent {
	return (tui, theme) => {
		const banner = new BannerComponent(tui, theme, options.store, options.version, options.compact);
		options.onCreate?.(banner);
		return banner;
	};
}
