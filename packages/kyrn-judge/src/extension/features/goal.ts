import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { goalMet } from "../../decisions/goal-met.ts";
import { openItems } from "../../frame/frame.ts";
import { clip, failOpen, type KyrnRuntime, textOf } from "../runtime.ts";

/** Stored in the session, so a rewind or a fork brings back the goal of that branch. */
export const GOAL_ENTRY = "kyrn.goal";
export const GOAL_MESSAGE = "kyrn.goal";

const GOAL_LENGTH = 600;

export type GoalStatus = "active" | "paused" | "met" | "cleared";

export interface GoalState {
	readonly status: GoalStatus;
	/** The condition, in the user's words. */
	readonly text: string;
	/** Why it is not running, for the user to read. */
	readonly reason?: string;
	/** Times mu sent the agent back to work since the user last spoke. */
	readonly continuations: number;
}

export function parseGoalEntry(data: unknown): GoalState | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const { status, text, reason, continuations } = data as Record<string, unknown>;
	if (status !== "active" && status !== "paused" && status !== "met" && status !== "cleared") return undefined;
	if (typeof text !== "string" || !text.trim()) return undefined;
	return {
		status,
		text,
		reason: typeof reason === "string" ? reason : undefined,
		continuations: typeof continuations === "number" && continuations >= 0 ? Math.floor(continuations) : 0,
	};
}

export function describeGoal(goal: GoalState | undefined): string {
	if (!goal || goal.status === "cleared") {
		return "No goal is set. /goal <condition> keeps the agent working until the condition holds; /goal clear ends it.";
	}
	const state =
		goal.status === "active"
			? `working (sent back to work ${goal.continuations} time${goal.continuations === 1 ? "" : "s"})`
			: goal.status === "met"
				? "met"
				: `paused: ${goal.reason ?? "waiting for you"}. Your next message picks it up again`;
	return `goal: ${goal.text}\nstate: ${state}`;
}

/**
 * Goal mode. `/goal <condition>` states once what "finished" means, and from
 * then on the agent is not allowed to stop short of it: each time it ends a
 * run, the judge reads the closing message against the condition, the harness
 * adds what it knows for a fact (open acceptance items, an edit nothing ran
 * after), and the agent is sent back to work until the condition holds.
 *
 * It stops by itself when the agent needs the user, when the user interrupts,
 * when a model call fails, when the agent twice in a row ends a run without
 * doing anything, and when its allowance of continuations or minutes is used
 * up. The user's next message picks a paused goal up again with a fresh
 * allowance.
 */
