import { defineDecision } from "../decision.ts";
import { threeZone } from "../policy.ts";

/**
 * D1, the completion gate. Whether files were edited and whether anything ran
 * afterwards are facts the harness already has; the judge only reads the
 * agent's closing message and the nature of the request.
 */
export interface CompletionInput {
	readonly userMessage: string;
	readonly finalMessage: string;
	readonly editedFiles: number;
	readonly ranCommandAfterLastEdit: boolean;
}

export type CompletionOutcome = "done" | "nudge";

export const turnCompletion = defineDecision({
	id: "turn.completion",
	version: 1,
	cacheImpact: "append-only",
	latency: "inline",
	capabilities: { needs_check: "meta" },
	questions: {
		claims_done: { type: "boolean", instructions: "Does `final_message` say the work is finished?" },
		needs_check: {
			type: "boolean",
			instructions: "Should the change asked for in `user_message` be checked by running it?",
		},
	},
	buildState(input: CompletionInput) {
		return {
			final_message: input.finalMessage,
			user_message: input.userMessage,
			edited_files: input.editedFiles,
			ran_command_after_last_edit: input.ranCommandAfterLastEdit,
		};
	},
	policy(answers, input): CompletionOutcome {
		if (input.editedFiles === 0 || input.ranCommandAfterLastEdit) return "done";
		const unverifiedClaim = threeZone(answers.claims_done) === "yes" && threeZone(answers.needs_check) === "yes";
		return unverifiedClaim ? "nudge" : "done";
	},
	fallback(): CompletionOutcome {
		return "done";
	},
});
