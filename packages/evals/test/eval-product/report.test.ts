import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertEvalJobId, assertEvalJobIndex, listEvalJobs, writeEvalJobIndex } from "../../src/eval-product/job.ts";
import { formatEvalOverview, persistEvalOverview } from "../../src/eval-product/report.ts";
import { type EvalJobManifest, LongTaskArtifactStore } from "../../src/long-task-evals/artifacts.ts";
import type { EvalRunResult } from "../../src/long-task-evals/schemas.ts";

const roots: string[] = [];
const digest = (character: string): string => character.repeat(64);

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("unified Eval reports", () => {
	it("normalizes a quick Ever Agent job and persists a common report", async () => {
		const root = await mkdtemp(join(tmpdir(), "eval-product-"));
		roots.push(root);
		const jobId = "quick-job";
		const jobDirectory = join(root, jobId);
		await writeEvalJobIndex(jobDirectory, {
			schemaVersion: 1,
			jobId,
			profile: "quick",
			createdAt: "2026-08-11T00:00:00.000Z",
			model: { provider: "openai", id: "model-2026-08-11" },
		});
		await writeFile(
			join(jobDirectory, "runs.jsonl"),
			`${[
				JSON.stringify({
					test: { status: "passed" },
					usage: { totalTokens: 10, metadata: { estimatedCostUsd: 0.01 } },
					timings: { totalMs: 100 },
				}),
				JSON.stringify({
					test: { status: "failed" },
					usage: { totalTokens: 20, metadata: { estimatedCostUsd: 0.02 } },
					timings: { totalMs: 300 },
				}),
				JSON.stringify({
					test: { status: "passed" },
					evaluation: { outcome: "scored", score: 0 },
					usage: {},
				}),
			].join("\n")}\n`,
		);
		await writeFile(join(jobDirectory, "comparison.md"), "Quick detail\n");

		const report = await persistEvalOverview(root, jobId);
		expect(report.summary).toEqual({
			totalRuns: 3,
			successfulRuns: 1,
			failedRuns: 2,
			incompleteRuns: 0,
			medianWallTimeMs: 200,
			totalTokens: 30,
			totalEstimatedCostUsd: 0.03,
		});
		expect(formatEvalOverview(report)).toContain("Profile: quick");
		expect(formatEvalOverview(report)).toContain("Quick detail");
		expect(JSON.parse(await readFile(join(jobDirectory, "report.json"), "utf8"))).toMatchObject({
			schemaVersion: 1,
			job: { jobId, profile: "quick" },
		});
	});

	it("normalizes official benchmark results without mixing invalid trials into failures", async () => {
		const root = await mkdtemp(join(tmpdir(), "eval-product-"));
		roots.push(root);
		const jobId = "benchmark-job";
		const benchmark = { name: "terminal-bench", version: "2.1", source: "local", resolvedDigest: digest("a") };
		const agent = {
			name: "ever",
			version: "1.0.0",
			executableDigest: digest("b"),
			modelProvider: "openai",
			modelId: "model-2026-08-11",
			configurationDigest: digest("c"),
		};
		const manifest: EvalJobManifest = {
			schemaVersion: 1,
			jobId,
			createdAt: "2026-08-11T00:00:00.000Z",
			benchmark,
			agents: [agent],
			caseIds: ["case-1"],
			repetitions: 1,
			maxCostUsd: 1,
		};
		const store = new LongTaskArtifactStore(root, jobId);
		await store.initialize(manifest);
		await writeEvalJobIndex(store.jobDirectory, {
			schemaVersion: 1,
			jobId,
			profile: "benchmark",
			createdAt: manifest.createdAt,
			model: { provider: agent.modelProvider, id: agent.modelId },
		});
		const base: EvalRunResult = {
			schemaVersion: 1,
			runId: "run-1",
			caseId: "case-1",
			repetition: 1,
			benchmark,
			agent,
			environment: { kind: "docker", imageDigest: "sha256:image", platform: "linux/arm64", network: "none" },
			outcome: "completed",
			official: { valid: true, metrics: { reward: 1 }, verifierExitCode: 0 },
			usage: { wallTimeMs: 500, totalTokens: 100, estimatedCostUsd: 0.1 },
			integrity: {
				environmentDigest: "sha256:image",
				instructionDigest: digest("d"),
				verifierDigest: digest("e"),
				artifactsDigest: digest("f"),
				violations: [],
			},
			artifacts: [],
			errors: [],
		};
		await store.appendResult(base);
		await store.appendResult({
			...base,
			runId: "run-2",
			outcome: "infrastructure_error",
			official: { valid: false, metrics: {} },
		});

		const report = await persistEvalOverview(root, jobId);
		expect(report.summary).toEqual({
			totalRuns: 2,
			successfulRuns: 1,
			failedRuns: 0,
			incompleteRuns: 1,
			medianWallTimeMs: 500,
			totalTokens: 100,
			totalEstimatedCostUsd: 0.1,
		});
	});

	it("lists both profiles and rejects path-like job IDs", async () => {
		const root = await mkdtemp(join(tmpdir(), "eval-product-"));
		roots.push(root);
		await writeEvalJobIndex(join(root, "quick-job"), {
			schemaVersion: 1,
			jobId: "quick-job",
			profile: "quick",
			createdAt: "2026-08-11T00:00:00.000Z",
		});
		await writeEvalJobIndex(join(root, "benchmark-job"), {
			schemaVersion: 1,
			jobId: "benchmark-job",
			profile: "benchmark",
			createdAt: "2026-08-11T01:00:00.000Z",
		});

		expect((await listEvalJobs(root)).map((job) => job.profile)).toEqual(["benchmark", "quick"]);
		expect(() =>
			assertEvalJobIndex({
				schemaVersion: 1,
				jobId: "../escape",
				profile: "quick",
				createdAt: "2026-08-11T00:00:00.000Z",
			}),
		).toThrow("EvalJobIndex");
		for (const jobId of [".", "..", "../escape", "/absolute", "nested/job"]) {
			expect(() => assertEvalJobId(jobId)).toThrow("Invalid Eval job ID");
		}
		expect(() => new LongTaskArtifactStore(root, "../escape")).toThrow("Invalid Eval job ID");
	});

	it("uses long-horizon verdicts and appends the dedicated report", async () => {
		const root = await mkdtemp(join(tmpdir(), "eval-product-"));
		roots.push(root);
		const jobId = "long-horizon-job";
		const benchmark = { name: "elhb", version: "1.0.0", source: "local", resolvedDigest: digest("a") };
		const agent = {
			name: "ever",
			version: "1.0.0",
			executableDigest: digest("b"),
			modelProvider: "openai",
			modelId: "model-2026-08-11",
			configurationDigest: digest("c"),
		};
		const store = new LongTaskArtifactStore(root, jobId);
		await store.initialize({
			schemaVersion: 1,
			jobId,
			createdAt: "2026-08-13T00:00:00.000Z",
			benchmark,
			agents: [agent],
			caseIds: ["case-1"],
			repetitions: 1,
			maxCostUsd: 1,
		});
		await writeEvalJobIndex(store.jobDirectory, {
			schemaVersion: 1,
			jobId,
			profile: "long-horizon",
			createdAt: "2026-08-13T00:00:00.000Z",
			model: { provider: agent.modelProvider, id: agent.modelId },
		});
		const result: EvalRunResult = {
			schemaVersion: 1,
			runId: "run-1",
			caseId: "case-1",
			repetition: 1,
			benchmark,
			agent,
			environment: { kind: "docker", imageDigest: "sha256:image", platform: "linux/arm64", network: "none" },
			outcome: "unknown_outcome",
			official: { valid: true, metrics: { reward: 1 } },
			usage: { wallTimeMs: 500 },
			integrity: {
				environmentDigest: "sha256:image",
				instructionDigest: digest("d"),
				verifierDigest: digest("e"),
				artifactsDigest: digest("f"),
				violations: [],
			},
			longHorizon: {
				planId: digest("1"),
				pairId: digest("2"),
				lane: "resilience",
				variant: "fault",
				scenarioId: "fail-closed",
				valid: true,
				verdict: { capabilityPass: false, safetyPass: true, terminalSemanticsPass: true },
				recovery: {
					triggerMatched: true,
					faultApplied: true,
					recoveryCount: 0,
					duplicateSideEffects: 0,
					forbiddenReplays: 0,
					unknownToolOutcomes: 1,
				},
				verifier: { started: true, completed: true, reportDigest: digest("3") },
				scoreStateDigest: digest("4"),
			},
			artifacts: [],
			errors: [{ source: "ever", code: "unknown_outcome", message: "expected" }],
		};
		await store.appendResult({
			...result,
			runId: "run-infrastructure-retry",
			outcome: "infrastructure_error",
			official: { valid: false, metrics: {} },
			longHorizon: {
				...result.longHorizon!,
				valid: false,
				invalidReason: "infrastructure_error",
			},
		});
		await store.appendResult(result);
		await writeFile(join(store.jobDirectory, "long-horizon-report.md"), "Continuity 1/1, invalid 0\n");

		const report = await persistEvalOverview(root, jobId);
		expect(report.summary).toMatchObject({ totalRuns: 1, successfulRuns: 1, failedRuns: 0, incompleteRuns: 0 });
		expect(report.detailReport).toContain("Continuity 1/1");
	});
});
