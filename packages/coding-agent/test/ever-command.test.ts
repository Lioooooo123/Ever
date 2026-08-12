import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "@ever/long-tasks";
import { afterEach, describe, expect, it } from "vitest";
import { submitAsyncTask, submitInteractiveTask } from "../src/cli/ever-command.ts";
import { handleTaskCommand } from "../src/cli/task-command.ts";
import { TaskApplication } from "../src/core/task-application.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("ever async submission", () => {
	it("creates a foreground Task without unattended sandbox approval", () => {
		const root = mkdtempSync(join(tmpdir(), "ever-submit-"));
		temporaryPaths.push(root);
		const agentDir = join(root, "agent");
		const workspace = join(root, "workspace");
		mkdirSync(workspace);

		const task = submitInteractiveTask({
			agentDir,
			cwd: workspace,
			goal: "在原 Pi TUI 中完成任务",
			model: { provider: "openai-codex", id: "gpt-5.4" },
		});

		expect(task).toMatchObject({
			state: "queued",
			constraints: {
				interactiveApproved: true,
				model: { provider: "openai-codex", id: "gpt-5.4" },
			},
		});
		expect(task.constraints.unattendedApproved).toBeUndefined();
		expect(new TaskApplication(agentDir).snapshot(task.id).agents[0]?.toolPolicy.sandboxRequired).toBe(false);
	});

	it("fails sandbox preflight before creating a Task database", async () => {
		const root = mkdtempSync(join(tmpdir(), "ever-submit-"));
		temporaryPaths.push(root);
		const agentDir = join(root, "agent");
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		await expect(
			submitAsyncTask({
				agentDir,
				cwd: workspace,
				goal: "must not queue without a sandbox",
				sandboxAvailable: false,
			}),
		).rejects.toThrow("后台任务需要可用 sandbox");
		expect(existsSync(join(agentDir, "long-tasks.sqlite"))).toBe(false);
	});

	it("creates an authorized queued task with agent evidence acceptance", async () => {
		const root = mkdtempSync(join(tmpdir(), "ever-submit-"));
		temporaryPaths.push(root);
		const agentDir = join(root, "agent");
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const task = await submitAsyncTask({
			agentDir,
			cwd: workspace,
			goal: "实现异步任务消费",
			verificationCommand: "true",
			sandboxAvailable: true,
		});
		expect(task.state).toBe("queued");
		expect(task.constraints.unattendedApproved).toBe(true);
		expect(task.workspaceRoot).toBe(realpathSync(workspace));
		expect(task.acceptance.map((criterion) => criterion.kind)).toEqual(["agent_evidence", "command"]);

		const store = SqliteTaskStore.open({ databasePath: join(agentDir, "long-tasks.sqlite") });
		expect(store.listAgents(task.id)[0]?.state).toBe("queued");
		store.close();
	});

	it("routes manual task creation through the same Task Application", async () => {
		const root = mkdtempSync(join(tmpdir(), "ever-submit-"));
		temporaryPaths.push(root);
		const agentDir = join(root, "agent");
		const workspace = join(root, "workspace");
		mkdirSync(workspace);

		const handled = await handleTaskCommand(
			["task", "create", "--title", "人工验收任务", "--goal", "统一提交入口", "--acceptance", "用户确认结果"],
			agentDir,
			workspace,
		);

		expect(handled).toBe(true);
		const store = SqliteTaskStore.open({ databasePath: join(agentDir, "long-tasks.sqlite") });
		const task = store.listTasks()[0]!;
		expect(task).toMatchObject({ state: "queued", workspaceRoot: realpathSync(workspace) });
		expect(task.acceptance).toEqual([{ id: "user-acceptance", kind: "manual", description: "用户确认结果" }]);
		store.close();
		expect(new TaskApplication(agentDir).resolve(task.id.slice(0, 8)).id).toBe(task.id);
	});
});
