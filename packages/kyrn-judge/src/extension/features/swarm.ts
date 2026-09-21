import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getAgentDir, type Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { swarmRouting } from "../../decisions/swarm-routing.ts";
import {
	activeRuns,
	type BeeObserver,
	type BeeRunner,
	type BeeTask,
	type SwarmLimits,
	SwarmRun,
	type SwarmSnapshot,
} from "../../swarm/run.ts";
import type { BeeEvent } from "../../swarm/state.ts";
import { renderSwarm } from "../../swarm/view.ts";
import { type AgentDefinition, type AgentThinking, loadAgents } from "../agents.ts";
import { clip, type KyrnRuntime } from "../runtime.ts";

/** A role the main model asked for by name is in `agent`. Left out, the judge picks one. */
export type SwarmTask = BeeTask;

export interface SwarmAssignment {
	/** The role the sub-agent plays. Undefined runs a plain sub-agent with every tool and no role prompt. */
	agent?: AgentDefinition;
	/** "provider/model-id", or undefined to use the child's default model. */
	model?: string;
	thinking: AgentThinking;
	/** Who settled the role: the main model, the judge, or nobody (the default role). */
	routedBy: "caller" | "judge" | "default";
}

/**
 * Runs one task in a fresh context and resolves with the sub-agent's final
 * message. `env` is added to the child's environment; `observer` is told
 * everything the child does while it does it.
 */
export type SwarmRunner = BeeRunner<SwarmAssignment>;

/** The model a task's difficulty maps to on a ladder ordered from cheapest to strongest. */
export function pickModel(ladder: readonly string[], strength: number): string | undefined {
	if (ladder.length === 0) return undefined;
	return ladder[Math.round(Math.min(1, Math.max(0, strength)) * (ladder.length - 1))];
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && existsSync(script)) return { command: process.execPath, args: [...process.execArgv, script, ...args] };
	const generic = /^(node|bun)(\.exe)?$/.test(basename(process.execPath).toLowerCase());
	return generic ? { command: "pi", args } : { command: process.execPath, args };
}

/** Extensions given on the command line are not in any settings file, so a child only gets them if they are passed on. */
export function forwardedExtensionArgs(argv: readonly string[] = process.argv.slice(2)): string[] {
	const forwarded: string[] = [];
	for (let index = 0; index < argv.length - 1; index++) {
		if (argv[index] === "-e" || argv[index] === "--extension") forwarded.push("-e", argv[++index]);
	}
	return forwarded;
}

/** The command line of one sub-agent, without the executable. Exported for tests. */
export function childArgs(task: SwarmTask, assignment: SwarmAssignment, promptPath?: string): string[] {
	// JSON mode: the child reports every step as it takes it, not just its last words when it is over.
	const args = ["--mode", "json", "-p", "--no-session", "--thinking", assignment.thinking];
	if (assignment.model) args.push("--model", assignment.model);
	if (assignment.agent?.tools) args.push("--tools", assignment.agent.tools.join(","));
	if (promptPath) args.push("--append-system-prompt", promptPath);
	args.push(...forwardedExtensionArgs(), `Task: ${task.instructions}`);
	return args;
}

/** How long a child that has finished may take to exit by itself before it is told to. Idle keep-alive sockets hold it for seconds. */
const EXIT_GRACE_MS = 1500;
const KILL_GRACE_MS = 5000;

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return typeof content === "string" ? content : "";
	return (content as Record<string, unknown>[])
		.flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : []))
		.join("\n");
}

/**
 * A child pi process in JSON mode. It inherits the agent directory, so
 * credentials and settings carry over. The run counts as over when the child
 * says its agent has settled, not when the process is gone: a finished child
 * lingers for seconds on idle connections, and nobody should wait for that.
 */
