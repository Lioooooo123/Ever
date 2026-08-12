import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30000,
			// Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts.
			env: { EVER_OFFLINE: "1" },
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
		resolve: {
			alias: [
				{
					find: /^@lioooooo123\/ever-long-tasks$/,
					replacement: fileURLToPath(new URL("../long-tasks/src/index.ts", import.meta.url)),
				},
				{
					find: /^@lioooooo123\/ever-client$/,
					replacement: fileURLToPath(new URL("../client/src/index.ts", import.meta.url)),
				},
				{
					find: /^@lioooooo123\/ever-protocol$/,
					replacement: fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
				},
				{ find: /^@lioooooo123\/ever-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@lioooooo123\/ever-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
				{ find: /^@lioooooo123\/ever-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@lioooooo123\/ever-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			],
		},
	}),
);
