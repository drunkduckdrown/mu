import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type ApplyOutcome,
	applyPlan,
	type Change,
	type CommitPlan,
	describePlan,
	PLAN_SYSTEM,
	parsePlanReply,
	planRequest,
	readChange,
	rulePlan,
	validatePlan,
} from "../../../packs/commit.ts";
import { installHint } from "../../../packs/exec.ts";
import { gitOver, repoState } from "../../../packs/git.ts";
import type { LlmCompletion } from "../../../providers/llm.ts";
import type { KyrnRuntime } from "../../runtime.ts";
import type { PackShared } from "./pack.ts";

const TITLE = "mu /commit";

/**
 * `/commit [what to keep in mind]`: the uncommitted change, split into commits
 * a reviewer can read one at a time. A model proposes the groups and the
 * messages, the user reads the plan and says yes, and only then are the
 * commits made: all of them, or none. Nothing is ever pushed. Where there is
 * nobody to ask, the plan is shown and nothing is committed.
 */
export function registerCommit(shared: PackShared, options: { maxPlanChars: number }): void {
	const { runtime } = shared;
	runtime.pi.registerCommand("commit", {
		description:
			"Split the uncommitted change into commits: shows the plan, commits only when you say yes, never pushes",
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			const git = gitOver(shared.run);
			const repo = await repoState(git, ctx.cwd);
			if (!repo.ok) {
				const why =
					repo.reason === "no-git"
						? installHint("git", shared.platform)
						: `Not a git repository here: ${repo.message}`;
				ctx.ui.notify(why, "warning");
				return;
			}
			if (repo.inProgress) {
				ctx.ui.notify(
					`A ${repo.inProgress} is in progress. Finish or abort it first: new commits now would get in its way.`,
					"warning",
				);
				return;
			}
			const change = await readChange(git, repo.root, repo.head);
			if (change.units.length === 0) {
				ctx.ui.notify(
					change.untracked.length > 0
						? `Nothing to commit: only files git does not track (${change.untracked.slice(0, 5).join(", ")}${change.untracked.length > 5 ? ", ..." : ""}). \`git add\` the ones that belong in, then run /commit again.`
						: "Nothing to commit: the working tree matches HEAD.",
					"info",
				);
				return;
			}

			const { plan, note } = await propose(runtime, ctx, change, args.trim() || undefined, options.maxPlanChars);
			const shown = `${describePlan(change, plan)}${note ? `\n\n${note}` : ""}`;
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`${shown}\n\nNot committed: /commit asks before it commits, and there is nobody to ask here.`,
					"info",
				);
				return;
			}
			const count = plan.commits.length;
			const agreed = await ctx.ui.confirm(
				TITLE,
				`${shown}\n\nMake ${count === 1 ? "this commit" : `these ${count} commits`}? Nothing is pushed.`,
			);
			if (!agreed) {
				ctx.ui.notify("Nothing was committed.", "info");
				return;
			}
			const outcome = await applyPlan(git, repo, change, plan, ctx.signal);
			ctx.ui.notify(report(outcome), outcome.status === "done" ? "info" : "warning");
		},
	});
}

/**
 * The model's grouping, checked unit by unit. A plan that misses or repeats a
 * unit goes back once with what was wrong; after that, or without a model, one
 * commit per file.
 */
async function propose(
	runtime: KyrnRuntime,
	ctx: ExtensionCommandContext,
	change: Change,
	hint: string | undefined,
	maxChars: number,
): Promise<{ plan: CommitPlan; note?: string }> {
	const model = ctx.model;
	const complete: LlmCompletion | undefined =
		runtime.writer() ?? (model ? runtime.llm(`${model.provider}/${model.id}`, { thinking: "off" }) : undefined);
	const byRule = (why: string) => ({ plan: rulePlan(change), note: `${why}: one commit per file instead.` });
	if (!complete) return byRule("No model to propose a split");

	const request = planRequest(change, hint, maxChars);
	let user = request;
	let problem = "";
	for (let attempt = 0; attempt < 2; attempt++) {
		let reply: string;
		try {
			reply = (await complete({ system: PLAN_SYSTEM, user, signal: ctx.signal })).text;
		} catch (error) {
			return byRule(`No proposal from the model (${error instanceof Error ? error.message : String(error)})`);
		}
		const parsed = parsePlanReply(reply);
		const problems = parsed.ok ? validatePlan(parsed.plan, change.units) : [parsed.problem];
		if (parsed.ok && problems.length === 0) return { plan: parsed.plan };
		problem = problems.slice(0, 3).join("; ");
		user = `${request}\n\nYOUR LAST REPLY:\n${reply.slice(0, 4000)}\n\nIT CANNOT BE USED: ${problems.join("; ")}. Reply again with every unit in exactly one commit.`;
	}
	return byRule(`The model's proposal could not be used (${problem})`);
}

function report(outcome: ApplyOutcome): string {
	if (outcome.status === "done") {
		const count = outcome.commits.length;
		return [
			`Made ${count} commit${count === 1 ? "" : "s"}:`,
			...outcome.commits.map((commit) => `  ${commit.sha.slice(0, 9)}  ${commit.subject}`),
			"Nothing was pushed.",
		].join("\n");
	}
	const undone = outcome.undone.length;
	return [
		`Stopped at ${outcome.step}: ${outcome.reason}`,
		`Nothing of the plan remains: HEAD and the index are as they were${undone > 0 ? ` (the ${undone} commit${undone === 1 ? "" : "s"} made before the stop are only in the reflog)` : ""}. The working tree was not touched.`,
	].join("\n");
}
