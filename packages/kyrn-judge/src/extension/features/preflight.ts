import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { Decision } from "../../decision.ts";
import {
	type Gear,
	inputPreflight,
	type PreflightInput,
	type PreflightOutcome,
} from "../../decisions/input-preflight.ts";
import { failOpen, type KyrnRuntime, recentTurnDigests } from "../runtime.ts";
import {
	renderPending,
	renderVerdict,
	VERDICT_ENTRY,
	type VerdictData,
	type VerdictState,
	verdictData,
} from "./preflight-view.ts";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Level = (typeof LEVELS)[number];

/** The thinking level a gear asks for, never raising a chat turn or lowering a heavy one past the user's own setting. */
export function thinkingForGear(gear: Gear, baseline: Level): Level {
	const at = LEVELS.indexOf(baseline);
	if (gear === "chat" || gear === "light") return LEVELS[Math.min(at, LEVELS.indexOf("low"))];
	if (gear === "heavy") return LEVELS[Math.max(at, LEVELS.indexOf("high"))];
	return baseline;
}

/** The hints the main model can be given, by a stable id a client can translate the shown line by. */
export const PREFLIGHT_HINTS = {
	clarify: "The request looks under-specified. Ask one focused clarifying question before doing significant work.",
	side_question: "This is a side question. Answer it briefly, keep the plan for the main task, then carry on with it.",
	plan_first: "This looks like a large or risky change. Write a short plan and confirm the approach before editing.",
	try_hive:
		"This looks hard. If the cause is unknown or a direct attempt fails, use the hive tool: several investigators on the one problem, from different angles, sharing what they find.",
	try_delegate: "This work splits into independent parts. Consider the delegate tool to run them in parallel.",
} as const;

export type PreflightHintId = keyof typeof PREFLIGHT_HINTS;

/** Which hints a verdict calls for. Unsure verdicts say nothing. */
export function hintIdsFor(outcome: PreflightOutcome, tools: readonly string[]): PreflightHintId[] {
	const ids: PreflightHintId[] = [];
	if (outcome.needsClarification === "yes") ids.push("clarify");
	if (outcome.sideQuestion === "yes") ids.push("side_question");
	if (outcome.planFirst === "yes") ids.push("plan_first");
	if (outcome.gear === "heavy" && tools.includes("hive")) ids.push("try_hive");
	if (outcome.swarmWorthy === "yes" && tools.includes("delegate")) ids.push("try_delegate");
	return ids;
}

/** One line per verdict the main model should know about. */
export function hintsFor(outcome: PreflightOutcome, tools: readonly string[]): string[] {
	return hintIdsFor(outcome, tools).map((id) => PREFLIGHT_HINTS[id]);
}

function describe(label: string, decision: Decision<PreflightOutcome>): string {
	const latency = decision.latencyMs === undefined ? "" : ` ${decision.latencyMs}ms`;
	const cut = decision.warnings?.length ? ` (${decision.warnings.length} warnings)` : "";
	const shown = decision.mode === "active" ? decision.outcome : (decision.judged ?? decision.outcome);
	if (shown.turnType === "unknown" && !decision.judged) {
		return `${label} ${decision.mode}: ${decision.reason ?? "no verdict"}${latency}`;
	}
	return `${label} ${decision.mode}: ${shown.turnType} -> ${shown.gear}${latency}${cut}`;
}

const PANEL = "kyrn.preflight";
/** The panel is only a stand-in until the message reaches the chat. If it never does (pi refused the prompt), it goes. */
const PANEL_MAX_MS = 30_000;

/** One user message on its way from the editor to the chat, and what the judge said about it. */
interface Staged {
	turnId: number;
	message: string;
	startedAt: number;
	decision?: Decision<PreflightOutcome>;
	/** Set when the prompt stopped waiting for the judge: verdict in hand, time up, or skipped by the user. */
	waitEndedAt?: number;
	waitEndedBy?: "verdict" | "timeout" | "skipped";
	/** `before_agent_start` has run; a verdict that arrives after this changes nothing. */
	turnStarted: boolean;
	applied: boolean;
	thinking?: { from: string; to: string };
	hints: string[];
	hintIds: string[];
	/** What another feature is working out before the turn starts, as it put it. */
	step?: string;
	/** The user message is in the chat and in the session, so the verdict line can follow it. */
	messageShown: boolean;
	entryShown: boolean;
}

