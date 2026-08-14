import { describe, expect, it } from "vitest";
import {
	compareRuntimeSnapshots,
	createInMemoryTaskStore,
	DurableAgentCoordinator,
	defaultToolEffect,
	ExecutionPolicy,
	RecoveryEngine,
	type RuntimeSnapshot,
	runtimeSnapshotHash,
	TaskContextBuilder,
	TaskController,
	TaskNotificationDispatcher,
	WorkspaceAllocator,
} from "../src/index.ts";

const NOW = new Date("2026-08-10T00:00:00.000Z");

function runtimeSnapshot(): RuntimeSnapshot {
	return {
		everVersion: "0.1.0",
		upstreamCommit: "31b513e",
		protocolVersion: 1,
		model: { provider: "test", id: "faux" },
		systemPromptSha256: "prompt",
		contextFiles: [],
		resources: [],
		toolPolicySha256: "tools",
		sandboxPolicySha256: "sandbox",
	};
}

function createTask() {
	const store = createInMemoryTaskStore(() => NOW);
	const controller = new TaskController(store);
	const task = controller.create({
		title: "durable task",
		goal: "finish safely",
		acceptance: [{ id: "tests", kind: "command", command: "npm test", cwd: "/repo", timeoutSeconds: 60 }],
		budget: { maxTurns: 20, maxWallTimeMinutes: 60, maxCostUsd: 5, mode: "hard" },
		workspaceRoot: "/repo",
		workspaceFingerprint: "fingerprint",
	});
	const main = store.listAgents(task.id)[0]!;
	return { store, controller, task, main };
}

describe("task controller", () => {
	it("creates a task and its unique main agent atomically", () => {
		const { store, task, main } = createTask();
		expect(task.state).toBe("draft");
		expect(main.kind).toBe("main");
		expect(store.listEvents(task.id).map((event) => event.type)).toEqual([
			"AuthorizationCompileRequested",
			"AgentDispatchCreated",
			"TaskCreated",
			"AgentCreated",
		]);
		store.close();
	});

	it("enforces legal transitions and acceptance completion gates", () => {
		const { store, controller, task } = createTask();
		expect(() => controller.pause(task.id)).toThrow("Illegal task transition");
		controller.submit(task.id);
		store.transitionTask(task.id, "running");
		expect(() => controller.requestCompletion(task.id)).toThrow("Acceptance criterion has not passed");
		controller.recordAcceptance(task.id, "tests", true, { exitCode: 0 });
		expect(() => controller.requestCompletion(task.id)).toThrow("Task completion requires a checkpoint");
		store.close();
	});
});

describe("task notifications", () => {
	it("persists and delivers a terminal notification once", async () => {
		const { store, controller, task } = createTask();
		controller.submit(task.id);
		store.transitionTask(task.id, "running");
		store.recordAcceptance(task.id, "tests", true, { exitCode: 0 });
		store.transitionTask(task.id, "failed", "test_failure");
		const delivered: string[] = [];
		const dispatcher = new TaskNotificationDispatcher(store, {
			async send(notification) {
				delivered.push(notification.id);
			},
		});
		expect(await dispatcher.dispatchPending()).toBe(1);
		expect(await dispatcher.dispatchPending()).toBe(0);
		expect(delivered).toHaveLength(1);
		store.close();
	});
});

