import { defineDecision } from "../decision.ts";
import { pickChoice } from "../policy.ts";

/**
 * B8: something happened outside the conversation (context is filling up, a
 * file changed on disk, a background task finished). Should the model hear
 * about it, and when? Every interruption costs tokens and attention.
 */
export interface NotifyInput {
	readonly event: string;
	readonly goal: string;
	readonly currentAction: string;
}

export type NotifyOutcome = "now" | "next_turn" | "drop";

export const notifyRouting = defineDecision({
	id: "notify.routing",
	version: 1,
	cacheImpact: "append-only",
	latency: "background",
	capabilities: "relate",
	questions: {
		urgency: {
			type: "choice",
			instructions: "When does the agent working on `goal` need to hear about `event`?",
			criteria: {
				now: "Immediately: continuing without it would waste work or cause harm",
				next_turn: "Soon, but it can wait until the current step is finished",
				drop: "Never: it does not affect the work",
				other: "Cannot tell",
			},
		},
	},
	buildState(input: NotifyInput) {
		return { event: input.event, goal: input.goal, current_action: input.currentAction };
	},
	policy(answers): NotifyOutcome {
		return pickChoice(answers.urgency) ?? "next_turn";
	},
	fallback(): NotifyOutcome {
		return "next_turn";
	},
});
