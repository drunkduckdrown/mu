/**
 * The mu harness layer as a pi extension.
 *
 *   pi -e packages/kyrn-judge/src/extension/kyrn-judge.ts
 *
 * Configuration lives in `<agent dir>/kyrn.json` (see `../config.ts`), with
 * environment overrides:
 *   KYRN_JUDGE            judges to use, in order: jev | laya | mock | llm:<provider>/<model> | a name from kyrn.json; "off" disables
 *   KYRN_JUDGE_MODE       default mode of every decision: shadow (default) | active | off
 *   KYRN_LOCAL_JUDGE_URL  sidecar address for `laya` (default http://127.0.0.1:47823)
 *
 * The decision model is pluggable: features ask typed questions through one
 * engine and never know which model answers. Every handler fails open. pi
 * treats a throwing `tool_call` handler as a block, so a judge outage must
 * never surface as an exception.
 */
import { homedir } from "node:os";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Capability } from "../catalog/catalog.ts";
import { DEFAULT_CONFIG, type KyrnConfig, loadConfig } from "../config.ts";
import type { DecisionMode } from "../decision.ts";
import { Judge } from "../judge.ts";
import type { JudgeProvider } from "../types.ts";
import { registerAdmission } from "./features/admission.ts";
import { registerBackground } from "./features/background.ts";
import { registerBrowser } from "./features/browser.ts";
import { registerCatalog } from "./features/catalog.ts";
import { type CheckpointDeps, registerCheckpoint } from "./features/checkpoint.ts";
import { registerCommands } from "./features/commands.ts";
import { registerCompaction } from "./features/compaction.ts";
import { registerCompletion } from "./features/completion.ts";
import { registerConstraints } from "./features/constraints.ts";
import { registerForgetting } from "./features/forgetting.ts";
import { registerFrame } from "./features/frame.ts";
import { registerGoal } from "./features/goal.ts";
import { registerGuard } from "./features/guard.ts";
import { registerHive } from "./features/hive.ts";
import { type HarnessRoots, registerInherit } from "./features/inherit.ts";
import { registerInterjection } from "./features/interjection.ts";
import { registerLsp } from "./features/lsp.ts";
import { type McpFeatureOptions, registerMcp } from "./features/mcp.ts";
import { registerMemory } from "./features/memory.ts";
import { registerMonitor } from "./features/monitor.ts";
import { registerNotify } from "./features/notify.ts";
import { registerPacks } from "./features/packs.ts";
import { registerPreflight } from "./features/preflight.ts";
import { registerSkills } from "./features/skills.ts";
import { registerSwarm, type SwarmRunner } from "./features/swarm.ts";
import { registerSwarmChild } from "./features/swarm-child.ts";
import { registerTools } from "./features/tools.ts";
import { registerTtsr } from "./features/ttsr.ts";
import { registerWarming } from "./features/warming.ts";
import { registerWeb } from "./features/web.ts";
import { registerWelcome } from "./features/welcome.ts";
import type { PresentationListener } from "./presentation.ts";
import { KyrnRuntime, recentTurnDigests } from "./runtime.ts";

export { recentTurnDigests };

export interface KyrnJudgeExtensionOptions {
	/** Native desktop/SDK observers. RPC clients receive the same events through setStatus. */
	onPresentation?: PresentationListener;
	/** A single judge backend, bypassing the configured tiers. Meant for tests and embedding. */
	provider?: JudgeProvider;
	/** Default decision mode. Overrides the config file and KYRN_JUDGE_MODE. */
	mode?: DecisionMode;
	/** Use this instead of reading kyrn.json and the environment. */
	config?: KyrnConfig;
	/** How the `delegate` tool runs a sub-agent. Defaults to a child pi process. */
	swarmRunner?: SwarmRunner;
	/** Register only these features, e.g. `["browser"]` for the browser alone on a stock pi. Default: all of them. */
	only?: readonly FeatureName[];
	/** Extra catalog entries, for embedding and tests. Whoever passes them registers their tools. */
	capabilities?: readonly Capability[];
	/**
	 * The home folder whose Claude Code, Cursor and Codex setup is inherited, and the agent directory mu keeps its
	 * state in. Default: the real ones, unless `config` or `provider` was injected, in which case no home is read.
	 */
	roots?: HarnessRoots;
	/** For tests of the MCP feature. */
	mcp?: McpFeatureOptions;
	/** For tests of the checkpoint feature: how git is run. */
	checkpoint?: CheckpointDeps;
}

