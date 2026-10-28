import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";

/**
 * Execution-point policy for the four generic tools (bash/read/edit/write).
 *
 * The policy produces only `allow` / `ask` / `deny` plus a reason. It never
 * parses the shell: low-impact investigation commands are recognized by their
 * first token, everything else - unknown commands, host perturbations,
 * network writes, and redirections or pipes that escape the workspace -
 * requires one-time user confirmation. Unknown commands default to `ask`:
 * the policy is the last line of defense before a root shell, and an
 * unreviewable failure mode beats an unconfirmed one. BitTune-owned paths
 * are always denied. The Core cannot claim to intercept Bash the Runtime
 * already allowed.
 */

export type PolicyDecision = "allow" | "ask" | "deny";

/**
 * `confirmation` is a Runtime-internal classification for `ask` outcomes:
 * `explicit` gates host/network side effects and can never be skipped by the
 * approval preference; `ordinary` asks (unknown commands, file writes outside
 * the workspace) may honor session/global skip. It never enters Core, the
 * session transcript or untrusted tool output.
 */
export interface PolicyOutcome {
	decision: PolicyDecision;
	reason: string;
	confirmation?: "ordinary" | "explicit";
}

	export type PolicyProfile = "parent" | "scout";

	export interface GenericPolicyInput {
		toolName: "bash" | "read" | "edit" | "write";
		command?: string;
		path?: string;
		cwd: string;
		/** BitTune-owned roots the Agent must never read or write. */
		protectedRoots: readonly string[];
		/** Scout sessions use a tighter bash allowlist. Parent policy is unchanged. */
		profile?: PolicyProfile;
	}

const READ_ONLY_FIRST_WORDS = new Set([
	"cat", "head", "tail", "grep", "find", "ls", "df", "free", "uname", "lscpu", "pwd", "which",
	"echo", "printf", "true", "false", "env", "printenv", "du", "uptime", "hostname", "id", "whoami", "date",
	"nvidia-smi", "ps", "ip", "ss", "file", "stat", "wc", "sort", "uniq", "cut", "tr", "sed", "awk",
	"python", "python3", "git", "docker", "curl", "wget", "pip", "pip3", "npm", "pnpm", "conda", "uv",
]);

/** First-token handlers for compound tools whose subcommands decide the impact. */
const COMPOUND: Record<string, (args: string[]) => PolicyOutcome> = {
	docker: (args) => {
		const subcommand = args[0];
		const readOnly = new Set(["ps", "images", "image", "version", "info", "inspect", "logs", "stats", "network", "volume", "container"]);
		if (subcommand && readOnly.has(subcommand)) return { decision: "allow", reason: "只读 Docker 检查。" };
		return { decision: "ask", confirmation: "explicit", reason: `docker ${subcommand ?? ""} 会改变容器或宿主机状态，需要确认。`.trim() };
	},
	git: (args) => {
		const readOnly = new Set(["status", "log", "diff", "show", "fetch", "branch", "remote", "rev-parse", "ls-files", "tag"]);
		if (readOnly.has(args[0] ?? "")) return { decision: "allow", reason: "只读 git 检查。" };
		return { decision: "ask", confirmation: "explicit", reason: `git ${args[0] ?? ""} 会推送或改写仓库，需要确认。`.trim() };
	},
	curl: (args) => {
		const methodIndex = args.findIndex((arg) => arg === "-X" || arg === "--request");
		const method = (methodIndex !== -1 ? args[methodIndex + 1]?.toUpperCase() : undefined) ?? "GET";
		const writes = args.some((arg) => /^(--data|--data-raw|--data-binary|--data-urlencode|-d|--form|-F|-T|--upload-file|-o|--output)\b/.test(arg));
		if (method !== "GET" || writes) return { decision: "ask", confirmation: "explicit", reason: "向外部服务写入或上传数据需要确认。" };
		return { decision: "allow", reason: "只读网络检查。" };
	},
	wget: (args) => ({ decision: "ask", confirmation: "explicit", reason: "wget 会把外部内容写入磁盘，需要确认。" }),
	pip: (args) => (["install", "uninstall"].includes(args[0] ?? "") ? { decision: "ask", confirmation: "explicit", reason: "pip 安装会改变 Python 环境，需要确认。" } : { decision: "allow", reason: "只读包环境检查。" }),
	pip3: (args) => COMPOUND.pip!(args),
	npm: (args) => (["install", "ci", "add", "run", "exec"].includes(args[0] ?? "") ? { decision: "ask", confirmation: "explicit", reason: "npm 安装或脚本会改变环境，需要确认。" } : { decision: "allow", reason: "只读包环境检查。" }),
	pnpm: (args) => COMPOUND.npm!(args),
	uv: (args) => (["pip", "add"].includes(args[0] ?? "") ? { decision: "ask", confirmation: "explicit", reason: "uv 安装会改变 Python 环境，需要确认。" } : { decision: "allow", reason: "只读工具链检查。" }),
	conda: (args) => (["install", "create", "remove"].includes(args[0] ?? "") ? { decision: "ask", confirmation: "explicit", reason: "conda 会改变环境，需要确认。" } : { decision: "allow", reason: "只读环境检查。" }),
};

	const ASK_FIRST_WORDS = new Set([
		"rm", "mv", "chmod", "chown", "kill", "pkill", "killall", "systemctl", "service", "mkdir", "touch", "cp",
		"apt", "apt-get", "yum", "dnf", "zypper", "pacman", "brew", "sudo", "reboot", "shutdown", "mount", "umount", "ssh", "scp",
		"dd", "tee", "shred", "truncate",
	]);

	/** Scout first tokens that stay silent-allow. Compound docker is handled separately. */
	const SCOUT_READ_ONLY_FIRST_WORDS = new Set([
		"cat", "head", "tail", "grep", "find", "ls", "df", "free", "uname", "lscpu", "pwd", "which",
		"echo", "printf", "true", "false", "env", "printenv", "du", "uptime", "hostname", "id", "whoami", "date",
		"nvidia-smi", "ps", "ip", "ss", "file", "stat", "wc", "sort", "uniq", "cut", "tr", "sed", "awk",
	]);

	const SCOUT_DENY_FIRST_WORDS = new Set([
		"rm", "kill", "pkill", "killall", "systemctl", "service", "reboot", "shutdown", "dd", "shred",
	]);

