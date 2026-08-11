import { createHash } from "node:crypto";
import type { SqliteTaskStore } from "./store.ts";
import type { AgentLease, AgentState, ContinuationDecision, ContinuationPolicy, Progress, TaskState } from "./types.ts";
import { DEFAULT_CONTINUATION_POLICY } from "./types.ts";

export interface ContinuationEvaluationInput {
	taskState: TaskState;
	agentState: AgentState;
	totalTurns: number;
	maxTurns: number;
	automaticTurns: number;
	hasUnknownToolOutcome: boolean;
	completionRequested: boolean;
	acceptancePassed: boolean;
	hasIncompleteRequiredDelegations: boolean;
	hasPendingManualAcceptance: boolean;
	progress: Progress;
	previousDecisions: ContinuationDecision[];
}

export interface ContinuationEvaluation {
	action: ContinuationDecision["action"];
	reasonCode: string;
	reason: string;
	progressFingerprint: string;
	nextPrompt?: string;
}

function stableUnique(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function progressFingerprint(progress: Progress): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				completedItems: stableUnique(progress.completedItems),
				currentItem: progress.currentItem?.trim() ?? null,
				nextActions: stableUnique(progress.nextActions),
				filesModified: stableUnique(progress.filesModified),
				verification: progress.verification
					.map((item) => ({
						command: item.command?.trim() ?? null,
						result: item.result,
						artifactRef: item.artifactRef ?? null,
					}))
					.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
			}),
		)
		.digest("hex");
}

function failureSignature(progress: Progress): string | undefined {
	const failures = progress.verification
		.filter((item) => item.result === "failed")
		.map((item) => `${item.command ?? "unknown"}\0${item.artifactRef ?? ""}`)
		.sort();
	if (failures.length === 0) return undefined;
	return createHash("sha256").update(failures.join("\0")).digest("hex");
}

function consecutiveMatches<T>(values: T[], predicate: (value: T) => boolean): number {
	let count = 0;
	for (const value of [...values].reverse()) {
		if (!predicate(value)) break;
		count += 1;
	}
	return count;
}

function nextPrompt(action: "continue" | "replan", reason: string, progress: Progress): string {
	const actions =
		progress.nextActions
			.slice(0, 5)
			.map((item) => `- ${item}`)
			.join("\n") || "- Reassess the next bounded action.";
	return `Continue the durable Task from the latest checkpoint.
Decision: ${action}
Reason: ${reason}
Current item: ${progress.currentItem ?? "not reported"}
Required next actions:
${actions}
Do not repeat completed work. Re-check evidence before requesting completion.`;
}

