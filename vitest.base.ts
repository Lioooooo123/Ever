import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	agentNode: fileURLToPath(new URL("./packages/agent/src/node.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	longTasksIndex: fileURLToPath(new URL("./packages/long-tasks/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@lioooooo123\/ever-telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@lioooooo123\/ever-telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@lioooooo123\/ever-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@lioooooo123\/ever-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@lioooooo123\/ever-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@lioooooo123\/ever-ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@lioooooo123\/ever-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@lioooooo123\/ever-agent-core\/node$/, replacement: workspaceSourcePaths.agentNode },
			{ find: /^@lioooooo123\/ever-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			{ find: /^@lioooooo123\/ever-long-tasks$/, replacement: workspaceSourcePaths.longTasksIndex },
		],
	},
});
