import { describe, expect, it } from "vitest";
import { createInMemoryTaskStore, RecoveryEngine, runtimeSnapshotHash, TaskController } from "../src/index.ts";

describe("control-plane fault injection", () => {
	it("blocks recovery while a Provider outcome is uncommitted", async () => {
		let now = new Date("2026-08-11T00:00:00.000Z");
		const store = createInMemoryTaskStore(() => now);
		const controller = new TaskController(store);
		const task = controller.create({
			title: "provider fault",
			goal: "do not replay an unknown request",
			acceptance: [],
			budget: { maxTurns: 5, maxWallTimeMinutes: 10 },
			workspaceRoot: process.cwd(),
			workspaceFingerprint: "fingerprint",
		});
		controller.submit(task.id);
		const agent = store.listAgents(task.id)[0]!;
		const snapshot = {
			karissaVersion: "0.1.0",
			upstreamCommit: "test",
			protocolVersion: 1,
			model: { provider: "test", id: "faux" },
			systemPromptSha256: "prompt",
			contextFiles: [],
			resources: [],
			toolPolicySha256: "tools",
			sandboxPolicySha256: "sandbox",
		};
		const claim = store.claimAttempt({
			agentId: agent.id,
			runtimeSnapshot: snapshot,
			runtimeSnapshotSha256: runtimeSnapshotHash(snapshot),
			workerId: "worker-1",
			executionId: "execution-1",
			leaseSeconds: 1,
		});
		const context = store.resolveAttemptClaim(claim);
		store.startProviderRequest(context.lease, context.attempt.id, {
			providerRequestId: "provider-1",
			provider: "test",
			modelId: "faux",
			requestKind: "agent",
		});
		now = new Date("2026-08-11T00:00:02.000Z");
		const result = await new RecoveryEngine(store, { stopExecution: async () => true }).recover(agent.id);
		expect(result).toEqual({
			agentId: agent.id,
			recovered: false,
			reason: "provider_outcome_unknown:provider-1",
		});
		expect(store.requireTask(task.id).state).toBe("unknown_outcome");
		store.close();
	});

	it("blocks recovery when a Worker dies during an external side effect", async () => {
		let now = new Date("2026-08-11T00:00:00.000Z");
		const store = createInMemoryTaskStore(() => now);
		const controller = new TaskController(store);
		const task = controller.create({
			title: "fault injection",
			goal: "recover without replaying external effects",
			acceptance: [],
			budget: { maxTurns: 5, maxWallTimeMinutes: 10 },
			workspaceRoot: "/repo",
			workspaceFingerprint: "fingerprint",
		});
		controller.submit(task.id);
		store.transitionTask(task.id, "running");
		const agent = store.listAgents(task.id)[0]!;
		const snapshot = {
			karissaVersion: "0.1.0",
			upstreamCommit: "test",
			protocolVersion: 1,
			model: { provider: "test", id: "faux" },
			systemPromptSha256: "prompt",
			contextFiles: [],
			resources: [],
			toolPolicySha256: "tools",
			sandboxPolicySha256: "sandbox",
		};
		const attemptId = store.createAttempt(agent.id, "session-1", snapshot, runtimeSnapshotHash(snapshot));
		const lease = store.acquireLease(agent.id, "worker-1", "execution-1", 1, { pid: 123 });
		store.appendAgentEvent(lease, attemptId, "ToolStarted", {
			toolCallId: "external-1",
			toolName: "send_message",
			effect: "external_side_effect",
			executionId: lease.executionId,
			fencingToken: lease.fencingToken,
		});
		now = new Date("2026-08-11T00:00:02.000Z");
		const result = await new RecoveryEngine(store, { stopExecution: async () => true }).recover(agent.id);
		expect(result).toMatchObject({ recovered: false, reason: "unknown_tool_outcome:external-1" });
		expect(store.requireTask(task.id).state).toBe("unknown_outcome");
		store.close();
	});
});
