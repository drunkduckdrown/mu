import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import type { DecisionMode } from "../src/decision.ts";
import { type GoalInput, goalMet } from "../src/decisions/goal-met.ts";
import {
	describeGoal,
	GOAL_ENTRY,
	GOAL_MESSAGE,
	type GoalState,
	parseGoalEntry,
} from "../src/extension/features/goal.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";

const yes: Answer = { type: "boolean", probability: 0.97 };
const no: Answer = { type: "boolean", probability: 0.02 };
const unsure: Answer = { type: "boolean", probability: 0.55 };

describe("goal mode", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function tool(name: string): AgentTool {
		return {
			name,
			label: name,
			description: name,
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
	}

	async function start(
		responder: MockResponder,
		extra: { mode?: DecisionMode; goal?: Record<string, unknown> } = {},
	): Promise<Harness> {
		const harness = await createHarness({
			tools: [tool("edit"), tool("bash")],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(responder),
					mode: extra.mode ?? "active",
					config: parseConfig({ features: { memory: false, goal: extra.goal ?? true } }),
					only: ["preflight", "goal", "completion"],
				}),
			],
		});
		harnesses.push(harness);
		return harness;
	}

	/** Answers the goal check from a list, one per run that ends; anything else gets no answer. */
	const verdicts =
		(...list: { achieved: Answer; needs_user: Answer }[]): MockResponder =>
		(request): Record<string, Answer> =>
			"achieved" in request.questions ? (list.shift() ?? { achieved: no, needs_user: no }) : {};

	const states = (harness: Harness): GoalState[] =>
		harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === GOAL_ENTRY)
			.map((entry) => (entry as { data?: unknown }).data as GoalState);
	const sent = (harness: Harness): string[] =>
		harness.session.messages
			.filter(
				(message) => message.role === "custom" && (message as { customType?: string }).customType === GOAL_MESSAGE,
			)
			.map((message) => String((message as { content?: unknown }).content));
	const work = (name: string, input: Record<string, string>) =>
		fauxAssistantMessage([fauxToolCall(name, input)], { stopReason: "toolUse" });
	const settled = (harness: Harness, left: number) =>
		vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(left), { timeout: 5000 });

	it("reads what the harness knows before what the message claims", () => {
		const input: GoalInput = { goal: "tests pass", finalMessage: "All done.", openItems: 0, unverified: false };
		expect(goalMet.policy({ achieved: yes, needs_user: no }, input)).toBe("met");
		expect(goalMet.policy({ achieved: unsure, needs_user: no }, input)).toBe("continue");
		expect(goalMet.policy({ achieved: no, needs_user: unsure }, input)).toBe("continue");
		// An open acceptance item, or an edit nothing ran after, is "not yet" whatever the message says.
		expect(goalMet.policy({ achieved: yes, needs_user: no }, { ...input, openItems: 1 })).toBe("continue");
		expect(goalMet.policy({ achieved: yes, needs_user: no }, { ...input, unverified: true })).toBe("continue");
		// A question to the user is never answered by working on.
		expect(goalMet.policy({ achieved: no, needs_user: yes }, { ...input, openItems: 3 })).toBe("ask");
		// Without a judge the facts still count, and the rest is the user's call.
		expect(goalMet.fallback({ ...input, openItems: 2 })).toBe("continue");
		expect(goalMet.fallback({ ...input, unverified: true })).toBe("continue");
		expect(goalMet.fallback(input)).toBe("unjudged");
	});

	it("sends the agent back to work until the judge reads the goal as met", async () => {
		const harness = await start(verdicts({ achieved: no, needs_user: no }, { achieved: yes, needs_user: no }));
		harness.setResponses([
			fauxAssistantMessage("I had a first look at the failing tests."),
			work("bash", { command: "npm test" }),
			fauxAssistantMessage("Every test in packages/x passes now: 41 of 41."),
			fauxAssistantMessage("unused"),
		]);

		await harness.session.prompt("/goal every test in packages/x passes");
		await settled(harness, 1);

		expect(states(harness).map((state) => `${state.status}:${state.continuations}`)).toEqual([
			"active:0",
			"active:1",
			"met:1",
		]);
		const messages = sent(harness);
		expect(messages).toHaveLength(2);
		expect(messages[0]).toContain("every test in packages/x passes");
		expect(messages[1]).toContain("not met yet");
		expect(messages[1]).toContain("continuation 1 of 20");
	});

	it("stops by itself when the agent twice ends a run without doing anything", async () => {
		const harness = await start(verdicts());
		harness.setResponses([
			fauxAssistantMessage("I think this is fine."),
			fauxAssistantMessage("As I said, this is fine."),
			fauxAssistantMessage("unused"),
		]);

		await harness.session.prompt("/goal the importer handles empty files");
		await settled(harness, 1);

		const last = states(harness).at(-1);
		expect(last?.status).toBe("paused");
		expect(last?.reason).toContain("without doing anything");
		expect(sent(harness)).toHaveLength(2);
	});

	it("waits when the agent needs the user, and goes on with a fresh allowance once they answer", async () => {
		const harness = await start(verdicts({ achieved: no, needs_user: yes }, { achieved: yes, needs_user: no }));
		harness.setResponses([
			fauxAssistantMessage("Which database should the importer write to, Postgres or SQLite?"),
			work("bash", { command: "npm test" }),
			fauxAssistantMessage("The importer writes to Postgres and its tests pass."),
			fauxAssistantMessage("unused"),
		]);

		await harness.session.prompt("/goal the importer writes to the database");
		await settled(harness, 3);
		expect(states(harness).at(-1)).toMatchObject({ status: "paused", reason: "the agent needs something from you" });
		// Nothing was sent after the question: the agent is not told to keep going past it.
		expect(sent(harness)).toHaveLength(1);

		await harness.session.prompt("Postgres.");
		await settled(harness, 1);
		expect(states(harness).map((state) => state.status)).toEqual(["active", "paused", "active", "met"]);
	});

	it("keeps to its allowance of continuations", async () => {
		const harness = await start(verdicts(), { goal: { maxContinuations: 1 } });
		harness.setResponses([
			work("bash", { command: "npm test" }),
			fauxAssistantMessage("Three tests still fail."),
			work("bash", { command: "npm test" }),
			fauxAssistantMessage("Two tests still fail."),
			fauxAssistantMessage("unused"),
		]);

		await harness.session.prompt("/goal every test passes");
		await settled(harness, 1);

		const last = states(harness).at(-1);
		expect(last).toMatchObject({ status: "paused", continuations: 1 });
		expect(last?.reason).toContain("allowance of 1 continuations");
	});

	it("goes by the facts alone when no judge is acted on, and leaves the rest to the user", async () => {
		let asked = 0;
		const harness = await start(
			(request): Record<string, Answer> => {
				if ("achieved" in request.questions) asked++;
				return "achieved" in request.questions ? { achieved: yes, needs_user: no } : {};
			},
			{ mode: "shadow" },
		);
		harness.setResponses([
			work("edit", { path: "src/importer.ts" }),
			fauxAssistantMessage("Done, empty files are skipped now."),
			work("bash", { command: "npm test -- importer" }),
			fauxAssistantMessage("The importer tests pass."),
			fauxAssistantMessage("unused"),
		]);

		await harness.session.prompt("/goal the importer handles empty files");
		await settled(harness, 1);

		// The edit nothing ran after is a fact: back to work, with the file named. The goal check speaks alone.
		const messages = sent(harness);
		expect(messages).toHaveLength(2);
		expect(messages[1]).toContain("src/importer.ts");
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && (message as { customType?: string }).customType === "kyrn.nudge",
			),
		).toBe(false);
		// After the test ran nothing is provably unfinished, and a shadowed judge is recorded, not obeyed.
		expect(asked).toBe(2);
		const last = states(harness).at(-1);
		expect(last?.status).toBe("paused");
		expect(last?.reason).toContain("no judge");
	});

	it("shows and clears the goal, and reads back only entries it wrote", async () => {
		const harness = await start(verdicts({ achieved: yes, needs_user: no }));
		harness.setResponses([fauxAssistantMessage("The README names the flag."), fauxAssistantMessage("unused")]);
		await harness.session.prompt("/goal the README names the new flag");
		await settled(harness, 1);
		await harness.session.prompt("/goal clear");
		expect(states(harness).map((state) => state.status)).toEqual(["active", "met", "cleared"]);

		expect(parseGoalEntry({ status: "active", text: "x", continuations: 2.7 })).toEqual({
			status: "active",
			text: "x",
			reason: undefined,
			continuations: 2,
		});
		expect(parseGoalEntry({ status: "running", text: "x" })).toBeUndefined();
		expect(parseGoalEntry({ status: "active", text: "  " })).toBeUndefined();
		expect(parseGoalEntry("active")).toBeUndefined();
		expect(describeGoal(undefined)).toContain("/goal <condition>");
		expect(
			describeGoal({ status: "paused", text: "ship it", reason: "you interrupted the run", continuations: 3 }),
		).toContain("you interrupted the run");
	});
});
