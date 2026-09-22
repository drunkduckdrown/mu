import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { languageOf, narratorRequest, narratorSystem, parseBoardText, plainBoard } from "../src/board/narrate.ts";
import { BoardProjects } from "../src/board/projects.ts";
import { parseConfig } from "../src/config.ts";
import {
	asksSomething,
	type BoardInput,
	type BoardReading,
	type BoardStep,
	boardRead,
	phaseByRule,
} from "../src/decisions/board-read.ts";
import {
	BOARD_ENTRY,
	type BoardUpdate,
	boardWidget,
	describeBoard,
	parseBoardEntry,
} from "../src/extension/features/board.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";

const yes: Answer = { type: "boolean", probability: 0.96 };
const no: Answer = { type: "boolean", probability: 0.03 };
const unsure: Answer = { type: "boolean", probability: 0.5 };
const choice = (option: string): Answer => ({ type: "choice", choice: option, probabilities: { [option]: 0.9 } });

const step = (tool: string, what: string, failed = false, check = false): BoardStep => ({ tool, what, failed, check });
const input = (extra: Partial<BoardInput> = {}): BoardInput => ({
	goal: "the importer skips empty files",
	items: [],
	steps: [],
	latest: "",
	ended: false,
	...extra,
});

const temporary: string[] = [];
afterEach(() => {
	while (temporary.length > 0) rmSync(temporary.pop() as string, { recursive: true, force: true });
});

describe("board reading", () => {
	it("tells the phase by rule from the last step, or from how the run ended", () => {
		expect(phaseByRule(input())).toBe("understanding");
		expect(phaseByRule(input({ steps: [step("read", "src/a.ts")] }))).toBe("understanding");
		expect(phaseByRule(input({ steps: [step("edit", "src/a.ts")] }))).toBe("changing");
		expect(phaseByRule(input({ steps: [step("bash", "npm test", false, true)] }))).toBe("checking");
		expect(phaseByRule(input({ steps: [step("bash", "npm test", true, true)] }))).toBe("fixing");
		// An edit after a failed check is the fix.
		expect(phaseByRule(input({ steps: [step("bash", "npm test", true, true), step("edit", "src/a.ts")] }))).toBe(
			"fixing",
		);
		expect(phaseByRule(input({ ended: true, latest: "Postgres or SQLite？" }))).toBe("waiting");
		expect(phaseByRule(input({ ended: true, latest: "Done: the importer skips empty files." }))).toBe("wrapping_up");
		expect(asksSomething("Which one?  ")).toBe(true);
		expect(asksSomething("用哪个？")).toBe(true);
		expect(asksSomething("It works.")).toBe(false);
	});

	it("asks about the focus only among several open items, and about change only after a first board", () => {
		const one = boardRead.questionsFor?.(input({ items: [{ id: "A1", text: "skips empty files", done: false }] }));
		expect(Object.keys(one ?? {}).sort()).toEqual(["needs_user", "phase"]);
		const many = boardRead.questionsFor?.(
			input({
				items: [
					{ id: "A1", text: "skips empty files", done: false },
					{ id: "A2", text: "logs a warning", done: false },
					{ id: "A3", text: "has a test", done: true },
				],
				last: { phase: "changing", now: "Changing the code." },
			}),
		);
		expect(Object.keys(many ?? {}).sort()).toEqual(["changed", "focus", "needs_user", "phase"]);
		const focus = many?.focus;
		expect(focus?.type === "choice" ? Object.keys(focus.criteria) : []).toEqual(["A1", "A2", "none"]);
	});

	it("writes the board again only when something changed, and always when the user is needed", () => {
		const last = { phase: "changing" as const, focus: "A1", now: "Changing the code." };
		const items = [
			{ id: "A1", text: "skips empty files", done: false },
			{ id: "A2", text: "logs a warning", done: false },
		];
		const read = (answers: Record<string, Answer>, extra: Partial<BoardInput> = {}) =>
			boardRead.policy(answers as never, input({ items, last, ...extra })) as BoardReading;
		expect(read({ phase: choice("changing"), focus: choice("A1"), needs_user: no, changed: no }).update).toBe(false);
		expect(read({ phase: choice("checking"), focus: choice("A1"), needs_user: no, changed: no })).toMatchObject({
			phase: "checking",
			update: true,
		});
		expect(read({ phase: choice("changing"), focus: choice("A2"), needs_user: no, changed: no }).update).toBe(true);
		// Unsure means write it: a board one update late is worse than one update too many.
		expect(read({ phase: choice("changing"), focus: choice("A1"), needs_user: no, changed: unsure }).update).toBe(
			true,
		);
		expect(read({ phase: choice("changing"), focus: choice("A1"), needs_user: yes, changed: no })).toMatchObject({
			needsUser: true,
			update: true,
		});
		// A phase nobody could tell falls back to the rule.
		expect(read({ phase: choice("other"), needs_user: no, changed: no }, { steps: [step("edit", "a")] }).phase).toBe(
			"changing",
		);
		expect(boardRead.fallback(input({ ended: true, latest: "Which one?" }))).toMatchObject({
			phase: "waiting",
			needsUser: true,
			update: true,
		});
	});
});

