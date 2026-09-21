import { defineDecision } from "../decision.ts";
import type { NoteKind } from "../hive/board.ts";
import { threeZone } from "../policy.ts";

/**
 * H1/H2, the hive's two gates. Bees work in separate context windows, which
 * is what lets a hard problem be attacked from several sides at once, and
 * also why swarms duplicate work and contradict each other: nothing one bee
 * learns reaches the others. Sharing everything floods every context; letting
 * each bee's main model decide what to share is slow, costly, and forgotten.
 *
 * So the judge does it, once per step, like the judges of a waggle dance:
 * H1 decides whether what a bee just said or saw is news for the hive, and
 * H2 decides, per bee, whether a piece of news matters to what that bee is doing.
 */
export interface PublishInput {
	readonly goal: string;
	/** What this bee was asked to look into. */
	readonly focus: string;
	/** Word for word what the bee said, or the beginning of what a tool returned. */
	readonly note: string;
	readonly source: string;
}

export type PublishOutcome = { readonly publish: boolean; readonly kind: NoteKind | null; readonly score: number };

export const hivePublish = defineDecision({
	id: "hive.publish",
	version: 1,
	cacheImpact: "none",
	latency: "background",
	capabilities: { share_worthy: "relate", kind: "classify" },
	questions: {
		share_worthy: {
			type: "boolean",
			instructions: "Would `note` help other workers on `goal` who have not seen it?",
		},
		kind: {
			type: "choice",
			instructions: "What is `note`?",
			criteria: {
				finding: "A fact discovered about the problem",
				dead_end: "An approach that failed or was ruled out",
				decision: "A choice made that the other workers must respect",
				blocker: "Something that stops progress",
				other: "Routine progress or something else",
			},
		},
	},
	buildState(input: PublishInput) {
		return { note: input.note, source: input.source, goal: input.goal, this_worker_focus: input.focus };
	},
	policy(answers): PublishOutcome {
		const kind = answers.kind.choice === "other" ? null : (answers.kind.choice as NoteKind);
		const worthy = threeZone(answers.share_worthy) === "yes";
		// Routine progress is not news, however relevant it sounds.
		return { publish: worthy && kind !== null, kind, score: answers.share_worthy.probability };
	},
	fallback(): PublishOutcome {
		return { publish: false, kind: null, score: 0 };
	},
});

export interface DeliverInput {
	/** What the receiving bee is working on. */
	readonly focus: string;
	readonly note: string;
	readonly kind: NoteKind;
	readonly from: string;
}

export type DeliverOutcome = { readonly deliver: boolean; readonly score: number };

export const hiveDeliver = defineDecision({
	id: "hive.deliver",
	version: 1,
	// A delivered note is appended to the receiving bee's context, nothing before it changes.
	cacheImpact: "append-only",
	latency: "background",
	capabilities: "relate",
	questions: {
		useful: { type: "boolean", instructions: "Is `note` useful for the work described in `focus`?" },
	},
	buildState(input: DeliverInput) {
		return { note: input.note, focus: input.focus, note_kind: input.kind, from_worker: input.from };
	},
	policy(answers, input): DeliverOutcome {
		// A decision binds everyone, whatever they are working on. That takes no judgment.
		if (input.kind === "decision") return { deliver: true, score: 1 };
		return { deliver: threeZone(answers.useful) === "yes", score: answers.useful.probability };
	},
	fallback(): DeliverOutcome {
		return { deliver: false, score: 0 };
	},
});
