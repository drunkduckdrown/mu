import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Capability } from "../../catalog/catalog.ts";
import { capabilityDisclosure } from "../../decisions/capability-disclosure.ts";
import type { InheritanceScan } from "../../inherit/scan.ts";
import type { McpServerDefinition } from "../../inherit/types.ts";
import { codedError, codeOf } from "../../language.ts";
import { allocateServerIds, allocateToolNames, capabilityId } from "../../mcp/names.ts";
import type { McpTool, McpTransport } from "../../mcp/protocol.ts";
import { toToolContent } from "../../mcp/result.ts";
import { McpServer } from "../../mcp/server.ts";
import { type CachedTool, McpStore } from "../../mcp/store.ts";
import { clip, failOpen, type KyrnRuntime } from "../runtime.ts";
import { type HarnessRoots, inheritedFor } from "./inherit.ts";

export interface McpFeatureOptions {
	/** Replaces the real transports, for tests. */
	readonly createTransport?: (definition: McpServerDefinition) => McpTransport;
}

interface Entry {
	readonly server: McpServer;
	/** Registered tool name -> the name the server knows the tool by. Only what is in here can be called. */
	live: Map<string, string>;
	/** Set when the server came from a project file and nobody has agreed to run it yet. */
	needsApproval: boolean;
}

/** What the judge and `find_capability` read, so the tool names come first: only some 200 characters are looked at. */
function describe(definition: McpServerDefinition, tools: readonly CachedTool[]): string {
	if (definition.description) return definition.description;
	if (tools.length === 0) {
		return `The "${definition.name}" MCP server. It has not run on this machine yet, so its tools are not known; open it to find out.`;
	}
	const names = tools.map((tool) => tool.name);
	const first = tools.find((tool) => tool.description);
	return clip(
		`Tools of the "${definition.name}" MCP server: ${names.slice(0, 12).join(", ")}${names.length > 12 ? ` and ${names.length - 12} more` : ""}.${first ? ` ${first.name}: ${first.description}` : ""}`,
		400,
	);
}

/** Everything a server is started with, for the one question that must show it. Values of variables and headers stay out. */
function approvalText(definition: McpServerDefinition): string {
	const transport = definition.transport;
	const what =
		transport.type === "stdio"
			? `command: ${[transport.command, ...transport.args].join(" ")}${Object.keys(transport.env).length > 0 ? `\nsets: ${Object.keys(transport.env).join(", ")}` : ""}`
			: `connects to: ${transport.url}${Object.keys(transport.headers).length > 0 ? `\nsends headers: ${Object.keys(transport.headers).join(", ")}` : ""}`;
	return `This project defines the MCP server "${definition.name}" in ${definition.source}.\n\n${what}\n\nStarting it runs that on your machine. Allow it only if you trust this repository. mu asks again when the definition changes.`;
}

/**
 * MCP, which pi leaves out on purpose. Every configured server is a `judged`
 * capability in the catalog: until the judge finds a task needs it, or the
 * model asks through `find_capability`, it costs no tool definitions and no
 * process. Opening it starts the server and registers its tools as
 * `mcp_<server>_<tool>`.
 *
 * With `capability.disclosure` off nothing is hidden, so every server is
 * started with the first message, as an ordinary MCP client would. A server
 * with `"exposure": "always"` in mu.json is started with the session either way.
 */