const PROTECTED_TOKEN = /(?:^|[\s"'\\])(?:\$BITTUNE_HOME|~\/\.bittune|\/root\/\.bittune|(?:\/[\w.-]*)*\/\.bittune)(?:[\/\s"']|$)/;
const DESTRUCTIVE_ROOT_RM = /\brm\b[^|&;\n]*\s-r[^|&;\n]*\s?(?:\/|\/(?:bin|sbin|etc|usr|var|opt|root|lib|boot)\b)/;

//: Words that request confirmation even when they appear behind a pipe or
//: inside a command substitution - a shallow guard for the common escapes
//: (`echo x | sudo tee /etc/hosts`, `dd of=/dev/sdb` without redirection).
const DANGEROUS_WORDS = [...ASK_FIRST_WORDS, "sudo"];
const PIPE_DANGEROUS_RE = new RegExp(`\\|[^|;&\\n]*?\\b(?:${DANGEROUS_WORDS.join("|")})\\b`);
const SUBSTITUTION_DANGEROUS_RE = new RegExp(`\\b(?:${DANGEROUS_WORDS.join("|")})\\b`);
const REDIRECT_RE = /(?:[0-2]?>>?)\s*([^\s;&|<>]+)/g;

function firstWord(command: string): { word: string; rest: string[] } {
	const words = command.trim().split(/\s+/).filter(Boolean);
	return { word: words[0] ?? "", rest: words.slice(1) };
}

function touchesProtectedRoot(command: string, protectedRoots: readonly string[]): string | undefined {
	if (PROTECTED_TOKEN.test(command)) return "$BITTUNE_HOME 下的路径";
	for (const root of protectedRoots) {
		const token = root.replace(/\\/g, "\\\\");
		if (new RegExp(`(?:^|[\\s"'\\\\])${token}(?:[\\/\\s"']|$)`).test(command)) return root;
	}
	return undefined;
}

function within(target: string, root: string): boolean {
	return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Redirection targets: writes outside the workspace/temp or to block
 * devices need confirmation. Shallow path reading only - an unevaluable
 * target (quotes stripped, `$`/`~`) is treated conservatively. */
function redirectionOutcome(command: string, cwd: string): PolicyOutcome | undefined {
	const targets: string[] = [];
	for (const match of command.matchAll(REDIRECT_RE)) {
		const raw = (match[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
		if (raw) targets.push(raw);
	}
	if (targets.length === 0) return undefined;
	for (const target of targets) {
		if (target === "/dev/null") continue;
		if (target.startsWith("/dev/")) return { decision: "ask", confirmation: "explicit", reason: `重定向指向块设备 ${target}，需要确认。` };
		if (target.includes("$") || target.includes("`") || target.startsWith("~")) {
			return { decision: "ask", confirmation: "explicit", reason: `重定向目标 ${target} 无法静态解析，需要确认。` };
		}
		const resolved = resolve(cwd, target);
		const inside = within(resolved, resolve(cwd)) || within(resolved, resolve(tmpdir()));
		if (!inside) return { decision: "ask", confirmation: "explicit", reason: `重定向写入工作区之外：${target}。` };
	}
	return undefined;
}

/** Pipes and command substitutions smuggling a confirmation-gated command
 * behind an otherwise innocent first word. */
function pipeOutcome(command: string): PolicyOutcome | undefined {
	if (PIPE_DANGEROUS_RE.test(command)) {
		return { decision: "ask", confirmation: "explicit", reason: "管道下游包含需要确认的命令。" };
	}
	if (/\$\(|`/.test(command) && SUBSTITUTION_DANGEROUS_RE.test(command)) {
		return { decision: "ask", confirmation: "explicit", reason: "命令替换中包含需要确认的命令。" };
	}
	return undefined;
}

	export function evaluateBash(
		command: string,
		cwd: string,
		protectedRoots: readonly string[],
		profile: PolicyProfile = "parent",
	): PolicyOutcome {
		if (!command.trim()) return { decision: "deny", reason: "空命令。" };
		if (touchesProtectedRoot(command, protectedRoots)) {
			return { decision: "deny", reason: "命令引用了 BitTune 受管目录（配置、状态或证据 Store）；Agent 不能经 Bash 读写这些路径。" };
		}
		if (DESTRUCTIVE_ROOT_RM.test(command)) {
			return { decision: "deny", reason: "递归删除系统目录会破坏宿主。" };
		}
		const redirection = redirectionOutcome(command, cwd);
		if (redirection) return redirection;
		const pipe = pipeOutcome(command);
		if (pipe) return pipe;
		const { word, rest } = firstWord(command);
		if (profile === "scout") {
			if (SCOUT_DENY_FIRST_WORDS.has(word)) {
				return { decision: "deny", reason: `排查不能运行 ${word}。` };
			}
			if (word === "docker") return COMPOUND.docker!(rest);
			if (SCOUT_READ_ONLY_FIRST_WORDS.has(word)) {
				return { decision: "allow", reason: "低影响只读调查。" };
			}
			return {
				decision: "ask",
				confirmation: "explicit",
				reason: `排查运行 ${word} 需要确认（cwd: ${cwd}）。`,
			};
		}
		const compound = COMPOUND[word];
		if (compound) return compound(rest);
		if (ASK_FIRST_WORDS.has(word)) {
			return { decision: "ask", confirmation: "explicit", reason: `${word} 会改变宿主或消耗资源（cwd: ${cwd}），需要确认。` };
		}
		if (READ_ONLY_FIRST_WORDS.has(word)) {
			return { decision: "allow", reason: "低影响只读调查。" };
		}
		return { decision: "ask", confirmation: "ordinary", reason: `无法确认 ${word} 是低影响只读命令；默认要求确认（cwd: ${cwd}）。` };
	}

export function evaluateFileAccess(input: GenericPolicyInput): PolicyOutcome {
	const path = input.path;
	if (!path) return { decision: "deny", reason: "文件工具缺少 path。" };
	const target = resolve(input.cwd, path);
	const normalizedRoots = input.protectedRoots.map((root) => resolve(root));
	const protectedRoot = normalizedRoots.find((root) => within(target, root));
	if (protectedRoot) {
		return { decision: "deny", reason: `${path} 位于 BitTune 受管目录（${protectedRoot}）；Agent 不能读写配置与证据 Store。` };
	}
	if (input.toolName === "read") {
		return { decision: "allow", reason: "只读文件检查。" };
	}
	if (within(target, resolve(input.cwd)) || within(target, resolve(tmpdir()))) {
		return { decision: "allow", reason: "工作区/临时目录内的文件修改。" };
	}
	return { decision: "ask", confirmation: "ordinary", reason: `${path} 位于工作区之外，修改需要确认。` };
}

	export function evaluateGenericCall(input: GenericPolicyInput): PolicyOutcome {
		if (input.toolName === "bash" && input.command !== undefined) {
			return evaluateBash(input.command, input.cwd, input.protectedRoots, input.profile ?? "parent");
		}
		return evaluateFileAccess(input);
	}