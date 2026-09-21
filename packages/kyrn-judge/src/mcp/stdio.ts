import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { type JsonRpcMessage, McpError, type McpTransport } from "./protocol.ts";
import { planSpawn, serverEnvironment } from "./spawn.ts";

export interface StdioTransportOptions {
	readonly command: string;
	readonly args: readonly string[];
	/** The definition's own variables, placeholders already filled in. */
	readonly env: Readonly<Record<string, string>>;
	readonly cwd?: string;
	readonly platform?: NodeJS.Platform;
	/** mu's own environment, of which only a safe part is passed on. */
	readonly parentEnv?: Readonly<Record<string, string | undefined>>;
	/** How long a server gets to exit after its input closed before it is killed. */
	readonly exitGraceMs?: number;
}

const STDERR_LINES = 40;
const STDERR_LINE_CHARS = 400;
/** A line without an end is not a message. Past this size the buffer is dropped instead of grown. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * A server as a child process: one JSON-RPC message per line on its stdin and
 * stdout, whatever it wants to say to people on stderr (kept, bounded, for
 * error messages). Shutdown follows the specification: close its input, wait,
 * then kill.
 */
export class StdioTransport implements McpTransport {
	readonly kind = "stdio" as const;
	onMessage?: (message: JsonRpcMessage) => void;
	onClose?: (reason: string) => void;
	private readonly options: StdioTransportOptions;
	private child: ChildProcess | undefined;
	private buffer = "";
	private stderrTail: string[] = [];
	private stderrPartial = "";
	private closing = false;
	private exited: Promise<void> = Promise.resolve();

	constructor(options: StdioTransportOptions) {
		this.options = options;
	}

	start(): Promise<void> {
		const platform = this.options.platform ?? process.platform;
		const parentEnv = this.options.parentEnv ?? process.env;
		const plan = planSpawn(this.options.command, this.options.args, {
			platform,
			env: parentEnv,
			exists: existsSync,
			cwd: this.options.cwd,
		});
		return new Promise<void>((resolve, reject) => {
			let child: ChildProcess;
			try {
				child = spawn(plan.command, [...plan.args], {
					cwd: this.options.cwd,
					env: serverEnvironment(parentEnv, this.options.env),
					stdio: ["pipe", "pipe", "pipe"],
					shell: false,
					windowsHide: true,
					windowsVerbatimArguments: plan.verbatim,
				});
			} catch (error) {
				reject(new McpError("unreachable", `could not start "${this.options.command}": ${describe(error)}`));
				return;
			}
			this.child = child;
			let settled = false;
			this.exited = new Promise<void>((done) => {
				child.once("close", (code, signal) => {
					done();
					const reason = signal ? `the server was stopped by ${signal}` : `the server exited with code ${code}`;
					if (!settled) {
						settled = true;
						reject(new McpError("unreachable", reason));
					}
					if (!this.closing) this.onClose?.(reason);
				});
			});
			// `on`, not `once`: an emitter without an error listener throws, and a failing kill can emit a second one.
			child.on("error", (error) => {
				const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
				const reason = missing
					? `the command "${this.options.command}" was not found`
					: `could not start "${this.options.command}": ${describe(error)}`;
				if (!settled) {
					settled = true;
					reject(new McpError("unreachable", reason));
				}
			});
			child.once("spawn", () => {
				if (settled) return;
				settled = true;
				resolve();
			});
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => this.readOutput(chunk));
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => this.readDiagnostics(chunk));
			// A server that died takes its pipe with it; the write error is the exit, reported above.
			child.stdin?.on("error", () => {});
		});
	}

	private readOutput(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const end = this.buffer.indexOf("\n");
			if (end === -1) break;
			const line = this.buffer.slice(0, end).trim();
			this.buffer = this.buffer.slice(end + 1);
			if (!line) continue;
			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				// Some servers greet on stdout. That breaks the rules, not the session.
				continue;
			}
			if (typeof message === "object" && message !== null) this.onMessage?.(message as JsonRpcMessage);
		}
		if (this.buffer.length > MAX_LINE_BYTES) this.buffer = "";
	}

	private readDiagnostics(chunk: string): void {
		const lines = (this.stderrPartial + chunk).split("\n");
		this.stderrPartial = (lines.pop() ?? "").slice(-STDERR_LINE_CHARS);
		for (const line of lines) {
			const text = line.trim();
			if (text) this.stderrTail.push(text.slice(0, STDERR_LINE_CHARS));
		}
		if (this.stderrTail.length > STDERR_LINES) this.stderrTail = this.stderrTail.slice(-STDERR_LINES);
	}

	diagnostics(): string {
		const partial = this.stderrPartial.trim();
		return [...this.stderrTail, ...(partial ? [partial] : [])].join("\n");
	}

	send(message: JsonRpcMessage): Promise<void> {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) {
			return Promise.reject(new McpError("closed", "the server is not running"));
		}
		return new Promise<void>((resolve, reject) => {
			stdin.write(`${JSON.stringify(message)}\n`, (error) =>
				error ? reject(new McpError("closed", "the server is not running")) : resolve(),
			);
		});
	}

	async close(): Promise<void> {
		const child = this.child;
		if (!child || this.closing) return;
		this.closing = true;
		child.stdin?.end();
		const grace = this.options.exitGraceMs ?? 2000;
		if (await this.exitedWithin(grace)) return;
		forceKill(child, this.options.platform ?? process.platform, false);
		if (await this.exitedWithin(grace)) return;
		forceKill(child, this.options.platform ?? process.platform, true);
	}

	private exitedWithin(ms: number): Promise<boolean> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), ms);
		});
		return Promise.race([this.exited.then(() => true), timeout]).finally(() => clearTimeout(timer));
	}
}

function describe(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code ?? (error instanceof Error ? error.name : "error");
}

/** Windows has no signals, and a `.cmd` shim leaves the real server as a grandchild: the whole tree goes. */
function forceKill(child: ChildProcess, platform: NodeJS.Platform, hard: boolean): void {
	try {
		if (platform === "win32" && child.pid !== undefined) {
			spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on(
				"error",
				() => child.kill(),
			);
		} else {
			child.kill(hard ? "SIGKILL" : "SIGTERM");
		}
	} catch {
		// Already gone.
	}
}
