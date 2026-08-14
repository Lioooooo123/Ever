import { join } from "node:path";
import { type FlowDefinition, SqliteTaskStore } from "@lioooooo123/ever-long-tasks";
import { Text } from "@lioooooo123/ever-tui";
import { Type } from "typebox";
import { requestDaemon, startDaemon } from "../cli/daemon-command.ts";
import { getAgentDir } from "../config.ts";
import type { ExtensionAPI } from "../core/extensions/types.ts";
import { defineFlowForTask, FlowDefinitionSchema, getFlowStatus } from "../core/native-coordination-tools.ts";

const FLOW_START_MESSAGE_TYPE = "flow-start";
const FLOW_TOOLS = ["flow_define", "flow_status", "session_message", "session_inbox", "session_address", "task_update"];

function mainAgentId(taskId: string): string {
	const agentDir = getAgentDir();
	const store = SqliteTaskStore.open({ databasePath: join(agentDir, "long-tasks.sqlite") });
	try {
		const main = store.listAgents(taskId).find((agent) => agent.kind === "main");
		if (!main) throw new Error(`Task ${taskId} has no main Agent`);
		return main.id;
	} finally {
		store.close();
	}
}

function formatStatus(taskId: string): string {
	const status = getFlowStatus(getAgentDir(), taskId);
	if (!status.flow) return `FLOW ${taskId.slice(0, 8)}  awaiting definition`;
	return [
		`FLOW ${status.flow.id.slice(0, 8)}  ${status.flow.state}`,
		...status.flow.nodes.map(
			(node) =>
				`${node.key.padEnd(20)} ${node.state.padEnd(10)} agent:${node.agentId.slice(0, 8)}${node.activeSessionId ? ` session:${node.activeSessionId.slice(0, 8)}` : ""}${node.dependsOn.length ? ` <- ${node.dependsOn.join(",")}` : ""}`,
		),
		`Episodes: ${status.episodes.length}`,
	].join("\n");
}

export default function flowExtension(ever: ExtensionAPI): void {
	let previousTools: string[] | undefined;
	const activateFlowTools = (): void => {
		previousTools ??= ever.getActiveTools().filter((name) => !FLOW_TOOLS.includes(name));
		ever.setActiveTools(FLOW_TOOLS);
	};
	const restoreTools = (): void => {
		if (!previousTools) return;
		ever.setActiveTools(previousTools);
		previousTools = undefined;
	};

	ever.registerMessageRenderer(FLOW_START_MESSAGE_TYPE, (message, { outputPad }, theme) => {
		const content = typeof message.content === "string" ? message.content : "Flow started";
		return new Text(`${theme.bold(theme.fg("accent", "FLOW"))}  ${content}`, outputPad, 0);
	});

	ever.registerTool({
		name: "flow_define",
		label: "Define Flow",
		description: "Atomically define and validate a dependency DAG of independent Agent Sessions.",
		promptSnippet: "flow_define: create a validated DAG; independent nodes run concurrently",
		parameters: FlowDefinitionSchema,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const goal = ctx.durableGoal.status();
			if (!goal || goal.executionMode !== "flow")
				throw new Error("/flow must start a Flow Task before defining its graph");
			const flow = defineFlowForTask(getAgentDir(), goal.taskId, mainAgentId(goal.taskId), params as FlowDefinition);
			await startDaemon(getAgentDir());
			const wake = await requestDaemon(getAgentDir(), { command: "wake", taskId: goal.taskId });
			if (!wake.ok) throw new Error(wake.message ?? "Daemon rejected Flow dispatch");
			return {
				content: [{ type: "text", text: JSON.stringify(flow) }],
				details: flow,
			};
		},
	});

	ever.registerTool({
		name: "flow_status",
		label: "Flow Status",
		description: "Inspect the current Flow graph, Agent Sessions, node states, and Episodes.",
		promptSnippet: "flow_status: inspect DAG progress and Handoffs",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			const goal = ctx.durableGoal.status();
			const status = goal ? getFlowStatus(getAgentDir(), goal.taskId) : { flow: undefined };
			return { content: [{ type: "text", text: JSON.stringify(status) }], details: status };
		},
	});

	ever.registerCommand("flow", {
		description: "Run a long task as a durable Agent Session DAG",
		getArgumentCompletions: (prefix) =>
			["status", "pause", "resume", "cancel"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const input = args.replace(/\r\n?/gu, "\n").trim();
			const current = ctx.durableGoal.status();
			if (input === "status" || (!input && current)) {
				ctx.ui.notify(current ? formatStatus(current.taskId) : "No Flow is attached.", "info");
				return;
			}
			if (input === "pause") {
				const goal = await ctx.durableGoal.pause();
				restoreTools();
				ctx.ui.notify(`FLOW ${goal.taskId.slice(0, 8)}  ${goal.state}`, "info");
				return;
			}
			if (input === "resume") {
				const goal = await ctx.durableGoal.resume();
				activateFlowTools();
				ever.sendMessage(
					{
						customType: FLOW_START_MESSAGE_TYPE,
						content: `Resume Flow ${goal.taskId.slice(0, 8)}: ${goal.goal}`,
						display: true,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				return;
			}
			if (input === "cancel" || input === "clear") {
				const goal = await ctx.durableGoal.cancel();
				restoreTools();
				ctx.ui.notify(`FLOW ${goal.taskId.slice(0, 8)}  ${goal.state}`, "info");
				return;
			}
			if (!input) throw new Error("Usage: /flow <objective>|status|pause|resume|cancel");
			const goal = await ctx.durableGoal.start(input, { mode: "flow" });
			activateFlowTools();
			ever.sendMessage(
				{
					customType: FLOW_START_MESSAGE_TYPE,
					content: [
						`Orchestrate Flow ${goal.taskId.slice(0, 8)}: ${input}`,
						"You are the Orchestrator. Do not execute the work directly.",
						"Use flow_define once to create a bounded DAG. Independent nodes should run concurrently.",
						"Use session_message for steering and sibling communication. Use flow_status to observe Episodes.",
						"When every required node is accepted, call task_update complete with evidence.",
					].join("\n"),
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
	});

	ever.on("before_agent_start", (_event, ctx) => {
		const goal = ctx.durableGoal.status();
		if (!goal) return;
		if (["completed", "failed", "cancelled"].includes(goal.state)) {
			restoreTools();
			return;
		}
		if (goal.executionMode === "flow") activateFlowTools();
	});
}