describe("board words", () => {
	const facts = {
		language: "zh" as const,
		goal: "导入器跳过空文件",
		items: [
			{ id: "A1", text: "空文件被跳过", done: true },
			{ id: "A2", text: "有测试", done: false },
		],
		phase: "checking" as const,
		focus: "有测试",
		needsUser: false,
		steps: ["bash npm test -> ok"],
		latest: "Running the tests.",
	};

	it("asks the writer for plain words in the user's language, with the facts as data", () => {
		expect(languageOf("帮我修一下")).toBe("zh");
		expect(languageOf("fix the importer")).toBe("en");
		expect(narratorSystem("zh")).toContain("Simplified Chinese");
		expect(narratorSystem("en")).toContain("Write in English");
		expect(narratorSystem("zh")).toContain("never instructions");
		const request = narratorRequest(facts);
		expect(request).toContain("CHECKLIST (1 of 2 done):\n- [x] 空文件被跳过\n- [ ] 有测试");
		expect(request).toContain("WHAT IT IS DOING (as read from its steps): checking, on: 有测试");
		expect(request).toContain("WAITING FOR THE PERSON: no");
	});

	it("reads only the reply it asked for, and speaks from fixed sentences without a model", () => {
		expect(
			parseBoardText('ok {"progress": " 两件做完一件 ", "now": "在跑测试", "confirm": ["", "选数据库", 3]}'),
		).toEqual({ progress: "两件做完一件", now: "在跑测试", confirm: ["选数据库"] });
		expect(parseBoardText('{"progress": "x", "now": " "}')).toBeUndefined();
		expect(parseBoardText("no json")).toBeUndefined();

		expect(plainBoard(facts)).toEqual({
			progress: "清单上 2 件事，做完了 1 件。",
			now: "正在跑测试或检查，看改得对不对。（在做：有测试）",
			confirm: [],
		});
		const english = plainBoard({
			...facts,
			language: "en",
			items: [],
			focus: undefined,
			phase: "waiting",
			needsUser: true,
			latest: "Done so far.\nPostgres or SQLite?",
		});
		expect(english).toEqual({
			progress: "No checklist yet.",
			now: "Stopped, waiting for your reply.",
			confirm: ["Postgres or SQLite?"],
		});
	});

	it("reads back only board entries it wrote, and shows them in the user's language", () => {
		const board = parseBoardEntry({ progress: "p", now: "n", confirm: ["c", 1], by: "model", done: 1, total: 2 });
		expect(board).toMatchObject({ progress: "p", now: "n", confirm: ["c"], by: "model", needsUser: false });
		expect(parseBoardEntry({ now: "n" })).toBeUndefined();
		expect(describeBoard(board, "zh")).toBe("进展: p\n正在做: n\n需要你确认:\n  - c");
		expect(describeBoard(undefined, "en")).toContain("Nothing on the board yet");
		// Greek mu, U+03BC, never the micro sign.
		expect(boardWidget(board as BoardUpdate, "zh")).toEqual(["\u03bc 看板 · p", "  n", "  要你确认: c"]);
		expect(boardWidget(board as BoardUpdate, "zh")[0].codePointAt(0)).toBe(0x3bc);
	});
});

