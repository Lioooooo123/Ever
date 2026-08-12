import type { AgentTool } from "@lioooooo123/ever-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@lioooooo123/ever-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionLifecycleEvent } from "../../src/core/agent-session-lifecycle.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession native lifecycle", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	it("persists tool intent before execution and result before settled", async () => {
		const order: string[] = [];
		const events: AgentSessionLifecycleEvent[] = [];
		const tool: AgentTool = {
			name: "write_marker",
			label: "Write marker",
			description: "Records an execution marker",
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => {
				order.push("execute");
				return { content: [{ type: "text", text: "written" }], details: {} };
			},
		};
		harness = await createHarness({
			tools: [tool],
			lifecycleRef: {
				current: {
					async handle(event) {
						events.push(event);
						order.push(event.type);
						return undefined;
					},
				},
			},
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write_marker", { value: "ok" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run");

		expect(order.indexOf("before_tool")).toBeLessThan(order.indexOf("execute"));
		expect(order.indexOf("execute")).toBeLessThan(order.indexOf("after_tool"));
		expect(order.indexOf("after_tool")).toBeLessThan(order.lastIndexOf("settled"));
		const before = events.find((event) => event.type === "before_tool");
		const after = events.find((event) => event.type === "after_tool");
		expect(before?.type === "before_tool" ? before.operationId : undefined).toBe(
			after?.type === "after_tool" ? after.operationId : undefined,
		);
	});

	it("fails closed when the host blocks a tool", async () => {
		let executed = false;
		const tool: AgentTool = {
			name: "dangerous_action",
			label: "Dangerous action",
			description: "Must be blocked",
			parameters: Type.Object({}),
			execute: async () => {
				executed = true;
				return { content: [{ type: "text", text: "unexpected" }], details: {} };
			},
		};
		harness = await createHarness({
			tools: [tool],
			lifecycleRef: {
				current: {
					async handle(event) {
						return event.type === "before_tool"
							? { block: true, reason: "blocked by host policy", terminate: true }
							: undefined;
					},
				},
			},
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("dangerous_action", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("blocked"),
		]);

		await harness.session.prompt("run");

		expect(executed).toBe(false);
		expect(harness.session.messages.some((message) => message.role === "toolResult" && message.isError)).toBe(true);
	});
});
