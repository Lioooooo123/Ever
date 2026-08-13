import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertHumanBaselineRecord, auditTaskCalibration } from "../../src/long-task-evals/calibration.ts";
import type { LongHorizonTask } from "../../src/long-task-evals/owned-benchmark.ts";

const roots: string[] = [];
const task = {
	id: "task-1",
	version: "1.0.0",
	calibration: { status: "human_calibrated", successfulBaselines: 1, medianActiveMinutes: 130 },
} as LongHorizonTask;

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function baseline() {
	return {
		schemaVersion: 1,
		taskId: "task-1",
		taskVersion: "1.0.0",
		benchmarkVersion: "1.0.0",
		participantId: "a".repeat(64),
		independent: true,
		professional: true,
		successful: true,
		activeMinutes: 130,
		blockedMinutes: 10,
		startedAt: "2026-08-13T00:00:00.000Z",
		completedAt: "2026-08-13T03:00:00.000Z",
		environment: "linux/arm64",
		evidenceDigest: "b".repeat(64),
		recordedBy: "reviewer",
	};
}

describe("human calibration gate", () => {
	it("rejects author estimates shorter than two hours", () => {
		expect(() => assertHumanBaselineRecord({ ...baseline(), activeMinutes: 119 })).toThrow(
			"Invalid human baseline record",
		);
	});

	it("requires both human evidence and two-reviewer quality evidence", async () => {
		const root = await mkdtemp(join(tmpdir(), "elhb-calibration-"));
		roots.push(root);
		await mkdir(join(root, "baselines"));
		await writeFile(join(root, "baselines", "human-1.json"), JSON.stringify(baseline()));
		await writeFile(
			join(root, "baselines", "quality-review.json"),
			JSON.stringify({
				schemaVersion: 1,
				taskId: "task-1",
				taskVersion: "1.0.0",
				reviewers: ["reviewer-one", "reviewer-two"],
				coherentDependencyChain: true,
				oracleThreeRepetitionsAllPlatforms: true,
				objectiveMutationCaught: true,
				regressionMutationCaught: true,
				duplicateEffectMutationCaught: true,
				missingEventMutationCaught: true,
				rewardHackingFindings: [],
				leakageFindings: [],
				reviewedAt: "2026-08-13T00:00:00.000Z",
			}),
		);
		expect(await auditTaskCalibration(root, task, "1.0.0")).toEqual({
			ready: true,
			successfulBaselines: 1,
			medianActiveMinutes: 130,
			reasons: [],
		});
	});
});
