import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
	type AcceptanceCriterion,
	type AgentCheckpointCommit,
	type AgentLease,
	type AgentRecord,
	type AttemptClaimContext,
	type AttemptRecord,
	assertSchema,
	type BeginTaskCommandInput,
	type Budget,
	type CheckpointRecord,
	type ClaimedAttempt,
	type CompleteTaskAuthorizationSourceInput,
	type ContinuationDecision,
	type CoordinationResult,
	type CreatePermissionGrantInput,
	type CreateTaskInput,
	type DaemonCommandRecord,
	type InboxMessage,
	type PermissionGrantRecord,
	type PermissionGrantState,
	type PermissionScope,
	type ReceiveDaemonCommandInput,
	type RuntimeSnapshot,
	type ScheduleClaim,
	type ScheduleEventTrigger,
	type ScheduleRecord,
	type StaleExecution,
	type TaskAuthorizationCandidate,
	type TaskAuthorizationEvidenceSpan,
	type TaskAuthorizationRecord,
	type TaskAuthorizationSourceRecord,
	type TaskCommandRecord,
	type TaskEvent,
	type TaskNotification,
	type TaskNotificationKind,
	type TaskRecord,
	type TaskState,
	type ToolPolicy,
	type UnfinishedProviderRequest,
	type UnfinishedToolExecution,
	type WorkspaceSnapshot,
} from "./types.ts";

type DatabaseSync = DatabaseSyncType;

const originalEmitWarning = process.emitWarning;
let DatabaseSync: typeof DatabaseSyncType;
try {
	// Node 22-24 labels the built-in SQLite API experimental even though Ever
	// deliberately owns and tests this dependency. Suppress only its synchronous
	// module-load notice so the public TUI starts with product state, not runtime noise.
	process.emitWarning = (() => {}) as typeof process.emitWarning;
	const sqliteModule = createRequire(import.meta.url)(process.versions.bun ? "bun:sqlite" : "node:sqlite") as {
		Database?: typeof DatabaseSyncType;
		DatabaseSync?: typeof DatabaseSyncType;
	};
	DatabaseSync = process.versions.bun ? sqliteModule.Database! : sqliteModule.DatabaseSync!;
} finally {
	process.emitWarning = originalEmitWarning;
}

const CURRENT_SCHEMA_VERSION = 8;

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

interface DaemonCommandRow {
	client_id: string;
	command_id: string;
	command_type: string;
	payload_sha256: string;
	payload_json: string;
	state: DaemonCommandRecord["state"];
	result_json: string | null;
	error: string | null;
	received_at: string;
	dispatched_at: string | null;
	completed_at: string | null;
	acknowledged_at: string | null;
}

interface TaskCommandRow {
	client_id: string;
	command_id: string;
	task_id: string;
	command_type: string;
	payload_sha256: string;
	payload_json: string;
	state: "dispatched" | "completed";
	result_json: string | null;
	dispatched_at: string;
	completed_at: string | null;
}

interface ContinuationDecisionRow {
	id: string;
	task_id: string;
	agent_id: string;
	attempt_id: string;
	settled_turn_index: number;
	action: ContinuationDecision["action"];
	reason_code: string;
	reason: string;
	progress_fingerprint: string;
	next_prompt: string | null;
	next_wake_at: string | null;
	created_at: string;
}

interface ScheduleRow {
	id: string;
	task_id: string;
	agent_id: string | null;
	kind: ScheduleRecord["kind"];
	expression: string;
	timezone: string;
	payload_json: string;
	state: ScheduleRecord["state"];
	next_run_at: string | null;
	last_claim_id: string | null;
	last_claimed_at: string | null;
	last_delivered_at: string | null;
	last_event_seq: number;
	created_at: string;
	updated_at: string;
}

interface PermissionGrantRow {
	id: string;
	source: PermissionGrantRecord["source"];
	lifetime: PermissionGrantRecord["lifetime"];
	scope_json: string;
	task_id: string;
	attempt_id: string | null;
	workspace_fingerprint: string;
	sandbox_profile_sha256: string;
	state: PermissionGrantState;
	remaining_uses: number | null;
	created_at: string;
	expires_at: string | null;
	revoked_at: string | null;
}

interface TaskAuthorizationSourceRow {
	id: string;
	task_id: string;
	source_kind: TaskAuthorizationSourceRecord["kind"];
	source_message_sha256: string;
	source_text: string;
	state: TaskAuthorizationSourceRecord["state"];
	created_at: string;
	compiled_at: string | null;
	error_code: string | null;
}

