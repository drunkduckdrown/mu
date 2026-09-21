import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { contextForget } from "../../decisions/context-forget.ts";
import { failOpen, type KyrnRuntime, textOf } from "../runtime.ts";
import { describeCall } from "./admission.ts";

interface ToolResultLike {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: { type: string; text?: string }[];
	isError: boolean;
}

interface Candidate {
	toolCallId: string;
	call: string;
	chars: number;
	ageTurns: number;
}

const KEEP_EDGE_CHARS = 600;
const STATE_ENTRY_TYPE = "kyrn.forgetting.state";

interface ForgettingState {
	version: 1;
	replaced: [string, string][];
	judged: string[];
	crossed: number[];
}

function isForgettingState(value: unknown): value is ForgettingState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<ForgettingState>;
	return (
		state.version === 1 &&
		Array.isArray(state.replaced) &&
		state.replaced.every(
			(pair) => Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === "string"),
		) &&
		Array.isArray(state.judged) &&
		state.judged.every((id) => typeof id === "string") &&
		Array.isArray(state.crossed) &&
		state.crossed.every((threshold) => typeof threshold === "number" && Number.isFinite(threshold))
	);
}

function shrink(text: string, call: string): string {
	const omitted = text.length - 2 * KEEP_EDGE_CHARS;
	return `${text.slice(0, KEEP_EDGE_CHARS)}\n[mu: ${omitted} chars of old output from "${call}" omitted; run it again if you need them]\n${text.slice(-KEEP_EDGE_CHARS)}`;
}

/**
 * B2: old tool results are shrunk in the outgoing request, never in the
 * session file, so nothing is lost and `/tree` still shows everything.
 *
 * Rewriting earlier context breaks the cached prefix from that point. So the
 * set of shrunk results only grows at cache boundaries (when context use
 * crosses a threshold) and is applied identically on every request between
 * them. Rules first: a full re-read of a file supersedes the older read.
 */
