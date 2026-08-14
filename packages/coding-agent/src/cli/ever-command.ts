import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { SqliteTaskStore, type TaskRecord } from "@lioooooo123/ever-long-tasks";
import chalk from "chalk";
import { TaskApplication } from "../core/task-application.ts";
import { resolveTaskModel, TaskModelConfigurationError, type TaskModelIdentity } from "../core/task-model.ts";
import { activateTaskRun } from "../core/task-run.ts";
import { getTaskRunContext } from "../core/task-run-context.ts";
import { requestDaemon, startDaemon } from "./daemon-command.ts";
import { runProviderAndModelSetup } from "./provider-setup.ts";
import { runTaskHome } from "./task-home.ts";
import { runTaskRpc } from "./task-rpc.ts";

const VALUE_OPTIONS = new Set([
	"--verify",
	"--max-turns",
	"--max-wall-time-minutes",
	"--max-cost-usd",
	"--mode",
	"--provider",
	"--model",
]);

const INTERNAL_SESSION_OPTIONS = new Set([
	"--continue",
	"-c",
	"--resume",
	"-r",
	"--session",
	"--session-id",
	"--fork",
	"--no-session",
	"--export",
]);

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	const value = args[index + 1];
	if (value === undefined || value.startsWith("-")) throw new Error(`${name} requires a value`);
	return value;
}

function validateValueOptions(args: string[]): void {
	for (const name of VALUE_OPTIONS) option(args, name);
}

export function taskText(args: string[]): string {
	const words: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (VALUE_OPTIONS.has(arg)) {
			index++;
			continue;
		}
		if (
			arg === "run" ||
			arg === "new" ||
			arg === "--yes" ||
			arg === "--detach" ||
			arg === "--json" ||
			arg === "--print" ||
			arg === "-p" ||
			arg === "--offline"
		)
			continue;
		if (arg === "--unsafe-no-sandbox") continue;
		if (arg.startsWith("-")) throw new Error(`Ever Task 入口不支持选项 ${arg}`);
		words.push(arg);
	}
	return words.join(" ").trim();
}

function optionalLimit(args: string[], name: string, integer: boolean): number | undefined {
	const text = option(args, name);
	if (text === undefined) return undefined;
	const value = Number(text);
	if (!Number.isFinite(value) || value < 0 || (integer && (!Number.isSafeInteger(value) || value === 0))) {
		throw new Error(`${name} 必须是${integer ? "正整数" : "非负数"}`);
	}
	return value;
}

function printTaskLine(task: TaskRecord): void {
	console.log(`${task.state.toUpperCase().padEnd(18)} ${task.id.slice(0, 8)}  ${task.title}`);
}

function printHelp(): void {
	console.log(`Ever long-running coding agent

Usage:
	  ever                           打开 Task Home
  ever <goal>                       创建 Task 并进入同一个 TUI
  ever <goal> --detach --yes        创建 Task 后转入后台
  ever new                          引导式创建 Task

Task:
  ever tasks                        查看 Task 队列
  ever status <task-id>             查看 Task 状态
  ever attach <task-id>             进入 Task，可继续输入指令
  ever pause|resume|cancel <task-id>
  ever task <command>               高级 Task 命令

Runtime:
	  Provider 与模型                 在 Task Home 内完成登录和模型选择
  /model                            在 Ever TUI 内选择模型
  ever models [search]              查看可用模型
  ever --mode rpc                   启动 Task JSONL RPC

Task options:
  --verify <command>                完成时运行验证命令
  --max-turns <n>                   最大轮数
  --max-wall-time-minutes <n>       最大运行分钟数
  --max-cost-usd <n>                最大费用
  --provider <name> --model <id>    固定模型
  --detach                          提交后不附着
  --yes                             确认允许修改当前工作区`);
}

function accepted(answer: string): boolean {
	return ["y", "yes", "是", "确认"].includes(answer.trim().toLowerCase());
}

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

