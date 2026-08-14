import type { Api, Model } from "@lioooooo123/ever-ai";
import { describe, expect, it } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	modelWorstCaseCostUsd,
	reviewerWorstCaseCostUsd,
	selectReviewerModel,
} from "../src/core/reviewer-model-selector.ts";

function model(id: string, input: number, output: number): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input, output, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_000,
		maxTokens: 1_000,
	};
}

function providerModel(provider: string, id: string, input: number, output: number): Model<Api> {
	return { ...model(id, input, output), provider };
}

function runtime(models: Model<Api>[]): ModelRuntime {
	return {
		getAvailableSnapshot: () => models,
		getModel: (provider: string, id: string) =>
			models.find((candidate) => candidate.provider === provider && candidate.id === id),
		hasConfiguredAuth: (provider: string) => provider === "test",
	} as unknown as ModelRuntime;
}

describe("reviewer model selection", () => {
	it("selects the cheapest authenticated eligible model by worst-case reviewer cost", () => {
		const expensive = model("expensive", 5, 15);
		const cheap = model("cheap", 0.1, 0.4);
		expect(selectReviewerModel({ runtime: runtime([expensive, cheap]) })).toBe(cheap);
		expect(reviewerWorstCaseCostUsd(cheap)).toBeLessThan(reviewerWorstCaseCostUsd(expensive));
	});

	it("honors an explicit Task model before workspace or global configuration", () => {
		const task = model("task", 1, 1);
		const workspace = model("workspace", 0.1, 0.1);
		expect(
			selectReviewerModel({
				runtime: runtime([task, workspace]),
				task: { provider: "test", model: "task" },
				workspaceOrGlobal: { provider: "test", model: "workspace" },
			}),
		).toBe(task);
	});

	it("keeps automatic selection on the main Agent provider", () => {
		const sameProvider = providerModel("test", "same-provider", 1, 1);
		const cheaperOtherProvider = providerModel("other", "other-provider", 0, 0);
		expect(
			selectReviewerModel({
				runtime: runtime([sameProvider, cheaperOtherProvider]),
				preferredProvider: "test",
			}),
		).toBe(sameProvider);
	});

	it("rejects automatic candidates without finite pricing", () => {
		const invalid = model("invalid-pricing", Number.NaN, 1);
		expect(() => selectReviewerModel({ runtime: runtime([invalid]) })).toThrow("No authenticated reviewer model");
	});

	it("does not apply a long-context pricing tier to the bounded reviewer request", () => {
		const tiered = model("tiered", 0.2, 1.2);
		tiered.cost.cacheRead = 0.02;
		tiered.cost.cacheWrite = 0.25;
		tiered.cost.tiers = [
			{
				inputTokensAbove: 272_000,
				input: 0.4,
				output: 1.8,
				cacheRead: 0.04,
				cacheWrite: 0.5,
			},
		];

		expect(reviewerWorstCaseCostUsd(tiered)).toBe(0.0012072);
	});

	it("uses the highest pricing tier whose threshold the reviewer input exceeds", () => {
		const tiered = model("tiered", 0.2, 1.2);
		tiered.cost.tiers = [
			{ inputTokensAbove: 1_000, input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0 },
			{ inputTokensAbove: 1_500, input: 0.4, output: 1.8, cacheRead: 0, cacheWrite: 0 },
		];

		expect(reviewerWorstCaseCostUsd(tiered)).toBe((2_000 * 0.4 + 256 * 1.8) / 1_000_000);
	});

	it("keeps the base rate at an exact tier threshold", () => {
		const tiered = model("tiered", 0.2, 1.2);
		tiered.cost.tiers = [{ inputTokensAbove: 2_000, input: 0.4, output: 1.8, cacheRead: 0, cacheWrite: 0 }];

		expect(modelWorstCaseCostUsd(tiered, 2_000, 256)).toBe((2_000 * 0.2 + 256 * 1.2) / 1_000_000);
		expect(modelWorstCaseCostUsd(tiered, 2_001, 256)).toBe((2_001 * 0.4 + 256 * 1.8) / 1_000_000);
	});

	it("never selects the main Agent model automatically", () => {
		const main = model("main", 0.01, 0.01);
		const reviewer = model("reviewer", 0.1, 0.1);
		expect(
			selectReviewerModel({
				runtime: runtime([main, reviewer]),
				excludedAutomaticModel: { provider: "test", model: "main" },
			}),
		).toBe(reviewer);
	});
});
