import {
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcResponse,
	LEGACY_VERSIONS,
	type McpCallResult,
	type McpContent,
	type McpEra,
	McpError,
	type McpTool,
	type McpTransport,
	META_CLIENT_CAPABILITIES,
	META_CLIENT_INFO,
	META_PROTOCOL_VERSION,
	MODERN_ERROR_CODES,
	MODERN_VERSION,
} from "./protocol.ts";

export interface McpClientOptions {
	readonly clientVersion: string;
	/** For the first answer of a server, which for an `npx` server includes downloading it. */
	readonly startTimeoutMs: number;
	readonly requestTimeoutMs: number;
	/** What this server turned out to be last time. Saves the round trip a modern-only server would otherwise cost. */
	readonly era?: McpEra;
	/** The server says its tools changed. */
	readonly onToolsChanged?: () => void;
	/** The channel closed without `close()` having been called: the server crashed. */
	readonly onClose?: (reason: string) => void;
}

export interface McpHandshake {
	readonly era: McpEra;
	readonly protocolVersion: string;
	readonly serverName?: string;
	readonly toolsListChanged: boolean;
}

interface Pending {
	readonly resolve: (result: Record<string, unknown>) => void;
	readonly reject: (error: McpError) => void;
	readonly cleanup: () => void;
}

const MAX_TOOL_PAGES = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One MCP session over one transport: the opening, `tools/list`, `tools/call`,
 * and the housekeeping a server may expect (answers to its pings, a refusal
 * for anything else it asks, cancellation of what timed out).
 *
 * Which era a server belongs to is found out by opening the legacy way first:
 * a legacy or dual-era server answers `initialize`, a modern-only server must
 * reject it with a JSON-RPC error, and then `server/discover` is tried. The
 * specification suggests probing with `server/discover` first on stdio and
 * reading silence as "legacy". That was not done here on purpose: silence is
 * also what a server that is still starting sounds like (an `npx` server
 * downloads itself first), so the probe would have to wait out the whole start
 * timeout before falling back. Nearly every server in use is legacy, and this
 * order costs them nothing.
 */
export class McpClient {
	private readonly transport: McpTransport;
	private readonly options: McpClientOptions;
	private readonly pending = new Map<JsonRpcId, Pending>();
	private nextId = 1;
	private closed = false;
	private handshake: McpHandshake | undefined;

	constructor(transport: McpTransport, options: McpClientOptions) {
		this.transport = transport;
		this.options = options;
		transport.onMessage = (message) => this.receive(message);
		transport.onClose = (reason) => {
			const wasClosed = this.closed;
			this.fail(new McpError("closed", reason));
			if (!wasClosed) options.onClose?.(reason);
		};
	}

	get era(): McpEra | undefined {
		return this.handshake?.era;
	}

	async connect(): Promise<McpHandshake> {
		await this.transport.start();
		const first: McpEra = this.options.era ?? "legacy";
		const open = (era: McpEra) => (era === "legacy" ? this.openLegacy() : this.openModern());
		try {
			this.handshake = await open(first);
		} catch (error) {
			// Only an answer tells the two eras apart. A timeout or a dead process is a failure in either.
			const answered = error instanceof McpError && (error.kind === "rpc" || error.kind === "protocol");
			const modernRefusal = first === "modern" && error instanceof McpError && isModernError(error);
			if (!answered || modernRefusal) throw error;
			try {
				this.handshake = await open(first === "legacy" ? "modern" : "legacy");
			} catch {
				throw error;
			}
		}
		this.transport.negotiated?.(this.handshake.protocolVersion, this.handshake.era);
		if (this.handshake.era === "legacy") {
			await this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		} else if (this.handshake.toolsListChanged) {
			// A modern server only reports changes to who asked. The request stays open for as long as the session does.
			void this.request(
				"subscriptions/listen",
				{ notifications: { toolsListChanged: true } },
				{ timeoutMs: 0, longLived: true },
			).catch(() => {});
		}
		return this.handshake;
	}

