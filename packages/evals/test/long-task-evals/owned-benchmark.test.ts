import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertLongHorizonTask,
	assertLongHorizonVerifierReport,
	OwnedLongHorizonBenchmarkAdapter,
} from "../../src/long-task-evals/owned-benchmark.ts";

const benchmarkRoot = resolve(import.meta.dirname, "../../benchmarks/long-horizon-v1");

describe("OwnedLongHorizonBenchmarkAdapter", () => {
	it("loads the development suite with pinned task metadata", async () => {
		const adapter = new OwnedLongHorizonBenchmarkAdapter(benchmarkRoot);
		const cases = await adapter.listCases("dev");
		expect(cases.map((testCase) => testCase.id)).toEqual([
			"repo-schema-migration",
			"durable-pipeline-resume",
			"side-effect-reconciliation",
		]);
		for (const testCase of cases) {
			expect(["none", "benchmark_declared"]).toContain(testCase.environment.network);
			expect(testCase.metadata.calibrationStatus).toBe("development_proxy");
			expect(testCase.metadata.taskDigest).toMatch(/^[a-f0-9]{64}$/);
			expect(testCase.metadata.verifierDigest).toMatch(/^[a-f0-9]{64}$/);
		}
	});

	it("rejects unknown suites", async () => {
		const adapter = new OwnedLongHorizonBenchmarkAdapter(benchmarkRoot);
		await expect(adapter.listCases("missing")).rejects.toThrow("Unknown long-horizon suite");
	});
});

describe("long-horizon schemas", () => {
	it("rejects task paths that escape the task root", () => {
		expect(() =>
			assertLongHorizonTask({
				schemaVersion: 1,
				id: "bad",
				version: "1.0.0",
				family: "test",
				instructionPath: "../instruction.md",
				environment: {
					buildContext: "environment",
					workingDirectory: "/app",
					network: "none",
					platforms: ["linux/arm64"],
					cpu: 1,
					memoryMb: 128,
					pids: 16,
				},
				calibration: { status: "development_proxy", successfulBaselines: 0, medianActiveMinutes: 0 },
				limits: { trialTimeoutSeconds: 1, verifierTimeoutSeconds: 1, maxTurns: 1, maxCostUsd: 1 },
				verification: { objective: ["a"], regression: ["b"], safety: ["c"], integrity: ["d"] },
				scenarios: [],
				metadata: { expertise: ["test"], stages: ["a", "b", "c"], canary: "canary-long-enough" },
			}),
		).toThrow("Invalid long-horizon task");
	});

	it("requires completed structured verifier reports", () => {
		expect(() =>
			assertLongHorizonVerifierReport({ schemaVersion: 1, started: true, completed: false, components: {} }),
		).toThrow("Invalid long-horizon verifier report");
	});
});
