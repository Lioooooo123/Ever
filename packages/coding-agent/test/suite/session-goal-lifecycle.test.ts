import { fauxAssistantMessage, fauxToolCall } from "@lioooooo123/ever-ai";
import { afterEach, describe, expect, it } from "vitest";
import goalExtension from "../../src/extensions/goal.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

describe("Session Goal lifecycle", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("keeps ordinary Session turns single-shot", async () => {
		const harness = await createHarness({ extensionFactories: [{ name: "goal", factory: goalExtension }] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ordinary response")]);

		await harness.session.prompt("ordinary prompt");

		expect(getUserTexts(harness)).toEqual(["ordinary prompt"]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("starts and automatically continues a Goal inside the same Session", async () => {
		const harness = await createHarness({ extensionFactories: [{ name: "goal", factory: goalExtension }] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first step"),
			fauxAssistantMessage(
				fauxToolCall("update_goal", {
					status: "completed",
					summary: "migration verified",
					evidence: ["focused tests passed"],
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const settled = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "agent_settled") return;
				unsubscribe();
				resolve();
			});
		});

		await harness.session.prompt("/goal finish the migration");
		await settled;

		const customMessages = harness.session.messages.filter((message) => message.role === "custom");
		expect(customMessages.map((message) => message.customType)).toContain("session-goal-start");
		expect(customMessages.map((message) => message.customType)).toContain("session-goal-continue");
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.session.getActiveToolNames()).not.toContain("update_goal");
	});
});
