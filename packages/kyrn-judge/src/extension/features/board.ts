import { join } from "node:path";
import type {
	AgentEndEvent,
	AgentStartEvent,
	ExtensionContext,
	MessageEndEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
	addModelHelp,
	boardModelChoices,
	type ModelLike,
	otherModelChoices,
	RECOMMENDED_BOARD_MODELS,
	refOf,
	SESSION_MODEL,
} from "../../board/model.ts";
import {
	type BoardFacts,
	type BoardLanguage,
	type BoardText,
	languageOf,
	narratorRequest,
	narratorSystem,
	parseBoardText,
	plainBoard,
} from "../../board/narrate.ts";
import { BoardProjects } from "../../board/projects.ts";
import { isCheckCommand } from "../../checkpoint/mutating.ts";
import {
	type BoardEvent,
	type BoardInput,
	type BoardPhase,
	type BoardStep,
	boardRead,
	describeEvent,
	MAX_EVENTS,
	MAX_KEY,
} from "../../decisions/board-read.ts";
import { appLanguage, say } from "../../language.ts";
import type { LlmCompletion } from "../../providers/llm.ts";
import { clip, failOpen, type KyrnRuntime, textOf } from "../runtime.ts";
import { isShellTool } from "../shell-tools.ts";
import { describeCall } from "./constraints.ts";
import type { HarnessRoots } from "./inherit.ts";

/** Stored in the session, so a reopened session shows where it stood. */
export const BOARD_ENTRY = "kyrn.board";
const WIDGET_KEY = "mu-board";
/** Events kept: enough for a long run's tail, and for the news picked earlier in it. */
const MAX_LOG = 64;
/** Reading and looking up: when it went fine, nothing a person would hear about. */
const ROUTINE_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"locate",
	"find_skill",
	"find_capability",
	"bg_output",
	"web_search",
	"web_fetch",
]);

interface LoggedEvent extends BoardEvent {
	readonly sequence: number;
	/** Picked as news for a board that was written. */
	key?: boolean;
}

export interface BoardUpdate extends BoardText {
	readonly phase?: BoardPhase;
	/** The id of the acceptance item being worked on. */
	readonly focus?: string;
	/** That item's text (the user's or the model's words), so a client can say what is being worked on. */
	readonly focusText?: string;
	readonly needsUser: boolean;
	/** Acceptance items done, and in all. */
	readonly done: number;
	readonly total: number;
	/** Who wrote the words: the plain-speaking model, or the fixed sentences. */
	readonly by: "model" | "rules";
	/** Written when the agent had stopped, rather than while it worked. */
	readonly ended: boolean;
	/**
	 * What the judge picked as news, as the session has it (commands, paths, the agent's words): the plain
	 * words above are the writer's telling of these. Since the last update, or over the whole run once it ended.
	 */
	readonly news?: readonly string[];
}

export function parseBoardEntry(data: unknown): BoardUpdate | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const value = data as Record<string, unknown>;
	if (typeof value.now !== "string" || typeof value.progress !== "string") return undefined;
	return {
		progress: value.progress,
		now: value.now,
		confirm: Array.isArray(value.confirm) ? value.confirm.filter((item) => typeof item === "string") : [],
		phase: typeof value.phase === "string" ? (value.phase as BoardPhase) : undefined,
		focus: typeof value.focus === "string" ? value.focus : undefined,
		...(typeof value.focusText === "string" ? { focusText: value.focusText } : {}),
		...(Array.isArray(value.confirmCodes)
			? {
					confirmCodes: value.confirmCodes.map((code) => (typeof code === "string" ? code : null)),
				}
			: {}),
		needsUser: value.needsUser === true,
		done: typeof value.done === "number" ? value.done : 0,
		total: typeof value.total === "number" ? value.total : 0,
		by: value.by === "model" ? "model" : "rules",
		ended: value.ended === true,
		...(Array.isArray(value.news) ? { news: value.news.filter((line) => typeof line === "string") } : {}),
	};
}

