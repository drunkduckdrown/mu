import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionCommandContext,
	getAgentDir,
	keyText,
	VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import { findChrome } from "../../browser/chrome.ts";
import type { DecisionMode } from "../../decision.ts";
import type { LedgerRecord } from "../../ledger.ts";
import { loadAgents } from "../agents.ts";
import { failOpen, type KyrnRuntime } from "../runtime.ts";
import { KYRN_VERSION } from "./welcome.ts";

const MODES: readonly string[] = ["off", "shadow", "active"];

/** Resolves to `<package>/prompts` from both `src/` and `dist/`. */
const PROMPTS_DIR = fileURLToPath(new URL("../../../prompts", import.meta.url));

/** Built when asked for: key names are only known once the user's keybindings are loaded. */
const help = () => `mu ${KYRN_VERSION} · judgment-first coding agent, built on pi ${PI_VERSION}

Start here
  /status                  judge, modes, what was kept out of the context, recent verdicts
  /doctor                  is everything wired up: judge, model, browser, sub-agents
  /init                    have the agent write AGENTS.md for this project
  /clear                   start a fresh conversation (same as /new)

Judgment layer
  Every message is read by the judge first: it waits above the editor while that happens (esc skips
  the wait), and the verdict stays under it in the chat. ${keyText("app.tools.expand")} shows every answer behind a verdict.
  /mu judge <tiers>      which models judge, in order: laya | laya,jev | llm:<provider>/<model>
  /mu route <decision> <tiers|default>      one decision on its own judge, e.g. browser.step luna
  /mu mode <decision|default> <off|shadow|active>
  /ledger [n]              the last n verdicts with timing
  /remember <lesson>       keep a lesson for future sessions

Tools the agent can use (and you can ask for)
  /browse <url> [goal]     drive the built-in browser yourself; the agent has it as "browse"
  /agents                  sub-agent roles behind "delegate" (independent parts) and "hive" (one hard problem,
                           several investigators, the judge passing findings between them)
  /swarm                   what every running sub-agent is doing right now; /swarm stop [name] has it report
                           now and keeps what it found, /swarm kill [name] ends it at once
  /review [what]           hand a review to the reviewer role

Session and model (from pi)
  /model  /thinking  /login  /logout  /settings  /hotkeys
  /new  /resume  /tree  /fork  /clone  /compact  /name  /session
  /copy  /export  /import  /share  /reload  /changelog  /quit

While typing:  ! runs a shell command · !! runs it without adding it to the context · @ attaches a file`;

function describeRecord(record: LedgerRecord): string[] {
	const verdict = record.judged === undefined ? (record.reason ?? "no verdict") : JSON.stringify(record.judged);
	const timing = record.latencyMs === undefined ? "" : ` ${record.latencyMs}ms`;
	const batch = record.batch ? ` x${record.batch.size}` : "";
	const tiers = (record.tiers ?? [])
		.map(
			(tier) =>
				`${tier.judgeId.split(/[:/]/).pop()} ${tier.kept}/${tier.asked}${tier.error ? ` ${tier.error}` : ""}`,
		)
		.join(", ");
	const lines = [
		`${record.timestamp.slice(11, 19)} ${record.specId} v${record.specVersion}${batch} [${record.source}]${timing}${tiers ? ` (${tiers})` : ""} ${verdict.slice(0, 200)}`,
	];
	for (const warning of record.warnings ?? []) {
		lines.push(
			`  ! ${warning.type}${warning.questionId ? ` (${warning.questionId})` : ""}: ${warning.message ?? ""}`,
		);
	}
	return lines;
}

/**
 * The slash commands that make mu a CLI of its own rather than a bag of
 * hooks: help, status, a self-check, and the switches of the judgment layer.
 */
