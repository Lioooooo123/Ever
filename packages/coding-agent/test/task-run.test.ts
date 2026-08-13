import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { submitInteractiveTask } from "../src/cli/ever-command.ts";
import { activateTaskRun } from "../src/core/task-run.ts";
import { getTaskRunContext } from "../src/core/task-run-context.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("activateTaskRun", () => {
	it("routes a durable Task into the inherited Ever CLI arguments", () => {
		const root = mkdtempSync(join(tmpdir(), "ever-task-run-"));
		temporaryPaths.push(root);
		const agentDir = join(root, "agent");
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const task = submitInteractiveTask({
			agentDir,
			cwd: workspace,
			goal: "复用原 Ever TUI",
			model: { provider: "openai-codex", id: "gpt-5.4" },
		});

		const args = activateTaskRun({
			agentDir,
			taskRef: task.id.slice(0, 8),
			print: false,
			clientId: "test-cli",
		});

		expect(args).toEqual(
			expect.arrayContaining([
				"--provider",
				"openai-codex",
				"--model",
				"gpt-5.4",
				"--append-system-prompt",
				"复用原 Ever TUI",
			]),
		);
		expect(getTaskRunContext()).toMatchObject({ taskId: task.id, acceptRuntimeDrift: false });
	});
});
