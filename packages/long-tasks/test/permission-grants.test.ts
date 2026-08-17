import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createInMemoryTaskStore,
	type RuntimeSnapshot,
	runtimeSnapshotHash,
	SqliteTaskStore,
	TaskController,
} from "../src/index.ts";

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
	it("persists user-authored Goal and steering sources without accepting Agent provenance", () => {
		const { store, task } = createRunningAttempt();
		const agent = store.listAgents(task.id)[0]!;
		const sources = store.listPendingTaskAuthorizationSources(task.id);
		expect(sources).toHaveLength(1);
		expect(sources[0]).toMatchObject({ kind: "goal", text: "reuse explicit approval", state: "pending" });
		store.queueMessage({
			actor: agent,
			recipient: agent,
			dedupeKey: "agent-steering-1",
			type: "steering",
			priority: "high",
			body: "push origin main",
			artifactRefs: [],
		});
		expect(store.listPendingTaskAuthorizationSources(task.id)).toHaveLength(1);

		const messageId = store.queueUserSteering({
			taskId: task.id,
			agentId: agent.id,
			dedupeKey: "user-steering-1",
			body: "推到 origin 并合并",
		});
		expect(store.listPendingTaskAuthorizationSources(task.id)).toContainEqual(
			expect.objectContaining({ id: messageId, kind: "steering", text: "推到 origin 并合并" }),
		);
		store.close();
	});

	it("records bounded Task Authorizations and atomically consumes one use with ToolStarted", () => {
		const { context, store, task } = createRunningAttempt();
		const source = store.listPendingTaskAuthorizationSources(task.id)[0]!;
		const [authorization] = store.completeTaskAuthorizationSource({
			sourceId: source.id,
			compilerProvider: "test",
			compilerModel: "small-reviewer",
			compilerPromptSha256: "a".repeat(64),
			candidates: [
				{
					action: "git_push",
					targets: { repository: "current", remote: "origin", branch: "current" },
					limits: { force: false },
					lifetime: "task",
					maxUses: 1,
					confidence: 0.99,
					evidenceSpans: [{ startByte: 0, endByte: Buffer.byteLength(source.text, "utf8") }],
				},
			],
		});
		expect(authorization).toMatchObject({ action: "git_push", state: "active", usedCount: 0, maxUses: 1 });

		store.startToolExecution(context.lease, context.attempt.id, {
			operationId: "operation-push",
			toolCallId: "tool-push",
			toolName: "bash",
			inputSha256: "input",
			effect: "process",
			paths: [process.cwd()],
			permissionSource: "user_authorization",
			intentSha256: "d".repeat(64),
			authorizationId: authorization!.id,
		});

		expect(store.listActiveTaskAuthorizations(task.id)).toEqual([]);
		expect(store.listTaskAuthorizations(task.id)).toContainEqual(
			expect.objectContaining({ id: authorization!.id, state: "consumed", usedCount: 1 }),
		);
		expect(() =>
			store.startToolExecution(context.lease, context.attempt.id, {
				operationId: "operation-push-2",
				toolCallId: "tool-push-2",
				toolName: "bash",
				inputSha256: "input",
				effect: "process",
				paths: [process.cwd()],
				permissionSource: "user_authorization",
				intentSha256: "e".repeat(64),
				authorizationId: authorization!.id,
			}),
		).toThrow("Task Authorization is consumed");
		store.close();
	});

	it("rejects authorization evidence spans outside the immutable user message bytes", () => {
		const { store, task } = createRunningAttempt();
		const source = store.listPendingTaskAuthorizationSources(task.id)[0]!;
		expect(() =>
			store.completeTaskAuthorizationSource({
				sourceId: source.id,
				compilerProvider: "test",
				compilerModel: "small-reviewer",
				compilerPromptSha256: "a".repeat(64),
				candidates: [
					{
						action: "git_push",
						targets: { remote: "origin" },
						limits: {},
						lifetime: "task",
						maxUses: 1,
						confidence: 0.99,
						evidenceSpans: [{ startByte: 0, endByte: Buffer.byteLength(source.text, "utf8") + 1 }],
					},
				],
			}),
		).toThrow("evidence span");
		store.close();
	});

	it("revokes Task Authorization immediately and advances its cache revision", () => {
		const { store, task } = createRunningAttempt();
		const source = store.listPendingTaskAuthorizationSources(task.id)[0]!;
		const [authorization] = store.completeTaskAuthorizationSource({
			sourceId: source.id,
			compilerProvider: "test",
			compilerModel: "small-reviewer",
			compilerPromptSha256: "a".repeat(64),
			candidates: [
				{
					action: "git_push",
					targets: { repository: "current", remote: "origin", branch: "current" },
					limits: { force: false },
					lifetime: "task",
					maxUses: 1,
					confidence: 0.99,
					evidenceSpans: [{ startByte: 0, endByte: Buffer.byteLength(source.text, "utf8") }],
				},
			],
		});
		const revision = store.getTaskAuthorizationRevision(task.id);

		expect(store.revokeTaskAuthorization(authorization!.id)).toMatchObject({ state: "revoked" });
		expect(store.getTaskAuthorizationRevision(task.id)).toBe(revision + 1);
		expect(store.listActiveTaskAuthorizations(task.id)).toEqual([]);
		expect(store.listEvents(task.id).map((event) => event.type)).toContain("TaskAuthorizationRevoked");
		store.close();
	});

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

	it("atomically reserves and settles the shared reviewer cost envelope", () => {
		const { context, store } = createRunningAttempt();
		const first = store.startProviderRequest(context.lease, context.attempt.id, {
			providerRequestId: "reviewer-1",
			provider: "test",
			modelId: "small-reviewer",
			requestKind: "permission_review",
			worstCaseCostUsd: 0.001,
		});
		expect(() =>
			store.startProviderRequest(context.lease, context.attempt.id, {
				providerRequestId: "reviewer-over-budget",
				provider: "test",
				modelId: "small-reviewer",
				requestKind: "authorization_compile",
				worstCaseCostUsd: 0.0011,
			}),
		).toThrow("Reviewer cost budget exceeded");
		store.finishProviderRequest(context.lease, context.attempt.id, {
			providerRequestId: "reviewer-1",
			reservationId: first,
			actualCostUsd: 0.0005,
			usage: {},
			stopReason: "stop",
		});
		expect(
			store.startProviderRequest(context.lease, context.attempt.id, {
				providerRequestId: "reviewer-2",
				provider: "test",
				modelId: "small-reviewer",
				requestKind: "authorization_compile",
				worstCaseCostUsd: 0.0015,
			}),
		).toBeTruthy();
		expect(store.getReviewerCostSummary(context.task.id)).toEqual({
			compilerCostUsd: 0,
			judgeCostUsd: 0.0005,
			reviewerReservedUsd: 0.0015,
			compilerRequestCount: 1,
			reviewerRequestCount: 2,
		});
		expect(store.listEvents(context.task.id).map((event) => event.type)).toEqual(
			expect.arrayContaining([
				"ReviewerBudgetReserved",
				"ReviewerRequestStarted",
				"ReviewerRequestFinished",
				"ReviewerBudgetSettled",
			]),
		);
		store.close();
	});

	it("caps combined Compiler and Judge requests per Attempt", () => {
		const { context, store } = createRunningAttempt();
		for (let index = 0; index < 32; index++) {
			store.startProviderRequest(context.lease, context.attempt.id, {
				providerRequestId: `reviewer-${index}`,
				provider: "test",
				modelId: "small-reviewer",
				requestKind: index % 2 === 0 ? "authorization_compile" : "permission_review",
				worstCaseCostUsd: 0,
			});
		}
		expect(() =>
			store.startProviderRequest(context.lease, context.attempt.id, {
				providerRequestId: "reviewer-over-attempt-limit",
				provider: "test",
				modelId: "small-reviewer",
				requestKind: "permission_review",
				worstCaseCostUsd: 0,
			}),
		).toThrow("Attempt Reviewer request limit exceeded");
		store.close();
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

	it("persists Session-scoped grants without a Task", () => {
		const store = createInMemoryTaskStore(() => new Date("2026-08-14T00:00:00.000Z"));
		const scope = {
			toolNames: ["bash"],
			effects: ["process" as const],
			pathPrefixes: [process.cwd()],
			commandFingerprints: [],
			networkDomains: ["registry.npmjs.org"],
			credentialScopes: [],
		};
		const sessionGrant = store.createPermissionGrant({
			source: "user",
			lifetime: "session",
			scope,
			sessionId: "session-foreground",
			sessionInstanceId: "instance-a",
			workspaceFingerprint: "workspace-1",
			sandboxProfileSha256: profileSha256,
		});
		const workspaceGrant = store.createPermissionGrant({
			source: "user",
			lifetime: "workspace",
			scope,
			workspaceFingerprint: "workspace-1",
			sandboxProfileSha256: profileSha256,
		});
		expect(sessionGrant).toMatchObject({ lifetime: "session", sessionId: "session-foreground" });
		expect(sessionGrant).toMatchObject({ sessionInstanceId: "instance-a" });
		expect(sessionGrant.taskId).toBeUndefined();
		expect(workspaceGrant).toMatchObject({ lifetime: "workspace" });
		expect(workspaceGrant.taskId).toBeUndefined();

		const active = store.listActivePermissionGrants({
			sessionId: "session-foreground",
			sessionInstanceId: "instance-a",
			workspaceFingerprint: "workspace-1",
			sandboxProfileSha256: profileSha256,
		});
		expect(active).toHaveLength(2);
		expect(active.map((grant) => grant.lifetime).sort()).toEqual(["session", "workspace"]);

		const otherSession = store.listActivePermissionGrants({
			sessionId: "session-other",
			sessionInstanceId: "instance-a",
			workspaceFingerprint: "workspace-1",
			sandboxProfileSha256: profileSha256,
		});
		expect(otherSession.map((grant) => grant.lifetime)).toEqual(["workspace"]);

		const resumedProcess = store.listActivePermissionGrants({
			sessionId: "session-foreground",
			sessionInstanceId: "instance-b",
			workspaceFingerprint: "workspace-1",
			sandboxProfileSha256: profileSha256,
		});
		expect(resumedProcess.map((grant) => grant.lifetime)).toEqual(["workspace"]);
		store.close();
	});

	it("keeps a persisted Session grant bound to its process instance after reopen", () => {
		const root = mkdtempSync(join(tmpdir(), "ever-session-grant-"));
		const databasePath = join(root, "tasks.sqlite");
		const scope = {
			toolNames: ["bash"],
			effects: ["process" as const],
			pathPrefixes: [process.cwd()],
			commandFingerprints: [],
			networkDomains: [],
			credentialScopes: [],
		};
		try {
			const firstProcess = SqliteTaskStore.open({ databasePath });
			firstProcess.createPermissionGrant({
				source: "user",
				lifetime: "session",
				scope,
				sessionId: "session-resume",
				sessionInstanceId: "instance-a",
				workspaceFingerprint: "workspace-1",
				sandboxProfileSha256: profileSha256,
			});
			firstProcess.close();

			const resumedProcess = SqliteTaskStore.open({ databasePath });
			expect(
				resumedProcess.listActivePermissionGrants({
					sessionId: "session-resume",
					sessionInstanceId: "instance-b",
					workspaceFingerprint: "workspace-1",
					sandboxProfileSha256: profileSha256,
				}),
			).toEqual([]);
			expect(
				resumedProcess.listActivePermissionGrants({
					sessionId: "session-resume",
					sessionInstanceId: "instance-a",
					workspaceFingerprint: "workspace-1",
					sandboxProfileSha256: profileSha256,
				}),
			).toHaveLength(1);
			resumedProcess.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
