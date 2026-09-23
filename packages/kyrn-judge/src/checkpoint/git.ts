import { spawn } from "node:child_process";
import { join } from "node:path";

export interface GitResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	/** Output stopped at `OutputLimit.maxEntries` and git was ended: `stdout` holds only the first entries. */
	readonly truncated?: boolean;
}

/** How much NUL-separated output (`-z`) is wanted at most. A listing of a huge folder is cut off there. */
export interface OutputLimit {
	readonly maxEntries: number;
}

/** The exit code a command gets when it outlived the runner's time limit. */
export const TIMED_OUT = 124;

/**
 * Runs git with exactly this environment. Injected into the store so its logic is tested without
 * caring how a process is started, and so a test can stand in for a machine without git.
 */
export type GitRun = (
	args: readonly string[],
	env: Readonly<Record<string, string>>,
	input?: string,
	limit?: OutputLimit,
) => Promise<GitResult>;

/** git is not installed, or could not be started. The feature says so once and stays quiet. */
export class GitMissing extends Error {
	constructor(binary: string, cause?: unknown) {
		super(`"${binary}" could not be started`, { cause });
		this.name = "GitMissing";
	}
}

/** A git command that ran and failed. */
export class GitFailed extends Error {
	readonly result: GitResult;
	constructor(args: readonly string[], result: GitResult) {
		super(`git ${args[0]} exited with ${result.code}: ${result.stderr.trim().slice(0, 300)}`);
		this.name = "GitFailed";
		this.result = result;
	}
}

/**
 * The real runner: no shell, an argument array, no console window on Windows. `git.exe` is a real
 * executable there, so no `.cmd` shim is involved. A command that outlives `timeoutMs` is killed and
 * reported as failed, so a huge project costs a turn its checkpoint rather than its start. With a
 * `limit`, git is ended as soon as its output holds more entries than that, and only those are kept.
 */
export function spawnGit(binary = "git", timeoutMs = 30_000): GitRun {
	return (args, env, input, limit) =>
		new Promise<GitResult>((resolve, reject) => {
			let child: ReturnType<typeof spawn>;
			try {
				child = spawn(binary, [...args], { env: { ...env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
			} catch (error) {
				reject(new GitMissing(binary, error));
				return;
			}
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			let timedOut = false;
			let entries = 0;
			let truncated = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill();
			}, timeoutMs);
			timer.unref?.();
			child.stdout?.on("data", (chunk: Buffer) => {
				if (truncated) return;
				out.push(chunk);
				if (!limit) return;
				for (let at = chunk.indexOf(0); at !== -1; at = chunk.indexOf(0, at + 1)) entries++;
				if (entries > limit.maxEntries) {
					truncated = true;
					child.kill();
				}
			});
			child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
			child.on("error", (error) => {
				clearTimeout(timer);
				reject(new GitMissing(binary, error));
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (truncated) {
					resolve({ code: 0, stdout: Buffer.concat(out).toString("utf8"), stderr: "", truncated: true });
					return;
				}
				resolve({
					code: timedOut ? TIMED_OUT : (code ?? 1),
					stdout: Buffer.concat(out).toString("utf8"),
					stderr: timedOut ? `timed out after ${timeoutMs} ms` : Buffer.concat(err).toString("utf8"),
				});
			});
			// A git that exits before reading its input must not take the process down with EPIPE.
			child.stdin?.on("error", () => {});
			child.stdin?.end(input ?? "");
		});
}

/**
 * The environment every shadow command runs in. Whatever `GIT_*` the agent was started with is
 * dropped first: inside a git hook `GIT_INDEX_FILE` points at the user's real index, and one
 * inherited variable would be enough to make a snapshot write there.
 */
export function shadowEnv(
	base: Readonly<Record<string, string | undefined>>,
	gitDir: string,
	workTree: string,
	indexFile = join(gitDir, "index"),
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined && !key.toUpperCase().startsWith("GIT_")) env[key] = value;
	}
	return {
		...env,
		GIT_DIR: gitDir,
		GIT_WORK_TREE: workTree,
		GIT_INDEX_FILE: indexFile,
		// Snapshots are nobody's commits: no dependence on, and no trace of, the user's identity.
		GIT_AUTHOR_NAME: "mu",
		GIT_AUTHOR_EMAIL: "mu@localhost",
		GIT_COMMITTER_NAME: "mu",
		GIT_COMMITTER_EMAIL: "mu@localhost",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
		// Paths are taken as they are: a file called "a[1].txt" or ":x" is not a pattern.
		GIT_LITERAL_PATHSPECS: "1",
	};
}