describe("durable coordination", () => {
	it("does not report deadlock while a live-delivery message is in flight", () => {
		const { store, controller, task, main } = createTask();
		controller.submit(task.id);
		store.transitionTask(task.id, "running");
		const child = store.requireAgent(
			store.createDelegation({
				actor: main,
				operationKey: "deadlock-child",
				name: "deadlock-child",
				role: "worker",
				objective: "wait for direction",
				acceptance: [],
				paths: ["."],
				allowedTools: [],
				workspaceMode: "read_only_shared",
				budget: { maxTurns: 2, maxWallTimeMinutes: 10 },
				required: false,
			}).agentId,
		);
		store.transitionAgent(main.id, "running");
		store.transitionAgent(main.id, "waiting_message");
		store.transitionAgent(child.id, "running");
		store.transitionAgent(child.id, "waiting_message");
		const messageId = store.queueMessage({
			actor: main,
			recipient: child,
			dedupeKey: "deadlock-steer",
			type: "steering",
			priority: "high",
			body: "resume",
			artifactRefs: [],
		});
		expect(store.claimAgentMessageForLiveDelivery(messageId, child.id)).toBe(true);

		expect(store.detectCoordinationDeadlock(task.id)).toBe(false);
		expect(store.requireTask(task.id).state).toBe("running");
		store.close();
	});

	it("scopes idempotency to one Task actor and rejects changed payloads", async () => {
		const { store, controller, task, main } = createTask();
		const coordinator = new DurableAgentCoordinator(store);
		const command = {
			type: "delegate" as const,
			operationKey: "shared-key",
			name: "reviewer-a",
			role: "review",
			objective: "review a",
			acceptance: [],
			scope: { paths: ["."], allowedTools: [], workspaceMode: "read_only_shared" as const },
			budget: { maxTurns: 2, maxWallTimeMinutes: 10 },
			required: true,
		};
		await coordinator.coordinate({ taskId: task.id, agentId: main.id, kind: "main" }, command);
		await expect(
			coordinator.coordinate(
				{ taskId: task.id, agentId: main.id, kind: "main" },
				{ ...command, objective: "changed input" },
			),
		).rejects.toThrow("reused with different input");

		const otherTask = controller.create({
			title: "other",
			goal: "other",
			acceptance: [],
			budget: { maxTurns: 10, maxWallTimeMinutes: 30 },
			workspaceRoot: "/repo",
			workspaceFingerprint: "other",
		});
		const otherMain = store.listAgents(otherTask.id)[0]!;
		await expect(
			coordinator.coordinate(
				{ taskId: otherTask.id, agentId: otherMain.id, kind: "main" },
				{ ...command, name: "reviewer-b" },
			),
		).resolves.toMatchObject({ kind: "delegated", replayed: false });
		store.close();
	});

	it("deduplicates delegation and messages and acknowledges inbox only with a checkpoint", async () => {
		const { store, task, main } = createTask();
		const coordinator = new DurableAgentCoordinator(store);
		const actor = { taskId: task.id, agentId: main.id, kind: "main" as const };
		const command = {
			type: "delegate" as const,
			operationKey: "delegate-1",
			name: "reviewer",
			role: "review",
			objective: "review files",
			acceptance: [{ id: "report", kind: "manual" as const, description: "report received" }],
			scope: { paths: ["."], allowedTools: ["read"], workspaceMode: "read_only_shared" as const },
			budget: { maxTurns: 5, maxWallTimeMinutes: 10 },
			required: true,
		};
		const first = await coordinator.coordinate(actor, command);
		const replay = await coordinator.coordinate(actor, command);
		expect(first.kind).toBe("delegated");
		expect(replay).toEqual({ ...first, replayed: true });
		if (first.kind !== "delegated") throw new Error("delegation expected");

		const message = await coordinator.coordinate(actor, {
			type: "message",
			operationKey: "message-1",
			recipientAgentId: first.agentId,
			messageType: "directive",
			body: "inspect",
		});
		const messageReplay = await coordinator.coordinate(actor, {
			type: "message",
			operationKey: "message-1",
			recipientAgentId: first.agentId,
			messageType: "directive",
			body: "inspect",
		});
		expect(messageReplay).toEqual({ ...message, replayed: true });

		const snapshot = runtimeSnapshot();
		const snapshotHash = runtimeSnapshotHash(snapshot);
		const attemptId = store.createAttempt(first.agentId, "session-child", snapshot, snapshotHash);
		const lease = store.acquireLease(first.agentId, "worker", "execution");
		const claimed = await coordinator.claimInbox(first.agentId, lease, 20);
		const redelivered = await coordinator.claimInbox(first.agentId, lease, 20);
		expect(redelivered.messages.map(({ id }) => id)).toEqual(claimed.messages.map(({ id }) => id));

		await coordinator.commitCheckpoint({
			taskId: task.id,
			agentId: first.agentId,
			attemptId,
			lease,
			sessionCheckpoint: {
				sessionId: "session-child",
				settledTurnIndex: 1,
				runtimeSnapshotSha256: snapshotHash,
				createdAt: NOW.toISOString(),
			},
			progress: {
				summary: "read directive",
				completedItems: [],
				nextActions: ["inspect"],
				blockers: [],
				filesRead: [],
				filesModified: [],
				verification: [],
				consumedMessageIds: claimed.messages.map(({ id }) => id),
				outboundMessageIds: [],
			},
			evidence: [],
			workspaceSnapshot: {},
		});
		expect((await coordinator.claimInbox(first.agentId, lease, 20)).messages).toEqual([]);
		expect(store.requireAgent(first.agentId).toolPolicy.allowedPaths).toEqual(["/repo"]);
		const childIdentity = { taskId: task.id, agentId: first.agentId, kind: "subagent" as const };
		const dispatchId = store.getRunnableAgentDispatch(first.agentId)!.id;
		const rejectedCompletion = await coordinator.coordinate(childIdentity, {
			type: "report",
			operationKey: "report-incomplete",
			dispatchId,
			status: "completed",
			summary: "done",
			evidence: [{ id: "report", kind: "event", ref: "event:1" }],
			acceptanceResults: [{ criterionId: "report", passed: false }],
		});
		expect(rejectedCompletion).toMatchObject({ kind: "report", agentState: "running" });
		const acceptedCompletion = await coordinator.coordinate(childIdentity, {
			type: "report",
			operationKey: "report-complete",
			dispatchId,
			status: "completed",
			summary: "done",
			evidence: [{ id: "report", kind: "event", ref: "event:2" }],
			acceptanceResults: [{ criterionId: "report", passed: true }],
		});
		expect(acceptedCompletion).toMatchObject({ kind: "report", agentState: "completed" });
		store.close();
	});

	it("uses atomic hard-budget reservations", () => {
		const { store, main } = createTask();
		const snapshot = runtimeSnapshot();
		const attemptId = store.createAttempt(main.id, "session-main", snapshot, runtimeSnapshotHash(snapshot));
		const reservation = store.reserveBudget(main.id, attemptId, "request-1", 2);
		expect(() => store.reserveBudget(main.id, attemptId, "request-2", 4)).toThrow("Task cost budget exceeded");
		store.settleBudget(reservation, 1.25);
		expect(store.requireTask(main.taskId).totalTurns).toBe(1);
		expect(store.requireTask(main.taskId).totalCostUsd).toBe(1.25);
		store.close();
	});
});

