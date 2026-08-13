import { describe, expect, it } from "vitest";
import { EverDurableEventProjector, type EverTaskEvent } from "../../src/long-task-evals/durable-events.ts";

const createdAt = "2026-08-13T00:00:00.000Z";

function event(seq: number, type: string, payload: Record<string, unknown>, attemptId?: string): EverTaskEvent {
	return {
		schemaVersion: 1,
		seq,
		taskId: "task-1",
		type,
		payload,
		createdAt,
		...(attemptId === undefined ? {} : { attemptId }),
	};
}

describe("EverDurableEventProjector", () => {
	it("projects exact durable events with execution and fencing identity", () => {
		const projector = new EverDurableEventProjector();
		projector.append([
			event(1, "LeaseAcquired", { executionId: "execution-1", fencingToken: 7 }),
			event(
				2,
				"ToolStarted",
				{
					toolCallId: "tool-1",
					effect: "reconcilable_write",
					executionId: "execution-1",
					fencingToken: 7,
				},
				"attempt-1",
			),
			event(3, "ToolFinished", { toolCallId: "tool-1", isError: false }, "attempt-1"),
			event(4, "CheckpointCreated", { checkpointId: "checkpoint-1" }, "attempt-1"),
			event(5, "RecoveryStarted", { executionId: "execution-1", fencingToken: 7 }),
			event(6, "RecoveryCompleted", {}),
			event(7, "TaskCompleted", { from: "running", to: "completed" }),
		]);

		const projected = projector.read(0);
		expect(projected.map((item) => item.type)).toEqual([
			"ToolStarted",
			"ToolFinished",
			"CheckpointSettled",
			"RecoveryStarted",
			"RecoveryFinished",
			"TaskStateChanged",
		]);
		expect(projected.every((item) => item.executionId === "execution-1" && item.fencingToken === 7)).toBe(true);
		expect(projected[1]).toMatchObject({
			toolCallId: "tool-1",
			effect: "reconcilable_write",
			outcome: "succeeded",
		});
	});

	it("rejects non-increasing source sequences", () => {
		const projector = new EverDurableEventProjector();
		projector.append([event(2, "LeaseAcquired", { executionId: "execution-1", fencingToken: 1 })]);
		expect(() =>
			projector.append([event(2, "LeaseAcquired", { executionId: "execution-2", fencingToken: 2 })]),
		).toThrow("strictly increasing");
	});

	it("rejects score-bearing events without execution identity", () => {
		const projector = new EverDurableEventProjector();
		expect(() =>
			projector.append([event(1, "ToolStarted", { toolCallId: "tool-1", effect: "read_only" }, "attempt-1")]),
		).toThrow("before LeaseAcquired");
	});

	it("rejects events and leases from an expired fencing token", () => {
		const projector = new EverDurableEventProjector();
		projector.append([
			event(1, "LeaseAcquired", { executionId: "execution-1", fencingToken: 1 }),
			event(2, "LeaseAcquired", { executionId: "execution-2", fencingToken: 2 }),
		]);
		expect(() =>
			projector.append([
				event(
					3,
					"ToolStarted",
					{ toolCallId: "tool-1", effect: "read_only", executionId: "execution-1", fencingToken: 1 },
					"attempt-1",
				),
			]),
		).toThrow("stale or mismatched");

		const leases = new EverDurableEventProjector();
		leases.append([event(1, "LeaseAcquired", { executionId: "execution-2", fencingToken: 2 })]);
		expect(() => leases.append([event(2, "LeaseAcquired", { executionId: "execution-1", fencingToken: 1 })])).toThrow(
			"did not advance",
		);
	});
});
