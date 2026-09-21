import { win32 } from "node:path";

/**
 * How to start a server's command on this platform, without a shell.
 *
 * On POSIX the command and its arguments go to `spawn` as they are. On Windows
 * `npx`, `npm`, `pnpm` and most Node tools are `.cmd` shims, and Node refuses
 * to spawn a `.cmd` or `.bat` file directly (it throws EINVAL since the
 * CVE-2024-27980 fix). Those have to go through `cmd.exe /d /s /c "<line>"`
 * with the line quoted by hand: once for the program that parses its own
 * command line (backslashes and quotes), once for cmd (its metacharacters).
 * This is the approach the cross-spawn package takes; the rules themselves are
 * cmd's and the C runtime's.
 *
 * Everything that differs per platform is a parameter, so that the Windows
 * side is tested on any machine.
 */
export interface SpawnPlan {
	readonly command: string;
	readonly args: readonly string[];
	/** Windows only: the arguments are already quoted, Node must not quote them again. */
	readonly verbatim: boolean;
}

export interface SpawnHost {
	readonly platform: NodeJS.Platform;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Whether a file exists. Injected so that tests need no Windows file system. */
	readonly exists: (path: string) => boolean;
	readonly cwd?: string;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
/** Shims a Node installation puts on the PATH. Used when the PATH cannot be searched, e.g. it is not set. */
const KNOWN_SHIMS: readonly string[] = ["npx", "npm", "pnpm", "pnpx", "yarn", "yarnpkg", "corepack", "bunx"];

function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
	// Windows variable names are case-insensitive, and `Path` is the usual spelling there.
	const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
	return key ? env[key] : undefined;
}

/** The file Windows would run for `command`: the PATH and PATHEXT search `CreateProcess` does not do for `.cmd`. */
export function resolveWindowsCommand(command: string, host: SpawnHost): string | undefined {
	const extensions = (envValue(host.env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.map((extension) => extension.trim())
		.filter(Boolean);
	const hasExtension = win32.extname(command) !== "";
	const candidates = (base: string): string[] => [
		...(hasExtension ? [base] : []),
		...extensions.map((extension) => base + extension.toLowerCase()),
		...extensions.map((extension) => base + extension),
	];
	const hasDirectory = /[\\/]/.test(command);
	const folders = hasDirectory
		? [""]
		: [host.cwd ?? "", ...(envValue(host.env, "PATH") ?? "").split(";").filter(Boolean)];
	for (const folder of folders) {
		const anchored = hasDirectory && !win32.isAbsolute(command) ? win32.join(host.cwd ?? "", command) : command;
		const base = hasDirectory ? anchored : win32.join(folder, command);
		const found = candidates(base).find((candidate) => host.exists(candidate));
		if (found) return found;
	}
	return undefined;
}

/** One argument, quoted so that the program's own parser gets it back unchanged, then made safe for cmd. */
function quoteForCmd(argument: string): string {
	const quoted = `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
	return quoted.replace(CMD_META, "^$1");
}

export function planSpawn(command: string, args: readonly string[], host: SpawnHost): SpawnPlan {
	if (host.platform !== "win32") return { command, args: [...args], verbatim: false };
	const resolved = resolveWindowsCommand(command, host);
	const target = resolved ?? command;
	const isBatch =
		/\.(cmd|bat)$/i.test(target) || (!resolved && KNOWN_SHIMS.includes(win32.basename(command).toLowerCase()));
	if (!isBatch) return { command: target, args: [...args], verbatim: false };
	const line = [target.replace(CMD_META, "^$1"), ...args.map(quoteForCmd)].join(" ");
	return {
		command: envValue(host.env, "ComSpec") ?? "cmd.exe",
		args: ["/d", "/s", "/c", `"${line}"`],
		verbatim: true,
	};
}

/**
 * What a server inherits from mu's own environment. Not everything: mu's
 * environment holds model keys, and a server has no business reading them.
 * This is the list the reference SDK uses, plus what `npx`-style servers need
 * behind a proxy or a mirror. Anything else a server needs is named in its
 * definition (`env`, or a `${VAR}` placeholder).
 */
const INHERITED: readonly string[] = [
	"HOME",
	"LOGNAME",
	"PATH",
	"SHELL",
	"TERM",
	"USER",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"TZ",
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"NVM_DIR",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"NODE_EXTRA_CA_CERTS",
	"NPM_CONFIG_REGISTRY",
	"APPDATA",
	"COMSPEC",
	"HOMEDRIVE",
	"HOMEPATH",
	"LOCALAPPDATA",
	"PATHEXT",
	"PROCESSOR_ARCHITECTURE",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"USERNAME",
	"USERPROFILE",
	"WINDIR",
];

export function serverEnvironment(
	parent: Readonly<Record<string, string | undefined>>,
	own: Readonly<Record<string, string>>,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(parent)) {
		// Case-insensitive, because Windows spells it `Path` and proxies are often set in lower case.
		if (value !== undefined && INHERITED.includes(key.toUpperCase())) env[key] = value;
	}
	return { ...env, ...own };
}
