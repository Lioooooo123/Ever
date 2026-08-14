import { describe, expect, it } from "vitest";
import { createInMemoryTaskStore, type RuntimeSnapshot, runtimeSnapshotHash, TaskController } from "../src/index.ts";

const profileSha256 = "b".repeat(64);

function createRunningAttempt(store = createInMemoryTaskStore(() => new Date("2026-08-14T00:00:00.000Z"))) {
	const controller = new TaskController(store);
	const task = controller.submit(
		controller.create({
			title: "permission grants",
			goal: "reuse explicit approval",
			acceptance: [],
			budget: { maxTurns: 5, maxWallTimeMinutes: 60 },
			workspaceRoot: process.cwd(),
			workspaceFingerprint: "workspace-1",
		}).id,
	);
	const agent = store.listAgents(task.id)[0]!;
	const runtime: RuntimeSnapshot = {
		everVersion: "test",
		upstreamCommit: "test",
		protocolVersion: 1,
		model: { provider: "test", id: "faux" },
		systemPromptSha256: "prompt",
		contextFiles: [],
		resources: [],
		toolPolicySha256: "tools",
		sandboxPolicySha256: profileSha256,
	};
	const claim = store.claimAttempt({
		agentId: agent.id,
		sessionId: "session-1",
		runtimeSnapshot: runtime,
		runtimeSnapshotSha256: runtimeSnapshotHash(runtime),
		workerId: "worker-1",
		executionId: "execution-1",
	});
	return { agent, context: store.resolveAttemptClaim(claim), store, task };
}

describe("durable permission grants", () => {
	it("matches identity-bound grants and atomically consumes single-use approval with ToolStarted", () => {
		const { context, store, task } = createRunningAttempt();
		const grant = store.createPermissionGrant({
			source: "user",
			lifetime: "once",
			scope: {
				toolNames: ["bash"],
				effects: ["process"],
				pathPrefixes: [process.cwd()],
				commandFingerprints: ["c".repeat(64)],
				networkDomains: [],
				credentialScopes: [],
			},
			taskId: task.id,
			attemptId: context.attempt.id,
			workspaceFingerprint: task.workspaceFingerprint,
			sandboxProfileSha256: profileSha256,
		});
		expect(
			store.listActivePermissionGrants({
				taskId: task.id,
				attemptId: context.attempt.id,
				workspaceFingerprint: task.workspaceFingerprint,
				sandboxProfileSha256: profileSha256,
			}),
		).toHaveLength(1);

		store.startToolExecution(context.lease, context.attempt.id, {
			operationId: "operation-1",
			toolCallId: "tool-1",
			toolName: "bash",
			inputSha256: "input",
			effect: "process",
			paths: [process.cwd()],
			permissionSource: "grant",
			intentSha256: "d".repeat(64),
			grantId: grant.id,
		});

		expect(
			store.listActivePermissionGrants({
				taskId: task.id,
				attemptId: context.attempt.id,
				workspaceFingerprint: task.workspaceFingerprint,
				sandboxProfileSha256: profileSha256,
			}),
		).toEqual([]);
		expect(store.listEvents(task.id).map((event) => event.type)).toContain("PermissionGrantUsed");
		store.close();
	});

	it("expires grants before profile derivation or permission management reads them", () => {
		const { store, task } = createRunningAttempt();
		const grant = store.createPermissionGrant({
			source: "user",
			lifetime: "task",
			scope: {
				toolNames: ["bash"],
				effects: ["process"],
				pathPrefixes: [process.cwd()],
				commandFingerprints: [],
				networkDomains: ["expired.example"],
				credentialScopes: [],
			},
			taskId: task.id,
			workspaceFingerprint: task.workspaceFingerprint,
			sandboxProfileSha256: profileSha256,
			expiresAt: "2026-08-13T23:59:59.000Z",
		});
		expect(store.listPermissionGrants(task.id)).toContainEqual(
			expect.objectContaining({ id: grant.id, state: "expired" }),
		);
		expect(store.listEvents(task.id).map((event) => event.type)).toContain("PermissionGrantExpired");
		store.close();
	});

	it("persists structured Risk Review audit facts", () => {
		const { context, store, task } = createRunningAttempt();
		const reviewId = store.recordRiskReview({
			taskId: task.id,
			attemptId: context.attempt.id,
			intentSha256: "a".repeat(64),
			modelProvider: "test",
			modelId: "reviewer",
			promptSha256: "b".repeat(64),
			inputSha256: "c".repeat(64),
			outputSha256: "d".repeat(64),
			verdict: "allow_once",
			risk: "low",
			confidence: 0.95,
		});
		expect(reviewId).toBeTruthy();
		expect(store.listEvents(task.id)).toContainEqual(
			expect.objectContaining({
				type: "RiskReviewRecorded",
				payload: expect.objectContaining({ reviewId, intentSha256: "a".repeat(64) }),
			}),
		);
		store.close();
	});

	it("rejects audit records associated with an Attempt from another Task", () => {
		const first = createRunningAttempt();
		const second = createRunningAttempt(first.store);
		const auditIdentity = {
			taskId: first.task.id,
			attemptId: second.context.attempt.id,
			intentSha256: "a".repeat(64),
		};

		expect(() =>
			first.store.recordRiskReview({
				...auditIdentity,
				modelProvider: "test",
				modelId: "reviewer",
				promptSha256: "b".repeat(64),
				inputSha256: "c".repeat(64),
				outputSha256: "d".repeat(64),
				verdict: "ask",
				risk: "medium",
				confidence: 0.8,
			}),
		).toThrow("Attempt does not belong to the Task");
		expect(() =>
			first.store.recordPermissionDecision({
				...auditIdentity,
				operationId: "cross-task-operation",
				action: "deny",
				source: "user",
			}),
		).toThrow("Attempt does not belong to the Task");
		first.store.close();
	});

	it("invalidates grants on profile drift and suppresses repeated user-denied intents per Attempt", () => {
		const { context, store, task } = createRunningAttempt();
		const grant = store.createPermissionGrant({
			source: "user",
			lifetime: "task",
			scope: {
				toolNames: ["bash"],
				effects: ["process"],
				pathPrefixes: [process.cwd()],
				commandFingerprints: ["c".repeat(64)],
				networkDomains: [],
				credentialScopes: [],
			},
			taskId: task.id,
			workspaceFingerprint: task.workspaceFingerprint,
			sandboxProfileSha256: profileSha256,
		});
		expect(
			store.listActivePermissionGrants({
				taskId: task.id,
				attemptId: context.attempt.id,
				workspaceFingerprint: task.workspaceFingerprint,
				sandboxProfileSha256: "e".repeat(64),
			}),
		).toEqual([]);

		store.recordPermissionDecision({
			taskId: task.id,
			attemptId: context.attempt.id,
			operationId: "operation-denied",
			intentSha256: "f".repeat(64),
			action: "deny",
			source: "user",
			reasonCode: "user_denied",
		});
		expect(store.hasAttemptPermissionDenial(context.attempt.id, "f".repeat(64))).toBe(true);
		expect(store.revokePermissionGrant(grant.id).state).toBe("revoked");
		expect(store.listPermissionGrants(task.id)).toEqual([
			expect.objectContaining({ id: grant.id, state: "revoked" }),
		]);
		store.close();
	});
});