export const spawnRunner: SwarmRunner = async (task, assignment, signal, env, observer?: BeeObserver) => {
	let promptDir: string | undefined;
	let promptPath: string | undefined;
	if (assignment.agent?.systemPrompt) {
		promptDir = await mkdtemp(join(tmpdir(), "kyrn-agent-"));
		promptPath = join(promptDir, `${assignment.agent.name}.md`);
		await writeFile(promptPath, assignment.agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
	}
	try {
		return await new Promise<string>((resolve, reject) => {
			const invocation = piInvocation(childArgs(task, assignment, promptPath));
			const child = spawn(invocation.command, invocation.args, {
				// No stdin: print mode would otherwise wait for it when it is not a terminal.
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, KYRN_SWARM_DEPTH: "1", ...env },
			});
			let buffer = "";
			let stderr = "";
			let lastText = "";
			let failure: string | undefined;
			let settled = false;
			let finished = false;

			const terminate = () => {
				if (child.exitCode !== null || child.signalCode !== null) return;
				child.kill("SIGTERM");
				const hard = setTimeout(() => {
					if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				}, KILL_GRACE_MS);
				hard.unref?.();
			};
			const finish = (error?: Error) => {
				if (finished) return;
				finished = true;
				signal?.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve(lastText.trim());
			};
			const onAbort = () => {
				terminate();
				finish(new Error("the sub-agent was stopped"));
			};
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });

			const onLine = (line: string) => {
				if (!line.trim()) return;
				let event: BeeEvent;
				try {
					event = JSON.parse(line) as BeeEvent;
				} catch {
					return;
				}
				if (event.type === "message_end" && event.message?.role === "assistant") {
					const stop = event.message.stopReason;
					if (stop === "error" || stop === "aborted") {
						failure = event.message.errorMessage ?? `the model request was ${stop}`;
					} else {
						failure = undefined;
						const text = textOf(event.message.content);
						if (text.trim()) lastText = text;
					}
				}
				observer?.event(event);
				if (event.type === "agent_settled") {
					settled = true;
					const grace = setTimeout(terminate, EXIT_GRACE_MS);
					grace.unref?.();
					finish(failure ? new Error(failure) : undefined);
				}
			};
			child.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) onLine(line);
			});
			child.stderr.on("data", (data: Buffer) => {
				stderr = (stderr + data.toString()).slice(-2000);
			});
			child.on("error", (error) => finish(error));
			child.on("close", (code) => {
				if (buffer.trim()) onLine(buffer);
				if (settled) return;
				const detail = stderr.trim().slice(-400);
				finish(new Error(`sub-agent exited with code ${code} before it finished${detail ? `: ${detail}` : ""}`));
			});
		});
	} finally {
		if (promptDir) await rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
	}
};

/** Names are how the user and the board refer to a sub-agent, so two of them cannot share one. */
export function uniqueNames(names: readonly string[]): string[] {
	const seen = new Map<string, number>();
	return names.map((raw) => {
		const name = raw.trim() || "task";
		const count = (seen.get(name) ?? 0) + 1;
		seen.set(name, count);
		return count === 1 ? name : `${name}-${count}`;
	});
}

/** What the tool shows before the first sub-agent exists: routing is a judge call, and a judge call can take seconds. */
export function announceRouting(
	onUpdate:
		| ((partial: { content: { type: "text"; text: string }[]; details: SwarmDetails | undefined }) => void)
		| undefined,
	count: number,
): void {
	onUpdate?.({
		content: [
			{
				type: "text",
				text: `choosing a role, a model and a thinking level for ${count} sub-agent${count === 1 ? "" : "s"}…`,
			},
		],
		details: undefined,
	});
}

/** Limits of a swarm, as they are written in kyrn.json. */
export const SWARM_LIMIT_DEFAULTS = {
	/** Minutes a sub-agent may work before it is told to wrap up and report. 0 means no budget. */
	beeMinutes: 10,
	/** Seconds it then has to hand in its report. */
	graceSeconds: 90,
	/** Seconds without a sign of life before it is stopped: while the model thinks, and while a tool runs. */
	stallSeconds: 300,
	toolStallSeconds: 900,
};

