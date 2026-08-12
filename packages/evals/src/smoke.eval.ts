import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createEverCodingAgentHarness } from "./ever-harness.ts";

const everCodingAgentHarness = createEverCodingAgentHarness({ noTools: "all" });

describeEval("Ever Coding Agent smoke", { harness: everCodingAgentHarness }, (it) => {
	it("runs a basic prompt end to end", async ({ run }) => {
		const result = await run("What's the capital of France? Respond with only the city name.");

		expect(result.output.trim()).toBe("Paris");
		expect(result.errors).toEqual([]);
		expect(result.usage.provider).toBe(process.env.EVER_PROVIDER);
		expect(result.usage.model).toBe(process.env.EVER_MODEL);
		expect(result.usage.totalTokens).toBeGreaterThan(0);
	});
});
