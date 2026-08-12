import { join } from "node:path";
import { SqliteTaskStore, type TaskRecord } from "@ever/long-tasks";
import chalk from "chalk";
import { TaskApplication } from "../core/task-application.ts";
import { resolveTaskModel } from "../core/task-model.ts";
import { activateTaskRun } from "../core/task-run.ts";
import { requestDaemon, startDaemon } from "./daemon-command.ts";
import { submitAsyncTask } from "./ever-command.ts";
import { readTaskSubmitManifest } from "./task-submit-manifest.ts";

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function requiredOption(args: string[], name: string): string {
	const value = option(args, name);
	if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
	return value;
}

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
	return parsed;
}

function printTask(task: TaskRecord): void {
	console.log(`${task.id}\t${task.state}\t${task.title}`);
}

function printTaskHelp(): void {
	console.log(`ever task commands:
  ever task submit --manifest <path> --yes --json
  ever task create --title <title> --goal <goal> --acceptance <text>
  ever task ls
  ever task run <task-id> [--accept-runtime-drift]
  ever task show <task-id>
  ever task bundle <task-id> [--json]
  ever task pause|resume|cancel <task-id>
  ever task stop <task-id> [--agent <agent-id>]
  ever task events <task-id> [--json]
  ever task logs <task-id> [--follow]`);
}

