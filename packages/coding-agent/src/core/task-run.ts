import { join } from "node:path";
import { SqliteTaskStore } from "@lioooooo123/ever-long-tasks";
import { TaskApplication } from "./task-application.ts";
import { setTaskRunContext } from "./task-run-context.ts";

function taskModelArgs(model: unknown): string[] {
	if (typeof model !== "object" || model === null || Array.isArray(model)) return [];
	const provider = Reflect.get(model, "provider");
	const id = Reflect.get(model, "id");
	if (typeof provider !== "string" || typeof id !== "string") throw new Error("Task model constraint is invalid");
	return ["--provider", provider, "--model", id];
}

export function activateTaskRun(input: {
	agentDir: string;
	taskRef: string;
	print: boolean;
	json?: boolean;
	acceptRuntimeDrift?: boolean;
	clientId: string;
}): string[] {
	const store = SqliteTaskStore.open({
		databasePath: join(input.agentDir, "long-tasks.sqlite"),
		artifactsRoot: join(input.agentDir, "tasks"),
	});
	try {
		const application = new TaskApplication(input.agentDir, store);
		let task = application.resolve(input.taskRef);
		const acceptRuntimeDrift = input.acceptRuntimeDrift === true;
		if (["paused", "waiting_input", "waiting_external"].includes(task.state)) {
			task = application.control(
				{ action: "resume", taskRef: task.id, acceptRuntimeDrift },
				{ clientId: input.clientId },
			).task;
		}
		if (task.state !== "queued" && task.state !== "running") {
			throw new Error(`Task cannot run from state ${task.state}`);
		}
		const mainAgent = store.listAgents(task.id).find((agent) => agent.kind === "main");
		if (!mainAgent) throw new Error(`Task ${task.id} has no main Agent`);
		const checkpoint = store.getLatestCheckpoint(mainAgent.id);
		if (checkpoint && !checkpoint.sessionCheckpoint.sessionPath) {
			throw new Error(`Task ${task.id} checkpoint has no resumable Session path`);
		}
		const acceptance = task.acceptance
			.map((criterion) =>
				criterion.kind === "manual" || criterion.kind === "agent_evidence"
					? `${criterion.id}: ${criterion.description}`
					: `${criterion.id}: ${JSON.stringify(criterion)}`,
			)
			.join("\n");
		const durableContext = `<long_task>\n<goal>${task.goal}</goal>\n<acceptance>${acceptance}</acceptance>\n<constraints>${JSON.stringify(task.constraints)}</constraints>\n<budget>${JSON.stringify(task.budget)}</budget>\n</long_task>`;
		setTaskRunContext({ taskId: task.id, agentId: mainAgent.id, acceptRuntimeDrift });
		return [
			...(checkpoint?.sessionCheckpoint.sessionPath ? ["--session", checkpoint.sessionCheckpoint.sessionPath] : []),
			...taskModelArgs(task.constraints.model),
			"--append-system-prompt",
			durableContext,
			...(input.json ? ["--mode", "json"] : input.print ? ["--print"] : []),
			...(checkpoint ? [] : [task.goal]),
		];
	} finally {
		store.close();
	}
}
