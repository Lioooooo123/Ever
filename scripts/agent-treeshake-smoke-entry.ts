import { Agent } from "@lioooooo123/ever-agent-core";
import { createModels } from "@lioooooo123/ever-ai";
import { anthropicProvider } from "@lioooooo123/ever-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Anthropic smoke-test model not found");

export const agent = new Agent({
	initialState: { model },
	streamFn: models.streamSimple.bind(models),
});
