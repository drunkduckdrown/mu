import { join } from "node:path";
import type {
	AgentEndEvent,
	ExtensionContext,
	MessageEndEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
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
import { type BoardInput, type BoardPhase, type BoardStep, boardRead } from "../../decisions/board-read.ts";
import type { LlmCompletion } from "../../providers/llm.ts";
import { clip, failOpen, type KyrnRuntime, textOf } from "../runtime.ts";
import { isShellTool } from "../shell-tools.ts";
import { describeCall } from "./constraints.ts";
import type { HarnessRoots } from "./inherit.ts";

/** Stored in the session, so a reopened session shows where it stood. */
export const BOARD_ENTRY = "kyrn.board";

export interface BoardUpdate extends BoardText {
	readonly phase?: BoardPhase;
	/** The id of the acceptance item being worked on. */
	readonly focus?: string;
	readonly needsUser: boolean;
	/** Acceptance items done, and in all. */
	readonly done: number;
	readonly total: number;
	/** Who wrote the words: the plain-speaking model, or the fixed sentences. */
	readonly by: "model" | "rules";
	/** Written when the agent had stopped, rather than while it worked. */
	readonly ended: boolean;
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
		needsUser: value.needsUser === true,
		done: typeof value.done === "number" ? value.done : 0,
		total: typeof value.total === "number" ? value.total : 0,
		by: value.by === "model" ? "model" : "rules",
		ended: value.ended === true,
	};
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
 * Off by default and switched per project (`/board on`), because every
 * update costs a model call.
 */
export function registerBoard(runtime: KyrnRuntime, roots: HarnessRoots | undefined): void {
	const options = runtime.options("board", {
		enabled: true,
		/** For projects nobody switched. Off: every update costs a model call. */
		defaultOn: false,
		/** The model that writes the board, "provider/model"; empty: the writer model, else the session's. */
		model: "",
		/** zh, en, or auto: the language the user writes in. */
		language: "auto",
		/** Tool calls between two looks while the agent works. */
		everyTools: 5,
		/** At least this long between two looks while the agent works. */
		minIntervalMs: 20000,
		/** Tool calls the judge and the writer see. */
		maxSteps: 10,
		narrateTimeoutMs: 60000,
	});
	if (!options.enabled || process.env.KYRN_SWARM_CONTROL) return;
	const { pi } = runtime;
	const projects = new BoardProjects(roots ? join(roots.agentDir, "mu") : undefined);
	const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
	let steps: BoardStep[] = [];
	let latest = "";
	let toolsSinceLook = 0;
	let lastLookAt = 0;
	let board: BoardUpdate | undefined;
	let looking: Promise<void> | undefined;
	/** A look asked for while another ran: done right after it, once. */
	let again: boolean | undefined;

	const on = (ctx: ExtensionContext) => projects.get(ctx.cwd) ?? options.defaultOn;
	const language = (): BoardLanguage => {
		if (options.language === "zh" || options.language === "en") return options.language;
		return languageOf(`${runtime.frame?.goal ?? ""} ${runtime.turn.userMessage}`);
	};

	/** The plain-speaking model: the one named for the board, else the writer, else the session's own. */
	const writerModel = (ctx: ExtensionContext): LlmCompletion | undefined => {
		if (options.model) return runtime.llm(options.model, { thinking: "off" });
		return (
			runtime.writer() ??
			(ctx.model ? runtime.llm(`${ctx.model.provider}/${ctx.model.id}`, { thinking: "off" }) : undefined)
		);
	};

	const look = async (ctx: ExtensionContext, ended: boolean): Promise<void> => {
		const frame = runtime.frame;
		const items = (frame?.acceptance ?? []).map((item) => ({ id: item.id, text: item.text, done: item.done }));
		const input: BoardInput = {
			goal: frame?.goal ?? runtime.turn.userMessage,
			items,
			steps: steps.slice(-options.maxSteps),
			latest,
			ended,
			last: board ? { phase: board.phase, focus: board.focus, now: board.now } : undefined,
		};
		const reading = (await runtime.engine.decide(boardRead, input)).outcome;
		toolsSinceLook = 0;
		lastLookAt = Date.now();
		if (!reading.update) return;

		const focusItem = reading.focus ? items.find((item) => item.id === reading.focus) : undefined;
		const facts = {
			language: language(),
			goal: input.goal,
			items,
			phase: reading.phase,
			focus: focusItem?.text,
			needsUser: reading.needsUser,
			steps: input.steps.map((step) => `${step.tool} ${step.what} -> ${step.failed ? "error" : "ok"}`),
			latest: clip(latest, 1200),
		};
		let text: BoardText | undefined;
		const complete = writerModel(ctx);
		if (complete) {
			try {
				const reply = await complete({
					system: narratorSystem(facts.language),
					user: narratorRequest(facts),
					signal: AbortSignal.timeout(options.narrateTimeoutMs),
				});
				text = parseBoardText(reply.text);
			} catch {
				text = undefined;
			}
		}
		const update: BoardUpdate = {
			...(text ?? plainBoard(facts)),
			phase: reading.phase,
			focus: reading.focus ?? undefined,
			needsUser: reading.needsUser,
			done: items.filter((item) => item.done).length,
			total: items.length,
			by: text ? "model" : "rules",
			ended,
		};
		board = update;
		pi.appendEntry<BoardUpdate>(BOARD_ENTRY, update);
		runtime.present("board.update", update);
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
			board = undefined;
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "custom" && entry.customType === BOARD_ENTRY)
					board = parseBoardEntry(entry.data) ?? board;
			}
			steps = [];
			latest = "";
			toolsSinceLook = 0;
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
			steps = [
				...steps.slice(-(options.maxSteps * 2)),
				{
					tool: name,
					what: clip(describeCall(name, input), 160),
					failed: event.isError,
					check: command !== "" && isCheckCommand(command),
				},
			];
			toolsSinceLook++;
			if (!on(ctx)) return undefined;
			if (toolsSinceLook >= options.everyTools && Date.now() - lastLookAt >= options.minIntervalMs) {
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
			if (said) latest = said;
			return undefined;
		}),
	);

	pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>((_event, ctx) => {
			runtime.touch(ctx);
			if (on(ctx)) schedule(ctx, true);
			return undefined;
		}),
	);

	pi.registerCommand("board", {
		description: "The plain-language board: /board (show it), /board on, /board off (for this project)",
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			const word = args.trim().toLowerCase();
			const zh = language() === "zh";
			if (word === "on" || word === "off") {
				projects.set(ctx.cwd, word === "on");
				runtime.present("board.switched", { on: word === "on", cwd: ctx.cwd });
				if (ctx.hasUI) {
					ctx.ui.notify(
						word === "on"
							? zh
								? "这个项目的人话看板已打开：代理每做一段，就用大白话告诉你进展。每次更新会调用一次模型。"
								: "The plain-language board is on for this project. Each update costs one model call."
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
