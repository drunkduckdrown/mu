import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Lesson, memoryCapture, memoryRecall } from "../../decisions/memory.ts";
import { clip, failOpen, type KyrnRuntime } from "../runtime.ts";

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
	const options = runtime.options("memory", { enabled: true, path: "", maxCandidates: 24, maxInjected: 5 });
	if (!options.enabled) return;
	const { pi } = runtime;
	const path = options.path || join(getAgentDir(), "mu", "lessons.jsonl");

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
					userMessage: clip(event.text, 400),
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
			if (runtime.turn.preflight?.needsMemory === "no") return undefined;
			const lessons = readLessons(path)
				.filter((lesson) => lesson.cwd === undefined || lesson.cwd === ctx.cwd)
				.slice(-options.maxCandidates);
			if (lessons.length === 0) return undefined;

			runtime.progress("checking lessons from earlier sessions");
			const decision = await runtime.engine.decide(
				memoryRecall,
				{ userMessage: clip(event.prompt, 400), lessons },
				{ signal: ctx.signal },
			);
			if (decision.source !== "judge" || decision.outcome.apply.length === 0) return undefined;
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
		description: "Store a lesson for future sessions in this project: /remember <what to do>",
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
