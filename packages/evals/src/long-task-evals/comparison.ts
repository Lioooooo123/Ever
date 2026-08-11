import type { EvalRunResult } from "./schemas.ts";

export interface AgentComparison {
	agent: string;
	validRuns: number;
	incompleteRuns: number;
	meanReward?: number;
	passRate?: number;
	passAt1?: number;
	medianWallTimeMs?: number;
	p95WallTimeMs?: number;
	medianTotalTokens?: number;
	medianEstimatedCostUsd?: number;
	timeoutRate: number;
	infrastructureErrorRate: number;
}

function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle];
}

function percentile(values: number[], quantile: number): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(quantile * sorted.length) - 1];
}

export function summarizeResults(results: readonly EvalRunResult[]): AgentComparison[] {
	const byAgent = new Map<string, EvalRunResult[]>();
	for (const result of results) {
		const values = byAgent.get(result.agent.name) ?? [];
		values.push(result);
		byAgent.set(result.agent.name, values);
	}
	return [...byAgent.entries()]
		.map(([agent, agentResults]) => {
			const valid = agentResults.filter((result) => result.official.valid);
			const rewards = valid.map((result) => result.official.metrics.reward).filter((value) => value !== undefined);
			const firstAttempts = valid.filter((result) => result.repetition === 1);
			const firstRewards = firstAttempts
				.map((result) => result.official.metrics.reward)
				.filter((value) => value !== undefined);
			const totalTokens = valid.map((result) => result.usage.totalTokens).filter((value) => value !== undefined);
			const costs = valid.map((result) => result.usage.estimatedCostUsd).filter((value) => value !== undefined);
			const wallTimes = valid.map((result) => result.usage.wallTimeMs);
			const medianWallTimeMs = median(wallTimes);
			const p95WallTimeMs = percentile(wallTimes, 0.95);
			return {
				agent,
				validRuns: valid.length,
				incompleteRuns: agentResults.length - valid.length,
				timeoutRate: agentResults.filter((result) => result.outcome === "timed_out").length / agentResults.length,
				infrastructureErrorRate:
					agentResults.filter((result) => result.outcome === "infrastructure_error").length / agentResults.length,
				...(rewards.length === 0
					? {}
					: {
							meanReward: rewards.reduce((total, value) => total + value, 0) / rewards.length,
							passRate: rewards.filter((value) => value >= 1).length / rewards.length,
						}),
				...(firstRewards.length === 0
					? {}
					: { passAt1: firstRewards.filter((value) => value >= 1).length / firstRewards.length }),
				...(medianWallTimeMs === undefined ? {} : { medianWallTimeMs }),
				...(p95WallTimeMs === undefined ? {} : { p95WallTimeMs }),
				...(median(totalTokens) === undefined ? {} : { medianTotalTokens: median(totalTokens) }),
				...(median(costs) === undefined ? {} : { medianEstimatedCostUsd: median(costs) }),
			};
		})
		.sort((left, right) => left.agent.localeCompare(right.agent));
}

export function formatComparisonMarkdown(comparisons: readonly AgentComparison[]): string {
	const lines = [
		"# Long-task Eval Comparison",
		"",
		"| Agent | Valid | Incomplete | Mean reward | Pass@1 | Success rate | Median / P95 wall | Median tokens | Median cost | Timeout | Infra error |",
		"|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
	];
	for (const item of comparisons) {
		lines.push(
			`| ${item.agent} | ${item.validRuns} | ${item.incompleteRuns} | ${item.meanReward?.toFixed(4) ?? "n/a"} | ${item.passAt1 === undefined ? "n/a" : `${(item.passAt1 * 100).toFixed(1)}%`} | ${item.passRate === undefined ? "n/a" : `${(item.passRate * 100).toFixed(1)}%`} | ${item.medianWallTimeMs?.toFixed(0) ?? "n/a"} / ${item.p95WallTimeMs?.toFixed(0) ?? "n/a"} ms | ${item.medianTotalTokens?.toFixed(0) ?? "n/a"} | ${item.medianEstimatedCostUsd === undefined ? "n/a" : `$${item.medianEstimatedCostUsd.toFixed(4)}`} | ${(item.timeoutRate * 100).toFixed(1)}% | ${(item.infrastructureErrorRate * 100).toFixed(1)}% |`,
		);
	}
	return `${lines.join("\n")}\n`;
}
