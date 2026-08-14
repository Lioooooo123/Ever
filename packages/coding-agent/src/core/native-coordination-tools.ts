import { join } from "node:path";
import { Type } from "@lioooooo123/ever-ai";
import {
	AcceptanceCriterionSchema,
	BudgetSchema,
	DurableAgentCoordinator,
	DurableFlowCoordinator,
	EvidenceRefSchema,
	type FlowDefinition,
	SqliteTaskStore,
	WorkspaceAllocator,
} from "@lioooooo123/ever-long-tasks";
import { requestDaemon, startDaemon } from "../cli/daemon-command.ts";
import { defineTool, type ToolDefinition } from "./extensions/types.ts";

const MessageTypeSchema = Type.Union([
	Type.Literal("directive"),
	Type.Literal("question"),
	Type.Literal("response"),
	Type.Literal("progress"),
	Type.Literal("result"),
	Type.Literal("steering"),
	Type.Literal("cancellation"),
]);

export const FlowDefinitionSchema = Type.Object({
	objective: Type.String({ minLength: 1, maxLength: 8000 }),
	nodes: Type.Array(
		Type.Object({
			key: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
			name: Type.String({ minLength: 1, maxLength: 80 }),
			role: Type.String({ minLength: 1, maxLength: 200 }),
			objective: Type.String({ minLength: 1, maxLength: 8000 }),
			dependsOn: Type.Array(Type.String()),
			acceptance: Type.Array(AcceptanceCriterionSchema),
			scope: Type.Object({
				paths: Type.Array(Type.String({ minLength: 1 })),
				allowedTools: Type.Array(Type.String({ minLength: 1 })),
				workspaceMode: Type.Union([Type.Literal("read_only_shared"), Type.Literal("isolated_worktree")]),
			}),
			budget: BudgetSchema,
			required: Type.Boolean(),
		}),
		{ minItems: 1, maxItems: 32 },
	),
});

function textResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

function openStore(agentDir: string): SqliteTaskStore {
	return SqliteTaskStore.open({
		databasePath: join(agentDir, "long-tasks.sqlite"),
		artifactsRoot: join(agentDir, "tasks"),
	});
}

function workspaceAllocator(agentDir: string): WorkspaceAllocator {
	return new WorkspaceAllocator({
		worktreesRoot: join(agentDir, "worktrees"),
		artifactsRoot: join(agentDir, "tasks"),
	});
}

export function defineFlowForTask(agentDir: string, taskId: string, agentId: string, definition: FlowDefinition) {
	const store = openStore(agentDir);
	try {
		const actor = store.requireAgent(agentId);
		return new DurableFlowCoordinator(store, {
			workspaceAllocator: workspaceAllocator(agentDir),
		}).define({ taskId, agentId, kind: actor.kind }, definition);
	} finally {
		store.close();
	}
}

export function getFlowStatus(agentDir: string, taskId: string) {
	const store = openStore(agentDir);
	try {
		const flow = store.getLatestFlow(taskId);
		return flow ? { flow, episodes: store.listEpisodes({ taskId, flowId: flow.id }) } : { flow: undefined };
	} finally {
		store.close();
	}
}

function resolveRecipient(store: SqliteTaskStore, taskId: string, reference: string) {
	const agents = store.listAgents(taskId);
	const exact = agents.find((agent) => agent.id === reference || agent.activeSessionId === reference);
	if (exact) return exact;
	const named = agents.filter((agent) => agent.name === reference);
	if (named.length === 1) return named[0]!;
	if (named.length > 1) throw new Error(`Recipient is missing or ambiguous: ${reference}`);
	const matches = agents.filter(
		(agent) => agent.id.startsWith(reference) || agent.activeSessionId?.startsWith(reference),
	);
	if (matches.length !== 1) throw new Error(`Recipient is missing or ambiguous: ${reference}`);
	return matches[0]!;
}

export const NATIVE_COORDINATION_TOOL_NAMES = [
	"agent_spawn",
	"agent_message",
	"agent_inbox",
	"agent_report",
	"flow_define",
	"flow_status",
] as const;