export function registerGoal(runtime: KyrnRuntime): void {
	const options = runtime.options("goal", { enabled: true, maxContinuations: 20, maxMinutes: 180, idleLimit: 2 });
	if (!options.enabled) return;
	const { pi } = runtime;
	let goal: GoalState | undefined;
	/** Runs in a row that ended without a single tool call. */
	let idle = 0;
	let since = Date.now();

	const show = (ctx: ExtensionContext | undefined, text: string, level: "info" | "warning" = "info") => {
		if (ctx?.hasUI) ctx.ui.notify(text, level);
	};
	const adopt = (next: GoalState | undefined) => {
		goal = next;
		runtime.goalActive = next?.status === "active";
	};
	const save = (next: GoalState) => {
		adopt(next);
		pi.appendEntry<GoalState>(GOAL_ENTRY, next);
		runtime.present("goal.state", { ...next, maxContinuations: options.maxContinuations });
	};
	const pause = (ctx: ExtensionContext, reason: string) => {
		if (!goal) return;
		save({ ...goal, status: "paused", reason });
		show(ctx, `mu goal paused: ${reason}.\n${goal.text}`, "warning");
	};

	const restore = (ctx: ExtensionContext) => {
		let restored: GoalState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === GOAL_ENTRY) {
				restored = parseGoalEntry(entry.data) ?? restored;
			}
		}
		// A goal that was running when the session closed does not start by itself: the user may be elsewhere now.
		adopt(
			restored?.status === "active"
				? { ...restored, status: "paused", reason: "the session was reopened" }
				: restored,
		);
		idle = 0;
		since = Date.now();
	};
	pi.on(
		"session_start",
		failOpen((_event, ctx) => {
			restore(ctx);
			return undefined;
		}),
	);
	pi.on(
		"session_tree",
		failOpen((_event, ctx) => {
			restore(ctx);
			return undefined;
		}),
	);

	pi.on(
		"input",
		failOpen((event) => {
			if (event.source === "extension" || !event.text.trim() || event.streamingBehavior) return undefined;
			// A command is not the user picking the work up again. A message may well start with a path, though.
			const command = /^\/(\S+)/.exec(event.text.trim())?.[1];
			if (command && pi.getCommands().some((candidate) => candidate.name === command)) return undefined;
			// The user is back and has seen where things stand: a paused goal goes on, with a fresh allowance.
			if (goal?.status === "paused") save({ ...goal, status: "active", reason: undefined, continuations: 0 });
			if (goal?.status === "active") {
				if (goal.continuations > 0) adopt({ ...goal, continuations: 0 });
				idle = 0;
				since = Date.now();
			}
			return undefined;
		}),
	);

	pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>(async (event, ctx) => {
			runtime.touch(ctx);
			if (goal?.status !== "active") return undefined;
			const last = [...event.messages].reverse().find((message) => message.role === "assistant") as
				| { content?: unknown; stopReason?: string }
				| undefined;
			// Cut by the harness itself, which also sends the model back to work: not an interruption by the user.
			if (runtime.harnessAbort) return undefined;
			if (last?.stopReason === "aborted") {
				pause(ctx, "you interrupted the run");
				return undefined;
			}
			if (!last || last.stopReason === "error") {
				pause(ctx, "a model call failed");
				return undefined;
			}
			const finalMessage = textOf(last.content);
			idle = event.messages.some((message) => message.role === "toolResult") ? 0 : idle + 1;

			const open = openItems(runtime.frame);
			const turn = runtime.turn;
			const unverified = turn.editedFiles.size > 0 && !turn.ranCommandAfterLastEdit;
			const decision = await runtime.engine.decide(goalMet, {
				goal: clip(goal.text, GOAL_LENGTH),
				finalMessage: clip(finalMessage, 800),
				openItems: open.length,
				unverified,
			});
			// The goal may have been cleared or replaced while the judge was reading.
			if (goal?.status !== "active") return undefined;

			if (decision.outcome === "met") {
				save({ ...goal, status: "met", reason: undefined });
				show(
					ctx,
					`mu goal met after ${goal.continuations} continuation${goal.continuations === 1 ? "" : "s"}.\n${goal.text}`,
				);
				return undefined;
			}
			if (decision.outcome === "ask") {
				pause(ctx, "the agent needs something from you");
				return undefined;
			}
			if (decision.outcome === "unjudged") {
				pause(ctx, "no judge could read whether the goal holds, and nothing is provably unfinished");
				return undefined;
			}
			if (idle >= options.idleLimit) {
				pause(ctx, `the agent ended ${idle} runs in a row without doing anything`);
				return undefined;
			}
			if (goal.continuations >= options.maxContinuations) {
				pause(ctx, `the allowance of ${options.maxContinuations} continuations is used up`);
				return undefined;
			}
			if (Date.now() - since > options.maxMinutes * 60_000) {
				pause(ctx, `the allowance of ${options.maxMinutes} minutes is used up`);
				return undefined;
			}

			const next: GoalState = { ...goal, continuations: goal.continuations + 1 };
			save(next);
			const facts: string[] = [];
			if (open.length > 0) {
				facts.push(
					`Open acceptance items: ${open.map((item) => `${item.id} ${item.text}`).join("; ")}. Tick each with the todo tool and one line of evidence, or say which no longer apply.`,
				);
			}
			if (unverified) {
				facts.push(`You edited ${[...turn.editedFiles].join(", ")} and nothing has run since. Verify the change.`);
			}
			pi.sendMessage(
				{
					customType: GOAL_MESSAGE,
					content: [
						`The goal the user set is not met yet: "${clip(goal.text, GOAL_LENGTH)}"`,
						...facts,
						"Keep working towards it. When it holds, say so plainly and name the evidence. If you cannot go on without the user, say exactly what you need from them and stop.",
						`(continuation ${next.continuations} of ${options.maxContinuations})`,
					].join("\n"),
					display: true,
					details: { continuation: next.continuations },
				},
				{ triggerTurn: true },
			);
			return undefined;
		}),
	);

	pi.registerCommand("goal", {
		description: "Keep the agent working until a condition holds: /goal <condition>, /goal (show), /goal clear",
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			const text = args.trim();
			if (!text) {
				show(ctx, describeGoal(goal));
				return;
			}
			if (["clear", "off", "stop", "none"].includes(text.toLowerCase())) {
				if (goal && goal.status !== "cleared") save({ ...goal, status: "cleared", reason: undefined });
				show(ctx, "mu goal cleared.");
				return;
			}
			save({ status: "active", text, continuations: 0 });
			idle = 0;
			since = Date.now();
			// The condition is the user's own sentence: the task frame reads it like any other message of theirs.
			runtime.beginTurn(text);
			show(
				ctx,
				`mu goal set. The agent keeps working until it holds (at most ${options.maxContinuations} continuations).`,
			);
			pi.sendMessage(
				{
					customType: GOAL_MESSAGE,
					content: [
						`The user set a goal: "${clip(text, GOAL_LENGTH)}"`,
						"Work until it holds. When it does, say so plainly and name the evidence. If you cannot go on without the user, say exactly what you need from them and stop.",
					].join("\n"),
					display: true,
					details: { continuation: 0 },
				},
				{ triggerTurn: true },
			);
		},
	});
}
