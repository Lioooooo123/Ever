import { sha256 } from "./hash.ts";
import type { LongHorizonTask } from "./owned-benchmark.ts";
import type { AgentIdentity, EvalCase } from "./schemas.ts";
import type { SemanticFaultScenario } from "./semantic-faults.ts";

export interface LongHorizonTrialPlan {
	schemaVersion: 1;
	planId: string;
	taskId: string;
	taskDigest: string;
	lane: "capability" | "resilience";
	variant: "standard" | "no_fault" | "fault";
	seed: number;
	repetition: number;
	pairId?: string;
	scenario?: SemanticFaultScenario;
	agent: AgentIdentity;
	limits: {
		trialTimeoutSeconds: number;
		maxTurns: number;
		maxCostUsd: number;
	};
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function taskDigest(testCase: EvalCase): string {
	const digest = testCase.metadata.taskDigest;
	if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
		throw new Error(`Long-horizon task ${testCase.id} has no pinned task digest`);
	return digest;
}

function planId(value: Omit<LongHorizonTrialPlan, "planId">): string {
	return sha256(canonical(value));
}

function base(
	task: LongHorizonTask,
	testCase: EvalCase,
	agent: AgentIdentity,
	repetition: number,
	seed: number,
): Pick<LongHorizonTrialPlan, "schemaVersion" | "taskId" | "taskDigest" | "seed" | "repetition" | "agent" | "limits"> {
	if (!Number.isSafeInteger(repetition) || repetition < 1) throw new Error("Trial repetition must be positive");
	if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("Trial seed must be a non-negative integer");
	if (task.id !== testCase.id) throw new Error(`Task definition does not match Eval case ${testCase.id}`);
	return {
		schemaVersion: 1,
		taskId: task.id,
		taskDigest: taskDigest(testCase),
		seed,
		repetition,
		agent,
		limits: {
			trialTimeoutSeconds: task.limits.trialTimeoutSeconds,
			maxTurns: task.limits.maxTurns,
			maxCostUsd: task.limits.maxCostUsd,
		},
	};
}

export function capabilityTrialPlan(
	task: LongHorizonTask,
	testCase: EvalCase,
	agent: AgentIdentity,
	repetition: number,
	seed: number,
): LongHorizonTrialPlan {
	const value: Omit<LongHorizonTrialPlan, "planId"> = {
		...base(task, testCase, agent, repetition, seed),
		lane: "capability",
		variant: "standard",
	};
	return { ...value, planId: planId(value) };
}

export function resilienceTrialPlans(
	task: LongHorizonTask,
	testCase: EvalCase,
	agent: AgentIdentity,
	repetition: number,
	seed: number,
): LongHorizonTrialPlan[] {
	if (agent.name !== "ever") throw new Error("Resilience plans require the Ever adapter");
	const shared = base(task, testCase, agent, repetition, seed);
	return task.scenarios.flatMap((scenario) => {
		const pairId = sha256(
			canonical({
				taskId: shared.taskId,
				taskDigest: shared.taskDigest,
				repetition,
				seed,
				agent,
				limits: shared.limits,
				scenarioId: scenario.id,
			}),
		);
		const noFault: Omit<LongHorizonTrialPlan, "planId"> = {
			...shared,
			lane: "resilience",
			variant: "no_fault",
			pairId,
			scenario,
		};
		const fault: Omit<LongHorizonTrialPlan, "planId"> = {
			...shared,
			lane: "resilience",
			variant: "fault",
			pairId,
			scenario,
		};
		return [
			{ ...noFault, planId: planId(noFault) },
			{ ...fault, planId: planId(fault) },
		];
	});
}

export function requiredPlanBudget(plans: readonly LongHorizonTrialPlan[]): number {
	return plans.reduce((total, plan) => total + plan.limits.maxCostUsd, 0);
}
