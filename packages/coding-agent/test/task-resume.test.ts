import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RuntimeSnapshot, runtimeSnapshotHash, SqliteTaskStore } from "@ever/long-tasks";
import { afterEach, expect, it } from "vitest";
import { submitInteractiveTask } from "../src/cli/ever-command.ts";
import { activateTaskRun } from "../src/core/task-run.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("resumes a checkpoint without replaying the original goal", () => {
	const root = mkdtempSync(join(tmpdir(), "ever-task-resume-"));
	temporaryPaths.push(root);
	const agentDir = join(root, "agent");
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	const task = submitInteractiveTask({
		agentDir,
		cwd: workspace,
		goal: "不得重复执行",
		model: { provider: "openai-codex", id: "gpt-5.4" },
	});
	const store = SqliteTaskStore.open({
		databasePath: join(agentDir, "long-tasks.sqlite"),
		artifactsRoot: join(agentDir, "tasks"),
	});
	const mainAgent = store.listAgents(task.id).find((agent) => agent.kind === "main");
	if (!mainAgent) throw new Error("Task has no main Agent");
	const snapshot: RuntimeSnapshot = {
		everVersion: "0.1.0",
		upstreamCommit: "test",
		protocolVersion: 1,
		model: { provider: "openai-codex", id: "gpt-5.4" },
		systemPromptSha256: "prompt",
		contextFiles: [],
		resources: [],
		toolPolicySha256: "tools",
		sandboxPolicySha256: "sandbox",
	};
	const snapshotSha256 = runtimeSnapshotHash(snapshot);
	const sessionPath = join(root, "session.jsonl");
	const attemptId = store.createAttempt(mainAgent.id, "session-1", snapshot, snapshotSha256);
	const lease = store.acquireLease(mainAgent.id, "worker-1", "execution-1");
	store.commitCheckpoint({
		taskId: task.id,
		agentId: mainAgent.id,
		attemptId,
		lease,
		sessionCheckpoint: {
			sessionId: "session-1",
			sessionPath,
			settledTurnIndex: 1,
			runtimeSnapshotSha256: snapshotSha256,
			createdAt: new Date().toISOString(),
		},
		progress: {
			summary: "第一轮已完成",
			completedItems: ["已执行一次"],
			nextActions: ["等待用户输入"],
			blockers: [],
			filesRead: [],
			filesModified: [],
			verification: [],
			consumedMessageIds: [],
			outboundMessageIds: [],
		},
		evidence: [],
		workspaceSnapshot: {},
	});
	store.releaseLease(lease);
	store.close();

	const args = activateTaskRun({
		agentDir,
		taskRef: task.id,
		print: false,
		clientId: "test-cli",
	});

	expect(args).toContain("--session");
	expect(args).toContain(sessionPath);
	expect(args).not.toContain(task.goal);
});
