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
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Capability } from "../catalog/catalog.ts";
import { DEFAULT_CONFIG, type KyrnConfig, loadConfig } from "../config.ts";
import type { DecisionMode } from "../decision.ts";
import { Judge } from "../judge.ts";
import type { JudgeProvider } from "../types.ts";
import { registerAdmission } from "./features/admission.ts";
import { registerBrowser } from "./features/browser.ts";
import { registerCatalog } from "./features/catalog.ts";
import { registerCommands } from "./features/commands.ts";
import { registerCompaction } from "./features/compaction.ts";
import { registerCompletion } from "./features/completion.ts";
import { registerConstraints } from "./features/constraints.ts";
import { registerForgetting } from "./features/forgetting.ts";
import { registerFrame } from "./features/frame.ts";
import { registerGoal } from "./features/goal.ts";
import { registerGuard } from "./features/guard.ts";
import { registerHive } from "./features/hive.ts";
import { registerInterjection } from "./features/interjection.ts";
import { registerMemory } from "./features/memory.ts";
import { registerMonitor } from "./features/monitor.ts";
import { registerNotify } from "./features/notify.ts";
import { registerPreflight } from "./features/preflight.ts";
import { registerSkills } from "./features/skills.ts";
import { registerSwarm, type SwarmRunner } from "./features/swarm.ts";
import { registerSwarmChild } from "./features/swarm-child.ts";
import { registerTools } from "./features/tools.ts";
import { registerWarming } from "./features/warming.ts";
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
	| "admission"
	| "forgetting"
	| "compaction"
	| "monitor"
	| "completion"
	| "notify"
	| "warming"
	| "swarm"
	| "hive"
	| "tools"
	| "browser";

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
		["goal", registerGoal],
		["completion", registerCompletion],
		["notify", registerNotify],
		["warming", registerWarming],
		["swarm", (shared) => registerSwarm(shared, options.swarmRunner)],
		["hive", (shared) => registerHive(shared, options.swarmRunner)],
		["tools", registerTools],
		["browser", registerBrowser],
	];
	for (const [name, register] of features) {
		if (!options.only || options.only.includes(name)) register(runtime);
	}
	registerCommands(runtime);
}
