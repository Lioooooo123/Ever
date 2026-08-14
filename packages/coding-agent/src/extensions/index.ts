import type { InlineExtension } from "../core/extensions/types.ts";
import flowExtension from "./flow.ts";
import goalExtension from "./goal.ts";
import llamaExtension from "./llama/index.ts";
import sessionMessagingExtension from "./session-messaging.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "goal", factory: goalExtension, hidden: true },
	{ name: "flow", factory: flowExtension, hidden: true },
	{ name: "session-messaging", factory: sessionMessagingExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
];
