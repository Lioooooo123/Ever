import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	type AgentRecord,
	SqliteTaskStore,
	TaskController,
	type TaskEvent,
	type TaskRecord,
	VerifiedChangeBundle,
	type VerifiedChangeBundleResult,
} from "@lioooooo123/ever-long-tasks";
import { probeUnattendedSandbox } from "./unattended-sandbox.ts";
import { workspaceIdentity } from "./workspace-identity.ts";

export interface UnattendedTaskSubmission {
	kind: "unattended";
	workspaceRoot: string;
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
}

export interface InteractiveTaskSubmission {
	kind: "interactive";
	mode?: "session" | "flow";
	workspaceRoot: string;
	goal: string;
	title?: string;
	verificationCommand?: string;
	verificationCwd?: string;
	verificationTimeoutSeconds?: number;
	maxTurns?: number;
	maxWallTimeMinutes?: number;
	maxCostUsd?: number;
	model: { provider: string; id: string };
}

export interface ManualTaskSubmission {
	kind: "manual";
	workspaceRoot: string;
	title: string;
	goal: string;
	acceptanceDescription: string;
	maxTurns: number;
	maxWallTimeMinutes: number;
	maxCostUsd?: number;
}

export type TaskSubmission = UnattendedTaskSubmission | InteractiveTaskSubmission | ManualTaskSubmission;

export type TaskControlCommand =
	| { action: "pause"; taskRef: string }
	| { action: "resume"; taskRef: string; acceptRuntimeDrift?: boolean }
	| { action: "cancel"; taskRef: string }
	| { action: "accept"; taskRef: string; criterionId: string }
	| { action: "steer"; taskRef: string; agentRef: string; message: string };

export interface TaskCommandIdentity {
	clientId: string;
	commandId?: string;
}

export interface TaskControlResult {
	task: TaskRecord;
	commandId: string;
	duplicate: boolean;
}

export interface TaskSnapshot {
	task: TaskRecord;
	agents: AgentRecord[];
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

export class TaskApplication {
	private readonly agentDir: string;
	private readonly existingStore: SqliteTaskStore | undefined;

	constructor(agentDir: string, existingStore?: SqliteTaskStore) {
		this.agentDir = agentDir;
		this.existingStore = existingStore;
	}

	submit(input: TaskSubmission): TaskRecord {
		if (input.kind === "unattended") {
			const capability = probeUnattendedSandbox();
			const sandboxAvailable = input.sandboxAvailable ?? capability.available;
			if (!sandboxAvailable && input.unsafeNoSandbox !== true) {
				throw new Error(
					`后台任务需要可用 sandbox。${capability.reason ?? "当前环境未通过 sandbox 能力检查"}；或在明确接受风险后使用 --unsafe-no-sandbox。`,
				);
			}
		}

		const workspace = workspaceIdentity(input.workspaceRoot);
		const store = this.existingStore ?? this.openStore();
		try {
			const controller = new TaskController(store);
			const acceptance: TaskRecord["acceptance"] =
				input.kind === "manual"
					? [
							{
								id: "user-acceptance",
								kind: "manual",
								description: input.acceptanceDescription,
							},
						]
					: [
							{
								id: "objective-audit",
								kind: "objective_audit",
								description: "完成请求必须逐项列出目标中的明确要求，并为每项绑定已核验的证据",
							},
							{
								id: "agent-evidence",
								kind: "agent_evidence",
								description: "Agent 提交至少一条可核验的完成证据",
								minEvidence: 1,
							},
							...(input.verificationCommand
								? [
										{
											id: "verification-command",
											kind: "command" as const,
											command: input.verificationCommand,
											cwd: input.verificationCwd ?? ".",
											timeoutSeconds: input.verificationTimeoutSeconds ?? 600,
										},
									]
								: []),
						];
			const maxTurns = input.maxTurns ?? 200;
			const maxWallTimeMinutes = input.maxWallTimeMinutes ?? 240;
			const task = controller.create({
				title: input.title ?? input.goal.split("\n", 1)[0]!.slice(0, 80),
				goal: input.goal,
				acceptance,
				...(input.kind !== "manual"
					? {
							constraints: {
								...(input.kind === "unattended" ? { unattendedApproved: true } : { interactiveApproved: true }),
								...(input.kind === "interactive" ? { executionMode: input.mode ?? "session" } : {}),
								...(input.model === undefined ? {} : { model: input.model }),
							},
						}
					: {}),
				budget: {
					maxTurns,
					maxWallTimeMinutes,
					...(input.maxCostUsd === undefined ? {} : { maxCostUsd: input.maxCostUsd, mode: "hard" as const }),
				},
				workspaceRoot: workspace.root,
				workspaceFingerprint: workspace.fingerprint,
				...(workspace.head ? { initialGitHead: workspace.head } : {}),
				...(input.kind !== "manual"
					? {
							toolPolicy: {
								allowedTools: [
									"read",
									"grep",
									"find",
									"ls",
									"bash",
									"edit",
									"write",
									"task_update",
									"agent_spawn",
									"agent_dispatch",
									"agent_message",
									"agent_inbox",
									...(input.kind === "interactive"
										? ["session_message", "session_inbox", "session_address"]
										: []),
									"agent_report",
									...(input.kind === "interactive" && input.mode === "flow"
										? ["flow_define", "flow_status"]
										: []),
								],
								allowedPaths: [workspace.root],
								readOnly: false,
								sandboxRequired: input.kind === "unattended" && input.unsafeNoSandbox !== true,
							},
						}
					: {}),
			});
			return controller.submit(task.id);
		} finally {
			if (!this.existingStore) store.close();
		}
	}

