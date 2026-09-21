import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { featureOptions, type KyrnConfig } from "../config.ts";
import { DecisionEngine, type DecisionMode } from "../decision.ts";
import type { PreflightOutcome, TaskFrame } from "../decisions/input-preflight.ts";
import { JudgeError } from "../errors.ts";
import type { JudgeLike } from "../judge.ts";
import { CompositeLedger, type LedgerRecord, type LedgerSink, MemoryLedger } from "../ledger.ts";
import type { LlmCompletion } from "../providers/llm.ts";
import { buildJudge } from "../registry.ts";
import { type KyrnPresentationEvent, PRESENTATION_STATUS_KEY, type PresentationListener } from "./presentation.ts";

export const LEDGER_ENTRY_TYPE = "kyrn.decision";
const GATEWAY_PROVIDER_ID = "vercel-ai-gateway";
const STATUS_KEY = "kyrn";

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const record = block as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	return parts.join("\n");
}

export function clip(text: string, length: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= length ? flat : `${flat.slice(0, length - 1)}…`;
}

/** The user turn that asked for a decision, as this runtime stamped it on the record. */
function askedTurn(record: LedgerRecord): number | undefined {
	const origin = record.origin;
	if (typeof origin !== "object" || origin === null || !("turn" in origin)) return undefined;
	return typeof origin.turn === "number" ? origin.turn : undefined;
}

/** Short role-tagged digests of the latest user and assistant messages, oldest first. */
export function recentTurnDigests(ctx: Pick<ExtensionContext, "sessionManager">, limit = 4, length = 240): string[] {
	const digests: string[] = [];
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0 && digests.length < limit; index--) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: unknown; content?: unknown };
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = clip(textOf(message.content), length);
		if (text) digests.unshift(`${message.role}: ${text}`);
	}
	return digests;
}

/** What one user turn has established so far. Reset when the next user message arrives. */
export interface TurnState {
	userMessage: string;
	preflight?: PreflightOutcome;
	/** Files edited or written this turn, and whether a command ran after the last edit. */
	editedFiles: Set<string>;
	ranCommandAfterLastEdit: boolean;
	nudgedForCompletion: boolean;
}

export interface Savings {
	/** Characters of tool output kept out of the context by admission control. */
	admissionOmittedChars: number;
	/** Characters of skill descriptions kept out of the system prompt. */
	skillsHiddenChars: number;
	/** Characters of stale tool results replaced by tombstones in outgoing requests. */
	forgottenChars: number;
	/** Characters of tool output pruned by summary-free compaction. */
	compactedChars: number;
}

/**
 * Everything the features share: one engine, one config, the live context,
 * and what is known about the current turn. Features never talk to a judge
 * directly, so swapping the decision model is a one-line change here.
 */
export class KyrnRuntime {
	readonly pi: ExtensionAPI;
	readonly config: KyrnConfig;
	readonly engine: DecisionEngine;
	readonly memory = new MemoryLedger();
	readonly problems: string[] = [];
	readonly savings: Savings = { admissionOmittedChars: 0, skillsHiddenChars: 0, forgottenChars: 0, compactedChars: 0 };
	readonly sessionId = randomUUID();
	/** False when the judge is switched off (MU_JUDGE=off): the CLI stays, the judgment layer asks nothing. */
	enabled = true;
	turn: TurnState = emptyTurn("");
	userTurns = 0;
	/** Tool calls so far in this session. Zero means no work has started: a plain message is then plain chat. */
	toolCalls = 0;
	/** The assistant's latest prose, used as the stated intent of the tool calls that follow it. */
	lastAssistantText = "";
	private latestCtx: ExtensionContext | undefined;
	private firstUserMessage = "";
	private presentationSequence = 0;
	onPresentation?: PresentationListener;

	constructor(pi: ExtensionAPI, config: KyrnConfig, judge?: JudgeLike, problem?: string) {
		this.pi = pi;
		this.config = config;
		if (problem) this.problems.push(problem);
		const sessionLedger: LedgerSink = {
			append: (record: LedgerRecord) => {
				pi.appendEntry(LEDGER_ENTRY_TYPE, record);
				// Raw judge inputs are not part of the UI protocol, even when the diagnostic ledger records them.
				const { state: _state, ...visible } = record;
				// A judge that answers after the next message began still belongs to the turn that asked.
				this.present("decision", visible, askedTurn(record) ?? this.userTurns);
			},
		};
		this.engine = new DecisionEngine({
			judge: judge ?? this.buildConfiguredJudge(config.tiers),
			ledger: new CompositeLedger([this.memory, sessionLedger]),
			defaultMode: config.modes.default ?? "shadow",
			modes: Object.fromEntries(Object.entries(config.modes).filter(([specId]) => specId !== "default")),
			recordState: config.recordState,
			origin: () => ({ turn: this.userTurns }),
		});
		for (const [specId, tiers] of Object.entries(config.routes)) this.route(specId, tiers);
	}

	/** Answer one decision with its own tiers, e.g. `/mu route browser.step luna`. Empty tiers undo it. */
	route(specId: string, tiers: readonly string[]): readonly string[] {
		const before = this.problems.length;
		this.engine.setJudgeFor(specId, tiers.length > 0 ? this.buildConfiguredJudge(tiers) : undefined);
		return this.problems.slice(before);
	}

