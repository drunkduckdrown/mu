import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Lesson, memoryCapture, memoryRecall } from "../../decisions/memory.ts";
import { say } from "../../language.ts";
import { clip, failOpen, type KyrnRuntime, userWords } from "../runtime.ts";

export interface StoredLesson extends Lesson {
	/** Project the lesson came from; undefined for lessons that apply everywhere. */
	readonly cwd?: string;
	readonly created: string;
}

export function readLessons(path: string): StoredLesson[] {
	let text = "";
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const lessons: StoredLesson[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as StoredLesson;
			if (typeof parsed.id === "string" && typeof parsed.lesson === "string" && typeof parsed.trigger === "string") {
				lessons.push(parsed);
			}
		} catch {
			// One corrupt line must not cost the rest of the store.
		}
	}
	return lessons;
}

function appendLesson(path: string, lesson: StoredLesson): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(lesson)}\n`);
}

const WRITER_PROMPT = `You turn a user's correction into one reusable lesson for a coding agent.
Reply with one JSON object and nothing else: {"trigger": "<the situation in which the lesson applies, one short sentence>", "lesson": "<what to do, one imperative sentence>"}`;

/**
 * A5 + D2, the agent's experience. Storage is built for minimal injection:
 * each lesson carries a trigger the judge can match against a new request,
 * and a hit costs one line of context.
 *
 * Writing is generative, which a judge cannot do: the judge only decides
 * whether a message is worth keeping, and the configured writer model phrases
 * it. Without a writer the user's own words are kept.
 */
export function registerMemory(runtime: KyrnRuntime): void {
	const options = runtime.options("memory", {
		enabled: true,
		path: "",
		maxCandidates: 24,
		maxInjected: 5,
		/** How long the turn waits for the recall verdict, counted from the arrival of the message. */
		waitMs: 4000,
	});
	if (!options.enabled) return;
	const { pi } = runtime;
	const path = options.path || join(getAgentDir(), "mu", "lessons.jsonl");

	const candidates = (cwd: string): StoredLesson[] =>
		readLessons(path)
			.filter((lesson) => lesson.cwd === undefined || lesson.cwd === cwd)
			.slice(-options.maxCandidates);
	const recall = (words: string, lessons: readonly StoredLesson[], signal?: AbortSignal) =>
		runtime.engine.decide(memoryRecall, { userMessage: clip(words, 400), lessons }, { signal });
	/** The recall asked the moment the message arrived, alongside preflight. */
	let early: { turn: number; lessons: StoredLesson[]; decision: ReturnType<typeof recall> } | undefined;
	runtime.atTurnStart((words) => {
		const cwd = runtime.ctx?.cwd;
		if (!cwd || runtime.mode(memoryRecall.id) === "off") return;
		const lessons = candidates(cwd);
		if (lessons.length === 0) return;
		const decision = recall(words, lessons);
		decision.catch(() => {});
		early = { turn: runtime.userTurns, lessons, decision };
	});

	const store = async (userMessage: string, previousAssistantMessage: string, cwd: string): Promise<void> => {
		let trigger = clip(userMessage, 200);
		let lesson = clip(userMessage, 300);
		const writer = runtime.writer();
		if (writer) {
			try {
				const reply = await writer({
					system: WRITER_PROMPT,
					user: `Assistant said:\n${clip(previousAssistantMessage, 600)}\n\nUser replied:\n${clip(userMessage, 600)}`,
				});
				const parsed = JSON.parse(reply.text.slice(reply.text.indexOf("{"), reply.text.lastIndexOf("}") + 1)) as {
					trigger?: unknown;
					lesson?: unknown;
				};
				if (typeof parsed.trigger === "string" && typeof parsed.lesson === "string") {
					trigger = clip(parsed.trigger, 200);
					lesson = clip(parsed.lesson, 300);
				}
			} catch {
				// Keep the user's own words.
			}
		}
		const stored = { id: randomUUID(), trigger, lesson, cwd, created: new Date().toISOString() };
		appendLesson(path, stored);
		runtime.present("memory.stored", stored);
	};

	pi.on(
		"input",
		failOpen((event, ctx) => {
			runtime.touch(ctx);
			if (event.source === "extension" || event.streamingBehavior || !event.text.trim()) return undefined;
			const previous = runtime.lastAssistantText;
			if (!previous) return undefined;
			void runtime.engine
				.decide(memoryCapture, {
					userMessage: clip(userWords(event.text), 400),
					previousAssistantMessage: clip(previous, 400),
				})
				.then((decision) => {
					if (decision.source === "judge" && decision.outcome === "capture")
						return store(event.text, previous, ctx.cwd);
					return undefined;
				})
				.catch(() => {});
			return undefined;
		}),
	);

	pi.on(
		"before_agent_start",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			const started = early?.turn === runtime.userTurns ? early : undefined;
			early = undefined;
			if (runtime.turn.preflight?.needsMemory === "no") return undefined;
			const lessons = started?.lessons ?? candidates(ctx.cwd);
			if (lessons.length === 0) return undefined;
			const pending = started?.decision ?? recall(userWords(event.prompt), lessons, ctx.signal);
			// Shadow records the verdict; only an active one is worth holding the turn for.
			if (runtime.mode(memoryRecall.id) !== "active") {
				void pending.catch(() => {});
				return undefined;
			}

			runtime.progress("checking lessons from earlier sessions", "lessons");
			const decision = await runtime.untilTurnDeadline(pending, options.waitMs);
			if (!decision || decision.source !== "judge" || decision.outcome.apply.length === 0) return undefined;
			const lines = lessons
				.filter((lesson) => decision.outcome.apply.includes(lesson.id))
				.slice(-options.maxInjected)
				.map((lesson) => `- ${lesson.lesson}`);
			return {
				message: {
					customType: "kyrn.lessons",
					content: `Lessons from earlier sessions that apply here:\n${lines.join("\n")}`,
					display: true,
				},
			};
		}),
	);

	pi.registerCommand("remember", {
		description: say({
			zh: "给这个项目记一条经验，以后的会话都会用上：/remember <该怎么做>",
			en: "Store a lesson for future sessions in this project: /remember <what to do>",
		}),
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				const known = readLessons(path).filter((lesson) => lesson.cwd === undefined || lesson.cwd === ctx.cwd);
				ctx.ui.notify(
					known.length === 0
						? "No lessons stored for this project."
						: known.map((lesson) => `- ${lesson.lesson}`).join("\n"),
					"info",
				);
				return;
			}
			const stored = {
				id: randomUUID(),
				trigger: clip(text, 200),
				lesson: clip(text, 300),
				cwd: ctx.cwd,
				created: new Date().toISOString(),
			};
			appendLesson(path, stored);
			runtime.present("memory.stored", stored);
			ctx.ui.notify("Stored.", "info");
		},
	});
}
