import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyEvent, type BeeEvent, type BeeState, isOver, isRunning, newBee, reportOf } from "./state.ts";

/** What a sub-agent is asked to do. */
export interface BeeTask {
	title: string;
	instructions: string;
	/** A role the caller asked for by name. */
	agent?: string;
}

/** What the runner is told about a bee while it runs. */
export interface BeeObserver {
	/** Every event of the child's JSON stream, parsed. */
	event(event: BeeEvent): void;
}

/** Starts one sub-agent and resolves with its final message. Rejects when it could not run or was stopped. */
export type BeeRunner<Assignment> = (
	task: BeeTask,
	assignment: Assignment,
	signal?: AbortSignal,
	env?: Readonly<Record<string, string>>,
	observer?: BeeObserver,
) => Promise<string>;

export interface SwarmLimits {
	concurrency: number;
	/** Minutes a bee may work before it is told to wrap up and report. 0 means no budget. */
	beeMinutes: number;
	/** Seconds a bee has to hand in its report once told to. */
	graceSeconds: number;
	/** Seconds without a sign of life before a bee is shown as quiet. */
	quietSeconds: number;
	/** Seconds without a sign of life before it is stopped: while the model is thinking, and while a tool runs. */
	stallSeconds: number;
	toolStallSeconds: number;
}

export const DEFAULT_LIMITS: SwarmLimits = {
	concurrency: 4,
	beeMinutes: 10,
	graceSeconds: 90,
	quietSeconds: 45,
	stallSeconds: 300,
	toolStallSeconds: 900,
};

export interface BeeSpec<Assignment> {
	name: string;
	task: BeeTask;
	assignment: Assignment;
	env?: Readonly<Record<string, string>>;
	/** Shown next to the name: role, model, thinking level. */
	role?: string;
	model?: string;
	thinking?: string;
}

export interface BoardLine {
	at: string;
	bee: string;
	kind: string;
	score: number;
	to: string[];
	text: string;
}

export interface BoardSummary {
	notes: number;
	deliveries: number;
	/** Candidates and note-to-bee pairs the judge has ruled on. */
	judged: number;
	latest: BoardLine[];
	/** Per bee name. */
	published: Readonly<Record<string, number>>;
	received: Readonly<Record<string, number>>;
}

export interface SwarmSnapshot {
	kind: "hive" | "delegate";
	title: string;
	startedAt: number;
	now: number;
	endedAt?: number;
	bees: BeeState[];
	board?: BoardSummary;
	/** Where the transcripts, the board and the gate log of this run are. */
	dir: string;
}

export interface BeeOutcome {
	state: BeeState;
	/** What goes back to the main model for this bee: its report, or what is known about why there is none. */
	report: string;
}

