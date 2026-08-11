import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
	type AcceptanceCriterion,
	type AgentCheckpointCommit,
	type AgentLease,
	type AgentRecord,
	type AttemptRecord,
	assertSchema,
	type Budget,
	type CheckpointRecord,
	type CoordinationResult,
	type CreateTaskInput,
	type InboxMessage,
	type StaleExecution,
	type TaskEvent,
	type TaskNotification,
	type TaskNotificationKind,
	type TaskRecord,
	type TaskState,
	type ToolPolicy,
	type UnfinishedToolExecution,
	type WorkspaceSnapshot,
} from "./types.ts";

const CURRENT_SCHEMA_VERSION = 3;

const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
	draft: ["queued", "cancelled"],
	queued: ["running", "waiting_input", "paused", "cancelled"],
	running: ["waiting_input", "waiting_external", "paused", "unknown_outcome", "completed", "failed", "cancelled"],
	waiting_input: ["queued", "cancelled"],
	waiting_external: ["queued", "paused", "cancelled"],
	paused: ["queued", "cancelled"],
	unknown_outcome: ["queued", "failed", "cancelled"],
	completed: [],
	failed: [],
	cancelled: [],
};

const AGENT_TRANSITIONS: Readonly<Record<AgentRecord["state"], readonly AgentRecord["state"][]>> = {
	created: ["queued", "cancelled"],
	queued: ["running", "paused", "cancelled"],
	running: [
		"queued",
		"waiting_message",
		"waiting_external",
		"paused",
		"unknown_outcome",
		"completed",
		"failed",
		"cancelled",
	],
	recovering: ["queued", "waiting_message", "unknown_outcome", "failed", "cancelled"],
	waiting_message: ["queued", "paused", "cancelled"],
	waiting_external: ["queued", "paused", "cancelled"],
	paused: ["queued", "cancelled"],
	unknown_outcome: ["queued", "failed", "cancelled"],
	completed: [],
	failed: [],
	cancelled: [],
};

interface TaskRow {
	id: string;
	title: string;
	goal: string;
	acceptance_json: string;
	constraints_json: string;
	budget_json: string;
	state: TaskState;
	state_reason: string | null;
	workspace_root: string;
	workspace_fingerprint: string;
	initial_git_head: string | null;
	total_turns: number;
	total_cost_usd: number;
	next_wake_at: string | null;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
}

interface AgentRow {
	id: string;
	task_id: string;
	parent_agent_id: string | null;
	kind: "main" | "subagent";
	name: string;
	role: string;
	objective: string;
	state: AgentRecord["state"];
	depth: 0 | 1;
	active_session_id: string | null;
	workspace_mode: AgentRecord["workspaceMode"];
	workspace_root: string;
	tool_policy_json: string;
	budget_json: string;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
}

interface EventRow {
	id: string;
	task_id: string;
	agent_id: string | null;
	attempt_id: string | null;
	seq: number;
	type: string;
	payload_json: string;
	created_at: string;
}

interface MessageRow {
	id: string;
	task_id: string;
	sender_agent_id: string;
	recipient_agent_id: string;
	sender_seq: number;
	type: InboxMessage["type"];
	priority: InboxMessage["priority"];
	body_json: string;
	reply_to_message_id: string | null;
	created_at: string;
}

interface StoredMessageBody {
	body: string;
	artifactRefs: string[];
}

interface LeaseRow {
	agent_id: string;
	task_id: string;
	worker_id: string;
	execution_id: string;
	fencing_token: number;
	expires_at: string;
	revoked_at: string | null;
	pid: number | null;
	sandbox_id: string | null;
}

function parseObject(text: string, label: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`Corrupt ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`Corrupt ${label} JSON: object required`);
	return value as Record<string, unknown>;
}

function parseArray<T>(text: string, label: string): T[] {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`Corrupt ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(value)) throw new Error(`Corrupt ${label} JSON: array required`);
	return value as T[];
}

function taskFromRow(row: TaskRow): TaskRecord {
	const acceptance = parseArray<AcceptanceCriterion>(row.acceptance_json, "task acceptance");
	assertSchema("acceptance", acceptance);
	const budget = parseObject(row.budget_json, "task budget");
	assertSchema("budget", budget);
	return {
		id: row.id,
		title: row.title,
		goal: row.goal,
		acceptance,
		constraints: parseObject(row.constraints_json, "task constraints"),
		budget: budget as unknown as Budget,
		state: row.state,
		...(row.state_reason === null ? {} : { stateReason: row.state_reason }),
		workspaceRoot: row.workspace_root,
		workspaceFingerprint: row.workspace_fingerprint,
		...(row.initial_git_head === null ? {} : { initialGitHead: row.initial_git_head }),
		totalTurns: row.total_turns,
		totalCostUsd: row.total_cost_usd,
		...(row.next_wake_at === null ? {} : { nextWakeAt: row.next_wake_at }),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
	};
}

function agentFromRow(row: AgentRow): AgentRecord {
	const budget = parseObject(row.budget_json, "agent budget");
	assertSchema("budget", budget);
	return {
		id: row.id,
		taskId: row.task_id,
		...(row.parent_agent_id === null ? {} : { parentAgentId: row.parent_agent_id }),
		kind: row.kind,
		name: row.name,
		role: row.role,
		objective: row.objective,
		state: row.state,
		depth: row.depth,
		...(row.active_session_id === null ? {} : { activeSessionId: row.active_session_id }),
		workspaceMode: row.workspace_mode,
		workspaceRoot: row.workspace_root,
		toolPolicy: parseObject(row.tool_policy_json, "tool policy") as unknown as ToolPolicy,
		budget: budget as unknown as Budget,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
	};
}

function eventFromRow(row: EventRow): TaskEvent {
	return {
		id: row.id,
		taskId: row.task_id,
		...(row.agent_id === null ? {} : { agentId: row.agent_id }),
		...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
		seq: row.seq,
		type: row.type,
		payload: parseObject(row.payload_json, "event payload"),
		createdAt: row.created_at,
	};
}

function executeTransaction<T>(database: DatabaseSync, operation: () => T): T {
	database.exec("BEGIN IMMEDIATE");
	try {
		const result = operation();
		database.exec("COMMIT");
		return result;
	} catch (error) {
		try {
			database.exec("ROLLBACK");
		} catch {
			// Preserve the original transaction error.
		}
		throw error;
	}
}

function migrationSql(version: number): string {
	const names = { 1: "long_tasks", 2: "multi_agent", 3: "notifications" } as const;
	return readFileSync(
		fileURLToPath(new URL(`./migrations/00${version}_${names[version as keyof typeof names]}.sql`, import.meta.url)),
		"utf8",
	);
}

export interface OpenTaskStoreOptions {
	databasePath: string;
	artifactsRoot?: string;
	now?: () => Date;
}

export class SqliteTaskStore {
	private readonly database: DatabaseSync;
	private readonly now: () => Date;

	private constructor(database: DatabaseSync, now: () => Date) {
		this.database = database;
		this.now = now;
	}

