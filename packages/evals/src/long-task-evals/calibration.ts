import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { hashDirectory } from "./hash.ts";
import type { LongHorizonTask } from "./owned-benchmark.ts";

export const HumanBaselineRecordSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		taskId: Type.String({ minLength: 1 }),
		taskVersion: Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+$" }),
		benchmarkVersion: Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+$" }),
		participantId: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		independent: Type.Literal(true),
		professional: Type.Literal(true),
		successful: Type.Literal(true),
		activeMinutes: Type.Number({ minimum: 120 }),
		blockedMinutes: Type.Number({ minimum: 0 }),
		startedAt: Type.String({ minLength: 1 }),
		completedAt: Type.String({ minLength: 1 }),
		environment: Type.String({ minLength: 1 }),
		evidenceDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		recordedBy: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export const TaskQualityReviewSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		taskId: Type.String({ minLength: 1 }),
		taskVersion: Type.String({ minLength: 1 }),
		reviewers: Type.Array(Type.String({ minLength: 1 }), { minItems: 2, uniqueItems: true }),
		coherentDependencyChain: Type.Literal(true),
		oracleThreeRepetitionsAllPlatforms: Type.Literal(true),
		objectiveMutationCaught: Type.Literal(true),
		regressionMutationCaught: Type.Literal(true),
		duplicateEffectMutationCaught: Type.Literal(true),
		missingEventMutationCaught: Type.Literal(true),
		rewardHackingFindings: Type.Array(Type.Never(), { maxItems: 0 }),
		leakageFindings: Type.Array(Type.Never(), { maxItems: 0 }),
		reviewedAt: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export type HumanBaselineRecord = Static<typeof HumanBaselineRecordSchema>;
export type TaskQualityReview = Static<typeof TaskQualityReviewSchema>;

const baselineValidator = Compile(HumanBaselineRecordSchema);
const qualityValidator = Compile(TaskQualityReviewSchema);

function assertDateOrder(record: HumanBaselineRecord): void {
	const start = Date.parse(record.startedAt);
	const end = Date.parse(record.completedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
		throw new Error("Human baseline timestamps must be valid and increasing");
}

export function assertHumanBaselineRecord(value: unknown): asserts value is HumanBaselineRecord {
	if (!baselineValidator.Check(value)) {
		const detail = [...baselineValidator.Errors(value)]
			.slice(0, 5)
			.map((error) => `${error.instancePath || "/"}: ${error.message}`)
			.join("; ");
		throw new TypeError(`Invalid human baseline record: ${detail}`);
	}
	assertDateOrder(value);
}

export function assertTaskQualityReview(value: unknown): asserts value is TaskQualityReview {
	if (qualityValidator.Check(value)) return;
	const detail = [...qualityValidator.Errors(value)]
		.slice(0, 5)
		.map((error) => `${error.instancePath || "/"}: ${error.message}`)
		.join("; ");
	throw new TypeError(`Invalid task quality review: ${detail}`);
}

export interface CalibrationAudit {
	ready: boolean;
	successfulBaselines: number;
	medianActiveMinutes?: number;
	reasons: string[];
}

function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle];
}

export async function auditTaskCalibration(
	taskRoot: string,
	task: LongHorizonTask,
	benchmarkVersion: string,
): Promise<CalibrationAudit> {
	const reasons: string[] = [];
	const baselineRoot = join(taskRoot, "baselines");
	let files: string[] = [];
	try {
		files = (await readdir(baselineRoot)).filter((name) => name.endsWith(".json") && name !== "quality-review.json");
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	const records: HumanBaselineRecord[] = [];
	for (const file of files) {
		const value = JSON.parse(await readFile(join(baselineRoot, file), "utf8")) as unknown;
		assertHumanBaselineRecord(value);
		if (value.taskId !== task.id || value.taskVersion !== task.version || value.benchmarkVersion !== benchmarkVersion)
			reasons.push(`baseline_version_mismatch:${file}`);
		else records.push(value);
	}
	let review: TaskQualityReview | undefined;
	try {
		const value = JSON.parse(await readFile(join(baselineRoot, "quality-review.json"), "utf8")) as unknown;
		assertTaskQualityReview(value);
		review = value;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") reasons.push("quality_review_missing");
		else throw error;
	}
	const medianActiveMinutes = median(records.map((record) => record.activeMinutes));
	if (records.length < 1) reasons.push("independent_successful_baseline_missing");
	if (medianActiveMinutes === undefined || medianActiveMinutes < 120)
		reasons.push("median_active_time_below_120_minutes");
	if (review !== undefined && (review.taskId !== task.id || review.taskVersion !== task.version))
		reasons.push("quality_review_version_mismatch");
	if (task.calibration.status !== "human_calibrated") reasons.push("task_not_marked_human_calibrated");
	if (task.calibration.successfulBaselines !== records.length) reasons.push("baseline_count_mismatch");
	if (task.calibration.medianActiveMinutes !== (medianActiveMinutes ?? 0)) reasons.push("baseline_median_mismatch");
	return {
		ready: reasons.length === 0,
		successfulBaselines: records.length,
		...(medianActiveMinutes === undefined ? {} : { medianActiveMinutes }),
		reasons,
	};
}

export async function calibrationEvidenceDigest(taskRoot: string): Promise<string> {
	return await hashDirectory(join(taskRoot, "baselines"));
}
