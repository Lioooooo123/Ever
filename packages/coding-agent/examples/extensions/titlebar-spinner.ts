/**
 * Titlebar Spinner Extension
 *
 * Shows a braille spinner animation in the terminal title while the agent is working.
 * Uses `ctx.ui.setTitle()` to update the terminal title via the extension API.
 *
 * Usage:
 *   ever --extension examples/extensions/titlebar-spinner.ts
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@lioooooo123/ever";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getBaseTitle(ever: ExtensionAPI): string {
	const cwd = path.basename(process.cwd());
	const session = ever.getSessionName();
	return session ? `Ever - ${session} - ${cwd}` : `Ever - ${cwd}`;
}

export default function (ever: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;

	function stopAnimation(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		ctx.ui.setTitle(getBaseTitle(ever));
	}

	function startAnimation(ctx: ExtensionContext) {
		stopAnimation(ctx);
		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			const cwd = path.basename(process.cwd());
			const session = ever.getSessionName();
			const title = session ? `${frame} Ever - ${session} - ${cwd}` : `${frame} Ever - ${cwd}`;
			ctx.ui.setTitle(title);
			frameIndex++;
		}, 80);
	}

	ever.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	ever.on("agent_end", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	ever.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});
}
