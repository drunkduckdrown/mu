import type { BeforeAgentStartEvent, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { capabilityDisclosure } from "../../decisions/capability-disclosure.ts";
import { run } from "../../packs/exec.ts";
import { failOpen, type KyrnRuntime } from "../runtime.ts";
import { CAPABILITY_ENTRY } from "./catalog.ts";
import { astGrepPack } from "./packs/ast-grep.ts";
import { githubPack } from "./packs/github.ts";
import type { Pack, PackShared } from "./packs/pack.ts";

/**
 * Capability packs: installed with mu, out of the model's sight until a task
 * needs one. Each is one `judged` entry of the capability catalog, and its
 * tools are only registered when it is opened, so a closed pack costs the
 * model nothing. What a pack needs from the machine (ast-grep, git, gh) is
 * looked for at that moment too: a missing program is an install hint to
 * whoever opened the pack, never an error at start-up.
 *
 * The commands a pack brings (`/review`, `/commit`) are the user's and are
 * always there. They open their pack themselves.
 */
export function registerPacks(runtime: KyrnRuntime): void {
	const options = runtime.options("packs", {
		enabled: true,
		astGrep: true,
		/** Matches `sg_search` returns unless the call asks for another number. */
		maxResults: 50,
		/** Characters of diff one tool result carries at most. */
		maxDiffChars: 12000,
		/** Empty: `ast-grep`, then `sg`, from PATH. */
		astGrepCommand: "",
		github: true,
		/** Empty: `gh` from PATH. */
		ghCommand: "",
	});
	if (!options.enabled) return;
	const { pi, catalog } = runtime;

	const shared: PackShared = {
		runtime,
		run,
		platform: process.platform,
		cwd: () => runtime.ctx?.cwd ?? process.cwd(),
		open: async (id) => {
			if (!(await catalog.open(id, "user", runtime.userTurns))) return;
			const capability = catalog.get(id);
			pi.appendEntry(CAPABILITY_ENTRY, { id, by: "user", turn: runtime.userTurns });
			runtime.present("capability.opened", { id, by: "user", title: capability?.title, tools: capability?.tools });
		},
	};

	const packs: Pack[] = [];
	if (options.astGrep) {
		packs.push(
			astGrepPack(shared, {
				command: options.astGrepCommand,
				maxResults: options.maxResults,
				maxDiffChars: options.maxDiffChars,
			}),
		);
	}

	if (options.github) packs.push(githubPack(shared, { command: options.ghCommand }));

	const starting = new Map<string, Promise<void>>();
	const start = (pack: Pack): Promise<void> => {
		let pending = starting.get(pack.id);
		if (!pending) {
			pending = pack.start();
			starting.set(pack.id, pending);
			// A program that is not installed today may be tomorrow: the next opening looks again.
			pending.catch(() => starting.delete(pack.id));
		}
		return pending;
	};

	for (const pack of packs) {
		catalog.register({
			id: pack.id,
			kind: "pack",
			title: pack.title,
			description: pack.description,
			tools: pack.tools,
			exposure: "judged",
			activate: () => start(pack),
		});
	}

	// With disclosure off, or no catalog at all, nothing is hidden and nobody opens anything: the tools
	// have to be there from the start. A pack whose program is missing simply stays out.
	const startAllWhenNothingIsHidden = async (ctx: ExtensionContext): Promise<undefined> => {
		runtime.touch(ctx);
		if (runtime.mode(capabilityDisclosure.id) === "off" || runtime.config.features.catalog === false) {
			await Promise.allSettled(packs.map(start));
		}
		return undefined;
	};
	// A skill travels with its pack from the start: hidden or not, the skill disclosure decision covers it.
	const skills = packs.flatMap((pack) => pack.skills ?? []);
	pi.on(
		"resources_discover",
		failOpen(() => (skills.length > 0 ? { skillPaths: skills } : undefined)),
	);

	pi.on(
		"session_start",
		failOpen<SessionStartEvent, undefined>((_event, ctx) => startAllWhenNothingIsHidden(ctx)),
	);
	pi.on(
		"before_agent_start",
		failOpen<BeforeAgentStartEvent, undefined>((_event, ctx) => startAllWhenNothingIsHidden(ctx)),
	);
}
