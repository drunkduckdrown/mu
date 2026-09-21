import {
	type JsonRpcMessage,
	type JsonRpcResponse,
	type McpEra,
	McpError,
	type McpTransport,
	type SendOptions,
} from "./protocol.ts";

export interface HttpTransportOptions {
	readonly url: string;
	/** Sent with every request. May hold secrets; never shown. */
	readonly headers: Readonly<Record<string, string>>;
	/** Replaces the global `fetch`, for tests. */
	readonly fetch?: typeof fetch;
}

const SENTINEL = /^=\?base64\?.*\?=$/;

/** A header value as it may travel: plain when it is visible ASCII without edges of whitespace, otherwise the base64 form the specification defines. */
export function headerValue(value: string): string {
	const plain = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(value) && !SENTINEL.test(value);
	return plain ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** The JSON-RPC messages of a Server-Sent Events body, as they arrive. Comments, event names and ids are of no use here. */
export async function readEventStream(
	body: ReadableStream<Uint8Array>,
	onMessage: (message: JsonRpcMessage) => void,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let data: string[] = [];
	const flush = () => {
		if (data.length === 0) return;
		const text = data.join("\n");
		data = [];
		try {
			const parsed: unknown = JSON.parse(text);
			if (typeof parsed === "object" && parsed !== null) onMessage(parsed as JsonRpcMessage);
		} catch {
			// Not a message. Keep-alives and greetings are allowed to be anything.
		}
	};
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		for (;;) {
			const end = buffer.search(/\r\n|\n|\r/);
			if (end === -1) break;
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + (buffer.startsWith("\r\n", end) ? 2 : 1));
			if (line === "") flush();
			else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
		}
	}
	flush();
}

/**
 * Streamable HTTP: every message is its own POST, and the answer is either one
 * JSON object or an event stream that ends with it.
 *
 * Both eras are spoken. Legacy (2025-03-26 to 2025-11-25): the server may hand
 * out an `Mcp-Session-Id` with its answer to `initialize`, which then goes on
 * every request and is given back with a DELETE at the end; a 404 means the
 * session expired. Modern (2026-07-28): no session, and the method and the
 * tool name are repeated in `Mcp-Method` and `Mcp-Name` headers.
 *
 * Not done: OAuth (a 401 is reported with what to do instead), the legacy GET
 * stream for notifications outside a request, and the HTTP+SSE transport of
 * 2024-11-05.
 */
export class StreamableHttpTransport implements McpTransport {
	readonly kind = "http" as const;
	onMessage?: (message: JsonRpcMessage) => void;
	onClose?: (reason: string) => void;
	private readonly options: HttpTransportOptions;
	private readonly inFlight = new Set<AbortController>();
	private version: string | undefined;
	private era: McpEra | undefined;
	private sessionId: string | undefined;
	private lastProblem = "";
	private closed = false;

	constructor(options: HttpTransportOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		let protocol = "";
		try {
			protocol = new URL(this.options.url).protocol;
		} catch {
			// Reported below, without the URL: it may carry a key.
		}
		if (protocol !== "http:" && protocol !== "https:") {
			throw new McpError("unreachable", "the server's url is not an http(s) address");
		}
	}

	negotiated(version: string, era: McpEra): void {
		this.version = version;
		this.era = era;
	}

	diagnostics(): string {
		return this.lastProblem;
	}

	async send(message: JsonRpcMessage, options: SendOptions = {}): Promise<void> {
		if (this.closed) throw new McpError("closed", "the connection was closed");
		const id = "id" in message && "method" in message ? message.id : undefined;
		const method = "method" in message ? message.method : undefined;
		const params = "params" in message ? message.params : undefined;
		const modern =
			params?._meta !== undefined && "io.modelcontextprotocol/protocolVersion" in (params._meta as object);
		const headers: Record<string, string> = {
			...this.options.headers,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...options.headers,
		};
		if (modern) {
			headers["MCP-Protocol-Version"] = String(
				(params?._meta as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"],
			);
			if (method) headers["Mcp-Method"] = method;
			if (method === "tools/call" && typeof params?.name === "string")
				headers["Mcp-Name"] = headerValue(params.name);
		} else {
			if (this.version && this.era === "legacy") headers["MCP-Protocol-Version"] = this.version;
			if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
		}

		const abort = new AbortController();
		const onAbort = () => abort.abort();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		this.inFlight.add(abort);
		let answered = false;
		const deliver = (incoming: JsonRpcMessage) => {
			if ("id" in incoming && incoming.id === id && !("method" in incoming)) answered = true;
			this.onMessage?.(incoming);
		};
		try {
			const response = await (this.options.fetch ?? fetch)(this.options.url, {
				method: "POST",
				headers,
				body: JSON.stringify(message),
				signal: abort.signal,
			});
			if (method === "initialize") this.sessionId = response.headers.get("mcp-session-id") ?? undefined;
			const type = response.headers.get("content-type") ?? "";
			if (response.ok && type.includes("text/event-stream") && response.body) {
				await readEventStream(response.body, deliver);
			} else {
				const text = await response.text();
				let parsed: unknown;
				try {
					parsed = text ? JSON.parse(text) : undefined;
				} catch {
					parsed = undefined;
				}
				for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
					if (typeof entry === "object" && entry !== null && "jsonrpc" in entry) deliver(entry as JsonRpcMessage);
				}
				if (!response.ok) this.refused(response.status, id, answered);
			}
			if (id !== undefined && !answered && response.ok && !abort.signal.aborted) {
				this.answer(id, -32000, "the server closed the response before answering");
			}
		} catch (error) {
			if (abort.signal.aborted) return;
			this.lastProblem = `the server could not be reached (${(error as { cause?: { code?: string } }).cause?.code ?? "network error"})`;
			throw new McpError("unreachable", this.lastProblem);
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
			this.inFlight.delete(abort);
		}
	}

	private answer(id: JsonRpcResponse["id"], code: number, message: string): void {
		this.onMessage?.({ jsonrpc: "2.0", id, error: { code, message } });
	}

	private refused(status: number, id: JsonRpcResponse["id"] | undefined, answered: boolean): void {
		const expired = status === 404 && this.sessionId !== undefined;
		this.lastProblem =
			status === 401 || status === 403
				? `the server wants authorization (HTTP ${status}). mu does not do OAuth yet: give the server a token in a header in mu.json`
				: expired
					? "the server ended the session"
					: `the server answered HTTP ${status}`;
		if (id !== undefined && id !== null && !answered) this.answer(id, -32000, this.lastProblem);
		if (expired && !this.closed) {
			// The owner opens a new session, the way it restarts a process that died.
			this.sessionId = undefined;
			this.onClose?.(this.lastProblem);
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const abort of this.inFlight) abort.abort();
		this.inFlight.clear();
		if (!this.sessionId) return;
		try {
			// Giving the session back is a courtesy. A server may not allow it, and mu does not wait long for it.
			await (this.options.fetch ?? fetch)(this.options.url, {
				method: "DELETE",
				headers: { ...this.options.headers, "Mcp-Session-Id": this.sessionId },
				signal: AbortSignal.timeout(1500),
			});
		} catch {
			// Best effort.
		}
	}
}
