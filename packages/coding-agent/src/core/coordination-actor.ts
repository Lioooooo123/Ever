import { realpathSync } from "node:fs";
import { join } from "node:path";
import { SqliteTaskStore } from "@lioooooo123/ever-long-tasks";
import type { CoordinationActor } from "./durable-coordination.ts";
import type { ExtensionContext } from "./extensions/types.ts";
import { SessionMailboxStore } from "./session-mailbox.ts";
import { TaskApplication } from "./task-application.ts";
import { getTaskRunContext } from "./task-run-context.ts";

function openTaskStore(agentDir: string): SqliteTaskStore {
	return SqliteTaskStore.open({
		databasePath: join(agentDir, "long-tasks.sqlite"),
		artifactsRoot: join(agentDir, "tasks"),
	});
}

function mainActor(store: SqliteTaskStore, taskId: string): CoordinationActor {
	const main = store.listAgents(taskId).find((agent) => agent.kind === "main");
	if (!main) throw new Error(`Task ${taskId} has no main Agent`);
	return { taskId, agentId: main.id };
}

/** Resolve a Task's stable main Agent without exposing Store details to entry-point adapters. */
export function resolveTaskMainCoordinationActor(agentDir: string, taskId: string): CoordinationActor {
	const store = openTaskStore(agentDir);
	try {
		return mainActor(store, taskId);
	} finally {
		store.close();
	}
}

/** Resolve the current Session to a Task-local actor, creating a coordination Task only on explicit spawn. */
export function resolveCoordinationActor(
	agentDir: string,
	ctx: ExtensionContext,
	options: { create: boolean },
): CoordinationActor {
	const taskRun = getTaskRunContext();
	if (taskRun)
		return {
			taskId: taskRun.taskId,
			agentId: taskRun.agentId,
			...(taskRun.dispatchId ? { dispatchId: taskRun.dispatchId } : {}),
		};

	const attached = ctx.durableGoal.status();
	if (attached) {
		const store = openTaskStore(agentDir);
		try {
			return mainActor(store, attached.taskId);
		} finally {
			store.close();
		}
	}

	const sessionId = ctx.sessionManager.getSessionId();
	const mailbox = new SessionMailboxStore(join(agentDir, "session-mailbox.sqlite"));
	try {
		const registered = mailbox.getSession(sessionId);
		if (registered?.taskId && registered.agentId) {
			const store = openTaskStore(agentDir);
			try {
				const actor = store.getAgent(registered.agentId);
				const task = store.getTask(registered.taskId);
				if (
					actor?.taskId === registered.taskId &&
					task &&
					!["completed", "failed", "cancelled"].includes(task.state) &&
					Date.now() < Date.parse(task.createdAt) + task.budget.maxWallTimeMinutes * 60_000 &&
					realpathSync(actor.workspaceRoot) === realpathSync(ctx.cwd)
				) {
					return { taskId: actor.taskId, agentId: actor.id };
				}
			} finally {
				store.close();
			}
		}
		if (!options.create) {
			throw new Error("This Session has no coordination Task. Call agent_spawn first.");
		}
		if (!ctx.model) throw new Error("Select a model before spawning an Agent");
		const task = new TaskApplication(agentDir).submit({
			kind: "interactive",
			mode: "session",
			workspaceRoot: ctx.cwd,
			goal: `Coordinate work delegated from Session ${sessionId}`,
			title: `Session coordination ${sessionId.slice(0, 8)}`,
			model: { provider: ctx.model.provider, id: ctx.model.id },
		});
		const store = openTaskStore(agentDir);
		try {
			const actor = mainActor(store, task.id);
			store.bindInteractiveAgentSession(actor.agentId, sessionId);
			mailbox.register({
				sessionId,
				...(ctx.sessionManager.getSessionName() ? { name: ctx.sessionManager.getSessionName() } : {}),
				cwd: ctx.cwd,
				...(ctx.sessionManager.getSessionFile() ? { sessionPath: ctx.sessionManager.getSessionFile() } : {}),
				taskId: actor.taskId,
				agentId: actor.agentId,
			});
			return actor;
		} finally {
			store.close();
		}
	} finally {
		mailbox.close();
	}
}
