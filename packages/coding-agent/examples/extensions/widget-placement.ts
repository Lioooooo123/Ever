import type { ExtensionAPI } from "@lioooooo123/ever-cli";

export default function widgetPlacementExtension(ever: ExtensionAPI) {
	ever.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("widget-above", ["Above editor widget"]);
		ctx.ui.setWidget("widget-below", ["Below editor widget"], { placement: "belowEditor" });
	});
}
