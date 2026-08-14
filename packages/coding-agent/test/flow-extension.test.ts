import { describe, expect, it, vi } from "vitest";
import type {
	DurableGoalHost,
	DurableGoalSnapshot,
	ExtensionAPI,
	ExtensionCommandContext,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import flowExtension from "../src/extensions/flow.ts";

describe("Flow extension", () => {
	it("starts an Orchestrator-only Task and exposes graph and communication tools", async () => {
		const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
		const tools = new Map<string, ToolDefinition>();
		let activeTools = ["read", "bash"];
		const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
		const goal: DurableGoalSnapshot = {
			taskId: "12345678-1234-1234-1234-123456789abc",
			goal: "research NAC",
			executionMode: "flow",
			state: "running",
			totalTurns: 0,
			totalCostUsd: 0,
			maxTurns: 200,
			maxWallTimeMinutes: 240,
		};
		const host = {
			status: () => undefined,
			start: vi.fn(async () => goal),
		} as unknown as DurableGoalHost;
		const api = {
			registerCommand(
				name: string,
				command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
			) {
				commands.set(name, command.handler);
			},
			registerTool(tool: ToolDefinition) {
				tools.set(tool.name, tool);
			},
			registerMessageRenderer() {},
			on() {},
			getActiveTools: () => activeTools,
			setActiveTools(next: string[]) {
				activeTools = next;
			},
			sendMessage,
		} as unknown as ExtensionAPI;
		flowExtension(api);
		const command = commands.get("flow");
		if (!command) throw new Error("Missing /flow command");
		await command("research NAC", { durableGoal: host } as unknown as ExtensionCommandContext);

		expect(host.start).toHaveBeenCalledWith("research NAC", { mode: "flow" });
		expect(activeTools).toEqual([
			"flow_define",
			"flow_status",
			"session_message",
			"session_inbox",
			"session_address",
			"task_update",
		]);
		expect(tools.has("flow_define")).toBe(true);
		expect(tools.has("flow_status")).toBe(true);
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("Do not execute the work directly") }),
			expect.objectContaining({ triggerTurn: true }),
		);
	});
});
