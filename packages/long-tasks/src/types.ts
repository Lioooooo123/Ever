import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

export const TASK_STATES = [
	"draft",
	"queued",
	"running",
	"waiting_input",
	"waiting_external",
	"paused",
	"unknown_outcome",
	"completed",
	"failed",
	"cancelled",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const AGENT_STATES = [
	"created",
	"queued",
	"running",
	"recovering",
	"waiting_message",
	"waiting_external",
	"paused",
	"unknown_outcome",
	"completed",
	"failed",
	"cancelled",
] as const;

export type AgentState = (typeof AGENT_STATES)[number];
export type AgentKind = "main" | "subagent";
export type WorkspaceMode = "read_only_shared" | "isolated_worktree" | "primary";

export type DaemonCommandState = "received" | "dispatched" | "completed" | "uncertain" | "acknowledged";

export interface DaemonCommandRecord {
	clientId: string;
	commandId: string;
	commandType: string;
	payloadSha256: string;
	payload: Record<string, unknown>;
	state: DaemonCommandState;
	result?: Record<string, unknown>;
	error?: string;
	receivedAt: string;
	dispatchedAt?: string;
	completedAt?: string;
	acknowledgedAt?: string;
}

export interface ReceiveDaemonCommandInput {
	clientId: string;
	commandId: string;
	commandType: string;
	payloadSha256: string;
	payload: Record<string, unknown>;
}

export interface TaskCommandRecord {
	clientId: string;
	commandId: string;
	taskId: string;
	commandType: string;
	payloadSha256: string;
	payload: Record<string, unknown>;
	state: "dispatched" | "completed";
	result?: Record<string, unknown>;
	dispatchedAt: string;
	completedAt?: string;
}

export interface BeginTaskCommandInput {
	clientId: string;
	commandId: string;
	taskId: string;
	commandType: string;
	payloadSha256: string;
	payload: Record<string, unknown>;
}

export type ContinuationAction =
	| "continue"
	| "replan"
	| "wait_user"
	| "wait_external"
	| "pause_budget"
	| "pause_no_progress"
	| "complete"
	| "fail";

export interface ContinuationDecision {
	id: string;
	taskId: string;
	agentId: string;
	attemptId: string;
	settledTurnIndex: number;
	action: ContinuationAction;
	reasonCode: string;
	reason: string;
	progressFingerprint: string;
	nextPrompt?: string;
	nextWakeAt?: string;
	createdAt: string;
}

export interface ContinuationPolicy {
	maxIdenticalProgressTurns: number;
	pauseAfterIdenticalProgressTurns: number;
	maxRepeatedFailureTurns: number;
	pauseAfterRepeatedFailureTurns: number;
	maxAutomaticContinuationTurnsPerAttempt: number;
}

export const DEFAULT_CONTINUATION_POLICY: ContinuationPolicy = {
	maxIdenticalProgressTurns: 2,
	pauseAfterIdenticalProgressTurns: 3,
	maxRepeatedFailureTurns: 2,
	pauseAfterRepeatedFailureTurns: 3,
	maxAutomaticContinuationTurnsPerAttempt: 25,
};

export type ScheduleKind = "once" | "interval" | "cron" | "event";
export type ScheduleState = "active" | "paused" | "completed" | "cancelled";

export interface ScheduleRecord {
	id: string;
	taskId: string;
	agentId?: string;
	kind: ScheduleKind;
	expression: string;
	timezone: string;
	payload: Record<string, unknown>;
	state: ScheduleState;
	nextRunAt?: string;
	lastClaimId?: string;
	lastClaimedAt?: string;
	lastDeliveredAt?: string;
	lastEventSeq: number;
	createdAt: string;
	updatedAt: string;
}

export interface ScheduleClaim {
	schedule: ScheduleRecord;
	claimId: string;
	dueAt: string;
	missedCount: number;
	claimedAt: string;
}

export interface ScheduleEventTrigger {
	schedule: ScheduleRecord;
	event: TaskEvent;
}

export const AcceptanceCriterionSchema = Type.Union([
	Type.Object({
		id: Type.String({ minLength: 1 }),
		kind: Type.Literal("command"),
		command: Type.String({ minLength: 1 }),
		cwd: Type.String({ minLength: 1 }),
		timeoutSeconds: Type.Integer({ minimum: 1 }),
	}),
	Type.Object({
		id: Type.String({ minLength: 1 }),
		kind: Type.Literal("artifact"),
		path: Type.String({ minLength: 1 }),
		sha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
	}),
	Type.Object({
		id: Type.String({ minLength: 1 }),
		kind: Type.Literal("manual"),
		description: Type.String({ minLength: 1 }),
	}),
	Type.Object({
		id: Type.String({ minLength: 1 }),
		kind: Type.Literal("agent_evidence"),
		description: Type.String({ minLength: 1 }),
		minEvidence: Type.Integer({ minimum: 1 }),
	}),
]);

export type TaskNotificationKind = "completed" | "failed" | "waiting_input";

export interface TaskNotification {
	id: string;
	taskId: string;
	kind: TaskNotificationKind;
	title: string;
	body: string;
	createdAt: string;
}

export type AcceptanceCriterion = Static<typeof AcceptanceCriterionSchema>;

export const BudgetSchema = Type.Object({
	maxTurns: Type.Integer({ minimum: 1 }),
	maxWallTimeMinutes: Type.Integer({ minimum: 1 }),
	maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
	mode: Type.Optional(Type.Union([Type.Literal("hard"), Type.Literal("soft")])),
});

export type Budget = Static<typeof BudgetSchema>;

export const EvidenceRefSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	kind: Type.Union([Type.Literal("command"), Type.Literal("file"), Type.Literal("artifact"), Type.Literal("event")]),
	ref: Type.String({ minLength: 1 }),
	sha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
	summary: Type.Optional(Type.String()),
});

