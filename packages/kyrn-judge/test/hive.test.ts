import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { DecisionEngine } from "../src/decision.ts";
import { hiveDeliver, hivePublish } from "../src/decisions/hive.ts";
import { candidatesOf } from "../src/extension/features/hive.ts";
import type { SwarmRunner } from "../src/extension/features/swarm.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { Board, isDuplicate, type Note } from "../src/hive/board.ts";
import { Judge } from "../src/judge.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";

const yes: Answer = { type: "boolean", probability: 0.95 };
const no: Answer = { type: "boolean", probability: 0.04 };
const kind = (choice: string): Answer => ({ type: "choice", choice, probabilities: { [choice]: 0.9 } });
const note = (patch: Partial<Note>): Note => ({
	id: "n1",
	bee: "repro",
	kind: "finding",
	score: 0.9,
	text: "npm test -- login fails only when TZ=UTC is set",
	source: "bash",
	at: "2026-09-20T00:00:00Z",
	...patch,
});

describe("hive board", () => {
	it("hands each reader only what is new to it, and survives a torn line", () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-hive-test-"));
		const writer = new Board(dir);
		const reader = new Board(dir);

		writer.post(note({ id: "a" }));
		expect(reader.fresh().map((entry) => entry.id)).toEqual(["a"]);
		expect(reader.fresh()).toEqual([]);

		appendFileSync(join(dir, "board.jsonl"), '{"id":"torn","bee":"x"');
		expect(reader.fresh()).toEqual([]);
		appendFileSync(join(dir, "board.jsonl"), ',"kind":"finding","score":1,"text":"t","source":"s","at":""}\n');
		writer.post(note({ id: "b" }));
		expect(reader.fresh().map((entry) => entry.id)).toEqual(["torn", "b"]);
		expect(writer.all()).toHaveLength(3);
	});

	it("knows without asking that a repeated note is not news", () => {
		const known = [note({})];
		expect(isDuplicate("npm test -- login fails only when TZ=UTC is set.", known)).toBe(true);
		expect(isDuplicate("the session cookie is dropped in refresh() at src/session.ts:88", known)).toBe(false);
	});

	it("takes what a bee said and the beginning of what its tools returned as candidates", () => {
		const candidates = candidatesOf(
			{
				content: [
					{ type: "text", text: "The cookie is dropped in refresh(): it never copies the Set-Cookie header." },
					{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test -- login" } },
				],
			},
			[
				{
					toolCallId: "c1",
					toolName: "bash",
					content: [{ type: "text", text: `FAIL login.test.ts\n${"x".repeat(900)}` }],
				},
				{ toolCallId: "c2", toolName: "ls", content: [{ type: "text", text: "a.ts" }] },
			],
		);

		expect(candidates.map((candidate) => candidate.source)).toEqual(["said", 'bash {"command":"npm test -- login"}']);
		expect(candidates[1].text).toHaveLength(600);
	});
});

describe("hive gates", () => {
	const engineWith = (responder: MockResponder) =>
		new DecisionEngine({ judge: new Judge({ provider: new MockJudgeProvider(responder) }), defaultMode: "active" });

	it("publishes news, not routine progress, and delivers a decision to everyone", async () => {
		const input = { goal: "fix login", focus: "reproduce it", note: "fails only with TZ=UTC", source: "said" };
		const news = await engineWith(() => ({ share_worthy: yes, kind: kind("finding") })).decide(hivePublish, input);
		const routine = await engineWith(() => ({ share_worthy: yes, kind: kind("other") })).decide(hivePublish, input);
		const irrelevant = await engineWith(() => ({ share_worthy: no, kind: kind("finding") })).decide(
			hivePublish,
			input,
		);

		expect(news.outcome).toEqual({ publish: true, kind: "finding", score: 0.95 });
		expect(routine.outcome.publish).toBe(false);
		expect(irrelevant.outcome.publish).toBe(false);

		const deliver = { focus: "read the auth code", note: "we will not touch src/generated", from: "lead" };
		const engine = engineWith(() => ({ useful: no }));
		expect((await engine.decide(hiveDeliver, { ...deliver, kind: "decision" })).outcome.deliver).toBe(true);
		expect((await engine.decide(hiveDeliver, { ...deliver, kind: "finding" })).outcome.deliver).toBe(false);
	});
});

