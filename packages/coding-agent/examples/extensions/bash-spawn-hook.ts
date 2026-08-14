/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   ever -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@lioooooo123/ever-cli";
import { createBashTool } from "@lioooooo123/ever-cli";

export default function (ever: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, EVER_SPAWN_HOOK: "1" },
		}),
	});

	ever.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
