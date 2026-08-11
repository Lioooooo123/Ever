import { createHash } from "node:crypto";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	AcceptanceCriterionSchema,
	AcceptanceResultSchema,
	AcceptanceRunner,
	type AgentRecord,
	DurableAgentCoordinator,
	EvidenceRefSchema,
	ExecutionPolicy,
	SqliteTaskStore,
	TaskContextBuilder,
	TaskController,
	WorkspaceAllocator,
} from "@karissa/long-tasks";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import {
	checkpointLongTaskBeforeCompaction,
	claimLongTaskInbox,
	reserveLongTaskProviderBudget,
} from "../../core/long-task-runtime.ts";

function operationKey(taskId: string, agentId: string, sessionEntryId: string, toolCallId: string): string {
	return createHash("sha256").update(`${taskId}\0${agentId}\0${sessionEntryId}\0${toolCallId}`).digest("hex");
}

function textResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

function xml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function openStore(): SqliteTaskStore {
	const agentDir = getAgentDir();
	return SqliteTaskStore.open({
		databasePath: join(agentDir, "long-tasks.sqlite"),
		artifactsRoot: join(agentDir, "tasks"),
	});
}

function resolveActor(store: SqliteTaskStore, taskId: string): AgentRecord {
	const requestedAgentId = process.env.KARISSA_AGENT_RUN_ID;
	const agents = store.listAgents(taskId);
	const actor = requestedAgentId
		? agents.find((agent) => agent.id === requestedAgentId)
		: agents.find((agent) => agent.kind === "main");
	if (!actor) throw new Error(`No active Agent found for Task ${taskId}`);
	return actor;
}

