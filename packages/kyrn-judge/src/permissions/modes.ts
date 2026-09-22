import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isReadOnlyCommand } from "../checkpoint/mutating.ts";
import { isShellTool } from "../extension/shell-tools.ts";

/**
 * How much the agent may do without asking.
 *
 * - `full`: nothing is asked. What the user said not to do still stops a call
 *   (the constraint gate is about the user's words, not about permission).
 * - `jev`: JeV approves for the user. Reading and editing inside the project
 *   go ahead, as the task itself; a command, a change outside the project, an
 *   action on the outside world or a sub-agent goes to JeV, and only what JeV
 *   does not approve reaches the user.
 * - `ask`: minimal permissions. Reading goes ahead; everything else asks.
 */
export type PermissionMode = "full" | "jev" | "ask";

export const PERMISSION_MODES: readonly PermissionMode[] = ["full", "jev", "ask"];

export const MODE_TEXT: Readonly<
	Record<PermissionMode, { zh: string; en: string; zhDescription: string; enDescription: string }>
> = {
	full: {
		zh: "完全访问",
		en: "Full access",
		zhDescription: "什么都不问，直接执行。你明确说过不许做的事仍然会被拦下。",
		enDescription: "Runs everything without asking. What you said not to do is still stopped.",
	},
	jev: {
		zh: "JeV 审批",
		en: "JeV approves",
		zhDescription: "项目里的读和改直接做；命令、项目外的改动、对外操作由 JeV 替你审批，它拿不准的才问你。",
		enDescription:
			"Reads and edits in the project go ahead; JeV approves commands, changes outside the project and outside actions for you, and asks you only when it is not sure.",
	},
	ask: {
		zh: "最小权限",
		en: "Minimal permissions",
		zhDescription: "只读操作直接做；改文件、跑命令、对外操作都先问你。",
		enDescription: "Only reading goes ahead; every edit, command and outside action asks you first.",
	},
};

const ALIASES: Readonly<Record<string, PermissionMode>> = {
	full: "full",
	"full-access": "full",
	yolo: "full",
	完全访问: "full",
	jev: "jev",
	auto: "jev",
	judge: "jev",
	审批: "jev",
	ask: "ask",
	minimal: "ask",
	"read-only": "ask",
	readonly: "ask",
	最小权限: "ask",
};

export function parseMode(raw: unknown): PermissionMode | undefined {
	return typeof raw === "string" ? ALIASES[raw.trim().toLowerCase()] : undefined;
}

/** What a call that needs permission is. */
export type PermissionKind = "edit" | "shell" | "run" | "outside" | "delegate" | "other";

export interface PermissionNeed {
	readonly kind: PermissionKind;
	/** One line a person can read: the command, the path, the tool and its main argument. */
	readonly summary: string;
	/** What an "allow for this conversation" covers. Undefined: this call can only be allowed once. */
	readonly grant?: { readonly key: string; readonly label: string };
	/** Never approved by JeV or a grant: the user decides, every time. */
	readonly protected?: string;
	/** In the project folder (edits) — the one thing JeV mode lets through without a judgment. */
	readonly inProject?: boolean;
}

/** Tools that only look: never asked in any mode. */
const LOOKING: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"find_skill",
	"find_capability",
	"locate",
	"todo",
	"web_search",
	"web_fetch",
	"bg_output",
	"bg_stop",
	"conflicts_list",
	"conflicts_show",
	"sg_search",
	"review_triage",
	"debug_inspect",
	"debug_step",
	"debug_stop",
]);

const EDITING: ReadonlySet<string> = new Set(["edit", "write", "apply_patch_from", "conflicts_resolve", "sg_rewrite"]);

/** Programs whose first argument names the action: "npm test" and "npm publish" are not one permission. */
const TWO_WORD =
	/^(?:git|npm|pnpm|yarn|bun|npx|cargo|go|docker|kubectl|pip|pip3|uv|poetry|make|dotnet|gh|brew|apt|apt-get)$/;
