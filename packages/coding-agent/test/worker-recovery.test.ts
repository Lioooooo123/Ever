import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryTaskStore, runtimeSnapshotHash, TaskController } from "@lioooooo123/ever-long-tasks";
import { afterEach, describe, expect, it } from "vitest";
import { recoverExpiredLongTaskExecutions } from "../src/core/long-task-runtime.ts";
import { type WorkerDescriptor, WorkerRegistry } from "../src/daemon/worker-registry.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(descriptorExecutionId = "execution-1", sandboxId?: string) {
	let now = new Date("2026-08-12T00:00:00.000Z");
	const store = createInMemoryTaskStore(() => now);
	const task = new TaskController(store).submit(
		new TaskController(store).create({
			title: "recovery identity",
			goal: "prove the old Worker stopped",
			acceptance: [],
			budget: { maxTurns: 5, maxWallTimeMinutes: 10 },
			workspaceRoot: process.cwd(),
			workspaceFingerprint: "fingerprint",
		}).id,
	);
	const agent = store.listAgents(task.id)[0]!;
	const snapshot = {
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
	store.claimAttempt({
		agentId: agent.id,
		runtimeSnapshot: snapshot,
		runtimeSnapshotSha256: runtimeSnapshotHash(snapshot),
		workerId: "worker-1",
		executionId: "execution-1",
		leaseSeconds: 1,
		pid: 123,
		...(sandboxId ? { sandboxId } : {}),
	});
	now = new Date("2026-08-12T00:00:02.000Z");
	const runDirectory = mkdtempSync(join(tmpdir(), "ever-worker-recovery-"));
	temporaryPaths.push(runDirectory);
	const registry = new WorkerRegistry(runDirectory);
	const descriptor: WorkerDescriptor = {
		schemaVersion: 1,
		workerId: "worker-1",
		executionId: descriptorExecutionId,
		agentId: agent.id,
		taskId: task.id,
		activeSessionId: "session-1",
		pid: 123,
		processGroupId: 123,
		supervisorGeneration: "generation-1",
		privateSocketPath: join(runDirectory, "worker.sock"),
		tokenSha256: "token",
		workspaceRoot: process.cwd(),
		lifecycle: "resident",
		...(sandboxId ? { sandboxId } : {}),
		state: "exited",
		heartbeatAt: now.toISOString(),
		startedAt: new Date("2026-08-12T00:00:00.000Z").toISOString(),
	};
	registry.write(descriptor);
	return { agent, registry, store };
}

describe("Worker Registry recovery proof", () => {
	it("recovers only when the full Worker execution identity is exited", async () => {
		const { agent, registry, store } = fixture();

		const result = await recoverExpiredLongTaskExecutions(store, registry);

		expect(result).toEqual([{ agentId: agent.id, recovered: true }]);
		store.close();
	});

	it("rejects an exited descriptor from a different execution", async () => {
		const { agent, registry, store } = fixture("execution-reused-pid");

		const result = await recoverExpiredLongTaskExecutions(store, registry);

		expect(result).toEqual([{ agentId: agent.id, recovered: false, reason: "old_execution_not_stopped" }]);
		expect(store.requireTask(agent.taskId).state).toBe("running");
		expect(store.requireAgent(agent.id).state).toBe("running");
		expect(store.listExpiredExecutions()).toHaveLength(1);
		store.close();
	});

	it("accepts an exited descriptor as stop proof for the same sandbox execution", async () => {
		const { agent, registry, store } = fixture("execution-1", "seatbelt:profile-1");

		const result = await recoverExpiredLongTaskExecutions(store, registry);

		expect(result).toEqual([{ agentId: agent.id, recovered: true }]);
		store.close();
	});
});
