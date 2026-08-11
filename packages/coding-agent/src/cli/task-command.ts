import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { SqliteTaskStore, TaskController, type TaskRecord } from "@karissa/long-tasks";
import chalk from "chalk";
import { requestDaemon, startDaemon } from "./daemon-command.ts";
import { submitAsyncTask } from "./karissa-command.ts";
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

function gitValue(cwd: string, args: string[]): string | undefined {
	try {
		return (
			execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined
		);
	} catch {
		return undefined;
	}
}

function workspaceIdentity(cwd: string): { root: string; fingerprint: string; head?: string } {
	const root = gitValue(cwd, ["rev-parse", "--show-toplevel"]) ?? realpathSync(cwd);
	const remote =
		gitValue(root, ["remote", "get-url", "origin"]) ??
		gitValue(root, ["remote", "get-url", "upstream"]) ??
		"no-remote";
	const branch = gitValue(root, ["branch", "--show-current"]) ?? "detached";
	const head = gitValue(root, ["rev-parse", "HEAD"]);
	const fingerprint = createHash("sha256")
		.update(`${realpathSync(root)}\0${remote}\0${branch}`)
		.digest("hex");
	return { root, fingerprint, ...(head === undefined ? {} : { head }) };
}

function resolveTask(store: SqliteTaskStore, id: string): TaskRecord {
	const exact = store.getTask(id);
	if (exact) return exact;
	const matches = store.listTasks(10_000).filter((task) => task.id.startsWith(id));
	if (matches.length === 1) return matches[0]!;
	if (matches.length > 1) throw new Error(`Task ID prefix is ambiguous: ${id}`);
	throw new Error(`Task not found: ${id}`);
}

function printTask(task: TaskRecord): void {
	console.log(`${task.id}\t${task.state}\t${task.title}`);
}

function taskModelArgs(task: TaskRecord): string[] {
	const model = task.constraints.model;
	if (typeof model !== "object" || model === null || Array.isArray(model)) return [];
	const provider = Reflect.get(model, "provider");
	const id = Reflect.get(model, "id");
	if (typeof provider !== "string" || typeof id !== "string") throw new Error("Task model constraint is invalid");
	return ["--provider", provider, "--model", id];
}

function printTaskHelp(): void {
	console.log(`karissa task commands:
  karissa task submit --manifest <path> --yes --json
  karissa task create --title <title> --goal <goal> --acceptance <text>
  karissa task ls
  karissa task run <task-id> [--accept-runtime-drift]
  karissa task show <task-id>
  karissa task pause|resume|cancel <task-id>
  karissa task events <task-id> [--json]
  karissa task logs <task-id> [--follow]`);
}

