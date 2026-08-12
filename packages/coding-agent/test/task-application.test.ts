import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "@ever/long-tasks";
import { afterEach, describe, expect, it } from "vitest";
import { TaskApplication } from "../src/core/task-application.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function createApplication() {
	const root = mkdtempSync(join(tmpdir(), "ever-task-application-"));
	temporaryPaths.push(root);
	const agentDir = join(root, "agent");
	const workspaceRoot = join(root, "workspace");
	mkdirSync(workspaceRoot);
	return { agentDir, application: new TaskApplication(agentDir), workspaceRoot };
}

describe("TaskApplication", () => {
	it("journals and deduplicates Task control commands through its public interface", () => {
		const { agentDir, application, workspaceRoot } = createApplication();
		const task = application.submit({
			kind: "manual",
			workspaceRoot,
			title: "control",
			goal: "pause once",
			acceptanceDescription: "user confirms",
			maxTurns: 10,
			maxWallTimeMinutes: 30,
		});
		const identity = { clientId: "test-client", commandId: "pause-once" };

		const first = application.control({ action: "pause", taskRef: task.id.slice(0, 8) }, identity);
		const replay = application.control({ action: "pause", taskRef: task.id }, identity);

		expect(first).toMatchObject({ duplicate: false, task: { state: "paused" } });
		expect(replay).toMatchObject({ duplicate: true, task: { state: "paused" } });
		const store = SqliteTaskStore.open({ databasePath: join(agentDir, "long-tasks.sqlite") });
		expect(store.listEvents(task.id, 0, 100).filter((event) => event.type === "TaskPaused")).toHaveLength(1);
		expect(store.getTaskCommand(identity.clientId, identity.commandId)).toMatchObject({
			state: "completed",
			commandType: "task.pause",
			result: { ok: true, state: "paused" },
		});
		store.close();
	});

	it("rejects command identity reuse with different input", () => {
		const { application, workspaceRoot } = createApplication();
		const task = application.submit({
			kind: "manual",
			workspaceRoot,
			title: "identity",
			goal: "reject conflicts",
			acceptanceDescription: "user confirms",
			maxTurns: 10,
			maxWallTimeMinutes: 30,
		});
		const identity = { clientId: "test-client", commandId: "same-command" };
		application.control({ action: "pause", taskRef: task.id }, identity);

		expect(() => application.control({ action: "cancel", taskRef: task.id }, identity)).toThrow(
			"Task command identity conflict",
		);
	});

	it("makes manual acceptance idempotent", () => {
		const { agentDir, application, workspaceRoot } = createApplication();
		const task = application.submit({
			kind: "manual",
			workspaceRoot,
			title: "acceptance",
			goal: "accept once",
			acceptanceDescription: "user confirms",
			maxTurns: 10,
			maxWallTimeMinutes: 30,
		});
		const command = { action: "accept" as const, taskRef: task.id, criterionId: "user-acceptance" };
		const identity = { clientId: "test-client", commandId: "accept-once" };

		application.control(command, identity);
		application.control(command, identity);

		const store = SqliteTaskStore.open({ databasePath: join(agentDir, "long-tasks.sqlite") });
		expect(store.listEvents(task.id, 0, 100).filter((event) => event.type === "AcceptancePassed")).toHaveLength(1);
		store.close();
	});

	it("journals steering and delivers a retried command once", () => {
		const { agentDir, application, workspaceRoot } = createApplication();
		const task = application.submit({
			kind: "manual",
			workspaceRoot,
			title: "steering",
			goal: "change direction once",
			acceptanceDescription: "user confirms",
			maxTurns: 10,
			maxWallTimeMinutes: 30,
		});
		const agent = application.snapshot(task.id).agents[0]!;
		const command = {
			action: "steer" as const,
			taskRef: task.id,
			agentRef: agent.id.slice(0, 8),
			message: "先验证恢复路径",
		};
		const identity = { clientId: "test-client", commandId: "steer-once" };

		expect(application.control(command, identity).duplicate).toBe(false);
		expect(application.control(command, identity).duplicate).toBe(true);

		const store = SqliteTaskStore.open({ databasePath: join(agentDir, "long-tasks.sqlite") });
		expect(store.listMessages(task.id)).toHaveLength(1);
		expect(store.listMessages(task.id)[0]).toMatchObject({ body: "先验证恢复路径", type: "steering" });
		expect(store.getTaskCommand(identity.clientId, identity.commandId)).toMatchObject({
			state: "completed",
			commandType: "task.steer",
		});
		store.close();
	});
});
