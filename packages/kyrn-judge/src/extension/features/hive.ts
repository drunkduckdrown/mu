import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEndEvent, getAgentDir, type TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type DeliverInput, hiveDeliver, hivePublish, type PublishInput } from "../../decisions/hive.ts";
import { swarmRouting } from "../../decisions/swarm-routing.ts";
import { Board, isDuplicate, type Note } from "../../hive/board.ts";
import { CHECKPOINT, HIVE_MESSAGE, lastCall, NOTES_HEADER } from "../../swarm/markers.ts";
import { type BoardSummary, SwarmRun } from "../../swarm/run.ts";
import { loadAgents } from "../agents.ts";
import { clip, failOpen, type KyrnRuntime, textOf } from "../runtime.ts";
import {
	announceRouting,
	compactSnapshot,
	limitsFrom,
	pickModel,
	registerSwarmCommand,
	renderSwarmResult,
	SWARM_LIMIT_DEFAULTS,
	type SwarmAssignment,
	type SwarmRunner,
	spawnRunner,
	streamUpdates,
	uniqueNames,
} from "./swarm.ts";
import { isWrappingUp } from "./swarm-child.ts";

/** How long the last turn waits for the judge to finish with the notes that are still in flight. */
const LAST_CALL_WAIT_MS = 4000;

interface Candidate {
	text: string;
	source: string;
}

/** What one step of a bee produced that could be news: what it said, and the beginning of what its tools returned. */
export function candidatesOf(
	message: { content?: unknown },
	toolResults: readonly { toolCallId?: string; toolName?: string; content?: unknown }[],
	limit = 4,
): Candidate[] {
	const candidates: Candidate[] = [];
	const said = textOf(message.content).trim();
	if (said.length >= 40) candidates.push({ text: clip(said, 700), source: "said" });
	const calls = new Map<string, string>();
	if (Array.isArray(message.content)) {
		for (const block of message.content as Record<string, unknown>[]) {
			if (block?.type === "toolCall" && typeof block.id === "string") {
				calls.set(block.id, clip(`${String(block.name)} ${JSON.stringify(block.arguments ?? {})}`, 160));
			}
		}
	}
	for (const result of toolResults) {
		const text = textOf(result.content).trim();
		if (text.length < 80) continue;
		const call = (result.toolCallId && calls.get(result.toolCallId)) || result.toolName || "tool";
		candidates.push({ text: text.slice(0, 600), source: call });
	}
	return candidates.slice(0, limit);
}

/**
 * Inside a bee. After every step the judge decides whether what the bee said
 * or saw is news for the hive (H1), and which of the others' news matters to
 * this bee (H2). The bee's own model spends nothing on either.
 */
