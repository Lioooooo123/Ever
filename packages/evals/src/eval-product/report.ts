import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExternalEvalTrialResult } from "../external-evals/schemas.ts";
import { LongTaskArtifactStore } from "../long-task-evals/artifacts.ts";
import { selectEffectiveLongHorizonResults } from "../long-task-evals/effective-results.ts";
import { assertEvalJobId, type EvalJobIndex, readEvalJobIndex } from "./job.ts";

export interface EvalOverviewReport {
	schemaVersion: 1;
	job: EvalJobIndex;
	summary: {
		totalRuns: number;
		successfulRuns: number;
		failedRuns: number;
		incompleteRuns: number;
		medianWallTimeMs?: number;
		totalTokens?: number;
		totalEstimatedCostUsd?: number;
	};
	detailReport?: string;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle];
}

async function optionalText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function loadQuickReport(jobDirectory: string, job: EvalJobIndex): Promise<EvalOverviewReport> {
	const runsText = (await optionalText(join(jobDirectory, "runs.jsonl"))) ?? "";
	const runs = runsText
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line, index) => {
			try {
				return JSON.parse(line) as unknown;
			} catch {
				throw new Error(`Invalid quick Eval result at runs.jsonl:${index + 1}`);
			}
		});
	let successfulRuns = 0;
	let failedRuns = 0;
	let incompleteRuns = 0;
	const wallTimes: number[] = [];
	const tokens: number[] = [];
	const costs: number[] = [];
	for (const run of runs) {
		if (typeof run !== "object" || run === null || Array.isArray(run))
			throw new Error("Invalid quick Eval run record");
		const evaluation = Reflect.get(run, "evaluation");
		const evaluationOutcome =
			typeof evaluation === "object" && evaluation !== null ? Reflect.get(evaluation, "outcome") : undefined;
		const evaluationScore =
			typeof evaluation === "object" && evaluation !== null ? finite(Reflect.get(evaluation, "score")) : undefined;
		const test = Reflect.get(run, "test");
		const status = typeof test === "object" && test !== null ? Reflect.get(test, "status") : undefined;
		if (evaluationOutcome === "scored" && evaluationScore !== undefined) {
			if (evaluationScore >= 1) successfulRuns += 1;
			else failedRuns += 1;
		} else if (evaluationOutcome === "errored") incompleteRuns += 1;
		else if (status === "passed") successfulRuns += 1;
		else if (status === "failed") failedRuns += 1;
		else incompleteRuns += 1;
		const usage = Reflect.get(run, "usage");
		if (typeof usage === "object" && usage !== null) {
			const totalTokens = finite(Reflect.get(usage, "totalTokens"));
			if (totalTokens !== undefined) tokens.push(totalTokens);
			const metadata = Reflect.get(usage, "metadata");
			if (typeof metadata === "object" && metadata !== null) {
				const cost = finite(Reflect.get(metadata, "estimatedCostUsd"));
				if (cost !== undefined) costs.push(cost);
			}
		}
		const timings = Reflect.get(run, "timings");
		if (typeof timings === "object" && timings !== null) {
			const wallTime = finite(Reflect.get(timings, "totalMs"));
			if (wallTime !== undefined) wallTimes.push(wallTime);
		}
	}
	const medianWallTimeMs = median(wallTimes);
	const detailReport = await optionalText(join(jobDirectory, "comparison.md"));
	return {
		schemaVersion: 1,
		job,
		summary: {
			totalRuns: runs.length,
			successfulRuns,
			failedRuns,
			incompleteRuns,
			...(medianWallTimeMs === undefined ? {} : { medianWallTimeMs }),
			...(tokens.length === 0 ? {} : { totalTokens: tokens.reduce((total, value) => total + value, 0) }),
			...(costs.length === 0 ? {} : { totalEstimatedCostUsd: costs.reduce((total, value) => total + value, 0) }),
		},
		...(detailReport === undefined ? {} : { detailReport }),
	};
}

async function loadBenchmarkReport(jobDirectory: string, job: EvalJobIndex): Promise<EvalOverviewReport> {
	const results = await new LongTaskArtifactStore(resolve(jobDirectory, "..").toString(), job.jobId).loadResults();
	const valid = results.filter((result) => result.official.valid);
	const failedRuns = valid.filter((result) => (result.official.metrics.reward ?? 0) < 1).length;
	const wallTimes = valid.map((result) => result.usage.wallTimeMs);
	const tokens = valid.map((result) => result.usage.totalTokens).filter((value) => value !== undefined);
	const costs = valid.map((result) => result.usage.estimatedCostUsd).filter((value) => value !== undefined);
	const medianWallTimeMs = median(wallTimes);
	const detailReport = await optionalText(join(jobDirectory, "comparison.md"));
	return {
		schemaVersion: 1,
		job,
		summary: {
			totalRuns: results.length,
			successfulRuns: valid.length - failedRuns,
			failedRuns,
			incompleteRuns: results.length - valid.length,
			...(medianWallTimeMs === undefined ? {} : { medianWallTimeMs }),
			...(tokens.length === 0 ? {} : { totalTokens: tokens.reduce((total, value) => total + value, 0) }),
			...(costs.length === 0 ? {} : { totalEstimatedCostUsd: costs.reduce((total, value) => total + value, 0) }),
		},
		...(detailReport === undefined ? {} : { detailReport }),
	};
}