async function resolveCommandModel(input: {
	agentDir: string;
	cwd: string;
	provider?: string;
	model?: string;
}): Promise<TaskModelIdentity> {
	try {
		return await resolveTaskModel(input);
	} catch (error) {
		if (!(error instanceof TaskModelConfigurationError)) throw error;
		if (process.stdin.isTTY !== true) {
			throw new Error(`${error.message}。请先在交互终端运行 ever 配置 Provider 与模型`);
		}
		if (!(await runProviderAndModelSetup(input.agentDir, input.cwd))) {
			throw new Error("尚未配置 Provider 与模型");
		}
		return resolveTaskModel(input);
	}
}

async function activateForegroundTask(input: {
	agentDir: string;
	taskRef: string;
	acceptRuntimeDrift: boolean;
	clientId: string;
}): Promise<string[]> {
	const current = new TaskApplication(input.agentDir).resolve(input.taskRef);
	if (current.state === "running") {
		const stopped = await requestDaemon(input.agentDir, { command: "stop-agent", taskId: current.id });
		if (!stopped.ok) throw new Error(stopped.message ?? "Daemon 拒绝 Task 交接");
	}
	return activateTaskRun({
		agentDir: input.agentDir,
		taskRef: current.id,
		print: false,
		acceptRuntimeDrift: input.acceptRuntimeDrift,
		clientId: input.clientId,
	});
}