const clock = (ms: number): string => {
	const seconds = Math.round(ms / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
};

/** File a bee's control requests are written to; the child watches it. */
export function controlPath(dir: string, index: number): string {
	return join(dir, "control", `bee-${index}.json`);
}

const active = new Set<SwarmRun<unknown>>();

/** Runs in progress in this process, for the commands that look at them and stop them. */
export function activeRuns(): SwarmRun<unknown>[] {
	return [...active];
}

/**
 * One swarm: a set of sub-agents started together, with a limit on how many
 * run at once, a watchdog, a time budget, and a live picture of each of them.
 *
 * Nothing here can hang on a bee. Every way a bee can fail to come back
 * (a stuck tool, a dead stream, a model that never stops) ends in a stop by
 * the watchdog, and what the bee had found until then is still handed back.
 */
export class SwarmRun<Assignment> {
	readonly kind: "hive" | "delegate";
	readonly title: string;
	readonly dir: string;
	readonly startedAt: number;
	endedAt?: number;
	readonly bees: BeeState[];
	/** Called when the picture changed; throttled by the caller of `run`. */
	onChange?: () => void;
	/** Hive only: the state of the shared board, read fresh for every snapshot. */
	board?: () => BoardSummary;
	private readonly specs: BeeSpec<Assignment>[];
	private readonly limits: SwarmLimits;
	private readonly controllers: (AbortController | undefined)[];
	private readonly now: () => number;

	constructor(options: {
		kind: "hive" | "delegate";
		title: string;
		dir: string;
		bees: BeeSpec<Assignment>[];
		limits?: Partial<SwarmLimits>;
		now?: () => number;
	}) {
		this.kind = options.kind;
		this.title = options.title;
		this.dir = options.dir;
		this.specs = options.bees;
		this.limits = { ...DEFAULT_LIMITS, ...options.limits };
		this.now = options.now ?? Date.now;
		this.startedAt = this.now();
		this.controllers = options.bees.map(() => undefined);
		mkdirSync(join(this.dir, "control"), { recursive: true });
		mkdirSync(join(this.dir, "transcripts"), { recursive: true });
		this.bees = options.bees.map((bee, index) =>
			newBee(bee.name, this.startedAt, {
				role: bee.role,
				model: bee.model,
				thinking: bee.thinking,
				transcript: join(this.dir, "transcripts", `${index}-${bee.name.replace(/[^\w.-]+/g, "_")}.jsonl`),
			}),
		);
	}

	snapshot(): SwarmSnapshot {
		const board = this.board?.();
		if (board) {
			for (const bee of this.bees) {
				bee.published = board.published[bee.name] ?? 0;
				bee.received = board.received[bee.name] ?? 0;
			}
		}
		return {
			kind: this.kind,
			title: this.title,
			startedAt: this.startedAt,
			now: this.now(),
			endedAt: this.endedAt,
			bees: this.bees,
			board,
			dir: this.dir,
		};
	}

	private find(name?: string): number[] {
		return this.bees.flatMap((bee, index) => (name === undefined || bee.name === name ? [index] : []));
	}

	/** Asks bees to stop investigating and report. Bees still waiting for a slot are dropped. Returns how many it reached. */
	wrapUp(name: string | undefined, reason: string): number {
		let reached = 0;
		for (const index of this.find(name)) {
			const bee = this.bees[index];
			if (bee.status === "queued") {
				bee.status = "stopped";
				bee.error = reason;
				bee.endedAt = this.now();
				reached++;
			} else if (isRunning(bee.status) && !bee.wrapUp) {
				bee.wrapUp = { at: this.now(), reason };
				bee.status = "wrapping-up";
				try {
					writeFileSync(controlPath(this.dir, index), JSON.stringify({ action: "wrap_up", reason }));
				} catch {
					// Without the file the bee is not told; the grace period still ends it.
				}
				reached++;
			}
		}
		if (reached > 0) this.onChange?.();
		return reached;
	}

	/** Ends bees now. What they found so far is kept. */
	kill(name: string | undefined, reason: string, status: "stopped" | "timed-out" = "stopped"): number {
		let reached = 0;
		for (const index of this.find(name)) {
			const bee = this.bees[index];
			if (isOver(bee.status)) continue;
			bee.status = status;
			bee.error = reason;
			bee.endedAt = this.now();
			bee.tool = undefined;
			this.controllers[index]?.abort();
			reached++;
		}
		if (reached > 0) this.onChange?.();
		return reached;
	}

	private watch(): void {
		const now = this.now();
		for (const bee of this.bees) {
			if (!isRunning(bee.status)) continue;
			const quiet = now - bee.lastEventAt;
			bee.quietMs = quiet >= this.limits.quietSeconds * 1000 ? quiet : undefined;
			const inTool = bee.status === "tool";
			const limit = (inTool ? this.limits.toolStallSeconds : this.limits.stallSeconds) * 1000;
			if (limit > 0 && quiet >= limit) {
				const what = inTool ? `its ${bee.tool?.name ?? "tool"} call` : "the model";
				this.kill(bee.name, `no sign of life from ${what} for ${clock(quiet)}`, "timed-out");
				continue;
			}
			if (bee.wrapUp) {
				if (now - bee.wrapUp.at >= this.limits.graceSeconds * 1000) {
					this.kill(
						bee.name,
						`${bee.wrapUp.reason}; no report within ${this.limits.graceSeconds}s of being asked`,
						"timed-out",
					);
				}
			} else if (this.limits.beeMinutes > 0 && now - (bee.startedAt ?? now) >= this.limits.beeMinutes * 60_000) {
				this.wrapUp(bee.name, `time budget of ${this.limits.beeMinutes} min reached`);
			}
		}
	}

	private outcome(index: number, returned: string | undefined, failure: unknown): BeeOutcome {
		const bee = this.bees[index];
		bee.endedAt ??= this.now();
		bee.tool = undefined;
		const report = reportOf(bee) || (returned ?? "").trim();
		if (!isOver(bee.status)) {
			if (failure !== undefined || (bee.error && !report)) {
				bee.status = "failed";
				bee.error ??= failure instanceof Error ? failure.message : String(failure ?? "no report");
			} else {
				bee.status = "done";
			}
		}
		if (bee.status === "done") {
			const body = report || "(it finished without a report)";
			// Asked to stop early and did: the report is real, but the reader should know it was cut short.
			return { state: bee, report: bee.wrapUp ? `(Cut short: ${bee.wrapUp.reason}.)\n${body}` : body };
		}

		const spent = `after ${clock((bee.endedAt ?? this.now()) - (bee.startedAt ?? bee.queuedAt))}, ${bee.turns} turns, ${bee.toolCalls} tool calls`;
		const label =
			bee.status === "failed" ? "FAILED" : bee.status === "timed-out" ? "STOPPED BY THE WATCHDOG" : "STOPPED";
		const lines = [`${label}: ${bee.error ?? "unknown reason"} (${spent}).`];
		// A bee that was asked to wrap up and did has a real report; one that was cut off has at most its last words.
		if (report) lines.push(`What it had reported by then:\n${report}`);
		else if (bee.said) lines.push(`The last thing it said: ${bee.said}`);
		return { state: bee, report: lines.join("\n") };
	}

	/** Runs every bee to an end. Never rejects. */
	async run(runner: BeeRunner<Assignment>, signal?: AbortSignal): Promise<BeeOutcome[]> {
		active.add(this as SwarmRun<unknown>);
		const outcomes: BeeOutcome[] = new Array(this.specs.length);
		const abortAll = () => this.kill(undefined, "the run was cancelled");
		if (signal?.aborted) abortAll();
		else signal?.addEventListener("abort", abortAll, { once: true });
		const ticker = setInterval(() => {
			this.watch();
			this.onChange?.();
		}, 1000);
		ticker.unref?.();

		let next = 0;
		const worker = async () => {
			while (next < this.specs.length) {
				const index = next++;
				const bee = this.bees[index];
				const spec = this.specs[index];
				if (isOver(bee.status)) {
					outcomes[index] = this.outcome(index, undefined, undefined);
					continue;
				}
				const controller = new AbortController();
				this.controllers[index] = controller;
				bee.status = "starting";
				bee.startedAt = this.now();
				bee.lastEventAt = bee.startedAt;
				this.onChange?.();
				const observer: BeeObserver = {
					event: (event) => {
						if (isOver(bee.status)) return;
						applyEvent(bee, event, this.now());
						if (event.type !== "message_update" && event.type !== "tool_execution_update" && bee.transcript) {
							try {
								appendFileSync(bee.transcript, `${JSON.stringify({ at: this.now(), ...event })}\n`);
							} catch {
								// The transcript is for people; losing a line of it changes nothing.
							}
						}
						this.onChange?.();
					},
				};
				let returned: string | undefined;
				let failure: unknown;
				try {
					returned = await runner(
						spec.task,
						spec.assignment,
						controller.signal,
						{ ...spec.env, KYRN_SWARM_CONTROL: controlPath(this.dir, index) },
						observer,
					);
				} catch (error) {
					failure = error;
				}
				outcomes[index] = this.outcome(index, returned, failure);
				this.onChange?.();
			}
		};
		try {
			await Promise.all(
				Array.from({ length: Math.max(1, Math.min(this.limits.concurrency, this.specs.length)) }, worker),
			);
		} finally {
			clearInterval(ticker);
			signal?.removeEventListener("abort", abortAll);
			this.endedAt = this.now();
			active.delete(this as SwarmRun<unknown>);
			this.onChange?.();
		}
		return outcomes;
	}
}
