import { spawn } from "node:child_process";
import { join } from "node:path";
import { getAgentDir, getPowerShellConfig, getShellConfig, SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * A background command runs in the shell the foreground tools use: pi's own
 * resolution (`/bin/bash`, Git Bash on Windows, the legacy WSL launcher that
 * takes its command on stdin, the user's `shellPath`), not Node's `shell: true`,
 * which would be `cmd.exe` on Windows and `/bin/sh` elsewhere.
 *
 * Everything that differs per platform takes the platform as a parameter, so
 * the Windows paths are tested on a Mac.
 */
export interface ShellLike {
	readonly shell: string;
	readonly args: readonly string[];
	readonly commandTransport?: "argv" | "stdin";
}

export type ShellKind = "bash" | "powershell";

/** pi's PowerShell tool starts every command with this, so that non-ASCII output arrives as UTF-8. */
const POWERSHELL_UTF8 = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

/** PowerShell only where it is the user's one shell tool (`defaultTools` without `bash`, on Windows). */
export function shellKind(activeTools: readonly string[], platform: NodeJS.Platform): ShellKind {
	return platform === "win32" && activeTools.includes("powershell") && !activeTools.includes("bash")
		? "powershell"
		: "bash";
}

export function resolveShell(kind: ShellKind, shellPath?: string): ShellLike {
	return kind === "powershell" ? getPowerShellConfig() : getShellConfig(shellPath);
}

export interface ShellSettings {
	readonly shellPath?: string;
	readonly commandPrefix?: string;
}

/**
 * `shellPath` and `shellCommandPrefix` as the foreground bash tool gets them. The project's
 * settings only count in a trusted project: a repository must not pick the binary that runs.
 */
export function readShellSettings(
	cwd: string,
	agentDir: string = getAgentDir(),
	projectTrusted = false,
): ShellSettings {
	const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
	return { shellPath: settings.getShellPath(), commandPrefix: settings.getShellCommandPrefix() };
}

export interface SpawnPlan {
	readonly file: string;
	readonly args: readonly string[];
	/** Set when the shell reads its command from stdin. */
	readonly stdin?: string;
	/** A process group of its own, which is what makes killing the whole tree possible on POSIX. */
	readonly detached: boolean;
}

export function planSpawn(
	command: string,
	shell: ShellLike,
	options: { kind?: ShellKind; prefix?: string; platform: NodeJS.Platform },
): SpawnPlan {
	const prefixed = options.prefix ? `${options.prefix}\n${command}` : command;
	const script = options.kind === "powershell" ? `${POWERSHELL_UTF8}${prefixed}` : prefixed;
	const detached = options.platform !== "win32";
	return shell.commandTransport === "stdin"
		? { file: shell.shell, args: [...shell.args], stdin: script, detached }
		: { file: shell.shell, args: [...shell.args, script], detached };
}

/** The foreground tools' environment: the agent's own bin directory comes first on PATH. */
export function shellEnv(env: NodeJS.ProcessEnv, binDir: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const separator = platform === "win32" ? ";" : ":";
	const entries = (env[pathKey] ?? "").split(separator).filter(Boolean);
	return entries.includes(binDir) ? { ...env } : { ...env, [pathKey]: [binDir, ...entries].join(separator) };
}

export type KillStep =
	| { readonly kind: "signal"; readonly pid: number; readonly signal: "SIGTERM" | "SIGKILL" }
	| { readonly kind: "exec"; readonly file: string; readonly args: readonly string[] };

/**
 * How to end a job and everything it started. POSIX: a signal to the process
 * group (the negative pid). Windows has no groups: `taskkill /T` walks the
 * tree, asking first and with `/F` forcing.
 */
export function killPlan(
	pid: number,
	force: boolean,
	platform: NodeJS.Platform,
	systemRoot: string = process.env.SystemRoot ?? "C:\\Windows",
): KillStep {
	if (platform !== "win32") return { kind: "signal", pid: -pid, signal: force ? "SIGKILL" : "SIGTERM" };
	// The trusted System32 binary, so that cleanup does not depend on PATH.
	const file = `${systemRoot}\\System32\\taskkill.exe`;
	return { kind: "exec", file, args: force ? ["/T", "/F", "/PID", String(pid)] : ["/T", "/PID", String(pid)] };
}

/** Never throws: a process that is already gone is the outcome that was asked for. */
export function runKillStep(step: KillStep): void {
	try {
		if (step.kind === "exec") {
			const child = spawn(step.file, [...step.args], { stdio: "ignore", detached: true, windowsHide: true });
			child.once("error", () => {});
			child.unref();
			return;
		}
		try {
			process.kill(step.pid, step.signal);
		} catch {
			// No group under that id (the shell was not a group leader): the process itself, then.
			if (step.pid < 0) process.kill(-step.pid, step.signal);
		}
	} catch {
		/* gone already */
	}
}

/** POSIX only: whether anything is left in the job's process group. */
export function groupAlive(pid: number, platform: NodeJS.Platform): boolean {
	if (platform === "win32") return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function agentBinDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, "bin");
}
