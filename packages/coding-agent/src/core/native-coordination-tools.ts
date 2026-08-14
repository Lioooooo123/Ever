import { Type } from "@lioooooo123/ever-ai";
import {
	AcceptanceCriterionSchema,
	BudgetSchema,
	EvidenceRefSchema,
	type FlowDefinition,
} from "@lioooooo123/ever-long-tasks";
import { type CoordinationActor, DurableCoordination } from "./durable-coordination.ts";
import { defineTool, type ExtensionContext, type ToolDefinition } from "./extensions/types.ts";

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

export async function defineFlowForTask(agentDir: string, taskId: string, agentId: string, definition: FlowDefinition) {
	return new DurableCoordination(agentDir, { taskId, agentId }).submit({
		type: "flow",
		operationKey: `flow:${taskId}`,
		definition,
	});
}

export function getFlowStatus(agentDir: string, taskId: string, agentId: string) {
	const snapshot = new DurableCoordination(agentDir, { taskId, agentId }).snapshot();
	return snapshot.flow ? { flow: snapshot.flow, episodes: snapshot.episodes ?? [] } : { flow: undefined };
}

export const NATIVE_COORDINATION_TOOL_NAMES = [
	"agent_spawn",
	"agent_dispatch",
	"agent_message",
	"agent_inbox",
	"agent_report",
	"flow_define",
	"flow_status",
] as const;

export type CoordinationToolIntent = "spawn" | "existing";
export type CoordinationActorResolver = (
	intent: CoordinationToolIntent,
	ctx: ExtensionContext,
) => CoordinationActor | Promise<CoordinationActor>;

export function createDurableCoordinationTools(
	agentDir: string,
	resolveActor: CoordinationActorResolver,
): ToolDefinition[] {
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
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				const actor = await resolveActor("spawn", ctx);
				return textResult(
					await new DurableCoordination(agentDir, actor).submit({
						type: "spawn",
						operationKey: toolCallId,
						name: params.name,
						role: params.role,
						action: params.objective,
						acceptance: params.acceptance,
						paths: params.paths,
						allowedTools: params.allowedTools,
						workspaceMode: params.workspaceMode,
						budget: params.budget,
						required: params.required,
					}),
				);
			},
		}),
		defineTool({
			name: "agent_dispatch",
			label: "Dispatch Agent",
			description: "Dispatch fresh work to an existing named Agent using retained Episodes, not its old transcript.",
			promptSnippet: "agent_dispatch: send a fresh action to an existing named Agent",
			parameters: Type.Object({
				agent: Type.String({ minLength: 1 }),
				action: Type.String({ minLength: 1, maxLength: 8000 }),
				sourceAgents: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 32 })),
			}),
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				const actor = await resolveActor("existing", ctx);
				return textResult(
					await new DurableCoordination(agentDir, actor).submit({
						type: "dispatch",
						operationKey: toolCallId,
						agent: params.agent,
						action: params.action,
						sourceAgents: params.sourceAgents ?? [],
					}),
				);
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
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				const actor = await resolveActor("existing", ctx);
				return textResult(
					await new DurableCoordination(agentDir, actor).send({
						dedupeKey: toolCallId,
						recipient: params.recipient,
						messageType: params.messageType,
						body: params.body,
						artifactRefs: params.artifactRefs ?? [],
						priority: params.priority ?? "normal",
					}),
				);
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
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const actor = await resolveActor("existing", ctx);
				const coordination = new DurableCoordination(agentDir, actor);
				if (params.action === "acknowledge") {
					if (!params.messageIds?.length) throw new Error("messageIds are required to acknowledge Agent messages");
					return textResult(coordination.inbox({ action: "acknowledge", messageIds: params.messageIds }));
				}
				return textResult(coordination.inbox({ action: "read", limit: params.limit ?? 50 }));
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
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				const actorIdentity = await resolveActor("existing", ctx);
				const result = await new DurableCoordination(agentDir, actorIdentity).report(toolCallId, {
					status: params.status,
					summary: params.summary,
					evidence: params.evidence,
					blockers: params.blockers ?? [],
					acceptanceResults: params.acceptanceResults ?? [],
				});
				return { ...textResult(result), terminate: params.status !== "progress" };
			},
		}),
		defineTool({
			name: "flow_define",
			label: "Define Flow",
			description: "Atomically define and validate a dependency DAG of independent Agent Sessions.",
			promptSnippet: "flow_define: create a validated DAG; independent nodes run concurrently",
			parameters: FlowDefinitionSchema,
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				const actor = await resolveActor("existing", ctx);
				return textResult(
					await new DurableCoordination(agentDir, actor).submit({
						type: "flow",
						operationKey: toolCallId,
						definition: params as FlowDefinition,
					}),
				);
			},
		}),
		defineTool({
			name: "flow_status",
			label: "Flow Status",
			description: "Inspect the current Flow graph, node Sessions, states, and persisted Episodes.",
			promptSnippet: "flow_status: inspect DAG progress and node Handoffs",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				const actor = await resolveActor("existing", ctx);
				return textResult(new DurableCoordination(agentDir, actor).snapshot());
			},
		}),
	];
}

export function createNativeCoordinationTools(
	agentDir: string,
	taskId: string,
	agentId: string,
	dispatchId?: string,
): ToolDefinition[] {
	return createDurableCoordinationTools(agentDir, () => ({
		taskId,
		agentId,
		...(dispatchId ? { dispatchId } : {}),
	}));
}