export async function handleTaskCommand(args: string[], agentDir: string, cwd: string): Promise<boolean> {
	if (args[0] !== "task") return false;
	const command = args[1];
	if (!command || command === "--help" || command === "help") {
		printTaskHelp();
		return true;
	}
	if (command === "submit") {
		if (!args.includes("--yes")) throw new Error("task submit requires --yes for unattended workspace changes");
		if (!args.includes("--json")) throw new Error("task submit requires --json");
		const manifest = readTaskSubmitManifest(requiredOption(args, "--manifest"), cwd);
		const model = await resolveTaskModel({
			agentDir,
			cwd: manifest.workspaceRoot,
			provider: manifest.model?.provider,
			model: manifest.model?.id,
		});
		const task = await submitAsyncTask({
			agentDir,
			cwd: manifest.workspaceRoot,
			goal: manifest.goal,
			...(manifest.title ? { title: manifest.title } : {}),
			...(manifest.verification
				? {
						verificationCommand: manifest.verification.command,
						verificationCwd: manifest.verification.cwd,
						verificationTimeoutSeconds: manifest.verification.timeoutSeconds,
					}
				: {}),
			maxTurns: manifest.limits.maxTurns,
			maxWallTimeMinutes: manifest.limits.maxWallTimeMinutes,
			...(manifest.limits.maxCostUsd === undefined ? {} : { maxCostUsd: manifest.limits.maxCostUsd }),
			model,
			unsafeNoSandbox: args.includes("--unsafe-no-sandbox"),
		});
		await startDaemon(agentDir, args.includes("--unsafe-no-sandbox"));
		const response = await requestDaemon(agentDir, { command: "wake", taskId: task.id });
		if (!response.ok) throw new Error(response.message ?? "Daemon rejected Task submission");
		console.log(JSON.stringify({ schemaVersion: 1, taskId: task.id, state: task.state, createdAt: task.createdAt }));
		return true;
	}
	const store = SqliteTaskStore.open({
		databasePath: join(agentDir, "long-tasks.sqlite"),
		artifactsRoot: join(agentDir, "tasks"),
	});
	const application = new TaskApplication(agentDir, store);
	const commandIdentity = {
		clientId: "ever-cli",
		...(option(args, "--command-id") ? { commandId: requiredOption(args, "--command-id") } : {}),
	};
	try {
		if (["schedule", "agent", "agents", "messages"].includes(command))
			throw new Error(`${command} is not available in the single-Agent V0.1 runtime`);
		switch (command) {
			case "create": {
				const title = requiredOption(args, "--title");
				const goal = requiredOption(args, "--goal");
				const acceptance = requiredOption(args, "--acceptance");
				const maxTurns = positiveInteger(option(args, "--max-turns"), 200, "--max-turns");
				const maxWallTimeMinutes = positiveInteger(
					option(args, "--max-wall-time-minutes"),
					240,
					"--max-wall-time-minutes",
				);
				const maxCostText = option(args, "--max-cost-usd");
				const maxCostUsd = maxCostText === undefined ? undefined : Number(maxCostText);
				if (maxCostUsd !== undefined && (!Number.isFinite(maxCostUsd) || maxCostUsd < 0))
					throw new Error("--max-cost-usd must be a non-negative number");
				const task = application.submit({
					kind: "manual",
					workspaceRoot: cwd,
					title,
					goal,
					acceptanceDescription: acceptance,
					maxTurns,
					maxWallTimeMinutes,
					...(maxCostUsd === undefined ? {} : { maxCostUsd }),
				});
				printTask(task);
				break;
			}
			case "ls":
				for (const task of store.listTasks()) printTask(task);
				break;
			case "run": {
				const printMode = args.includes("--print") || process.env.EVER_DAEMON_WORKER === "1";
				args.splice(
					0,
					args.length,
					...activateTaskRun({
						agentDir,
						taskRef: args[2] ?? "",
						print: printMode,
						acceptRuntimeDrift: args.includes("--accept-runtime-drift"),
						clientId: commandIdentity.clientId,
					}),
				);
				return false;
			}
			case "start": {
				let task = application.resolve(args[2] ?? "");
				if (["paused", "waiting_input", "waiting_external"].includes(task.state))
					task = application.control({ action: "resume", taskRef: task.id }, commandIdentity).task;
				if (task.state !== "queued") throw new Error(`Task cannot start from state ${task.state}`);
				store.setNextWakeAt(task.id, undefined);
				const response = await requestDaemon(agentDir, { command: "wake", taskId: task.id });
				if (!response.ok) throw new Error(response.message ?? "Daemon rejected Task start");
				printTask(store.requireTask(task.id));
				break;
			}
			case "stop": {
				const task = application.resolve(args[2] ?? "");
				const response = await requestDaemon(agentDir, {
					command: "stop-agent",
					taskId: task.id,
					...(option(args, "--agent") ? { agentId: requiredOption(args, "--agent") } : {}),
				});
				if (!response.ok) throw new Error(response.message ?? "Daemon rejected Agent stop");
				console.log(JSON.stringify(response));
				break;
			}
			case "logs": {
				const task = application.resolve(args[2] ?? "");
				let afterSeq = 0;
				let reading = true;
				while (reading) {
					const events = store.listEvents(task.id, afterSeq, 500);
					for (const event of events) console.log(JSON.stringify({ schemaVersion: 1, ...event }));
					afterSeq = events.at(-1)?.seq ?? afterSeq;
					reading = args.includes("--follow");
					if (reading) await new Promise((resolve) => setTimeout(resolve, 500));
				}
				break;
			}
			case "show": {
				const task = application.resolve(args[2] ?? "");
				console.log(JSON.stringify({ schemaVersion: 1, ...task, agents: store.listAgents(task.id) }, null, 2));
				break;
			}
			case "bundle": {
				const result = application.bundle(args[2] ?? "");
				console.log(
					args.includes("--json")
						? JSON.stringify({ schemaVersion: 1, ...result }, null, 2)
						: `${result.manifestPath}\t${result.manifestSha256}\t${result.manifest.verified ? "verified" : "unverified"}`,
				);
				break;
			}
			case "pause": {
				const task = application.resolve(args[2] ?? "");
				printTask(application.control({ action: "pause", taskRef: task.id }, commandIdentity).task);
				break;
			}
			case "resume": {
				const task = application.resolve(args[2] ?? "");
				printTask(
					application.control(
						{
							action: "resume",
							taskRef: task.id,
							acceptRuntimeDrift: args.includes("--accept-runtime-drift"),
						},
						commandIdentity,
					).task,
				);
				break;
			}
			case "cancel": {
				const task = application.resolve(args[2] ?? "");
				printTask(application.control({ action: "cancel", taskRef: task.id }, commandIdentity).task);
				break;
			}
			case "accept": {
				const task = application.resolve(args[2] ?? "");
				const criterionId = args[3] ?? "";
				const criterion = task.acceptance.find((candidate) => candidate.id === criterionId);
				if (!criterion) throw new Error(`Acceptance criterion not found: ${criterionId}`);
				if (criterion.kind !== "manual") throw new Error("Only manual acceptance criteria use ever task accept");
				application.control({ action: "accept", taskRef: task.id, criterionId: criterion.id }, commandIdentity);
				console.log(criterion.id);
				break;
			}
			case "events": {
				const task = application.resolve(args[2] ?? "");
				const after = option(args, "--after");
				const afterSeq = after === undefined ? 0 : Number(after);
				if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
					throw new Error("--after must be a non-negative integer");
				for (const event of store.listEvents(task.id, afterSeq, 10_000)) {
					console.log(
						args.includes("--json")
							? JSON.stringify({ schemaVersion: 1, ...event })
							: `${event.seq}\t${event.createdAt}\t${event.type}`,
					);
				}
				break;
			}
			case "steer": {
				const task = application.resolve(args[2] ?? "");
				const targetId = requiredOption(args, "--agent");
				const body = requiredOption(args, "--message");
				const result = application.control(
					{ action: "steer", taskRef: task.id, agentRef: targetId, message: body },
					commandIdentity,
				);
				console.log(result.commandId);
				break;
			}
			default:
				throw new Error(`Unknown task command: ${command}`);
		}
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		process.exitCode = 1;
	} finally {
		store.close();
	}
	return true;
}
