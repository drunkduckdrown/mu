#!/usr/bin/env node
/**
 * A small MCP server for tests, speaking newline-delimited JSON-RPC on stdio.
 *
 *   --era legacy|modern|dual   which protocol era it belongs to (default: legacy)
 *   --starts-file <path>       appends a line on every start, so tests can count restarts
 *   --banner                   prints a line that is not JSON on stdout first, as sloppy servers do
 *   --crash-on-start           writes to stderr and exits before answering anything
 *   --crash-on-restart         with --starts-file: starts once, then crashes on every later start
 *   --hang-on-start <n>        with --starts-file: its n-th start never answers anything, as a stuck start does
 *   --leak-env <NAME>          writes the value of that variable to stderr on start and when it crashes
 *   --silent-before-init       ignores anything but `initialize` until initialized, instead of answering with an error
 *   --version <v>              the legacy protocol version it answers `initialize` with
 *
 * Tools: echo, fail, picture, hang, crash, grow (adds the tool `late` and announces the change), plus `pad_N` fillers
 * so that `tools/list` needs several pages.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

const era = option("--era", "legacy");
const startsFile = option("--starts-file");
const leak = option("--leak-env");
const legacyVersion = option("--version", "2025-06-18");
const MODERN = "2026-07-28";
const PAGE = 3;

const startedBefore = startsFile && existsSync(startsFile) && readFileSync(startsFile, "utf8").trim() !== "";
if (startsFile) appendFileSync(startsFile, `${process.pid}\n`);
const hanging =
	startsFile !== undefined &&
	option("--hang-on-start") !== undefined &&
	readFileSync(startsFile, "utf8").trim().split("\n").length === Number(option("--hang-on-start"));
if (leak) process.stderr.write(`starting with token ${process.env[leak]}\n`);
if (flag("--crash-on-start") || (flag("--crash-on-restart") && startedBefore)) {
	process.stderr.write("fatal: cannot open database /nowhere/db.sqlite\n");
	process.exit(2);
}
if (flag("--banner")) process.stdout.write("Fake MCP server v1 ready\n");

const tool = (name, description, properties = {}, required = []) => ({
	name,
	description,
	inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties, required },
});
const tools = [
	tool("echo", "Echo a message back", { message: { type: "string", description: "What to say" } }, ["message"]),
	tool("fail", "Always reports an error"),
	tool("picture", "Returns a tiny image"),
	tool("hang", "Never answers"),
	tool("crash", "Takes the server down"),
	tool("grow", "Adds another tool and says so"),
	tool("pad.one", "Filler with a dot in its name"),
	tool("pad one", "Filler with a space in its name"),
];

let initialized = false;
let subscription;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result: era === "legacy" ? result : { resultType: "complete", ...result } });
const refuse = (id, code, message, data) => send({ jsonrpc: "2.0", id, error: { code, message, data } });

function call(id, params) {
	const name = params?.name;
	const input = params?.arguments ?? {};
	if (name === "echo") return reply(id, { content: [{ type: "text", text: `echo: ${input.message}` }] });
	if (name === "fail") return reply(id, { content: [{ type: "text", text: "the upstream API said no" }], isError: true });
	if (name === "picture") {
		return reply(id, {
			content: [
				{ type: "text", text: "one pixel" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			],
		});
	}
	if (name === "hang") return undefined;
	if (name === "crash") {
		process.stderr.write(`panic: out of cheese${leak ? ` (token ${process.env[leak]})` : ""}\n`);
		process.exit(3);
	}
	if (name === "grow") {
		if (!tools.some((entry) => entry.name === "late")) tools.push(tool("late", "A tool that appeared later"));
		reply(id, { content: [{ type: "text", text: "grown" }] });
		const meta = subscription === undefined ? undefined : { _meta: { "io.modelcontextprotocol/subscriptionId": subscription } };
		if (era === "legacy" || subscription !== undefined) {
			send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", ...(meta ? { params: meta } : {}) });
		}
		return undefined;
	}
	if (name === "late" && tools.some((entry) => entry.name === "late")) {
		return reply(id, { content: [{ type: "text", text: "late but here" }] });
	}
	return refuse(id, -32602, `Unknown tool: ${name}`);
}

function handle(message) {
	if (hanging) return undefined;
	const { id, method, params } = message;
	if (id === undefined) {
		if (method === "notifications/initialized") initialized = true;
		return;
	}
	const modernRequest = params?._meta?.["io.modelcontextprotocol/protocolVersion"] !== undefined;

	if (method === "initialize") {
		if (era === "modern") return refuse(id, -32601, `Method not found. This server speaks ${MODERN} only.`);
		return reply(id, {
			protocolVersion: legacyVersion,
			capabilities: { tools: { listChanged: true } },
			serverInfo: { name: "fake", version: "1.0.0" },
		});
	}
	if (modernRequest) {
		if (era === "legacy" && !initialized && flag("--silent-before-init")) return undefined;
		if (era === "legacy") return refuse(id, -32601, "Method not found");
		const version = params._meta["io.modelcontextprotocol/protocolVersion"];
		if (version !== MODERN) {
			return refuse(id, -32022, "Unsupported protocol version", { supported: [MODERN], requested: version });
		}
		if (method === "server/discover") {
			return send({
				jsonrpc: "2.0",
				id,
				result: {
					resultType: "complete",
					supportedVersions: [MODERN],
					capabilities: { tools: { listChanged: true } },
					_meta: { "io.modelcontextprotocol/serverInfo": { name: "fake-modern", version: "2.0.0" } },
				},
			});
		}
		if (method === "subscriptions/listen") {
			subscription = id;
			return send({
				jsonrpc: "2.0",
				method: "notifications/subscriptions/acknowledged",
				params: { _meta: { "io.modelcontextprotocol/subscriptionId": id }, notifications: { toolsListChanged: true } },
			});
		}
	} else {
		if (era === "modern") return refuse(id, -32602, "Invalid params: _meta is required");
		if (!initialized) {
			if (flag("--silent-before-init")) return undefined;
			return refuse(id, -32600, "Received request before initialization was complete");
		}
	}

	if (method === "tools/list") {
		const start = params?.cursor ? Number(params.cursor) : 0;
		const next = start + PAGE < tools.length ? String(start + PAGE) : undefined;
		return reply(id, { tools: tools.slice(start, start + PAGE), ...(next ? { nextCursor: next } : {}) });
	}
	if (method === "tools/call") return call(id, params);
	return refuse(id, -32601, `Method not found: ${method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const end = buffer.indexOf("\n");
		if (end === -1) break;
		const line = buffer.slice(0, end).trim();
		buffer = buffer.slice(end + 1);
		if (!line) continue;
		try {
			handle(JSON.parse(line));
		} catch (error) {
			process.stderr.write(`bad message: ${error.message}\n`);
		}
	}
});
// The client closing its end is the signal to leave.
process.stdin.on("end", () => process.exit(0));
