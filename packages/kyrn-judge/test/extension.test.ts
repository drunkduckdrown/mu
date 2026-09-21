import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { inputPreflight } from "../src/decisions/input-preflight.ts";
import { JudgeError } from "../src/errors.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer, JudgeProvider } from "../src/types.ts";

const yes: Answer = { type: "boolean", probability: 0.95 };
const no: Answer = { type: "boolean", probability: 0.04 };

const chatVerdict: Record<string, Answer> = {
	turn_type: { type: "choice", choice: "chat_question", probabilities: { chat_question: 0.9 } },
	is_side_question: yes,
	needs_clarification: no,
	needs_files_changed: no,
	needs_memory: no,
	swarm_worthy: no,
	plan_first: no,
	task_complexity: { type: "score", score: 0.5 },
	reasoning_depth: { type: "score", score: 1 },
	tool_complexity: { type: "score", score: 0.2 },
};

function ledgerRecords(harness: Harness): LedgerRecord[] {
	const records: LedgerRecord[] = [];
	for (const entry of harness.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === "kyrn.decision") records.push(entry.data as LedgerRecord);
	}
	return records;
}

/**
 * The records of the decision these tests are about. A default session holds hidden capability packs,
 * so every message is also asked which of them it needs (`capability.disclosure`).
 */
function preflightRecords(harness: Harness): LedgerRecord[] {
	return ledgerRecords(harness).filter((record) => record.specId === inputPreflight.id);
}

describe("kyrn judge extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("judges each user message in shadow mode without changing what the model sees", async () => {
		const provider = new MockJudgeProvider(() => chatVerdict);
		const harness = await createHarness({ extensionFactories: [createKyrnJudgeExtension({ provider })] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("It refreshes the access token.")]);

		await harness.session.prompt("By the way, what does the refreshToken helper do?");
		await vi.waitFor(() => expect(preflightRecords(harness)).toHaveLength(1));

		const [record] = preflightRecords(harness);
		expect(record).toMatchObject({
			specId: "input.preflight",
			specVersion: inputPreflight.version,
			mode: "shadow",
			source: "fallback",
			reason: "shadow",
			providerId: "mock",
		});
		// First message of the session: the side-question rule overrides the judge's "yes".
		expect(record.judged).toMatchObject({ turnType: "chat_question", gear: "chat", sideQuestion: "no" });
		// Shadow mode: the outcome acted on is the stock default, not the verdict.
		expect(record.outcome).toMatchObject({ turnType: "unknown", gear: "standard" });

		const preflightCalls = provider.calls.filter((call) => "turn_type" in call.questions);
		expect(preflightCalls).toHaveLength(1);
		expect(preflightCalls[0].state).toMatchObject({
			user_message: "By the way, what does the refreshToken helper do?",
		});
		// Ledger entries live in the session file but never reach the model.
		expect(harness.session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
	});

	it("passes recent turns to the judge as short digests", async () => {
		const provider = new MockJudgeProvider(() => chatVerdict);
		const harness = await createHarness({ extensionFactories: [createKyrnJudgeExtension({ provider })] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("First answer."), fauxAssistantMessage("Second answer.")]);

		await harness.session.prompt("first question");
		await harness.session.prompt("second question");
		const preflights = () => provider.calls.filter((call) => "turn_type" in call.questions);
		await vi.waitFor(() => expect(preflights()).toHaveLength(2));

		expect(preflights()[0].state).toMatchObject({ recent_turns: [] });
		expect(preflights()[1].state).toMatchObject({
			recent_turns: ["user: first question", "assistant: First answer."],
			user_message: "second question",
		});
	});

	it("in active mode raises thinking for a heavy turn, hints at a plan, then restores the user's level", async () => {
		const heavyVerdict: Record<string, Answer> = {
			...chatVerdict,
			turn_type: { type: "choice", choice: "multi_step_task", probabilities: { multi_step_task: 0.9 } },
			needs_files_changed: yes,
			plan_first: yes,
			task_complexity: { type: "score", score: 2.8 },
		};
		const harness = await createHarness({
			models: [{ id: "faux-reasoner", reasoning: true }],
			extensionFactories: [
				createKyrnJudgeExtension({ provider: new MockJudgeProvider(() => heavyVerdict), mode: "active" }),
			],
		});
		harnesses.push(harness);
		harness.session.setThinkingLevel("low");
		let reasoningSent: string | undefined;
		let promptSeen = "";
		harness.setResponses([
			(context, options) => {
				reasoningSent = options?.reasoning;
				promptSeen = JSON.stringify(context.messages);
				return fauxAssistantMessage("Here is the plan.");
			},
		]);

		await harness.session.prompt("Rewrite the authentication module to use OAuth2 across the whole app.");

		expect(reasoningSent).toBe("high");
		expect(promptSeen).toContain("Write a short plan");
		expect(harness.session.thinkingLevel).toBe("low");
	});

	it("never blocks or breaks a prompt when the judge is down", async () => {
		const down: JudgeProvider = {
			id: "down",
			evaluate: async () => {
				throw new JudgeError("payment_required", "AI Gateway requires a valid credit card on file", {
					status: 403,
				});
			},
		};
		const harness = await createHarness({
			extensionFactories: [createKyrnJudgeExtension({ provider: down, mode: "active" })],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");
		await vi.waitFor(() => expect(preflightRecords(harness)).toHaveLength(1));

		// Every decision of the turn fell back, the one about hidden capabilities included.
		for (const record of ledgerRecords(harness)) {
			expect(record).toMatchObject({ source: "fallback", reason: "error:payment_required" });
		}
		expect(harness.session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
	});
});
