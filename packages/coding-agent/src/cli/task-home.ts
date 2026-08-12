import type { TaskRecord } from "@lioooooo123/ever-long-tasks";
import { SettingsManager } from "../core/settings-manager.ts";
import { TaskApplication } from "../core/task-application.ts";
import { resolveTaskModel, TaskModelConfigurationError, type TaskModelIdentity } from "../core/task-model.ts";
import { requestDaemon, startDaemon } from "./daemon-command.ts";
import { runProviderAndModelSetup } from "./provider-setup.ts";
import { showStartupInput, showStartupSelector } from "./startup-ui.ts";

type HomeAction =
	| { kind: "create" }
	| { kind: "provider" }
	| { kind: "refresh" }
	| { kind: "quit" }
	| { kind: "task"; taskId: string };

type CreateResult = { kind: "launch"; taskId: string } | { kind: "background"; task: TaskRecord } | undefined;

export type TaskHomeResult = { kind: "launch"; taskId: string } | { kind: "quit" };

const TERMINAL_STATES = new Set<TaskRecord["state"]>(["completed", "failed", "cancelled"]);

const STATE_LABELS = {
	draft: "草稿",
	queued: "已排队",
	running: "运行中",
	waiting_input: "等你输入",
	waiting_external: "等待外部",
	paused: "已暂停",
	unknown_outcome: "结果待确认",
	completed: "已完成",
	failed: "失败",
	cancelled: "已取消",
} satisfies Record<TaskRecord["state"], string>;

function compactTitle(value: string, maxLength = 46): string {
	const singleLine = value.replace(/\s+/gu, " ").trim();
	return singleLine.length <= maxLength ? singleLine : singleLine.slice(0, maxLength);
}

export function formatTaskHomeTaskLabel(task: TaskRecord): string {
	return `[${STATE_LABELS[task.state]}]  ${task.id.slice(0, 8)}  ${compactTitle(task.title)}`;
}

export function formatTaskHomeTitle(tasks: TaskRecord[], modelLabel: string): string {
	const active = tasks.filter((task) => !TERMINAL_STATES.has(task.state)).length;
	return [
		"EVER / TASK HOME",
		`${active} 个进行中  ·  ${tasks.length} 个 Task`,
		`模型  ${modelLabel}`,
		"选择 Task 继续，或创建新任务。",
	].join("\n");
}

export function needsFirstRunSetup(taskCount: number, modelConfigured: boolean): boolean {
	return taskCount === 0 && !modelConfigured;
}

async function showNotice(settings: SettingsManager, title: string, message: string): Promise<void> {
	await showStartupSelector(settings, `${title}\n${message}`, [{ label: "返回 Task Home", value: true }]);
}

async function resolveHomeModel(agentDir: string, cwd: string): Promise<TaskModelIdentity | undefined> {
	try {
		return await resolveTaskModel({ agentDir, cwd });
	} catch (error) {
		if (!(error instanceof TaskModelConfigurationError)) throw error;
		if (!(await runProviderAndModelSetup(agentDir, cwd))) return undefined;
		return resolveTaskModel({ agentDir, cwd });
	}
}

async function currentModelLabel(agentDir: string, cwd: string): Promise<string> {
	try {
		const model = await resolveTaskModel({ agentDir, cwd });
		return `${model.provider}/${model.id}`;
	} catch (error) {
		if (error instanceof TaskModelConfigurationError) return "未配置";
		return "不可用";
	}
}

async function hasConfiguredModel(agentDir: string, cwd: string): Promise<boolean> {
	try {
		await resolveTaskModel({ agentDir, cwd });
		return true;
	} catch (error) {
		if (error instanceof TaskModelConfigurationError) return false;
		throw error;
	}
}

async function createTask(
	settings: SettingsManager,
	application: TaskApplication,
	agentDir: string,
	cwd: string,
): Promise<CreateResult> {
	const goal = (await showStartupInput(settings, "新建 Task", "描述目标、边界和期望结果"))?.trim();
	if (!goal) return undefined;
	const verificationCommand = (
		await showStartupInput(settings, "完成条件", "可留空，由 Agent 提交可核验证据")
	)?.trim();
	const execution = await showStartupSelector(settings, "如何运行这个 Task？", [
		{ label: "立即进入", value: "foreground" as const },
		{ label: "转入后台", value: "background" as const },
		{ label: "取消", value: "cancel" as const },
	]);
	if (!execution || execution === "cancel") return undefined;
	const model = await resolveHomeModel(agentDir, cwd);
	if (!model) return undefined;
	const task = application.submit({
		kind: execution === "foreground" ? "interactive" : "unattended",
		workspaceRoot: cwd,
		goal,
		model,
		...(verificationCommand ? { verificationCommand } : {}),
	});
	if (execution === "foreground") return { kind: "launch", taskId: task.id };
	await startDaemon(agentDir);
	const wake = await requestDaemon(agentDir, { command: "wake", taskId: task.id });
	if (!wake.ok) throw new Error(wake.message ?? "Daemon 拒绝启动 Task");
	return { kind: "background", task };
}