	resolve(taskRef: string): TaskRecord {
		const store = this.existingStore ?? this.openStore();
		try {
			return this.resolveWithStore(store, taskRef);
		} finally {
			if (!this.existingStore) store.close();
		}
	}

	list(): TaskRecord[] {
		const store = this.existingStore ?? this.openStore();
		try {
			return store.listTasks();
		} finally {
			if (!this.existingStore) store.close();
		}
	}

	snapshot(taskRef: string): TaskSnapshot {
		const store = this.existingStore ?? this.openStore();
		try {
			const task = this.resolveWithStore(store, taskRef);
			return { task, agents: store.listAgents(task.id) };
		} finally {
			if (!this.existingStore) store.close();
		}
	}

	events(taskRef: string, afterSeq = 0, limit = 200): TaskEvent[] {
		if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
			throw new TypeError("afterSeq must be a non-negative integer");
		if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000)
			throw new TypeError("limit must be an integer between 1 and 10000");
		const store = this.existingStore ?? this.openStore();
		try {
			const task = this.resolveWithStore(store, taskRef);
			return store.listEvents(task.id, afterSeq, limit);
		} finally {
			if (!this.existingStore) store.close();
		}
	}

	bundle(taskRef: string): VerifiedChangeBundleResult {
		const store = this.existingStore ?? this.openStore();
		try {
			const task = this.resolveWithStore(store, taskRef);
			return new VerifiedChangeBundle({ store, artifactsRoot: join(this.agentDir, "tasks") }).rebuild(task.id);
		} finally {
			if (!this.existingStore) store.close();
		}
	}

	control(command: TaskControlCommand, identity: TaskCommandIdentity): TaskControlResult {
		if (identity.clientId.trim() === "") throw new TypeError("Task command client ID is required");
		const commandId = identity.commandId ?? randomUUID();
		const store = this.existingStore ?? this.openStore();
		try {
			const task = this.resolveWithStore(store, command.taskRef);
			const { taskRef: _taskRef, ...control } = command;
			const payload = { ...control, taskId: task.id };
			const started = store.beginTaskCommand({
				clientId: identity.clientId,
				commandId,
				taskId: task.id,
				commandType: `task.${command.action}`,
				payloadSha256: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
				payload,
			});
			if (started.command.state === "completed") {
				if (started.command.result?.ok !== true) {
					const message = started.command.result?.error;
					throw new Error(typeof message === "string" ? message : "Stored Task command failed");
				}
				return { task: store.requireTask(task.id), commandId, duplicate: true };
			}

			try {
				const controlled = this.applyControl(store, task.id, command, `${identity.clientId}\0${commandId}`);
				store.completeTaskCommand(identity.clientId, commandId, {
					ok: true,
					taskId: controlled.id,
					state: controlled.state,
				});
				return { task: controlled, commandId, duplicate: started.duplicate };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				store.completeTaskCommand(identity.clientId, commandId, { ok: false, error: message });
				throw error;
			}
		} finally {
			if (!this.existingStore) store.close();
		}
	}

	private applyControl(
		store: SqliteTaskStore,
		taskId: string,
		command: TaskControlCommand,
		commandIdentity: string,
	): TaskRecord {
		const task = store.requireTask(taskId);
		const controller = new TaskController(store);
		if (command.action === "pause") return task.state === "paused" ? task : controller.pause(taskId);
		if (command.action === "resume")
			return task.state === "queued" ? task : controller.resume(taskId, command.acceptRuntimeDrift);
		if (command.action === "cancel") return task.state === "cancelled" ? task : controller.cancel(taskId);
		if (command.action === "steer") {
			if (command.message.trim() === "") throw new TypeError("Steering message is required");
			const agents = store.listAgents(taskId);
			const main = agents.find((agent) => agent.kind === "main");
			const exact = agents.find((agent) => agent.id === command.agentRef);
			const matches = exact ? [exact] : agents.filter((agent) => agent.id.startsWith(command.agentRef));
			if (!main || matches.length !== 1) throw new Error("Main or target Agent not found or ambiguous");
			const target = matches[0]!;
			store.queueUserSteering({
				taskId,
				agentId: target.id,
				dedupeKey: createHash("sha256").update(`user-steer\0${taskId}\0${commandIdentity}`).digest("hex"),
				body: command.message,
			});
			return store.requireTask(taskId);
		}
		const criterion = task.acceptance.find((candidate) => candidate.id === command.criterionId);
		if (!criterion) throw new Error(`Acceptance criterion not found: ${command.criterionId}`);
		if (criterion.kind !== "manual") throw new Error("Only manual acceptance criteria can be accepted by a user");
		if (!store.hasPassedAcceptance(taskId, criterion.id)) {
			controller.recordAcceptance(taskId, criterion.id, true, {
				confirmedBy: "user",
				confirmedAt: new Date().toISOString(),
			});
		}
		return store.requireTask(taskId);
	}

	private resolveWithStore(store: SqliteTaskStore, taskRef: string): TaskRecord {
		if (taskRef.trim() === "") throw new Error("Task ID is required");
		const exact = store.getTask(taskRef);
		if (exact) return exact;
		const matches = store.findTasksByIdPrefix(taskRef);
		if (matches.length === 1) return matches[0]!;
		if (matches.length > 1) throw new Error(`Task ID prefix is ambiguous: ${taskRef}`);
		throw new Error(`Task not found: ${taskRef}`);
	}

	private openStore(): SqliteTaskStore {
		return SqliteTaskStore.open({
			databasePath: join(this.agentDir, "long-tasks.sqlite"),
			artifactsRoot: join(this.agentDir, "tasks"),
		});
	}
}