/** Chaining, redirection, substitution: a grant for the first word would cover whatever comes after it. */
const COMPOUND = /[<>;&|`\n\r]|\$\(|\$\{/;

/** "npm test", "git commit", "python": what "allow for this conversation" allows for a command. */
export function commandPrefix(command: string): string | undefined {
	const text = command.trim();
	if (!text || COMPOUND.test(text)) return undefined;
	const words = text.split(/\s+/);
	// A leading `VAR=value` or `sudo` changes what runs: such a command is allowed once or not at all.
	if (/=/.test(words[0]) || /^(?:sudo|doas|env|xargs|eval|exec|sh|bash|zsh|pwsh|powershell|cmd)$/i.test(words[0]))
		return undefined;
	const [first, second] = words;
	return TWO_WORD.test(first) && second && !second.startsWith("-") ? `${first} ${second}` : first;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function pathOf(input: Readonly<Record<string, unknown>>): string {
	return text(input.path) || text(input.file_path) || text(input.file);
}

export function insideProject(cwd: string, path: string): boolean {
	if (!path) return true;
	const target = resolve(cwd, path);
	const rel = relative(resolve(cwd), target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const clip = (value: string, length: number) => {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length <= length ? line : `${line.slice(0, length - 1)}…`;
};

/**
 * Whether a call needs permission, and what it is. Wrong in the safe direction
 * only: a tool nobody listed needs permission, and a command counts as only
 * looking when every part of it is on the short read-only list.
 */
export function permissionNeed(
	toolName: string,
	input: Readonly<Record<string, unknown>>,
	cwd: string,
	protectedPaths: readonly string[] = [],
): PermissionNeed | undefined {
	const touches = (value: string) => protectedPaths.find((path) => value.includes(path));
	if (LOOKING.has(toolName)) return undefined;
	if (isShellTool(toolName) || toolName === "bg_start") {
		const command = text(input.command);
		if (isReadOnlyCommand(command)) return undefined;
		const guarded = touches(command);
		const prefix = commandPrefix(command);
		return {
			kind: "shell",
			summary: clip(command, 300),
			...(guarded ? { protected: guarded } : prefix ? { grant: { key: `shell:${prefix}`, label: prefix } } : {}),
		};
	}
	if (toolName === "sg_rewrite" && input.apply !== true) return undefined;
	if (EDITING.has(toolName)) {
		const path = pathOf(input);
		const inProject = insideProject(cwd, path);
		const guarded = path ? touches(resolve(cwd, path)) : undefined;
		const summary = clip(`${toolName} ${path || text(input.id) || text(input.pattern)}`, 300);
		if (guarded) return { kind: "edit", summary, protected: guarded };
		return inProject
			? { kind: "edit", summary, inProject, grant: { key: "edit", label: "edit" } }
			: { kind: "outside", summary, grant: { key: `outside:${resolve(cwd, path)}`, label: path } };
	}
	if (toolName === "delegate" || toolName === "hive") {
		const tasks = Array.isArray(input.tasks) ? input.tasks.length : 0;
		const title = text(input.goal) || text(input.task);
		return {
			kind: "delegate",
			summary: clip(`${toolName} ${tasks ? `${tasks} task${tasks === 1 ? "" : "s"}` : title}`, 300),
			grant: { key: `tool:${toolName}`, label: toolName },
		};
	}
	if (toolName === "debug_start") {
		return {
			kind: "run",
			summary: clip(`${toolName} ${text(input.program) || text(input.command) || JSON.stringify(input)}`, 300),
			grant: { key: "tool:debug_start", label: toolName },
		};
	}
	const main = text(input.url) || text(input.action) || text(input.query) || text(input.task) || JSON.stringify(input);
	return {
		kind: "other",
		summary: clip(`${toolName} ${main}`, 300),
		grant: { key: `tool:${toolName}`, label: toolName },
	};
}

/**
 * The mode new conversations start in, as the user last chose it. In the
 * user's own agent folder, next to the board's switches; never in a project.
 */
export class PermissionDefaults {
	readonly file: string | undefined;
	private memory: PermissionMode | undefined;

	constructor(dir: string | undefined) {
		this.file = dir ? join(dir, "permissions.json") : undefined;
	}

	get(): PermissionMode | undefined {
		if (!this.file) return this.memory;
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { version?: unknown; mode?: unknown };
			return parsed.version === 1 ? parseMode(parsed.mode) : undefined;
		} catch {
			return undefined;
		}
	}

	set(mode: PermissionMode): void {
		if (!this.file) {
			this.memory = mode;
			return;
		}
		mkdirSync(join(this.file, ".."), { recursive: true });
		const temp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify({ version: 1, mode }, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temp, this.file);
	}
}
