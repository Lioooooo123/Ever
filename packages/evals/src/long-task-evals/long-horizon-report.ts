import type { EvalRunResult } from "./schemas.ts";

export interface RateSummary {
	passed: number;
	valid: number;
	invalid: number;
	total: number;
	rate?: number;
}

export interface LongHorizonReport {
	schemaVersion: 1;
	benchmark: { name: string; version: string; digest: string };
	agent: { name: string; provider: string; model: string; configurationDigest: string };
	header: { suite: string; lane: "capability" | "resilience"; repetitions: number };
	rates: {
		capability: RateSummary;
		safety: RateSummary;
		continuity: RateSummary;
		terminalSemantics: RateSummary;
		passAt1: RateSummary;
		passPower3: RateSummary;
	};
	pairedFaultDegradation?: number;
	recoveryLatencyMs?: { median: number; p95: number };
	resources: {
		wallTimeMs: { median: number; p95: number };
		totalTokens?: { median: number; p95: number };
		estimatedCostUsd?: { median: number; p95: number };
	};
	duplicateSideEffects: number;
	forbiddenReplays: number;
	terminalStates: Record<string, number>;
	invalidReasons: Record<string, number>;
	platforms: Record<string, number>;
	imageDigests: Record<string, number>;
}

function rate(results: readonly EvalRunResult[], predicate: (result: EvalRunResult) => boolean): RateSummary {
	const valid = results.filter((result) => result.longHorizon?.valid === true);
	const passed = valid.filter(predicate).length;
	return {
		passed,
		valid: valid.length,
		invalid: results.length - valid.length,
		total: results.length,
		...(valid.length === 0 ? {} : { rate: passed / valid.length }),
	};
}

function percentile(values: number[], quantile: number): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(sorted.length * quantile) - 1];
}

function counts(values: readonly string[]): Record<string, number> {
	const result: Record<string, number> = {};
	for (const value of values) result[value] = (result[value] ?? 0) + 1;
	return result;
}

function distribution(values: number[]): { median: number; p95: number } | undefined {
	const median = percentile(values, 0.5);
	const p95 = percentile(values, 0.95);
	return median === undefined || p95 === undefined ? undefined : { median, p95 };
}

interface TaskScore {
	valid: boolean;
	passed: boolean;
}

function trialPassed(result: EvalRunResult): boolean {
	const verdict = result.longHorizon!.verdict;
	if (verdict.terminalSemanticsPass !== undefined) return verdict.terminalSemanticsPass;
	if (verdict.continuityPass !== undefined) return verdict.continuityPass && verdict.safetyPass;
	return verdict.capabilityPass && verdict.safetyPass;
}

function aggregateTaskScores(results: readonly EvalRunResult[]): TaskScore[] {
	const grouped = new Map<string, EvalRunResult[]>();
	for (const result of results) {
		const taskResults = grouped.get(result.caseId) ?? [];
		taskResults.push(result);
		grouped.set(result.caseId, taskResults);
	}
	return [...grouped.values()].map((taskResults) => ({
		valid: taskResults.every((result) => result.longHorizon!.valid),
		passed: taskResults.every(trialPassed),
	}));
}

function taskRate(scores: readonly TaskScore[]): RateSummary {
	const valid = scores.filter((score) => score.valid);
	const passed = valid.filter((score) => score.passed).length;
	return {
		passed,
		valid: valid.length,
		invalid: scores.length - valid.length,
		total: scores.length,
		...(valid.length === 0 ? {} : { rate: passed / valid.length }),
	};
}