/**
 * What the judge should read for a message. A prompt template or a skill
 * command stands for what it does, not for its name: "/init" says nothing,
 * its description does. Undefined means there is nothing worth judging.
 */
export function judgedText(
	text: string,
	commands: readonly { name: string; description?: string }[],
): string | undefined {
	const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
	if (!match) return text;
	const command = commands.find((candidate) => candidate.name === match[1]);
	// Not a command after all: a message may well start with a path.
	if (!command) return text;
	if (!command.description) return undefined;
	return match[2] ? `${command.description}\n${match[2]}` : command.description;
}

/** Who settled the verdict and what became of it. Exported for tests. */
export function verdictStateOf(staged: {
	decision?: Decision<PreflightOutcome>;
	turnStarted: boolean;
	applied: boolean;
}): VerdictState {
	const decision = staged.decision;
	if (!decision) return "none";
	if (decision.mode !== "active") return decision.judged ? "shadow" : "none";
	if (decision.source !== "judge" && decision.outcome.turnType === "unknown") return "none";
	return staged.turnStarted && !staged.applied ? "late" : "applied";
}

/**
 * A1-A7: one batched judgment per user message decides the gear of the turn.
 * In shadow mode it only records; in active mode the prompt waits for it
 * (bounded) and the gear sets the thinking level and adds one-line hints.
 *
 * The wait is on screen: the message sits in a panel above the editor while
 * the judge reads it, the verdict shows there the moment it lands, and only
 * then does the message move into the chat, with the verdict as a line under
 * it that expands to every answer the judge gave.
 */