describe("runtime and policy", () => {
	it("hashes snapshots canonically and detects semantic drift", () => {
		const previous = runtimeSnapshot();
		const current = { ...runtimeSnapshot(), model: { provider: "test", id: "faux-v2" } };
		expect(compareRuntimeSnapshots(previous, previous).compatible).toBe(true);
		expect(compareRuntimeSnapshots(previous, current).changedFields).toEqual(["model"]);
	});

	it("enforces read-only tools and retains mandatory context fields", () => {
		expect(defaultToolEffect("read")).toBe("read_only");
		expect(defaultToolEffect("write")).toBe("reconcilable_write");
		expect(defaultToolEffect("bash")).toBe("process");
		expect(defaultToolEffect("send_message")).toBe("external_side_effect");
		const { store, task, main } = createTask();
		const policyRoot = process.cwd();
		const policyPath = join(policyRoot, "a.ts");
		const readOnly = {
			...main,
			toolPolicy: { allowedTools: ["read"], allowedPaths: [policyRoot], readOnly: true, sandboxRequired: true },
		};
		const policy = new ExecutionPolicy();
		expect(
			policy.authorizeTool(
				readOnly,
				{ name: "read", paths: [policyPath], effect: "read_only" },
				{ sandboxAvailable: true, unattended: false },
			),
		).toEqual({ allowed: true });
		expect(
			policy.authorizeTool(
				readOnly,
				{ name: "write", paths: [policyPath], effect: "reconcilable_write" },
				{ sandboxAvailable: true, unattended: false },
			),
		).toMatchObject({ allowed: false });
		const unattended = { ...main, toolPolicy: { ...main.toolPolicy, allowedPaths: [policyRoot] } };
		expect(
			policy.authorizeTool(
				unattended,
				{ name: "bash", paths: [policyRoot], effect: "process" },
				{ sandboxAvailable: false, unattended: true },
			),
		).toMatchObject({ allowed: false, code: "unattended_sandbox_required" });
		const context = new TaskContextBuilder().build({ task, agent: main, evidence: [] });
		expect(context).toContain("<goal>finish safely</goal>");
		expect(context).toContain("<acceptance>");
		expect(context).toContain("<tool_policy>");
		expect(context).not.toContain("<delegation_scope>");
		expect(context).not.toContain("<agent_roster>");
		store.close();
	});
});