	private async openLegacy(): Promise<McpHandshake> {
		const result = await this.request(
			"initialize",
			{
				protocolVersion: LEGACY_VERSIONS[0],
				capabilities: {},
				clientInfo: { name: "mu", version: this.options.clientVersion },
			},
			{ timeoutMs: this.options.startTimeoutMs, era: "legacy" },
		);
		const version = result.protocolVersion;
		if (typeof version !== "string" || !LEGACY_VERSIONS.includes(version)) {
			throw new McpError("protocol", `the server speaks protocol version "${String(version)}", which mu does not`);
		}
		const capabilities = isRecord(result.capabilities) ? result.capabilities : {};
		const tools = isRecord(capabilities.tools) ? capabilities.tools : {};
		const serverInfo = isRecord(result.serverInfo) ? result.serverInfo : {};
		return {
			era: "legacy",
			protocolVersion: version,
			serverName: typeof serverInfo.name === "string" ? serverInfo.name : undefined,
			toolsListChanged: tools.listChanged === true,
		};
	}

	private async openModern(): Promise<McpHandshake> {
		const result = await this.request(
			"server/discover",
			{},
			{ timeoutMs: this.options.startTimeoutMs, era: "modern" },
		);
		const versions = Array.isArray(result.supportedVersions) ? result.supportedVersions : [];
		if (!versions.includes(MODERN_VERSION)) {
			throw new McpError(
				"protocol",
				`the server speaks protocol versions ${versions.map(String).join(", ") || "(none named)"}, mu speaks ${MODERN_VERSION}`,
			);
		}
		const capabilities = isRecord(result.capabilities) ? result.capabilities : {};
		const tools = isRecord(capabilities.tools) ? capabilities.tools : {};
		const meta = isRecord(result._meta) ? result._meta : {};
		const serverInfo = isRecord(meta["io.modelcontextprotocol/serverInfo"])
			? meta["io.modelcontextprotocol/serverInfo"]
			: {};
		return {
			era: "modern",
			protocolVersion: MODERN_VERSION,
			serverName: typeof serverInfo.name === "string" ? serverInfo.name : undefined,
			toolsListChanged: tools.listChanged === true,
		};
	}

