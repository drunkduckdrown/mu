/**
 * The part of the Model Context Protocol mu speaks: tools, over JSON-RPC 2.0.
 *
 * The protocol has two eras (specification 2026-07-28, "Versioning and
 * Compatibility"). Legacy servers, which is nearly all of them today, open with
 * an `initialize` handshake. Modern servers are stateless: there is no
 * handshake, every request carries the protocol version and the client's
 * capabilities in `_meta`, and `server/discover` tells what the server speaks.
 * mu speaks both; see `client.ts` for how it finds out which one a server is.
 */
export const LEGACY_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const MODERN_VERSION = "2026-07-28";
export type McpEra = "legacy" | "modern";

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

/** Errors only a modern server sends. Getting one of these back means "modern", whatever else went wrong. */
export const MODERN_ERROR_CODES: readonly number[] = [-32020, -32021, -32022];

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: JsonRpcId | null;
	result?: Record<string, unknown>;
	error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface McpTool {
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly inputSchema: Record<string, unknown>;
}

export type McpContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "audio"; data: string; mimeType: string }
	| { type: "resource_link"; uri: string; name?: string; description?: string; mimeType?: string }
	| { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

export interface McpCallResult {
	readonly content: readonly McpContent[];
	readonly structuredContent?: unknown;
	readonly isError: boolean;
}

export type McpErrorKind =
	/** The process could not be started or the endpoint could not be reached. */
	| "unreachable"
	/** The channel closed while something was still expected from it. */
	| "closed"
	| "timeout"
	| "aborted"
	/** The server answered with a JSON-RPC error. */
	| "rpc"
	/** The server answered with something that is not the protocol. */
	| "protocol";

export class McpError extends Error {
	readonly kind: McpErrorKind;
	readonly code?: number;
	readonly data?: unknown;

	constructor(kind: McpErrorKind, message: string, details: { code?: number; data?: unknown } = {}) {
		super(message);
		this.name = "McpError";
		this.kind = kind;
		this.code = details.code;
		this.data = details.data;
	}
}

export interface SendOptions {
	/** Aborting gives up on the response. An HTTP transport closes the request, which is how HTTP cancels. */
	readonly signal?: AbortSignal;
	/** The response is a stream that stays open (`subscriptions/listen`). */
	readonly longLived?: boolean;
}

/** One channel to one server. Everything the server says arrives through `onMessage`, whatever the transport. */
export interface McpTransport {
	readonly kind: "stdio" | "http";
	onMessage?: (message: JsonRpcMessage) => void;
	/** The channel is gone: the process exited or the connection dropped. Not called after `close()`. */
	onClose?: (reason: string) => void;
	start(): Promise<void>;
	send(message: JsonRpcMessage, options?: SendOptions): Promise<void>;
	/** Told once the handshake is over. HTTP repeats the version in a header on every request. */
	negotiated?(version: string, era: McpEra): void;
	close(): Promise<void>;
	/** The last lines the server wrote for people (stderr), for error messages. May contain anything. */
	diagnostics(): string;
}

/**
 * Text that came from a server or names its configuration can carry the
 * secrets it was started with. Every such text goes through here before it is
 * shown, logged or handed to the model.
 */
export function redact(text: string, secrets: readonly string[]): string {
	let clean = text;
	for (const secret of secrets) {
		// Short values ("1", "true", "prod") are not secrets, and replacing them would shred the text.
		if (secret.length >= 6) clean = clean.split(secret).join("[redacted]");
	}
	return clean;
}