describe("board switches", () => {
	it("keeps each project's switch in the user's own folder, and in memory without one", () => {
		const memory = new BoardProjects(undefined);
		expect(memory.get("/p")).toBeUndefined();
		memory.set("/p", true);
		expect(memory.get("/p/")).toBe(true);

		const dir = mkdtempSync(join(tmpdir(), "mu-board-"));
		temporary.push(dir);
		const store = new BoardProjects(dir);
		store.set("/p", true);
		store.set("/q", false);
		expect(new BoardProjects(dir).get("/p")).toBe(true);
		expect(new BoardProjects(dir).get("/q")).toBe(false);
		expect(JSON.parse(readFileSync(join(dir, "board.json"), "utf8"))).toEqual({
			version: 1,
			projects: { "/p": true, "/q": false },
		});
		if (process.platform !== "win32") expect(statSync(join(dir, "board.json")).mode & 0o777).toBe(0o600);
		writeFileSync(join(dir, "board.json"), "{broken");
		expect(new BoardProjects(dir).get("/p")).toBeUndefined();
	});
});

describe("board feature", () => {
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

	const WRITER = "You tell a person who is not a programmer";
	/**
	 * The board writes in the background, so its model call can come between two of the agent's.
	 * Every queued step routes by who is asking: the writer gets the next writer reply, the agent the next of its own.
	 */
	function router(agent: AssistantMessage[], writer: string[], asked: string[]): FauxResponseFactory {
		return (context) => {
			const request = JSON.stringify(context.messages);
			if (request.includes(WRITER)) {
				asked.push(request);
				return fauxAssistantMessage(writer.shift() ?? "no more writer replies");
			}
			return agent.shift() ?? fauxAssistantMessage("no more agent replies");
		};
	}

	async function start(
		responder: MockResponder,
		board: Record<string, unknown> = {},
		agentDir?: string,
	): Promise<{ harness: Harness; events: KyrnPresentationEvent[]; notes: string[] }> {
		const events: KyrnPresentationEvent[] = [];
		const harness = await createHarness({
			tools: [tool("edit"), tool("bash"), tool("read")],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(responder),
					mode: "active",
					config: parseConfig({ features: { memory: false, board: { minIntervalMs: 0, ...board } } }),
					only: ["preflight", "board"],
					onPresentation: (event) => events.push(event),
					...(agentDir ? { roots: { home: agentDir, agentDir } } : {}),
				}),
			],
		});
		harnesses.push(harness);
		const notes: string[] = [];
		const known: Record<string, unknown> = {
			notify: (message: string) => notes.push(message),
			setStatus: () => undefined,
		};
		const ui = new Proxy(known, {
			get: (target, key) => (key in target ? target[key as string] : () => undefined),
		}) as unknown as ExtensionUIContext;
		await harness.session.bindExtensions({ uiContext: ui, mode: "rpc" });
		return { harness, events, notes };
	}

	const boards = (harness: Harness): BoardUpdate[] =>
		harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === BOARD_ENTRY)
			.map((entry) => (entry as { data?: unknown }).data as BoardUpdate);
	const work = (name: string, args: Record<string, string>) =>
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
	/** Answers the board's questions; anything else gets no answer. */
	const reading =
		(answers: () => Record<string, Answer>, count?: { reads: number }): MockResponder =>
		(request): Record<string, Answer> => {
			if (!("phase" in request.questions)) return {};
			if (count) count.reads++;
			return answers();
		};

	it("stays silent in a project nobody switched on", async () => {
		const count = { reads: 0 };
		const { harness, events } = await start(reading(() => ({ phase: choice("changing"), needs_user: no }), count));
		const agent = [
			work("edit", { path: "a.ts" }),
			work("bash", { command: "npm test" }),
			fauxAssistantMessage("Done."),
		];
		harness.setResponses(Array.from({ length: 6 }, () => router(agent, [], [])));
		await harness.session.prompt("Make the importer skip empty files.");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(count.reads).toBe(0);
		expect(boards(harness)).toEqual([]);
		// All it ever says is that it is off here, when the session opens.
		expect(events.filter((event) => event.kind.startsWith("board.")).map((event) => event.payload)).toEqual([
			{ on: false, cwd: harness.tempDir },
		]);
	});

	it("once switched on, looks while the agent works and when it stops, and has the writer speak plainly", async () => {
		const count = { reads: 0 };
		const phases = [choice("changing"), choice("checking"), choice("wrapping_up")];
		const { harness, events, notes } = await start(
			reading(() => ({ phase: phases.shift() ?? choice("other"), needs_user: no, changed: yes }), count),
			{ everyTools: 2 },
		);
		await harness.session.prompt("/board on");
		expect(events.filter((event) => event.kind === "board.switched").at(-1)?.payload).toMatchObject({ on: true });
		expect(notes.at(-1)).toContain("Each update costs one model call");

		const asked: string[] = [];
		const agent = [
			work("read", { path: "src/importer.ts" }),
			work("edit", { path: "src/importer.ts" }),
			work("bash", { command: "npm test -- importer" }),
			fauxAssistantMessage("The importer skips empty files and its tests pass."),
		];
		const writer = [
			JSON.stringify({ progress: "Halfway.", now: "It changed the importer.", confirm: [] }),
			JSON.stringify({ progress: "Done.", now: "It finished and checked its work.", confirm: [] }),
		];
		harness.setResponses(Array.from({ length: 10 }, () => router(agent, writer, asked)));
		await harness.session.prompt("Make the importer skip empty files.");
		await vi.waitFor(() => expect(boards(harness)).toHaveLength(2), { timeout: 5000 });

		const [during, after] = boards(harness);
		expect(during).toMatchObject({ now: "It changed the importer.", phase: "changing", by: "model", ended: false });
		expect(after).toMatchObject({ now: "It finished and checked its work.", by: "model", ended: true });
		// The writer read the steps and what the agent said, in the user's language.
		expect(asked[0]).toContain("edit src/importer.ts -> ok");
		expect(asked.at(-1)).toContain("The importer skips empty files and its tests pass.");
		expect(asked.at(-1)).toContain("Write in English");
		expect(events.filter((event) => event.kind === "board.update")).toHaveLength(2);
		// Nothing of the board reached the agent.
		expect(JSON.stringify(harness.session.messages)).not.toContain("It changed the importer.");

		await harness.session.prompt("/board");
		expect(notes.at(-1)).toContain("Now: It finished and checked its work.");
	});

	it("names what waits on the user, and speaks from fixed sentences when the writer does not answer as asked", async () => {
		const { harness } = await start(reading(() => ({ phase: choice("waiting"), needs_user: yes, changed: yes })));
		await harness.session.prompt("/board on");
		const agent = [work("read", { path: "db.ts" }), fauxAssistantMessage("用 Postgres 还是 SQLite？")];
		harness.setResponses(Array.from({ length: 6 }, () => router(agent, ["I would rather not."], [])));
		await harness.session.prompt("导入器要写进数据库");
		await vi.waitFor(() => expect(boards(harness)).toHaveLength(1), { timeout: 5000 });
		expect(boards(harness)[0]).toMatchObject({
			by: "rules",
			needsUser: true,
			now: "停下来了，在等你回复。",
			confirm: ["用 Postgres 还是 SQLite？"],
		});
	});

	it("skips the writer when the judge sees nothing new, and stops when switched off", async () => {
		const count = { reads: 0 };
		const { harness } = await start(
			reading(() => ({ phase: choice("changing"), needs_user: no, changed: no }), count),
			{ everyTools: 1 },
		);
		await harness.session.prompt("/board on");
		const asked: string[] = [];
		const agent = [
			work("edit", { path: "a.ts" }),
			work("edit", { path: "b.ts" }),
			work("edit", { path: "c.ts" }),
			fauxAssistantMessage("Edited three files, nothing run yet."),
		];
		const writer = [JSON.stringify({ progress: "Started.", now: "Changing files.", confirm: [] })];
		harness.setResponses(Array.from({ length: 10 }, () => router(agent, writer, asked)));
		await harness.session.prompt("Rename the helper everywhere.");
		await vi.waitFor(() => expect(count.reads).toBeGreaterThanOrEqual(2), { timeout: 5000 });
		await new Promise((resolve) => setTimeout(resolve, 100));
		// The first look writes the board; the rest saw the same phase and nothing new.
		expect(boards(harness)).toHaveLength(1);
		expect(asked).toHaveLength(1);

		await harness.session.prompt("/board off");
		const before = count.reads;
		const more = [work("edit", { path: "d.ts" }), fauxAssistantMessage("One more.")];
		harness.setResponses(Array.from({ length: 4 }, () => router(more, [], [])));
		await harness.session.prompt("And d.ts.");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(count.reads).toBe(before);
	});

	it("writes in the app's language when the desktop says which, even one mu has no wording for", async () => {
		vi.stubEnv("MU_LANG", "ja-JP");
		const { harness } = await start(reading(() => ({ phase: choice("changing"), needs_user: no, changed: yes })));
		await harness.session.prompt("/board on");
		const asked: string[] = [];
		const agent = [work("edit", { path: "a.ts" }), fauxAssistantMessage("Edited a.ts.")];
		harness.setResponses(
			Array.from({ length: 6 }, () =>
				router(agent, [JSON.stringify({ progress: "半分", now: "a.ts を変更", confirm: [] })], asked),
			),
		);
		await harness.session.prompt("Change a.ts.");
		await vi.waitFor(() => expect(boards(harness)).toHaveLength(1), { timeout: 5000 });
		expect(asked[0]).toContain("Write in Japanese.");
		expect(boards(harness)[0]).toMatchObject({ now: "a.ts を変更", by: "model" });
	});

	it("a reopened session shows the last board again, marked as restored", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-board-reopen-"));
		try {
			const { harness, events } = await start(
				reading(() => ({ phase: choice("changing"), needs_user: no, changed: yes })),
				{},
				dir,
			);
			await harness.session.prompt("/board on");
			const agent = [work("edit", { path: "a.ts" }), fauxAssistantMessage("Edited a.ts.")];
			const writer = [JSON.stringify({ progress: "Halfway.", now: "It changed a.ts.", confirm: [] })];
			harness.setResponses(Array.from({ length: 6 }, () => router(agent, writer, [])));
			await harness.session.prompt("Change a.ts.");
			await vi.waitFor(() => expect(boards(harness)).toHaveLength(1), { timeout: 5000 });
			expect(events.filter((event) => event.kind === "board.update").at(-1)?.payload).not.toHaveProperty("restored");

			events.length = 0;
			await harness.session.reload();
			expect(events.find((event) => event.kind === "board.switched")?.payload).toEqual({
				on: true,
				cwd: harness.tempDir,
			});
			expect(events.find((event) => event.kind === "board.update")?.payload).toMatchObject({
				now: "It changed a.ts.",
				by: "model",
				restored: true,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("follows a switch made in another conversation on the same project, and tells its own panel", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-board-other-"));
		try {
			const count = { reads: 0 };
			const { harness, events } = await start(
				reading(() => ({ phase: choice("changing"), needs_user: no, changed: no }), count),
				{},
				dir,
			);
			const switches = () => events.filter((event) => event.kind === "board.switched").map((event) => event.payload);
			expect(switches()).toEqual([{ on: false, cwd: harness.tempDir }]);
			// The other conversation's /board on, through the same file.
			new BoardProjects(join(dir, "mu")).set(harness.tempDir, true);
			const agent = [
				work("edit", { path: "a.ts" }),
				work("edit", { path: "b.ts" }),
				fauxAssistantMessage("Edited."),
			];
			harness.setResponses(Array.from({ length: 6 }, () => router(agent, [], [])));
			await harness.session.prompt("Change a.ts and b.ts.");
			await vi.waitFor(() => expect(count.reads).toBeGreaterThan(0), { timeout: 5000 });
			// Said once, when it changed; not again on every step.
			expect(switches()).toEqual([
				{ on: false, cwd: harness.tempDir },
				{ on: true, cwd: harness.tempDir },
			]);

			new BoardProjects(join(dir, "mu")).set(harness.tempDir, false);
			const more = [work("edit", { path: "c.ts" }), fauxAssistantMessage("One more.")];
			harness.setResponses(Array.from({ length: 4 }, () => router(more, [], [])));
			await harness.session.prompt("And c.ts.");
			expect(switches().at(-1)).toEqual({ on: false, cwd: harness.tempDir });
			expect(switches()).toHaveLength(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("drops a look still running when the session ends, and cancels its writer", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const count = { reads: 0 };
		const { harness, events } = await start(async (request): Promise<Record<string, Answer>> => {
			if (!("phase" in request.questions)) return {};
			count.reads++;
			await gate;
			return { phase: choice("changing"), needs_user: no, changed: yes };
		});
		await harness.session.prompt("/board on");
		const asked: string[] = [];
		const agent = [work("edit", { path: "a.ts" }), fauxAssistantMessage("Edited a.ts.")];
		const writer = [JSON.stringify({ progress: "Halfway.", now: "It changed a.ts.", confirm: [] })];
		harness.setResponses(Array.from({ length: 6 }, () => router(agent, writer, asked)));
		await harness.session.prompt("Change a.ts.");
		await vi.waitFor(() => expect(count.reads).toBe(1), { timeout: 5000 });

		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		release();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(boards(harness)).toEqual([]);
		expect(events.some((event) => event.kind === "board.update")).toBe(false);
		expect(asked).toEqual([]);
	});
});