	static open(options: OpenTaskStoreOptions): SqliteTaskStore {
		if (options.databasePath !== ":memory:") {
			mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
			chmodSync(dirname(options.databasePath), 0o700);
		}
		const database = new DatabaseSync(options.databasePath);
		database.exec(
			"PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;",
		);
		database.exec(
			"CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
		);
		const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
			version: number | null;
		};
		const existingVersion = row.version ?? 0;
		if (existingVersion > CURRENT_SCHEMA_VERSION) {
			database.close();
			throw new Error(
				`Long-task database schema ${existingVersion} is newer than supported schema ${CURRENT_SCHEMA_VERSION}`,
			);
		}
		for (let version = existingVersion + 1; version <= CURRENT_SCHEMA_VERSION; version++) {
			executeTransaction(database, () => {
				database.exec(migrationSql(version));
				database
					.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
					.run(version, new Date().toISOString());
			});
		}
		if (options.databasePath !== ":memory:") chmodSync(options.databasePath, 0o600);
		if (options.artifactsRoot) {
			mkdirSync(options.artifactsRoot, { recursive: true, mode: 0o700 });
			chmodSync(options.artifactsRoot, 0o700);
		}
		return new SqliteTaskStore(database, options.now ?? (() => new Date()));
	}

	close(): void {
		this.database.close();
	}

	createTask(input: CreateTaskInput): { task: TaskRecord; mainAgent: AgentRecord } {
		assertSchema("acceptance", input.acceptance);
		assertSchema("budget", input.budget);
		if (input.title.trim() === "" || input.goal.trim() === "")
			throw new TypeError("Task title and goal are required");
		const now = this.now().toISOString();
		const taskId = randomUUID();
		const agentId = randomUUID();
		const toolPolicy: ToolPolicy = input.toolPolicy ?? {
			allowedTools: [
				"read",
				"grep",
				"find",
				"ls",
				"bash",
				"edit",
				"write",
				"task_update",
				"delegate_task",
				"message_agent",
			],
			allowedPaths: [input.workspaceRoot],
			readOnly: false,
			sandboxRequired: false,
		};
		executeTransaction(this.database, () => {
			this.database
				.prepare(
					`INSERT INTO tasks (
					 id, title, goal, acceptance_json, constraints_json, budget_json, state, workspace_root,
					 workspace_fingerprint, initial_git_head, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
				)
				.run(
					taskId,
					input.title,
					input.goal,
					JSON.stringify(input.acceptance),
					JSON.stringify(input.constraints ?? {}),
					JSON.stringify(input.budget),
					input.workspaceRoot,
					input.workspaceFingerprint,
					input.initialGitHead ?? null,
					now,
					now,
				);
			this.database
				.prepare(
					`INSERT INTO agents (
					 id, task_id, kind, name, role, objective, state, depth, workspace_mode, workspace_root,
					 tool_policy_json, budget_json, created_at, updated_at
					) VALUES (?, ?, 'main', 'main', 'main', ?, 'created', 0, 'primary', ?, ?, ?, ?, ?)`,
				)
				.run(
					agentId,
					taskId,
					input.goal,
					input.workspaceRoot,
					JSON.stringify(toolPolicy),
					JSON.stringify(input.budget),
					now,
					now,
				);
			this.appendEventInternal(
				taskId,
				agentId,
				undefined,
				"TaskCreated",
				{ title: input.title, schemaVersion: 1 },
				now,
			);
			this.appendEventInternal(taskId, agentId, undefined, "AgentCreated", { kind: "main", schemaVersion: 1 }, now);
		});
		return { task: this.requireTask(taskId), mainAgent: this.requireAgent(agentId) };
	}

	getTask(taskId: string): TaskRecord | undefined {
		const row = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
		return row ? taskFromRow(row) : undefined;
	}

	requireTask(taskId: string): TaskRecord {
		const task = this.getTask(taskId);
		if (!task) throw new Error(`Task not found: ${taskId}`);
		return task;
	}

	listTasks(limit = 100): TaskRecord[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
			throw new RangeError("Task list limit must be 1..10000");
		return (
			this.database
				.prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?")
				.all(limit) as unknown as TaskRow[]
		).map(taskFromRow);
	}

	listRunnableTasks(limit = 1): TaskRecord[] {
		const now = this.now().toISOString();
		return (
			this.database
				.prepare(
					`SELECT * FROM tasks WHERE state IN ('queued', 'running') AND (next_wake_at IS NULL OR next_wake_at <= ?)
					 ORDER BY updated_at, created_at LIMIT ?`,
				)
				.all(now, limit) as unknown as TaskRow[]
		).map(taskFromRow);
	}

	queueStateNotifications(): number {
		return executeTransaction(this.database, () => {
			const rows = this.database
				.prepare(
					`SELECT events.task_id, events.seq, events.type, tasks.title
					 FROM task_events events JOIN tasks ON tasks.id = events.task_id
					 WHERE (events.type IN ('TaskCompleted', 'TaskFailed')
					   OR (events.type = 'TaskWaiting' AND json_extract(events.payload_json, '$.to') = 'waiting_input'))
					 AND NOT EXISTS (
					   SELECT 1 FROM task_notifications notifications
					   WHERE notifications.task_id = events.task_id AND notifications.source_event_seq = events.seq
					 )
					 ORDER BY events.created_at, events.seq`,
				)
				.all() as unknown as Array<{ task_id: string; seq: number; type: string; title: string }>;
			let queued = 0;
			for (const row of rows) {
				const kind: TaskNotificationKind =
					row.type === "TaskCompleted" ? "completed" : row.type === "TaskFailed" ? "failed" : "waiting_input";
				const result = this.database
					.prepare(
						`INSERT OR IGNORE INTO task_notifications
						 (id, task_id, source_event_seq, kind, title, body, state, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
					)
					.run(
						randomUUID(),
						row.task_id,
						row.seq,
						kind,
						kind === "completed"
							? "Karissa 已完成任务"
							: kind === "failed"
								? "Karissa 任务失败"
								: "Karissa 需要你的输入",
						`${row.title}\n${row.task_id.slice(0, 8)}`,
						this.now().toISOString(),
					);
				queued += Number(result.changes);
			}
			return queued;
		});
	}

	listPendingNotifications(limit = 20): TaskNotification[] {
		const rows = this.database
			.prepare("SELECT * FROM task_notifications WHERE state = 'pending' ORDER BY created_at LIMIT ?")
			.all(limit) as unknown as Array<{
			id: string;
			task_id: string;
			kind: TaskNotificationKind;
			title: string;
			body: string;
			created_at: string;
		}>;
		return rows.map((row) => ({
			id: row.id,
			taskId: row.task_id,
			kind: row.kind,
			title: row.title,
			body: row.body,
			createdAt: row.created_at,
		}));
	}

	markNotificationSent(notificationId: string): void {
		const result = this.database
			.prepare("UPDATE task_notifications SET state = 'sent', sent_at = ? WHERE id = ? AND state = 'pending'")
			.run(this.now().toISOString(), notificationId);
		if (Number(result.changes) !== 1) throw new Error(`Pending notification not found: ${notificationId}`);
	}

	markNotificationFailed(notificationId: string, message: string): void {
		this.database
			.prepare("UPDATE task_notifications SET last_error = ? WHERE id = ? AND state = 'pending'")
			.run(message.slice(0, 1000), notificationId);
	}

	setNextWakeAt(taskId: string, nextWakeAt: string | undefined): TaskRecord {
		const task = this.requireTask(taskId);
		if (nextWakeAt !== undefined && !Number.isFinite(Date.parse(nextWakeAt))) throw new Error("Invalid wake time");
		if (["completed", "failed", "cancelled"].includes(task.state)) throw new Error("Cannot schedule a terminal Task");
		const now = this.now().toISOString();
		executeTransaction(this.database, () => {
			this.database
				.prepare("UPDATE tasks SET next_wake_at = ?, updated_at = ? WHERE id = ?")
				.run(nextWakeAt ?? null, now, taskId);
			this.appendEventInternal(
				taskId,
				undefined,
				undefined,
				nextWakeAt ? "TaskWaiting" : "TaskQueued",
				{ kind: "time", resumeAt: nextWakeAt, schemaVersion: 1 },
				now,
			);
		});
		return this.requireTask(taskId);
	}

	getAgent(agentId: string): AgentRecord | undefined {
		const row = this.database.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
		return row ? agentFromRow(row) : undefined;
	}

	requireAgent(agentId: string): AgentRecord {
		const agent = this.getAgent(agentId);
		if (!agent) throw new Error(`Agent not found: ${agentId}`);
		return agent;
	}

	listAgents(taskId: string): AgentRecord[] {
		return (
			this.database
				.prepare("SELECT * FROM agents WHERE task_id = ? ORDER BY depth, created_at, id")
				.all(taskId) as unknown as AgentRow[]
		).map(agentFromRow);
	}

	listRunnableAgents(taskId: string, maxConcurrent = 4): AgentRecord[] {
		const agents = this.listAgents(taskId);
		const active = agents.filter((agent) => ["running", "recovering"].includes(agent.state)).length;
		return agents.filter((agent) => agent.state === "queued").slice(0, Math.max(0, maxConcurrent - active));
	}

	transitionAgent(agentId: string, nextState: AgentRecord["state"], reason?: string): AgentRecord {
		return executeTransaction(this.database, () => {
			const agent = this.requireAgent(agentId);
			if (!AGENT_TRANSITIONS[agent.state].includes(nextState))
				throw new Error(`Illegal Agent transition: ${agent.state} -> ${nextState}`);
			const now = this.now().toISOString();
			const completedAt = ["completed", "failed", "cancelled"].includes(nextState) ? now : null;
			this.database
				.prepare("UPDATE agents SET state = ?, updated_at = ?, completed_at = ? WHERE id = ?")
				.run(nextState, now, completedAt, agentId);
			this.appendEventInternal(
				agent.taskId,
				agentId,
				undefined,
				nextState === "queued"
					? "AgentQueued"
					: nextState === "paused"
						? "AgentPaused"
						: nextState === "cancelled"
							? "AgentCancelled"
							: nextState === "failed"
								? "AgentFailed"
								: nextState === "completed"
									? "AgentCompleted"
									: "AgentStarted",
				{ from: agent.state, to: nextState, reason, schemaVersion: 1 },
				now,
			);
			return this.requireAgent(agentId);
		});
	}

	detectCoordinationDeadlock(taskId: string): boolean {
		return executeTransaction(this.database, () => {
			const task = this.requireTask(taskId);
			const agents = this.listAgents(taskId).filter(
				(agent) => !["completed", "failed", "cancelled"].includes(agent.state),
			);
			if (
				agents.length === 0 ||
				!agents.every((agent) => ["waiting_message", "waiting_external"].includes(agent.state))
			)
				return false;
			const queued = this.database
				.prepare(
					"SELECT COUNT(*) AS count FROM agent_messages WHERE task_id = ? AND state IN ('queued', 'delivered')",
				)
				.get(taskId) as { count: number };
			const wakes = this.database
				.prepare("SELECT COUNT(*) AS count FROM wake_conditions WHERE task_id = ? AND state = 'pending'")
				.get(taskId) as { count: number };
			if (queued.count > 0 || wakes.count > 0) return false;
			const now = this.now().toISOString();
			this.appendEventInternal(
				taskId,
				undefined,
				undefined,
				"CoordinationDeadlockDetected",
				{ agentIds: agents.map((agent) => agent.id), schemaVersion: 1 },
				now,
			);
			if (task.state === "running") {
				this.database
					.prepare(
						"UPDATE tasks SET state = 'waiting_input', state_reason = 'coordination_deadlock', updated_at = ? WHERE id = ?",
					)
					.run(now, taskId);
			}
			return true;
		});
	}

	markProviderUnavailable(agentId: string, retryAt: string, failureCount: number): void {
		const agent = this.requireAgent(agentId);
		executeTransaction(this.database, () => {
			const now = this.now().toISOString();
			this.database
				.prepare("UPDATE agents SET state = 'waiting_external', updated_at = ? WHERE id = ?")
				.run(now, agentId);
			this.database
				.prepare(
					"UPDATE tasks SET state = 'waiting_external', state_reason = 'provider_unavailable', next_wake_at = ?, updated_at = ? WHERE id = ?",
				)
				.run(retryAt, now, agent.taskId);
			this.appendEventInternal(
				agent.taskId,
				agentId,
				undefined,
				"TaskWaiting",
				{ kind: "provider", retryAt, failureCount, schemaVersion: 1 },
				now,
			);
		});
	}

	transitionTask(taskId: string, nextState: TaskState, reason?: string): TaskRecord {
		return executeTransaction(this.database, () => {
			const task = this.requireTask(taskId);
			if (!TASK_TRANSITIONS[task.state].includes(nextState))
				throw new Error(`Illegal task transition: ${task.state} -> ${nextState}`);
			if (nextState === "completed") this.assertCompletionReady(taskId);
			const now = this.now().toISOString();
			const completedAt = nextState === "completed" ? now : null;
			this.database
				.prepare("UPDATE tasks SET state = ?, state_reason = ?, updated_at = ?, completed_at = ? WHERE id = ?")
				.run(nextState, reason ?? null, now, completedAt, taskId);
			if (nextState === "queued") {
				this.database
					.prepare(
						`UPDATE agents SET state = 'queued', updated_at = ? WHERE task_id = ?
						 AND state IN ('created', 'paused', 'waiting_message', 'waiting_external')`,
					)
					.run(now, taskId);
			} else if (nextState === "paused") {
				this.database
					.prepare(
						`UPDATE agents SET state = 'paused', updated_at = ? WHERE task_id = ?
						 AND state NOT IN ('completed', 'failed', 'cancelled', 'unknown_outcome')`,
					)
					.run(now, taskId);
			} else if (nextState === "cancelled" || nextState === "failed") {
				this.database
					.prepare(
						`UPDATE agents SET state = ?, updated_at = ?, completed_at = ? WHERE task_id = ?
						 AND state NOT IN ('completed', 'failed', 'cancelled')`,
					)
					.run(nextState, now, now, taskId);
			}
			const eventType =
				nextState === "queued"
					? "TaskQueued"
					: nextState === "paused"
						? "TaskPaused"
						: nextState === "completed"
							? "TaskCompleted"
							: nextState === "failed"
								? "TaskFailed"
								: nextState === "cancelled"
									? "TaskCancelled"
									: nextState.startsWith("waiting_")
										? "TaskWaiting"
										: nextState === "running"
											? "AttemptStarted"
											: "ToolOutcomeUnknown";
			this.appendEventInternal(
				taskId,
				undefined,
				undefined,
				eventType,
				{ from: task.state, to: nextState, reason, schemaVersion: 1 },
				now,
			);
			return this.requireTask(taskId);
		});
	}

	listEvents(taskId: string, afterSeq = 0, limit = 200): TaskEvent[] {
		return (
			this.database
				.prepare("SELECT * FROM task_events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?")
				.all(taskId, afterSeq, limit) as unknown as EventRow[]
		).map(eventFromRow);
	}

	appendAgentEvent(
		lease: AgentLease,
		attemptId: string | undefined,
		type: string,
		payload: Record<string, unknown>,
	): number {
		return executeTransaction(this.database, () => {
			this.assertLeaseInternal(lease);
			return this.appendEventInternal(
				lease.taskId,
				lease.agentId,
				attemptId,
				type,
				payload,
				this.now().toISOString(),
			);
		});
	}

	appendTaskEvent(taskId: string, type: string, payload: Record<string, unknown>): number {
		this.requireTask(taskId);
		return executeTransaction(this.database, () =>
			this.appendEventInternal(taskId, undefined, undefined, type, payload, this.now().toISOString()),
		);
	}

	recordAcceptance(taskId: string, criterionId: string, passed: boolean, evidence: Record<string, unknown>): void {
		const task = this.requireTask(taskId);
		if (!task.acceptance.some((criterion) => criterion.id === criterionId))
			throw new Error(`Unknown acceptance criterion: ${criterionId}`);
		executeTransaction(this.database, () => {
			this.appendEventInternal(
				taskId,
				undefined,
				undefined,
				passed ? "AcceptancePassed" : "AcceptanceFailed",
				{ criterionId, evidence, schemaVersion: 1 },
				this.now().toISOString(),
			);
		});
	}

	hasPassedAcceptance(taskId: string, criterionId: string): boolean {
		return Boolean(
			this.database
				.prepare(
					`SELECT id FROM task_events WHERE task_id = ? AND type = 'AcceptancePassed'
					 AND json_extract(payload_json, '$.criterionId') = ? ORDER BY seq DESC LIMIT 1`,
				)
				.get(taskId, criterionId),
		);
	}

	createAttempt(
		agentId: string,
		sessionId: string | undefined,
		runtimeSnapshot: Record<string, unknown>,
		runtimeSnapshotSha256: string,
	): string {
		const agent = this.requireAgent(agentId);
		assertSchema("runtimeSnapshot", runtimeSnapshot);
		const attemptId = randomUUID();
		const now = this.now().toISOString();
		executeTransaction(this.database, () => {
			const ordinalRow = this.database
				.prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM attempts WHERE agent_id = ?")
				.get(agentId) as {
				ordinal: number;
			};
			this.database
				.prepare(
					`INSERT INTO attempts (
					 id, task_id, agent_id, session_id, ordinal, state, runtime_snapshot_json,
					 runtime_snapshot_sha256, started_at
					) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
				)
				.run(
					attemptId,
					agent.taskId,
					agentId,
					sessionId ?? null,
					ordinalRow.ordinal,
					JSON.stringify(runtimeSnapshot),
					runtimeSnapshotSha256,
					now,
				);
			this.database
				.prepare("UPDATE agents SET state = 'running', active_session_id = ?, updated_at = ? WHERE id = ?")
				.run(sessionId ?? null, now, agentId);
			this.appendEventInternal(
				agent.taskId,
				agentId,
				attemptId,
				"AttemptStarted",
				{ ordinal: ordinalRow.ordinal, schemaVersion: 1 },
				now,
			);
		});
		return attemptId;
	}

	getLatestAttempt(agentId: string): AttemptRecord | undefined {
		const row = this.database
			.prepare("SELECT * FROM attempts WHERE agent_id = ? ORDER BY ordinal DESC LIMIT 1")
			.get(agentId) as
			| {
					id: string;
					task_id: string;
					agent_id: string;
					session_id: string | null;
					ordinal: number;
					state: string;
					runtime_snapshot_json: string;
					runtime_snapshot_sha256: string;
					started_at: string;
					settled_at: string | null;
					turn_count: number;
					cost_usd: number;
					error_code: string | null;
			  }
			| undefined;
		if (!row) return undefined;
		const runtimeSnapshot = parseObject(row.runtime_snapshot_json, "attempt runtime snapshot");
		assertSchema("runtimeSnapshot", runtimeSnapshot);
		return {
			id: row.id,
			taskId: row.task_id,
			agentId: row.agent_id,
			...(row.session_id === null ? {} : { sessionId: row.session_id }),
			ordinal: row.ordinal,
			state: row.state,
			runtimeSnapshot: runtimeSnapshot as unknown as AttemptRecord["runtimeSnapshot"],
			runtimeSnapshotSha256: row.runtime_snapshot_sha256,
			startedAt: row.started_at,
			...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
			turnCount: row.turn_count,
			costUsd: row.cost_usd,
			...(row.error_code === null ? {} : { errorCode: row.error_code }),
		};
	}

	getLatestCheckpoint(agentId: string): CheckpointRecord | undefined {
		const row = this.database
			.prepare("SELECT * FROM checkpoints WHERE agent_id = ? ORDER BY event_seq DESC LIMIT 1")
			.get(agentId) as
			| {
					id: string;
					task_id: string;
					agent_id: string;
					attempt_id: string;
					event_seq: number;
					session_checkpoint_json: string;
					progress_json: string;
					evidence_json: string;
					workspace_snapshot_json: string;
					runtime_snapshot_sha256: string;
					created_at: string;
			  }
			| undefined;
		if (!row) return undefined;
		const sessionCheckpoint = parseObject(row.session_checkpoint_json, "session checkpoint");
		const progress = parseObject(row.progress_json, "checkpoint progress");
		const evidence = parseArray(row.evidence_json, "checkpoint evidence");
		assertSchema("sessionCheckpoint", sessionCheckpoint);
		assertSchema("progress", progress);
		assertSchema("evidence", evidence);
		return {
			id: row.id,
			taskId: row.task_id,
			agentId: row.agent_id,
			attemptId: row.attempt_id,
			eventSeq: row.event_seq,
			sessionCheckpoint: sessionCheckpoint as unknown as CheckpointRecord["sessionCheckpoint"],
			progress: progress as unknown as CheckpointRecord["progress"],
			evidence: evidence as CheckpointRecord["evidence"],
			workspaceSnapshot: parseObject(row.workspace_snapshot_json, "workspace snapshot"),
			runtimeSnapshotSha256: row.runtime_snapshot_sha256,
			createdAt: row.created_at,
		};
	}

	getPendingCheckpointUpdate(
		taskId: string,
		agentId: string,
	):
		| {
				summary: string;
				completedItems: string[];
				currentItem?: string;
				nextActions: string[];
				evidence: CheckpointRecord["evidence"];
		  }
		| undefined {
		const row = this.database
			.prepare(
				`SELECT payload_json FROM task_events
				 WHERE task_id = ? AND type = 'CheckpointRequested'
				 AND json_extract(payload_json, '$.agentId') = ?
				 AND seq > COALESCE((SELECT MAX(event_seq) FROM checkpoints WHERE task_id = ? AND agent_id = ?), 0)
				 ORDER BY seq DESC LIMIT 1`,
			)
			.get(taskId, agentId, taskId, agentId) as { payload_json: string } | undefined;
		if (!row) return undefined;
		const payload = parseObject(row.payload_json, "checkpoint request");
		const evidence = payload.evidence;
		if (
			typeof payload.summary !== "string" ||
			!Array.isArray(payload.completedItems) ||
			!payload.completedItems.every((item) => typeof item === "string") ||
			!Array.isArray(payload.nextActions) ||
			!payload.nextActions.every((item) => typeof item === "string")
		) {
			throw new Error("Corrupt CheckpointRequested event payload");
		}
		assertSchema("evidence", evidence);
		return {
			summary: payload.summary,
			completedItems: payload.completedItems,
			...(typeof payload.currentItem === "string" ? { currentItem: payload.currentItem } : {}),
			nextActions: payload.nextActions,
			evidence: evidence as CheckpointRecord["evidence"],
		};
	}

	acquireLease(
		agentId: string,
		workerId: string,
		executionId: string,
		leaseSeconds = 30,
		execution?: { pid?: number; sandboxId?: string },
	): AgentLease {
		const agent = this.requireAgent(agentId);
		return executeTransaction(this.database, () => {
			const nowDate = this.now();
			const now = nowDate.toISOString();
			const existing = this.database.prepare("SELECT * FROM leases WHERE agent_id = ?").get(agentId) as
				| LeaseRow
				| undefined;
			if (existing && existing.revoked_at === null && Date.parse(existing.expires_at) > nowDate.getTime()) {
				throw new Error(`Agent ${agentId} already has an active lease`);
			}
			if (existing && existing.revoked_at === null) {
				throw new Error(`Agent ${agentId} requires the recovery barrier before lease takeover`);
			}
			const fencingToken = (existing?.fencing_token ?? 0) + 1;
			const expiresAt = new Date(nowDate.getTime() + leaseSeconds * 1000).toISOString();
			this.database
				.prepare(
					`INSERT INTO leases (agent_id, task_id, worker_id, execution_id, pid, sandbox_id, fencing_token, acquired_at, heartbeat_at, expires_at, revoked_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
					 ON CONFLICT(agent_id) DO UPDATE SET worker_id=excluded.worker_id, execution_id=excluded.execution_id,
					 pid=excluded.pid, sandbox_id=excluded.sandbox_id,
					 fencing_token=excluded.fencing_token, acquired_at=excluded.acquired_at, heartbeat_at=excluded.heartbeat_at,
					 expires_at=excluded.expires_at, revoked_at=NULL`,
				)
				.run(
					agentId,
					agent.taskId,
					workerId,
					executionId,
					execution?.pid ?? null,
					execution?.sandboxId ?? null,
					fencingToken,
					now,
					now,
					expiresAt,
				);
			this.appendEventInternal(
				agent.taskId,
				agentId,
				undefined,
				"LeaseAcquired",
				{ workerId, executionId, fencingToken, schemaVersion: 1 },
				now,
			);
			return { agentId, taskId: agent.taskId, workerId, executionId, fencingToken, expiresAt };
		});
	}

	listExpiredExecutions(): StaleExecution[] {
		const rows = this.database
			.prepare("SELECT * FROM leases WHERE revoked_at IS NULL AND expires_at <= ? ORDER BY expires_at")
			.all(this.now().toISOString()) as unknown as LeaseRow[];
		return rows.map((row) => ({
			agentId: row.agent_id,
			taskId: row.task_id,
			workerId: row.worker_id,
			executionId: row.execution_id,
			fencingToken: row.fencing_token,
			expiresAt: row.expires_at,
			...(row.pid === null ? {} : { pid: row.pid }),
			...(row.sandbox_id === null ? {} : { sandboxId: row.sandbox_id }),
		}));
	}

	beginRecovery(agentId: string): { execution: StaleExecution; unfinishedTools: UnfinishedToolExecution[] } {
		return executeTransaction(this.database, () => {
			const row = this.database.prepare("SELECT * FROM leases WHERE agent_id = ?").get(agentId) as
				| LeaseRow
				| undefined;
			if (!row || row.revoked_at !== null) throw new Error(`No stale execution to recover for Agent ${agentId}`);
			if (Date.parse(row.expires_at) > this.now().getTime())
				throw new Error(`Agent ${agentId} lease has not expired`);
			const now = this.now().toISOString();
			this.database.prepare("UPDATE leases SET revoked_at = ? WHERE agent_id = ?").run(now, agentId);
			this.database.prepare("UPDATE agents SET state = 'recovering', updated_at = ? WHERE id = ?").run(now, agentId);
			const execution: StaleExecution = {
				agentId: row.agent_id,
				taskId: row.task_id,
				workerId: row.worker_id,
				executionId: row.execution_id,
				fencingToken: row.fencing_token,
				expiresAt: row.expires_at,
				...(row.pid === null ? {} : { pid: row.pid }),
				...(row.sandbox_id === null ? {} : { sandboxId: row.sandbox_id }),
			};
			for (const type of ["WorkerLost", "LeaseRevoked", "RecoveryStarted"]) {
				this.appendEventInternal(
					row.task_id,
					agentId,
					undefined,
					type,
					{ executionId: row.execution_id, fencingToken: row.fencing_token, schemaVersion: 1 },
					now,
				);
			}
			return { execution, unfinishedTools: this.listUnfinishedToolsInternal(row.task_id, agentId) };
		});
	}

	finishRecovery(agentId: string, safe: boolean, reason?: string): void {
		executeTransaction(this.database, () => {
			const agent = this.requireAgent(agentId);
			if (agent.state !== "recovering") throw new Error(`Agent ${agentId} is not recovering`);
			const now = this.now().toISOString();
			const state = safe ? "queued" : "unknown_outcome";
			this.database.prepare("UPDATE agents SET state = ?, updated_at = ? WHERE id = ?").run(state, now, agentId);
			this.appendEventInternal(
				agent.taskId,
				agentId,
				undefined,
				safe ? "RecoveryCompleted" : "RecoveryBlocked",
				{ reason, schemaVersion: 1 },
				now,
			);
			if (!safe) {
				const task = this.requireTask(agent.taskId);
				if (task.state === "running") {
					this.database
						.prepare("UPDATE tasks SET state = 'unknown_outcome', state_reason = ?, updated_at = ? WHERE id = ?")
						.run(reason ?? "recovery_blocked", now, agent.taskId);
				}
			}
		});
	}

	renewLease(lease: AgentLease, leaseSeconds = 30): AgentLease {
		return executeTransaction(this.database, () => {
			this.assertLeaseInternal(lease);
			const nowDate = this.now();
			const expiresAt = new Date(nowDate.getTime() + leaseSeconds * 1000).toISOString();
			this.database
				.prepare("UPDATE leases SET heartbeat_at = ?, expires_at = ? WHERE agent_id = ?")
				.run(nowDate.toISOString(), expiresAt, lease.agentId);
			this.appendEventInternal(
				lease.taskId,
				lease.agentId,
				undefined,
				"LeaseRenewed",
				{ fencingToken: lease.fencingToken, schemaVersion: 1 },
				nowDate.toISOString(),
			);
			return { ...lease, expiresAt };
		});
	}

	releaseLease(lease: AgentLease): void {
		executeTransaction(this.database, () => {
			this.assertLeaseInternal(lease);
			const now = this.now().toISOString();
			this.database.prepare("UPDATE leases SET revoked_at = ? WHERE agent_id = ?").run(now, lease.agentId);
			this.appendEventInternal(
				lease.taskId,
				lease.agentId,
				undefined,
				"LeaseReleased",
				{ fencingToken: lease.fencingToken, schemaVersion: 1 },
				now,
			);
		});
	}

	reserveBudget(agentId: string, attemptId: string, providerRequestId: string, worstCaseCostUsd?: number): string {
		const agent = this.requireAgent(agentId);
		return executeTransaction(this.database, () => {
			const task = this.requireTask(agent.taskId);
			const reserved = this.database
				.prepare(
					`SELECT COALESCE(SUM(reserved_turns), 0) AS turns, COALESCE(SUM(reserved_cost_usd), 0) AS cost
					 FROM budget_reservations WHERE task_id = ? AND state = 'active'`,
				)
				.get(task.id) as { turns: number; cost: number };
			if (task.totalTurns + reserved.turns + 1 > task.budget.maxTurns) throw new Error("Task turn budget exceeded");
			if (
				task.budget.maxCostUsd !== undefined &&
				(worstCaseCostUsd === undefined ||
					task.totalCostUsd + reserved.cost + worstCaseCostUsd > task.budget.maxCostUsd)
			) {
				throw new Error(
					worstCaseCostUsd === undefined
						? "Hard cost budget requires a reliable worst-case cost"
						: "Task cost budget exceeded",
				);
			}
			const id = randomUUID();
			const now = this.now().toISOString();
			this.database
				.prepare(
					`INSERT INTO budget_reservations
					 (id, task_id, agent_id, attempt_id, provider_request_id, reserved_turns, reserved_cost_usd, state, created_at)
					 VALUES (?, ?, ?, ?, ?, 1, ?, 'active', ?)`,
				)
				.run(id, task.id, agentId, attemptId, providerRequestId, worstCaseCostUsd ?? null, now);
			this.appendEventInternal(
				task.id,
				agentId,
				attemptId,
				"BudgetReserved",
				{ reservationId: id, schemaVersion: 1 },
				now,
			);
			return id;
		});
	}

	settleBudget(reservationId: string, actualCostUsd: number): void {
		executeTransaction(this.database, () => {
			const row = this.database
				.prepare("SELECT * FROM budget_reservations WHERE id = ? AND state = 'active'")
				.get(reservationId) as { task_id: string; agent_id: string; attempt_id: string } | undefined;
			if (!row) throw new Error(`Active budget reservation not found: ${reservationId}`);
			const now = this.now().toISOString();
			this.database
				.prepare("UPDATE budget_reservations SET state = 'settled', settled_at = ? WHERE id = ?")
				.run(now, reservationId);
			this.database
				.prepare(
					"UPDATE tasks SET total_turns = total_turns + 1, total_cost_usd = total_cost_usd + ?, updated_at = ? WHERE id = ?",
				)
				.run(actualCostUsd, now, row.task_id);
			this.database
				.prepare("UPDATE attempts SET turn_count = turn_count + 1, cost_usd = cost_usd + ? WHERE id = ?")
				.run(actualCostUsd, row.attempt_id);
			this.appendEventInternal(
				row.task_id,
				row.agent_id,
				row.attempt_id,
				"BudgetSettled",
				{ reservationId, actualCostUsd, schemaVersion: 1 },
				now,
			);
		});
	}

	coordinate(actorId: string, operationKey: string, operation: () => CoordinationResult): CoordinationResult {
		return executeTransaction(this.database, () => {
			const existing = this.database
				.prepare("SELECT result_json FROM coordination_results WHERE operation_key = ?")
				.get(operationKey) as { result_json: string } | undefined;
			if (existing)
				return {
					...(parseObject(existing.result_json, "coordination result") as unknown as CoordinationResult),
					replayed: true,
				};
			const result = operation();
			const actor = this.requireAgent(actorId);
			this.database
				.prepare(
					"INSERT INTO coordination_results(operation_key, task_id, actor_agent_id, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run(operationKey, actor.taskId, actorId, JSON.stringify(result), this.now().toISOString());
			return result;
		});
	}

	createDelegation(input: {
		actor: AgentRecord;
		operationKey: string;
		name: string;
		role: string;
		objective: string;
		acceptance: AcceptanceCriterion[];
		paths: string[];
		allowedTools: string[];
		workspaceMode: "read_only_shared" | "isolated_worktree";
		budget: Budget;
		required: boolean;
		workspaceRoot?: string;
		workspaceSnapshot?: WorkspaceSnapshot;
		workspaceSnapshotSha256?: string;
	}): { delegationId: string; agentId: string } {
		if (input.actor.kind !== "main") throw new Error("Only the main agent may delegate");
		assertSchema("acceptance", input.acceptance);
		assertSchema("budget", input.budget);
		const task = this.requireTask(input.actor.taskId);
		if (["completed", "failed", "cancelled"].includes(task.state))
			throw new Error("Cannot delegate from a terminal task");
		if (input.allowedTools.includes("delegate_task")) throw new Error("Subagent tools cannot include delegate_task");
		if (input.budget.maxTurns > input.actor.budget.maxTurns)
			throw new Error("Subagent turn budget exceeds parent budget");
		if (!input.allowedTools.every((tool) => input.actor.toolPolicy.allowedTools.includes(tool)))
			throw new Error("Subagent tool policy exceeds parent policy");
		const normalizedPaths = input.paths.map((path) => resolve(input.actor.workspaceRoot, path));
		if (
			!normalizedPaths.every((path) =>
				input.actor.toolPolicy.allowedPaths.some((allowedPath) => {
					const child = relative(resolve(allowedPath), path);
					return child === "" || (!child.startsWith("..") && !isAbsolute(child));
				}),
			)
		)
			throw new Error("Subagent path scope exceeds parent policy");
		const reservedBudgets = this.database
			.prepare(
				"SELECT budget_json FROM delegations WHERE task_id = ? AND state NOT IN ('completed', 'failed', 'cancelled')",
			)
			.all(task.id) as unknown as Array<{ budget_json: string }>;
		const reservedTurns = reservedBudgets.reduce((total, row) => {
			const budget = parseObject(row.budget_json, "delegation budget");
			assertSchema("budget", budget);
			return total + (budget as unknown as Budget).maxTurns;
		}, 0);
		if (reservedTurns + input.budget.maxTurns > Math.max(0, task.budget.maxTurns - task.totalTurns)) {
			throw new Error("Delegation turn reservations exceed remaining Task budget");
		}
		if (task.budget.maxCostUsd !== undefined && input.budget.maxCostUsd !== undefined) {
			const reservedCost = reservedBudgets.reduce((total, row) => {
				const cost = parseObject(row.budget_json, "delegation budget").maxCostUsd;
				return total + (typeof cost === "number" ? cost : 0);
			}, 0);
			if (reservedCost + input.budget.maxCostUsd > task.budget.maxCostUsd - task.totalCostUsd)
				throw new Error("Delegation cost reservations exceed remaining Task budget");
		}
		const now = this.now().toISOString();
		const agentId = randomUUID();
		const delegationId = randomUUID();
		const readOnly = input.workspaceMode === "read_only_shared";
		const toolPolicy: ToolPolicy = {
			allowedTools: input.allowedTools,
			allowedPaths: normalizedPaths,
			readOnly,
			sandboxRequired: readOnly,
		};
		this.database
			.prepare(
				`INSERT INTO agents (
				 id, task_id, parent_agent_id, kind, name, role, objective, state, depth, workspace_mode,
				 workspace_root, tool_policy_json, budget_json, created_at, updated_at
				) VALUES (?, ?, ?, 'subagent', ?, ?, ?, 'queued', 1, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				agentId,
				input.actor.taskId,
				input.actor.id,
				input.name,
				input.role,
				input.objective,
				input.workspaceMode,
				input.workspaceRoot ?? input.actor.workspaceRoot,
				JSON.stringify(toolPolicy),
				JSON.stringify(input.budget),
				now,
				now,
			);
		this.database
			.prepare(
				`INSERT INTO delegations (
				 id, task_id, parent_agent_id, child_agent_id, operation_key, objective, acceptance_json,
				 scope_json, budget_json, workspace_snapshot_json, workspace_snapshot_sha256, required, state, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
			)
			.run(
				delegationId,
				input.actor.taskId,
				input.actor.id,
				agentId,
				input.operationKey,
				input.objective,
				JSON.stringify(input.acceptance),
				JSON.stringify({
					paths: normalizedPaths,
					allowedTools: input.allowedTools,
					workspaceMode: input.workspaceMode,
				}),
				JSON.stringify(input.budget),
				input.workspaceSnapshot ? JSON.stringify(input.workspaceSnapshot) : null,
				input.workspaceSnapshotSha256 ?? null,
				input.required ? 1 : 0,
				now,
			);
		this.appendEventInternal(
			input.actor.taskId,
			input.actor.id,
			undefined,
			"DelegationCreated",
			{ delegationId, childAgentId: agentId, schemaVersion: 1 },
			now,
		);
		if (input.workspaceSnapshot && input.workspaceSnapshotSha256) {
			this.appendEventInternal(
				input.actor.taskId,
				agentId,
				undefined,
				"WorkspaceSnapshotCreated",
				{ delegationId, workspaceSnapshotSha256: input.workspaceSnapshotSha256, schemaVersion: 1 },
				now,
			);
		}
		this.appendEventInternal(
			input.actor.taskId,
			agentId,
			undefined,
			"AgentCreated",
			{ kind: "subagent", parentAgentId: input.actor.id, schemaVersion: 1 },
			now,
		);
		return { delegationId, agentId };
	}

	getDelegationForAgent(agentId: string): { acceptance: AcceptanceCriterion[] } | undefined {
		const row = this.database
			.prepare("SELECT acceptance_json FROM delegations WHERE child_agent_id = ?")
			.get(agentId) as { acceptance_json: string } | undefined;
		if (!row) return undefined;
		const acceptance = parseArray<AcceptanceCriterion>(row.acceptance_json, "delegation acceptance");
		assertSchema("acceptance", acceptance);
		return { acceptance };
	}

	queueMessage(input: {
		actor: AgentRecord;
		recipient: AgentRecord;
		dedupeKey: string;
		type: InboxMessage["type"];
		priority: InboxMessage["priority"];
		body: string;
		artifactRefs: string[];
		replyToMessageId?: string;
	}): string {
		if (Buffer.byteLength(input.body, "utf8") > 16_384) throw new RangeError("Agent message exceeds 16 KiB");
		if (input.actor.taskId !== input.recipient.taskId) throw new Error("Cross-task communication is forbidden");
		const allowed =
			(input.type === "steering" && input.actor.id === input.recipient.id) ||
			(input.actor.kind === "main" && input.recipient.parentAgentId === input.actor.id) ||
			(input.actor.kind === "subagent" && input.actor.parentAgentId === input.recipient.id);
		if (!allowed) throw new Error("Agent communication must follow the main-subagent relationship");
		const nextSeq = this.database
			.prepare(
				"SELECT COALESCE(MAX(sender_seq), 0) + 1 AS seq FROM agent_messages WHERE task_id = ? AND sender_agent_id = ? AND recipient_agent_id = ?",
			)
			.get(input.actor.taskId, input.actor.id, input.recipient.id) as { seq: number };
		const id = randomUUID();
		const now = this.now().toISOString();
		this.database
			.prepare(
				`INSERT INTO agent_messages (
				 id, task_id, sender_agent_id, recipient_agent_id, sender_seq, type, priority,
				 body_json, reply_to_message_id, dedupe_key, state, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
			)
			.run(
				id,
				input.actor.taskId,
				input.actor.id,
				input.recipient.id,
				nextSeq.seq,
				input.type,
				input.priority,
				JSON.stringify({ body: input.body, artifactRefs: input.artifactRefs }),
				input.replyToMessageId ?? null,
				input.dedupeKey,
				now,
			);
		if (input.priority === "high" && ["waiting_message", "waiting_external"].includes(input.recipient.state)) {
			this.database
				.prepare("UPDATE agents SET state = 'queued', updated_at = ? WHERE id = ?")
				.run(now, input.recipient.id);
		}
		this.appendEventInternal(
			input.actor.taskId,
			input.actor.id,
			undefined,
			"MessageQueued",
			{ messageId: id, recipientAgentId: input.recipient.id, schemaVersion: 1 },
			now,
		);
		return id;
	}

	listMessages(taskId: string, agentId?: string, limit = 200): InboxMessage[] {
		this.requireTask(taskId);
		const rows = (agentId
			? this.database
					.prepare(
						`SELECT * FROM agent_messages WHERE task_id = ? AND (sender_agent_id = ? OR recipient_agent_id = ?)
						 ORDER BY created_at, sender_agent_id, sender_seq LIMIT ?`,
					)
					.all(taskId, agentId, agentId, limit)
			: this.database
					.prepare(
						"SELECT * FROM agent_messages WHERE task_id = ? ORDER BY created_at, sender_agent_id, sender_seq LIMIT ?",
					)
					.all(taskId, limit)) as unknown as MessageRow[];
		return rows.map((row) => {
			const body = parseObject(row.body_json, "agent message body") as unknown as StoredMessageBody;
			if (typeof body.body !== "string" || !Array.isArray(body.artifactRefs))
				throw new Error("Corrupt agent message body JSON");
			return {
				id: row.id,
				taskId: row.task_id,
				senderAgentId: row.sender_agent_id,
				recipientAgentId: row.recipient_agent_id,
				senderSeq: row.sender_seq,
				type: row.type,
				priority: row.priority,
				body: body.body,
				artifactRefs: body.artifactRefs,
				...(row.reply_to_message_id === null ? {} : { replyToMessageId: row.reply_to_message_id }),
				createdAt: row.created_at,
			};
		});
	}

	recordAgentReport(
		agent: AgentRecord,
		status: "progress" | "completed" | "failed",
		messageId: string,
	): AgentRecord["state"] {
		const now = this.now().toISOString();
		const nextState = status === "completed" ? "completed" : status === "failed" ? "failed" : agent.state;
		if (status !== "progress") {
			this.database
				.prepare("UPDATE agents SET state = ?, updated_at = ?, completed_at = ? WHERE id = ?")
				.run(nextState, now, now, agent.id);
			this.database
				.prepare("UPDATE delegations SET state = ?, completed_at = ? WHERE child_agent_id = ?")
				.run(nextState, now, agent.id);
		}
		this.appendEventInternal(
			agent.taskId,
			agent.id,
			undefined,
			"AgentReported",
			{ messageId, status, schemaVersion: 1 },
			now,
		);
		if (status === "completed") {
			this.appendEventInternal(
				agent.taskId,
				agent.id,
				undefined,
				"AgentCompleted",
				{ messageId, schemaVersion: 1 },
				now,
			);
		}
		if (status === "failed") {
			this.appendEventInternal(
				agent.taskId,
				agent.id,
				undefined,
				"AgentFailed",
				{ messageId, schemaVersion: 1 },
				now,
			);
		}
		return nextState;
	}

	claimInbox(agentId: string, lease: AgentLease, limit: number): InboxMessage[] {
		return executeTransaction(this.database, () => {
			this.assertLeaseInternal(lease);
			if (lease.agentId !== agentId) throw new Error("Lease does not belong to inbox recipient");
			const rows = this.database
				.prepare(
					`SELECT * FROM agent_messages
					 WHERE recipient_agent_id = ? AND state IN ('queued', 'delivered')
					 ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END, sender_agent_id, sender_seq LIMIT ?`,
				)
				.all(agentId, limit) as unknown as MessageRow[];
			const now = this.now().toISOString();
			for (const row of rows) {
				this.database
					.prepare("UPDATE agent_messages SET state = 'delivered', delivered_at = ? WHERE id = ?")
					.run(now, row.id);
				this.appendEventInternal(
					row.task_id,
					agentId,
					undefined,
					"MessageDelivered",
					{ messageId: row.id, schemaVersion: 1 },
					now,
				);
			}
			return rows.map((row) => {
				const body = parseObject(row.body_json, "agent message body") as unknown as StoredMessageBody;
				if (typeof body.body !== "string" || !Array.isArray(body.artifactRefs))
					throw new Error("Corrupt agent message body JSON");
				return {
					id: row.id,
					taskId: row.task_id,
					senderAgentId: row.sender_agent_id,
					recipientAgentId: row.recipient_agent_id,
					senderSeq: row.sender_seq,
					type: row.type,
					priority: row.priority,
					body: body.body,
					artifactRefs: body.artifactRefs,
					...(row.reply_to_message_id === null ? {} : { replyToMessageId: row.reply_to_message_id }),
					createdAt: row.created_at,
				};
			});
		});
	}

	commitCheckpoint(input: AgentCheckpointCommit): void {
		assertSchema("sessionCheckpoint", input.sessionCheckpoint);
		assertSchema("progress", input.progress);
		assertSchema("evidence", input.evidence);
		executeTransaction(this.database, () => {
			this.assertLeaseInternal(input.lease);
			if (input.lease.agentId !== input.agentId || input.lease.taskId !== input.taskId)
				throw new Error("Checkpoint lease identity mismatch");
			const attempt = this.database
				.prepare("SELECT runtime_snapshot_sha256 FROM attempts WHERE id = ? AND agent_id = ?")
				.get(input.attemptId, input.agentId) as { runtime_snapshot_sha256: string } | undefined;
			if (!attempt) throw new Error(`Attempt not found for checkpoint: ${input.attemptId}`);
			if (attempt.runtime_snapshot_sha256 !== input.sessionCheckpoint.runtimeSnapshotSha256) {
				throw new Error("Checkpoint runtime snapshot does not match the Attempt");
			}
			const now = this.now().toISOString();
			const eventSeq = this.appendEventInternal(
				input.taskId,
				input.agentId,
				input.attemptId,
				"TurnSettled",
				{ schemaVersion: 1 },
				now,
			);
			const checkpointId = randomUUID();
			this.database
				.prepare(
					`INSERT INTO checkpoints (
					 id, task_id, agent_id, attempt_id, event_seq, session_checkpoint_json, progress_json,
					 evidence_json, workspace_snapshot_json, runtime_snapshot_sha256, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					checkpointId,
					input.taskId,
					input.agentId,
					input.attemptId,
					eventSeq,
					JSON.stringify(input.sessionCheckpoint),
					JSON.stringify(input.progress),
					JSON.stringify(input.evidence),
					JSON.stringify(input.workspaceSnapshot),
					input.sessionCheckpoint.runtimeSnapshotSha256,
					now,
				);
			for (const messageId of input.progress.consumedMessageIds) {
				const result = this.database
					.prepare(
						"UPDATE agent_messages SET state = 'acknowledged', acknowledged_at = ? WHERE id = ? AND recipient_agent_id = ? AND state = 'delivered'",
					)
					.run(now, messageId, input.agentId);
				if (Number(result.changes) !== 1) throw new Error(`Cannot acknowledge undelivered message ${messageId}`);
				this.appendEventInternal(
					input.taskId,
					input.agentId,
					input.attemptId,
					"MessageAcknowledged",
					{ messageId, schemaVersion: 1 },
					now,
				);
			}
			this.appendEventInternal(
				input.taskId,
				input.agentId,
				input.attemptId,
				"CheckpointCreated",
				{ checkpointId, eventSeq, schemaVersion: 1 },
				now,
			);
		});
	}

	private assertCompletionReady(taskId: string): void {
		const task = this.requireTask(taskId);
		for (const criterion of task.acceptance) {
			const passed = this.database
				.prepare(
					`SELECT id FROM task_events WHERE task_id = ? AND type = 'AcceptancePassed'
					 AND json_extract(payload_json, '$.criterionId') = ? ORDER BY seq DESC LIMIT 1`,
				)
				.get(taskId, criterion.id);
			if (!passed) throw new Error(`Acceptance criterion has not passed: ${criterion.id}`);
		}
		const requiredIncomplete = this.database
			.prepare(
				"SELECT COUNT(*) AS count FROM delegations WHERE task_id = ? AND required = 1 AND state <> 'completed'",
			)
			.get(taskId) as { count: number };
		if (requiredIncomplete.count > 0) throw new Error("Required delegations are not complete");
		const unknownTools = this.database
			.prepare(
				`SELECT COUNT(*) AS count FROM task_events started
				 WHERE started.task_id = ? AND started.type = 'ToolStarted'
				 AND NOT EXISTS (
				  SELECT 1 FROM task_events finished WHERE finished.task_id = started.task_id
				  AND finished.type = 'ToolFinished'
				  AND json_extract(finished.payload_json, '$.toolCallId') = json_extract(started.payload_json, '$.toolCallId')
				 )`,
			)
			.get(taskId) as { count: number };
		if (unknownTools.count > 0) throw new Error("Task has tools with unknown outcomes");
		const checkpoint = this.database
			.prepare("SELECT id FROM checkpoints WHERE task_id = ? ORDER BY event_seq DESC LIMIT 1")
			.get(taskId);
		if (!checkpoint) throw new Error("Task completion requires a checkpoint");
	}

	private assertLeaseInternal(lease: AgentLease): void {
		const row = this.database.prepare("SELECT * FROM leases WHERE agent_id = ?").get(lease.agentId) as
			| LeaseRow
			| undefined;
		if (
			!row ||
			row.revoked_at !== null ||
			row.task_id !== lease.taskId ||
			row.worker_id !== lease.workerId ||
			row.execution_id !== lease.executionId ||
			row.fencing_token !== lease.fencingToken ||
			Date.parse(row.expires_at) <= this.now().getTime()
		) {
			throw new Error(`Lease lost for agent ${lease.agentId}`);
		}
	}

	private listUnfinishedToolsInternal(taskId: string, agentId: string): UnfinishedToolExecution[] {
		const rows = this.database
			.prepare(
				`SELECT started.payload_json FROM task_events started
				 WHERE started.task_id = ? AND started.agent_id = ? AND started.type = 'ToolStarted'
				 AND NOT EXISTS (
				  SELECT 1 FROM task_events finished WHERE finished.task_id = started.task_id
				  AND finished.type = 'ToolFinished'
				  AND json_extract(finished.payload_json, '$.toolCallId') = json_extract(started.payload_json, '$.toolCallId')
				 ) ORDER BY started.seq`,
			)
			.all(taskId, agentId) as unknown as Array<{ payload_json: string }>;
		return rows.map(({ payload_json }) => {
			const payload = parseObject(payload_json, "ToolStarted payload");
			const effect = payload.effect;
			if (
				typeof payload.toolCallId !== "string" ||
				typeof payload.toolName !== "string" ||
				!(["read_only", "reconcilable_write", "process", "external_side_effect"] as unknown[]).includes(effect)
			) {
				throw new Error("Corrupt ToolStarted event payload");
			}
			return {
				toolCallId: payload.toolCallId,
				toolName: payload.toolName,
				effect: effect as UnfinishedToolExecution["effect"],
				...(typeof payload.executionId === "string" ? { executionId: payload.executionId } : {}),
				...(typeof payload.fencingToken === "number" ? { fencingToken: payload.fencingToken } : {}),
			};
		});
	}

	private appendEventInternal(
		taskId: string,
		agentId: string | undefined,
		attemptId: string | undefined,
		type: string,
		payload: Record<string, unknown>,
		createdAt: string,
	): number {
		const seqRow = this.database
			.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM task_events WHERE task_id = ?")
			.get(taskId) as {
			seq: number;
		};
		this.database
			.prepare(
				"INSERT INTO task_events(id, task_id, agent_id, attempt_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				randomUUID(),
				taskId,
				agentId ?? null,
				attemptId ?? null,
				seqRow.seq,
				type,
				JSON.stringify(payload),
				createdAt,
			);
		return seqRow.seq;
	}
}

export function createInMemoryTaskStore(now?: () => Date): SqliteTaskStore {
	return SqliteTaskStore.open({ databasePath: ":memory:", now });
}

export function normalizeSqliteValue(value: unknown): SQLInputValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "bigint" ||
		value instanceof Uint8Array
	) {
		return value;
	}
	throw new TypeError("Unsupported SQLite value");
}