export function registerPreflight(runtime: KyrnRuntime): void {
	const options = runtime.options("preflight", {
		enabled: true,
		thinking: true,
		hints: true,
		/** Show the wait and the verdict in the terminal UI. */
		show: true,
		waitMs: 6000,
	});
	if (!options.enabled) return;
	const { pi } = runtime;
	if (process.env.KYRN_SWARM_DEPTH) {
		// A sub-agent's turn was routed by its parent: role, model and thinking level are set. A second opinion
		// here would undo that choice, and it costs every sub-agent seconds before it starts.
		pi.on(
			"input",
			failOpen((event, ctx) => {
				runtime.touch(ctx);
				if (event.source !== "extension" && event.text.trim() && !event.streamingBehavior)
					runtime.beginTurn(event.text);
				return { action: "continue" as const };
			}),
		);
		return;
	}
	let baseline: Level | undefined;
	let staged: Staged | undefined;
	let panel: { redraw?: () => void; timer?: ReturnType<typeof setTimeout> } | undefined;

	const data = (turn: Staged): VerdictData => {
		const decision = turn.decision;
		if (!decision) {
			const waited = (turn.waitEndedAt ?? Date.now()) - turn.startedAt;
			const skipped = turn.waitEndedBy === "skipped";
			const seconds = Number((waited / 1000).toFixed(1));
			const reason = skipped ? "skipped" : `no answer after ${seconds.toFixed(1)} s`;
			return verdictData(undefined, {
				by: runtime.judgeLabel,
				state: "none",
				reason,
				reasonCode: skipped ? "skipped" : "no_answer",
				...(skipped ? {} : { reasonParams: { seconds } }),
				waitedMs: waited,
			});
		}
		return verdictData(decision, {
			by: decision.source === "judge" || decision.mode !== "active" ? runtime.judgeLabel : "rule",
			state: verdictStateOf(turn),
			thinking: turn.thinking,
			hints: turn.hints,
			hintIds: turn.hintIds,
		});
	};

	const closePanel = (ctx: ExtensionContext) => {
		if (!panel) return;
		if (panel.timer) clearTimeout(panel.timer);
		panel = undefined;
		ctx.ui.setWidget(PANEL, undefined);
	};

	const openPanel = (ctx: ExtensionContext, turn: Staged) => {
		closePanel(ctx);
		const opened: NonNullable<typeof panel> = {};
		panel = opened;
		ctx.ui.setWidget(PANEL, (tui, theme) => {
			// The spinner and the clock move until the wait is over; after that the panel only changes when told to.
			const spinner = setInterval(() => {
				if (turn.waitEndedAt === undefined) tui.requestRender();
			}, 80);
			spinner.unref?.();
			opened.redraw = () => tui.requestRender();
			return {
				render: (width: number) =>
					renderPending(
						{
							message: turn.message,
							judge: runtime.judgeLabel,
							elapsedMs: (turn.waitEndedAt ?? Date.now()) - turn.startedAt,
							verdict: turn.waitEndedAt === undefined ? undefined : data(turn),
							step: turn.step,
							skipKey: "esc",
						},
						width,
						theme,
					),
				invalidate() {},
				dispose() {
					clearInterval(spinner);
				},
			};
		});
	};

	/** The verdict line goes into the chat once there is a verdict and a message for it to stand under. */
	const showEntry = (turn: Staged) => {
		if (turn.entryShown || !turn.messageShown || !turn.decision || turn.decision.mode === "off") return;
		turn.entryShown = true;
		pi.appendEntry<VerdictData>(VERDICT_ENTRY, data(turn));
		runtime.present("preflight.verdict", data(turn), turn.turnId);
	};

	// Other features say what they are working out before the turn starts; the panel passes it on.
	runtime.onProgress = (step) => {
		if (!panel || !staged) return;
		staged.step = step;
		panel.redraw?.();
	};

	pi.registerEntryRenderer<VerdictData>(VERDICT_ENTRY, (entry, { expanded }, theme) => {
		const verdict = entry.data;
		if (!verdict || verdict.version !== 1) return undefined;
		return { render: (width: number) => renderVerdict(verdict, expanded, width, theme), invalidate() {} };
	});

	pi.on(
		"input",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			if (event.source === "extension" || !event.text.trim()) return { action: "continue" as const };
			// A message typed mid-run belongs to the turn in progress; routing it is the interjection feature's job.
			if (event.streamingBehavior) return { action: "continue" as const };

			runtime.beginTurn(event.text);
			// Whatever the last message left on screen or in flight is no longer about the current one.
			closePanel(ctx);
			staged = undefined;
			const judged = judgedText(event.text, pi.getCommands());
			if (judged === undefined) return { action: "continue" as const };
			const input: PreflightInput = {
				userMessage: judged,
				recentTurns: recentTurnDigests(ctx),
				taskFrame: runtime.userTurns > 1 ? runtime.taskFrame() : undefined,
				sessionHasWork: runtime.toolCalls > 0,
			};
			const turn = runtime.turn;
			const active = runtime.mode(inputPreflight.id) === "active";
			const visible = options.show && (ctx.mode === "tui" || ctx.mode === "rpc");
			const turnId = runtime.userTurns;
			const current: Staged = {
				turnId,
				message: event.text,
				startedAt: Date.now(),
				turnStarted: false,
				applied: false,
				hints: [],
				hintIds: [],
				messageShown: false,
				entryShown: false,
			};
			staged = visible ? current : undefined;
			runtime.present(
				"preflight.pending",
				{ judge: runtime.judgeLabel, mode: runtime.mode(inputPreflight.id) },
				turnId,
			);
			// No panel for a prompt pi is about to refuse: its error is the feedback, and nothing would ever take the panel down.
			const willRun = ctx.model !== undefined && ctx.modelRegistry.hasConfiguredAuth(ctx.model);
			if (visible && active && willRun && ctx.mode === "tui") openPanel(ctx, current);

			const pending = runtime.engine.decide(inputPreflight, input, { signal: ctx.signal }).then((decision) => {
				// A fallback that still names a turn type was settled by rule (an obvious chat message), judge or no judge.
				const ruled = decision.mode === "active" && decision.outcome.turnType !== "unknown";
				if (decision.source === "judge" || ruled) turn.preflight = decision.outcome;
				current.decision = decision;
				runtime.present("preflight.verdict", data(current), turnId);
				try {
					runtime.status(describe(runtime.judgeLabel, decision));
					// A verdict that outlived its turn has no message left to stand under.
					if (staged === current) showEntry(current);
				} catch {
					// Showing the verdict is a courtesy; failing to must not cost the turn its gear.
				}
			});
			if (!active) {
				void pending.catch(() => {});
				return { action: "continue" as const };
			}

			// Bounded, and the user can cut it short: a slow judge costs the turn its gear, never its start.
			let skip: () => void = () => {};
			const skipped = new Promise<"skipped">((resolve) => {
				skip = () => resolve("skipped");
			});
			const unsubscribe = panel
				? ctx.ui.onTerminalInput((keys) => {
						if (!matchesKey(keys, "escape")) return undefined;
						skip();
						return { consume: true };
					})
				: undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), options.waitMs);
			});
			try {
				current.waitEndedBy = await Promise.race([pending.then(() => "verdict" as const), timeout, skipped]);
			} finally {
				if (timer) clearTimeout(timer);
				unsubscribe?.();
				current.waitEndedAt = Date.now();
				runtime.present(
					"preflight.wait_end",
					{ reason: current.waitEndedBy, waitedMs: current.waitEndedAt - current.startedAt },
					turnId,
				);
				if (panel) {
					panel.redraw?.();
					panel.timer = setTimeout(() => closePanel(ctx), PANEL_MAX_MS);
					panel.timer.unref?.();
				}
			}
			return { action: "continue" as const };
		}),
	);

	pi.on(
		"before_agent_start",
		failOpen((_event, ctx) => {
			runtime.touch(ctx);
			const outcome = runtime.turn.preflight;
			if (staged) staged.turnStarted = true;
			if (!outcome) return undefined;
			if (staged) staged.applied = true;

			if (options.thinking) {
				const current = pi.getThinkingLevel() as Level;
				const wanted = thinkingForGear(outcome.gear, current);
				if (wanted !== current) {
					baseline = current;
					pi.setThinkingLevel(wanted as never);
					if (staged) staged.thinking = { from: current, to: wanted };
				}
			}
			const hintIds = options.hints ? hintIdsFor(outcome, pi.getActiveTools()) : [];
			const hints = hintIds.map((id) => PREFLIGHT_HINTS[id]);
			if (staged) {
				staged.hints = hints;
				staged.hintIds = hintIds;
			}
			if (hints.length === 0) return undefined;
			// With the verdict line on screen the hints are one keypress away there; without it they show as their own message.
			return { message: { customType: "kyrn.hint", content: hints.join("\n"), display: staged === undefined } };
		}),
	);

	// The agent is starting, so pi is about to put the message in the chat: the stand-in has done its job.
	pi.on(
		"agent_start",
		failOpen((_event, ctx) => {
			closePanel(ctx);
			return undefined;
		}),
	);

	// First model call of the turn: by now the user message is in the chat and in the session.
	pi.on(
		"context",
		failOpen(() => {
			if (staged && !staged.messageShown) {
				staged.messageShown = true;
				showEntry(staged);
			}
			return undefined;
		}),
	);

	pi.on(
		"tool_result",
		failOpen(() => {
			runtime.toolCalls++;
			return undefined;
		}),
	);

	// The gear is per turn: hand the user's own thinking level back when the run ends.
	pi.on(
		"agent_end",
		failOpen(() => {
			if (baseline !== undefined) pi.setThinkingLevel(baseline as never);
			baseline = undefined;
			return undefined;
		}),
	);

	pi.on(
		"session_shutdown",
		failOpen((_event, ctx) => {
			closePanel(ctx);
			staged = undefined;
			return undefined;
		}),
	);
}
