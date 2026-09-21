import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient } from "../src/mcp/client.ts";
import { headerValue, StreamableHttpTransport } from "../src/mcp/http.ts";

interface Seen {
	method: string;
	headers: IncomingMessage["headers"];
	body: { id?: number; method?: string; params?: Record<string, unknown> } | undefined;
}

const servers: Server[] = [];
const clients: McpClient[] = [];
afterEach(async () => {
	while (clients.length > 0) await clients.pop()?.close();
	while (servers.length > 0) {
		const server = servers.pop();
		server?.closeAllConnections();
		await new Promise((done) => server?.close(done));
	}
});

type Handler = (seen: Seen, response: ServerResponse) => void;

/** A Streamable HTTP endpoint on a loopback port, scripted by the test. */
async function endpoint(handler: Handler): Promise<{ url: string; seen: Seen[] }> {
	const seen: Seen[] = [];
	const server = createServer((request, response) => {
		let text = "";
		request.on("data", (chunk) => {
			text += chunk;
		});
		request.on("end", () => {
			const entry: Seen = {
				method: request.method ?? "",
				headers: request.headers,
				body: text ? JSON.parse(text) : undefined,
			};
			seen.push(entry);
			handler(entry, response);
		});
	});
	servers.push(server);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen };
}

const json = (response: ServerResponse, body: unknown, headers: Record<string, string> = {}, status = 200) => {
	response.writeHead(status, { "Content-Type": "application/json", ...headers });
	response.end(JSON.stringify(body));
};

function connect(url: string, headers: Record<string, string> = {}, onClose?: (reason: string) => void) {
	const client = new McpClient(new StreamableHttpTransport({ url, headers }), {
		clientVersion: "test",
		startTimeoutMs: 3000,
		requestTimeoutMs: 3000,
		onClose,
	});
	clients.push(client);
	return client;
}

const echoTool = { name: "echo", description: "Echo", inputSchema: { type: "object" } };

