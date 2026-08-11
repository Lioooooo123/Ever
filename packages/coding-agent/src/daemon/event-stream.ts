import { randomUUID } from "node:crypto";
import type { EventCursor } from "./protocol.ts";

export interface SequencedDaemonEvent<T> {
	cursor: EventCursor;
	type: string;
	payload: T;
	createdAt: string;
}

export type EventReplay<T> =
	| { status: "complete"; cursor: EventCursor; events: SequencedDaemonEvent<T>[] }
	| { status: "snapshot_required"; cursor: EventCursor; events: [] };

export class SequencedEventBuffer<T> {
	readonly generation: string;
	private readonly capacity: number;
	private readonly maxBytes: number;
	private readonly now: () => Date;
	private sequence = 0;
	private totalBytes = 0;
	private readonly events: SequencedDaemonEvent<T>[] = [];
	private readonly eventBytes: number[] = [];

	constructor(
		capacity = 10_000,
		generation: string = randomUUID(),
		now: () => Date = () => new Date(),
		maxBytes = 16_777_216,
	) {
		if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("Event capacity must be positive");
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("Event byte budget must be positive");
		this.capacity = capacity;
		this.maxBytes = maxBytes;
		this.generation = generation;
		this.now = now;
	}

	currentCursor(): EventCursor {
		return { generation: this.generation, sequence: this.sequence };
	}

	publish(type: string, payload: T): SequencedDaemonEvent<T> {
		this.sequence += 1;
		const event = {
			cursor: this.currentCursor(),
			type,
			payload,
			createdAt: this.now().toISOString(),
		};
		const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
		this.events.push(event);
		this.eventBytes.push(bytes);
		this.totalBytes += bytes;
		while (this.events.length > this.capacity || this.totalBytes > this.maxBytes) {
			this.events.shift();
			this.totalBytes -= this.eventBytes.shift() ?? 0;
		}
		return event;
	}

	replay(cursor?: EventCursor): EventReplay<T> {
		const current = this.currentCursor();
		if (!cursor) return { status: "snapshot_required", cursor: current, events: [] };
		const firstAvailable = this.events[0]?.cursor.sequence ?? this.sequence + 1;
		if (
			cursor.generation !== this.generation ||
			cursor.sequence > this.sequence ||
			cursor.sequence < firstAvailable - 1
		) {
			return { status: "snapshot_required", cursor: current, events: [] };
		}
		return {
			status: "complete",
			cursor: current,
			events: this.events.filter((event) => event.cursor.sequence > cursor.sequence),
		};
	}
}