export function createNativeCoordinationTools(agentDir: string, taskId: string, agentId: string): ToolDefinition[] {
	return [
		defineTool({
			name: "agent_spawn",
			label: "Spawn Agent",
			description:
				"Start an independent child Agent Session with an explicit scope, budget, and acceptance contract.",
			promptSnippet: "agent_spawn: delegate bounded work to an independent Agent Session",
			parameters: Type.Object({
				name: Type.String({ minLength: 1, maxLength: 80 }),
				role: Type.String({ minLength: 1, maxLength: 200 }),
				objective: Type.String({ minLength: 1, maxLength: 8000 }),
				acceptance: Type.Array(AcceptanceCriterionSchema),
				paths: Type.Array(Type.String({ minLength: 1 })),
				allowedTools: Type.Array(Type.String({ minLength: 1 })),
				workspaceMode: Type.Union([Type.Literal("read_only_shared"), Type.Literal("isolated_worktree")]),
				budget: BudgetSchema,
				required: Type.Boolean(),
			}),
			async execute(toolCallId, params) {
				const store = openStore(agentDir);
				try {
					const actor = store.requireAgent(agentId);
					const result = await new DurableAgentCoordinator(store, {
						workspaceAllocator: workspaceAllocator(agentDir),
					}).coordinate(
						{ taskId, agentId, kind: actor.kind },
						{
							type: "delegate",
							operationKey: toolCallId,
							name: params.name,
							role: params.role,
							objective: params.objective,
							acceptance: params.acceptance,
							scope: {
								paths: params.paths,
								allowedTools: params.allowedTools,
								workspaceMode: params.workspaceMode,
							},
							budget: params.budget,
							required: params.required,
						},
					);
					await startDaemon(agentDir);
					const wake = await requestDaemon(agentDir, { command: "wake", taskId });
					if (!wake.ok) throw new Error(wake.message ?? "Daemon rejected Agent dispatch");
					return textResult(result);
				} finally {
					store.close();
				}
			},
		}),
		defineTool({
			name: "agent_message",
			label: "Session Message",
			description:
				"Send a durable message to another Agent Session in the current Task, including sibling Sessions.",
			promptSnippet: "agent_message: communicate with another Task Agent by Agent or Session id",
			parameters: Type.Object({
				recipient: Type.String({ minLength: 1 }),
				messageType: MessageTypeSchema,
				body: Type.String({ minLength: 1, maxLength: 16384 }),
				artifactRefs: Type.Optional(Type.Array(Type.String())),
				priority: Type.Optional(Type.Union([Type.Literal("normal"), Type.Literal("high")])),
			}),
			async execute(toolCallId, params) {
				const store = openStore(agentDir);
				try {
					const actor = store.requireAgent(agentId);
					const recipient = resolveRecipient(store, taskId, params.recipient);
					const result = await new DurableAgentCoordinator(store).coordinate(
						{ taskId, agentId, kind: actor.kind },
						{
							type: "message",
							operationKey: toolCallId,
							recipientAgentId: recipient.id,
							messageType: params.messageType,
							body: params.body,
							artifactRefs: params.artifactRefs ?? [],
							priority: params.priority ?? "normal",
						},
					);
					return textResult({
						...result,
						recipientAgentId: recipient.id,
						recipientSessionId: recipient.activeSessionId,
					});
				} finally {
					store.close();
				}
			},
		}),
		defineTool({
			name: "agent_inbox",
			label: "Session Inbox",
			description: "Read or explicitly acknowledge durable messages addressed to the current Agent Session.",
			promptSnippet: "agent_inbox: inspect Task Agent messages and Handoffs",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("read"), Type.Literal("acknowledge")]),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
				messageIds: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
			}),
			async execute(_toolCallId, params) {
				const store = openStore(agentDir);
				try {
					if (params.action === "acknowledge") {
						if (!params.messageIds?.length)
							throw new Error("messageIds are required to acknowledge Agent messages");
						store.acknowledgeAgentInbox(agentId, params.messageIds);
						return textResult({ acknowledged: params.messageIds });
					}
					return textResult(store.readAgentInbox(agentId, params.limit ?? 50));
				} finally {
					store.close();
				}
			},
		}),
		defineTool({
			name: "agent_report",
			label: "Agent Report",
			description: "Persist an Episode and report progress or a verified terminal Handoff to the parent Agent.",
			promptSnippet: "agent_report: persist a structured Episode and Handoff to the parent Agent",
			parameters: Type.Object({
				status: Type.Union([Type.Literal("progress"), Type.Literal("completed"), Type.Literal("failed")]),
				summary: Type.String({ minLength: 1, maxLength: 8000 }),
				evidence: Type.Array(EvidenceRefSchema),
				blockers: Type.Optional(Type.Array(Type.String())),
				acceptanceResults: Type.Optional(
					Type.Array(
						Type.Object({
							criterionId: Type.String({ minLength: 1 }),
							passed: Type.Boolean(),
							details: Type.Optional(Type.String()),
						}),
					),
				),
			}),
			async execute(toolCallId, params) {
				const store = openStore(agentDir);
				try {
					const actor = store.requireAgent(agentId);
					const result = await new DurableAgentCoordinator(store).coordinate(
						{ taskId, agentId, kind: actor.kind },
						{
							type: "report",
							operationKey: toolCallId,
							status: params.status,
							summary: params.summary,
							evidence: params.evidence,
							blockers: params.blockers ?? [],
							acceptanceResults: params.acceptanceResults ?? [],
						},
					);
					return { ...textResult(result), terminate: params.status !== "progress" };
				} finally {
					store.close();
				}
			},
		}),
		defineTool({
			name: "flow_define",
			label: "Define Flow",
			description: "Atomically define and validate a dependency DAG of independent Agent Sessions.",
			promptSnippet: "flow_define: create a validated DAG; independent nodes run concurrently",
			parameters: FlowDefinitionSchema,
			async execute(_toolCallId, params) {
				return textResult(defineFlowForTask(agentDir, taskId, agentId, params as FlowDefinition));
			},
		}),
		defineTool({
			name: "flow_status",
			label: "Flow Status",
			description: "Inspect the current Flow graph, node Sessions, states, and persisted Episodes.",
			promptSnippet: "flow_status: inspect DAG progress and node Handoffs",
			parameters: Type.Object({}),
			async execute() {
				return textResult(getFlowStatus(agentDir, taskId));
			},
		}),
	];
}