export type FeatureName =
	| "interjection"
	| "preflight"
	| "frame"
	| "memory"
	| "skills"
	| "catalog"
	| "guard"
	| "constraints"
	| "goal"
	| "ttsr"
	| "admission"
	| "forgetting"
	| "compaction"
	| "monitor"
	| "lsp"
	| "completion"
	| "checkpoint"
	| "notify"
	| "warming"
	| "swarm"
	| "hive"
	| "tools"
	| "browser"
	| "inherit"
	| "mcp"
	| "background"
	| "web"
	| "packs";

export function createKyrnJudgeExtension(options: KyrnJudgeExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => registerKyrn(pi, options);
}

export default function kyrnJudgeExtension(pi: ExtensionAPI): void {
	registerKyrn(pi, {});
}

function registerKyrn(pi: ExtensionAPI, options: KyrnJudgeExtensionOptions): void {
	// An injected provider or config means the caller owns the setup: do not read the user's files.
	const loaded =
		options.config || options.provider
			? { config: options.config ?? DEFAULT_CONFIG, disabled: false, problem: undefined }
			: loadConfig({ dir: getAgentDir(), env: process.env });
	// KYRN_JUDGE=off keeps the CLI (welcome screen, commands) and asks nothing: every decision is off.
	const config: KyrnConfig = loaded.disabled
		? { ...loaded.config, tiers: ["mock"], modes: { default: "off" } }
		: options.mode
			? { ...loaded.config, modes: { ...loaded.config.modes, default: options.mode } }
			: loaded.config;

	const runtime = new KyrnRuntime(
		pi,
		config,
		options.provider ? new Judge({ provider: options.provider }) : undefined,
		loaded.problem,
	);
	runtime.enabled = !loaded.disabled;
	runtime.onPresentation = options.onPresentation;
	for (const capability of options.capabilities ?? []) runtime.catalog.register(capability);
	registerWelcome(runtime);
	if (loaded.disabled) {
		registerCommands(runtime);
		return;
	}

	// A sub-agent first of all listens to its parent: a wrap-up request has to be known before anything else reacts to a step.
	if (process.env.KYRN_SWARM_CONTROL) registerSwarmChild(runtime, process.env.KYRN_SWARM_CONTROL);

	// Whoever injected a provider or a config owns the setup, and that includes not reading the user's home folder.
	const roots: HarnessRoots | undefined =
		options.roots ?? (options.config || options.provider ? undefined : { home: homedir(), agentDir: getAgentDir() });

	// Order matters where two features share an event: interjection must see a
	// mid-run message before anything else, and preflight must set the turn's
	// gear before memory and skills read it.
	const features: readonly [FeatureName, (runtime: KyrnRuntime) => void][] = [
		["interjection", registerInterjection],
		["preflight", registerPreflight],
		// Right after preflight, which counts the turns: the frame has to be current before anything reads it.
		["frame", registerFrame],
		["memory", registerMemory],
		["skills", registerSkills],
		// Registered before the features that add capabilities, and that is fine: it reads the catalog when a turn starts.
		["catalog", registerCatalog],
		["guard", registerGuard],
		["constraints", registerConstraints],
		["admission", registerAdmission],
		["forgetting", registerForgetting],
		["compaction", registerCompaction],
		["monitor", registerMonitor],
		["ttsr", registerTtsr],
		// Before the goal and completion checks: errors an edit introduced are said before "verify your change" is.
		["lsp", registerLsp],
		["goal", registerGoal],
		["completion", registerCompletion],
		// After the guard and the monitor: a blocked call needs no checkpoint, and the monitor's trouble is what the rewind hears.
		["checkpoint", (shared) => registerCheckpoint(shared, roots, options.checkpoint)],
		["notify", registerNotify],
		["warming", registerWarming],
		["swarm", (shared) => registerSwarm(shared, options.swarmRunner)],
		["hive", (shared) => registerHive(shared, options.swarmRunner)],
		["tools", registerTools],
		["browser", registerBrowser],
		["inherit", (shared) => registerInherit(shared, roots)],
		["mcp", (shared) => registerMcp(shared, roots, options.mcp)],
		["background", registerBackground],
		["web", registerWeb],
		["packs", registerPacks],
	];
	for (const [name, register] of features) {
		if (!options.only || options.only.includes(name)) register(runtime);
	}
	registerCommands(runtime);
}
