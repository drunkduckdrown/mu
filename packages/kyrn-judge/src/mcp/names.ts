import { createHash } from "node:crypto";

/**
 * Names the model sees. A provider accepts `[A-Za-z0-9_-]` and at most 64
 * characters in a tool name; server and tool names in the wild have dots,
 * spaces and slashes. A tool is `mcp_<server>_<tool>`, which also keeps two
 * servers that both offer `search` apart.
 */
const MAX_TOOL_NAME = 64;
const PREFIX = "mcp_";

export function sanitizeName(name: string): string {
	const clean = name
		.normalize("NFKD")
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^[_-]+|[_-]+$/g, "");
	return clean || "x";
}

function shortHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 6);
}

/** `taken` gets the returned name added. A second claim on a name gets a number: `figma`, `figma_2`. */
function claim(wanted: string, taken: Set<string>): string {
	let name = wanted;
	for (let count = 2; taken.has(name.toLowerCase()); count++) name = `${wanted}_${count}`;
	taken.add(name.toLowerCase());
	return name;
}

/**
 * One id per server, in the order given, stable for a given set of names.
 * Two names that sanitize to the same id ("my.server", "my server") both stay usable.
 */
export function allocateServerIds(names: readonly string[]): Map<string, string> {
	const ids = new Map<string, string>();
	const taken = new Set<string>();
	for (const name of names) {
		// Leaves room for the prefix, the separator and a recognizable piece of the tool's own name.
		ids.set(
			name,
			claim(
				sanitizeName(name)
					.slice(0, 24)
					.replace(/[_-]+$/, "") || "x",
				taken,
			),
		);
	}
	return ids;
}

/** The registered name of each of a server's tools, keyed by the name the server knows it by. */
export function allocateToolNames(serverId: string, tools: readonly string[]): Map<string, string> {
	const names = new Map<string, string>();
	const taken = new Set<string>();
	for (const tool of tools) {
		let name = `${PREFIX}${serverId}_${sanitizeName(tool)}`;
		if (name.length > MAX_TOOL_NAME) {
			// Cut, but keep it unique and the same from one session to the next.
			name = `${name.slice(0, MAX_TOOL_NAME - 7)}_${shortHash(tool)}`;
		}
		names.set(tool, claim(name, taken).slice(0, MAX_TOOL_NAME));
	}
	return names;
}

export function capabilityId(serverId: string): string {
	return `mcp:${serverId}`;
}