/** The board above the editor of the terminal: the desktop draws its own panel from the presentation event. */
export function boardWidget(board: BoardUpdate, language: BoardLanguage): string[] {
	const zh = language === "zh";
	return [
		`${zh ? "\u03bc 看板" : "\u03bc board"} · ${board.progress}`,
		`  ${board.now}`,
		...board.confirm.map((item) => `  ${zh ? "要你确认" : "For you"}: ${item}`),
	];
}

export function describeBoard(board: BoardUpdate | undefined, language: BoardLanguage): string {
	if (!board) return language === "zh" ? "看板还没有内容：等代理做一会儿再看。" : "Nothing on the board yet.";
	const zh = language === "zh";
	const lines = [`${zh ? "进展" : "Progress"}: ${board.progress}`, `${zh ? "正在做" : "Now"}: ${board.now}`];
	if (board.confirm.length > 0) {
		lines.push(`${zh ? "需要你确认" : "Waiting on you"}:`, ...board.confirm.map((item) => `  - ${item}`));
	}
	return lines.join("\n");
}

/**
 * The plain-language board: where the work stands, in words a person who is
 * not a programmer can follow. The judge reads the session by multiple
 * choice (the phase, the acceptance item being worked on, whether the user is
 * needed, whether anything changed) every few tool calls and when the agent
 * stops; only when it sees something new does a model that explains well
 * write the board again. The board is for the person only: nothing of it
 * reaches the working model's context.
 *
 * What the writer is told is picked by the judge too: every step, item
 * ticked and thing the agent said is logged, and at each look the judge sorts
 * what happened since the last board into news and routine. When the run
 * ends, it picks again over the whole run (the news it picked before, and
 * what came after), and the board sums the run up. So the person has two
 * accounts of the same work: the agent's own, in the conversation, and the
 * board's, in plain words.
 *
 * Off by default and switched per project (`/board on`), because every
 * update costs a model call. The first time it is switched on, the person
 * picks the model that writes it (`/board model` changes it later).
 */