function registerMember(runtime: KyrnRuntime, dir: string): void {
	const options = runtime.options("hive", {
		enabled: true,
		maxNotesPerBee: 12,
		maxDeliveriesPerBee: 10,
		/** Tool calls a bee may make in silence before it is asked what it has found. 0 turns checkpoints off. */
		checkpointEvery: 4,
		/** Notes that arrive while a bee writes its report get one hearing: a corrected report, or "NO CHANGE". */
		lastCall: true,
	});
	const me = process.env.KYRN_HIVE_BEE ?? "bee";
	const goal = process.env.KYRN_HIVE_GOAL ?? "";
	const focus = process.env.KYRN_HIVE_FOCUS ?? "";
	const board = new Board(dir);
	const seen = new Set<string>();
	let posted = 0;
	let received = 0;
	let silentCalls = 0;
	/** Notes the judge accepted for this bee that it has not been shown yet. */
	const inbox: { note: Note; score: number }[] = [];
	let lastCalled = false;
	/** Empties the inbox into lines for the bee, and records each note as delivered: only now has it reached anyone. */
	const takeInbox = (): string[] =>
		inbox.splice(0).map(({ note, score }) => {
			board.delivered({ note: note.id, to: me, score });
			return `- ${note.bee} (${note.kind.replace("_", " ")}): ${note.text}`;
		});
	// Steps are judged in order and off the bee's critical path: it never waits for the hive.
	let queue: Promise<void> = Promise.resolve();

	const step = async (candidates: Candidate[], signal: AbortSignal | undefined): Promise<void> => {
		const known = board.all();
		const novel = candidates.filter((candidate) => !isDuplicate(candidate.text, known));
		if (novel.length > 0 && posted < options.maxNotesPerBee) {
			const inputs: PublishInput[] = novel.map((candidate) => ({
				goal,
				focus,
				note: candidate.text,
				source: candidate.source,
			}));
			const verdicts = await runtime.engine.decideMany(hivePublish, inputs, { signal });
			verdicts.forEach((verdict, at) => {
				const { publish, kind, score } = verdict.outcome;
				board.log({
					gate: "publish",
					bee: me,
					source: novel[at].source,
					head: clip(novel[at].text, 100),
					text: novel[at].text,
					publish,
					kind,
					score,
					reason: verdict.reason,
				});
				if (!publish || !kind || posted >= options.maxNotesPerBee) return;
				posted++;
				const id = randomUUID().slice(0, 8);
				seen.add(id);
				board.post({
					id,
					bee: me,
					kind,
					score,
					text: novel[at].text,
					source: novel[at].source,
					at: new Date().toISOString(),
				});
			});
		}

		const news = board.fresh().filter((note) => note.bee !== me && !seen.has(note.id));
		for (const note of news) seen.add(note.id);
		if (news.length === 0 || received >= options.maxDeliveriesPerBee) return;
		const inputs: DeliverInput[] = news.map((note) => ({ focus, note: note.text, kind: note.kind, from: note.bee }));
		const verdicts = await runtime.engine.decideMany(hiveDeliver, inputs, { signal });
		news.forEach((note, at) => {
			const { deliver, score } = verdicts[at].outcome;
			board.log({
				gate: "deliver",
				to: me,
				from: note.bee,
				note: note.id,
				deliver,
				score,
				reason: verdicts[at].reason,
			});
		});
		const accepted = news
			.filter((_, at) => verdicts[at].outcome.deliver)
			.slice(0, options.maxDeliveriesPerBee - received);
		if (accepted.length === 0) return;
		received += accepted.length;
		// Not handed over here: a note that lands while the bee is writing its report would wake it up again
		// after it had finished, and its last words would replace the report. It gets them at its next step.
		for (const note of accepted) inbox.push({ note, score: verdicts[news.indexOf(note)]?.outcome.score ?? 0 });
	};

	const tell = (content: string) =>
		runtime.pi.sendMessage({ customType: HIVE_MESSAGE, content, display: true }, { deliverAs: "steer" });

	runtime.pi.on(
		"turn_end",
		failOpen<TurnEndEvent, undefined>(async (event, ctx) => {
			runtime.touch(ctx);
			const candidates = candidatesOf(event.message as { content?: unknown }, event.toolResults);
			queue = queue.then(() => step(candidates, ctx.signal)).catch(() => undefined);
			// Told to wrap up: nothing more goes in, it only has to get its report out.
			if (isWrappingUp(runtime)) return undefined;

			if (event.toolResults.length > 0) {
				// The bee goes on anyway, so what is waiting for it costs no extra turn.
				if (inbox.length > 0) tell(`${NOTES_HEADER}\n${takeInbox().join("\n")}`);
				const spoke = candidates.some((candidate) => candidate.source === "said");
				silentCalls = spoke ? 0 : silentCalls + event.toolResults.length;
				if (options.checkpointEvery > 0 && silentCalls >= options.checkpointEvery) {
					silentCalls = 0;
					tell(CHECKPOINT);
				}
				return undefined;
			}

			// The last turn: this message is the report. Late notes get one deliberate hearing, never an open-ended one.
			if (lastCalled || !options.lastCall) return undefined;
			await Promise.race([queue, new Promise((resolve) => setTimeout(resolve, LAST_CALL_WAIT_MS))]);
			if (inbox.length === 0) return undefined;
			lastCalled = true;
			tell(lastCall(takeInbox()));
			return undefined;
		}),
	);

	// A bee in print mode exits right after its last turn: give what it found at the end a moment to reach the board.
	runtime.pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>(async () => {
			await Promise.race([queue, new Promise((resolve) => setTimeout(resolve, 6000))]);
			return undefined;
		}),
	);
}

