import { expandPlaceholders } from "../inherit/mcp-config.ts";
import type { McpServerDefinition } from "../inherit/types.ts";
import { McpClient } from "./client.ts";
import { StreamableHttpTransport } from "./http.ts";
import { type McpCallResult, McpError, type McpTool, type McpTransport, redact } from "./protocol.ts";
import { StdioTransport } from "./stdio.ts";
import type { McpStore } from "./store.ts";

export type McpServerState = "idle" | "starting" | "running" | "failed";

export interface McpServerHost {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly projectDir: string;
	readonly home: string;
	readonly platform?: NodeJS.Platform;
	readonly clientVersion: string;
	readonly startTimeoutMs: number;
	readonly requestTimeoutMs: number;
	readonly store: McpStore;
	/** Replaces the real transports, for tests. */
	readonly createTransport?: (definition: McpServerDefinition) => McpTransport;
}

/**
 * One configured server through a session: started on first use, restarted
 * once if it dies, stopped with the session. Every text that leaves this class
 * for a person or the model has the server's own secrets taken out, because a
 * crashing server likes to print what it was started with.
 */
export class McpServer {
	readonly definition: McpServerDefinition;
	readonly id: string;
	state: McpServerState = "idle";
	/** Why it is not running, in one line, safe to show. */
	lastError: string | undefined;
	tools: McpTool[] = [];
	/** The tools were listed again: after a restart, or because the server said they changed. */
	onToolsChanged?: (tools: readonly McpTool[]) => void;
	onCrash?: (reason: string, willRestart: boolean) => void;
	private readonly host: McpServerHost;
	private client: McpClient | undefined;
	private starting: Promise<McpTool[]> | undefined;
	private restarts = 0;
	private stopped = false;
	private secrets: string[] = [];

	constructor(definition: McpServerDefinition, id: string, host: McpServerHost) {
		this.definition = definition;
		this.id = id;
		this.host = host;
	}

	/** Starts the server if it is not running and resolves to its tools. Safe to call from several places at once. */
	start(): Promise<McpTool[]> {
		if (this.state === "running") return Promise.resolve(this.tools);
		if (!this.starting) {
			this.stopped = false;
			this.state = "starting";
			this.starting = this.open()
				.then((tools) => {
					this.state = "running";
					this.lastError = undefined;
					this.tools = tools;
					return tools;
				})
				.catch((error: unknown) => {
					this.state = "failed";
					this.lastError = this.explain(error);
					throw new Error(this.lastError);
				})
				.finally(() => {
					this.starting = undefined;
				});
		}
		return this.starting;
	}

	private expand(value: string): string {
		return expandPlaceholders(value, { env: this.host.env, projectDir: this.host.projectDir, home: this.host.home });
	}

	private transport(): McpTransport {
		if (this.host.createTransport) return this.host.createTransport(this.definition);
		const definition = this.definition.transport;
		const expandAll = (map: Readonly<Record<string, string>>) =>
			Object.fromEntries(Object.entries(map).map(([key, value]) => [key, this.expand(value)]));
		if (definition.type === "stdio") {
			const env = expandAll(definition.env);
			this.secrets = Object.values(env);
			return new StdioTransport({
				command: this.expand(definition.command),
				args: definition.args.map((argument) => this.expand(argument)),
				env,
				cwd: definition.cwd ? this.expand(definition.cwd) : this.host.projectDir,
				platform: this.host.platform,
				parentEnv: this.host.env,
			});
		}
		const headers = expandAll(definition.headers);
		// "Bearer abc" is shown as "Bearer [redacted]", so the token is taken out on its own as well.
		this.secrets = Object.values(headers).flatMap((value) => [value, ...value.split(/\s+/).slice(1)]);
		return new StreamableHttpTransport({ url: this.expand(definition.url), headers });
	}

