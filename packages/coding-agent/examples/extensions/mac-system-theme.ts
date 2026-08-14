/**
 * Syncs ever theme with macOS system appearance (dark/light mode).
 *
 * Usage:
 *   ever -e examples/extensions/mac-system-theme.ts
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@lioooooo123/ever-cli";

const execAsync = promisify(exec);

async function isDarkMode(): Promise<boolean> {
	try {
		const { stdout } = await execAsync(
			"osascript -e 'tell application \"System Events\" to tell appearance preferences to return dark mode'",
		);
		return stdout.trim() === "true";
	} catch {
		return false;
	}
}

export default function (ever: ExtensionAPI) {
	let intervalId: ReturnType<typeof setInterval> | null = null;

	ever.on("session_start", async (_event, ctx) => {
		let currentTheme = (await isDarkMode()) ? "dark" : "light";
		ctx.ui.setTheme(currentTheme);

		intervalId = setInterval(async () => {
			const newTheme = (await isDarkMode()) ? "dark" : "light";
			if (newTheme !== currentTheme) {
				currentTheme = newTheme;
				ctx.ui.setTheme(currentTheme);
			}
		}, 2000);
	});

	ever.on("session_shutdown", () => {
		if (intervalId) {
			clearInterval(intervalId);
			intervalId = null;
		}
	});
}
