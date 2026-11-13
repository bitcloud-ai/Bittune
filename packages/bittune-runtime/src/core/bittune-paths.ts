import {homedir} from "node:os";
import {join} from "node:path";
export interface BittunePaths {
	root: string;
	agent: string;
	sessions: string;
	state: string;
	/** Python Core home (SQLite + artifacts + staging); default ~/.bittune/core. */
	core: string;
	logs: string;
}

function getEnvironmentPath(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value || undefined;
}

export function resolveBittunePaths(overrides: Partial<BittunePaths> = {}): BittunePaths {
	const root = overrides.root ?? getEnvironmentPath("BITTUNE_HOME") ?? join(homedir(), ".bittune");
	const agent =
		overrides.agent ??
		getEnvironmentPath("BITTUNE_AGENT_DIR") ??
		getEnvironmentPath("BITTUNE_CODING_AGENT_DIR") ??
		join(root, "agent");
	return {
		root,
		agent,
		sessions:
			overrides.sessions ?? getEnvironmentPath("BITTUNE_SESSION_DIR") ?? join(agent, "sessions"),
		state: overrides.state ?? getEnvironmentPath("BITTUNE_STATE_DIR") ?? join(root, "state"),
		core: overrides.core ?? getEnvironmentPath("BITTUNE_CORE_HOME") ?? join(root, "core"),
		logs: overrides.logs ?? getEnvironmentPath("BITTUNE_LOG_DIR") ?? join(root, "logs"),
	};
}