export default function longTasksExtension(pi: ExtensionAPI): void {
	const taskId = process.env.KARISSA_TASK_RUN_ID;
	if (!taskId) return;

	pi.on("before_agent_start", async (event, ctx) => {
		const store = openStore();
		try {
			const task = store.requireTask(taskId);
			const actor = resolveActor(store, taskId);
			const checkpoint = store.getLatestCheckpoint(actor.id);
			const context = new TaskContextBuilder().build({
				task,
				agent: actor,
				progress: checkpoint?.progress,
				evidence: checkpoint?.evidence ?? [],
				agents: store.listAgents(taskId),
			});
			const inbox = claimLongTaskInbox(ctx.sessionManager.getSessionId());
			const inboxContext = inbox.length
				? `\n<agent_inbox>\n${inbox
						.map(
							(message) =>
								`<message id="${xml(message.id)}" from="${xml(message.senderAgentId)}" type="${xml(message.type)}"${message.replyToMessageId ? ` reply_to="${xml(message.replyToMessageId)}"` : ""}>${xml(message.body)}</message>`,
						)
						.join("\n")}\n</agent_inbox>`
				: "";
			return { systemPrompt: `${event.systemPrompt}\n\n${context}${inboxContext}` };
		} finally {
			store.close();
		}
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		const accepted = await checkpointLongTaskBeforeCompaction(ctx.sessionManager.getSessionId());
		return accepted ? undefined : { cancel: true };
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		reserveLongTaskProviderBudget(ctx.sessionManager.getSessionId());
	});

	pi.on("tool_call", async (event) => {
		const store = openStore();
		try {
			const actor = resolveActor(store, taskId);
			const effect =
				event.toolName === "bash"
					? "process"
					: ["edit", "write"].includes(event.toolName)
						? "reconcilable_write"
						: ["read", "grep", "find", "ls"].includes(event.toolName)
							? "read_only"
							: "external_side_effect";
			const input = event.input as Record<string, unknown>;
			const paths = [input.path, input.cwd].filter((value): value is string => typeof value === "string");
			const decision = new ExecutionPolicy().authorizeTool(
				actor,
				{ name: event.toolName, paths, effect },
				{
					sandboxAvailable: process.env.KARISSA_UNATTENDED_SANDBOX === "1",
					unattended: process.env.KARISSA_DAEMON_WORKER === "1",
					unsafeNoSandbox: process.env.KARISSA_UNSAFE_NO_SANDBOX === "1",
				},
			);
			if (decision.allowed) return undefined;
			store.appendTaskEvent(taskId, "SecurityPolicyDenied", {
				agentId: actor.id,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				reason: decision.reason,
				schemaVersion: 1,
			});
			return { block: true, reason: decision.reason, terminate: true };
		} finally {
			store.close();
		}
	});

	pi.on("session_compact", async (event) => {
		const store = openStore();
		try {
			store.appendTaskEvent(taskId, "CompactionFinished", {
				compactionEntryId: event.compactionEntry.id,
				reason: event.reason,
				schemaVersion: 1,
			});
		} finally {
			store.close();
		}
	});

	pi.registerTool({
		name: "task_update",
		label: "Task Update",
		description: "Checkpoint progress, wait, request completion, or fail the current durable Task.",
		parameters: Type.Union([
			Type.Object({
				action: Type.Literal("checkpoint"),
				summary: Type.String({ maxLength: 4000 }),
				completedItems: Type.Array(Type.String()),
				currentItem: Type.Optional(Type.String()),
				nextActions: Type.Array(Type.String()),
				evidence: Type.Array(EvidenceRefSchema),
			}),
			Type.Object({
				action: Type.Literal("wait"),
				waitKind: Type.Union([Type.Literal("user"), Type.Literal("time"), Type.Literal("external")]),
				reason: Type.String(),
				resumeAt: Type.Optional(Type.String()),
			}),
			Type.Object({
				action: Type.Literal("complete"),
				summary: Type.String(),
				evidence: Type.Array(EvidenceRefSchema),
			}),
			Type.Object({ action: Type.Literal("fail"), code: Type.String(), reason: Type.String() }),
		]),
		async execute(_toolCallId, params) {
			const store = openStore();
			try {
				const actor = resolveActor(store, taskId);
				if (actor.kind !== "main") throw new Error("Only the main Agent may update the Task");
				const controller = new TaskController(store);
				if (params.action === "checkpoint") {
					store.appendTaskEvent(taskId, "CheckpointRequested", { ...params, agentId: actor.id, schemaVersion: 1 });
					return textResult({ accepted: true, state: store.requireTask(taskId).state });
				}
				if (params.action === "wait") {
					if (params.resumeAt) store.setNextWakeAt(taskId, params.resumeAt);
					const state = params.waitKind === "user" ? "waiting_input" : "waiting_external";
					return textResult({ accepted: true, state: store.transitionTask(taskId, state, params.reason).state });
				}
				if (params.action === "complete") {
					store.appendTaskEvent(taskId, "AcceptanceRequested", {
						summary: params.summary,
						evidence: params.evidence,
						schemaVersion: 1,
					});
					for (const criterion of store.requireTask(taskId).acceptance) {
						if (criterion.kind !== "agent_evidence") continue;
						store.recordAcceptance(taskId, criterion.id, params.evidence.length >= criterion.minEvidence, {
							summary: params.summary,
							evidence: params.evidence,
						});
					}
					const acceptance = new AcceptanceRunner(store).runAutomated(taskId);
					if (acceptance.failed.length > 0 || acceptance.pendingManual.length > 0) {
						return textResult({ accepted: false, state: store.requireTask(taskId).state, acceptance });
					}
					const completed = controller.requestCompletion(taskId);
					store.transitionAgent(actor.id, "completed", "task_completed");
					return textResult({ accepted: true, state: completed.state });
				}
				return textResult({ accepted: true, state: controller.fail(taskId, params.code).state });
			} finally {
				store.close();
			}
		},
	});

	pi.registerTool({
		name: "delegate_task",
		label: "Delegate Task",
		description: "Create a persistent, directly supervised subagent with a bounded scope and budget.",
		parameters: Type.Object({
			name: Type.String(),
			role: Type.String(),
			objective: Type.String(),
			acceptance: Type.Array(AcceptanceCriterionSchema),
			scope: Type.Object({
				paths: Type.Array(Type.String()),
				allowedTools: Type.Array(Type.String()),
				workspaceMode: Type.Union([Type.Literal("read_only_shared"), Type.Literal("isolated_worktree")]),
			}),
			budget: Type.Object({
				maxTurns: Type.Integer({ minimum: 1 }),
				maxWallTimeMinutes: Type.Integer({ minimum: 1 }),
				maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
			}),
			required: Type.Boolean(),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const store = openStore();
			try {
				const actor = resolveActor(store, taskId);
				const leaf = ctx.sessionManager.getLeafId() ?? "root";
				const task = store.requireTask(taskId);
				const workspaceAllocator = new WorkspaceAllocator({
					worktreesRoot: join(getAgentDir(), "worktrees", task.workspaceFingerprint),
					artifactsRoot: join(getAgentDir(), "tasks", taskId, "artifacts", "workspace-snapshots"),
				});
				const result = await new DurableAgentCoordinator(store, { workspaceAllocator }).coordinate(
					{
						taskId,
						agentId: actor.id,
						kind: actor.kind,
						...(actor.parentAgentId ? { parentAgentId: actor.parentAgentId } : {}),
					},
					{ type: "delegate", operationKey: operationKey(taskId, actor.id, leaf, toolCallId), ...params },
				);
				return textResult(result);
			} finally {
				store.close();
			}
		},
	});

	pi.registerTool({
		name: "message_agent",
		label: "Message Agent",
		description: "Send a durable message to the main Agent or one of its direct subagents.",
		parameters: Type.Object({
			recipientAgentId: Type.String(),
			type: Type.Union([
				Type.Literal("directive"),
				Type.Literal("question"),
				Type.Literal("response"),
				Type.Literal("progress"),
				Type.Literal("result"),
				Type.Literal("steering"),
				Type.Literal("cancellation"),
			]),
			body: Type.String({ maxLength: 16_384 }),
			replyToMessageId: Type.Optional(Type.String()),
			artifactRefs: Type.Optional(Type.Array(Type.String())),
			priority: Type.Optional(Type.Union([Type.Literal("normal"), Type.Literal("high")])),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const store = openStore();
			try {
				const actor = resolveActor(store, taskId);
				const leaf = ctx.sessionManager.getLeafId() ?? "root";
				const result = await new DurableAgentCoordinator(store).coordinate(
					{
						taskId,
						agentId: actor.id,
						kind: actor.kind,
						...(actor.parentAgentId ? { parentAgentId: actor.parentAgentId } : {}),
					},
					{
						type: "message",
						operationKey: operationKey(taskId, actor.id, leaf, toolCallId),
						recipientAgentId: params.recipientAgentId,
						messageType: params.type,
						body: params.body,
						...(params.replyToMessageId ? { replyToMessageId: params.replyToMessageId } : {}),
						artifactRefs: params.artifactRefs ?? [],
						priority: params.priority ?? "normal",
					},
				);
				return textResult(result);
			} finally {
				store.close();
			}
		},
	});

	pi.registerTool({
		name: "report_to_parent",
		label: "Report to Parent",
		description: "Submit durable progress or a final evidence-backed result to the parent Agent.",
		parameters: Type.Object({
			status: Type.Union([Type.Literal("progress"), Type.Literal("completed"), Type.Literal("failed")]),
			summary: Type.String({ maxLength: 4000 }),
			evidence: Type.Array(EvidenceRefSchema),
			blockers: Type.Optional(Type.Array(Type.String())),
			acceptanceResults: Type.Optional(Type.Array(AcceptanceResultSchema)),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const store = openStore();
			try {
				const actor = resolveActor(store, taskId);
				const leaf = ctx.sessionManager.getLeafId() ?? "root";
				const result = await new DurableAgentCoordinator(store).coordinate(
					{
						taskId,
						agentId: actor.id,
						kind: actor.kind,
						...(actor.parentAgentId ? { parentAgentId: actor.parentAgentId } : {}),
					},
					{ type: "report", operationKey: operationKey(taskId, actor.id, leaf, toolCallId), ...params },
				);
				return textResult(result);
			} finally {
				store.close();
			}
		},
	});
}