	/** Every tool the server offers, all pages of them. */
	async listTools(): Promise<McpTool[]> {
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MAX_TOOL_PAGES; page++) {
			const result = await this.request("tools/list", cursor === undefined ? {} : { cursor });
			for (const entry of Array.isArray(result.tools) ? result.tools : []) {
				if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name) continue;
				tools.push({
					name: entry.name,
					title: typeof entry.title === "string" ? entry.title : undefined,
					description: typeof entry.description === "string" ? entry.description : undefined,
					inputSchema: isRecord(entry.inputSchema) ? entry.inputSchema : { type: "object" },
				});
			}
			cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
			if (cursor === undefined) break;
		}
		return tools;
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		options: { signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<McpCallResult> {
		const result = await this.request("tools/call", { name, arguments: args }, options);
		const content = (Array.isArray(result.content) ? result.content : []).filter(
			(block): block is McpContent => isRecord(block) && typeof block.type === "string",
		);
		return { content, structuredContent: result.structuredContent, isError: result.isError === true };
	}

	private request(
		method: string,
		params: Record<string, unknown>,
		options: { signal?: AbortSignal; timeoutMs?: number; era?: McpEra; longLived?: boolean } = {},
	): Promise<Record<string, unknown>> {
		if (this.closed) return Promise.reject(new McpError("closed", "the server is not running"));
		if (options.signal?.aborted) return Promise.reject(new McpError("aborted", "the call was cancelled"));
		const era = options.era ?? this.handshake?.era ?? "legacy";
		const id = this.nextId++;
		const body =
			era === "modern"
				? {
						...params,
						_meta: {
							...(isRecord(params._meta) ? params._meta : {}),
							[META_PROTOCOL_VERSION]: MODERN_VERSION,
							[META_CLIENT_INFO]: { name: "mu", version: this.options.clientVersion },
							[META_CLIENT_CAPABILITIES]: {},
						},
					}
				: params;
		const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs;
		const abort = new AbortController();

		return new Promise<Record<string, unknown>>((resolve, reject) => {
			const giveUp = (error: McpError) => {
				const entry = this.pending.get(id);
				if (!entry) return;
				this.pending.delete(id);
				entry.cleanup();
				abort.abort();
				// `initialize` must not be cancelled, and over modern HTTP closing the request is the cancellation.
				if (method !== "initialize" && !(era === "modern" && this.transport.kind === "http")) {
					void this.transport
						.send({
							jsonrpc: "2.0",
							method: "notifications/cancelled",
							params: { requestId: id, reason: error.kind },
						})
						.catch(() => {});
				}
				reject(error);
			};
			const timer =
				timeoutMs > 0
					? setTimeout(
							() =>
								giveUp(
									new McpError("timeout", `no answer to ${method} within ${Math.round(timeoutMs / 1000)} s`),
								),
							timeoutMs,
						)
					: undefined;
			const onAbort = () => giveUp(new McpError("aborted", "the call was cancelled"));
			options.signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, {
				resolve,
				reject,
				cleanup: () => {
					clearTimeout(timer);
					options.signal?.removeEventListener("abort", onAbort);
				},
			});
			this.transport
				.send({ jsonrpc: "2.0", id, method, params: body }, { signal: abort.signal, longLived: options.longLived })
				.catch((error: unknown) => {
					const entry = this.pending.get(id);
					if (!entry) return;
					this.pending.delete(id);
					entry.cleanup();
					reject(error instanceof McpError ? error : new McpError("closed", "the message could not be sent"));
				});
		});
	}

	private receive(message: JsonRpcMessage): void {
		if (!isRecord(message)) return;
		if ("method" in message && typeof message.method === "string") {
			const id: unknown = "id" in message ? message.id : undefined;
			if (typeof id === "string" || typeof id === "number") {
				// A legacy server may ask things of its client. Pings are answered; nothing else was offered.
				const reply: JsonRpcResponse =
					message.method === "ping"
						? { jsonrpc: "2.0", id, result: {} }
						: { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
				void this.transport.send(reply).catch(() => {});
			} else if (message.method === "notifications/tools/list_changed") {
				this.options.onToolsChanged?.();
			}
			return;
		}
		const response = message as JsonRpcResponse;
		if (response.id === null || response.id === undefined) return;
		const entry = this.pending.get(response.id);
		if (!entry) return;
		this.pending.delete(response.id);
		entry.cleanup();
		if (response.error) {
			const text = typeof response.error.message === "string" ? response.error.message : "error";
			entry.reject(
				new McpError("rpc", text.slice(0, 500), { code: response.error.code, data: response.error.data }),
			);
			return;
		}
		const result = isRecord(response.result) ? response.result : {};
		// A result without a type is a complete one: that is how every legacy server answers.
		const type = result.resultType ?? "complete";
		if (type === "input_required") {
			entry.reject(new McpError("protocol", "the server asked the client for input, which mu does not provide yet"));
		} else if (type !== "complete") {
			entry.reject(new McpError("protocol", `the server sent a result of unknown type "${String(type)}"`));
		} else {
			entry.resolve(result);
		}
	}

	private fail(error: McpError): void {
		this.closed = true;
		for (const [id, entry] of [...this.pending]) {
			this.pending.delete(id);
			entry.cleanup();
			entry.reject(error);
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.fail(new McpError("closed", "the session was closed"));
		await this.transport.close();
	}

	/** What the server last wrote for people. May contain anything, including what it was configured with. */
	diagnostics(): string {
		return this.transport.diagnostics();
	}
}

function isModernError(error: McpError): boolean {
	return error.code !== undefined && MODERN_ERROR_CODES.includes(error.code);
}