export function limitsFrom(options: typeof SWARM_LIMIT_DEFAULTS & { concurrency: number }): Partial<SwarmLimits> {
	return {
		concurrency: options.concurrency,
		beeMinutes: options.beeMinutes,
		graceSeconds: options.graceSeconds,
		stallSeconds: options.stallSeconds,
		toolStallSeconds: options.toolStallSeconds,
	};
}

export interface SwarmDetails {
	snapshot: SwarmSnapshot;
	/** Set once the run is over. */
	reports?: string[];
}

/** Partial results at most this often: the picture changes with every streamed token. */
const UPDATE_EVERY_MS = 200;

/** Feeds the tool's partial results from a run, as text for whoever cannot draw and as a snapshot for the terminal. */
export function streamUpdates(
	run: SwarmRun<SwarmAssignment>,
	onUpdate: ((partial: { content: { type: "text"; text: string }[]; details: SwarmDetails }) => void) | undefined,
): void {
	if (!onUpdate) return;
	let last = 0;
	let pending: ReturnType<typeof setTimeout> | undefined;
	const send = () => {
		pending = undefined;
		last = Date.now();
		const snapshot = run.snapshot();
		onUpdate({
			content: [{ type: "text", text: renderSwarm(snapshot, { expanded: false, width: 120 }, PLAIN).join("\n") }],
			details: { snapshot },
		});
	};
	run.onChange = () => {
		if (run.endedAt !== undefined) {
			if (pending) clearTimeout(pending);
			return;
		}
		const wait = UPDATE_EVERY_MS - (Date.now() - last);
		if (wait <= 0) send();
		else pending ??= setTimeout(send, wait);
	};
}

const PLAIN = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text };

/** The terminal's view of a swarm tool call: live while it runs, a summary with the reports behind ctrl+o when it is over. */
export function renderSwarmResult(
	result: { content: { type: string; text?: string }[]; details?: unknown },
	options: { expanded: boolean },
	theme: Theme,
): { render(width: number): string[]; invalidate(): void } {
	const details = result.details as SwarmDetails | undefined;
	return {
		render: (width: number) => {
			if (!details?.snapshot)
				return (result.content[0]?.text ?? "").split("\n").slice(0, options.expanded ? 400 : 12);
			return renderSwarm(details.snapshot, { expanded: options.expanded, width, reports: details.reports }, theme);
		},
		invalidate() {},
	};
}

/** A snapshot small enough to keep in the session: what each bee came to, without its activity log or its words. */
export function compactSnapshot(snapshot: SwarmSnapshot): SwarmSnapshot {
	return {
		...snapshot,
		bees: snapshot.bees.map((bee) => ({ ...bee, recent: [], finals: [], said: undefined })),
		board: snapshot.board ? { ...snapshot.board, latest: snapshot.board.latest.slice(-8) } : undefined,
	};
}

function describeAgent(agent: AgentDefinition): string {
	const pins = [agent.model, agent.thinking && `thinking ${agent.thinking}`].filter(Boolean).join(", ");
	return `${agent.name} (${agent.source}${pins ? `, ${pins}` : ""}): ${agent.description}\n  tools: ${agent.tools?.join(", ") ?? "all"}`;
}

/**
 * C1-C4, the swarm. pi has no sub-agents by design; KYRN adds one tool. Each
 * task runs in its own context window, and because that context starts empty,
 * the judge can give every task the role, the cheapest model and the thinking
 * level that fit it without costing the main session any prompt cache.
 *
 * Roles use pi's agent file format, so files written for pi's subagent
 * example work here unchanged. With no configuration at all this still
 * works: built-in roles, the session's own model, judge-picked thinking.
 */
