import { describe, expect, it } from "vitest";
import { SequencedEventBuffer } from "../src/daemon/event-stream.ts";

describe("SequencedEventBuffer", () => {
	it("replays only events after a valid cursor", () => {
		const events = new SequencedEventBuffer<{ value: number }>(10, "generation-1", () => new Date(0));
		const first = events.publish("progress", { value: 1 });
		events.publish("progress", { value: 2 });

		expect(events.replay(first.cursor)).toMatchObject({
			status: "complete",
			cursor: { generation: "generation-1", sequence: 2 },
			events: [{ cursor: { sequence: 2 }, payload: { value: 2 } }],
		});
	});

	it("requires a snapshot when the generation changes or the cursor expires", () => {
		const events = new SequencedEventBuffer<{ value: number }>(2, "generation-2", () => new Date(0));
		events.publish("progress", { value: 1 });
		events.publish("progress", { value: 2 });
		events.publish("progress", { value: 3 });

		expect(events.replay({ generation: "generation-1", sequence: 3 }).status).toBe("snapshot_required");
		expect(events.replay({ generation: "generation-2", sequence: 0 }).status).toBe("snapshot_required");
	});

	it("evicts old events when the byte budget is exceeded", () => {
		const events = new SequencedEventBuffer<{ text: string }>(10, "generation-1", () => new Date(0), 220);
		const first = events.publish("chunk", { text: "a".repeat(80) });
		events.publish("chunk", { text: "b".repeat(80) });

		expect(events.replay({ generation: "generation-1", sequence: 0 }).status).toBe("snapshot_required");
		expect(events.replay(first.cursor)).toMatchObject({
			status: "complete",
			events: [{ payload: { text: "b".repeat(80) } }],
		});
	});
});
