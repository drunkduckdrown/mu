import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient, type McpClientOptions } from "../src/mcp/client.ts";
import { McpError, redact } from "../src/mcp/protocol.ts";
import { planSpawn, resolveWindowsCommand, serverEnvironment } from "../src/mcp/spawn.ts";
import { StdioTransport } from "../src/mcp/stdio.ts";

const FAKE_SERVER = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

const clients: McpClient[] = [];
afterEach(async () => {
	while (clients.length > 0) await clients.pop()?.close();
});

function client(args: string[] = [], options: Partial<McpClientOptions> = {}, env: Record<string, string> = {}) {
	const transport = new StdioTransport({
		command: process.execPath,
		args: [FAKE_SERVER, ...args],
		env,
		exitGraceMs: 500,
	});
	const created = new McpClient(transport, {
		clientVersion: "test",
		startTimeoutMs: 5000,
		requestTimeoutMs: 5000,
		...options,
	});
	clients.push(created);
	return created;
}

describe("MCP client over stdio", () => {
	it("opens a legacy server, lists every page of its tools and calls one", async () => {
		const mcp = client(["--banner"]);
		const handshake = await mcp.connect();
		expect(handshake).toEqual({
			era: "legacy",
			protocolVersion: "2025-06-18",
			serverName: "fake",
			toolsListChanged: true,
		});

		const tools = await mcp.listTools();
		expect(tools.map((tool) => tool.name)).toEqual([
			"echo",
			"fail",
			"picture",
			"hang",
			"crash",
			"grow",
			"pad.one",
			"pad one",
		]);
		expect(tools[0]).toMatchObject({
			description: "Echo a message back",
			inputSchema: { type: "object", required: ["message"] },
		});

		expect(await mcp.callTool("echo", { message: "hi" })).toEqual({
			content: [{ type: "text", text: "echo: hi" }],
			structuredContent: undefined,
			isError: false,
		});
		const failed = await mcp.callTool("fail", {});
		expect(failed.isError).toBe(true);
		const picture = await mcp.callTool("picture", {});
		expect(picture.content[1]).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
		await expect(mcp.callTool("nope", {})).rejects.toMatchObject({ kind: "rpc", code: -32602 });
	});

	it("falls forward to a modern server that refuses the handshake, and hears about changed tools", async () => {
		const changed = vi.fn();
		const mcp = client(["--era", "modern"], { onToolsChanged: changed });
		expect(await mcp.connect()).toEqual({
			era: "modern",
			protocolVersion: "2026-07-28",
			serverName: "fake-modern",
			toolsListChanged: true,
		});
		expect((await mcp.listTools()).length).toBe(8);
		expect((await mcp.callTool("echo", { message: "stateless" })).content).toEqual([
			{ type: "text", text: "echo: stateless" },
		]);
		await mcp.callTool("grow", {});
		await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
		expect((await mcp.listTools()).map((tool) => tool.name)).toContain("late");
	});

	it("goes straight to the era it is told, and back when that turns out wrong", async () => {
		const modern = client(["--era", "modern"], { era: "modern" });
		expect((await modern.connect()).era).toBe("modern");
		const legacy = client([], { era: "modern" });
		expect((await legacy.connect()).era).toBe("legacy");
		const dual = client(["--era", "dual"]);
		expect((await dual.connect()).era).toBe("legacy");
	});

	it("hears a legacy server announce changed tools", async () => {
		const changed = vi.fn();
		const mcp = client([], { onToolsChanged: changed });
		await mcp.connect();
		await mcp.callTool("grow", {});
		await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
	});

	it("gives up on a call that gets no answer, and on one the user cancels", async () => {
		const mcp = client();
		await mcp.connect();
		await expect(mcp.callTool("hang", {}, { timeoutMs: 80 })).rejects.toMatchObject({ kind: "timeout" });
		const abort = new AbortController();
		const call = mcp.callTool("hang", {}, { signal: abort.signal });
		abort.abort();
		await expect(call).rejects.toMatchObject({ kind: "aborted" });
		// The session is still good afterwards.
		expect((await mcp.callTool("echo", { message: "still here" })).isError).toBe(false);
	});

	it("reports a crash to whoever is waiting and to the owner, with what the server last said", async () => {
		const closed = vi.fn();
		const mcp = client([], { onClose: closed });
		await mcp.connect();
		await expect(mcp.callTool("crash", {})).rejects.toMatchObject({ kind: "closed" });
		await vi.waitFor(() => expect(closed).toHaveBeenCalledWith("the server exited with code 3"));
		expect(mcp.diagnostics()).toContain("panic: out of cheese");
		await expect(mcp.callTool("echo", { message: "x" })).rejects.toMatchObject({ kind: "closed" });
	});

	it("says why a server did not start", async () => {
		const dead = client(["--crash-on-start"]);
		await expect(dead.connect()).rejects.toBeInstanceOf(McpError);
		expect(dead.diagnostics()).toContain("cannot open database");

		const missing = new McpClient(new StdioTransport({ command: "mu-no-such-command-anywhere", args: [], env: {} }), {
			clientVersion: "test",
			startTimeoutMs: 2000,
			requestTimeoutMs: 2000,
		});
		await expect(missing.connect()).rejects.toMatchObject({
			kind: "unreachable",
			message: 'the command "mu-no-such-command-anywhere" was not found',
		});

		const mute = client(["--silent-before-init", "--era", "legacy"], { startTimeoutMs: 150, era: "modern" });
		await expect(mute.connect()).rejects.toMatchObject({ kind: "timeout" });

		const future = client(["--version", "2031-01-01"]);
		await expect(future.connect()).rejects.toMatchObject({ kind: "protocol" });
	});

	it("does not tell a server about mu's own secrets, and closes it cleanly", async () => {
		const transport = new StdioTransport({
			command: process.execPath,
			args: [FAKE_SERVER, "--leak-env", "ANTHROPIC_API_KEY"],
			env: { OWN: "value" },
			parentEnv: { ...process.env, ANTHROPIC_API_KEY: "sk-parent-secret" },
			exitGraceMs: 500,
		});
		const mcp = new McpClient(transport, { clientVersion: "test", startTimeoutMs: 5000, requestTimeoutMs: 5000 });
		await mcp.connect();
		await vi.waitFor(() => expect(mcp.diagnostics()).toContain("starting with token"));
		expect(mcp.diagnostics()).toContain("starting with token undefined");
		const closed = vi.fn();
		transport.onClose = closed;
		await mcp.close();
		expect(closed).not.toHaveBeenCalled();
	});
});