interface TaskAuthorizationRow {
	id: string;
	task_id: string;
	source_message_id: string;
	source_message_sha256: string;
	action: TaskAuthorizationRecord["action"];
	targets_json: string;
	limits_json: string;
	lifetime: TaskAuthorizationRecord["lifetime"];
	max_uses: number;
	used_count: number;
	confidence: number;
	compiler_provider: string;
	compiler_model: string;
	compiler_prompt_sha256: string;
	evidence_spans_json: string;
	git_head: string | null;
	change_set_sha256: string | null;
	revision: number;
	state: TaskAuthorizationRecord["state"];
	created_at: string;
	consumed_at: string | null;
	revoked_at: string | null;
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

function daemonCommandFromRow(row: DaemonCommandRow): DaemonCommandRecord {
	return {
		clientId: row.client_id,
		commandId: row.command_id,
		commandType: row.command_type,
		payloadSha256: row.payload_sha256,
		payload: parseObject(row.payload_json, "daemon command payload"),
		state: row.state,
		...(row.result_json === null ? {} : { result: parseObject(row.result_json, "daemon command result") }),
		...(row.error === null ? {} : { error: row.error }),
		receivedAt: row.received_at,
		...(row.dispatched_at === null ? {} : { dispatchedAt: row.dispatched_at }),
		...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
		...(row.acknowledged_at === null ? {} : { acknowledgedAt: row.acknowledged_at }),
	};
}

function taskCommandFromRow(row: TaskCommandRow): TaskCommandRecord {
	return {
		clientId: row.client_id,
		commandId: row.command_id,
		taskId: row.task_id,
		commandType: row.command_type,
		payloadSha256: row.payload_sha256,
		payload: parseObject(row.payload_json, "task command payload"),
		state: row.state,
		...(row.result_json === null ? {} : { result: parseObject(row.result_json, "task command result") }),
		dispatchedAt: row.dispatched_at,
		...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
	};
}

function continuationDecisionFromRow(row: ContinuationDecisionRow): ContinuationDecision {
	return {
		id: row.id,
		taskId: row.task_id,
		agentId: row.agent_id,
		attemptId: row.attempt_id,
		settledTurnIndex: row.settled_turn_index,
		action: row.action,
		reasonCode: row.reason_code,
		reason: row.reason,
		progressFingerprint: row.progress_fingerprint,
		...(row.next_prompt === null ? {} : { nextPrompt: row.next_prompt }),
		...(row.next_wake_at === null ? {} : { nextWakeAt: row.next_wake_at }),
		createdAt: row.created_at,
	};
}

function scheduleFromRow(row: ScheduleRow): ScheduleRecord {
	return {
		id: row.id,
		taskId: row.task_id,
		...(row.agent_id === null ? {} : { agentId: row.agent_id }),
		kind: row.kind,
		expression: row.expression,
		timezone: row.timezone,
		payload: parseObject(row.payload_json, "schedule payload"),
		state: row.state,
		...(row.next_run_at === null ? {} : { nextRunAt: row.next_run_at }),
		...(row.last_claim_id === null ? {} : { lastClaimId: row.last_claim_id }),
		...(row.last_claimed_at === null ? {} : { lastClaimedAt: row.last_claimed_at }),
		...(row.last_delivered_at === null ? {} : { lastDeliveredAt: row.last_delivered_at }),
		lastEventSeq: row.last_event_seq,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function permissionGrantFromRow(row: PermissionGrantRow): PermissionGrantRecord {
	const scope = parseObject(row.scope_json, "permission grant scope") as unknown as PermissionScope;
	return {
		id: row.id,
		source: row.source,
		lifetime: row.lifetime,
		scope,
		taskId: row.task_id,
		...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
		workspaceFingerprint: row.workspace_fingerprint,
		sandboxProfileSha256: row.sandbox_profile_sha256,
		state: row.state,
		...(row.remaining_uses === null ? {} : { remainingUses: row.remaining_uses }),
		createdAt: row.created_at,
		...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
		...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
	};
}

function taskAuthorizationSourceFromRow(row: TaskAuthorizationSourceRow): TaskAuthorizationSourceRecord {
	return {
		id: row.id,
		taskId: row.task_id,
		kind: row.source_kind,
		textSha256: row.source_message_sha256,
		text: row.source_text,
		state: row.state,
		createdAt: row.created_at,
		...(row.compiled_at === null ? {} : { compiledAt: row.compiled_at }),
		...(row.error_code === null ? {} : { errorCode: row.error_code }),
	};
}

function taskAuthorizationFromRow(row: TaskAuthorizationRow): TaskAuthorizationRecord {
	return {
		id: row.id,
		taskId: row.task_id,
		sourceMessageId: row.source_message_id,
		sourceMessageSha256: row.source_message_sha256,
		source: "user",
		action: row.action,
		targets: parseObject(row.targets_json, "Task Authorization targets"),
		limits: parseObject(row.limits_json, "Task Authorization limits"),
		lifetime: row.lifetime,
		maxUses: row.max_uses,
		usedCount: row.used_count,
		confidence: row.confidence,
		compilerProvider: row.compiler_provider,
		compilerModel: row.compiler_model,
		compilerPromptSha256: row.compiler_prompt_sha256,
		...(row.git_head === null ? {} : { gitHead: row.git_head }),
		...(row.change_set_sha256 === null ? {} : { changeSetSha256: row.change_set_sha256 }),
		evidenceSpans: parseArray<TaskAuthorizationEvidenceSpan>(
			row.evidence_spans_json,
			"Task Authorization evidence spans",
		),
		revision: row.revision,
		state: row.state,
		createdAt: row.created_at,
		...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
		...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
	};
}

function validateAuthorizationCandidate(candidate: TaskAuthorizationCandidate, sourceText: string): void {
	const sourceBytes = Buffer.from(sourceText, "utf8");
	if (!Number.isSafeInteger(candidate.maxUses) || candidate.maxUses < 1 || candidate.maxUses > 10)
		throw new TypeError("Task Authorization maxUses must be 1..10");
	if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0.95 || candidate.confidence > 1)
		throw new TypeError("Task Authorization confidence is below the activation threshold");
	if (candidate.lifetime !== "task") throw new TypeError("Unsupported Task Authorization lifetime");
	if (candidate.evidenceSpans.length === 0) throw new TypeError("Task Authorization requires an evidence span");
	for (const span of candidate.evidenceSpans) {
		if (
			!Number.isSafeInteger(span.startByte) ||
			!Number.isSafeInteger(span.endByte) ||
			span.startByte < 0 ||
			span.endByte <= span.startByte ||
			span.endByte > sourceBytes.length
		)
			throw new TypeError("Invalid Task Authorization evidence span");
		const evidenceBytes = sourceBytes.subarray(span.startByte, span.endByte);
		if (!Buffer.from(evidenceBytes.toString("utf8"), "utf8").equals(evidenceBytes))
			throw new TypeError("Task Authorization evidence span splits a UTF-8 code point");
	}
}

function validatePermissionScope(scope: PermissionScope): void {
	const arrays = [
		scope.toolNames,
		scope.effects,
		scope.pathPrefixes,
		scope.commandFingerprints,
		scope.networkDomains,
		scope.credentialScopes,
	];
	if (arrays.some((values) => !Array.isArray(values) || !values.every((value) => typeof value === "string")))
		throw new TypeError("Invalid permission grant scope");
	if (scope.toolNames.length === 0 || scope.effects.length === 0)
		throw new TypeError("Permission grant scope requires a tool and effect");
	if (scope.pathPrefixes.some((path) => !isAbsolute(path)))
		throw new TypeError("Permission grant path prefixes must be absolute");
	if (scope.commandFingerprints.some((value) => !/^[a-f0-9]{64}$/.test(value)))
		throw new TypeError("Invalid permission grant command fingerprint");
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
	const names = {
		1: "long_tasks",
		2: "multi_agent",
		3: "notifications",
		4: "control_plane",
		5: "verified_completion",
		6: "task_commands",
		7: "permissions",
		8: "task_authorizations",
	} as const;
	const filename = `00${version}_${names[version as keyof typeof names]}.sql`;
	const migrationPath = import.meta.url.includes("$bunfs")
		? resolve(dirname(process.execPath), "migrations", filename)
		: fileURLToPath(new URL(`./migrations/${filename}`, import.meta.url));
	return readFileSync(migrationPath, "utf8");
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

	registerTaskAuthorizationSource(input: {
		taskId: string;
		sourceMessageId: string;
		kind: TaskAuthorizationSourceRecord["kind"];
		text: string;
	}): TaskAuthorizationSourceRecord {
		return executeTransaction(this.database, () =>
			this.registerTaskAuthorizationSourceInternal(
				input.taskId,
				input.sourceMessageId,
				input.kind,
				input.text,
				this.now().toISOString(),
			),
		);
	}

	listPendingTaskAuthorizationSources(taskId: string, limit = 32): TaskAuthorizationSourceRecord[] {
		this.requireTask(taskId);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
			throw new RangeError("Task Authorization source limit must be 1..1000");
		return (
			this.database
				.prepare(
					"SELECT * FROM task_authorization_sources WHERE task_id = ? AND state = 'pending' ORDER BY created_at, id LIMIT ?",
				)
				.all(taskId, limit) as unknown as TaskAuthorizationSourceRow[]
		).map(taskAuthorizationSourceFromRow);
	}

	completeTaskAuthorizationSource(input: CompleteTaskAuthorizationSourceInput): TaskAuthorizationRecord[] {
		if (
			input.compilerProvider.trim() === "" ||
			input.compilerModel.trim() === "" ||
			!/^[a-f0-9]{64}$/.test(input.compilerPromptSha256)
		)
			throw new TypeError("Invalid Authorization Compiler identity");
		if (input.candidates.length > 16) throw new RangeError("Authorization Compiler returned too many candidates");
		return executeTransaction(this.database, () => {
			const source = this.requireTaskAuthorizationSource(input.sourceId);
			if (source.state !== "pending") throw new Error(`Task Authorization source is ${source.state}`);
			for (const candidate of input.candidates) validateAuthorizationCandidate(candidate, source.text);
			const now = this.now().toISOString();
			this.database
				.prepare("UPDATE task_authorization_state SET revision = revision + 1 WHERE task_id = ?")
				.run(source.taskId);
			const state = this.database
				.prepare("SELECT revision FROM task_authorization_state WHERE task_id = ?")
				.get(source.taskId) as { revision: number } | undefined;
			if (!state) throw new Error(`Task Authorization state not found: ${source.taskId}`);
			const authorizations: TaskAuthorizationRecord[] = [];
			for (const candidate of input.candidates) {
				const id = randomUUID();
				this.database
					.prepare(
						`INSERT INTO task_authorizations
						 (id, task_id, source_message_id, source_message_sha256, action, targets_json, limits_json,
						  lifetime, max_uses, confidence, compiler_provider, compiler_model, compiler_prompt_sha256,
						  evidence_spans_json, git_head, change_set_sha256, revision, state, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
					)
					.run(
						id,
						source.taskId,
						source.id,
						source.textSha256,
						candidate.action,
						JSON.stringify(candidate.targets),
						JSON.stringify(candidate.limits),
						candidate.lifetime,
						candidate.maxUses,
						candidate.confidence,
						input.compilerProvider,
						input.compilerModel,
						input.compilerPromptSha256,
						JSON.stringify(candidate.evidenceSpans),
						input.gitHead ?? null,
						input.changeSetSha256 ?? null,
						state.revision,
						now,
					);
				this.appendEventInternal(
					source.taskId,
					undefined,
					undefined,
					"TaskAuthorizationGranted",
					{
						authorizationId: id,
						sourceMessageId: source.id,
						action: candidate.action,
						revision: state.revision,
						schemaVersion: 1,
					},
					now,
				);
				authorizations.push(this.requireTaskAuthorization(id));
			}
			this.database
				.prepare(
					"UPDATE task_authorization_sources SET state = 'compiled', compiled_at = ?, error_code = NULL WHERE id = ?",
				)
				.run(now, source.id);
			this.appendEventInternal(
				source.taskId,
				undefined,
				undefined,
				"AuthorizationCompiled",
				{
					sourceMessageId: source.id,
					inputSha256: source.textSha256,
					outputSha256: createHash("sha256").update(JSON.stringify(input.candidates)).digest("hex"),
					compilerProvider: input.compilerProvider,
					compilerModel: input.compilerModel,
					compilerPromptSha256: input.compilerPromptSha256,
					candidateCount: authorizations.length,
					revision: state.revision,
					schemaVersion: 1,
				},
				now,
			);
			return authorizations;
		});
	}

	failTaskAuthorizationSource(sourceId: string, errorCode: string): TaskAuthorizationSourceRecord {
		if (errorCode.trim() === "") throw new TypeError("Authorization Compiler error code is required");
		return executeTransaction(this.database, () => {
			const source = this.requireTaskAuthorizationSource(sourceId);
			if (source.state !== "pending") return source;
			const now = this.now().toISOString();
			this.database
				.prepare(
					"UPDATE task_authorization_sources SET state = 'failed', compiled_at = ?, error_code = ? WHERE id = ? AND state = 'pending'",
				)
				.run(now, errorCode.slice(0, 200), sourceId);
			this.appendEventInternal(
				source.taskId,
				undefined,
				undefined,
				"AuthorizationCompileFailed",
				{ sourceMessageId: source.id, errorCode: errorCode.slice(0, 200), schemaVersion: 1 },
				now,
			);
			return this.requireTaskAuthorizationSource(sourceId);
		});
	}

	listTaskAuthorizations(taskId: string): TaskAuthorizationRecord[] {
		this.requireTask(taskId);
		return (
			this.database
				.prepare("SELECT * FROM task_authorizations WHERE task_id = ? ORDER BY created_at, id")
				.all(taskId) as unknown as TaskAuthorizationRow[]
		).map(taskAuthorizationFromRow);
	}

	listActiveTaskAuthorizations(taskId: string): TaskAuthorizationRecord[] {
		return this.listTaskAuthorizations(taskId).filter(
			(authorization) => authorization.state === "active" && authorization.usedCount < authorization.maxUses,
		);
	}

	getTaskAuthorizationRevision(taskId: string): number {
		this.requireTask(taskId);
		const state = this.database
			.prepare("SELECT revision FROM task_authorization_state WHERE task_id = ?")
			.get(taskId) as { revision: number } | undefined;
		if (!state) throw new Error(`Task Authorization state not found: ${taskId}`);
		return state.revision;
	}

	getReviewerCostSummary(taskId: string): {
		compilerCostUsd: number;
		judgeCostUsd: number;
		reviewerReservedUsd: number;
		compilerRequestCount: number;
		reviewerRequestCount: number;
	} {
		this.requireTask(taskId);
		const state = this.database
			.prepare(
				`SELECT compiler_cost_usd, judge_cost_usd, reviewer_reserved_usd,
				        compiler_request_count, reviewer_request_count
				 FROM task_authorization_state WHERE task_id = ?`,
			)
			.get(taskId) as
			| {
					compiler_cost_usd: number;
					judge_cost_usd: number;
					reviewer_reserved_usd: number;
					compiler_request_count: number;
					reviewer_request_count: number;
			  }
			| undefined;
		if (!state) throw new Error(`Task Authorization state not found: ${taskId}`);
		return {
			compilerCostUsd: state.compiler_cost_usd,
			judgeCostUsd: state.judge_cost_usd,
			reviewerReservedUsd: state.reviewer_reserved_usd,
			compilerRequestCount: state.compiler_request_count,
			reviewerRequestCount: state.reviewer_request_count,
		};
	}

	revokeTaskAuthorization(authorizationId: string): TaskAuthorizationRecord {
		return executeTransaction(this.database, () => {
			const authorization = this.requireTaskAuthorization(authorizationId);
			if (authorization.state !== "active") return authorization;
			const now = this.now().toISOString();
			this.database
				.prepare(
					"UPDATE task_authorizations SET state = 'revoked', revoked_at = ? WHERE id = ? AND state = 'active'",
				)
				.run(now, authorizationId);
			this.database
				.prepare("UPDATE task_authorization_state SET revision = revision + 1 WHERE task_id = ?")
				.run(authorization.taskId);
			this.appendEventInternal(
				authorization.taskId,
				undefined,
				undefined,
				"TaskAuthorizationRevoked",
				{ authorizationId, schemaVersion: 1 },
				now,
			);
			return this.requireTaskAuthorization(authorizationId);
		});
	}

	queueUserSteering(input: { taskId: string; agentId: string; dedupeKey: string; body: string }): string {
		if (Buffer.byteLength(input.body, "utf8") > 16_384) throw new RangeError("User steering exceeds 16 KiB");
		if (input.body.trim() === "" || input.dedupeKey.trim() === "")
			throw new TypeError("User steering body and dedupe key are required");
		return executeTransaction(this.database, () => {
			const agent = this.requireAgent(input.agentId);
			if (agent.taskId !== input.taskId) throw new Error("User steering Agent does not belong to Task");
			const existing = this.database
				.prepare(
					"SELECT id, body_json FROM agent_messages WHERE task_id = ? AND sender_agent_id = ? AND dedupe_key = ?",
				)
				.get(input.taskId, input.agentId, input.dedupeKey) as { id: string; body_json: string } | undefined;
			if (existing) {
				const body = parseObject(existing.body_json, "user steering body") as unknown as StoredMessageBody;
				if (body.body !== input.body) throw new Error(`User steering identity conflict: ${input.dedupeKey}`);
				return existing.id;
			}
			const nextSeq = this.database
				.prepare(
					"SELECT COALESCE(MAX(sender_seq), 0) + 1 AS seq FROM agent_messages WHERE task_id = ? AND sender_agent_id = ? AND recipient_agent_id = ?",
				)
				.get(input.taskId, input.agentId, input.agentId) as { seq: number };
			const id = randomUUID();
			const now = this.now().toISOString();
			this.database
				.prepare(
					`INSERT INTO agent_messages
					 (id, task_id, sender_agent_id, recipient_agent_id, sender_seq, type, priority, body_json,
					  dedupe_key, state, provenance, created_at)
					 VALUES (?, ?, ?, ?, ?, 'steering', 'high', ?, ?, 'queued', 'user', ?)`,
				)
				.run(
					id,
					input.taskId,
					input.agentId,
					input.agentId,
					nextSeq.seq,
					JSON.stringify({ body: input.body, artifactRefs: [] }),
					input.dedupeKey,
					now,
				);
			this.registerTaskAuthorizationSourceInternal(input.taskId, id, "steering", input.body, now);
			this.appendEventInternal(
				input.taskId,
				input.agentId,
				undefined,
				"MessageQueued",
				{ messageId: id, recipientAgentId: input.agentId, provenance: "user", schemaVersion: 1 },
				now,
			);
			return id;
		});
	}

	createPermissionGrant(input: CreatePermissionGrantInput): PermissionGrantRecord {
		const task = this.requireTask(input.taskId);
		validatePermissionScope(input.scope);
		if (task.workspaceFingerprint !== input.workspaceFingerprint)
			throw new Error("Permission grant workspace identity does not match the Task");
		if (!/^[a-f0-9]{64}$/.test(input.sandboxProfileSha256))
			throw new TypeError("Invalid permission grant sandbox profile hash");
		if (input.expiresAt !== undefined && !Number.isFinite(Date.parse(input.expiresAt)))
			throw new TypeError("Invalid permission grant expiration");
		if (input.source === "reviewer_once" && input.lifetime !== "once")
			throw new Error("Risk reviewer grants must be single-use");
		if (["once", "attempt"].includes(input.lifetime)) {
			if (!input.attemptId) throw new Error(`${input.lifetime} permission grants require an Attempt`);
			const attempt = this.getAttempt(input.attemptId);
			if (!attempt || attempt.taskId !== input.taskId)
				throw new Error("Permission grant Attempt does not belong to the Task");
		} else if (input.attemptId !== undefined) {
			throw new Error(`${input.lifetime} permission grants cannot be bound to an Attempt`);
		}
		const id = randomUUID();
		const now = this.now().toISOString();
		executeTransaction(this.database, () => {
			this.database
				.prepare(
					`INSERT INTO permission_grants
					 (id, source, lifetime, scope_json, task_id, attempt_id, workspace_fingerprint,
					  sandbox_profile_sha256, state, remaining_uses, created_at, expires_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
				)
				.run(
					id,
					input.source,
					input.lifetime,
					JSON.stringify(input.scope),
					input.taskId,
					input.attemptId ?? null,
					input.workspaceFingerprint,
					input.sandboxProfileSha256,
					input.lifetime === "once" ? 1 : null,
					now,
					input.expiresAt ?? null,
				);
			this.appendEventInternal(
				input.taskId,
				undefined,
				input.attemptId,
				"PermissionGrantCreated",
				{ grantId: id, source: input.source, lifetime: input.lifetime, schemaVersion: 1 },
				now,
			);
		});
		return this.requirePermissionGrant(id);
	}

	listPermissionGrants(taskId?: string): PermissionGrantRecord[] {
		this.expirePermissionGrants();
		const rows = (taskId
			? this.database.prepare("SELECT * FROM permission_grants WHERE task_id = ? ORDER BY created_at").all(taskId)
			: this.database
					.prepare("SELECT * FROM permission_grants ORDER BY created_at")
					.all()) as unknown as PermissionGrantRow[];
		return rows.map(permissionGrantFromRow);
	}

	listActivePermissionGrants(input: {
		taskId: string;
		attemptId: string;
		workspaceFingerprint: string;
		sandboxProfileSha256: string;
	}): PermissionGrantRecord[] {
		this.expirePermissionGrants();
		return (
			this.database
				.prepare(
					`SELECT * FROM permission_grants
					 WHERE state = 'active' AND workspace_fingerprint = ? AND sandbox_profile_sha256 = ?
					 AND (lifetime IN ('workspace', 'project_policy') OR task_id = ?)
					 AND (attempt_id IS NULL OR attempt_id = ?)
					 ORDER BY created_at`,
				)
				.all(
					input.workspaceFingerprint,
					input.sandboxProfileSha256,
					input.taskId,
					input.attemptId,
				) as unknown as PermissionGrantRow[]
		).map(permissionGrantFromRow);
	}

	consumePermissionGrant(input: {
		grantId: string;
		taskId: string;
		attemptId: string;
		operationId: string;
		intentSha256: string;
	}): PermissionGrantRecord {
		return executeTransaction(this.database, () => {
			const grant = this.requirePermissionGrant(input.grantId);
			if (grant.state !== "active") throw new Error(`Permission grant is ${grant.state}`);
			if (grant.lifetime !== "workspace" && grant.lifetime !== "project_policy" && grant.taskId !== input.taskId)
				throw new Error("Permission grant does not belong to this Task");
			if (grant.attemptId !== undefined && grant.attemptId !== input.attemptId)
				throw new Error("Permission grant does not belong to this Attempt");
			const now = this.now().toISOString();
			if (grant.remainingUses !== undefined) {
				if (grant.remainingUses < 1) throw new Error("Permission grant has no remaining uses");
				this.database
					.prepare(
						`UPDATE permission_grants SET remaining_uses = remaining_uses - 1,
						 state = CASE WHEN remaining_uses = 1 THEN 'consumed' ELSE state END WHERE id = ? AND state = 'active'`,
					)
					.run(grant.id);
			}
			this.appendEventInternal(
				input.taskId,
				undefined,
				input.attemptId,
				"PermissionGrantUsed",
				{
					grantId: grant.id,
					operationId: input.operationId,
					intentSha256: input.intentSha256,
					schemaVersion: 1,
				},
				now,
			);
			return this.requirePermissionGrant(grant.id);
		});
	}

	revokePermissionGrant(grantId: string): PermissionGrantRecord {
		return executeTransaction(this.database, () => {
			const grant = this.requirePermissionGrant(grantId);
			if (grant.state === "revoked") return grant;
			if (grant.state !== "active") throw new Error(`Permission grant cannot be revoked from ${grant.state}`);
			const now = this.now().toISOString();
			this.database
				.prepare("UPDATE permission_grants SET state = 'revoked', revoked_at = ? WHERE id = ?")
				.run(now, grant.id);
			this.appendEventInternal(
				grant.taskId,
				undefined,
				grant.attemptId,
				"PermissionGrantRevoked",
				{ grantId: grant.id, schemaVersion: 1 },
				now,
			);
			return this.requirePermissionGrant(grant.id);
		});
	}

	hasAttemptPermissionDenial(attemptId: string, intentSha256: string): boolean {
		return Boolean(
			this.database
				.prepare(
					`SELECT id FROM permission_decisions
					 WHERE attempt_id = ? AND intent_sha256 = ? AND action = 'deny' AND source = 'user' LIMIT 1`,
				)
				.get(attemptId, intentSha256),
		);
	}

	recordRiskReview(input: {
		taskId: string;
		attemptId?: string;
		intentSha256: string;
		modelProvider: string;
		modelId: string;
		promptSha256: string;
		inputSha256: string;
		outputSha256: string;
		verdict: "allow_once" | "ask" | "deny";
		risk: "low" | "medium" | "high";
		confidence: number;
	}): string {
		this.requireTask(input.taskId);
		if (input.attemptId !== undefined && this.getAttempt(input.attemptId)?.taskId !== input.taskId)
			throw new Error("Risk Review Attempt does not belong to the Task");
		for (const hash of [input.intentSha256, input.promptSha256, input.inputSha256, input.outputSha256]) {
			if (!/^[a-f0-9]{64}$/.test(hash)) throw new TypeError("Invalid Risk Review hash");
		}
		if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
			throw new TypeError("Invalid Risk Review confidence");
		const id = randomUUID();
		const now = this.now().toISOString();
		executeTransaction(this.database, () => {
			this.database
				.prepare(
					`INSERT INTO risk_reviews
					 (id, task_id, attempt_id, intent_sha256, model_provider, model_id, prompt_sha256,
					  input_sha256, output_sha256, verdict, risk, confidence, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					input.taskId,
					input.attemptId ?? null,
					input.intentSha256,
					input.modelProvider,
					input.modelId,
					input.promptSha256,
					input.inputSha256,
					input.outputSha256,
					input.verdict,
					input.risk,
					input.confidence,
					now,
				);
			this.appendEventInternal(
				input.taskId,
				undefined,
				input.attemptId,
				"RiskReviewRecorded",
				{
					reviewId: id,
					intentSha256: input.intentSha256,
					verdict: input.verdict,
					risk: input.risk,
					schemaVersion: 1,
				},
				now,
			);
		});
		return id;
	}

	recordPermissionDecision(input: {
		taskId: string;
		attemptId?: string;
		operationId: string;
		intentSha256: string;
		action: "allow" | "ask" | "deny";
		source: "policy" | "grant" | "reviewer" | "user" | "user_authorization";
		grantId?: string;
		authorizationId?: string;
		reasonCode?: string;
	}): string {
		this.requireTask(input.taskId);
		if (input.attemptId !== undefined && this.getAttempt(input.attemptId)?.taskId !== input.taskId)
			throw new Error("Permission decision Attempt does not belong to the Task");
		const id = randomUUID();
		const now = this.now().toISOString();
		executeTransaction(this.database, () => {
			this.database
				.prepare(
					`INSERT INTO permission_decisions
					 (id, operation_id, task_id, attempt_id, intent_sha256, action, source, grant_id,
					  authorization_id, reason_code, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					input.operationId,
					input.taskId,
					input.attemptId ?? null,
					input.intentSha256,
					input.action,
					input.source,
					input.grantId ?? null,
					input.authorizationId ?? null,
					input.reasonCode ?? null,
					now,
				);
			this.appendEventInternal(
				input.taskId,
				undefined,
				input.attemptId,
				"PermissionEvaluated",
				{
					decisionId: id,
					operationId: input.operationId,
					intentSha256: input.intentSha256,
					action: input.action,
					source: input.source,
					...(input.grantId ? { grantId: input.grantId } : {}),
					...(input.authorizationId ? { authorizationId: input.authorizationId } : {}),
					...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
					schemaVersion: 1,
				},
				now,
			);
		});
		return id;
	}

	private registerTaskAuthorizationSourceInternal(
		taskId: string,
		sourceMessageId: string,
		kind: TaskAuthorizationSourceRecord["kind"],
		text: string,
		createdAt: string,
	): TaskAuthorizationSourceRecord {
		this.requireTask(taskId);
		if (sourceMessageId.trim() === "" || text.trim() === "")
			throw new TypeError("Task Authorization source identity and text are required");
		const textSha256 = createHash("sha256").update(text).digest("hex");
		const existing = this.getTaskAuthorizationSource(sourceMessageId);
		if (existing) {
			if (
				existing.taskId !== taskId ||
				existing.kind !== kind ||
				existing.textSha256 !== textSha256 ||
				existing.text !== text
			)
				throw new Error(`Task Authorization source identity conflict: ${sourceMessageId}`);
			return existing;
		}
		this.database
			.prepare(
				`INSERT INTO task_authorization_sources
				 (id, task_id, source_kind, source_message_sha256, source_text, state, created_at)
				 VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
			)
			.run(sourceMessageId, taskId, kind, textSha256, text, createdAt);
		this.appendEventInternal(
			taskId,
			undefined,
			undefined,
			"AuthorizationCompileRequested",
			{ sourceMessageId, sourceKind: kind, sourceMessageSha256: textSha256, schemaVersion: 1 },
			createdAt,
		);
		return this.requireTaskAuthorizationSource(sourceMessageId);
	}

	private getTaskAuthorizationSource(sourceId: string): TaskAuthorizationSourceRecord | undefined {
		const row = this.database.prepare("SELECT * FROM task_authorization_sources WHERE id = ?").get(sourceId) as
			| TaskAuthorizationSourceRow
			| undefined;
		return row ? taskAuthorizationSourceFromRow(row) : undefined;
	}

	private requireTaskAuthorizationSource(sourceId: string): TaskAuthorizationSourceRecord {
		const source = this.getTaskAuthorizationSource(sourceId);
		if (!source) throw new Error(`Task Authorization source not found: ${sourceId}`);
		return source;
	}

	private getTaskAuthorization(authorizationId: string): TaskAuthorizationRecord | undefined {
		const row = this.database.prepare("SELECT * FROM task_authorizations WHERE id = ?").get(authorizationId) as
			| TaskAuthorizationRow
			| undefined;
		return row ? taskAuthorizationFromRow(row) : undefined;
	}

	private requireTaskAuthorization(authorizationId: string): TaskAuthorizationRecord {
		const authorization = this.getTaskAuthorization(authorizationId);
		if (!authorization) throw new Error(`Task Authorization not found: ${authorizationId}`);
		return authorization;
	}

	private getPermissionGrant(grantId: string): PermissionGrantRecord | undefined {
		const row = this.database.prepare("SELECT * FROM permission_grants WHERE id = ?").get(grantId) as
			| PermissionGrantRow
			| undefined;
		return row ? permissionGrantFromRow(row) : undefined;
	}

	private requirePermissionGrant(grantId: string): PermissionGrantRecord {
		const grant = this.getPermissionGrant(grantId);
		if (!grant) throw new Error(`Permission grant not found: ${grantId}`);
		return grant;
	}

	private expirePermissionGrants(): void {
		const now = this.now().toISOString();
		const expired = this.database
			.prepare(
				"SELECT * FROM permission_grants WHERE state = 'active' AND expires_at IS NOT NULL AND expires_at <= ?",
			)
			.all(now) as unknown as PermissionGrantRow[];
		if (expired.length === 0) return;
		executeTransaction(this.database, () => {
			for (const row of expired) {
				this.database.prepare("UPDATE permission_grants SET state = 'expired' WHERE id = ?").run(row.id);
				this.appendEventInternal(
					row.task_id,
					undefined,
					row.attempt_id ?? undefined,
					"PermissionGrantExpired",
					{ grantId: row.id, schemaVersion: 1 },
					now,
				);
			}
		});
	}

	beginTaskCommand(input: BeginTaskCommandInput): { command: TaskCommandRecord; duplicate: boolean } {
		if (
			input.clientId.trim() === "" ||
			input.commandId.trim() === "" ||
			input.commandType.trim() === "" ||
			!/^[a-f0-9]{64}$/.test(input.payloadSha256)
		)
			throw new TypeError("Invalid Task command identity");
		this.requireTask(input.taskId);
		return executeTransaction(this.database, () => {
			const existing = this.getTaskCommand(input.clientId, input.commandId);
			if (existing) {
				if (
					existing.taskId !== input.taskId ||
					existing.commandType !== input.commandType ||
					existing.payloadSha256 !== input.payloadSha256
				)
					throw new Error(`Task command identity conflict: ${input.clientId}/${input.commandId}`);
				return { command: existing, duplicate: true };
			}
			this.database
				.prepare(
					`INSERT INTO task_commands
					 (client_id, command_id, task_id, command_type, payload_sha256, payload_json, state, dispatched_at)
					 VALUES (?, ?, ?, ?, ?, ?, 'dispatched', ?)`,
				)
				.run(
					input.clientId,
					input.commandId,
					input.taskId,
					input.commandType,
					input.payloadSha256,
					JSON.stringify(input.payload),
					this.now().toISOString(),
				);
			return { command: this.requireTaskCommand(input.clientId, input.commandId), duplicate: false };
		});
	}

	getTaskCommand(clientId: string, commandId: string): TaskCommandRecord | undefined {
		const row = this.database
			.prepare("SELECT * FROM task_commands WHERE client_id = ? AND command_id = ?")
			.get(clientId, commandId) as TaskCommandRow | undefined;
		return row ? taskCommandFromRow(row) : undefined;
	}

	completeTaskCommand(clientId: string, commandId: string, result: Record<string, unknown>): TaskCommandRecord {
		return executeTransaction(this.database, () => {
			const existing = this.requireTaskCommand(clientId, commandId);
			if (existing.state === "completed") return existing;
			this.database
				.prepare(
					`UPDATE task_commands SET state = 'completed', result_json = ?, completed_at = ?
					 WHERE client_id = ? AND command_id = ? AND state = 'dispatched'`,
				)
				.run(JSON.stringify(result), this.now().toISOString(), clientId, commandId);
			return this.requireTaskCommand(clientId, commandId);
		});
	}

	receiveDaemonCommand(input: ReceiveDaemonCommandInput): { command: DaemonCommandRecord; duplicate: boolean } {
		if (
			input.clientId.trim() === "" ||
			input.commandId.trim() === "" ||
			input.commandType.trim() === "" ||
			!/^[a-f0-9]{64}$/.test(input.payloadSha256)
		) {
			throw new TypeError("Invalid daemon command identity");
		}
		return executeTransaction(this.database, () => {
			const existing = this.getDaemonCommand(input.clientId, input.commandId);
			if (existing) {
				if (existing.payloadSha256 !== input.payloadSha256 || existing.commandType !== input.commandType) {
					throw new Error(`Daemon command identity conflict: ${input.clientId}/${input.commandId}`);
				}
				return { command: existing, duplicate: true };
			}
			const now = this.now().toISOString();
			this.database
				.prepare(
					`INSERT INTO daemon_commands
					 (client_id, command_id, command_type, payload_sha256, payload_json, state, received_at)
					 VALUES (?, ?, ?, ?, ?, 'received', ?)`,
				)
				.run(
					input.clientId,
					input.commandId,
					input.commandType,
					input.payloadSha256,
					JSON.stringify(input.payload),
					now,
				);
			return { command: this.requireDaemonCommand(input.clientId, input.commandId), duplicate: false };
		});
	}

	getDaemonCommand(clientId: string, commandId: string): DaemonCommandRecord | undefined {
		const row = this.database
			.prepare("SELECT * FROM daemon_commands WHERE client_id = ? AND command_id = ?")
			.get(clientId, commandId) as DaemonCommandRow | undefined;
		return row ? daemonCommandFromRow(row) : undefined;
	}

	markDaemonCommandDispatched(clientId: string, commandId: string): DaemonCommandRecord {
		const result = this.database
			.prepare(
				"UPDATE daemon_commands SET state = 'dispatched', dispatched_at = ? WHERE client_id = ? AND command_id = ? AND state = 'received'",
			)
			.run(this.now().toISOString(), clientId, commandId);
		if (Number(result.changes) !== 1) throw new Error(`Daemon command is not ready: ${clientId}/${commandId}`);
		return this.requireDaemonCommand(clientId, commandId);
	}

	completeDaemonCommand(clientId: string, commandId: string, result: Record<string, unknown>): DaemonCommandRecord {
		const update = this.database
			.prepare(
				`UPDATE daemon_commands SET state = 'completed', result_json = ?, error = NULL, completed_at = ?
				 WHERE client_id = ? AND command_id = ? AND state = 'dispatched'`,
			)
			.run(JSON.stringify(result), this.now().toISOString(), clientId, commandId);
		if (Number(update.changes) !== 1) throw new Error(`Daemon command is not dispatched: ${clientId}/${commandId}`);
		return this.requireDaemonCommand(clientId, commandId);
	}

	markDaemonCommandUncertain(clientId: string, commandId: string, error?: string): DaemonCommandRecord {
		const result = this.database
			.prepare(
				`UPDATE daemon_commands SET state = 'uncertain', error = ?
				 WHERE client_id = ? AND command_id = ? AND state IN ('received', 'dispatched')`,
			)
			.run(error?.slice(0, 1000) ?? null, clientId, commandId);
		if (Number(result.changes) !== 1)
			throw new Error(`Daemon command cannot become uncertain: ${clientId}/${commandId}`);
		return this.requireDaemonCommand(clientId, commandId);
	}

	acknowledgeDaemonCommand(clientId: string, commandId: string): DaemonCommandRecord {
		const result = this.database
			.prepare(
				`UPDATE daemon_commands SET state = 'acknowledged', acknowledged_at = ?
				 WHERE client_id = ? AND command_id = ? AND state IN ('completed', 'uncertain')`,
			)
			.run(this.now().toISOString(), clientId, commandId);
		if (Number(result.changes) !== 1)
			throw new Error(`Daemon command cannot be acknowledged: ${clientId}/${commandId}`);
		return this.requireDaemonCommand(clientId, commandId);
	}

	markInterruptedDaemonCommandsUncertain(): number {
		const result = this.database
			.prepare(
				`UPDATE daemon_commands SET state = 'uncertain', error = COALESCE(error, 'daemon restarted before completion')
				 WHERE state IN ('received', 'dispatched')`,
			)
			.run();
		return Number(result.changes);
	}

	pruneDaemonCommands(retentionDays: number): number {
		if (!Number.isSafeInteger(retentionDays) || retentionDays < 1)
			throw new TypeError("Invalid daemon command journal retention");
		const cutoff = new Date(this.now().getTime() - retentionDays * 86_400_000).toISOString();
		const result = this.database
			.prepare(
				`DELETE FROM daemon_commands
				 WHERE state IN ('completed', 'uncertain', 'acknowledged')
				   AND COALESCE(acknowledged_at, completed_at, received_at) < ?`,
			)
			.run(cutoff);
		return Number(result.changes);
	}

	recordContinuationDecision(
		lease: AgentLease,
		input: Omit<ContinuationDecision, "id" | "taskId" | "agentId" | "createdAt">,
	): { decision: ContinuationDecision; duplicate: boolean } {
		if (!Number.isSafeInteger(input.settledTurnIndex) || input.settledTurnIndex < 0)
			throw new TypeError("Invalid settled Turn index");
		return executeTransaction(this.database, () => {
			this.assertLeaseInternal(lease);
			const existing = this.database
				.prepare(
					"SELECT * FROM continuation_decisions WHERE agent_id = ? AND attempt_id = ? AND settled_turn_index = ?",
				)
				.get(lease.agentId, input.attemptId, input.settledTurnIndex) as ContinuationDecisionRow | undefined;
			if (existing) return { decision: continuationDecisionFromRow(existing), duplicate: true };
			const id = randomUUID();
			const now = this.now().toISOString();
			this.database
				.prepare(
					`INSERT INTO continuation_decisions
					 (id, task_id, agent_id, attempt_id, settled_turn_index, action, reason_code, reason,
					  progress_fingerprint, next_prompt, next_wake_at, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					lease.taskId,
					lease.agentId,
					input.attemptId,
					input.settledTurnIndex,
					input.action,
					input.reasonCode,
					input.reason,
					input.progressFingerprint,
					input.nextPrompt ?? null,
					input.nextWakeAt ?? null,
					now,
				);
			this.appendEventInternal(
				lease.taskId,
				lease.agentId,
				input.attemptId,
				"ContinuationDecided",
				{
					decisionId: id,
					settledTurnIndex: input.settledTurnIndex,
					action: input.action,
					reasonCode: input.reasonCode,
					progressFingerprint: input.progressFingerprint,
					schemaVersion: 1,
				},
				now,
			);
			const row = this.database.prepare("SELECT * FROM continuation_decisions WHERE id = ?").get(id) as
				| ContinuationDecisionRow
				| undefined;
			if (!row) throw new Error(`Continuation decision not found after insert: ${id}`);
			return { decision: continuationDecisionFromRow(row), duplicate: false };
		});
	}

	listContinuationDecisions(agentId: string, attemptId?: string): ContinuationDecision[] {
		const rows = (attemptId
			? this.database
					.prepare(
						"SELECT * FROM continuation_decisions WHERE agent_id = ? AND attempt_id = ? ORDER BY settled_turn_index",
					)
					.all(agentId, attemptId)
			: this.database
					.prepare("SELECT * FROM continuation_decisions WHERE agent_id = ? ORDER BY created_at")
					.all(agentId)) as unknown as ContinuationDecisionRow[];
		return rows.map(continuationDecisionFromRow);
	}

	hasUnfinishedTools(taskId: string, agentId: string): boolean {
		return this.listUnfinishedToolsInternal(taskId, agentId).length > 0;
	}

	hasPendingAcceptanceRequest(taskId: string): boolean {
		return Boolean(
			this.database
				.prepare(
					`SELECT id FROM task_events requested WHERE task_id = ? AND type = 'AcceptanceRequested'
					 AND NOT EXISTS (
					  SELECT 1 FROM task_events completed WHERE completed.task_id = requested.task_id
					  AND completed.type = 'TaskCompleted' AND completed.seq > requested.seq
					 ) ORDER BY seq DESC LIMIT 1`,
				)
				.get(taskId),
		);
	}

	hasPassedAllAcceptance(taskId: string): boolean {
		return this.requireTask(taskId).acceptance.every((criterion) => this.hasPassedAcceptance(taskId, criterion.id));
	}

	hasPendingManualAcceptance(taskId: string): boolean {
		return this.requireTask(taskId).acceptance.some(
			(criterion) => criterion.kind === "manual" && !this.hasPassedAcceptance(taskId, criterion.id),
		);
	}

	hasIncompleteRequiredDelegations(taskId: string): boolean {
		const row = this.database
			.prepare(
				"SELECT COUNT(*) AS count FROM delegations WHERE task_id = ? AND required = 1 AND state <> 'completed'",
			)
			.get(taskId) as { count: number };
		return row.count > 0;
	}

	createSchedule(input: {
		taskId: string;
		agentId?: string;
		kind: ScheduleRecord["kind"];
		expression: string;
		timezone: string;
		payload?: Record<string, unknown>;
		nextRunAt?: string;
	}): ScheduleRecord {
		this.requireTask(input.taskId);
		if (input.agentId && this.requireAgent(input.agentId).taskId !== input.taskId)
			throw new Error("Schedule Agent does not belong to Task");
		if (input.expression.trim() === "" || input.timezone.trim() === "")
			throw new TypeError("Schedule expression and timezone are required");
		if (input.nextRunAt !== undefined && !Number.isFinite(Date.parse(input.nextRunAt)))
			throw new Error("Invalid schedule next run time");
		const id = randomUUID();
		const now = this.now().toISOString();
		executeTransaction(this.database, () => {
			this.database
				.prepare(
					`INSERT INTO schedules
					 (id, task_id, agent_id, kind, expression, timezone, payload_json, state, next_run_at,
					  last_event_seq, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, ?, ?)`,
				)
				.run(
					id,
					input.taskId,
					input.agentId ?? null,
					input.kind,
					input.expression,
					input.timezone,
					JSON.stringify(input.payload ?? {}),
					input.nextRunAt ?? null,
					now,
					now,
				);
			const createdEventSeq = this.appendEventInternal(
				input.taskId,
				input.agentId,
				undefined,
				"ScheduleCreated",
				{ scheduleId: id, kind: input.kind, nextRunAt: input.nextRunAt, schemaVersion: 1 },
				now,
			);
			if (input.kind === "event")
				this.database.prepare("UPDATE schedules SET last_event_seq = ? WHERE id = ?").run(createdEventSeq, id);
		});
		return this.requireSchedule(id);
	}

	getSchedule(scheduleId: string): ScheduleRecord | undefined {
		const row = this.database.prepare("SELECT * FROM schedules WHERE id = ?").get(scheduleId) as
			| ScheduleRow
			| undefined;
		return row ? scheduleFromRow(row) : undefined;
	}

	requireSchedule(scheduleId: string): ScheduleRecord {
		const schedule = this.getSchedule(scheduleId);
		if (!schedule) throw new Error(`Schedule not found: ${scheduleId}`);
		return schedule;
	}

	listSchedules(taskId: string): ScheduleRecord[] {
		return (
			this.database
				.prepare("SELECT * FROM schedules WHERE task_id = ? ORDER BY created_at")
				.all(taskId) as unknown as ScheduleRow[]
		).map(scheduleFromRow);
	}

	listDueSchedules(dueAt: string, limit = 100): ScheduleRecord[] {
		return (
			this.database
				.prepare(
					"SELECT * FROM schedules WHERE state = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT ?",
				)
				.all(dueAt, limit) as unknown as ScheduleRow[]
		).map(scheduleFromRow);
	}

	listPendingEventScheduleTriggers(limit = 100): ScheduleEventTrigger[] {
		const rows = this.database
			.prepare(
				`SELECT
				   s.id AS schedule_id,
				   e.id AS event_id, e.task_id, e.agent_id, e.attempt_id, e.seq, e.type, e.payload_json, e.created_at
				 FROM schedules s
				 JOIN task_events e ON e.task_id = s.task_id AND e.seq > s.last_event_seq
				 WHERE s.kind = 'event' AND s.state = 'active'
				   AND (s.expression = '*' OR s.expression = e.type)
				   AND e.type NOT LIKE 'Schedule%'
				   AND (s.agent_id IS NULL OR s.agent_id = e.agent_id)
				 ORDER BY e.created_at, e.seq, s.created_at
				 LIMIT ?`,
			)
			.all(limit) as unknown as Array<EventRow & { schedule_id: string; event_id: string }>;
		return rows.map((row) => ({
			schedule: this.requireSchedule(row.schedule_id),
			event: eventFromRow({ ...row, id: row.event_id }),
		}));
	}

	claimEventSchedule(trigger: ScheduleEventTrigger, claimedAt: string): ScheduleClaim | undefined {
		return executeTransaction(this.database, () => {
			const schedule = this.getSchedule(trigger.schedule.id);
			if (!schedule || schedule.kind !== "event" || schedule.state !== "active") return undefined;
			if (schedule.lastEventSeq >= trigger.event.seq) return undefined;
			const claimId = randomUUID();
			const result = this.database
				.prepare(
					`UPDATE schedules SET last_event_seq = ?, last_claim_id = ?, last_claimed_at = ?,
					 last_delivered_at = NULL, updated_at = ?
					 WHERE id = ? AND kind = 'event' AND state = 'active' AND last_event_seq < ?`,
				)
				.run(trigger.event.seq, claimId, claimedAt, claimedAt, schedule.id, trigger.event.seq);
			if (Number(result.changes) !== 1) return undefined;
			this.appendEventInternal(
				schedule.taskId,
				schedule.agentId,
				undefined,
				"ScheduleEventClaimed",
				{
					scheduleId: schedule.id,
					claimId,
					sourceEventId: trigger.event.id,
					sourceEventSeq: trigger.event.seq,
					sourceEventType: trigger.event.type,
					schemaVersion: 1,
				},
				claimedAt,
			);
			return {
				schedule: this.requireSchedule(schedule.id),
				claimId,
				dueAt: trigger.event.createdAt,
				missedCount: 1,
				claimedAt,
			};
		});
	}

	claimSchedule(input: {
		scheduleId: string;
		dueAt: string;
		claimedAt: string;
		nextRunAt?: string;
		missedCount: number;
	}): ScheduleClaim | undefined {
		return executeTransaction(this.database, () => {
			const schedule = this.getSchedule(input.scheduleId);
			if (!schedule || schedule.state !== "active" || schedule.nextRunAt !== input.dueAt) return undefined;
			const claimId = randomUUID();
			const nextState = schedule.kind === "once" ? "completed" : "active";
			const result = this.database
				.prepare(
					`UPDATE schedules SET state = ?, next_run_at = ?, last_claim_id = ?, last_claimed_at = ?,
					 last_delivered_at = NULL, updated_at = ?
					 WHERE id = ? AND state = 'active' AND next_run_at = ?`,
				)
				.run(
					nextState,
					input.nextRunAt ?? null,
					claimId,
					input.claimedAt,
					input.claimedAt,
					schedule.id,
					input.dueAt,
				);
			if (Number(result.changes) !== 1) return undefined;
			this.appendEventInternal(
				schedule.taskId,
				schedule.agentId,
				undefined,
				"ScheduleClaimed",
				{
					scheduleId: schedule.id,
					claimId,
					dueAt: input.dueAt,
					nextRunAt: input.nextRunAt,
					missedCount: input.missedCount,
					schemaVersion: 1,
				},
				input.claimedAt,
			);
			return {
				schedule: this.requireSchedule(schedule.id),
				claimId,
				dueAt: input.dueAt,
				missedCount: input.missedCount,
				claimedAt: input.claimedAt,
			};
		});
	}

	markScheduleDelivered(scheduleId: string, claimId: string, deliveredAt: string): ScheduleRecord {
		return executeTransaction(this.database, () => {
			const schedule = this.requireSchedule(scheduleId);
			if (schedule.lastClaimId !== claimId) throw new Error("Schedule claim is no longer current");
			if (schedule.lastDeliveredAt !== undefined) return schedule;
			this.database
				.prepare("UPDATE schedules SET last_delivered_at = ?, updated_at = ? WHERE id = ? AND last_claim_id = ?")
				.run(deliveredAt, deliveredAt, scheduleId, claimId);
			this.appendEventInternal(
				schedule.taskId,
				schedule.agentId,
				undefined,
				"ScheduleDelivered",
				{ scheduleId, claimId, schemaVersion: 1 },
				deliveredAt,
			);
			return this.requireSchedule(scheduleId);
		});
	}

	transitionSchedule(scheduleId: string, state: "active" | "paused" | "cancelled"): ScheduleRecord {
		const schedule = this.requireSchedule(scheduleId);
		if (schedule.state === "completed" || schedule.state === "cancelled")
			throw new Error(`Schedule cannot transition from ${schedule.state}`);
		const now = this.now().toISOString();
		this.database.prepare("UPDATE schedules SET state = ?, updated_at = ? WHERE id = ?").run(state, now, scheduleId);
		return this.requireSchedule(scheduleId);
	}

	private requireDaemonCommand(clientId: string, commandId: string): DaemonCommandRecord {
		const command = this.getDaemonCommand(clientId, commandId);
		if (!command) throw new Error(`Daemon command not found: ${clientId}/${commandId}`);
		return command;
	}

	private requireTaskCommand(clientId: string, commandId: string): TaskCommandRecord {
		const command = this.getTaskCommand(clientId, commandId);
		if (!command) throw new Error(`Task command not found: ${clientId}/${commandId}`);
		return command;
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
			allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write", "task_update"],
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
			this.database.prepare("INSERT INTO task_authorization_state(task_id) VALUES (?)").run(taskId);
			this.registerTaskAuthorizationSourceInternal(taskId, `goal:${taskId}`, "goal", input.goal, now);
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

	findTasksByIdPrefix(prefix: string, limit = 2): TaskRecord[] {
		if (!/^[a-f0-9-]+$/i.test(prefix)) return [];
		return (
			this.database
				.prepare("SELECT * FROM tasks WHERE id >= ? AND id < ? ORDER BY id LIMIT ?")
				.all(prefix, `${prefix}\uffff`, limit) as unknown as TaskRow[]
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
						kind === "completed" ? "Ever 已完成任务" : kind === "failed" ? "Ever 任务失败" : "Ever 需要你的输入",
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
						 AND state IN ('created', 'paused', 'waiting_message', 'waiting_external', 'unknown_outcome')`,
					)
					.run(now, taskId);
			} else if (nextState === "waiting_input") {
				this.database
					.prepare(
						"UPDATE agents SET state = 'waiting_message', updated_at = ? WHERE task_id = ? AND state = 'running'",
					)
					.run(now, taskId);
			} else if (nextState === "waiting_external") {
				this.database
					.prepare(
						"UPDATE agents SET state = 'waiting_external', updated_at = ? WHERE task_id = ? AND state = 'running'",
					)
					.run(now, taskId);
			} else if (nextState === "paused") {
				this.database
					.prepare(
						`UPDATE agents SET state = 'paused', updated_at = ? WHERE task_id = ?
						 AND state NOT IN ('completed', 'failed', 'cancelled', 'unknown_outcome')`,
					)
					.run(now, taskId);
			} else if (nextState === "completed" || nextState === "cancelled" || nextState === "failed") {
				this.database
					.prepare(
						`UPDATE agents SET state = ?, updated_at = ?, completed_at = ? WHERE task_id = ?
						 AND state NOT IN ('completed', 'failed', 'cancelled')`,
					)
					.run(nextState, now, now, taskId);
				this.database
					.prepare(
						`UPDATE attempts SET state = ?, settled_at = ? WHERE task_id = ?
						 AND state NOT IN ('completed', 'failed', 'cancelled', 'unknown_outcome')`,
					)
					.run(nextState, now, taskId);
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

	findEvent(taskId: string, ref: string): TaskEvent | undefined {
		const numericSeq = /^\d+$/.test(ref) ? Number(ref) : undefined;
		const row = (
			numericSeq === undefined
				? this.database.prepare("SELECT * FROM task_events WHERE task_id = ? AND id = ?").get(taskId, ref)
				: this.database.prepare("SELECT * FROM task_events WHERE task_id = ? AND seq = ?").get(taskId, numericSeq)
		) as EventRow | undefined;
		return row ? eventFromRow(row) : undefined;
	}

	beginVerifiedCompletion(input: {
		taskId: string;
		requestId: string;
		summary: string;
		evidence: readonly unknown[];
		requirements?: readonly unknown[];
	}): { status: "new" | "running" | "completed"; result?: Record<string, unknown> } {
		this.requireTask(input.taskId);
		if (input.requestId.trim() === "") throw new TypeError("Verified completion request ID is required");
		const evidenceJson = JSON.stringify(
			input.requirements === undefined
				? input.evidence
				: { evidence: input.evidence, requirements: input.requirements },
		);
		return executeTransaction(this.database, () => {
			const existing = this.database
				.prepare(
					"SELECT summary, evidence_json, state, result_json FROM verified_completion_requests WHERE task_id = ? AND request_id = ?",
				)
				.get(input.taskId, input.requestId) as
				| { summary: string; evidence_json: string; state: "running" | "completed"; result_json: string | null }
				| undefined;
			if (existing) {
				if (existing.summary !== input.summary || existing.evidence_json !== evidenceJson)
					throw new Error(`Verified completion request ${input.requestId} was reused with different input`);
				return {
					status: existing.state,
					...(existing.result_json === null
						? {}
						: { result: parseObject(existing.result_json, "verified completion result") }),
				};
			}
			const now = this.now().toISOString();
			this.database
				.prepare(
					`INSERT INTO verified_completion_requests
					 (task_id, request_id, summary, evidence_json, state, created_at)
					 VALUES (?, ?, ?, ?, 'running', ?)`,
				)
				.run(input.taskId, input.requestId, input.summary, evidenceJson, now);
			this.appendEventInternal(
				input.taskId,
				undefined,
				undefined,
				"AcceptanceRequested",
				{
					requestId: input.requestId,
					summary: input.summary,
					evidence: input.evidence,
					...(input.requirements === undefined ? {} : { requirements: input.requirements }),
					schemaVersion: 2,
				},
				now,
			);
			return { status: "new" };
		});
	}

	finishVerifiedCompletion(taskId: string, requestId: string, result: Record<string, unknown>): void {
		executeTransaction(this.database, () => {
			const now = this.now().toISOString();
			const update = this.database
				.prepare(
					`UPDATE verified_completion_requests
					 SET state = 'completed', result_json = ?, completed_at = ?
					 WHERE task_id = ? AND request_id = ? AND state = 'running'`,
				)
				.run(JSON.stringify(result), now, taskId, requestId);
			if (Number(update.changes) !== 1) throw new Error(`Verified completion request is not running: ${requestId}`);
			this.appendEventInternal(
				taskId,
				undefined,
				undefined,
				"AcceptanceEvaluationCompleted",
				{ requestId, accepted: result.accepted === true, schemaVersion: 1 },
				now,
			);
		});
	}

	beginAcceptanceCommand(taskId: string, requestId: string, criterionId: string): "execute" | "unknown" | "finished" {
		return executeTransaction(this.database, () => {
			const existing = this.database
				.prepare(
					`SELECT state FROM acceptance_command_executions
					 WHERE task_id = ? AND request_id = ? AND criterion_id = ?`,
				)
				.get(taskId, requestId, criterionId) as { state: "started" | "finished" } | undefined;
			if (existing) return existing.state === "finished" ? "finished" : "unknown";
			this.database
				.prepare(
					`INSERT INTO acceptance_command_executions
					 (task_id, request_id, criterion_id, state, created_at)
					 VALUES (?, ?, ?, 'started', ?)`,
				)
				.run(taskId, requestId, criterionId, this.now().toISOString());
			return "execute";
		});
	}

	finishAcceptanceCommand(
		taskId: string,
		requestId: string,
		criterionId: string,
		passed: boolean,
		evidence: Record<string, unknown>,
	): void {
		const task = this.requireTask(taskId);
		if (!task.acceptance.some((criterion) => criterion.id === criterionId))
			throw new Error(`Unknown acceptance criterion: ${criterionId}`);
		executeTransaction(this.database, () => {
			const now = this.now().toISOString();
			const update = this.database
				.prepare(
					`UPDATE acceptance_command_executions
					 SET state = 'finished', result_json = ?, finished_at = ?
					 WHERE task_id = ? AND request_id = ? AND criterion_id = ? AND state = 'started'`,
				)
				.run(JSON.stringify({ passed, evidence }), now, taskId, requestId, criterionId);
			if (Number(update.changes) !== 1) throw new Error(`Acceptance command is not running: ${criterionId}`);
			this.appendEventInternal(
				taskId,
				undefined,
				undefined,
				passed ? "AcceptancePassed" : "AcceptanceFailed",
				{ criterionId, evidence, requestId, schemaVersion: 2 },
				now,
			);
		});
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

	startToolExecution(
		lease: AgentLease,
		attemptId: string,
		input: {
			operationId: string;
			toolCallId: string;
			toolName: string;
			inputSha256: string;
			effect: UnfinishedToolExecution["effect"];
			paths: string[];
			permissionSource?: "policy" | "grant" | "reviewer" | "user_authorization";
			intentSha256?: string;
			grantId?: string;
			authorizationId?: string;
		},
	): void {
		if ((input.permissionSource !== undefined) !== (input.intentSha256 !== undefined))
			throw new Error("Permission source and intent hash must be recorded together");
		if ((input.grantId !== undefined) !== (input.permissionSource === "grant"))
			throw new Error("Permission grant id and permission source must be recorded together");
		if ((input.authorizationId !== undefined) !== (input.permissionSource === "user_authorization"))
			throw new Error("Task Authorization id and permission source must be recorded together");
		executeTransaction(this.database, () => {
			this.assertLeaseInternal(lease);
			const now = this.now().toISOString();
			if (input.grantId) {
				const grant = this.requirePermissionGrant(input.grantId);
				if (grant.state !== "active") throw new Error(`Permission grant is ${grant.state}`);
				if (grant.lifetime !== "workspace" && grant.lifetime !== "project_policy" && grant.taskId !== lease.taskId)
					throw new Error("Permission grant does not belong to this Task");
				if (grant.attemptId !== undefined && grant.attemptId !== attemptId)
					throw new Error("Permission grant does not belong to this Attempt");
				if (grant.remainingUses !== undefined) {
					if (grant.remainingUses < 1) throw new Error("Permission grant has no remaining uses");
					this.database
						.prepare(
							`UPDATE permission_grants SET remaining_uses = remaining_uses - 1,
							 state = CASE WHEN remaining_uses = 1 THEN 'consumed' ELSE state END WHERE id = ? AND state = 'active'`,
						)
						.run(grant.id);
				}
				this.appendEventInternal(
					lease.taskId,
					lease.agentId,
					attemptId,
					"PermissionGrantUsed",
					{
						grantId: grant.id,
						operationId: input.operationId,
						intentSha256: input.intentSha256,
						schemaVersion: 1,
					},
					now,
				);
			}
			if (input.authorizationId) {
				const authorization = this.requireTaskAuthorization(input.authorizationId);
				if (authorization.taskId !== lease.taskId)
					throw new Error("Task Authorization does not belong to this Task");
				if (authorization.state !== "active") throw new Error(`Task Authorization is ${authorization.state}`);
				const update = this.database
					.prepare(
						`UPDATE task_authorizations SET used_count = used_count + 1,
						 state = CASE WHEN used_count + 1 >= max_uses THEN 'consumed' ELSE state END,
						 consumed_at = CASE WHEN used_count + 1 >= max_uses THEN ? ELSE consumed_at END
						 WHERE id = ? AND state = 'active' AND used_count < max_uses`,
					)
					.run(now, authorization.id);
				if (Number(update.changes) !== 1) throw new Error("Task Authorization has no remaining uses");
				this.appendEventInternal(
					lease.taskId,
					lease.agentId,
					attemptId,
					"TaskAuthorizationUsed",
					{
						authorizationId: authorization.id,
						operationId: input.operationId,
						intentSha256: input.intentSha256,
						schemaVersion: 1,
					},
					now,
				);
			}
			if (input.permissionSource && input.intentSha256) {
				this.database
					.prepare(
						`INSERT INTO permission_decisions
						 (id, operation_id, task_id, attempt_id, intent_sha256, action, source, grant_id,
						  authorization_id, created_at)
						 VALUES (?, ?, ?, ?, ?, 'allow', ?, ?, ?, ?)`,
					)
					.run(
						randomUUID(),
						input.operationId,
						lease.taskId,
						attemptId,
						input.intentSha256,
						input.permissionSource,
						input.grantId ?? null,
						input.authorizationId ?? null,
						now,
					);
			}
			const base = {
				operationId: input.operationId,
				toolCallId: input.toolCallId,
				toolName: input.toolName,
				inputSha256: input.inputSha256,
				effect: input.effect,
				paths: input.paths,
				...(input.permissionSource ? { permissionSource: input.permissionSource } : {}),
				...(input.intentSha256 ? { intentSha256: input.intentSha256 } : {}),
				...(input.grantId ? { grantId: input.grantId } : {}),
				...(input.authorizationId ? { authorizationId: input.authorizationId } : {}),
				executionId: lease.executionId,
				fencingToken: lease.fencingToken,
				schemaVersion: 1,
			};
			this.appendEventInternal(lease.taskId, lease.agentId, attemptId, "ToolPlanned", base, now);
			this.appendEventInternal(lease.taskId, lease.agentId, attemptId, "ToolAuthorized", base, now);
			this.appendEventInternal(lease.taskId, lease.agentId, attemptId, "ToolStarted", base, now);
		});
	}

	finishToolExecution(
		lease: AgentLease,
		attemptId: string,
		input: { operationId: string; toolCallId: string; toolName: string; isError: boolean; summary: string },
	): void {
		this.appendAgentEvent(lease, attemptId, "ToolFinished", { ...input, schemaVersion: 1 });
	}

	markExecutionOutcomeUnknown(lease: AgentLease, attemptId: string, reason: string): void {
		executeTransaction(this.database, () => {
			this.assertLeaseInternal(lease);
			const now = this.now().toISOString();
			this.database
				.prepare("UPDATE agents SET state = 'unknown_outcome', updated_at = ? WHERE id = ?")
				.run(now, lease.agentId);
			this.database
				.prepare("UPDATE tasks SET state = 'unknown_outcome', state_reason = ?, updated_at = ? WHERE id = ?")
				.run(reason.slice(0, 1000), now, lease.taskId);
			this.database
				.prepare("UPDATE attempts SET state = 'unknown_outcome', error_code = ?, settled_at = ? WHERE id = ?")
				.run(reason.slice(0, 1000), now, attemptId);
			this.appendEventInternal(
				lease.taskId,
				lease.agentId,
				attemptId,
				"ToolOutcomeUnknown",
				{ reason: reason.slice(0, 1000), schemaVersion: 1 },
				now,
			);
		});
	}

	markProviderOutcomeUnknown(lease: AgentLease, attemptId: string, providerRequestId: string, reason: string): void {
		executeTransaction(this.database, () => {
			this.assertLeaseInternal(lease);
			const reservation = this.database
				.prepare("SELECT request_kind FROM budget_reservations WHERE provider_request_id = ? AND attempt_id = ?")
				.get(providerRequestId, attemptId) as { request_kind: string | null } | undefined;
			const reviewerRequest =
				reservation?.request_kind === "authorization_compile" || reservation?.request_kind === "permission_review";
			const now = this.now().toISOString();
			this.database
				.prepare("UPDATE agents SET state = 'unknown_outcome', updated_at = ? WHERE id = ?")
				.run(now, lease.agentId);
			this.database
				.prepare("UPDATE tasks SET state = 'unknown_outcome', state_reason = ?, updated_at = ? WHERE id = ?")
				.run(reason.slice(0, 1000), now, lease.taskId);
			this.database
				.prepare("UPDATE attempts SET state = 'unknown_outcome', error_code = ?, settled_at = ? WHERE id = ?")
				.run("provider_outcome_unknown", now, attemptId);
			this.appendEventInternal(
				lease.taskId,
				lease.agentId,
				attemptId,
				"ProviderOutcomeUnknown",
				{ providerRequestId, reason: reason.slice(0, 1000), schemaVersion: 1 },
				now,
			);
			if (reviewerRequest)
				this.appendEventInternal(
					lease.taskId,
					lease.agentId,
					attemptId,
					"ReviewerRequestUnknown",
					{
						providerRequestId,
						requestKind: reservation.request_kind,
						reason: reason.slice(0, 1000),
						schemaVersion: 1,
					},
					now,
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
		const row = this.database
			.prepare(
				`SELECT type FROM task_events
				 WHERE task_id = ? AND type IN ('AcceptancePassed', 'AcceptanceFailed')
				 AND json_extract(payload_json, '$.criterionId') = ? ORDER BY seq DESC LIMIT 1`,
			)
			.get(taskId, criterionId) as { type: "AcceptancePassed" | "AcceptanceFailed" } | undefined;
		return row?.type === "AcceptancePassed";
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

	claimAttempt(input: {
		agentId: string;
		sessionId?: string;
		runtimeSnapshot: RuntimeSnapshot;
		runtimeSnapshotSha256: string;
		workerId: string;
		executionId: string;
		leaseSeconds?: number;
		pid?: number;
		sandboxId?: string;
	}): ClaimedAttempt {
		assertSchema("runtimeSnapshot", input.runtimeSnapshot);
		return executeTransaction(this.database, () => {
			const agent = this.requireAgent(input.agentId);
			const task = this.requireTask(agent.taskId);
			if (task.state !== "queued" && task.state !== "running")
				throw new Error(`Task ${task.id} is not runnable from state ${task.state}`);
			if (agent.state !== "queued" && agent.state !== "running")
				throw new Error(`Agent ${agent.id} is not claimable from state ${agent.state}`);

			const nowDate = this.now();
			const now = nowDate.toISOString();
			const existing = this.database.prepare("SELECT * FROM leases WHERE agent_id = ?").get(agent.id) as
				| LeaseRow
				| undefined;
			if (existing && existing.revoked_at === null && Date.parse(existing.expires_at) > nowDate.getTime())
				throw new Error(`Agent ${agent.id} already has an active lease`);
			if (existing && existing.revoked_at === null)
				throw new Error(`Agent ${agent.id} requires the recovery barrier before lease takeover`);

			const leaseSeconds = input.leaseSeconds ?? 30;
			if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) throw new TypeError("Invalid lease duration");
			const fencingToken = (existing?.fencing_token ?? 0) + 1;
			const expiresAt = new Date(nowDate.getTime() + leaseSeconds * 1000).toISOString();
			this.database
				.prepare(
					`INSERT INTO leases (agent_id, task_id, worker_id, execution_id, pid, sandbox_id, fencing_token, acquired_at, heartbeat_at, expires_at, revoked_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
					 ON CONFLICT(agent_id) DO UPDATE SET worker_id=excluded.worker_id, execution_id=excluded.execution_id,
					 pid=excluded.pid, sandbox_id=excluded.sandbox_id, fencing_token=excluded.fencing_token,
					 acquired_at=excluded.acquired_at, heartbeat_at=excluded.heartbeat_at,
					 expires_at=excluded.expires_at, revoked_at=NULL`,
				)
				.run(
					agent.id,
					task.id,
					input.workerId,
					input.executionId,
					input.pid ?? null,
					input.sandboxId ?? null,
					fencingToken,
					now,
					now,
					expiresAt,
				);

			const attemptId = randomUUID();
			const ordinalRow = this.database
				.prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM attempts WHERE agent_id = ?")
				.get(agent.id) as { ordinal: number };
			this.database
				.prepare(
					`INSERT INTO attempts (
					 id, task_id, agent_id, session_id, ordinal, state, runtime_snapshot_json,
					 runtime_snapshot_sha256, started_at
					) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
				)
				.run(
					attemptId,
					task.id,
					agent.id,
					input.sessionId ?? null,
					ordinalRow.ordinal,
					JSON.stringify(input.runtimeSnapshot),
					input.runtimeSnapshotSha256,
					now,
				);
			this.database
				.prepare("UPDATE agents SET state = 'running', active_session_id = ?, updated_at = ? WHERE id = ?")
				.run(input.sessionId ?? null, now, agent.id);
			if (task.state === "queued")
				this.database
					.prepare("UPDATE tasks SET state = 'running', state_reason = ?, updated_at = ? WHERE id = ?")
					.run("attempt_claimed", now, task.id);
			this.appendEventInternal(
				task.id,
				agent.id,
				attemptId,
				"LeaseAcquired",
				{
					workerId: input.workerId,
					executionId: input.executionId,
					fencingToken,
					schemaVersion: 1,
				},
				now,
			);
			this.appendEventInternal(
				task.id,
				agent.id,
				attemptId,
				"AttemptStarted",
				{
					ordinal: ordinalRow.ordinal,
					deadlineAt: new Date(Date.parse(task.createdAt) + task.budget.maxWallTimeMinutes * 60_000).toISOString(),
					schemaVersion: 1,
				},
				now,
			);
			return { token: attemptId };
		});
	}

	resolveAttemptClaim(claim: ClaimedAttempt): AttemptClaimContext {
		const attempt = this.getAttempt(claim.token);
		if (!attempt) throw new Error("Attempt claim is invalid or no longer available");
		if (this.getLatestAttempt(attempt.agentId)?.id !== attempt.id)
			throw new Error("Attempt claim has been superseded by a newer Attempt");
		const row = this.database.prepare("SELECT * FROM leases WHERE agent_id = ?").get(attempt.agentId) as
			| LeaseRow
			| undefined;
		if (
			!row ||
			row.revoked_at !== null ||
			row.execution_id === "" ||
			Date.parse(row.expires_at) <= this.now().getTime()
		)
			throw new Error("Attempt claim has lost its execution lease");
		const task = this.requireTask(attempt.taskId);
		return {
			task,
			agent: this.requireAgent(attempt.agentId),
			attempt,
			lease: {
				agentId: row.agent_id,
				taskId: row.task_id,
				workerId: row.worker_id,
				executionId: row.execution_id,
				fencingToken: row.fencing_token,
				expiresAt: row.expires_at,
			},
			deadlineAt: new Date(Date.parse(task.createdAt) + task.budget.maxWallTimeMinutes * 60_000).toISOString(),
		};
	}

	getAttempt(attemptId: string): AttemptRecord | undefined {
		const row = this.database.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId) as
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

	beginRecovery(agentId: string): {
		execution: StaleExecution;
		unfinishedTools: UnfinishedToolExecution[];
		unfinishedProviderRequests: UnfinishedProviderRequest[];
	} {
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
			return {
				execution,
				unfinishedTools: this.listUnfinishedToolsInternal(row.task_id, agentId),
				unfinishedProviderRequests: this.listUnfinishedProviderRequestsInternal(row.task_id, agentId),
			};
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

	startProviderRequest(
		lease: AgentLease,
		attemptId: string,
		input: {
			providerRequestId: string;
			provider: string;
			modelId: string;
			requestKind: string;
			worstCaseCostUsd?: number;
		},
	): string {
		return executeTransaction(this.database, () => {
			this.assertLeaseInternal(lease);
			const task = this.requireTask(lease.taskId);
			const reviewerRequest =
				input.requestKind === "authorization_compile" || input.requestKind === "permission_review";
			const reserved = this.database
				.prepare(
					`SELECT COALESCE(SUM(reserved_turns), 0) AS turns, COALESCE(SUM(reserved_cost_usd), 0) AS cost
					 FROM budget_reservations WHERE task_id = ? AND state = 'active'`,
				)
				.get(task.id) as { turns: number; cost: number };
			if (!reviewerRequest && task.totalTurns + reserved.turns + 1 > task.budget.maxTurns)
				throw new Error("Task turn budget exceeded");
			if (
				task.budget.maxCostUsd !== undefined &&
				(input.worstCaseCostUsd === undefined ||
					task.totalCostUsd + reserved.cost + input.worstCaseCostUsd > task.budget.maxCostUsd)
			) {
				throw new Error(
					input.worstCaseCostUsd === undefined
						? "Hard cost budget requires a reliable worst-case cost"
						: "Task cost budget exceeded",
				);
			}
			if (reviewerRequest) {
				if (input.worstCaseCostUsd === undefined)
					throw new Error("Reviewer requests require a reliable worst-case cost");
				const state = this.database
					.prepare(
						`SELECT compiler_request_count, reviewer_request_count, reviewer_cost_usd,
						        reviewer_reserved_usd
						 FROM task_authorization_state WHERE task_id = ?`,
					)
					.get(task.id) as
					| {
							compiler_request_count: number;
							reviewer_request_count: number;
							reviewer_cost_usd: number;
							reviewer_reserved_usd: number;
					  }
					| undefined;
				if (!state) throw new Error(`Task Authorization state not found: ${task.id}`);
				if (input.requestKind === "authorization_compile" && state.compiler_request_count >= 32)
					throw new Error("Authorization Compiler request limit exceeded");
				if (state.reviewer_request_count >= 128) throw new Error("Task Reviewer request limit exceeded");
				const attemptRequests = this.database
					.prepare(
						`SELECT COUNT(*) AS count FROM budget_reservations
						 WHERE attempt_id = ? AND request_kind IN ('authorization_compile', 'permission_review')`,
					)
					.get(attemptId) as { count: number };
				if (attemptRequests.count >= 32) throw new Error("Attempt Reviewer request limit exceeded");
				const mainAgentSettled = Math.max(0, task.totalCostUsd - state.reviewer_cost_usd);
				const reviewerCommitted = state.reviewer_cost_usd + state.reviewer_reserved_usd;
				const absoluteRemaining = 0.05 - reviewerCommitted;
				const shareRemaining = 0.002 + mainAgentSettled * 0.05 - reviewerCommitted;
				if (input.worstCaseCostUsd > Math.min(absoluteRemaining, shareRemaining))
					throw new Error("Reviewer cost budget exceeded");
			}
			const reservationId = randomUUID();
			const now = this.now().toISOString();
			this.database
				.prepare(
					`INSERT INTO budget_reservations
					 (id, task_id, agent_id, attempt_id, provider_request_id, reserved_turns, reserved_cost_usd,
					  request_kind, state, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
				)
				.run(
					reservationId,
					task.id,
					lease.agentId,
					attemptId,
					input.providerRequestId,
					reviewerRequest ? 0 : 1,
					input.worstCaseCostUsd ?? null,
					input.requestKind,
					now,
				);
			if (reviewerRequest) {
				this.database
					.prepare(
						`UPDATE task_authorization_state
						 SET compiler_request_count = compiler_request_count + ?,
						     reviewer_request_count = reviewer_request_count + 1,
						     reviewer_reserved_usd = reviewer_reserved_usd + ?,
						     startup_allowance_used = 1
						 WHERE task_id = ?`,
					)
					.run(input.requestKind === "authorization_compile" ? 1 : 0, input.worstCaseCostUsd ?? 0, task.id);
			}
			this.appendEventInternal(
				task.id,
				lease.agentId,
				attemptId,
				"BudgetReserved",
				{
					reservationId,
					providerRequestId: input.providerRequestId,
					requestKind: input.requestKind,
					worstCaseCostUsd: input.worstCaseCostUsd,
					schemaVersion: 1,
				},
				now,
			);
			if (reviewerRequest)
				this.appendEventInternal(
					task.id,
					lease.agentId,
					attemptId,
					"ReviewerBudgetReserved",
					{
						reservationId,
						providerRequestId: input.providerRequestId,
						requestKind: input.requestKind,
						worstCaseCostUsd: input.worstCaseCostUsd,
						schemaVersion: 1,
					},
					now,
				);
			this.appendEventInternal(
				task.id,
				lease.agentId,
				attemptId,
				"ProviderRequestStarted",
				{
					providerRequestId: input.providerRequestId,
					reservationId,
					provider: input.provider,
					modelId: input.modelId,
					requestKind: input.requestKind,
					executionId: lease.executionId,
					fencingToken: lease.fencingToken,
					schemaVersion: 1,
				},
				now,
			);
			if (reviewerRequest)
				this.appendEventInternal(
					task.id,
					lease.agentId,
					attemptId,
					"ReviewerRequestStarted",
					{
						providerRequestId: input.providerRequestId,
						reservationId,
						provider: input.provider,
						modelId: input.modelId,
						requestKind: input.requestKind,
						schemaVersion: 1,
					},
					now,
				);
			return reservationId;
		});
	}

	finishProviderRequest(
		lease: AgentLease,
		attemptId: string,
		input: {
			providerRequestId: string;
			reservationId: string;
			actualCostUsd: number;
			usage: Record<string, unknown>;
			stopReason: string;
		},
	): void {
		executeTransaction(this.database, () => {
			this.assertLeaseInternal(lease);
			const reservation = this.database
				.prepare(
					`SELECT task_id, agent_id, attempt_id, provider_request_id, reserved_cost_usd, request_kind
					 FROM budget_reservations
					 WHERE id = ? AND state = 'active'`,
				)
				.get(input.reservationId) as
				| {
						task_id: string;
						agent_id: string;
						attempt_id: string;
						provider_request_id: string;
						reserved_cost_usd: number | null;
						request_kind: string | null;
				  }
				| undefined;
			if (
				!reservation ||
				reservation.task_id !== lease.taskId ||
				reservation.agent_id !== lease.agentId ||
				reservation.attempt_id !== attemptId ||
				reservation.provider_request_id !== input.providerRequestId
			)
				throw new Error(`Active Provider reservation not found: ${input.reservationId}`);
			const reviewerRequest =
				reservation.request_kind === "authorization_compile" || reservation.request_kind === "permission_review";
			if (
				reviewerRequest &&
				(reservation.reserved_cost_usd === null || input.actualCostUsd > reservation.reserved_cost_usd + 1e-9)
			)
				throw new Error("Reviewer actual cost exceeded its reservation");
			const now = this.now().toISOString();
			this.database
				.prepare("UPDATE budget_reservations SET state = 'settled', settled_at = ? WHERE id = ?")
				.run(now, input.reservationId);
			this.database
				.prepare(
					`UPDATE tasks SET total_turns = total_turns + ?, total_cost_usd = total_cost_usd + ?,
					 updated_at = ? WHERE id = ?`,
				)
				.run(reviewerRequest ? 0 : 1, input.actualCostUsd, now, lease.taskId);
			this.database
				.prepare("UPDATE attempts SET turn_count = turn_count + ?, cost_usd = cost_usd + ? WHERE id = ?")
				.run(reviewerRequest ? 0 : 1, input.actualCostUsd, attemptId);
			if (reviewerRequest) {
				this.database
					.prepare(
						`UPDATE task_authorization_state
						 SET reviewer_cost_usd = reviewer_cost_usd + ?,
						     compiler_cost_usd = compiler_cost_usd + ?,
						     judge_cost_usd = judge_cost_usd + ?,
						     reviewer_reserved_usd = MAX(0, reviewer_reserved_usd - ?)
						 WHERE task_id = ?`,
					)
					.run(
						input.actualCostUsd,
						reservation.request_kind === "authorization_compile" ? input.actualCostUsd : 0,
						reservation.request_kind === "permission_review" ? input.actualCostUsd : 0,
						reservation.reserved_cost_usd,
						lease.taskId,
					);
			}
			this.appendEventInternal(
				lease.taskId,
				lease.agentId,
				attemptId,
				"ProviderRequestFinished",
				{
					providerRequestId: input.providerRequestId,
					reservationId: input.reservationId,
					actualCostUsd: input.actualCostUsd,
					usage: input.usage,
					usageKind: "exact",
					stopReason: input.stopReason,
					schemaVersion: 1,
				},
				now,
			);
			if (reviewerRequest)
				this.appendEventInternal(
					lease.taskId,
					lease.agentId,
					attemptId,
					"ReviewerRequestFinished",
					{
						providerRequestId: input.providerRequestId,
						reservationId: input.reservationId,
						requestKind: reservation.request_kind,
						actualCostUsd: input.actualCostUsd,
						usage: input.usage,
						stopReason: input.stopReason,
						schemaVersion: 1,
					},
					now,
				);
			this.appendEventInternal(
				lease.taskId,
				lease.agentId,
				attemptId,
				"BudgetSettled",
				{
					reservationId: input.reservationId,
					actualCostUsd: input.actualCostUsd,
					schemaVersion: 1,
				},
				now,
			);
			if (reviewerRequest)
				this.appendEventInternal(
					lease.taskId,
					lease.agentId,
					attemptId,
					"ReviewerBudgetSettled",
					{
						reservationId: input.reservationId,
						requestKind: reservation.request_kind,
						actualCostUsd: input.actualCostUsd,
						schemaVersion: 1,
					},
					now,
				);
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
			if (!this.hasPassedAcceptance(taskId, criterion.id))
				throw new Error(`Acceptance criterion has not passed: ${criterion.id}`);
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

	private listUnfinishedProviderRequestsInternal(taskId: string, agentId: string): UnfinishedProviderRequest[] {
		return (
			this.database
				.prepare(
					`SELECT id, attempt_id, provider_request_id FROM budget_reservations
					 WHERE task_id = ? AND agent_id = ? AND state = 'active' ORDER BY created_at`,
				)
				.all(taskId, agentId) as unknown as Array<{
				id: string;
				attempt_id: string;
				provider_request_id: string;
			}>
		).map((row) => ({
			reservationId: row.id,
			attemptId: row.attempt_id,
			providerRequestId: row.provider_request_id,
		}));
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
