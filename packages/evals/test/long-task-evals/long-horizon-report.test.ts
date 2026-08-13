import { describe, expect, it } from "vitest";
import { summarizeLongHorizonResults } from "../../src/long-task-evals/long-horizon-report.ts";
import type { EvalRunResult } from "../../src/long-task-evals/schemas.ts";

function result(repetition: number, valid = true): EvalRunResult {
	return {
		schemaVersion: 1,
		runId: `run-${repetition}`,
		caseId: "task-1",
		repetition,
		benchmark: { name: "elhb", version: "1.0.0", source: "local", resolvedDigest: "a".repeat(64) },
		agent: {
			name: "ever",
			version: "1.0.0",
			executableDigest: "b".repeat(64),
			modelProvider: "openai",
			modelId: "exact-model",
			configurationDigest: "c".repeat(64),
		},
		environment: {
			kind: "docker",
			imageDigest: "sha256:native",
			platform: "linux/arm64",
			network: "none",
		},
		outcome: "completed",
		official: { valid, metrics: { reward: valid ? 1 : 0 } },
		usage: { wallTimeMs: 100 },
		integrity: {
			environmentDigest: "sha256:native",
			instructionDigest: "d".repeat(64),
			verifierDigest: "e".repeat(64),
			artifactsDigest: "f".repeat(64),
			violations: [],
		},
		longHorizon: {
			planId: String(repetition).repeat(64),
			lane: "capability",
			variant: "standard",
			valid,
			...(valid ? {} : { invalidReason: "verifier_invalid" }),
			verdict: { capabilityPass: valid, safetyPass: valid },
			recovery: {
				triggerMatched: false,
				faultApplied: false,
				recoveryCount: 0,
				duplicateSideEffects: 0,
				forbiddenReplays: 0,
				unknownToolOutcomes: 0,
			},
			verifier: { started: true, completed: valid, reportDigest: "1".repeat(64) },
			scoreStateDigest: "2".repeat(64),
		},
		artifacts: [],
		errors: [],
	};
}

describe("long-horizon report", () => {
	it("includes denominators, invalid counts, pass@1, and pass^3", () => {
		const report = summarizeLongHorizonResults([result(1), result(2), result(3)], {
			suite: "full",
			lane: "capability",
			repetitions: 3,
		});
		expect(report.rates.capability).toEqual({ passed: 3, valid: 3, invalid: 0, total: 3, rate: 1 });
		expect(report.rates.passAt1.rate).toBe(1);
		expect(report.rates.passPower3.rate).toBe(1);
	});

	it("rejects silent benchmark version merges", () => {
		const changed = { ...result(2), benchmark: { ...result(2).benchmark, version: "1.1.0" } };
		expect(() =>
			summarizeLongHorizonResults([result(1), changed], {
				suite: "full",
				lane: "capability",
				repetitions: 3,
			}),
		).toThrow("different benchmark versions");
	});

	it("aggregates pass@1 by task and requires three distinct repetitions for pass^3", () => {
		const scenarioA = result(1);
		const scenarioB = {
			...result(1),
			runId: "scenario-b",
			longHorizon: {
				...result(1).longHorizon!,
				planId: "3".repeat(64),
				verdict: { capabilityPass: false, safetyPass: true },
			},
		};
		const report = summarizeLongHorizonResults([scenarioA, scenarioB], {
			suite: "dev",
			lane: "resilience",
			repetitions: 1,
		});
		expect(report.rates.passAt1).toEqual({ passed: 0, valid: 1, invalid: 0, total: 1, rate: 0 });
		expect(report.rates.passPower3.total).toBe(0);
	});

	it("treats an expected fail-closed fault as no paired degradation", () => {
		const noFault = {
			...result(1),
			longHorizon: { ...result(1).longHorizon!, pairId: "pair", variant: "no_fault" as const },
		};
		const fault = {
			...result(1),
			runId: "fault",
			outcome: "unknown_outcome" as const,
			longHorizon: {
				...result(1).longHorizon!,
				pairId: "pair",
				variant: "fault" as const,
				verdict: { capabilityPass: false, safetyPass: true, terminalSemanticsPass: true },
			},
		};
		const report = summarizeLongHorizonResults([noFault, fault], {
			suite: "dev",
			lane: "resilience",
			repetitions: 1,
		});
		expect(report.pairedFaultDegradation).toBe(0);
	});
});
