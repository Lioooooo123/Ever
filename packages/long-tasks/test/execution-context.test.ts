import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryTaskStore, resolveAgentExecutionContext, TaskController } from "../src/index.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("agent execution context", () => {
	it("resolves main and isolated subagent workspaces from the Agent record", () => {
		const root = mkdtempSync(join(tmpdir(), "ever-execution-context-"));
		temporaryPaths.push(root);
		const primary = join(root, "primary");
		const isolated = join(root, "isolated");
		mkdirSync(primary);
		mkdirSync(isolated);
		const store = createInMemoryTaskStore();
		const controller = new TaskController(store);
		const task = controller.create({
			title: "workspace routing",
			goal: "run each agent in its assigned workspace",
			acceptance: [],
			budget: { maxTurns: 10, maxWallTimeMinutes: 10 },
			workspaceRoot: primary,
			workspaceFingerprint: "fingerprint",
		});
		const main = store.listAgents(task.id)[0]!;
		const delegated = store.createDelegation({
			actor: main,
			operationKey: "isolated-agent",
			name: "worker",
			role: "implementation",
			objective: "edit only the isolated worktree",
			acceptance: [],
			paths: [primary],
			allowedTools: ["read", "write"],
			workspaceMode: "isolated_worktree",
			budget: { maxTurns: 5, maxWallTimeMinutes: 5 },
			required: true,
			workspaceRoot: isolated,
		});
		expect(resolveAgentExecutionContext(store, task.id).canonicalWorkspaceRoot).toBe(realpathSync(primary));
		expect(resolveAgentExecutionContext(store, task.id, delegated.agentId)).toMatchObject({
			canonicalWorkspaceRoot: realpathSync(isolated),
			workspaceMode: "isolated_worktree",
		});
		store.close();
	});

	it("rejects an isolated Agent that points at the primary workspace", () => {
		const root = mkdtempSync(join(tmpdir(), "ever-execution-context-"));
		temporaryPaths.push(root);
		const store = createInMemoryTaskStore();
		const controller = new TaskController(store);
		const task = controller.create({
			title: "workspace isolation",
			goal: "reject shared writes",
			acceptance: [],
			budget: { maxTurns: 10, maxWallTimeMinutes: 10 },
			workspaceRoot: root,
			workspaceFingerprint: "fingerprint",
		});
		const main = store.listAgents(task.id)[0]!;
		const delegated = store.createDelegation({
			actor: main,
			operationKey: "invalid-isolated-agent",
			name: "worker",
			role: "implementation",
			objective: "edit",
			acceptance: [],
			paths: [root],
			allowedTools: ["read"],
			workspaceMode: "isolated_worktree",
			budget: { maxTurns: 5, maxWallTimeMinutes: 5 },
			required: true,
			workspaceRoot: root,
		});

		expect(() => resolveAgentExecutionContext(store, task.id, delegated.agentId)).toThrow(
			"Isolated Agent workspace must not match Task workspace",
		);
		store.close();
	});
});
