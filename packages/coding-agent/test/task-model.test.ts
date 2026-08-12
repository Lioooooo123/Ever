import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTaskModel } from "../src/core/task-model.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Task model pinning", () => {
	it("resolves an explicit authenticated model to a durable exact identity", async () => {
		const root = mkdtempSync(join(tmpdir(), "ever-task-model-"));
		temporaryPaths.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "workspace");
		mkdirSync(agentDir);
		mkdirSync(cwd);
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }), {
			mode: 0o600,
		});

		await expect(
			resolveTaskModel({ agentDir, cwd, provider: "anthropic", model: "claude-haiku-4-5" }),
		).resolves.toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
	});

	it("rejects a partial model identity", async () => {
		await expect(resolveTaskModel({ agentDir: "/tmp/unused", cwd: "/tmp", provider: "anthropic" })).rejects.toThrow(
			"必须同时指定",
		);
	});
});
