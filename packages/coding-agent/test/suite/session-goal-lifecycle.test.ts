import { fauxAssistantMessage } from "@lioooooo123/ever-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurableGoalHost, DurableGoalSnapshot } from "../../src/core/extensions/index.ts";
import goalExtension from "../../src/extensions/goal.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

function bindGoalHost(harness: Harness): DurableGoalHost {
	let goal: DurableGoalSnapshot | undefined;
	const host: DurableGoalHost = {
		status: () => goal,
		start: vi.fn(async (objective: string) => {
			goal = {
				taskId: "12345678-1234-1234-1234-123456789abc",
				goal: objective,
				state: "running",
				totalTurns: 0,
				totalCostUsd: 0,
				maxTurns: 25,
				maxWallTimeMinutes: 240,
			};
			return goal;
		}),
		pause: async () => {
			if (!goal) throw new Error("No Task");
			goal = { ...goal, state: "paused" };
			return goal;
		},
		resume: async () => {
			if (!goal) throw new Error("No Task");
			goal = { ...goal, state: "running" };
			return goal;
		},
		cancel: async () => {
			if (!goal) throw new Error("No Task");
			goal = { ...goal, state: "cancelled" };
			return goal;
		},
		update: async () => ({ accepted: true }),
		listPermissionGrants: () => [],
		revokePermissionGrant: () => {
			throw new Error("Grant not found");
		},
		listTaskAuthorizations: () => [],
		revokeTaskAuthorization: () => {
			throw new Error("Authorization not found");
		},
	};
	harness.session.setDurableGoalHost(host);
	return host;
}

describe("Session durable Goal lifecycle", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("keeps ordinary Session turns single-shot", async () => {
		const harness = await createHarness({ extensionFactories: [{ name: "goal", factory: goalExtension }] });
		harnesses.push(harness);
		bindGoalHost(harness);
		harness.setResponses([fauxAssistantMessage("ordinary response")]);

		await harness.session.prompt("ordinary prompt");

		expect(getUserTexts(harness)).toEqual(["ordinary prompt"]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("creates a durable Task through /goal without adding a parallel Goal state", async () => {
		const harness = await createHarness({ extensionFactories: [{ name: "goal", factory: goalExtension }] });
		harnesses.push(harness);
		const host = bindGoalHost(harness);
		harness.setResponses([fauxAssistantMessage("started durable work")]);
		const settled = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "agent_settled") return;
				unsubscribe();
				resolve();
			});
		});

		await harness.session.prompt("/goal finish the migration");
		await settled;

		expect(host.start).toHaveBeenCalledWith("finish the migration");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("leaves retry recovery to AgentSession without Goal-owned continuation", async () => {
		const harness = await createHarness({
			extensionFactories: [{ name: "goal", factory: goalExtension }],
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		const host = bindGoalHost(harness);
		await host.start("recover before continuing");
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered step"),
		]);
		const settled = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "agent_settled") return;
				unsubscribe();
				resolve();
			});
		});

		await harness.session.prompt("continue the attached Task");
		await settled;

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