describe("recovery barrier", () => {
	it("revokes an expired worker before allowing a new lease", async () => {
		let now = new Date("2026-08-10T00:00:00.000Z");
		const store = createInMemoryTaskStore(() => now);
		const controller = new TaskController(store);
		const task = controller.create({
			title: "recover",
			goal: "recover safely",
			acceptance: [],
			budget: { maxTurns: 5, maxWallTimeMinutes: 10 },
			workspaceRoot: "/repo",
			workspaceFingerprint: "fingerprint",
		});
		controller.submit(task.id);
		store.transitionTask(task.id, "running");
		const agent = store.listAgents(task.id)[0]!;
		const snapshot = runtimeSnapshot();
		const attemptId = store.createAttempt(agent.id, "session", snapshot, runtimeSnapshotHash(snapshot));
		const lease = store.acquireLease(agent.id, "worker-1", "execution-1", 1, { pid: 123 });
		store.appendAgentEvent(lease, attemptId, "ToolStarted", {
			toolCallId: "read-1",
			toolName: "read",
			effect: "read_only",
			executionId: lease.executionId,
			fencingToken: lease.fencingToken,
		});
		now = new Date("2026-08-10T00:00:02.000Z");
		expect(() => store.acquireLease(agent.id, "worker-2", "execution-2")).toThrow("recovery barrier");
		const engine = new RecoveryEngine(store, { stopExecution: async () => true });
		expect(await engine.recover(agent.id)).toEqual({ agentId: agent.id, recovered: true });
		const nextLease = store.acquireLease(agent.id, "worker-2", "execution-2");
		expect(nextLease.fencingToken).toBe(2);
		store.close();
	});
});

describe("workspace allocator", () => {
	it("creates an isolated worktree from a verified dirty snapshot", () => {
		const root = mkdtempSync(join(tmpdir(), "ever-workspace-"));
		const repo = join(root, "repo");
		execFileSync("git", ["init", repo]);
		execFileSync("git", ["config", "user.email", "ever@example.test"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Ever Test"], { cwd: repo });
		writeFileSync(join(repo, "tracked.txt"), "base\n");
		execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
		execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
		writeFileSync(join(repo, "tracked.txt"), "changed\n");
		writeFileSync(join(repo, "new.txt"), "new\n");
		const allocation = new WorkspaceAllocator({
			worktreesRoot: join(root, "worktrees"),
			artifactsRoot: join(root, "artifacts"),
			now: () => NOW,
		}).allocate({ repoRoot: repo, taskId: "task-12345678", agentId: "agent-12345678", paths: [repo] });
		expect(readFileSync(join(allocation.worktreePath, "tracked.txt"), "utf8")).toBe("changed\n");
		expect(readFileSync(join(allocation.worktreePath, "new.txt"), "utf8")).toBe("new\n");
		expect(allocation.snapshot.untrackedFiles).toHaveLength(1);
	});
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