describe("MCP client over Streamable HTTP", () => {
	it("speaks the legacy era: session id, version header, JSON and event-stream answers, DELETE at the end", async () => {
		const { url, seen } = await endpoint(({ method, body }, response) => {
			if (method === "DELETE") return void response.writeHead(405).end();
			if (body?.method === "initialize") {
				return json(
					response,
					{
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-06-18",
							capabilities: { tools: {} },
							serverInfo: { name: "remote" },
						},
					},
					{ "Mcp-Session-Id": "session-1" },
				);
			}
			if (body?.id === undefined) return void response.writeHead(202).end();
			if (body.method === "tools/list")
				return json(response, { jsonrpc: "2.0", id: body.id, result: { tools: [echoTool] } });
			// The answer to a call comes as an event stream: a comment, a progress notification, then the result.
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.write(": keep-alive\n\n");
			response.write(
				`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`,
			);
			response.end(
				`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "streamed" }] } })}\r\n\r\n`,
			);
		});
		const client = connect(url, { Authorization: "Bearer token-abcdef" });

		expect(await client.connect()).toMatchObject({
			era: "legacy",
			protocolVersion: "2025-06-18",
			serverName: "remote",
		});
		expect((await client.listTools()).map((tool) => tool.name)).toEqual(["echo"]);
		expect((await client.callTool("echo", {})).content).toEqual([{ type: "text", text: "streamed" }]);
		await client.close();

		expect(seen.map((entry) => entry.body?.method ?? entry.method)).toEqual([
			"initialize",
			"notifications/initialized",
			"tools/list",
			"tools/call",
			"DELETE",
		]);
		expect(seen[0].headers["mcp-session-id"]).toBeUndefined();
		for (const entry of seen.slice(1)) expect(entry.headers["mcp-session-id"]).toBe("session-1");
		expect(seen[2].headers["mcp-protocol-version"]).toBe("2025-06-18");
		expect(seen[2].headers.accept).toBe("application/json, text/event-stream");
		expect(seen[3].headers.authorization).toBe("Bearer token-abcdef");
	});

	it("falls forward to a modern endpoint and mirrors the method and the tool name into headers", async () => {
		const { url, seen } = await endpoint(({ body, headers }, response) => {
			if (!body || body.id === undefined) return void response.writeHead(202).end();
			if (!headers["mcp-method"]) {
				return json(
					response,
					{
						jsonrpc: "2.0",
						id: body.id,
						error: { code: -32020, message: "Header mismatch: Mcp-Method is missing" },
					},
					{},
					400,
				);
			}
			const result =
				body.method === "server/discover"
					? { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }
					: body.method === "tools/list"
						? { tools: [{ ...echoTool, name: "查询" }] }
						: { content: [{ type: "text", text: "modern" }] };
			return json(response, { jsonrpc: "2.0", id: body.id, result: { resultType: "complete", ...result } });
		});
		const client = connect(url);

		expect((await client.connect()).era).toBe("modern");
		const [tool] = await client.listTools();
		expect((await client.callTool(tool.name, {})).content).toEqual([{ type: "text", text: "modern" }]);

		const call = seen[seen.length - 1];
		expect(call.headers["mcp-protocol-version"]).toBe("2026-07-28");
		expect(call.headers["mcp-method"]).toBe("tools/call");
		expect(call.headers["mcp-name"]).toBe(`=?base64?${Buffer.from("查询").toString("base64")}?=`);
		expect(call.headers["mcp-session-id"]).toBeUndefined();
		expect((call.body?.params?._meta as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"]).toBe(
			"2026-07-28",
		);
	});

	it("says what to do about a server that wants a login, and notices an expired session", async () => {
		const locked = await endpoint((_seen, response) => void response.writeHead(401).end("Unauthorized"));
		await expect(connect(locked.url).connect()).rejects.toMatchObject({
			kind: "rpc",
			message: expect.stringContaining("mu does not do OAuth yet"),
		});

		let expired = false;
		const session = await endpoint(({ body }, response) => {
			if (body?.method === "initialize") {
				return json(
					response,
					{ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: {} } },
					{ "Mcp-Session-Id": "s" },
				);
			}
			if (body?.id === undefined) return void response.writeHead(202).end();
			if (expired) return void response.writeHead(404).end();
			return json(response, { jsonrpc: "2.0", id: body.id, result: { tools: [] } });
		});
		const closed = vi.fn();
		const client = connect(session.url, {}, closed);
		await client.connect();
		await client.listTools();
		expired = true;
		await expect(client.listTools()).rejects.toMatchObject({ message: "the server ended the session" });
		expect(closed).toHaveBeenCalledWith("the server ended the session");
	});

	it("gives up on an endpoint that is not there, and on one that never answers", async () => {
		await expect(connect("http://127.0.0.1:9/mcp").connect()).rejects.toMatchObject({ kind: "unreachable" });
		await expect(connect("file:///etc/passwd").connect()).rejects.toMatchObject({ kind: "unreachable" });

		const silent = await endpoint(({ body }, response) => {
			if (body?.method === "initialize") {
				return json(response, {
					jsonrpc: "2.0",
					id: body.id,
					result: { protocolVersion: "2025-11-25", capabilities: {} },
				});
			}
			if (body?.id === undefined) return void response.writeHead(202).end();
			// A call is never answered.
		});
		const client = connect(silent.url);
		await client.connect();
		await expect(client.callTool("echo", {}, { timeoutMs: 100 })).rejects.toMatchObject({ kind: "timeout" });
	});

	it("writes header values the way the specification wants them", () => {
		expect(headerValue("get_weather")).toBe("get_weather");
		expect(headerValue("two words")).toBe("two words");
		expect(headerValue(" padded ")).toBe("=?base64?IHBhZGRlZCA=?=");
		expect(headerValue("line1\nline2")).toBe("=?base64?bGluZTEKbGluZTI=?=");
		expect(headerValue("=?base64?literal?=")).toBe("=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
	});
});
