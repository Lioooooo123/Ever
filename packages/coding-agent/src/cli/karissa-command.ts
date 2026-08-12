import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { SqliteTaskStore, type TaskRecord } from "@karissa/long-tasks";
import chalk from "chalk";
import { TaskApplication } from "../core/task-application.ts";
import { resolveTaskModel } from "../core/task-model.ts";
import { getTaskRunContext } from "../core/task-run-context.ts";
import { attachTask, requestDaemon, startDaemon } from "./daemon-command.ts";
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
	return index < 0 ? undefined : args[index + 1];
}

function taskText(args: string[]): string {
	const words: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (VALUE_OPTIONS.has(arg)) {
			index++;
			continue;
		}
		if (arg === "run" || arg === "--yes" || arg === "--json" || arg === "--print" || arg === "-p") continue;
		if (arg === "--unsafe-no-sandbox") continue;
		if (arg.startsWith("-")) throw new Error(`Karissa Task 入口不支持选项 ${arg}`);
		words.push(arg);
	}
	return words.join(" ").trim();
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

export async function handleKarissaCommand(args: string[], agentDir: string, cwd: string): Promise<boolean> {
	if (getTaskRunContext() || process.env.KARISSA_DAEMON_WORKER === "1") return false;
	if (args.includes("--version") || args.includes("-v") || args.includes("--list-models")) return false;
	if (args.some((arg) => INTERNAL_SESSION_OPTIONS.has(arg))) {
		console.error(chalk.red("Error: Karissa CLI 只运行持久 Task；普通 Session 仅保留在 Pi SDK 内部。"));
		process.exitCode = 1;
		return true;
	}
	if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
		console.log(`Karissa long-running agent

Usage:
  karissa                         打开 Task Home
  karissa <goal> [--yes]          创建、启动并附着持久 Task
  karissa run [goal]              引导式创建 Task
  karissa status [task-id]        查看 Task
  karissa attach <task-id> --follow
  karissa stop <task-id>
  karissa task <command>
  karissa --mode rpc              启动 Task JSONL RPC`);
		return true;
	}
	if (option(args, "--mode") === "rpc") {
		await runTaskRpc(agentDir, cwd);
		return true;
	}
	if (args[0] === "status") {
		const store = SqliteTaskStore.open({ databasePath: join(agentDir, "long-tasks.sqlite") });
		try {
			const id = args[1];
			const tasks = id ? [new TaskApplication(agentDir, store).resolve(id)] : store.listTasks();
			for (const task of tasks) console.log(JSON.stringify({ ...task, agents: store.listAgents(task.id) }));
			return true;
		} finally {
			store.close();
		}
	}
	if (args[0] === "stop") {
		const taskId = args[1];
		if (!taskId) throw new Error("stop requires a Task ID");
		const response = await requestDaemon(agentDir, { command: "stop-agent", taskId });
		console.log(JSON.stringify(response));
		return true;
	}
	if (args.length === 0 && process.stdin.isTTY === true && process.stdout.isTTY === true) {
		await runTaskHome(agentDir, cwd);
		return true;
	}
	const explicitRun = args[0] === "run";
	const runArgs = explicitRun ? args.slice(1) : args;
	const guided = explicitRun && runArgs.length === 0 && process.stdin.isTTY === true;
	const quick = runArgs.length > 0;
	if (!guided && !quick) {
		console.error(chalk.red("Error: 缺少 Task 目标。交互终端请直接运行 karissa。"));
		process.exitCode = 1;
		return true;
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const goal = guided ? (await rl.question("你希望 Karissa 完成什么任务？\n> ")).trim() : taskText(runArgs);
		if (!goal) throw new Error("任务内容不能为空");
		const verificationCommand = guided
			? (await rl.question("完成后运行什么验证命令？直接回车表示由 Agent 提交证据：\n> ")).trim() || undefined
			: option(args, "--verify");
		const approved =
			args.includes("--yes") ||
			(process.stdin.isTTY === true && accepted(await rl.question("允许 Karissa 在后台修改当前工作区吗？[y/N] ")));
		if (!approved) {
			console.log("已取消，未创建任务。");
			return true;
		}
		const maxTurnsText = option(args, "--max-turns");
		const maxTurns = maxTurnsText === undefined ? undefined : Number(maxTurnsText);
		if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns <= 0)) {
			throw new Error("--max-turns 必须是正整数");
		}
		const unsafeNoSandbox = args.includes("--unsafe-no-sandbox");
		const model = await resolveTaskModel({
			agentDir,
			cwd,
			provider: option(args, "--provider"),
			model: option(args, "--model"),
		});
		const task = await submitAsyncTask({
			agentDir,
			cwd,
			goal,
			verificationCommand,
			maxTurns,
			model,
			unsafeNoSandbox,
		});
		await startDaemon(agentDir, unsafeNoSandbox);
		const wake = await requestDaemon(agentDir, { command: "wake", taskId: task.id });
		if (!wake.ok) throw new Error(wake.message ?? "Daemon rejected Task submission");
		const machineOutput =
			args.includes("--json") ||
			args.includes("--print") ||
			args.includes("-p") ||
			option(args, "--mode") === "json";
		if (machineOutput) {
			const mainAgent = new TaskApplication(agentDir)
				.snapshot(task.id)
				.agents.find((agent) => agent.kind === "main");
			console.log(
				JSON.stringify({ schemaVersion: 1, taskId: task.id, state: task.state, agentId: mainAgent?.id ?? null }),
			);
		} else {
			console.log(`已提交：${task.id.slice(0, 8)}  ${task.title}`);
			console.log("已附着事件流；按 Ctrl+C 仅分离终端，Worker 会继续运行。");
			await attachTask(agentDir, task.id, { follow: true });
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