	private buildConfiguredJudge(tiers: readonly string[]): JudgeLike {
		const built = buildJudge(
			{ ...this.config, tiers },
			{
				env: process.env,
				gatewayApiKey: async () =>
					(await this.latestCtx?.modelRegistry.getApiKeyForProvider(GATEWAY_PROVIDER_ID)) ??
					process.env.AI_GATEWAY_API_KEY,
				llm: (model, options) => this.llm(model, options),
			},
		);
		this.problems.push(...built.problems);
		return built.judge;
	}

	/** Switch the decision model at runtime, e.g. `/mu judge laya,jev`. */
	useJudges(tiers: readonly string[]): readonly string[] {
		const before = this.problems.length;
		this.engine.setJudge(this.buildConfiguredJudge(tiers));
		return this.problems.slice(before);
	}

	/** A completion function over one of the host's models. Looked up per call, because models load after extensions. */
	llm(modelRef: string, options: { thinking?: string } = {}): LlmCompletion {
		return async ({ system, user, signal }) => {
			const ctx = this.latestCtx;
			if (!ctx) throw new JudgeError("unreachable", "No session is attached yet");
			const slash = modelRef.indexOf("/");
			const model =
				slash > 0 ? ctx.modelRegistry.find(modelRef.slice(0, slash), modelRef.slice(slash + 1)) : undefined;
			if (!model) throw new JudgeError("bad_request", `Model "${modelRef}" is not available`);
			const thinking = options.thinking && options.thinking !== "off" ? options.thinking : undefined;
			const message = await ctx.modelRegistry
				.streamSimple(
					model,
					{
						systemPrompt: system,
						messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }],
					},
					{
						signal,
						maxTokens: 2000,
						reasoning: thinking as never,
						cacheRetention: "none",
						sessionId: this.sessionId,
					},
				)
				.result();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new JudgeError("server", message.errorMessage?.slice(0, 200) ?? "The model call failed");
			}
			return { text: textOf(message.content), inputTokens: message.usage.input, outputTokens: message.usage.output };
		};
	}

	/** The configured writer model, or undefined when generative helpers are off. */
	writer(): LlmCompletion | undefined {
		return this.config.writer ? this.llm(this.config.writer, { thinking: "off" }) : undefined;
	}

	touch(ctx: ExtensionContext): void {
		this.latestCtx = ctx;
	}

	get ctx(): ExtensionContext | undefined {
		return this.latestCtx;
	}

	mode(specId: string): DecisionMode {
		return this.engine.getMode(specId);
	}

	options<T extends { enabled: boolean }>(feature: string, defaults: T): T {
		return featureOptions(this.config, feature, defaults);
	}

	beginTurn(userMessage: string): void {
		this.userTurns++;
		if (!this.firstUserMessage) this.firstUserMessage = userMessage;
		this.turn = emptyTurn(userMessage);
	}

	/**
	 * A stand-in until a writer model maintains a real one: the session's first
	 * request is the goal and the latest message is the current subgoal.
	 */
	taskFrame(): TaskFrame | undefined {
		if (!this.firstUserMessage) return undefined;
		const goal = clip(this.firstUserMessage, 300);
		const current = clip(this.turn.userMessage, 200);
		return { goal, currentSubgoal: current && current !== goal ? current : undefined };
	}

	status(text: string): void {
		const ctx = this.latestCtx;
		if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
	}

	/** Whoever shows the time between a message and its turn sets this; nobody has to. */
	onProgress?: (step: string) => void;

	/** Says what is being worked out before the turn starts ("choosing skills"). Showing it is best effort. */
	progress(step: string): void {
		this.present("progress", { step });
		try {
			this.onProgress?.(step);
		} catch {
			// A display problem is never a reason to skip the work being announced.
		}
	}

	/** A display failure must never affect execution. RPC transports this over its existing status channel. */
	present(kind: KyrnPresentationEvent["kind"], payload: unknown, turnId = this.userTurns): void {
		const event: KyrnPresentationEvent = {
			version: 1,
			sequence: ++this.presentationSequence,
			at: Date.now(),
			runtimeId: this.sessionId,
			turnId,
			kind,
			payload,
		};
		try {
			this.onPresentation?.(event);
		} catch {
			/* Observers do not own the run. */
		}
		try {
			if (this.latestCtx?.mode === "rpc")
				this.latestCtx.ui.setStatus(PRESENTATION_STATUS_KEY, JSON.stringify(event));
		} catch {
			/* A disconnected presentation does not stop the agent. */
		}
	}

	/** "cascade(local:laya>gateway:typesafe-ai/jev)" -> "laya>jev". */
	get judgeLabel(): string {
		if (!this.enabled) return "off";
		const id = this.engine.providerId.replace(/^cascade\((.*)\)$/, "$1");
		return id
			.split(">")
			.map((tier) => tier.split(/[:/]/).pop() || tier)
			.join(">");
	}
}

function emptyTurn(userMessage: string): TurnState {
	return {
		userMessage,
		editedFiles: new Set(),
		ranCommandAfterLastEdit: false,
		nudgedForCompletion: false,
	};
}

/** Wraps a handler so a bug in a feature can never block a tool or a prompt: pi treats a throw as a veto. */
export function failOpen<Event, Result>(
	handler: (event: Event, ctx: ExtensionContext) => Promise<Result | undefined> | Result | undefined,
): (event: Event, ctx: ExtensionContext) => Promise<Result | undefined> {
	return async (event, ctx) => {
		try {
			return await handler(event, ctx);
		} catch {
			return undefined;
		}
	};
}
