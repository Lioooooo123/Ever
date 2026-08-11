import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "@karissa/long-tasks";
import { afterEach, describe, expect, it } from "vitest";
import { submitAsyncTask } from "../src/cli/karissa-command.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("karissa async submission", () => {
	it("creates an authorized queued task with agent evidence acceptance", async () => {
		const root = mkdtempSync(join(tmpdir(), "karissa-submit-"));
		temporaryPaths.push(root);
		const agentDir = join(root, "agent");
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const task = await submitAsyncTask({
			agentDir,
			cwd: workspace,
			goal: "实现异步任务消费",
			verificationCommand: "true",
		});
		expect(task.state).toBe("queued");
		expect(task.constraints.unattendedApproved).toBe(true);
		expect(task.workspaceRoot).toBe(realpathSync(workspace));
		expect(task.acceptance.map((criterion) => criterion.kind)).toEqual(["agent_evidence", "command"]);

		const store = SqliteTaskStore.open({ databasePath: join(agentDir, "long-tasks.sqlite") });
		expect(store.listAgents(task.id)[0]?.state).toBe("queued");
		store.close();
	});
});