export type EvidenceRef = Static<typeof EvidenceRefSchema>;

export const AcceptanceResultSchema = Type.Object({
	criterionId: Type.String({ minLength: 1 }),
	passed: Type.Boolean(),
	evidence: Type.Optional(Type.Array(EvidenceRefSchema)),
	summary: Type.Optional(Type.String()),
});

export type AcceptanceResult = Static<typeof AcceptanceResultSchema>;

export const RuntimeSnapshotSchema = Type.Object({
	everVersion: Type.String(),
	upstreamCommit: Type.String(),
	protocolVersion: Type.Integer({ minimum: 1 }),
	model: Type.Object({
		provider: Type.String(),
		id: Type.String(),
		thinkingLevel: Type.Optional(Type.String()),
	}),
	systemPromptSha256: Type.String(),
	contextFiles: Type.Array(Type.Object({ path: Type.String(), sha256: Type.String() })),
	resources: Type.Array(
		Type.Object({
			kind: Type.Union([
				Type.Literal("skill"),
				Type.Literal("extension"),
				Type.Literal("prompt"),
				Type.Literal("tool"),
			]),
			identity: Type.String(),
			version: Type.Optional(Type.String()),
			sha256: Type.String(),
		}),
	),
	toolPolicySha256: Type.String(),
	sandboxPolicySha256: Type.String(),
});

export type RuntimeSnapshot = Static<typeof RuntimeSnapshotSchema>;

export const SessionCheckpointSchema = Type.Object({
	sessionId: Type.String(),
	sessionPath: Type.Optional(Type.String()),
	leafEntryId: Type.Optional(Type.String()),
	settledTurnIndex: Type.Integer({ minimum: 0 }),
	runtimeSnapshotSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	createdAt: Type.String(),
});

export type SessionCheckpoint = Static<typeof SessionCheckpointSchema>;