async function loadLongHorizonReport(jobDirectory: string, job: EvalJobIndex): Promise<EvalOverviewReport> {
	const attempts = await new LongTaskArtifactStore(resolve(jobDirectory, "..").toString(), job.jobId).loadResults();
	const results = selectEffectiveLongHorizonResults(attempts);
	const valid = results.filter((result) => result.longHorizon?.valid === true);
	const successfulRuns = valid.filter((result) => {
		const verdict = result.longHorizon!.verdict;
		if (verdict.terminalSemanticsPass !== undefined) return verdict.terminalSemanticsPass;
		if (verdict.continuityPass !== undefined) return verdict.continuityPass && verdict.safetyPass;
		return verdict.capabilityPass && verdict.safetyPass;
	}).length;
	const wallTimes = valid.map((result) => result.usage.wallTimeMs);
	const tokens = valid.map((result) => result.usage.totalTokens).filter((value) => value !== undefined);
	const costs = valid.map((result) => result.usage.estimatedCostUsd).filter((value) => value !== undefined);
	const medianWallTimeMs = median(wallTimes);
	const detailReport = await optionalText(join(jobDirectory, "long-horizon-report.md"));
	return {
		schemaVersion: 1,
		job,
		summary: {
			totalRuns: results.length,
			successfulRuns,
			failedRuns: valid.length - successfulRuns,
			incompleteRuns: results.length - valid.length,
			...(medianWallTimeMs === undefined ? {} : { medianWallTimeMs }),
			...(tokens.length === 0 ? {} : { totalTokens: tokens.reduce((total, value) => total + value, 0) }),
			...(costs.length === 0 ? {} : { totalEstimatedCostUsd: costs.reduce((total, value) => total + value, 0) }),
		},
		...(detailReport === undefined ? {} : { detailReport }),
	};
}

async function loadExternalReport(jobDirectory: string, job: EvalJobIndex): Promise<EvalOverviewReport> {
	const value = JSON.parse(await readFile(join(jobDirectory, "external-results.json"), "utf8")) as unknown;
	if (!Array.isArray(value)) throw new Error("Invalid external-results.json");
	const results = value as ExternalEvalTrialResult[];
	const config = JSON.parse(await readFile(join(jobDirectory, "external-config.json"), "utf8")) as {
		acceptance?: { metrics?: Record<string, number> };
	};
	const thresholds = config.acceptance?.metrics ?? {};
	const successfulRuns = results.filter(
		(result) =>
			result.completed &&
			Object.entries(thresholds).every(
				([name, threshold]) => (result.metrics[name] ?? Number.NEGATIVE_INFINITY) >= threshold,
			),
	).length;
	const incompleteRuns = results.filter((result) => !result.completed).length;
	const wallTimes = results.map((result) => result.wallTimeMs).filter((value) => value !== undefined);
	const tokens = results
		.map((result) =>
			result.inputTokens === undefined && result.outputTokens === undefined
				? undefined
				: (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
		)
		.filter((value) => value !== undefined);
	const costs = results.map((result) => result.costUsd).filter((value) => value !== undefined);
	const medianWallTimeMs = median(wallTimes);
	return {
		schemaVersion: 1,
		job,
		summary: {
			totalRuns: results.length,
			successfulRuns,
			failedRuns: results.length - successfulRuns - incompleteRuns,
			incompleteRuns,
			...(medianWallTimeMs === undefined ? {} : { medianWallTimeMs }),
			...(tokens.length === 0 ? {} : { totalTokens: tokens.reduce((total, value) => total + value, 0) }),
			...(costs.length === 0 ? {} : { totalEstimatedCostUsd: costs.reduce((total, value) => total + value, 0) }),
		},
	};
}

export async function loadEvalOverview(artifactRoot: string, jobId: string): Promise<EvalOverviewReport> {
	assertEvalJobId(jobId);
	const jobDirectory = join(resolve(artifactRoot), jobId);
	const job = await readEvalJobIndex(jobDirectory);
	if (job.profile === "quick") return await loadQuickReport(jobDirectory, job);
	if (job.profile === "external") return await loadExternalReport(jobDirectory, job);
	if (job.profile === "long-horizon") return await loadLongHorizonReport(jobDirectory, job);
	return await loadBenchmarkReport(jobDirectory, job);
}

export function formatEvalOverview(report: EvalOverviewReport): string {
	const { job, summary } = report;
	const lines = [
		`# Eval Report: ${job.jobId}`,
		"",
		`- Profile: ${job.profile}`,
		`- Created: ${job.createdAt}`,
		`- Model: ${job.model === undefined ? "not recorded" : `${job.model.provider}/${job.model.id}`}`,
		`- Runs: ${summary.totalRuns}`,
		`- Successful: ${summary.successfulRuns}`,
		`- Failed: ${summary.failedRuns}`,
		`- Incomplete: ${summary.incompleteRuns}`,
		`- Median wall time: ${summary.medianWallTimeMs === undefined ? "unavailable" : `${summary.medianWallTimeMs.toFixed(0)} ms`}`,
		`- Total tokens: ${summary.totalTokens ?? "unavailable"}`,
		`- Estimated cost: ${summary.totalEstimatedCostUsd === undefined ? "unavailable" : `$${summary.totalEstimatedCostUsd.toFixed(4)}`}`,
	];
	if (report.detailReport?.trim()) lines.push("", report.detailReport.trim());
	return `${lines.join("\n")}\n`;
}

export async function persistEvalOverview(artifactRoot: string, jobId: string): Promise<EvalOverviewReport> {
	assertEvalJobId(jobId);
	const report = await loadEvalOverview(artifactRoot, jobId);
	const jobDirectory = join(resolve(artifactRoot), jobId);
	await writeFile(join(jobDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
	await writeFile(join(jobDirectory, "report.md"), formatEvalOverview(report), { mode: 0o600 });
	return report;
}