export function registerBoard(runtime: KyrnRuntime, roots: HarnessRoots | undefined): void {
	const options = runtime.options("board", {
		enabled: true,
		/** For projects nobody switched. Off: every update costs a model call. */
		defaultOn: false,
		/**
		 * The model that writes the board, "provider/model". Empty: the one picked with /board model (kept in
		 * <agentDir>/mu/board.json), else the writer model, else the session's.
		 */
		model: "",
		/** zh, en, or auto: the language the user writes in. */
		language: "auto",
		/** Tool calls between two looks while the agent works. */
		everyTools: 5,
		/** At least this long between two looks while the agent works. */
		minIntervalMs: 20000,
		/** Tool calls the judge sees, for what the agent is doing now. */
		maxSteps: 10,
		narrateTimeoutMs: 60000,
	});
	if (!options.enabled || process.env.KYRN_SWARM_CONTROL) return;
	const { pi } = runtime;
	const projects = new BoardProjects(roots ? join(roots.agentDir, "mu") : undefined);
	const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
	let steps: BoardStep[] = [];
	let latest = "";
	/** What happened, numbered: the candidates the judge picks the news from. */
	let events: LoggedEvent[] = [];
	let sequence = 0;
	/** The last event a written board covered. */
	let reported = 0;
	/** The last event before this run started. */
	let runStart = 0;
	/** A check ran or an item was ticked: the next look need not wait for `everyTools` more steps. */
	let moment = false;
	/** The chosen model is not usable here: said once per session. */
	let toldUnusable = false;
	let toolsSinceLook = 0;
	let lastLookAt = 0;
	let board: BoardUpdate | undefined;
	let looking: Promise<void> | undefined;
	/** A look asked for while another ran: done right after it, once. */
	let again: boolean | undefined;
	/** Bumped when the session ends or another one starts: a look still running then belongs to a session that is gone. */
	let epoch = 0;
	let retired = new AbortController();
	const retire = () => {
		epoch++;
		retired.abort();
		retired = new AbortController();
		again = undefined;
	};

	const on = (ctx: ExtensionContext) => projects.get(ctx.cwd) ?? options.defaultOn;
	/** The model named in kyrn.json, else the one the person picked: "provider/id", or "session". */
	const chosen = (): string | undefined => options.model || projects.model();
	const usable = (ctx: ExtensionContext, ref: string): boolean => {
		const slash = ref.indexOf("/");
		const model = slash > 0 ? ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
		return model !== undefined && ctx.modelRegistry.hasConfiguredAuth(model);
	};
	/** The model that writes the board now: the chosen one while it is usable, else the writer, else the conversation's. */
	const writerRef = (ctx: ExtensionContext): string | undefined => {
		const picked = chosen();
		if (picked && picked !== SESSION_MODEL && usable(ctx, picked)) return picked;
		if (picked !== SESSION_MODEL && runtime.config.writer) return runtime.config.writer;
		return ctx.model ? refOf(ctx.model) : undefined;
	};
	/** The recommended models, and which of them the person could pick right now. */
	const recommended = (ctx: ExtensionContext) => {
		const available = ctx.modelRegistry.getAvailable();
		return RECOMMENDED_BOARD_MODELS.map((model) => ({
			name: model.name,
			ref: available.map(refOf).find((ref) => model.pattern.test(ref)) ?? null,
		}));
	};
	/** For the panel: a model has to be added (the person asked how), or the chosen one cannot be used here. */
	const modelNeeded = (ctx: ExtensionContext, reason: "add" | "unusable", extra: Record<string, string> = {}) =>
		runtime.present("board.model_needed", { cwd: ctx.cwd, reason, recommended: recommended(ctx), ...extra });
	/** What this process last told the panel. */
	let shown: boolean | undefined;
	/**
	 * Tells the panel whether the board is on here, when it asks or when it changed. Another conversation on the
	 * same project may have switched it: the switch is the project's, so this one follows and says so.
	 */
	const announce = (ctx: ExtensionContext, always = false): boolean => {
		const switched = on(ctx);
		if (always || switched !== shown) {
			shown = switched;
			runtime.present("board.switched", {
				on: switched,
				cwd: ctx.cwd,
				model: writerRef(ctx) ?? null,
				modelChosen: chosen() !== undefined,
			});
			if (!always) showWidget(ctx);
		}
		return switched;
	};
	const showWidget = (ctx: ExtensionContext | undefined) => {
		if (!ctx?.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setWidget(WIDGET_KEY, board && on(ctx) ? boardWidget(board, language()) : undefined);
	};
	/** A fixed language first, then the app's (MU_LANG), then the language the user writes in. */
	const language = (): BoardLanguage => {
		if (options.language === "zh" || options.language === "en") return options.language;
		return appLanguage()?.wording ?? languageOf(`${runtime.frame?.goal ?? ""} ${runtime.turn.userMessage}`);
	};
	/** What the writer is told to write in: the app's own language when it has one mu has no wording for. */
	const writeIn = (): string | undefined =>
		options.language === "zh" || options.language === "en" ? undefined : appLanguage()?.name;

	/** The plain-speaking model. A chosen one that cannot be used here (signed out, say) is said once, then stood in for. */
	const writerModel = (ctx: ExtensionContext): LlmCompletion | undefined => {
		const picked = chosen();
		if (picked && picked !== SESSION_MODEL && !usable(ctx, picked) && !toldUnusable) {
			toldUnusable = true;
			modelNeeded(ctx, "unusable", { model: picked });
			if (ctx.hasUI) {
				ctx.ui.notify(
					words({
						zh: `看板选的模型 ${picked} 现在用不了，先用 ${writerRef(ctx) ?? "对话的模型"} 来写。/board model 可以换一个。`,
						en: `The board's model ${picked} cannot be used here, so ${writerRef(ctx) ?? "the conversation's model"} writes it for now. /board model picks another.`,
					}),
					"warning",
				);
			}
		}
		const ref = writerRef(ctx);
		return ref ? runtime.llm(ref, { thinking: "off" }) : undefined;
	};
	const words = (texts: { readonly zh: string; readonly en: string }) => (language() === "zh" ? texts.zh : texts.en);
	/** Who writes the board, in words: a model, or the conversation's own. */
	const writerName = (ctx: ExtensionContext): string => {
		const ref = writerRef(ctx);
		const picked = chosen();
		if (picked && picked !== SESSION_MODEL && ref === picked) return ref;
		return words({
			zh: `对话用的模型${ref ? `（现在是 ${ref}）` : ""}`,
			en: `the conversation's model${ref ? ` (now ${ref})` : ""}`,
		});
	};

	/**
	 * The person picks the board's model: the recommended ones first, then whatever the conversation uses,
	 * then any other they have, or how to add one. Nothing is kept when they close it or want to add one.
	 */
	const chooseModel = async (ctx: ExtensionContext): Promise<string | undefined> => {
		const available: readonly ModelLike[] = ctx.modelRegistry.getAvailable();
		const choices = boardModelChoices(available, ctx.model, language());
		const answer = await ctx.ui.select(
			words({
				zh: "人话看板请哪个模型来讲？每次更新调用它一次。",
				en: "Which model should write the plain-language board? Each update is one call to it.",
			}),
			choices.map((choice) => choice.label),
		);
		const choice = choices.find((entry) => entry.label === answer);
		if (!choice) return undefined;
		if (choice.kind === "add") {
			ctx.ui.notify(addModelHelp(language(), choice.recommended), "info");
			modelNeeded(ctx, "add", choice.recommended ? { name: choice.recommended.name } : {});
			return undefined;
		}
		let ref = choice.kind === "model" ? choice.ref : undefined;
		if (choice.kind === "other") {
			const others = otherModelChoices(available);
			const second = await ctx.ui.select(
				words({ zh: "选一个模型", en: "Pick a model" }),
				others.map((other) => other.label),
			);
			ref = others.find((other) => other.label === second)?.ref;
		}
		if (!ref) return undefined;
		projects.setModel(ref);
		return ref;
	};

	const log = (event: BoardEvent) => {
		events = [...events.slice(-(MAX_LOG - 1)), { ...event, sequence: ++sequence }];
	};
	/** Steps worth weighing: reading that went fine tells a person nothing, an item ticked or a check is a moment. */
	const record = (name: string, input: Record<string, unknown>, step: BoardStep) => {
		if (name === "todo" && !step.failed) {
			const action = String(input.action ?? "");
			const item = runtime.frame?.acceptance.find((entry) => entry.id === input.id);
			if (action === "done" && item) {
				log({
					kind: "ticked",
					text: clip(`${item.id} ${item.text}${item.evidence ? ` (${item.evidence})` : ""}`, 300),
				});
				moment = true;
			} else if (action === "add") {
				log({ kind: "step", text: clip(`added to the checklist: ${String(input.text ?? "")}`, 300) });
			}
			return;
		}
		if (!step.failed && ROUTINE_TOOLS.has(name)) return;
		log({
			kind: "step",
			text: `${name} ${step.what} -> ${step.failed ? "error" : "ok"}`,
			...(step.failed ? { failed: true } : {}),
			...(step.check ? { check: true } : {}),
		});
		if (step.check) moment = true;
	};
	/**
	 * What the judge picks the news from: what happened since the last board. Once the run ended, the news it
	 * picked earlier in this run as well, so the summing up covers the whole run and not only its tail.
	 */
	const candidates = (ended: boolean): LoggedEvent[] => {
		const earlier = ended
			? events
					.filter((event) => event.key && event.sequence > runStart && event.sequence <= reported)
					.slice(-MAX_KEY)
			: [];
		const since = ended ? Math.max(reported, runStart) : reported;
		const fresh = events.filter((event) => event.sequence > since).slice(-(MAX_EVENTS - earlier.length));
		return [...earlier, ...fresh];
	};

	const look = async (ctx: ExtensionContext, ended: boolean): Promise<void> => {
		const at = epoch;
		const gone = retired.signal;
		const upTo = sequence;
		moment = false;
		const weighed = candidates(ended);
		const frame = runtime.frame;
		const items = (frame?.acceptance ?? []).map((item) => ({ id: item.id, text: item.text, done: item.done }));
		const input: BoardInput = {
			goal: frame?.goal ?? runtime.turn.userMessage,
			items,
			steps: steps.slice(-options.maxSteps),
			latest,
			ended,
			events: weighed,
			last: board ? { phase: board.phase, focus: board.focus, now: board.now } : undefined,
		};
		const reading = (await runtime.engine.decide(boardRead, input)).outcome;
		if (at !== epoch) return;
		toolsSinceLook = 0;
		lastLookAt = Date.now();
		if (!reading.update) return;

		const focusItem = reading.focus ? items.find((item) => item.id === reading.focus) : undefined;
		const news = reading.key.flatMap((index) => (weighed[index] ? [weighed[index]] : []));
		const facts: BoardFacts = {
			language: language(),
			goal: input.goal,
			items,
			phase: reading.phase,
			focus: focusItem?.text,
			needsUser: reading.needsUser,
			// With the news picked, the last few steps are enough to say what it is doing now.
			steps: (weighed.length > 0 ? input.steps.slice(-4) : input.steps).map(
				(step) => `${step.tool} ${step.what} -> ${step.failed ? "error" : "ok"}`,
			),
			latest: clip(latest, 1200),
			...(weighed.length > 0 ? { keyEvents: news.map(describeEvent) } : {}),
			ended,
		};
		let text: BoardText | undefined;
		const complete = writerModel(ctx);
		if (complete) {
			try {
				const reply = await complete({
					system: narratorSystem(facts.language, writeIn()),
					user: narratorRequest(facts),
					signal: AbortSignal.any([AbortSignal.timeout(options.narrateTimeoutMs), gone]),
				});
				text = parseBoardText(reply.text);
			} catch {
				text = undefined;
			}
		}
		if (at !== epoch) return;
		const update: BoardUpdate = {
			...(text ?? plainBoard(facts)),
			phase: reading.phase,
			focus: reading.focus ?? undefined,
			...(focusItem ? { focusText: focusItem.text } : {}),
			needsUser: reading.needsUser,
			done: items.filter((item) => item.done).length,
			total: items.length,
			by: text ? "model" : "rules",
			ended,
			...(news.length > 0 ? { news: news.map(describeEvent) } : {}),
		};
		for (const event of news) event.key = true;
		reported = Math.max(reported, upTo);
		board = update;
		pi.appendEntry<BoardUpdate>(BOARD_ENTRY, update);
		runtime.present("board.update", update);
		showWidget(runtime.ctx ?? ctx);
	};

	/** One look at a time, in the background: the board never holds up the agent. */
	const schedule = (ctx: ExtensionContext, ended: boolean) => {
		if (looking) {
			again = (again ?? false) || ended;
			return;
		}
		looking = look(ctx, ended)
			.catch(() => undefined)
			.finally(() => {
				looking = undefined;
				const next = again;
				again = undefined;
				if (next !== undefined) schedule(runtime.ctx ?? ctx, next);
			});
	};

	pi.on(
		"session_start",
		failOpen((_event, ctx) => {
			runtime.touch(ctx);
			retire();
			board = undefined;
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "custom" && entry.customType === BOARD_ENTRY)
					board = parseBoardEntry(entry.data) ?? board;
			}
			steps = [];
			latest = "";
			events = [];
			reported = sequence;
			runStart = sequence;
			moment = false;
			toldUnusable = false;
			toolsSinceLook = 0;
			// A panel opening with the session learns whether the board is on here, and what it said last.
			const switched = announce(ctx, true);
			if (board && switched) runtime.present("board.update", { ...board, restored: true });
			showWidget(ctx);
			return undefined;
		}),
	);

	pi.on(
		"session_shutdown",
		failOpen(() => {
			retire();
			return undefined;
		}),
	);

	pi.on(
		"tool_execution_start",
		failOpen<ToolExecutionStartEvent, undefined>((event) => {
			calls.set(event.toolCallId, {
				name: event.toolName,
				input: (typeof event.args === "object" && event.args !== null ? event.args : {}) as Record<string, unknown>,
			});
			return undefined;
		}),
	);

	pi.on(
		"tool_execution_end",
		failOpen<ToolExecutionEndEvent, undefined>((event, ctx) => {
			runtime.touch(ctx);
			const call = calls.get(event.toolCallId);
			calls.delete(event.toolCallId);
			const name = call?.name ?? event.toolName;
			const input = call?.input ?? {};
			const command = isShellTool(name) ? String(input.command ?? "") : "";
			const step: BoardStep = {
				tool: name,
				what: clip(describeCall(name, input), 160),
				failed: event.isError,
				check: command !== "" && isCheckCommand(command),
			};
			steps = [...steps.slice(-(options.maxSteps * 2)), step];
			record(name, input, step);
			toolsSinceLook++;
			if (!announce(ctx)) return undefined;
			if ((toolsSinceLook >= options.everyTools || moment) && Date.now() - lastLookAt >= options.minIntervalMs) {
				schedule(ctx, false);
			}
			return undefined;
		}),
	);

	pi.on(
		"message_end",
		failOpen<MessageEndEvent, undefined>((event) => {
			if (event.message.role !== "assistant") return undefined;
			const said = textOf((event.message as { content?: unknown }).content).trim();
			if (said) {
				latest = said;
				log({ kind: "said", text: clip(said.replace(/\s+/g, " "), 300) });
			}
			return undefined;
		}),
	);

	pi.on(
		"agent_start",
		failOpen<AgentStartEvent, undefined>(() => {
			runStart = sequence;
			return undefined;
		}),
	);

	pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>((_event, ctx) => {
			runtime.touch(ctx);
			if (announce(ctx)) schedule(ctx, true);
			return undefined;
		}),
	);

	pi.registerCommand("board", {
		description: say({
			zh: "人话看板：/board 查看，/board on、/board off 为这个项目打开或关闭，/board model 换个模型来讲",
			en: "The plain-language board: /board (show it), /board on, /board off (for this project), /board model (who writes it)",
		}),
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			const [first = "", ...rest] = args.trim().split(/\s+/);
			const word = first.toLowerCase();
			const zh = language() === "zh";
			if (word === "model") {
				const ref = rest.join(" ").trim();
				if (ref) {
					if (ref !== SESSION_MODEL && !usable(ctx, ref)) {
						if (ctx.hasUI) {
							ctx.ui.notify(
								`${words({ zh: `${ref} 现在用不了。`, en: `${ref} cannot be used here.` })}\n${addModelHelp(language())}`,
								"warning",
							);
						}
						return;
					}
					projects.setModel(ref);
				} else if (!ctx.hasUI || !(await chooseModel(ctx))) {
					return;
				}
				toldUnusable = false;
				announce(ctx, true);
				if (ctx.hasUI) {
					ctx.ui.notify(
						words({
							zh: `看板现在由 ${writerName(ctx)} 来讲。`,
							en: `The board is now written by ${writerName(ctx)}.`,
						}),
						"info",
					);
				}
				return;
			}
			if (word === "on" || word === "off") {
				projects.set(ctx.cwd, word === "on");
				announce(ctx, true);
				showWidget(ctx);
				// The first time: who should speak for the board. Closing the picker leaves it to the conversation's model.
				if (word === "on" && ctx.hasUI && chosen() === undefined && (await chooseModel(ctx))) announce(ctx, true);
				if (ctx.hasUI) {
					ctx.ui.notify(
						word === "on"
							? zh
								? `这个项目的人话看板已打开：代理每做一段，就用大白话告诉你进展，由 ${writerName(ctx)} 来讲。每次更新会调用一次模型。`
								: `The plain-language board is on for this project, written by ${writerName(ctx)}. Each update costs one model call.`
							: zh
								? "这个项目的人话看板已关闭。"
								: "The plain-language board is off for this project.",
						"info",
					);
				}
				// Switched on in the middle of things: the first board need not wait for the next tool call.
				if (word === "on" && (steps.length > 0 || latest)) schedule(ctx, false);
				return;
			}
			if (!ctx.hasUI) return;
			if (!on(ctx)) {
				ctx.ui.notify(
					zh ? "这个项目没有打开人话看板。/board on 打开。" : "The board is off for this project: /board on.",
					"info",
				);
				return;
			}
			ctx.ui.notify(describeBoard(board, zh ? "zh" : "en"), "info");
		},
	});
}