export const ProgressSchema = Type.Object({
	summary: Type.String({ maxLength: 4000 }),
	completedItems: Type.Array(Type.String()),
	currentItem: Type.Optional(Type.String()),
	nextActions: Type.Array(Type.String()),
	blockers: Type.Array(Type.String()),
	filesRead: Type.Array(Type.String()),
	filesModified: Type.Array(Type.String()),
	verification: Type.Array(
		Type.Object({
			command: Type.Optional(Type.String()),
			result: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_run")]),
			artifactRef: Type.Optional(Type.String()),
		}),
	),
	consumedMessageIds: Type.Array(Type.String()),
	outboundMessageIds: Type.Array(Type.String()),
});

export type Progress = Static<typeof ProgressSchema>;

export interface TaskRecord {
	id: string;
	title: string;
	goal: string;
	acceptance: AcceptanceCriterion[];
	constraints: Record<string, unknown>;
	budget: Budget;
	state: TaskState;
	stateReason?: string;
	workspaceRoot: string;
	workspaceFingerprint: string;
	initialGitHead?: string;
	totalTurns: number;
	totalCostUsd: number;
	nextWakeAt?: string;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

export interface AgentRecord {
	id: string;
	taskId: string;
	parentAgentId?: string;
	kind: AgentKind;
	name: string;
	role: string;
	objective: string;
	state: AgentState;
	depth: 0 | 1;
	activeSessionId?: string;
	workspaceMode: WorkspaceMode;
	workspaceRoot: string;
	toolPolicy: ToolPolicy;
	budget: Budget;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

export interface TaskEvent {
	id: string;
	taskId: string;
	agentId?: string;
	attemptId?: string;
	seq: number;
	type: string;
	payload: Record<string, unknown>;
	createdAt: string;
}

export interface ToolPolicy {
	allowedTools: string[];
	allowedPaths: string[];
	readOnly: boolean;
	sandboxRequired: boolean;
}

export interface CreateTaskInput {
	title: string;
	goal: string;
	acceptance: AcceptanceCriterion[];
	constraints?: Record<string, unknown>;
	budget: Budget;
	workspaceRoot: string;
	workspaceFingerprint: string;
	initialGitHead?: string;
	toolPolicy?: ToolPolicy;
}

export interface AgentIdentity {
	taskId: string;
	agentId: string;
	kind: AgentKind;
	parentAgentId?: string;
}

export interface AgentLease {
	agentId: string;
	taskId: string;
	workerId: string;
	executionId: string;
	fencingToken: number;
	expiresAt: string;
}

export interface StaleExecution {
	agentId: string;
	taskId: string;
	workerId: string;
	executionId: string;
	fencingToken: number;
	expiresAt: string;
	pid?: number;
	sandboxId?: string;
}

export interface UnfinishedToolExecution {
	toolCallId: string;
	toolName: string;
	effect: "read_only" | "reconcilable_write" | "process" | "external_side_effect";
	executionId?: string;
	fencingToken?: number;
}

export interface UnfinishedProviderRequest {
	providerRequestId: string;
	reservationId: string;
	attemptId: string;
}

export interface WorkspaceSnapshot {
	baseCommit: string;
	trackedPatchArtifact: string;
	trackedPatchSha256: string;
	untrackedFiles: Array<{
		relativePath: string;
		artifactRef: string;
		sha256: string;
	}>;
	excludedPaths: string[];
	createdAt: string;
}

export interface AttemptRecord {
	id: string;
	taskId: string;
	agentId: string;
	sessionId?: string;
	ordinal: number;
	state: string;
	runtimeSnapshot: RuntimeSnapshot;
	runtimeSnapshotSha256: string;
	startedAt: string;
	settledAt?: string;
	turnCount: number;
	costUsd: number;
	errorCode?: string;
}

/** Opaque capability returned by the Task Control Plane for one running Attempt. */
export interface ClaimedAttempt {
	readonly token: string;
}

/** Internal execution facts resolved from a valid Attempt claim. */
export interface AttemptClaimContext {
	task: TaskRecord;
	agent: AgentRecord;
	attempt: AttemptRecord;
	lease: AgentLease;
	deadlineAt: string;
}

export type AttemptOutcome =
	| { kind: "settled"; taskId: string; attemptId: string }
	| { kind: "waiting"; taskId: string; attemptId: string; reason: string }
	| { kind: "paused"; taskId: string; attemptId: string; reason: string }
	| { kind: "completed"; taskId: string; attemptId: string }
	| { kind: "failed"; taskId: string; attemptId: string; reason: string }
	| { kind: "unknown_outcome"; taskId: string; attemptId: string; reason: string };

export interface CheckpointRecord {
	id: string;
	taskId: string;
	agentId: string;
	attemptId: string;
	eventSeq: number;
	sessionCheckpoint: SessionCheckpoint;
	progress: Progress;
	evidence: EvidenceRef[];
	workspaceSnapshot: Record<string, unknown>;
	runtimeSnapshotSha256: string;
	createdAt: string;
}

export interface DelegateCommand {
	type: "delegate";
	operationKey: string;
	name: string;
	role: string;
	objective: string;
	acceptance: AcceptanceCriterion[];
	scope: {
		paths: string[];
		allowedTools: string[];
		workspaceMode: Exclude<WorkspaceMode, "primary">;
	};
	budget: Budget;
	required: boolean;
}

export interface MessageCommand {
	type: "message";
	operationKey: string;
	recipientAgentId: string;
	messageType: "directive" | "question" | "response" | "progress" | "result" | "steering" | "cancellation";
	body: string;
	replyToMessageId?: string;
	artifactRefs?: string[];
	priority?: "normal" | "high";
}

export interface ReportCommand {
	type: "report";
	operationKey: string;
	status: "progress" | "completed" | "failed";
	summary: string;
	evidence: EvidenceRef[];
	blockers?: string[];
	acceptanceResults?: AcceptanceResult[];
}

export type CoordinationCommand = DelegateCommand | MessageCommand | ReportCommand;

export type CoordinationResult =
	| { kind: "delegated"; delegationId: string; agentId: string; replayed: boolean }
	| { kind: "message"; messageId: string; replayed: boolean }
	| { kind: "report"; messageId: string; agentState: AgentState; replayed: boolean };

export interface InboxMessage {
	id: string;
	taskId: string;
	senderAgentId: string;
	recipientAgentId: string;
	senderSeq: number;
	type: MessageCommand["messageType"];
	priority: "normal" | "high";
	body: string;
	artifactRefs: string[];
	replyToMessageId?: string;
	createdAt: string;
}

export interface InboxBatch {
	messages: InboxMessage[];
}

export interface AgentCheckpointCommit {
	taskId: string;
	agentId: string;
	attemptId: string;
	lease: AgentLease;
	sessionCheckpoint: SessionCheckpoint;
	progress: Progress;
	evidence: EvidenceRef[];
	workspaceSnapshot: Record<string, unknown>;
}

export interface AgentCoordinator {
	coordinate(actor: AgentIdentity, command: CoordinationCommand): Promise<CoordinationResult>;
	claimInbox(agentId: string, lease: AgentLease, limit: number): Promise<InboxBatch>;
	commitCheckpoint(input: AgentCheckpointCommit): Promise<void>;
}

const validators = {
	acceptance: Compile(Type.Array(AcceptanceCriterionSchema)),
	budget: Compile(BudgetSchema),
	evidence: Compile(Type.Array(EvidenceRefSchema)),
	progress: Compile(ProgressSchema),
	runtimeSnapshot: Compile(RuntimeSnapshotSchema),
	sessionCheckpoint: Compile(SessionCheckpointSchema),
};

export type JsonSchemaName = keyof typeof validators;

export function assertSchema(name: JsonSchemaName, value: unknown): void {
	const validator = validators[name];
	if (validator.Check(value)) return;
	const detail = [...validator.Errors(value)]
		.slice(0, 3)
		.map((error) => `${error.instancePath || "/"}: ${error.message}`)
		.join("; ");
	throw new TypeError(`Invalid ${name} JSON: ${detail}`);
}
