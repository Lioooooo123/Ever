import type { TaskRecord } from "@lioooooo123/ever-long-tasks";
import { TaskApplication } from "../core/task-application.ts";
import { getTaskRunContext } from "../core/task-run-context.ts";

export async function submitAsyncTask(input: {
	agentDir: string;
	cwd: string;
	goal: string;
	title?: string;
	verificationCommand?: string;
	verificationCwd?: string;
	verificationTimeoutSeconds?: number;
	maxTurns?: number;
	maxWallTimeMinutes?: number;
	maxCostUsd?: number;
	model?: { provider: string; id: string };
	sandboxAvailable?: boolean;
	unsafeNoSandbox?: boolean;
}): Promise<TaskRecord> {
	return new TaskApplication(input.agentDir).submit({
		kind: "unattended",
		workspaceRoot: input.cwd,
		goal: input.goal,
		...(input.title === undefined ? {} : { title: input.title }),
		...(input.verificationCommand === undefined ? {} : { verificationCommand: input.verificationCommand }),
		...(input.verificationCwd === undefined ? {} : { verificationCwd: input.verificationCwd }),
		...(input.verificationTimeoutSeconds === undefined
			? {}
			: { verificationTimeoutSeconds: input.verificationTimeoutSeconds }),
		...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
		...(input.maxWallTimeMinutes === undefined ? {} : { maxWallTimeMinutes: input.maxWallTimeMinutes }),
		...(input.maxCostUsd === undefined ? {} : { maxCostUsd: input.maxCostUsd }),
		...(input.model === undefined ? {} : { model: input.model }),
		...(input.sandboxAvailable === undefined ? {} : { sandboxAvailable: input.sandboxAvailable }),
		...(input.unsafeNoSandbox === undefined ? {} : { unsafeNoSandbox: input.unsafeNoSandbox }),
	});
}

export function submitInteractiveTask(input: {
	agentDir: string;
	cwd: string;
	goal: string;
	verificationCommand?: string;
	maxTurns?: number;
	maxWallTimeMinutes?: number;
	maxCostUsd?: number;
	model: { provider: string; id: string };
}): TaskRecord {
	return new TaskApplication(input.agentDir).submit({
		kind: "interactive",
		workspaceRoot: input.cwd,
		goal: input.goal,
		...(input.verificationCommand === undefined ? {} : { verificationCommand: input.verificationCommand }),
		...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
		...(input.maxWallTimeMinutes === undefined ? {} : { maxWallTimeMinutes: input.maxWallTimeMinutes }),
		...(input.maxCostUsd === undefined ? {} : { maxCostUsd: input.maxCostUsd }),
		model: input.model,
	});
}

export async function handleEverCommand(args: string[], _agentDir: string, _cwd: string): Promise<boolean> {
	if (getTaskRunContext() || process.env.EVER_DAEMON_WORKER === "1") return false;
	if (args[0] === "models") {
		args.splice(0, args.length, "--list-models", ...args.slice(1));
	}
	return false;
}
