import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { EvidenceRefSchema, SqliteTaskStore, TaskController, VerifiedCompletion } from "@karissa/long-tasks";
import { defineTool, type ToolDefinition } from "./extensions/types.ts";

function textResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

export function createNativeTaskTool(agentDir: string, taskId: string): ToolDefinition {
	return defineTool({
		name: "task_update",
		label: "Task Update",
		description: "Persist progress, wait, request verified completion, or fail the current durable Task.",
		promptSnippet: "task_update: persist progress and request evidence-backed completion",
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
		async execute(toolCallId, params) {
			const store = SqliteTaskStore.open({
				databasePath: join(agentDir, "long-tasks.sqlite"),
				artifactsRoot: join(agentDir, "tasks"),
			});
			try {
				const actor = store.listAgents(taskId).find((agent) => agent.kind === "main");
				if (!actor) throw new Error(`Task ${taskId} has no main Agent`);
				if (params.action === "checkpoint") {
					store.appendTaskEvent(taskId, "CheckpointRequested", {
						...params,
						agentId: actor.id,
						schemaVersion: 1,
					});
					return textResult({ accepted: true, state: store.requireTask(taskId).state });
				}
				if (params.action === "wait") {
					if (params.waitKind === "time" && !params.resumeAt) throw new Error("Timed waits require resumeAt");
					if (params.resumeAt) store.setNextWakeAt(taskId, params.resumeAt);
					const state = params.waitKind === "user" ? "waiting_input" : "waiting_external";
					return textResult({ accepted: true, state: store.transitionTask(taskId, state, params.reason).state });
				}
				if (params.action === "complete") {
					return textResult(
						new VerifiedCompletion(store).request({
							taskId,
							requestId: toolCallId,
							summary: params.summary,
							evidence: params.evidence,
						}),
					);
				}
				return textResult({ accepted: true, state: new TaskController(store).fail(taskId, params.code).state });
			} finally {
				store.close();
			}
		},
	});
}