export async function handleTaskCommand(
	args: string[],
	agentDir: string,
	cwd: string,
	enabled = true,
): Promise<boolean> {
	if (args[0] !== "task") return false;
	if (!enabled) {
		console.error(chalk.red("Error: Long Tasks are disabled by longTasks.enabled"));
		process.exitCode = 1;
		return true;
	}
	const command = args[1];
	if (!command || command === "--help" || command === "help") {
		printTaskHelp();
		return true;
	}
	if (command === "submit") {
		if (!args.includes("--yes")) throw new Error("task submit requires --yes for unattended workspace changes");
		if (!args.includes("--json")) throw new Error("task submit requires --json");
		const manifest = readTaskSubmitManifest(requiredOption(args, "--manifest"), cwd);
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
			...(manifest.model === undefined ? {} : { model: manifest.model }),
		});
		await startDaemon(agentDir);
		const response = await requestDaemon(agentDir, { command: "wake", taskId: task.id });
		if (!response.ok) throw new Error(response.message ?? "Daemon rejected Task submission");
		console.log(JSON.stringify({ schemaVersion: 1, taskId: task.id, state: task.state, createdAt: task.createdAt }));
		return true;
	}
	const store = SqliteTaskStore.open({
		databasePath: join(agentDir, "long-tasks.sqlite"),
		artifactsRoot: join(agentDir, "tasks"),
	});
	const controller = new TaskController(store);
	try {
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
				const workspace = workspaceIdentity(cwd);
				const task = controller.create({
					title,
					goal,
					acceptance: [{ id: "user-acceptance", kind: "manual", description: acceptance }],
					budget: {
						maxTurns,
						maxWallTimeMinutes,
						...(maxCostUsd === undefined ? {} : { maxCostUsd, mode: "hard" }),
					},
					workspaceRoot: workspace.root,
					workspaceFingerprint: workspace.fingerprint,
					...(workspace.head === undefined ? {} : { initialGitHead: workspace.head }),
				});
				controller.submit(task.id);
				printTask(store.requireTask(task.id));
				break;
			}
			case "ls":
				for (const task of store.listTasks()) printTask(task);
				break;
			case "run": {
				let task = resolveTask(store, args[2] ?? "");
				const acceptRuntimeDrift = args.includes("--accept-runtime-drift");
				if (task.state === "paused" || task.state === "waiting_input" || task.state === "waiting_external") {
					task = controller.resume(task.id, acceptRuntimeDrift);
				}
				if (task.state !== "queued" && task.state !== "running")
					throw new Error(`Task cannot run from state ${task.state}`);
				const mainAgent = store.listAgents(task.id).find((agent) => agent.kind === "main");
				if (!mainAgent) throw new Error(`Task ${task.id} has no main Agent`);
				const checkpoint = store.getLatestCheckpoint(mainAgent.id);
				const printMode = args.includes("--print") || process.env.KARISSA_DAEMON_WORKER === "1";
				const acceptance = task.acceptance
					.map(
						(criterion) =>
							`${criterion.id}: ${criterion.kind === "manual" || criterion.kind === "agent_evidence" ? criterion.description : JSON.stringify(criterion)}`,
					)
					.join("\n");
				const durableContext = `<long_task>\n<goal>${task.goal}</goal>\n<acceptance>${acceptance}</acceptance>\n<constraints>${JSON.stringify(task.constraints)}</constraints>\n<budget>${JSON.stringify(task.budget)}</budget>\n</long_task>`;
				process.env.KARISSA_TASK_RUN_ID = task.id;
				if (acceptRuntimeDrift) process.env.KARISSA_ACCEPT_RUNTIME_DRIFT = "1";
				args.splice(
					0,
					args.length,
					...(checkpoint?.sessionCheckpoint.sessionPath
						? ["--session", checkpoint.sessionCheckpoint.sessionPath]
						: []),
					...taskModelArgs(task),
					"--append-system-prompt",
					durableContext,
					...(printMode ? ["--print"] : []),
					task.goal,
				);
				return false;
			}
			case "start": {
				let task = resolveTask(store, args[2] ?? "");
				if (["paused", "waiting_input", "waiting_external"].includes(task.state)) task = controller.resume(task.id);
				if (task.state !== "queued") throw new Error(`Task cannot start from state ${task.state}`);
				store.setNextWakeAt(task.id, undefined);
				const response = await requestDaemon(agentDir, { command: "wake", taskId: task.id });
				if (!response.ok) throw new Error(response.message ?? "Daemon rejected Task start");
				printTask(store.requireTask(task.id));
				break;
			}
			case "schedule": {
				const task = resolveTask(store, args[2] ?? "");
				const at = requiredOption(args, "--at");
				if (!Number.isFinite(Date.parse(at))) throw new Error("--at must be an ISO date-time");
				printTask(store.setNextWakeAt(task.id, new Date(at).toISOString()));
				try {
					await requestDaemon(agentDir, { command: "wake", taskId: task.id });
				} catch {
					// The persisted wake condition remains valid when the daemon is offline.
				}
				break;
			}
			case "logs": {
				const task = resolveTask(store, args[2] ?? "");
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
				const task = resolveTask(store, args[2] ?? "");
				console.log(JSON.stringify({ schemaVersion: 1, ...task, agents: store.listAgents(task.id) }, null, 2));
				break;
			}
			case "pause": {
				const task = resolveTask(store, args[2] ?? "");
				printTask(controller.pause(task.id));
				break;
			}
			case "resume": {
				const task = resolveTask(store, args[2] ?? "");
				printTask(controller.resume(task.id, args.includes("--accept-runtime-drift")));
				break;
			}
			case "cancel": {
				const task = resolveTask(store, args[2] ?? "");
				printTask(controller.cancel(task.id));
				break;
			}
			case "accept": {
				const task = resolveTask(store, args[2] ?? "");
				const criterionId = args[3] ?? "";
				const criterion = task.acceptance.find((candidate) => candidate.id === criterionId);
				if (!criterion) throw new Error(`Acceptance criterion not found: ${criterionId}`);
				if (criterion.kind !== "manual") throw new Error("Only manual acceptance criteria use karissa task accept");
				controller.recordAcceptance(task.id, criterion.id, true, {
					confirmedBy: "user",
					confirmedAt: new Date().toISOString(),
				});
				console.log(criterion.id);
				break;
			}
			case "events": {
				const task = resolveTask(store, args[2] ?? "");
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
			case "agents": {
				const task = resolveTask(store, args[2] ?? "");
				for (const agent of store.listAgents(task.id))
					console.log(`${agent.id}\t${agent.kind}\t${agent.state}\t${agent.role}`);
				break;
			}
			case "agent": {
				if (!(["show", "run", "pause", "resume", "cancel"] as string[]).includes(args[2] ?? ""))
					throw new Error("Expected: karissa task agent <show|run|pause|resume|cancel> <task-id> <agent-id>");
				const task = resolveTask(store, args[3] ?? "");
				const agentId = args[4] ?? "";
				const matches = store
					.listAgents(task.id)
					.filter((candidate) => candidate.id === agentId || candidate.id.startsWith(agentId));
				if (matches.length > 1) throw new Error(`Agent ID prefix is ambiguous: ${agentId}`);
				const agent = matches[0];
				if (!agent) throw new Error(`Agent not found: ${agentId}`);
				if (args[2] === "run") {
					if (agent.kind !== "subagent") throw new Error("Use karissa task run for the main Agent");
					if (task.state !== "running" || agent.state !== "queued") {
						throw new Error(`Subagent cannot run from Task ${task.state} / Agent ${agent.state}`);
					}
					const checkpoint = store.getLatestCheckpoint(agent.id);
					process.env.KARISSA_TASK_RUN_ID = task.id;
					process.env.KARISSA_AGENT_RUN_ID = agent.id;
					args.splice(
						0,
						args.length,
						...(checkpoint?.sessionCheckpoint.sessionPath
							? ["--session", checkpoint.sessionCheckpoint.sessionPath]
							: []),
						"--append-system-prompt",
						`<delegation><role>${agent.role}</role><objective>${agent.objective}</objective><workspace_mode>${agent.workspaceMode}</workspace_mode></delegation>`,
						...(args.includes("--print") || process.env.KARISSA_DAEMON_WORKER === "1" ? ["--print"] : []),
						agent.objective,
					);
					return false;
				}
				if (args[2] === "pause") {
					console.log(JSON.stringify(store.transitionAgent(agent.id, "paused", "user_requested")));
					break;
				}
				if (args[2] === "resume") {
					console.log(JSON.stringify(store.transitionAgent(agent.id, "queued", "user_requested")));
					break;
				}
				if (args[2] === "cancel") {
					console.log(JSON.stringify(store.transitionAgent(agent.id, "cancelled", "user_requested")));
					break;
				}
				console.log(
					JSON.stringify(
						{
							...agent,
							latestAttempt: store.getLatestAttempt(agent.id),
							latestCheckpoint: store.getLatestCheckpoint(agent.id),
						},
						null,
						2,
					),
				);
				break;
			}
			case "messages": {
				const task = resolveTask(store, args[2] ?? "");
				const agentId = option(args, "--agent");
				for (const message of store.listMessages(task.id, agentId, 10_000)) console.log(JSON.stringify(message));
				break;
			}
			case "steer": {
				const task = resolveTask(store, args[2] ?? "");
				const targetId = requiredOption(args, "--agent");
				const body = requiredOption(args, "--message");
				const agents = store.listAgents(task.id);
				const main = agents.find((agent) => agent.kind === "main");
				const target = agents.find((agent) => agent.id === targetId || agent.id.startsWith(targetId));
				if (!main || !target) throw new Error("Main or target Agent not found");
				const messageId = store.queueMessage({
					actor: target.kind === "main" ? target : main,
					recipient: target,
					dedupeKey: createHash("sha256")
						.update(`user-steer\0${task.id}\0${target.id}\0${body}\0${Date.now()}`)
						.digest("hex"),
					type: "steering",
					priority: "high",
					body,
					artifactRefs: [],
				});
				console.log(messageId);
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
