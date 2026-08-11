import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { SqliteTaskStore, TaskController, type TaskRecord } from "@karissa/long-tasks";
import chalk from "chalk";
import { requestDaemon, startDaemon } from "./daemon-command.ts";

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index < 0 ? undefined : args[index + 1];
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
	const remote = gitValue(root, ["remote", "get-url", "origin"]) ?? "no-remote";
	const branch = gitValue(root, ["branch", "--show-current"]) ?? "detached";
	const head = gitValue(root, ["rev-parse", "HEAD"]);
	return {
		root,
		fingerprint: createHash("sha256")
			.update(`${realpathSync(root)}\0${remote}\0${branch}`)
			.digest("hex"),
		...(head ? { head } : {}),
	};
}

function taskText(args: string[]): string {
	const optionIndex = args.findIndex((arg) => arg.startsWith("--"));
	return args
		.slice(0, optionIndex < 0 ? args.length : optionIndex)
		.join(" ")
		.trim();
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
}): Promise<TaskRecord> {
	const workspace = workspaceIdentity(input.cwd);
	const store = SqliteTaskStore.open({
		databasePath: join(input.agentDir, "long-tasks.sqlite"),
		artifactsRoot: join(input.agentDir, "tasks"),
	});
	try {
		const acceptance: TaskRecord["acceptance"] = [
			{
				id: "agent-evidence",
				kind: "agent_evidence",
				description: "Agent 提交至少一条可核验的完成证据",
				minEvidence: 1,
			},
		];
		if (input.verificationCommand) {
			acceptance.push({
				id: "verification-command",
				kind: "command",
				command: input.verificationCommand,
				cwd: input.verificationCwd ?? ".",
				timeoutSeconds: input.verificationTimeoutSeconds ?? 600,
			});
		}
		const controller = new TaskController(store);
		const task = controller.create({
			title: input.title ?? input.goal.split("\n", 1)[0]!.slice(0, 80),
			goal: input.goal,
			acceptance,
			constraints: { unattendedApproved: true, ...(input.model === undefined ? {} : { model: input.model }) },
			budget: {
				maxTurns: input.maxTurns ?? 200,
				maxWallTimeMinutes: input.maxWallTimeMinutes ?? 240,
				...(input.maxCostUsd === undefined ? {} : { maxCostUsd: input.maxCostUsd, mode: "hard" }),
			},
			workspaceRoot: workspace.root,
			workspaceFingerprint: workspace.fingerprint,
			...(workspace.head ? { initialGitHead: workspace.head } : {}),
		});
		return controller.submit(task.id);
	} finally {
		store.close();
	}
}

export async function handleKarissaCommand(
	args: string[],
	agentDir: string,
	cwd: string,
	enabled: boolean,
): Promise<boolean> {
	const guided = args.length === 0 && process.stdin.isTTY === true;
	const quick = args.length > 0 && !args[0]!.startsWith("-");
	if (!guided && !quick) return false;
	if (!enabled) {
		console.error(chalk.red("Error: Long Tasks are disabled by longTasks.enabled"));
		process.exitCode = 1;
		return true;
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const goal = guided ? (await rl.question("你希望 Karissa 完成什么任务？\n> ")).trim() : taskText(args);
		if (!goal) throw new Error("任务内容不能为空");
		const verificationCommand = guided
			? (await rl.question("完成后运行什么验证命令？直接回车表示由 Agent 提交证据：\n> ")).trim() || undefined
			: option(args, "--verify");
		const approved =
			args.includes("--yes") || accepted(await rl.question("允许 Karissa 在后台修改当前工作区吗？[y/N] "));
		if (!approved) {
			console.log("已取消，未创建任务。");
			return true;
		}
		const maxTurnsText = option(args, "--max-turns");
		const maxTurns = maxTurnsText === undefined ? undefined : Number(maxTurnsText);
		if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns <= 0)) {
			throw new Error("--max-turns 必须是正整数");
		}
		const task = await submitAsyncTask({ agentDir, cwd, goal, verificationCommand, maxTurns });
		await startDaemon(agentDir);
		await requestDaemon(agentDir, { command: "wake", taskId: task.id });
		console.log(`已提交：${task.id.slice(0, 8)}  ${task.title}`);
		console.log(`查看：karissa task show ${task.id.slice(0, 8)}`);
		console.log(`日志：karissa task logs ${task.id.slice(0, 8)} --follow`);
		return true;
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		process.exitCode = 1;
		return true;
	} finally {
		rl.close();
	}
}