export function registerForgetting(runtime: KyrnRuntime): void {
	const options = runtime.options("forgetting", {
		enabled: true,
		thresholds: [50, 70, 85],
		minChars: 6000,
		minAgeTurns: 2,
		maxPerBatch: 12,
	});
	if (!options.enabled) return;
	let replaced = new Map<string, string>();
	let judged = new Set<string>();
	const counted = new Set<string>();
	let crossed = new Set<number>();
	let generation = 0;

	const restore = (ctx: ExtensionContext) => {
		generation++;
		let state: ForgettingState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			// A successful compaction starts a new prefix epoch. Failure/cancellation does not.
			if (entry.type === "compaction") state = undefined;
			if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE && isForgettingState(entry.data))
				state = entry.data;
		}
		replaced = new Map(state?.replaced);
		judged = new Set(state?.judged);
		crossed = new Set(state?.crossed);
	};
	// Custom entries follow the active branch, survive reload/resume, and never enter the model context.
	runtime.pi.on("session_start", (_event, ctx) => {
		counted.clear();
		restore(ctx);
	});
	runtime.pi.on("session_tree", (_event, ctx) => restore(ctx));
	runtime.pi.on("session_compact", (_event, ctx) => restore(ctx));
	runtime.pi.on("session_shutdown", () => {
		generation++;
	});

	runtime.pi.on(
		"context",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			const mode = runtime.mode(contextForget.id);
			if (mode === "off") return undefined;
			const messages = event.messages as unknown as { role: string; content?: unknown }[];

			const usage = ctx.getContextUsage();
			const levels = options.thresholds.filter(
				(threshold) => (usage?.percent ?? 0) >= threshold && !crossed.has(threshold),
			);
			if (levels.length > 0) {
				const epoch = generation;
				const nextReplaced = new Map(replaced);
				const nextJudged = new Set(judged);

				const calls = new Map<string, string>();
				const userTurnAt: number[] = [];
				messages.forEach((message, index) => {
					if (message.role === "user") userTurnAt.push(index);
					if (message.role !== "assistant" || !Array.isArray(message.content)) return;
					for (const block of message.content as {
						type?: string;
						id?: string;
						name?: string;
						arguments?: unknown;
					}[]) {
						if (block.type === "toolCall" && block.id && block.name) {
							calls.set(block.id, describeCall(block.name, (block.arguments ?? {}) as Record<string, unknown>));
						}
					}
				});

				// Rule: a later full read of the same file supersedes the earlier one.
				const latestRead = new Map<string, string>();
				const candidates: Candidate[] = [];
				messages.forEach((message, index) => {
					if (message.role !== "toolResult") return;
					const result = message as unknown as ToolResultLike;
					const call = calls.get(result.toolCallId) ?? result.toolName;
					if (result.toolName === "read" && !result.isError) {
						const previous = latestRead.get(call);
						if (previous && !nextReplaced.has(previous))
							nextReplaced.set(previous, `[mu: superseded by a later ${call}]`);
						latestRead.set(call, result.toolCallId);
						return;
					}
					const chars = textOf(result.content).length;
					const ageTurns = userTurnAt.filter((at) => at > index).length;
					if (result.isError || chars < options.minChars || ageTurns < options.minAgeTurns) return;
					if (judged.has(result.toolCallId)) return;
					candidates.push({ toolCallId: result.toolCallId, call, chars, ageTurns });
				});

				const batch = candidates.sort((a, b) => b.chars - a.chars).slice(0, options.maxPerBatch);
				for (const candidate of batch) nextJudged.add(candidate.toolCallId);
				const goal = runtime.taskFrame()?.goal ?? "";
				const since = messages
					.filter((message) => message.role === "assistant")
					.slice(-4)
					.map((message) => textOf(message.content).replace(/\s+/g, " ").slice(0, 160))
					.filter(Boolean);
				const decisions = await runtime.engine.decideMany(
					contextForget,
					batch.map((candidate) => ({
						goal,
						call: candidate.call,
						resultChars: candidate.chars,
						ageTurns: candidate.ageTurns,
						since,
					})),
					{ signal: ctx.signal },
				);
				if (epoch !== generation || ctx.signal?.aborted) return undefined;
				decisions.forEach((decision, index) => {
					if (decision.source === "judge" && decision.outcome === "shrink")
						nextReplaced.set(batch[index].toolCallId, "shrink");
				});
				// An empty crossing stays armed. Spend all levels already crossed in this one batch,
				// rather than invalidating the prefix again on each following request at the same usage.
				if (batch.length > 0 || nextReplaced.size > replaced.size) {
					const nextCrossed = new Set([...crossed, ...levels]);
					const state: ForgettingState = {
						version: 1,
						replaced: [...nextReplaced],
						judged: [...nextJudged],
						crossed: [...nextCrossed],
					};
					// Persist before applying: a failed write must not silently produce an un-restorable prefix.
					runtime.pi.appendEntry(STATE_ENTRY_TYPE, state);
					replaced = nextReplaced;
					judged = nextJudged;
					crossed = nextCrossed;
				}
			}

			if (mode !== "active" || replaced.size === 0) return undefined;
			let changed = false;
			const next = messages.map((message) => {
				if (message.role !== "toolResult") return message;
				const result = message as unknown as ToolResultLike;
				const replacement = replaced.get(result.toolCallId);
				if (!replacement) return message;
				const text = textOf(result.content);
				const body = replacement === "shrink" ? shrink(text, result.toolName) : replacement;
				if (body.length >= text.length) return message;
				changed = true;
				// This runs on every request; count each result once.
				if (!counted.has(result.toolCallId)) {
					counted.add(result.toolCallId);
					runtime.savings.forgottenChars += text.length - body.length;
				}
				return { ...message, content: [{ type: "text", text: body }] };
			});
			return changed ? { messages: next as unknown as typeof event.messages } : undefined;
		}),
	);
}