export async function handleEverCommand(args: string[], agentDir: string, cwd: string): Promise<boolean> {
	if (getTaskRunContext() || process.env.EVER_DAEMON_WORKER === "1") return false;
	if (args[0] === "models") {
		args.splice(0, args.length, "--list-models", ...args.slice(1));
		return false;
	}
	if (args.includes("--version") || args.includes("-v") || args.includes("--list-models")) return false;
	if (args.some((arg) => INTERNAL_SESSION_OPTIONS.has(arg))) {
		console.error(chalk.red("Error: Ever CLI 只运行持久 Task；Session 是 Task 内部的执行上下文。"));
		process.exitCode = 1;
		return true;
	}
	if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
		printHelp();
		return true;
	}
	validateValueOptions(args);
	if (option(args, "--mode") === "rpc") {
		await runTaskRpc(agentDir, cwd);
		return true;
	}
	if (args[0] === "attach") {
		const taskRef = args[1];
		if (!taskRef) throw new Error("attach requires a Task ID");
		args.splice(
			0,
			args.length,
			...(await activateForegroundTask({
				agentDir,
				taskRef: taskRef,
				acceptRuntimeDrift: args.includes("--accept-runtime-drift"),
				clientId: "ever-cli",
			})),
		);
		return false;
	}
	if (args[0] === "status" || args[0] === "tasks") {
		const store = SqliteTaskStore.open({ databasePath: join(agentDir, "long-tasks.sqlite") });
		try {
			const id = args[0] === "status" ? args[1] : undefined;
			const tasks = id ? [new TaskApplication(agentDir, store).resolve(id)] : store.listTasks();
			if (args.includes("--json")) {
				for (const task of tasks) console.log(JSON.stringify({ ...task, agents: store.listAgents(task.id) }));
			} else if (tasks.length === 0) {
				console.log("当前没有 Task。运行 ever 创建一个。");
			} else {
				for (const task of tasks) printTaskLine(task);
			}
			return true;
		} finally {
			store.close();
		}
	}
	if (["pause", "resume", "cancel"].includes(args[0] ?? "")) {
		const taskId = args[1];
		if (!taskId) throw new Error(`${args[0]} requires a Task ID`);
		const action = args[0] as "pause" | "resume" | "cancel";
		const result = new TaskApplication(agentDir).control({ action, taskRef: taskId }, { clientId: "ever-cli" });
		printTaskLine(result.task);
		return true;
	}
	if (args[0] === "stop") {
		const taskId = args[1];
		if (!taskId) throw new Error("stop requires a Task ID");
		const response = await requestDaemon(agentDir, { command: "stop-agent", taskId });
		console.log(JSON.stringify(response));
		return true;
	}
	if ((args.length === 0 || (args[0] === "new" && args.length === 1)) && process.stdin.isTTY === true) {
		const home = await runTaskHome(agentDir, cwd, args[0] === "new");
		if (home.kind === "quit") return true;
		args.splice(
			0,
			args.length,
			...(await activateForegroundTask({
				agentDir,
				taskRef: home.taskId,
				acceptRuntimeDrift: false,
				clientId: "ever-task-home",
			})),
		);
		return false;
	}
	const explicitRun = args[0] === "run" || args[0] === "new";
	const runArgs = explicitRun ? args.slice(1) : args;
	const guided = runArgs.length === 0 && process.stdin.isTTY === true;
	const quick = runArgs.length > 0;
	if (!guided && !quick) {
		console.error(chalk.red("Error: 缺少 Task 目标。交互终端请直接运行 ever。"));
		process.exitCode = 1;
		return true;
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const goal = guided ? (await rl.question("你希望 Ever 完成什么任务？\n> ")).trim() : taskText(runArgs);
		if (!goal) throw new Error("任务内容不能为空");
		const verificationCommand = guided
			? (await rl.question("完成后运行什么验证命令？直接回车表示由 Agent 提交证据：\n> ")).trim() || undefined
			: option(args, "--verify");
		const detached = args.includes("--detach");
		const approved =
			!detached ||
			args.includes("--yes") ||
			(process.stdin.isTTY === true &&
				accepted(await rl.question("允许 Ever 修改当前工作区并持续执行这个 Task 吗？[y/N] ")));
		if (!approved) {
			console.log("已取消，未创建任务。");
			return true;
		}
		const maxTurns = optionalLimit(args, "--max-turns", true);
		const maxWallTimeMinutes = optionalLimit(args, "--max-wall-time-minutes", true);
		const maxCostUsd = optionalLimit(args, "--max-cost-usd", false);
		const unsafeNoSandbox = args.includes("--unsafe-no-sandbox");
		const model = await resolveCommandModel({
			agentDir,
			cwd,
			provider: option(args, "--provider"),
			model: option(args, "--model"),
		});
		const task = detached
			? await submitAsyncTask({
					agentDir,
					cwd,
					goal,
					verificationCommand,
					maxTurns,
					maxWallTimeMinutes,
					maxCostUsd,
					model,
					unsafeNoSandbox,
				})
			: submitInteractiveTask({
					agentDir,
					cwd,
					goal,
					verificationCommand,
					maxTurns,
					maxWallTimeMinutes,
					maxCostUsd,
					model,
				});
		if (detached) {
			await startDaemon(agentDir, unsafeNoSandbox);
			const wake = await requestDaemon(agentDir, { command: "wake", taskId: task.id });
			if (!wake.ok) throw new Error(wake.message ?? "Daemon rejected Task submission");
		}
		const machineOutput =
			args.includes("--json") ||
			args.includes("--print") ||
			args.includes("-p") ||
			option(args, "--mode") === "json";
		if (machineOutput && detached) {
			const mainAgent = new TaskApplication(agentDir)
				.snapshot(task.id)
				.agents.find((agent) => agent.kind === "main");
			console.log(
				JSON.stringify({ schemaVersion: 1, taskId: task.id, state: task.state, agentId: mainAgent?.id ?? null }),
			);
		} else if (detached) {
			console.log(`QUEUED             ${task.id.slice(0, 8)}  ${task.title}`);
			console.log(`后台运行。使用 ever attach ${task.id.slice(0, 8)} 重新进入。`);
		} else {
			const jsonOutput = args.includes("--json") || option(args, "--mode") === "json";
			args.splice(
				0,
				args.length,
				...activateTaskRun({
					agentDir,
					taskRef: task.id,
					print: machineOutput && !jsonOutput,
					json: jsonOutput,
					clientId: "ever-cli",
				}),
			);
			return false;
		}
		return true;
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		process.exitCode = 1;
		return true;
	} finally {
		rl.close();
	}
}