async function showTaskDetails(settings: SettingsManager, task: TaskRecord): Promise<void> {
	const detail = [
		`TASK / ${task.id.slice(0, 8)}`,
		`${STATE_LABELS[task.state]}  ${task.title}`,
		`目标：${task.goal}`,
		`目录：${task.workspaceRoot}`,
		`轮数：${task.totalTurns}  费用：$${task.totalCostUsd.toFixed(4)}`,
		...(task.stateReason ? [`原因：${task.stateReason}`] : []),
	].join("\n");
	await showStartupSelector(settings, detail, [{ label: "返回", value: true }]);
}

async function confirmCancel(settings: SettingsManager, task: TaskRecord): Promise<boolean> {
	return (
		(await showStartupSelector(settings, `取消 Task / ${task.id.slice(0, 8)}？\n${task.title}`, [
			{ label: "保留 Task", value: false },
			{ label: "确认取消", value: true },
		])) === true
	);
}

async function manageTask(
	settings: SettingsManager,
	application: TaskApplication,
	task: TaskRecord,
): Promise<TaskHomeResult | { kind: "refresh" }> {
	type TaskAction = "open" | "show" | "resume" | "pause" | "cancel" | "back";
	const canOpen = ["queued", "running", "paused", "waiting_input", "waiting_external"].includes(task.state);
	const options: Array<{ label: string; value: TaskAction }> = [
		...(canOpen ? [{ label: "进入 Task", value: "open" as const }] : []),
		{ label: "查看详情", value: "show" },
		...(["paused", "waiting_input", "waiting_external"].includes(task.state)
			? [{ label: "恢复后台执行", value: "resume" as const }]
			: []),
		...(["queued", "running"].includes(task.state) ? [{ label: "暂停", value: "pause" as const }] : []),
		...(!TERMINAL_STATES.has(task.state) ? [{ label: "取消 Task", value: "cancel" as const }] : []),
		{ label: "返回队列", value: "back" },
	];
	const action = await showStartupSelector(
		settings,
		`TASK / ${task.id.slice(0, 8)}\n${STATE_LABELS[task.state]}  ${task.title}`,
		options,
	);
	if (!action || action === "back") return { kind: "refresh" };
	if (action === "open") return { kind: "launch", taskId: task.id };
	if (action === "show") {
		await showTaskDetails(settings, task);
		return { kind: "refresh" };
	}
	if (action === "cancel" && !(await confirmCancel(settings, task))) return { kind: "refresh" };
	application.control({ action, taskRef: task.id }, { clientId: "ever-task-home" });
	return { kind: "refresh" };
}

export async function runTaskHome(agentDir: string, cwd: string, startWithCreate = false): Promise<TaskHomeResult> {
	const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const application = new TaskApplication(agentDir);
	const initialTasks = application.list();
	if (needsFirstRunSetup(initialTasks.length, await hasConfiguredModel(agentDir, cwd))) {
		try {
			await runProviderAndModelSetup(agentDir, cwd);
		} catch (error) {
			await showNotice(settings, "无法配置 Provider", error instanceof Error ? error.message : String(error));
		}
	}
	let createImmediately = startWithCreate;
	while (true) {
		try {
			if (createImmediately) {
				createImmediately = false;
				const created = await createTask(settings, application, agentDir, cwd);
				if (created?.kind === "launch") return created;
				if (created?.kind === "background") {
					await showNotice(settings, "Task 已在后台运行", `${created.task.id.slice(0, 8)}  ${created.task.title}`);
				}
			}
			const tasks = application.list();
			const options: Array<{ label: string; value: HomeAction }> = [
				{ label: "+  新建 Task", value: { kind: "create" } },
				{ label: "◇  Provider 与模型", value: { kind: "provider" } },
				...tasks.slice(0, 12).map((task) => ({
					label: formatTaskHomeTaskLabel(task),
					value: { kind: "task" as const, taskId: task.id },
				})),
				{ label: "↻  刷新", value: { kind: "refresh" } },
				{ label: "×  退出", value: { kind: "quit" } },
			];
			const action = await showStartupSelector(
				settings,
				formatTaskHomeTitle(tasks, await currentModelLabel(agentDir, cwd)),
				options,
			);
			if (!action || action.kind === "quit") return { kind: "quit" };
			if (action.kind === "create") createImmediately = true;
			else if (action.kind === "provider") await runProviderAndModelSetup(agentDir, cwd);
			else if (action.kind === "task") {
				const result = await manageTask(settings, application, application.resolve(action.taskId));
				if (result.kind !== "refresh") return result;
			}
		} catch (error) {
			await showNotice(settings, "无法完成操作", error instanceof Error ? error.message : String(error));
		}
	}
}
