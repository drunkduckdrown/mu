import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Provider } from "@earendil-works/pi-ai";
// pi itself: its sources in a checkout (run through tsx), its own bundle's index in the npm package (kyrn/npm/build.mjs).
import { defaultModelPerProvider, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { featureOptions, loadConfig } from "../config.ts";
import { antigravityProvider, geminiCliProvider } from "../google-login/providers.ts";
import { muEnv, muHome } from "../naming.ts";
import { runAuth } from "./runner.ts";

/**
 * The entry of `mu auth` (see runner.ts), which kyrn/bin/mu.mjs starts: through tsx in a checkout, as
 * judge/dist/auth.js in the npm package. The agent directory is the one every part of mu uses: MU_AGENT_DIR,
 * which the launcher sets, else ~/.mu/agent.
 */
const agentDir = muEnv("AGENT_DIR") || join(muHome(), "agent");
const say = (message: Readonly<Record<string, unknown>>) => process.stdout.write(`${JSON.stringify(message)}\n`);

/**
 * The Google sign-ins are mu's, offered while its googleLogin feature is on, which is read from the user's mu.json
 * the way a session reads it. Should they fail to load, pi's own sign-ins still work.
 */
function googleProviders(): Provider[] {
	try {
		const loaded = loadConfig({ dir: agentDir, env: process.env });
		if (loaded.disabled) return [];
		const options = featureOptions(loaded.config, "googleLogin", {
			enabled: true,
			geminiCli: true,
			antigravity: true,
		});
		if (!options.enabled) return [];
		return [
			...(options.geminiCli ? [geminiCliProvider()] : []),
			...(options.antigravity ? [antigravityProvider()] : []),
		];
	} catch {
		return [];
	}
}

async function main(): Promise<number> {
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		refreshOnCreate: false,
	});
	return runAuth(process.argv.slice(2), {
		runtime,
		preferred: defaultModelPerProvider,
		extra: googleProviders(),
		io: {
			say,
			listen: (line, end) => {
				const lines = createInterface({ input: process.stdin });
				lines.on("line", line);
				lines.on("close", end);
			},
		},
	});
}

// Exits once the answer is out: a sign-in's callback server or an idle connection must not keep the process alive.
main().then(
	(code) => process.exit(code),
	(error: unknown) => {
		say({ type: "error", message: error instanceof Error ? error.message : String(error) });
		process.exit(1);
	},
);
