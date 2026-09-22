import { defineDecision } from "../decision.ts";
import { pickChoice, threeZone } from "../policy.ts";
import type { Answer, Question, Questions } from "../types.ts";

/**
 * The plain-language board. Its reader is the judge on purpose: what the
 * agent is doing now is a choice among a handful of phases, which acceptance
 * item it works on is a choice among the open ones, and whether the board is
 * worth writing again is a yes or no. Those answers are cheap, so the board
 * can look often; the model that writes the words for a person is only
 * called when the judge sees something new.
 */
export type BoardPhase =
	| "understanding"
	| "planning"
	| "changing"
	| "checking"
	| "fixing"
	| "waiting"
	| "wrapping_up"
	| "stuck";

export interface BoardStep {
	readonly tool: string;
	/** The command or the path, short. */
	readonly what: string;
	readonly failed: boolean;
	/** A test run, build, type check or linter. */
	readonly check: boolean;
}

export interface BoardItem {
	readonly id: string;
	readonly text: string;
	readonly done: boolean;
}

export interface BoardInput {
	readonly goal: string;
	readonly items: readonly BoardItem[];
	/** The latest tool calls, oldest first. */
	readonly steps: readonly BoardStep[];
	/** The latest thing the agent said. */
	readonly latest: string;
	/** The agent stopped: its run ended and it waits for the user. */
	readonly ended: boolean;
	/** What the board said last time, when it said anything. */
	readonly last?: { readonly phase?: BoardPhase; readonly focus?: string; readonly now: string };
}

export type BoardReading = {
	/** By the judge, or by rule when it could not tell. */
	readonly phase: BoardPhase;
	/** The id of the acceptance item being worked on. */
	readonly focus: string | null;
	readonly needsUser: boolean;
	/** Worth writing the board again. */
	readonly update: boolean;
};

const MAX_ITEMS = 8;
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "web_fetch", "web_search", "browse", "locate"]);
const CHANGE_TOOLS = new Set(["edit", "write", "sg_rewrite", "conflicts_resolve", "apply_patch_from"]);

const PHASES: Record<BoardPhase | "other", string> = {
	understanding: "Reading code, files or pages to understand the task",
	planning: "Working out how to do it, nothing changed yet",
	changing: "Changing code or files",
	checking: "Running tests, a build or another check",
	fixing: "Fixing what a check, an error or the user reported",
	waiting: "Stopped, waiting for the user",
	wrapping_up: "Finished its work and summing up",
	stuck: "Repeating itself or going in circles",
	other: "Cannot tell",
};

const stepLine = (step: BoardStep) => `${step.tool} ${step.what} -> ${step.failed ? "error" : "ok"}`;
const choiceOf = (answer: Answer | undefined) => (answer?.type === "choice" ? pickChoice(answer) : undefined);
const verdict = (answer: Answer | undefined) => (answer?.type === "boolean" ? threeZone(answer) : "unsure");

/** Asks like a person would: questions end with a question mark, in either script. */
export function asksSomething(text: string): boolean {
	return /[?？]\s*$/.test(text.trim());
}

/** The phase by rule, when there is no judge: the kind of the last step, or how the run ended. */
export function phaseByRule(input: BoardInput): BoardPhase {
	if (input.ended) return asksSomething(input.latest) ? "waiting" : "wrapping_up";
	const last = input.steps.at(-1);
	if (!last) return "understanding";
	if (last.check) return last.failed ? "fixing" : "checking";
	if (CHANGE_TOOLS.has(last.tool))
		return input.steps.some((step) => step.check && step.failed) ? "fixing" : "changing";
	if (READ_ONLY_TOOLS.has(last.tool)) return "understanding";
	return "changing";
}

export const boardRead = defineDecision({
	id: "board.read",
	version: 1,
	cacheImpact: "none",
	latency: "background",
	capabilities: "relate",
	questions: {} as Questions,
	questionsFor(input: BoardInput): Questions {
		const open = input.items.filter((item) => !item.done).slice(0, MAX_ITEMS);
		const questions: Record<string, Question> = {
			phase: {
				type: "choice",
				instructions: "What is the agent doing right now, judging by `steps` and `latest`?",
				criteria: PHASES,
			},
			needs_user: {
				type: "boolean",
				instructions: "Is the agent waiting for the user to confirm, decide or provide something?",
			},
		};
		if (open.length > 1) {
			questions.focus = {
				type: "choice",
				instructions: "Which open item of `items` are the latest `steps` working on?",
				criteria: {
					...Object.fromEntries(open.map((item) => [item.id, item.text.slice(0, 160)])),
					none: "None of them, or cannot tell",
				},
			};
		}
		if (input.last) {
			questions.changed = {
				type: "boolean",
				instructions:
					"Compared with `last_board`, has something happened that the user would want to hear: a new phase, an item finished, a failure, a question to them?",
			};
		}
		return questions;
	},
	buildState(input: BoardInput) {
		return {
			goal: input.goal.slice(0, 600),
			items: input.items
				.slice(0, 20)
				.map((item) => `${item.id} [${item.done ? "done" : "open"}] ${item.text.slice(0, 160)}`)
				.join("\n"),
			steps: input.steps.map(stepLine).join("\n") || "(no tool calls yet)",
			latest: input.latest.slice(0, 800),
			agent_stopped: input.ended,
			...(input.last ? { last_board: `${input.last.phase ?? "?"}: ${input.last.now}`.slice(0, 400) } : {}),
		};
	},
	policy(answers, input): BoardReading {
		const picked = choiceOf(answers.phase) as BoardPhase | undefined;
		const open = input.items.filter((item) => !item.done);
		const focus = open.length === 1 ? open[0].id : (choiceOf(answers.focus) ?? null);
		const needsUser = verdict(answers.needs_user) === "yes";
		const last = input.last;
		// Unsure counts as changed: a board one update late is worse than one update too many.
		const changed =
			!last ||
			verdict(answers.changed) !== "no" ||
			(picked !== undefined && picked !== last.phase) ||
			focus !== (last.focus ?? null);
		return { phase: picked ?? phaseByRule(input), focus, needsUser, update: changed || needsUser };
	},
	fallback(input): BoardReading {
		const phase = phaseByRule(input);
		const open = input.items.filter((item) => !item.done);
		return {
			phase,
			focus: open.length === 1 ? open[0].id : null,
			needsUser: input.ended && asksSomething(input.latest),
			update: !input.last || input.last.phase !== phase || input.ended,
		};
	},
});