export function decideContinuation(
	input: ContinuationEvaluationInput,
	policy: ContinuationPolicy = DEFAULT_CONTINUATION_POLICY,
): ContinuationEvaluation {
	const fingerprint = progressFingerprint(input.progress);
	const result = (
		action: ContinuationEvaluation["action"],
		reasonCode: string,
		reason: string,
	): ContinuationEvaluation => ({
		action,
		reasonCode,
		reason,
		progressFingerprint: fingerprint,
		...(action === "continue" || action === "replan"
			? { nextPrompt: nextPrompt(action, reason, input.progress) }
			: {}),
	});
	if (input.hasUnknownToolOutcome)
		return result("wait_user", "unknown_tool_outcome", "A tool outcome is unknown and requires reconciliation.");
	if (input.agentState === "completed")
		return result("complete", "agent_completed", "The Agent completed its assigned objective.");
	if (input.agentState === "failed" || input.agentState === "cancelled")
		return result("fail", `agent_${input.agentState}`, `Agent is already ${input.agentState}.`);
	if (input.taskState === "unknown_outcome")
		return result(
			"wait_user",
			"task_unknown_outcome",
			"The Task has an unknown outcome that requires reconciliation.",
		);
	if (input.taskState === "cancelled" || input.taskState === "failed")
		return result("fail", `task_${input.taskState}`, `Task is already ${input.taskState}.`);
	if (input.taskState === "completed") return result("complete", "task_completed", "Task is already complete.");
	if (input.totalTurns >= input.maxTurns || input.automaticTurns >= policy.maxAutomaticContinuationTurnsPerAttempt) {
		return result("pause_budget", "automatic_turn_budget", "The automatic continuation Turn budget is exhausted.");
	}
	if (input.completionRequested && input.acceptancePassed && !input.hasIncompleteRequiredDelegations)
		return result("complete", "acceptance_passed", "All registered acceptance criteria passed.");
	if (input.completionRequested && input.hasPendingManualAcceptance)
		return result(
			"wait_user",
			"manual_acceptance_required",
			"A registered manual acceptance criterion requires user confirmation.",
		);
	if (input.completionRequested && !input.acceptancePassed)
		return result(
			"replan",
			"acceptance_not_met",
			"The completion request did not satisfy all registered acceptance criteria.",
		);
	if (input.taskState === "waiting_input" || input.taskState === "paused")
		return result("wait_user", "user_input_required", "The Task requires user input before continuing.");
	if (input.taskState === "waiting_external" || input.hasIncompleteRequiredDelegations)
		return result("wait_external", "external_result_required", "A required external or delegated result is pending.");

	const failure = failureSignature(input.progress);
	if (failure) {
		const reasonCode = `verification_failed:${failure}`;
		const count = 1 + consecutiveMatches(input.previousDecisions, (decision) => decision.reasonCode === reasonCode);
		if (count >= policy.pauseAfterRepeatedFailureTurns)
			return result("pause_no_progress", reasonCode, "The same verification failure repeated without recovery.");
		if (count >= policy.maxRepeatedFailureTurns)
			return result(
				"replan",
				reasonCode,
				"The same verification failure repeated; change the approach before retrying.",
			);
		return result(
			"continue",
			reasonCode,
			"Verification failed once; address the recorded failure before proceeding.",
		);
	}

	const identicalTurns =
		1 + consecutiveMatches(input.previousDecisions, (decision) => decision.progressFingerprint === fingerprint);
	if (identicalTurns >= policy.pauseAfterIdenticalProgressTurns)
		return result("pause_no_progress", "identical_progress", "Progress remained unchanged across consecutive Turns.");
	if (identicalTurns >= policy.maxIdenticalProgressTurns)
		return result("replan", "identical_progress", "Progress did not change; a different plan is required.");
	return result("continue", "next_actions_available", "The latest checkpoint contains bounded next actions.");
}

export class ContinuationController {
	private readonly store: SqliteTaskStore;
	private readonly policy: ContinuationPolicy;

	constructor(store: SqliteTaskStore, policy: ContinuationPolicy = DEFAULT_CONTINUATION_POLICY) {
		this.store = store;
		this.policy = policy;
	}

	evaluate(input: { lease: AgentLease; attemptId: string; settledTurnIndex: number; progress: Progress }): {
		decision: ContinuationDecision;
		duplicate: boolean;
	} {
		const task = this.store.requireTask(input.lease.taskId);
		const agent = this.store.requireAgent(input.lease.agentId);
		const previousDecisions = this.store.listContinuationDecisions(input.lease.agentId, input.attemptId);
		const evaluation = decideContinuation(
			{
				taskState: task.state,
				agentState: agent.state,
				totalTurns: task.totalTurns,
				maxTurns: task.budget.maxTurns,
				automaticTurns: previousDecisions.filter((decision) => ["continue", "replan"].includes(decision.action))
					.length,
				hasUnknownToolOutcome: this.store.hasUnfinishedTools(task.id, input.lease.agentId),
				completionRequested: this.store.hasPendingAcceptanceRequest(task.id),
				acceptancePassed: this.store.hasPassedAllAcceptance(task.id),
				hasIncompleteRequiredDelegations: this.store.hasIncompleteRequiredDelegations(task.id),
				hasPendingManualAcceptance: this.store.hasPendingManualAcceptance(task.id),
				progress: input.progress,
				previousDecisions,
			},
			this.policy,
		);
		const recorded = this.store.recordContinuationDecision(input.lease, {
			attemptId: input.attemptId,
			settledTurnIndex: input.settledTurnIndex,
			...evaluation,
		});
		if (recorded.duplicate) return recorded;
		if (agent.kind !== "main") return recorded;
		if (recorded.decision.action === "complete") this.store.transitionTask(task.id, "completed", "acceptance_passed");
		else if (recorded.decision.action === "fail")
			this.store.transitionTask(task.id, "failed", recorded.decision.reasonCode);
		else if (recorded.decision.action === "pause_budget" || recorded.decision.action === "pause_no_progress")
			this.store.transitionTask(task.id, "paused", recorded.decision.reasonCode);
		else if (recorded.decision.action === "wait_user")
			this.store.transitionTask(task.id, "waiting_input", recorded.decision.reasonCode);
		else if (recorded.decision.action === "wait_external")
			this.store.transitionTask(task.id, "waiting_external", recorded.decision.reasonCode);
		return recorded;
	}
}
