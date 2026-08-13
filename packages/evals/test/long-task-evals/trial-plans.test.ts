import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertLongHorizonTask, OwnedLongHorizonBenchmarkAdapter } from "../../src/long-task-evals/owned-benchmark.ts";
import type { AgentIdentity } from "../../src/long-task-evals/schemas.ts";
import {
	capabilityTrialPlan,
	requiredPlanBudget,
	resilienceTrialPlans,
} from "../../src/long-task-evals/trial-plans.ts";

const benchmarkRoot = resolve(import.meta.dirname, "../../benchmarks/long-horizon-v1");
const ever: AgentIdentity = {
	name: "ever",
	version: "1.0.0",
	executableDigest: "a".repeat(64),
	modelProvider: "openai",
	modelId: "exact-model",
	configurationDigest: "b".repeat(64),
};

describe("long-horizon trial plans", () => {
	it("builds stable capability plan identities", async () => {
		const testCase = (await new OwnedLongHorizonBenchmarkAdapter(benchmarkRoot).listCases("smoke"))[0]!;
		const value = JSON.parse(await readFile(resolve(testCase.taskRoot, "task.json"), "utf8")) as unknown;
		assertLongHorizonTask(value);
		const first = capabilityTrialPlan(value, testCase, ever, 1, 42);
		const second = capabilityTrialPlan(value, testCase, ever, 1, 42);
		expect(first).toEqual(second);
		expect(first).toMatchObject({ lane: "capability", variant: "standard", repetition: 1, seed: 42 });
	});

	it("pairs no-fault and fault plans with identical controlled variables", async () => {
		const testCase = (await new OwnedLongHorizonBenchmarkAdapter(benchmarkRoot).listCases("smoke"))[0]!;
		const value = JSON.parse(await readFile(resolve(testCase.taskRoot, "task.json"), "utf8")) as unknown;
		assertLongHorizonTask(value);
		const task = {
			...value,
			scenarios: [
				{
					id: "after-checkpoint",
					trigger: {
						source: "agent_event" as const,
						type: "CheckpointSettled" as const,
						where: { checkpointId: "checkpoint-1" },
						occurrence: 1,
						waitTimeoutSeconds: 30,
					},
					action: { type: "kill_worker" as const, signal: "SIGKILL" as const },
					expectation: { kind: "eventual_completion" as const, maxRecoverySeconds: 60 },
				},
			],
		};
		const plans = resilienceTrialPlans(task, testCase, ever, 2, 99);
		expect(plans).toHaveLength(2);
		expect(plans.map((plan) => plan.variant)).toEqual(["no_fault", "fault"]);
		expect(plans[0]!.pairId).toBe(plans[1]!.pairId);
		expect(plans[0]!.planId).not.toBe(plans[1]!.planId);
		for (const plan of plans) {
			expect(plan).toMatchObject({ lane: "resilience", seed: 99, repetition: 2, agent: ever });
		}
	});

	it("does not assign resilience zeros to generic command agents", async () => {
		const testCase = (await new OwnedLongHorizonBenchmarkAdapter(benchmarkRoot).listCases("smoke"))[0]!;
		const value = JSON.parse(await readFile(resolve(testCase.taskRoot, "task.json"), "utf8")) as unknown;
		assertLongHorizonTask(value);
		expect(() => resilienceTrialPlans(value, testCase, { ...ever, name: "codex" }, 1, 1)).toThrow(
			"require the Ever adapter",
		);
	});

	it("computes the total admitted budget from immutable plans", async () => {
		const testCase = (await new OwnedLongHorizonBenchmarkAdapter(benchmarkRoot).listCases("smoke"))[0]!;
		const value = JSON.parse(await readFile(resolve(testCase.taskRoot, "task.json"), "utf8")) as unknown;
		assertLongHorizonTask(value);
		const plans = [
			capabilityTrialPlan(value, testCase, ever, 1, 1),
			capabilityTrialPlan(value, testCase, ever, 2, 1),
		];
		expect(requiredPlanBudget(plans)).toBe(value.limits.maxCostUsd * 2);
	});
});
