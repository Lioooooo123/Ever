import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTaskSubmitManifest } from "../src/cli/task-submit-manifest.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Task submit manifest", () => {
	it("accepts a pinned model and resolves the current workspace", () => {
		const workspace = mkdtempSync(join(tmpdir(), "karissa-task-manifest-"));
		temporaryDirectories.push(workspace);
		const manifestPath = join(workspace, "task.json");
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schemaVersion: 1,
				goal: "Implement the task",
				workspaceRoot: ".",
				unattendedApproved: true,
				model: { provider: "openai", id: "gpt-test-2026-01-01" },
				limits: { maxTurns: 10, maxWallTimeMinutes: 30, maxCostUsd: 1 },
			}),
		);

		const manifest = readTaskSubmitManifest(manifestPath, workspace);
		expect(manifest.workspaceRoot).toBe(realpathSync(workspace));
		expect(manifest.model).toEqual({ provider: "openai", id: "gpt-test-2026-01-01" });
	});

	it("rejects a workspace outside the current directory", () => {
		const workspace = mkdtempSync(join(tmpdir(), "karissa-task-manifest-"));
		temporaryDirectories.push(workspace);
		const outside = join(workspace, "outside");
		const current = join(workspace, "current");
		mkdirSync(outside);
		mkdirSync(current);
		const manifestPath = join(current, "task.json");
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schemaVersion: 1,
				goal: "Escape",
				workspaceRoot: outside,
				unattendedApproved: true,
				limits: { maxTurns: 10, maxWallTimeMinutes: 30 },
			}),
		);

		expect(() => readTaskSubmitManifest(manifestPath, current)).toThrow("workspaceRoot");
	});
});