	private async open(): Promise<McpTool[]> {
		const cached = this.host.store.cached(this.definition);
		const client = new McpClient(this.transport(), {
			clientVersion: this.host.clientVersion,
			startTimeoutMs: this.definition.startTimeoutMs ?? this.host.startTimeoutMs,
			requestTimeoutMs: this.definition.requestTimeoutMs ?? this.host.requestTimeoutMs,
			era: cached?.era,
			onToolsChanged: () => void this.relist(),
			onClose: (reason) => this.crashed(client, reason),
		});
		this.client = client;
		try {
			const handshake = await client.connect();
			const tools = await client.listTools();
			this.host.store.remember(this.definition, handshake.era, tools);
			return tools;
		} catch (error) {
			this.client = undefined;
			// A remembered era that no longer holds must not fail every later start the same way.
			if (cached?.era === "modern") this.host.store.forgetEra(this.definition);
			const tail = client.diagnostics();
			await client.close().catch(() => {});
			throw Object.assign(error instanceof Error ? error : new Error(String(error)), { tail });
		}
	}

	private async relist(): Promise<void> {
		const client = this.client;
		if (!client || this.state !== "running") return;
		try {
			const tools = await client.listTools();
			if (client !== this.client) return;
			this.tools = tools;
			if (client.era) this.host.store.remember(this.definition, client.era, tools);
			this.onToolsChanged?.(tools);
		} catch {
			// The old list stays. A server that cannot list will fail its next call loudly enough.
		}
	}

	private crashed(client: McpClient, reason: string): void {
		if (client !== this.client || this.stopped) return;
		this.client = undefined;
		const tail = lastLine(client.diagnostics());
		const detail = redact(`${reason}${tail ? `; its last words: ${tail}` : ""}`, this.secrets);
		const willRestart = this.restarts < 1;
		this.onCrash?.(detail, willRestart);
		if (!willRestart) {
			this.state = "failed";
			this.lastError = `crashed again and was not restarted (${detail})`;
			return;
		}
		this.restarts++;
		this.state = "idle";
		this.lastError = `crashed (${detail})`;
		this.start()
			.then((tools) => this.onToolsChanged?.(tools))
			.catch(() => {});
	}

	async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
		if (this.state === "failed") {
			throw new Error(`The MCP server "${this.definition.name}" is not running: ${this.lastError ?? "it failed"}.`);
		}
		await this.start();
		const client = this.client;
		if (!client) throw new Error(`The MCP server "${this.definition.name}" is not running.`);
		try {
			return await client.callTool(tool, args, { signal });
		} catch (error) {
			if (error instanceof McpError && error.kind === "closed") {
				// Not repeated on its own: nobody here knows whether the call is safe to make twice.
				throw new Error(
					`The MCP server "${this.definition.name}" stopped during this call (${this.lastError ?? "it exited"}). ` +
						(this.hasFailed()
							? "It is not running any more."
							: "It was restarted; repeat the call if that is safe."),
				);
			}
			throw new Error(redact(error instanceof Error ? error.message : String(error), this.secrets));
		}
	}

	/** Asked through a method because the state changes while a call waits, which a narrowed property read does not see. */
	private hasFailed(): boolean {
		return this.state === "failed";
	}

	/** A deliberate new start, by the user: the crash budget is theirs to reset. */
	async restart(): Promise<McpTool[]> {
		await this.stop();
		this.restarts = 0;
		this.state = "idle";
		return this.start();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		const client = this.client;
		this.client = undefined;
		if (this.state !== "failed") this.state = "idle";
		await client?.close().catch(() => {});
	}

	private explain(error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		const tail = lastLine(typeof error === "object" && error !== null && "tail" in error ? String(error.tail) : "");
		return redact(`${message}${tail ? `; its last words: ${tail}` : ""}`, this.secrets).slice(0, 400);
	}
}

function lastLine(text: string): string {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return (lines[lines.length - 1] ?? "").slice(0, 200);
}
