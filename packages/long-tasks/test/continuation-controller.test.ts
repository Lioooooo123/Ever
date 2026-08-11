import { describe, expect, it } from "vitest";
import { type ContinuationDecision, decideContinuation, type Progress, progressFingerprint } from "../src/index.ts";

function progress(overrides: Partial<Progress> = {}): Progress {
	return {
		summary: "working",
		completedItems: [],
		nextActions: ["Run the focused verification"],
		blockers: [],
		filesRead: [],
		filesModified: [],
		verification: [],
		consumedMessageIds: [],
		outboundMessageIds: [],
		...overrides,
	};
}

function previousDecision(
	index: number,
	fingerprint: string,
	reasonCode = "next_actions_available",
): ContinuationDecision {
	return {
		id: `decision-${index}`,
		taskId: "task-1",
		agentId: "agent-1",
		attemptId: "attempt-1",
		settledTurnIndex: index,
		action: "continue",
		reasonCode,
		reason: "test",
		progressFingerprint: fingerprint,
		createdAt: new Date(index).toISOString(),
	};
}

function evaluate(current: Progress, previousDecisions: ContinuationDecision[] = []) {
	return decideContinuation({
		taskState: "running",
		agentState: "running",
		totalTurns: previousDecisions.length + 1,
		maxTurns: 100,
		automaticTurns: previousDecisions.length,
		hasUnknownToolOutcome: false,
		completionRequested: false,
		acceptancePassed: false,
		hasIncompleteRequiredDelegations: false,
		hasPendingManualAcceptance: false,
		progress: current,
		previousDecisions,
	});
}

describe("ContinuationController", () => {
	it("replans after two identical progress Turns and pauses after three", () => {
		const current = progress();
		const fingerprint = progressFingerprint(current);
		expect(evaluate(current, [previousDecision(1, fingerprint)]).action).toBe("replan");
		expect(evaluate(current, [previousDecision(1, fingerprint), previousDecision(2, fingerprint)]).action).toBe(
			"pause_no_progress",
		);
	});

	it("replans and then pauses repeated verification failures", () => {
		const current = progress({ verification: [{ command: "npm run check", result: "failed" }] });
		const first = evaluate(current);
		expect(first.action).toBe("continue");
		const second = evaluate(current, [previousDecision(1, first.progressFingerprint, first.reasonCode)]);
		expect(second.action).toBe("replan");
		const third = evaluate(current, [
			previousDecision(1, first.progressFingerprint, first.reasonCode),
			previousDecision(2, second.progressFingerprint, second.reasonCode),
		]);
		expect(third.action).toBe("pause_no_progress");
	});

	it("prioritizes unknown outcomes, budgets, and host acceptance gates", () => {
		const current = progress();
		const base = {
			taskState: "running" as const,
			agentState: "running" as const,
			totalTurns: 1,
			maxTurns: 100,
			automaticTurns: 0,
			hasUnknownToolOutcome: false,
			completionRequested: false,
			acceptancePassed: false,
			hasIncompleteRequiredDelegations: false,
			hasPendingManualAcceptance: false,
			progress: current,
			previousDecisions: [],
		};
		expect(
			decideContinuation({ ...base, hasUnknownToolOutcome: true, completionRequested: true, acceptancePassed: true })
				.action,
		).toBe("wait_user");
		expect(decideContinuation({ ...base, totalTurns: 100 }).action).toBe("pause_budget");
		expect(decideContinuation({ ...base, completionRequested: true, acceptancePassed: true }).action).toBe(
			"complete",
		);
		expect(
			decideContinuation({
				...base,
				completionRequested: true,
				acceptancePassed: true,
				hasIncompleteRequiredDelegations: true,
			}).action,
		).toBe("wait_external");
		expect(
			decideContinuation({
				...base,
				completionRequested: true,
				hasPendingManualAcceptance: true,
			}).action,
		).toBe("wait_user");
		expect(decideContinuation({ ...base, completionRequested: true }).action).toBe("replan");
		expect(decideContinuation({ ...base, agentState: "completed" }).reasonCode).toBe("agent_completed");
		expect(decideContinuation({ ...base, taskState: "unknown_outcome" }).action).toBe("wait_user");
	});
});
