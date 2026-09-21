import { defineDecision } from "../decision.ts";
import { pickChoice } from "../policy.ts";

/**
 * B1, admission control for tool output: tokens that never enter the context
 * are the cheapest ones, and keeping them out costs no prompt cache. One
 * judgment per chunk, so a judge with a small window can do it too.
 *
 * The question asks what a chunk IS, not whether it is relevant to the agent's
 * intent. Measured on the local judge (kyrn/docs/03-local-judge.md): the
 * relational form called every chunk relevant, noise included, while this
 * classification put 4 of 4 noise chunks and 3 of 3 errors in the right class.
 *
 * Only a confident noise class drops a chunk. The caller archives whatever it
 * drops and leaves a one-line pointer, which keeps a wrong verdict recoverable.
 */
export interface AdmissionInput {
	/** The call that produced the output, e.g. the shell command. */
	readonly call: string;
	readonly chunk: string;
}

export type AdmissionKind = "error" | "result" | "progress" | "warning" | "passing";

export type AdmissionOutcome = {
	readonly kind: AdmissionKind | "unknown";
	readonly drop: boolean;
};

const NOISE: readonly AdmissionKind[] = ["progress", "warning", "passing"];

export const toolAdmission = defineDecision({
	id: "tool.admission",
	version: 2,
	cacheImpact: "none",
	latency: "inline",
	questions: {
		kind: {
			type: "choice",
			instructions: "What kind of output is `chunk`?",
			criteria: {
				error: "An error, a failure or a stack trace",
				result: "Search results, file contents or data",
				progress: "Progress, downloads or build status",
				warning: "Repeated warnings or deprecation notices",
				passing: "Tests or checks that passed",
				other: "Something else",
			},
		},
	},
	// The chunk is the long field, so it goes last: a bounded-window judge cuts the tail.
	buildState(input: AdmissionInput) {
		return { call: input.call, chunk: input.chunk };
	},
	policy(answers): AdmissionOutcome {
		const kind = pickChoice(answers.kind) ?? "unknown";
		return { kind, drop: kind !== "unknown" && NOISE.includes(kind) };
	},
	fallback(): AdmissionOutcome {
		return { kind: "unknown", drop: false };
	},
});