export function registerSwarm(runtime: KyrnRuntime, runner: SwarmRunner = spawnRunner): void {
	const options = runtime.options("swarm", {
		enabled: true,
		/** Cheapest to strongest. Empty means every sub-agent uses the session's current model. */
		models: [] as string[],
		maxTasks: 6,
		concurrency: 3,
		/** The role for tasks that fit none. Set to "" for a plain sub-agent with no role. */
		defaultAgent: "worker",
		/** Where the user's own roles live. Empty means `<agentDir>/agents`. */
		agentsDir: "",
		...SWARM_LIMIT_DEFAULTS,
	});
	// A sub-agent does not get to spawn its own swarm.
	if (!options.enabled || process.env.KYRN_SWARM_DEPTH) return;
	const { pi } = runtime;

	// Read per call: a role file edited mid-session applies to the next delegation.
	const agents = (): AgentDefinition[] => loadAgents(options.agentsDir || join(getAgentDir(), "agents"));
	// A role needs at least one of its tools to exist here: "browser" without the browse tool would be a dead end.
	const usable = (): AgentDefinition[] => {
		const known = new Set(pi.getAllTools().map((tool) => tool.name));
		return agents().filter((agent) => !agent.tools || agent.tools.some((tool) => known.has(tool)));
	};

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: `Run independent tasks in parallel, each in a fresh sub-agent with its own context window. Use it for work that splits into parts that do not depend on each other, and for side work whose details you do not need (broad code search, web research). Each sub-agent sees only its own instructions, so make them self-contained. A fitting role, model and thinking level are chosen per task; name a role only when you want a specific one (${agents()
			.map((agent) => agent.name)
			.join(", ")}). Returns each sub-agent's final report.`,
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					title: Type.String({ description: "Short name of the task" }),
					instructions: Type.String({
						description: "Complete, self-contained instructions, including what to report back",
					}),
					agent: Type.Optional(Type.String({ description: "Role name. Leave out to have one chosen." })),
				}),
				{ minItems: 1 },
			),
		}),
		execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
			runtime.touch(ctx);
			const tasks: SwarmTask[] = params.tasks.slice(0, options.maxTasks);
			const names = uniqueNames(tasks.map((task) => task.title));
			announceRouting(onUpdate, tasks.length);
			const roles = usable();
			const byName = new Map(roles.map((agent) => [agent.name, agent]));
			const menu = Object.fromEntries(roles.map((agent) => [agent.name, agent.description]));

			const routes = await runtime.engine.decideMany(
				swarmRouting,
				tasks.map((task) => ({
					task: clip(`${task.title}: ${task.instructions}`, 600),
					// A role the caller named is settled, so the judge is only asked how hard the task is.
					agents: task.agent && byName.has(task.agent) ? undefined : menu,
				})),
				{ signal },
			);
			const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const assignments: SwarmAssignment[] = routes.map((route, index) => {
				const named = tasks[index].agent ? byName.get(tasks[index].agent ?? "") : undefined;
				// The judge routes whatever the decision mode: a delegated task has no "unchanged behaviour" to fall back to.
				const judged = route.judged?.agent ? byName.get(route.judged.agent) : undefined;
				const agent = named ?? judged ?? byName.get(options.defaultAgent);
				const verdict = route.judged ?? route.outcome;
				return {
					agent,
					model: agent?.model ?? pickModel(options.models, verdict.strength) ?? current,
					thinking: agent?.thinking ?? verdict.thinking,
					routedBy: named ? "caller" : judged ? "judge" : "default",
				};
			});

			const run = new SwarmRun<SwarmAssignment>({
				kind: "delegate",
				title: `${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
				dir: join(tmpdir(), `kyrn-swarm-${randomUUID().slice(0, 8)}`),
				limits: limitsFrom(options),
				bees: tasks.map((task, index) => ({
					name: names[index],
					task,
					assignment: assignments[index],
					role: assignments[index].agent?.name,
					model: assignments[index].model,
					thinking: assignments[index].thinking,
				})),
			});
			streamUpdates(run, onUpdate);
			const outcomes = await run.run(runner, signal);
			const reports = outcomes.map((outcome) => outcome.report);

			const text = tasks
				.map((task, index) => {
					const { agent, model, thinking } = assignments[index];
					const label = [agent?.name ?? "no role", model ?? "default model", `thinking ${thinking}`].join(", ");
					return `## ${task.title} [${label}]\n${reports[index]}`;
				})
				.join("\n\n");
			return {
				content: [{ type: "text", text }],
				details: {
					snapshot: compactSnapshot(run.snapshot()),
					reports,
					assignments: assignments.map(({ agent, model, thinking, routedBy }) => ({
						agent: agent?.name,
						model,
						thinking,
						routedBy,
					})),
				},
			};
		},
		renderResult: (result, renderOptions, theme) => renderSwarmResult(result, renderOptions, theme),
	});

	registerSwarmCommand(runtime);

	pi.registerCommand("agents", {
		description: "List the sub-agent roles the delegate tool can use, and where to add your own",
		handler: async (_args, ctx) => {
			const dir = options.agentsDir || join(getAgentDir(), "agents");
			const ladder = options.models.length > 0 ? options.models.join(" < ") : "the session's current model";
			ctx.ui.notify(
				[
					...agents().map(describeAgent),
					"",
					`models: ${ladder}`,
					`Add or override a role with a markdown file in ${dir} (frontmatter: name, description, tools, model, thinking).`,
				].join("\n"),
				"info",
			);
		},
	});
}

