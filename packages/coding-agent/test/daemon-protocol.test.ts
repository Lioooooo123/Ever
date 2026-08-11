import { describe, expect, it } from "vitest";
import { SequencedEventBuffer } from "../src/daemon/event-stream.ts";
import {
	createDaemonCommand,
	daemonCommandPayloadSha256,
	daemonResponse,
	parseDaemonCommand,
	parseDaemonResponse,
} from "../src/daemon/protocol.ts";

describe("daemon control protocol", () => {
	it("creates and validates versioned command envelopes", () => {
		const command = createDaemonCommand(
			{ command: "wake", taskId: "task-1" },
			{ clientId: "client-1", commandId: "command-1" },
		);
		expect(parseDaemonCommand(command)).toEqual(command);
		expect(daemonCommandPayloadSha256(command)).toMatch(/^[a-f0-9]{64}$/);
		expect(() => parseDaemonCommand({ ...command, protocolVersion: 2 })).toThrow("Unsupported daemon protocol");
	});

	it("authenticates outside the durable payload identity and accepts in-progress retries", () => {
		const first = createDaemonCommand(
			{ command: "wake", taskId: "task-1" },
			{ clientId: "client-1", commandId: "command-1", authToken: "token-1" },
		);
		const second = { ...first, authToken: "token-2" };
		expect(daemonCommandPayloadSha256(first)).toBe(daemonCommandPayloadSha256(second));
		expect(parseDaemonResponse(daemonResponse("command-1", "in_progress", { ok: false }))).toMatchObject({
			commandId: "command-1",
			status: "in_progress",
		});
	});

	it("replays retained events and requires snapshots for stale cursors", () => {
		const events = new SequencedEventBuffer<Record<string, unknown>>(2, "generation-1", () => new Date(0));
		const initialCursor = events.currentCursor();
		events.publish("WorkerStarted", { workerId: "worker-1" });
		events.publish("WorkerHeartbeat", { workerId: "worker-1" });
		const replay = events.replay(initialCursor);
		expect(replay.status).toBe("complete");
		expect(replay.events.map((event) => event.type)).toEqual(["WorkerStarted", "WorkerHeartbeat"]);
		events.publish("WorkerExited", { workerId: "worker-1" });
		expect(events.replay(initialCursor)).toMatchObject({ status: "snapshot_required", events: [] });
		expect(events.replay({ generation: "old", sequence: 3 })).toMatchObject({ status: "snapshot_required" });
	});

	it("bounds replay memory by serialized event bytes", () => {
		const events = new SequencedEventBuffer<Record<string, unknown>>(100, "generation-1", () => new Date(0), 180);
		const cursor = events.currentCursor();
		events.publish("Delta", { text: "a".repeat(60) });
		events.publish("Delta", { text: "b".repeat(60) });
		expect(events.replay(cursor).status).toBe("snapshot_required");
	});
});
