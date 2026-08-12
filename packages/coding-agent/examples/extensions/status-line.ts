/**
 * Status Line Extension
 *
 * Demonstrates ctx.ui.setStatus() for displaying persistent status text in the footer.
 * Shows turn progress with themed colors.
 */

import type { ExtensionAPI } from "@lioooooo123/ever";

export default function (ever: ExtensionAPI) {
	let turnCount = 0;

	ever.on("session_start", async (_event, ctx) => {
		const theme = ctx.ui.theme;
		ctx.ui.setStatus("status-demo", theme.fg("dim", "Ready"));
	});

	ever.on("turn_start", async (_event, ctx) => {
		turnCount++;
		const theme = ctx.ui.theme;
		const spinner = theme.fg("accent", "●");
		const text = theme.fg("dim", ` Turn ${turnCount}...`);
		ctx.ui.setStatus("status-demo", spinner + text);
	});

	ever.on("turn_end", async (_event, ctx) => {
		const theme = ctx.ui.theme;
		const check = theme.fg("success", "✓");
		const text = theme.fg("dim", ` Turn ${turnCount} complete`);
		ctx.ui.setStatus("status-demo", check + text);
	});
}