describe("starting a server's command", () => {
	it("passes the command through untouched outside Windows", () => {
		expect(planSpawn("npx", ["-y", "server"], { platform: "darwin", env: {}, exists: () => false })).toEqual({
			command: "npx",
			args: ["-y", "server"],
			verbatim: false,
		});
	});

	it("runs a .cmd shim through cmd.exe on Windows, quoted by hand", () => {
		const files = new Set([
			"C:\\Program Files\\nodejs\\npx.cmd",
			"C:\\Program Files\\nodejs\\node.exe",
			"C:\\tools\\uvx.exe",
		]);
		const host = {
			platform: "win32" as const,
			env: { Path: "C:\\tools;C:\\Program Files\\nodejs", ComSpec: "C:\\Windows\\system32\\cmd.exe" },
			exists: (path: string) => files.has(path),
		};
		expect(resolveWindowsCommand("npx", host)).toBe("C:\\Program Files\\nodejs\\npx.cmd");
		expect(planSpawn("npx", ["-y", "@scope/server", "--root", "C:\\My Files\\", 'say "hi" & exit'], host)).toEqual({
			command: "C:\\Windows\\system32\\cmd.exe",
			args: [
				"/d",
				"/s",
				"/c",
				'"C:\\Program^ Files\\nodejs\\npx.cmd ^"-y^" ^"@scope/server^" ^"--root^" ^"C:\\My^ Files\\\\^" ^"say^ \\^"hi\\^"^ ^&^ exit^""',
			],
			verbatim: true,
		});
		// A real executable needs no shell.
		expect(planSpawn("uvx", ["server"], host)).toEqual({
			command: "C:\\tools\\uvx.exe",
			args: ["server"],
			verbatim: false,
		});
		expect(planSpawn("node", ["x.js"], host).command).toBe("C:\\Program Files\\nodejs\\node.exe");
		// Nothing found on the PATH: a known shim name still goes through cmd, anything else is left to Windows.
		const blind = { platform: "win32" as const, env: {}, exists: () => false };
		expect(planSpawn("npx", ["x"], blind)).toMatchObject({ command: "cmd.exe", verbatim: true });
		expect(planSpawn("my-server", ["x"], blind)).toEqual({ command: "my-server", args: ["x"], verbatim: false });
	});

	it("hands a server a small part of mu's environment, plus its own", () => {
		const env = serverEnvironment(
			{
				PATH: "/bin",
				Path: "C:\\bin",
				HOME: "/home/u",
				https_proxy: "http://proxy:1",
				OPENAI_API_KEY: "sk-x",
				MU_JUDGE: "jev",
			},
			{ GITHUB_TOKEN: "own", PATH: "/custom" },
		);
		expect(env).toEqual({
			PATH: "/custom",
			Path: "C:\\bin",
			HOME: "/home/u",
			https_proxy: "http://proxy:1",
			GITHUB_TOKEN: "own",
		});
	});

	it("takes known secrets out of text before it is shown", () => {
		expect(redact("token sk-abcdef123 failed, mode=1", ["sk-abcdef123", "1"])).toBe(
			"token [redacted] failed, mode=1",
		);
	});
});