export function summarizeLongHorizonResults(
	results: readonly EvalRunResult[],
	header: LongHorizonReport["header"],
): LongHorizonReport {
	if (results.length === 0) throw new Error("Long-horizon report requires results");
	if (results.some((result) => result.longHorizon === undefined))
		throw new Error("Long-horizon report cannot mix generic benchmark results");
	const first = results[0]!;
	for (const result of results) {
		if (
			result.benchmark.resolvedDigest !== first.benchmark.resolvedDigest ||
			result.benchmark.version !== first.benchmark.version
		) {
			throw new Error("Long-horizon results from different benchmark versions cannot be merged");
		}
		if (JSON.stringify(result.agent) !== JSON.stringify(first.agent))
			throw new Error("Long-horizon results from different agent identities cannot be merged");
	}
	const continuity = results.filter((result) => result.longHorizon!.verdict.continuityPass !== undefined);
	const terminal = results.filter((result) => result.longHorizon!.verdict.terminalSemanticsPass !== undefined);
	const scoreBearing = results.filter((result) => result.longHorizon!.variant !== "no_fault");
	const firstRuns = aggregateTaskScores(scoreBearing.filter((result) => result.repetition === 1));
	const byTask = new Map<string, EvalRunResult[]>();
	for (const result of scoreBearing) {
		const taskResults = byTask.get(result.caseId) ?? [];
		taskResults.push(result);
		byTask.set(result.caseId, taskResults);
	}
	const power3: TaskScore[] = [];
	for (const taskResults of byTask.values()) {
		if (new Set(taskResults.map((result) => result.repetition)).size < 3) continue;
		const fixedRepetitions = taskResults.filter((result) => result.repetition <= 3);
		power3.push({
			valid: fixedRepetitions.every((result) => result.longHorizon!.valid),
			passed: fixedRepetitions.every(trialPassed),
		});
	}
	const paired = new Map<string, { noFault?: EvalRunResult; fault?: EvalRunResult }>();
	for (const result of results) {
		const pairId = result.longHorizon!.pairId;
		if (pairId === undefined) continue;
		const pair = paired.get(pairId) ?? {};
		if (result.longHorizon!.variant === "no_fault") pair.noFault = result;
		if (result.longHorizon!.variant === "fault") pair.fault = result;
		paired.set(pairId, pair);
	}
	const degradations = [...paired.values()]
		.filter((pair) => pair.noFault?.longHorizon?.valid && pair.fault?.longHorizon?.valid)
		.map((pair) => Number(trialPassed(pair.noFault!)) - Number(trialPassed(pair.fault!)));
	const latencies = results
		.map((result) => result.longHorizon!.recovery.recoveryLatencyMs)
		.filter((value) => value !== undefined);
	const medianLatency = percentile(latencies, 0.5);
	const p95Latency = percentile(latencies, 0.95);
	const wallTime = distribution(results.map((result) => result.usage.wallTimeMs))!;
	const totalTokens = distribution(
		results.map((result) => result.usage.totalTokens).filter((value) => value !== undefined),
	);
	const estimatedCostUsd = distribution(
		results.map((result) => result.usage.estimatedCostUsd).filter((value) => value !== undefined),
	);
	return {
		schemaVersion: 1,
		benchmark: {
			name: first.benchmark.name,
			version: first.benchmark.version,
			digest: first.benchmark.resolvedDigest,
		},
		agent: {
			name: first.agent.name,
			provider: first.agent.modelProvider,
			model: first.agent.modelId,
			configurationDigest: first.agent.configurationDigest,
		},
		header,
		rates: {
			capability: rate(results, (result) => result.longHorizon!.verdict.capabilityPass),
			safety: rate(results, (result) => result.longHorizon!.verdict.safetyPass),
			continuity: rate(continuity, (result) => result.longHorizon!.verdict.continuityPass === true),
			terminalSemantics: rate(terminal, (result) => result.longHorizon!.verdict.terminalSemanticsPass === true),
			passAt1: taskRate(firstRuns),
			passPower3: taskRate(power3),
		},
		...(degradations.length === 0
			? {}
			: { pairedFaultDegradation: degradations.reduce((sum, value) => sum + value, 0) / degradations.length }),
		...(medianLatency === undefined || p95Latency === undefined
			? {}
			: { recoveryLatencyMs: { median: medianLatency, p95: p95Latency } }),
		resources: {
			wallTimeMs: wallTime,
			...(totalTokens === undefined ? {} : { totalTokens }),
			...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
		},
		duplicateSideEffects: results.reduce((sum, result) => sum + result.longHorizon!.recovery.duplicateSideEffects, 0),
		forbiddenReplays: results.reduce((sum, result) => sum + result.longHorizon!.recovery.forbiddenReplays, 0),
		terminalStates: counts(results.map((result) => result.outcome)),
		invalidReasons: counts(
			results.map((result) => result.longHorizon!.invalidReason).filter((value) => value !== undefined),
		),
		platforms: counts(results.map((result) => result.environment.platform)),
		imageDigests: counts(results.map((result) => result.environment.imageDigest)),
	};
}

function formatRate(label: string, summary: RateSummary): string {
	return `| ${label} | ${summary.passed}/${summary.valid} | ${summary.invalid} | ${summary.total} | ${summary.rate === undefined ? "n/a" : `${(summary.rate * 100).toFixed(1)}%`} |`;
}

export function formatLongHorizonReport(report: LongHorizonReport): string {
	return `${[
		"# Ever Long-Horizon Benchmark Report",
		"",
		`- Benchmark: ${report.benchmark.name} ${report.benchmark.version} (${report.benchmark.digest})`,
		`- Suite/lane: ${report.header.suite}/${report.header.lane}`,
		`- Agent/model: ${report.agent.name} ${report.agent.provider}/${report.agent.model}`,
		`- Repetitions: ${report.header.repetitions}`,
		"",
		"| Dimension | Passed / valid | Invalid | Total | Rate |",
		"|---|---:|---:|---:|---:|",
		formatRate("Capability", report.rates.capability),
		formatRate("Safety", report.rates.safety),
		formatRate("Continuity", report.rates.continuity),
		formatRate("Terminal semantics", report.rates.terminalSemantics),
		formatRate("Pass@1", report.rates.passAt1),
		formatRate("Pass^3", report.rates.passPower3),
		"",
		`- Paired fault degradation: ${report.pairedFaultDegradation ?? "unavailable"}`,
		`- Recovery latency median/P95: ${report.recoveryLatencyMs ? `${report.recoveryLatencyMs.median}/${report.recoveryLatencyMs.p95} ms` : "unavailable"}`,
		`- Duplicate side effects: ${report.duplicateSideEffects}`,
		`- Forbidden replays: ${report.forbiddenReplays}`,
		`- Wall time median/P95: ${report.resources.wallTimeMs.median}/${report.resources.wallTimeMs.p95} ms`,
		`- Tokens median/P95: ${report.resources.totalTokens ? `${report.resources.totalTokens.median}/${report.resources.totalTokens.p95}` : "unavailable"}`,
		`- Cost median/P95: ${report.resources.estimatedCostUsd ? `${report.resources.estimatedCostUsd.median}/${report.resources.estimatedCostUsd.p95} USD` : "unavailable"}`,
		`- Native platforms: ${Object.entries(report.platforms)
			.map(([platform, count]) => `${platform} (${count})`)
			.join(", ")}`,
		`- Image digests: ${Object.keys(report.imageDigests).join(", ")}`,
	].join("\n")}\n`;
}
