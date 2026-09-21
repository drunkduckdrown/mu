import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

// The extension test drives a real AgentSession through coding-agent's faux-provider
// harness, so workspace packages must resolve to their sources like they do there.
export default mergeConfig(
	baseConfig,
	defineConfig({
		resolve: {
			// The extension imports runtime values from pi, which the base config does not alias.
			alias: [{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex }],
		},
		test: {
			environment: "node",
			testTimeout: 30000,
			env: { PI_OFFLINE: "1" },
			unstubEnvs: true,
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
	}),
);
