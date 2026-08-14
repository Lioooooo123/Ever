import type { Api, Model } from "@lioooooo123/ever-ai";
import type { ModelRuntime } from "./model-runtime.ts";

export interface ReviewerModelIdentity {
	provider: string;
	model: string;
}

const REVIEWER_CONTEXT_TOKENS = 8_000;
const REVIEWER_INPUT_TOKENS = 2_000;
const REVIEWER_OUTPUT_TOKENS = 256;

export function reviewerWorstCaseCostUsd(
	model: Pick<Model<Api>, "contextWindow" | "cost" | "maxTokens">,
	outputTokens = REVIEWER_OUTPUT_TOKENS,
): number {
	const rates = [model.cost, ...(model.cost.tiers ?? [])];
	if (
		rates.some((rate) =>
			[rate.input, rate.output, rate.cacheRead, rate.cacheWrite].some(
				(value) => !Number.isFinite(value) || value < 0,
			),
		)
	)
		throw new Error("Reviewer model pricing is incomplete");
	const inputRate = Math.max(...rates.map((rate) => Math.max(rate.input + rate.cacheWrite, rate.cacheRead)));
	const outputRate = Math.max(...rates.map((rate) => rate.output));
	return (REVIEWER_INPUT_TOKENS * inputRate + outputTokens * outputRate) / 1_000_000;
}

function hasReliablePricing(model: Pick<Model<Api>, "contextWindow" | "cost" | "maxTokens">): boolean {
	try {
		reviewerWorstCaseCostUsd(model);
		return true;
	} catch {
		return false;
	}
}

function requireConfiguredModel(runtime: ModelRuntime, identity: ReviewerModelIdentity): Model<Api> {
	const model = runtime.getModel(identity.provider, identity.model);
	if (!model) throw new Error(`Configured reviewer model was not found: ${identity.provider}/${identity.model}`);
	if (!runtime.hasConfiguredAuth(model.provider))
		throw new Error(`Configured reviewer model has no credentials: ${identity.provider}/${identity.model}`);
	if (
		!model.input.includes("text") ||
		model.contextWindow < REVIEWER_CONTEXT_TOKENS ||
		model.maxTokens < REVIEWER_OUTPUT_TOKENS
	)
		throw new Error(`Configured reviewer model is too small: ${identity.provider}/${identity.model}`);
	reviewerWorstCaseCostUsd(model);
	return model;
}

/** Selects a fixed reviewer model without consulting the main Agent. */
export function selectReviewerModel(options: {
	runtime: ModelRuntime;
	task?: ReviewerModelIdentity;
	workspaceOrGlobal?: ReviewerModelIdentity;
	preferredProvider?: string;
	excludedAutomaticModel?: ReviewerModelIdentity;
}): Model<Api> {
	const configured = options.task ?? options.workspaceOrGlobal;
	if (configured) return requireConfiguredModel(options.runtime, configured);
	const eligible = options.runtime
		.getAvailableSnapshot()
		.filter(
			(model) =>
				(options.preferredProvider === undefined || model.provider === options.preferredProvider) &&
				(model.provider !== options.excludedAutomaticModel?.provider ||
					model.id !== options.excludedAutomaticModel.model) &&
				model.input.includes("text") &&
				model.contextWindow >= REVIEWER_CONTEXT_TOKENS &&
				model.maxTokens >= REVIEWER_OUTPUT_TOKENS &&
				hasReliablePricing(model),
		)
		.sort(
			(left, right) =>
				reviewerWorstCaseCostUsd(left) - reviewerWorstCaseCostUsd(right) ||
				`${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`),
		);
	const selected = eligible[0];
	if (!selected) throw new Error("No authenticated reviewer model satisfies the reviewer token limits");
	return selected;
}
