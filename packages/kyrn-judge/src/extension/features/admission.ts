import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTestLog, planTestLog, renderTestLog, type TestLogStrategy } from "../../admission/test-log.ts";
import { toolAdmission } from "../../decisions/tool-admission.ts";
import { clip, failOpen, type KyrnRuntime, textOf } from "../runtime.ts";

/** Splits on line boundaries into pieces of at most `size` characters; an over-long line becomes its own piece. */
export function chunkLines(text: string, size: number): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const line of text.split("\n")) {
		if (current && current.length + line.length + 1 > size) {
			chunks.push(current);
			current = "";
		}
		current = current ? `${current}\n${line}` : line;
		while (current.length > size) {
			chunks.push(current.slice(0, size));
			current = current.slice(size);
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

/** A compact description of a tool call for the judge: the command, pattern or path that produced the output. */
export function describeCall(toolName: string, input: Record<string, unknown>): string {
	const value = input.command ?? input.pattern ?? input.path ?? input.query;
	return clip(`${toolName}: ${typeof value === "string" ? value : JSON.stringify(input)}`, 300);
}

/**
 * B1: long tool output is classified chunk by chunk before it enters the
 * context, and confident noise (progress, repeated warnings, passing checks)
 * is archived instead. Rules come first: errors, short output, images and
 * source reads always pass, and the first and last chunk always stay because
 * that is where commands put their summary and exit status.
 *
 * `testLog` (off by default) gives test-runner output its own path, see
 * admission/test-log.ts. It also takes failing runs, which the chunk path skips:
 * in real sessions every long test log was a failing one, and half of its text
 * repeated an earlier part of itself.
 */
export function registerAdmission(runtime: KyrnRuntime): void {
	const options = runtime.options("admission", {
		enabled: true,
		minChars: 4000,
		chunkChars: 1200,
		maxChunks: 48,
		passThrough: ["read", "edit", "write"],
		/** "rules" omits exact repeats in test-runner output; "jev" also asks the judge about what is left. */
		testLog: "off" as TestLogStrategy | "off",
		/** Tell test runners an agent is reading: Vitest then prints failures and the summary only. */
		agentEnv: true,
	});
	if (!options.enabled) return;
	const { pi } = runtime;
	// An explicit reporter flag still wins, so the agent can list every passing test when it needs them.
	if (options.agentEnv) process.env.AI_AGENT ??= "1";

	pi.on(
		"message_end",
		failOpen((event, ctx) => {
			runtime.touch(ctx);
			const message = event.message as { role?: unknown; content?: unknown };
			if (message.role !== "assistant") return undefined;
			const text = textOf(message.content);
			if (text.trim()) runtime.lastAssistantText = text;
			return undefined;
		}),
	);

	pi.on(
		"tool_result",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			const toolName = "toolName" in event ? String(event.toolName) : "";
			if (options.passThrough.includes(toolName)) return undefined;
			if (event.content.some((block) => block.type !== "text")) return undefined;
			const text = textOf(event.content);
			if (text.length < options.minChars) return undefined;
			const call = describeCall(toolName, event.input);
			const archiveDir = join(tmpdir(), `kyrn-${runtime.sessionId}`);
			const archivePath = join(archiveDir, `${event.toolCallId.replace(/[^\w.-]/g, "_")}.txt`);

			if (options.testLog !== "off" && isTestLog(call, text)) {
				const frame = runtime.taskFrame();
				const goal = [frame?.goal, frame?.currentSubgoal].filter(Boolean).join("\n");
				const intent = clip(runtime.lastAssistantText, 400);
				const plan = await planTestLog({ call, goal, intent, output: text }, options.testLog, runtime.engine, {
					signal: ctx.signal,
				});
				const rendered = renderTestLog(plan, archivePath);
				if (!rendered.applied) return undefined;
				// The markers count lines of this text, so this text is what gets archived, not pi's own full-output file.
				mkdirSync(archiveDir, { recursive: true });
				writeFileSync(archivePath, text);
				runtime.savings.admissionOmittedChars += rendered.omittedChars;
				return { content: [{ type: "text" as const, text: rendered.text }] };
			}

			const mode = runtime.mode(toolAdmission.id);
			if (mode === "off" || event.isError) return undefined;
			const chunks = chunkLines(text, options.chunkChars);
			if (chunks.length < 3 || chunks.length > options.maxChunks) return undefined;
			const middle = chunks.slice(1, -1);
			const decisions = await runtime.engine.decideMany(
				toolAdmission,
				middle.map((chunk) => ({ call, chunk })),
				{ signal: ctx.signal },
			);
			if (mode !== "active") return undefined;

			const dropped = decisions.map((decision) => decision.source === "judge" && decision.outcome.drop);
			if (!dropped.some(Boolean)) return undefined;

			mkdirSync(archiveDir, { recursive: true });
			writeFileSync(archivePath, text);

			const kept: string[] = [chunks[0]];
			let omittedChars = 0;
			let run: string[] = [];
			const kinds = new Set<string>();
			const flush = () => {
				if (run.length === 0) return;
				const chars = run.reduce((sum, chunk) => sum + chunk.length, 0);
				const lines = run.reduce((sum, chunk) => sum + chunk.split("\n").length, 0);
				omittedChars += chars;
				kept.push(
					`[mu: ${lines} lines (${chars} chars) of ${[...kinds].join("/")} output omitted; full output: ${archivePath}]`,
				);
				kinds.clear();
				run = [];
			};
			middle.forEach((chunk, index) => {
				if (dropped[index]) {
					run.push(chunk);
					kinds.add(decisions[index].outcome.kind);
				} else {
					flush();
					kept.push(chunk);
				}
			});
			flush();
			kept.push(chunks[chunks.length - 1]);

			runtime.savings.admissionOmittedChars += omittedChars;
			return { content: [{ type: "text" as const, text: kept.join("\n") }] };
		}),
	);
}