const withCommand = new WeakSet<KyrnRuntime>();

/**
 * `/swarm`: look at the sub-agents that are running right now, and end them
 * without losing what they found. Commands run while the agent is busy, so
 * this works in the middle of a hive or a delegate call, which is when it is
 * needed. Esc cancels the whole tool call and throws its results away; this
 * does not.
 */
export function registerSwarmCommand(runtime: KyrnRuntime): void {
	// The swarm and the hive both bring it; one session gets it once.
	if (withCommand.has(runtime)) return;
	withCommand.add(runtime);
	const handler = async (
		args: string,
		ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
	) => {
		const [verb = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
		const name = rest.join(" ") || undefined;
		const runs = activeRuns();
		if (runs.length === 0) {
			ctx.ui.notify("No sub-agents are running. They start when the agent uses its delegate or hive tool.", "info");
			return;
		}
		if (verb === "stop" || verb === "kill") {
			const reached = runs.reduce(
				(sum, run) =>
					sum + (verb === "stop" ? run.wrapUp(name, "stopped by the user") : run.kill(name, "ended by the user")),
				0,
			);
			ctx.ui.notify(
				reached === 0
					? `Nothing to ${verb}${name ? ` named "${name}"` : ""}. Running: ${runs.flatMap((run) => run.bees.map((bee) => bee.name)).join(", ")}`
					: verb === "stop"
						? `Asked ${reached} sub-agent${reached === 1 ? "" : "s"} to stop and report. Anything that has not reported in time is ended.`
						: `Ended ${reached} sub-agent${reached === 1 ? "" : "s"}. What they had found is kept.`,
				reached === 0 ? "warning" : "info",
			);
			return;
		}
		const theme = PLAIN;
		ctx.ui.notify(
			runs.map((run) => renderSwarm(run.snapshot(), { expanded: true, width: 110 }, theme).join("\n")).join("\n\n"),
			"info",
		);
	};
	for (const command of ["swarm", "hive"]) {
		runtime.pi.registerCommand(command, {
			description:
				command === "swarm"
					? "Sub-agents at work: /swarm (what each one is doing), /swarm stop [name] (report now), /swarm kill [name]"
					: "Same as /swarm",
			// No argument completions on purpose: with them the first Enter picks a completion and only the
			// second one runs the command, and "stop" is typed by someone who wants it to happen now.
			handler,
		});
	}
}