describe("hive in a session", () => {
	const harnesses: Harness[] = [];
	const saved = { ...process.env };
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		duringRead = () => {};
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("KYRN_HIVE_") || key.startsWith("KYRN_SWARM_")) delete process.env[key];
		}
		Object.assign(process.env, saved);
	});

	/** Set by a test to have something happen while the bee's tool runs. */
	let duringRead: () => void = () => {};
	const readTool: AgentTool = {
		name: "read",
		label: "read",
		description: "read",
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async () => {
			duringRead();
			return { content: [{ type: "text", text: "export const ok = true;" }], details: {} };
		},
	};

	/** A bee in a hive whose judge shares nothing of its own and accepts every note about TZ=UTC. */
	async function bee(dir: string, extraEnv: Record<string, string> = {}) {
		Object.assign(process.env, {
			KYRN_HIVE_DIR: dir,
			KYRN_HIVE_BEE: "auth-code",
			KYRN_HIVE_GOAL: "fix the flaky login",
			KYRN_HIVE_FOCUS: "read the session code",
			...extraEnv,
		});
		const harness = await createHarness({
			tools: [readTool],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider((request): Record<string, Answer> => {
						const state = request.state as { note?: string };
						if ("share_worthy" in request.questions) return { share_worthy: no, kind: kind("other") };
						if ("useful" in request.questions)
							return { useful: String(state.note).includes("TZ=UTC") ? yes : no };
						return {};
					}),
					mode: "active",
					config: parseConfig({ features: { memory: false, admission: false, permissions: { mode: "full" } } }),
				}),
			],
		});
		harnesses.push(harness);
		return harness;
	}

	const step = (text: string) =>
		fauxAssistantMessage([fauxText(text), fauxToolCall("read", { path: "src/session.ts" })], {
			stopReason: "toolUse",
		});

	it("inside a bee: notes are handed over at a working step, and a finished bee is not woken up again", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-hive-test-"));
		new Board(dir).post(note({ id: "from-repro" }));
		const harness = await bee(dir);
		const seen: string[] = [];
		const record = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: { messages: unknown }) => {
			seen.push(JSON.stringify(context.messages));
			return reply;
		};
		harness.setResponses([
			record(step("Reading the session code to see where the cookie is set.")),
			// The judge needs a moment; the note is in the inbox by the end of this step.
			async (context) => {
				await vi.waitFor(() => expect(new Board(dir).judged()).toBeGreaterThan(0));
				return record(step("Still reading, now the refresh path in the same file."))(context);
			},
			record(fauxAssistantMessage("**Found** - refresh() drops the cookie; it only shows when TZ=UTC.")),
		]);

		await harness.session.prompt("Investigate your angle.");

		expect(seen).toHaveLength(3);
		expect(seen[1]).not.toContain("fails only when TZ=UTC");
		expect(seen[2]).toContain("Notes from the other workers");
		expect(seen[2]).toContain("fails only when TZ=UTC");
		expect(new Board(dir).deliveries()).toEqual([{ note: "from-repro", to: "auth-code", score: 0.95 }]);
		// The report is the bee's last word: nothing arrived afterwards to make it say "Acknowledged".
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant" });
		expect(JSON.stringify(harness.session.messages.at(-1))).toContain("**Found**");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("inside a bee: a note that arrives while it writes its report gets one last call, and only one", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-hive-test-"));
		const harness = await bee(dir);
		let lastCallSeen = "";
		harness.setResponses([
			() => {
				// It lands while the report is being written: too late for a working step.
				new Board(dir).post(note({ id: "late" }));
				return fauxAssistantMessage("**Found** - refresh() drops the session cookie.");
			},
			(context) => {
				lastCallSeen = JSON.stringify(context.messages);
				new Board(dir).post(note({ id: "later", text: "also TZ=UTC breaks the date parser in src/date.ts" }));
				return fauxAssistantMessage("NO CHANGE");
			},
		]);

		await harness.session.prompt("Investigate your angle.");

		expect(lastCallSeen).toContain("Last call before your report is handed in.");
		expect(lastCallSeen).toContain("fails only when TZ=UTC");
		expect(lastCallSeen).toContain("reply with exactly: NO CHANGE");
		// The second late note found nobody: there is no third turn.
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
		expect(new Board(dir).deliveries().map((delivery) => delivery.note)).toEqual(["late"]);
	});

	it("inside any sub-agent: a wrap-up request asks for the report and closes the tools", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-hive-test-"));
		const control = join(dir, "bee-0.json");
		const harness = await bee(dir, { KYRN_SWARM_CONTROL: control });
		// The request comes in while a tool runs: the bee hears of it at the end of that step.
		duringRead = () => {
			duringRead = () => {};
			writeFileSync(control, JSON.stringify({ action: "wrap_up", reason: "time budget of 10 min reached" }));
		};
		let afterRequest = "";
		let afterBlocked = "";
		harness.setResponses([
			step("Reading the session code."),
			(context) => {
				afterRequest = JSON.stringify(context.messages);
				// A model that does not listen and reaches for a tool anyway.
				return step("One more file.");
			},
			(context) => {
				afterBlocked = JSON.stringify(context.messages);
				return fauxAssistantMessage("Report: the cookie is set in refresh(); not yet verified under TZ=UTC.");
			},
		]);

		await harness.session.prompt("Investigate your angle.");

		expect(afterRequest).toContain("Time is up. (time budget of 10 min reached.) Stop investigating now");
		expect(afterBlocked).toContain("Time is up: no more tool calls. (time budget of 10 min reached.)");
		expect(JSON.stringify(harness.session.messages.at(-1))).toContain("Report: the cookie is set in refresh()");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("inside any sub-agent: a request that lands mid-step is answered by the very next tool call", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-hive-test-"));
		const control = join(dir, "bee-0.json");
		const harness = await bee(dir, { KYRN_SWARM_CONTROL: control });
		let ran = 0;
		duringRead = () => {
			ran++;
		};
		harness.setResponses([
			() => {
				writeFileSync(control, JSON.stringify({ action: "wrap_up", reason: "stopped by the user" }));
				return step("Reading the session code.");
			},
			fauxAssistantMessage("Report: nothing established yet."),
		]);

		await harness.session.prompt("Investigate your angle.");

		expect(ran).toBe(0);
		const blocked = JSON.stringify(harness.session.messages.find((message) => message.role === "toolResult"));
		expect(blocked).toContain("Time is up: no more tool calls. (stopped by the user.)");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("inside a bee: the judge posts what the bee found and hands it what the others found", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-hive-test-"));
		new Board(dir).post(note({ id: "from-repro" }));
		new Board(dir).post(note({ id: "noise", bee: "web", text: "the project uses vitest for its unit tests" }));
		Object.assign(process.env, {
			KYRN_HIVE_DIR: dir,
			KYRN_HIVE_BEE: "auth-code",
			KYRN_HIVE_GOAL: "fix the flaky login",
			KYRN_HIVE_FOCUS: "read the session code",
		});

		const tool: AgentTool = {
			name: "read",
			label: "read",
			description: "read",
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async () => ({
				content: [{ type: "text", text: `export function refresh() {\n${"  // body\n".repeat(40)}}` }],
				details: {},
			}),
		};
		const harness = await createHarness({
			tools: [tool],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider((request): Record<string, Answer> => {
						const state = request.state as { note?: string };
						if ("share_worthy" in request.questions) {
							const news = String(state.note).includes("never copies the Set-Cookie");
							return { share_worthy: news ? yes : no, kind: kind(news ? "finding" : "other") };
						}
						if ("useful" in request.questions)
							return { useful: String(state.note).includes("TZ=UTC") ? yes : no };
						return {};
					}),
					mode: "active",
					config: parseConfig({ features: { memory: false, admission: false, permissions: { mode: "full" } } }),
				}),
			],
		});
		harnesses.push(harness);
		let second = "";
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxText("refresh() never copies the Set-Cookie header, so the session cookie is lost."),
					fauxToolCall("read", { path: "src/session.ts" }),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				second = JSON.stringify(context.messages);
				return fauxAssistantMessage("Found: the cookie is dropped in refresh().");
			},
		]);

		await harness.session.prompt("Investigate your angle.");
		await vi.waitFor(() => expect(new Board(dir).all().some((entry) => entry.bee === "auth-code")).toBe(true));

		const mine = new Board(dir).all().filter((entry) => entry.bee === "auth-code");
		expect(mine).toHaveLength(1);
		expect(mine[0]).toMatchObject({ kind: "finding", source: "said" });
		expect(mine[0].text).toContain("never copies the Set-Cookie header");
		// What the repro bee found reached this one before its next step; the irrelevant note did not.
		await vi.waitFor(() =>
			expect(new Board(dir).deliveries()).toEqual([{ note: "from-repro", to: "auth-code", score: 0.95 }]),
		);
		if (second.includes("kyrn.hive") || second.includes("TZ=UTC")) {
			expect(second).toContain("fails only when TZ=UTC");
			expect(second).not.toContain("uses vitest");
		}
	});

	it("the queen: gives every bee its angle and the others', and brings back reports plus the board", async () => {
		const calls: { instructions: string; env: Readonly<Record<string, string>>; role?: string }[] = [];
		const runner: SwarmRunner = async (task, assignment, _signal, env) => {
			calls.push({ instructions: task.instructions, env: env ?? {}, role: assignment.agent?.name });
			const board = new Board(env?.KYRN_HIVE_DIR ?? "");
			if (env?.KYRN_HIVE_BEE === "repro") {
				board.post(note({ id: "r1", bee: "repro" }));
				board.delivered({ note: "r1", to: "history", score: 0.9 });
			}
			return `${task.title}: done`;
		};
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					mode: "active",
					config: parseConfig({ features: { memory: false, permissions: { mode: "full" } } }),
					swarmRunner: runner,
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("hive", {
						goal: "Login is flaky in CI only.",
						bees: [
							{ name: "repro", focus: "Reproduce the failure locally" },
							{ name: "history", focus: "Find the commit that introduced it", agent: "scout" },
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("It is the timezone."),
		]);

		await harness.session.prompt("Why is login flaky?");

		expect(calls.map((call) => [call.env.KYRN_HIVE_BEE, call.role])).toEqual([
			["repro", "investigator"],
			["history", "scout"],
		]);
		expect(calls[0].env.KYRN_HIVE_DIR).toBe(calls[1].env.KYRN_HIVE_DIR);
		expect(calls[0].instructions).toContain("Your angle: Reproduce the failure locally");
		expect(calls[0].instructions).toContain("- history: Find the commit that introduced it");
		const result = JSON.stringify(harness.session.messages.find((message) => message.role === "toolResult"));
		expect(result).toContain("repro: done");
		expect(result).toContain("1 notes passed the judge, 1 deliveries");
		expect(result).toContain("repro -> history");
		expect(result).toContain("TZ=UTC");
	});
});