export function registerMcp(
	runtime: KyrnRuntime,
	roots: HarnessRoots | undefined,
	feature: McpFeatureOptions = {},
): void {
	const options = runtime.options("mcp", {
		enabled: true,
		/** The first answer of a server; an `npx` server downloads itself first. */
		startTimeoutMs: 45000,
		requestTimeoutMs: 120000,
		/** How long a turn waits for servers that are to be open from the start. */
		waitMs: 8000,
		/** A result longer than this is cut, with the whole of it saved to a file. */
		maxResultChars: 60000,
	});
	if (!options.enabled) return;
	const { pi, catalog } = runtime;
	const entries = new Map<string, Entry>();
	const store = new McpStore(roots ? join(roots.agentDir, "mu") : undefined);
	let scan: Pick<InheritanceScan, "servers" | "skipped"> | undefined;
	let eager: Promise<unknown> | undefined;

	const capabilityOf = (entry: Entry, tools: readonly CachedTool[], toolNames: readonly string[]): Capability => ({
		id: capabilityId(entry.server.id),
		kind: "mcp",
		title: `${entry.server.definition.name} (MCP)`,
		description: describe(entry.server.definition, tools),
		tools: toolNames,
		exposure: entry.server.definition.exposure,
		activate: () => activate(entry),
	});

	const registerTools = (entry: Entry, tools: readonly McpTool[]): void => {
		const { server } = entry;
		const names = allocateToolNames(
			server.id,
			tools.map((tool) => tool.name),
		);
		const before = new Set(entry.live.keys());
		entry.live = new Map([...names].map(([original, registered]) => [registered, original]));
		for (const tool of tools) {
			const registered = names.get(tool.name);
			if (!registered) continue;
			// `$schema` and `$id` say nothing about the arguments, and some providers reject them.
			const { $schema: _dialect, $id: _identity, ...schema } = tool.inputSchema;
			pi.registerTool({
				name: registered,
				label: `${server.definition.name}: ${tool.title ?? tool.name}`,
				description: clip(
					tool.description ?? `The ${tool.name} tool of the ${server.definition.name} MCP server.`,
					2000,
				),
				// The server's own JSON Schema, as it is: pi validates plain JSON Schema as well as TypeBox.
				parameters: Type.Unsafe<Record<string, unknown>>({ type: "object", ...schema }),
				execute: async (toolCallId, params, signal) => {
					const original = entry.live.get(registered);
					if (!original) {
						throw new Error(`The ${server.definition.name} MCP server does not offer this tool any more.`);
					}
					const result = await server.call(original, params ?? {}, signal);
					const content = toToolContent(result, server.definition.name);
					const text = content[0];
					if (text.type === "text" && text.text.length > options.maxResultChars) {
						const dir = join(tmpdir(), `kyrn-${runtime.sessionId}`);
						const path = join(dir, `${toolCallId.replace(/[^\w.-]/g, "_")}.mcp.txt`);
						mkdirSync(dir, { recursive: true });
						writeFileSync(path, text.text);
						const cut = text.text.length - options.maxResultChars;
						text.text = `${text.text.slice(0, options.maxResultChars)}\n[mu: ${cut} more characters cut; the whole result: ${path}]`;
					}
					// An MCP error result is an error to the model as well, and pi marks a throw as one.
					if (result.isError) throw new Error(text.type === "text" ? text.text : "The tool reported an error.");
					return { content, details: { server: server.definition.name, tool: original } };
				},
			});
		}
		// pi has no way to take a tool back. One that a server dropped leaves the tool list and refuses calls.
		const gone = [...before].filter((name) => !entry.live.has(name));
		if (gone.length > 0) pi.setActiveTools(pi.getActiveTools().filter((name) => !gone.includes(name)));
		catalog.register(
			capabilityOf(
				entry,
				tools.map((tool) => ({ name: tool.name, description: tool.description ?? "" })),
				[...entry.live.keys()],
			),
		);
	};

	const approve = async (entry: Entry): Promise<void> => {
		if (!entry.needsApproval) return;
		const ctx = runtime.ctx;
		const definition = entry.server.definition;
		if (!ctx?.isProjectTrusted())
			throw codedError("the project is not trusted, and this server is defined by the project", {
				code: "project_untrusted",
			});
		if (!store.isApproved(ctx.cwd, definition)) {
			if (!ctx.hasUI) {
				throw codedError(
					`it is defined by the project (${definition.source}) and has not been approved. Start mu in this folder interactively and open it once, or define it in mu.json`,
					{ code: "needs_approval", params: { source: definition.source } },
				);
			}
			const allowed = await ctx.ui.confirm("mu MCP", approvalText(definition));
			if (!allowed) throw codedError("you did not allow this project's server to start", { code: "denied" });
			store.approve(ctx.cwd, definition);
		}
		entry.needsApproval = false;
	};

	/** Starts a server, or starts it again (`restart`), and tells the app how that went either way. */
	async function activate(entry: Entry, restart = false): Promise<void> {
		const { server } = entry;
		try {
			await approve(entry);
			registerTools(entry, await (restart ? server.restart() : server.start()));
			runtime.present("mcp.started", {
				id: capabilityId(server.id),
				name: server.definition.name,
				tools: [...entry.live.keys()],
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const coded = codeOf(error);
			runtime.present("mcp.failed", {
				id: capabilityId(server.id),
				name: server.definition.name,
				reason,
				code: coded?.code ?? "start_failed",
				...(coded?.params ? { params: coded.params } : {}),
			});
			throw new Error(reason);
		}
	}

	const ensureLoaded = (ctx: ExtensionContext): void => {
		if (scan) return;
		scan = inheritedFor(runtime, roots, ctx, runtime.config.mcp);
		const ids = allocateServerIds(scan.servers.map((server) => server.name));
		for (const definition of scan.servers) {
			const server = new McpServer(definition, ids.get(definition.name) ?? definition.name, {
				env: process.env,
				projectDir: ctx.cwd,
				home: roots?.home ?? "",
				clientVersion: "0.1.0",
				startTimeoutMs: options.startTimeoutMs,
				requestTimeoutMs: options.requestTimeoutMs,
				store,
				createTransport: feature.createTransport,
			});
			const entry: Entry = { server, live: new Map(), needsApproval: definition.scope === "project" };
			server.onToolsChanged = (tools) => {
				registerTools(entry, tools);
				runtime.present("mcp.tools_changed", { id: capabilityId(server.id), tools: [...entry.live.keys()] });
			};
			server.onCrash = (reason, willRestart, coded) =>
				runtime.present("mcp.failed", {
					id: capabilityId(server.id),
					name: definition.name,
					reason,
					willRestart,
					...(coded ? { code: coded.code, ...(coded.params ? { params: coded.params } : {}) } : {}),
				});
			entries.set(server.id, entry);
			const cached = store.cached(definition)?.tools ?? [];
			const names = allocateToolNames(
				server.id,
				cached.map((tool) => tool.name),
			);
			catalog.register(capabilityOf(entry, cached, [...names.values()]));
		}
	};

	/** Servers that are to be open without anybody asking: pinned ones, and all of them when nothing is hidden. */
	const startEager = (): Promise<unknown> => {
		const everything = runtime.mode(capabilityDisclosure.id) === "off";
		const wanted = [...entries.values()].filter(
			(entry) =>
				(everything || entry.server.definition.exposure === "always") &&
				entry.server.state === "idle" &&
				// A question about a project's server is asked when somebody wants that server, not at every start.
				!(entry.needsApproval && !store.isApproved(runtime.ctx?.cwd ?? "", entry.server.definition)),
		);
		return Promise.allSettled(wanted.map((entry) => activate(entry)));
	};

	pi.on(
		"session_start",
		failOpen((_event, ctx) => {
			runtime.touch(ctx);
			ensureLoaded(ctx);
			eager = startEager();
			return undefined;
		}),
	);

	pi.on(
		"before_agent_start",
		failOpen((_event, ctx) => {
			runtime.touch(ctx);
			ensureLoaded(ctx);
			eager ??= startEager();
			// Tools that are meant to be there should be there for the first answer, but no server gets to hold a turn up.
			const patience = new Promise<void>((done) => setTimeout(done, options.waitMs));
			return Promise.race([eager, patience]).then(() => undefined);
		}),
	);

	pi.on(
		"session_shutdown",
		failOpen(() =>
			Promise.allSettled([...entries.values()].map((entry) => entry.server.stop())).then(() => undefined),
		),
	);

	pi.registerCommand("mcp", {
		description: "MCP servers: /mcp, /mcp open <id>, /mcp restart <id>",
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			ensureLoaded(ctx);
			const [verb, id] = args.trim().split(/\s+/);
			const entry = id ? entries.get(id.replace(/^mcp:/, "")) : undefined;
			if ((verb === "open" || verb === "restart") && entry) {
				try {
					if (verb === "restart" && entry.server.state !== "idle") {
						await activate(entry, true);
					} else if (
						entry.server.definition.exposure === "always" ||
						catalog.isOpen(capabilityId(entry.server.id))
					) {
						await activate(entry);
					} else {
						await catalog.open(capabilityId(entry.server.id), "user", runtime.userTurns);
					}
					ctx.ui.notify(`${entry.server.definition.name} is running with ${entry.live.size} tools.`, "info");
				} catch (error) {
					ctx.ui.notify(
						`${entry.server.definition.name} did not start: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				}
				return;
			}
			const rows = [...entries.values()].map((row) => {
				const { server } = row;
				const open = server.definition.exposure === "always" || catalog.isOpen(capabilityId(server.id));
				const state =
					server.state === "failed"
						? `failed: ${server.lastError ?? "unknown"}`
						: server.state === "running"
							? `open, ${row.live.size} tools`
							: server.state === "starting"
								? "starting"
								: open
									? "open, not running"
									: `hidden${row.needsApproval && !store.isApproved(ctx.cwd, server.definition) ? ", asks before its first start" : ""}`;
				const known = store.cached(server.definition)?.tools.length;
				return `${capabilityId(server.id).padEnd(22)} ${state}${server.state === "idle" && known ? ` (${known} tools last time)` : ""}\n    from ${server.definition.source}`;
			});
			const skipped = (scan?.skipped ?? []).map(
				(entry) => `${entry.name.padEnd(22)} not used: ${entry.reason}\n    from ${entry.source}`,
			);
			const all = [...rows, ...skipped];
			ctx.ui.notify(
				all.length > 0
					? all.join("\n")
					: 'No MCP servers are configured. Add one under "mcp": { "servers": { … } } in mu.json, or set one up in Claude Code, Cursor or Codex.',
				"info",
			);
		},
	});
}
