import { defineDecision } from "../decision.ts";
import { threeZone } from "../policy.ts";
import type { Questions } from "../types.ts";

/** One stored lesson. `trigger` says when it applies; `lesson` is the single line that gets injected. */
export interface Lesson {
	readonly id: string;
	readonly trigger: string;
	readonly lesson: string;
}

export interface RecallInput {
	readonly userMessage: string;
	readonly lessons: readonly Lesson[];
}

export type RecallOutcome = { readonly apply: readonly string[] };

export function lessonQuestionId(index: number): string {
	return `lesson_${index}`;
}

/** A5, experience read side: which stored lessons apply to this message? Only a confident "yes" injects one. */
export const memoryRecall = defineDecision({
	id: "memory.recall",
	version: 1,
	cacheImpact: "append-only",
	latency: "inline",
	capabilities: "relate",
	questions: {} as Questions,
	questionsFor(input: RecallInput): Questions {
		return Object.fromEntries(
			input.lessons.map((lesson, index) => [
				lessonQuestionId(index),
				{
					type: "boolean" as const,
					instructions: `Does this situation match \`user_message\`? ${lesson.trigger.slice(0, 200)}`,
				},
			]),
		);
	},
	buildState(input: RecallInput) {
		return { user_message: input.userMessage };
	},
	policy(answers, input): RecallOutcome {
		const apply: string[] = [];
		input.lessons.forEach((lesson, index) => {
			const answer = answers[lessonQuestionId(index)];
			if (answer?.type === "boolean" && threeZone(answer) === "yes") apply.push(lesson.id);
		});
		return { apply };
	},
	fallback(): RecallOutcome {
		return { apply: [] };
	},
});

export interface CaptureInput {
	readonly userMessage: string;
	readonly previousAssistantMessage: string;
}

export type CaptureOutcome = "capture" | "skip";

/** D2, experience write side: is this message a correction or a standing preference worth keeping? */
export const memoryCapture = defineDecision({
	id: "memory.capture",
	version: 1,
	cacheImpact: "none",
	latency: "background",
	questions: {
		correction: { type: "boolean", instructions: "Does `user_message` correct a mistake the assistant made?" },
		preference: { type: "boolean", instructions: "Does `user_message` state a rule to follow from now on?" },
	},
	buildState(input: CaptureInput) {
		return { user_message: input.userMessage, previous_assistant_message: input.previousAssistantMessage };
	},
	policy(answers): CaptureOutcome {
		const lasting = threeZone(answers.correction) === "yes" || threeZone(answers.preference) === "yes";
		return lasting ? "capture" : "skip";
	},
	fallback(): CaptureOutcome {
		return "skip";
	},
});