export function registerCommands(runtime: KyrnRuntime): void {
	const { pi, engine } = runtime;

	const status = (ctx: ExtensionCommandContext): string => {
		const { stats } = engine;
		const { savings } = runtime;
		const modes = [...engine.explicitModes()].map(([specId, mode]) => `${specId}=${mode}`).join(" ");
		const usage = ctx.getContextUsage();
		const lines = [
			`model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"} · thinking ${pi.getThinkingLevel()}${
				usage?.percent === undefined || usage.percent === null ? "" : ` · context ${Math.round(usage.percent)}%`
			}`,
			`judge: ${runtime.enabled ? engine.providerId : "off"}`,
			...[...engine.routes()].map(([specId, judge]) => `  ${specId} -> ${judge.id}`),
			`mode: default=${engine.getMode("*")}${modes ? ` ${modes}` : ""}`,
			`calls: ${stats.calls} | failures: ${stats.failures} | abstentions: ${stats.abstentions} | input tokens: ${stats.inputTokens}`,
			`kept out of context: tool output ${savings.admissionOmittedChars} chars, skills ${savings.skillsHiddenChars} chars, forgotten ${savings.forgottenChars} chars, compacted ${savings.compactedChars} chars`,
		];
		if (stats.lastError) lines.push(`last error: ${stats.lastError.kind} - ${stats.lastError.message}`);
		for (const problem of runtime.problems) lines.push(`problem: ${problem}`);
		for (const record of runtime.memory.records.slice(-6)) lines.push(...describeRecord(record));
		return lines.join("\n");
	};

	const mu = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		runtime.touch(ctx);
		const [verb, first, second] = args.trim().split(/\s+/);
		if (verb === "judge" && first) {
			const problems = runtime.useJudges(first.split(",").map((tier) => tier.trim()));
			const probe = await engine.probe();
			ctx.ui.notify(
				[
					`judge: ${engine.providerId}`,
					probe.ok ? `answering in ${probe.latencyMs} ms` : `not answering (${probe.error}); decisions fall back`,
					...problems.map((problem) => `problem: ${problem}`),
				].join("\n"),
				probe.ok ? "info" : "warning",
			);
			return;
		}
		if (verb === "route" && first) {
			const tiers = second && second !== "default" ? second.split(",").map((tier) => tier.trim()) : [];
			const problems = runtime.route(first, tiers);
			ctx.ui.notify(
				[`${first} -> ${engine.judgeFor(first).id}`, ...problems.map((problem) => `problem: ${problem}`)].join(
					"\n",
				),
				"info",
			);
			return;
		}
		if (verb === "mode" && first && second && MODES.includes(second)) {
			if (first === "default") engine.setDefaultMode(second as DecisionMode);
			else engine.setMode(first, second as DecisionMode);
			ctx.ui.notify(`${first} -> ${second}`, "info");
			return;
		}
		ctx.ui.notify(status(ctx), "info");
	};

	pi.registerCommand("mu", {
		description:
			"mu status. Also: /mu judge <tiers> | /mu route <decision> <tiers|default> | /mu mode <decision|default> <off|shadow|active>",
		getArgumentCompletions: (prefix) => {
			const options = [
				"judge laya",
				"judge laya,luna",
				"judge laya,jev",
				"mode default active",
				"mode default shadow",
			];
			const matches = options.filter((option) => option.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: mu,
	});

	pi.registerCommand("status", {
		description: "Model, judge, decision modes, context savings and the latest verdicts",
		handler: async (_args, ctx) => mu("", ctx),
	});

	pi.registerCommand("help", {
		description: "What mu can do and every command worth knowing",
		handler: async (_args, ctx) => ctx.ui.notify(help(), "info"),
	});

	pi.registerCommand("clear", {
		description: "Start a fresh conversation (same as /new)",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});

	pi.registerCommand("ledger", {
		description: "The last verdicts of the judge with timing: /ledger [n]",
		handler: async (args, ctx) => {
			const count = Math.min(50, Math.max(1, Number.parseInt(args.trim(), 10) || 15));
			const records = runtime.memory.records.slice(-count);
			ctx.ui.notify(
				records.length === 0
					? "No verdicts yet in this session. Across sessions: mu ledger"
					: records.flatMap(describeRecord).join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("doctor", {
		description: "Check that the judge, the model, the browser and the sub-agents are wired up",
		handler: async (_args, ctx) => {
			runtime.touch(ctx);
			const ok = (good: boolean) => (good ? "ok  " : "FIX ");
			const probe = runtime.enabled ? await engine.probe() : undefined;
			const chrome = findChrome();
			const available = ctx.modelRegistry.getAvailable();
			const providers = [...new Set(available.map((model) => model.provider))];
			const agentsDir = join(getAgentDir(), "agents");
			const roles = loadAgents(agentsDir);
			const ladder = runtime.options("swarm", { enabled: true, models: [] as string[] }).models;
			const missing = ladder.filter((ref) => {
				const slash = ref.indexOf("/");
				return slash < 1 || !ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
			});
			const lines = [
				`${ok(Boolean(ctx.model))}model      ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none selected: /login, then /model"}`,
				`${ok(providers.length > 0)}login      ${providers.length > 0 ? providers.join(", ") : "no provider has credentials: /login"}`,
				probe
					? `${ok(probe.ok)}judge      ${engine.providerId} ${probe.ok ? `answers in ${probe.latencyMs} ms` : `does not answer (${probe.error}). For laya: mu judge start`}`
					: "--  judge      off (MU_JUDGE=off)",
				`--  decisions  default ${engine.getMode("*")}. Change with /mu mode default <off|shadow|active>`,
				`${ok(Boolean(chrome))}browser    ${chrome ?? "no Chrome or Chromium found; set MU_CHROME"}`,
				`--  browse     driven by ${engine.judgeFor("browser.step").id}. It needs a judge that can relate a goal to a page (jev, or an llm judge): /mu route browser.step luna`,
				`${ok(roles.length > 0)}sub-agents ${roles.map((role) => role.name).join(", ")} · your own go in ${agentsDir}`,
				`${ok(missing.length === 0)}ladder     ${ladder.length === 0 ? "none: sub-agents use the session's model" : ladder.join(" < ")}${
					missing.length > 0 ? ` · not available: ${missing.join(", ")}` : ""
				}`,
				`--  writer     ${runtime.config.writer ?? "none: the session's model writes typed text and lessons"}`,
				...runtime.problems.map((problem) => `FIX problem    ${problem}`),
			];
			ctx.ui.notify(lines.join("\n"), lines.some((line) => line.startsWith("FIX")) ? "warning" : "info");
		},
	});

	// /init and /review are prompts, so they ship as pi prompt templates rather than code.
	pi.on(
		"resources_discover",
		failOpen(() => (existsSync(PROMPTS_DIR) ? { promptPaths: [PROMPTS_DIR] } : undefined)),
	);
}
