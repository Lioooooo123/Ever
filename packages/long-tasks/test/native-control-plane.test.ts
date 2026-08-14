import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createInMemoryTaskStore,
	EvidenceResolver,
	type RuntimeSnapshot,
	runtimeSnapshotHash,
	TaskController,
} from "../src/index.ts";

function snapshot(): RuntimeSnapshot {
	return {
		everVersion: "0.1.0",
		upstreamCommit: "test",
		protocolVersion: 1,
		model: { provider: "test", id: "faux" },
		systemPromptSha256: "prompt",
		contextFiles: [],
		resources: [],
		toolPolicySha256: "tools",
		sandboxPolicySha256: "sandbox",
	};
}

describe("native Attempt control plane", () => {
	it("atomically claims one Attempt and journals dispatch before tool execution", () => {
		const store = createInMemoryTaskStore(() => new Date("2026-08-12T00:00:00.000Z"));
		const controller = new TaskController(store);
		const task = controller.create({
			title: "atomic claim",
			goal: "run once",
			acceptance: [],
			budget: { maxTurns: 5, maxWallTimeMinutes: 60 },
			workspaceRoot: process.cwd(),
			workspaceFingerprint: "fingerprint",
		});
		controller.submit(task.id);
		const agent = store.listAgents(task.id)[0]!;
		const runtime = snapshot();
		const claim = store.claimAttempt({
			agentId: agent.id,
			sessionId: "session-1",
			runtimeSnapshot: runtime,
			runtimeSnapshotSha256: runtimeSnapshotHash(runtime),
			workerId: "worker-1",
			executionId: "execution-1",
		});
		expect(() =>
			store.claimAttempt({
				agentId: agent.id,
				sessionId: "session-2",
				runtimeSnapshot: runtime,
				runtimeSnapshotSha256: runtimeSnapshotHash(runtime),
				workerId: "worker-2",
				executionId: "execution-2",
			}),
		).toThrow("active lease");
		const context = store.resolveAttemptClaim(claim);
		store.startToolExecution(context.lease, context.attempt.id, {
			operationId: "operation-1",
			toolCallId: "tool-1",
			toolName: "write",
			inputSha256: "input",
			effect: "reconcilable_write",
			paths: [process.cwd()],
			permissionSource: "reviewer",
			intentSha256: "a".repeat(64),
		});
		const toolEvents = store.listEvents(task.id).slice(-3);
		expect(toolEvents.map((event) => event.type)).toEqual(["ToolPlanned", "ToolAuthorized", "ToolStarted"]);
		expect(toolEvents[1]?.payload).toMatchObject({
			permissionSource: "reviewer",
			intentSha256: "a".repeat(64),
		});
		store.close();
	});

	it("resolves file evidence and rejects missing or escaping refs", () => {
		const root = mkdtempSync(join(tmpdir(), "ever-evidence-"));
		writeFileSync(join(root, "result.txt"), "verified\n");
		const store = createInMemoryTaskStore();
		const task = new TaskController(store).create({
			title: "evidence",
			goal: "verify facts",
			acceptance: [],
			budget: { maxTurns: 5, maxWallTimeMinutes: 60 },
			workspaceRoot: root,
			workspaceFingerprint: "fingerprint",
		});
		const result = new EvidenceResolver(store).resolve(task.id, [
			{ id: "valid", kind: "file", ref: "result.txt" },
			{ id: "missing", kind: "file", ref: "missing.txt" },
			{ id: "escape", kind: "file", ref: "../outside.txt" },
		]);
		expect(result.map(({ verified }) => verified)).toEqual([true, false, false]);
		expect(result[0]?.actualSha256).toMatch(/^[a-f0-9]{64}$/);
		store.close();
	});

	it("keeps the main Agent state aligned with Task waits, resumes, and completion", () => {
		const store = createInMemoryTaskStore();
		const controller = new TaskController(store);
		const task = controller.submit(
			controller.create({
				title: "state alignment",
				goal: "wait and resume",
				acceptance: [],
				budget: { maxTurns: 5, maxWallTimeMinutes: 60 },
				workspaceRoot: process.cwd(),
				workspaceFingerprint: "fingerprint",
			}).id,
		);
		const agent = store.listAgents(task.id)[0]!;
		const runtime = snapshot();
		const claim = store.claimAttempt({
			agentId: agent.id,
			sessionId: "session-state",
			runtimeSnapshot: runtime,
			runtimeSnapshotSha256: runtimeSnapshotHash(runtime),
			workerId: "worker-state",
			executionId: "execution-state",
		});
		const context = store.resolveAttemptClaim(claim);

		store.transitionTask(task.id, "waiting_input", "needs_user");
		expect(store.requireAgent(agent.id).state).toBe("waiting_message");
		store.releaseLease(context.lease);
		store.transitionTask(task.id, "queued", "user_replied");
		expect(store.requireAgent(agent.id).state).toBe("queued");

		const completionClaim = store.claimAttempt({
			agentId: agent.id,
			sessionId: "session-complete",
			runtimeSnapshot: runtime,
			runtimeSnapshotSha256: runtimeSnapshotHash(runtime),
			workerId: "worker-complete",
			executionId: "execution-complete",
		});
		const completionContext = store.resolveAttemptClaim(completionClaim);
		store.commitCheckpoint({
			taskId: task.id,
			agentId: agent.id,
			attemptId: completionContext.attempt.id,
			lease: completionContext.lease,
			sessionCheckpoint: {
				sessionId: "session-complete",
				settledTurnIndex: 1,
				runtimeSnapshotSha256: runtimeSnapshotHash(runtime),
				createdAt: new Date().toISOString(),
			},
			progress: {
				summary: "verified",
				completedItems: ["task"],
				nextActions: [],
				blockers: [],
				filesRead: [],
				filesModified: [],
				verification: [],
				consumedMessageIds: [],
				outboundMessageIds: [],
			},
			evidence: [],
			workspaceSnapshot: {},
		});
		store.transitionTask(task.id, "completed", "verified");
		expect(store.requireAgent(agent.id).state).toBe("completed");
		store.releaseLease(completionContext.lease);
		store.close();
	});
});
