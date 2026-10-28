import { COPY } from "../harness/tui/copy.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
}

	// BITTUNE-FORK: builtin slash descriptions come from product copy, not English Pi defaults.
	export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
		{ name: "copy", description: COPY.slash.copy },
		{ name: "name", description: COPY.slash.name },
		{ name: "session", description: COPY.slash.session },
		{ name: "hotkeys", description: COPY.slash.hotkeys },
		{ name: "fork", description: COPY.slash.fork },
		{ name: "clone", description: COPY.slash.clone },
		{ name: "tree", description: COPY.slash.tree },
		{ name: "new", description: COPY.slash.new },
		{ name: "compact", description: COPY.slash.compact },
		{ name: "resume", description: COPY.slash.resume },
		{ name: "quit", description: COPY.slash.quit },
	];
