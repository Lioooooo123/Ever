import type { InlineExtension } from "../core/extensions/types.ts";
import goalExtension from "./goal.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "goal", factory: goalExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
];
