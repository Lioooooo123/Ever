import type { TaskRecord } from "@karissa/long-tasks";
import { SettingsManager } from "../core/settings-manager.ts";
import { TaskApplication } from "../core/task-application.ts";
import { resolveTaskModel } from "../core/task-model.ts";
import { requestDaemon, startDaemon } from "./daemon-command.ts";
import { showStartupInput, showStartupSelector } from "./startup-ui.ts";

type HomeAction = { kind: "create" | "refresh" | "quit" } | { kind: "task"; taskId: string };

const TERMINAL_STATES = new Set<TaskRecord["state"]>(["completed", "failed", "cancelled"]);

function compactTitle(value: string, maxLength = 42): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}

function taskLabel(task: TaskRecord): string {
	return `${task.state.padEnd(16)} ${task.id.slice(0, 8)}  ${compactTitle(task.title)}`;
}

function homeTitle(tasks: TaskRecord[]): string {
	const active = tasks.filter((task) => !TERMINAL_STATES.has(task.state)).length;
	return [
		"KARISSA / NIGHT SHIFT",
		`TASK QUEUE  ${String(active).padStart(2, "0")} active  ${String(tasks.length).padStart(2, "0")} total`,
		"选择一个持久 Task，或登记新的长程目标。",
	].join("\n");
}

async function createTask(settings: SettingsManager, agentDir: string, cwd: string): Promise<TaskRecord | undefined> {
	const goal = (await showStartupInput(settings, "NEW TASK / GOAL", "描述目标、边界和期望结果"))?.trim();
	if (!goal) return undefined;
	const verificationCommand = (
		await showStartupInput(settings, "VERIFIED COMPLETION / COMMAND", "可留空，由 Agent 提交可核验证据")
	)?.trim();
	const confirmation = await showStartupSelector(settings, "UNATTENDED EXECUTION", [
		{ label: "启动后台 Task", value: true },
		{ label: "取消", value: false },
	]);
	if (confirmation !== true) return undefined;
	const model = await resolveTaskModel({ agentDir, cwd });
	const task = new TaskApplication(agentDir).submit({
		kind: "unattended",
		workspaceRoot: cwd,
		goal,
		model,
		...(verificationCommand ? { verificationCommand } : {}),
	});
	await startDaemon(agentDir);
	const wake = await requestDaemon(agentDir, { command: "wake", taskId: task.id });
	if (!wake.ok) throw new Error(wake.message ?? "Daemon rejected Task submission");
	return task;
}

async function manageTask(
	settings: SettingsManager,
	application: TaskApplication,
	task: TaskRecord,
): Promise<"refresh" | "quit"> {
	type TaskAction = "show" | "resume" | "pause" | "cancel" | "back";
	const options: Array<{ label: string; value: TaskAction }> = [
		{ label: "查看详情并退出", value: "show" },
		...(["paused", "waiting_input", "waiting_external"].includes(task.state)
			? [{ label: "恢复执行", value: "resume" as const }]
			: []),
		...(task.state === "queued" || task.state === "running" ? [{ label: "暂停", value: "pause" as const }] : []),
		...(!TERMINAL_STATES.has(task.state) ? [{ label: "取消 Task", value: "cancel" as const }] : []),
		{ label: "返回队列", value: "back" },
	];
	const action = await showStartupSelector(
		settings,
		`TASK / ${task.id.slice(0, 8)}\n${task.state}  ${task.title}`,
		options,
	);
	if (!action || action === "back") return "refresh";
	if (action === "show") {
		console.log(JSON.stringify({ schemaVersion: 1, ...application.resolve(task.id) }, null, 2));
		return "quit";
	}
	application.control({ action, taskRef: task.id }, { clientId: "karissa-task-home" });
	return "refresh";
}

export async function runTaskHome(agentDir: string, cwd: string): Promise<void> {
	const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const application = new TaskApplication(agentDir);
	let open = true;
	while (open) {
		const tasks = application.list();
		const options: Array<{ label: string; value: HomeAction }> = [
			{ label: "+  NEW TASK", value: { kind: "create" } },
			...tasks
				.slice(0, 12)
				.map((task) => ({ label: taskLabel(task), value: { kind: "task" as const, taskId: task.id } })),
			{ label: "↻  REFRESH", value: { kind: "refresh" } },
			{ label: "×  QUIT", value: { kind: "quit" } },
		];
		const action = await showStartupSelector(settings, homeTitle(tasks), options);
		if (!action || action.kind === "quit") {
			open = false;
		} else if (action.kind === "create") {
			const task = await createTask(settings, agentDir, cwd);
			if (task) {
				console.log(`Task ${task.id.slice(0, 8)} 已进入后台队列。`);
				open = false;
			}
		} else if (action.kind === "task") {
			open = (await manageTask(settings, application, application.resolve(action.taskId))) === "refresh";
		}
	}
}
