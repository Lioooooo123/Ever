import { realpathSync } from "node:fs";
import type { SqliteTaskStore } from "./store.ts";
import type { AgentRecord, TaskRecord, WorkspaceMode } from "./types.ts";

export interface AgentExecutionContext {
	task: TaskRecord;
	agent: AgentRecord;
	canonicalWorkspaceRoot: string;
	workspaceMode: WorkspaceMode;
}

export function resolveAgentExecutionContext(
	store: SqliteTaskStore,
	taskId: string,
	requestedAgentId?: string,
): AgentExecutionContext {
	const task = store.requireTask(taskId);
	const agent = requestedAgentId
		? store.getAgent(requestedAgentId)
		: store.listAgents(taskId).find((candidate) => candidate.kind === "main");
	if (!agent || agent.taskId !== taskId) {
		throw new Error(`Agent ${requestedAgentId ?? "main"} does not belong to Task ${taskId}`);
	}

	const canonicalTaskRoot = realpathSync(task.workspaceRoot);
	const canonicalWorkspaceRoot = realpathSync(agent.workspaceRoot);
	if (agent.workspaceMode === "primary" && canonicalWorkspaceRoot !== canonicalTaskRoot) {
		throw new Error(`Primary Agent workspace must match Task workspace: ${agent.workspaceRoot}`);
	}
	if (agent.workspaceMode === "read_only_shared" && canonicalWorkspaceRoot !== canonicalTaskRoot) {
		throw new Error(`Read-only shared Agent workspace must match Task workspace: ${agent.workspaceRoot}`);
	}
	if (agent.workspaceMode === "isolated_worktree" && canonicalWorkspaceRoot === canonicalTaskRoot) {
		throw new Error(`Isolated Agent workspace must not match Task workspace: ${agent.workspaceRoot}`);
	}

	return { task, agent, canonicalWorkspaceRoot, workspaceMode: agent.workspaceMode };
}