/**
 * H, the hive: several bees on ONE hard problem, each from its own angle and
 * in its own context window, with a shared board between them that only the
 * judge writes to and reads from on their behalf.
 *
 * `delegate` is for work that splits into independent parts. The hive is for
 * work that does not: a bug nobody understands, a design with unknowns,
 * where what one line of inquiry turns up changes what the others should do.
 */
export function registerHive(runtime: KyrnRuntime, runner: SwarmRunner = spawnRunner): void {
	const options = runtime.options("hive", {
		enabled: true,
		maxBees: 6,
		concurrency: 4,
		/** The role of a bee the caller named none for. */
		defaultAgent: "investigator",
		/** Cheapest to strongest; empty means the swarm ladder, and failing that the session's model. */
		models: [] as string[],
		...SWARM_LIMIT_DEFAULTS,
	});
	if (!options.enabled) return;
	const memberDir = process.env.KYRN_HIVE_DIR;
	if (memberDir) {
		registerMember(runtime, memberDir);
		return;
	}
	// Only the top-level session may start a hive.
	if (process.env.KYRN_SWARM_DEPTH) return;
	const { pi } = runtime;

	pi.registerTool({
		name: "hive",
		label: "Hive",
		description:
			"Put several investigators on ONE hard problem at once, each from a different angle (reproduce it, read the code involved, search history, search the web, test a hypothesis). Unlike delegate, they are not isolated: a fast judgment model watches every step and passes what one of them finds to the others it matters to, so they build on each other instead of repeating each other. Use it when a problem resists a direct attempt or its cause is unknown. Investigators do not edit files; you get their reports and the shared findings, and you make the change.",
		parameters: Type.Object({
			goal: Type.String({ description: "The problem, stated completely: symptoms, what was tried, constraints" }),
			bees: Type.Array(
				Type.Object({
					name: Type.String({ description: "Short name, e.g. repro, history, auth-code" }),
					focus: Type.String({ description: "The angle this one takes, self-contained" }),
					agent: Type.Optional(
						Type.String({ description: "Role name. Default: investigator (read-only plus bash and browse)" }),
					),
				}),
				{ minItems: 2 },
			),
		}),
		execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
			runtime.touch(ctx);
			const asked = params.bees.slice(0, options.maxBees);
			const names = uniqueNames(asked.map((bee) => bee.name));
			const bees = asked.map((bee, at) => ({ ...bee, name: names[at] }));
			announceRouting(onUpdate, bees.length);
			const dir = join(tmpdir(), `kyrn-hive-${randomUUID().slice(0, 8)}`);
			const board = new Board(dir);
			const roles = new Map(loadAgents(join(getAgentDir(), "agents")).map((agent) => [agent.name, agent]));
			const swarm = runtime.options("swarm", { enabled: true, models: [] as string[] });
			const ladder = options.models.length > 0 ? options.models : swarm.models;
			const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

			const routes = await runtime.engine.decideMany(
				swarmRouting,
				bees.map((bee) => ({ task: clip(`${bee.focus} (part of: ${params.goal})`, 600) })),
				{ signal },
			);
			const assignments: SwarmAssignment[] = routes.map((route, at) => {
				const agent = roles.get(bees[at].agent ?? "") ?? roles.get(options.defaultAgent);
				const verdict = route.judged ?? route.outcome;
				return {
					agent,
					model: agent?.model ?? pickModel(ladder, verdict.strength) ?? current,
					thinking: agent?.thinking ?? verdict.thinking,
					routedBy: bees[at].agent && roles.has(bees[at].agent ?? "") ? "caller" : "default",
				};
			});

			const run = new SwarmRun<SwarmAssignment>({
				kind: "hive",
				title: clip(params.goal, 120),
				dir,
				limits: limitsFrom(options),
				bees: bees.map((bee, at) => {
					const others = bees.filter((other) => other !== bee).map((other) => `- ${other.name}: ${other.focus}`);
					const instructions = [
						`You are "${bee.name}", one of ${bees.length} investigators working on the same problem at the same time.`,
						`The problem:\n${params.goal}`,
						`Your angle: ${bee.focus}`,
						`The others, so you do not repeat them:\n${others.join("\n")}`,
					].join("\n\n");
					return {
						name: bee.name,
						task: { title: bee.name, instructions },
						assignment: assignments[at],
						role: assignments[at].agent?.name,
						model: assignments[at].model,
						thinking: assignments[at].thinking,
						env: {
							KYRN_HIVE_DIR: dir,
							KYRN_HIVE_BEE: bee.name,
							KYRN_HIVE_GOAL: clip(params.goal, 600),
							KYRN_HIVE_FOCUS: clip(bee.focus, 400),
						},
					};
				}),
			});
			// The board is part of the live view: what the judge let through, whom it reached, how much it has ruled on.
			run.board = () => summarizeBoard(board);
			streamUpdates(run, onUpdate);
			const outcomes = await run.run(runner, signal);
			const reports = outcomes.map((outcome) => outcome.report);

			const notes = board.all().sort((a, b) => b.score - a.score);
			const deliveries = board.deliveries();
			const reached = (note: Note) =>
				deliveries.filter((delivery) => delivery.note === note.id).map((delivery) => delivery.to);
			const boardText =
				notes.length === 0
					? "(nothing was judged worth sharing)"
					: notes
							.slice(0, 14)
							.map((note) => {
								const to = reached(note);
								return `- [${note.kind.replace("_", " ")} ${note.score.toFixed(2)}] ${note.bee}${to.length > 0 ? ` -> ${to.join(", ")}` : ""}: ${clip(note.text, 400)}`;
							})
							.join("\n");
			const text = [
				...bees.map((bee, at) => {
					const { agent, model, thinking } = assignments[at];
					return `## ${bee.name} [${[agent?.name ?? "no role", model ?? "default model", `thinking ${thinking}`].join(", ")}]\n${reports[at]}`;
				}),
				`## Hive board: ${notes.length} notes passed the judge, ${deliveries.length} deliveries between investigators\n${boardText}\n(every verdict of the gates: ${join(dir, "gate.jsonl")})`,
			].join("\n\n");
			return {
				content: [{ type: "text", text }],
				details: {
					snapshot: compactSnapshot(run.snapshot()),
					reports,
					notes: notes.length,
					delivered: deliveries.length,
					dir,
				},
			};
		},
		renderResult: (result, renderOptions, theme) => renderSwarmResult(result, renderOptions, theme),
	});

	registerSwarmCommand(runtime);
}

/** The board as the live view shows it. Read from the files every time: the bees write them from their own processes. */
export function summarizeBoard(board: Board): BoardSummary {
	const notes = board.all();
	const deliveries = board.deliveries();
	const published: Record<string, number> = {};
	const received: Record<string, number> = {};
	for (const note of notes) published[note.bee] = (published[note.bee] ?? 0) + 1;
	for (const delivery of deliveries) received[delivery.to] = (received[delivery.to] ?? 0) + 1;
	return {
		notes: notes.length,
		deliveries: deliveries.length,
		judged: board.judged(),
		published,
		received,
		latest: notes.slice(-8).map((note) => ({
			at: note.at,
			bee: note.bee,
			kind: note.kind,
			score: note.score,
			to: deliveries.filter((delivery) => delivery.note === note.id).map((delivery) => delivery.to),
			text: clip(note.text, 200),
		})),
	};
}
