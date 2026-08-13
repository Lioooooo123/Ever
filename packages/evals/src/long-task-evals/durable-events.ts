import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

const DurableEventTypeSchema = Type.Union([
	Type.Literal("CheckpointSettled"),
	Type.Literal("ToolStarted"),
	Type.Literal("ToolFinished"),
	Type.Literal("RecoveryStarted"),
	Type.Literal("RecoveryFinished"),
	Type.Literal("TaskStateChanged"),
]);

export const EvalDurableEventSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		seq: Type.Integer({ minimum: 1 }),
		taskId: Type.String({ minLength: 1 }),
		attemptId: Type.String({ minLength: 1 }),
		executionId: Type.String({ minLength: 1 }),
		fencingToken: Type.Integer({ minimum: 1 }),
		createdAt: Type.String({ minLength: 1 }),
		type: DurableEventTypeSchema,
		checkpointId: Type.Optional(Type.String({ minLength: 1 })),
		toolCallId: Type.Optional(Type.String({ minLength: 1 })),
		effect: Type.Optional(
			Type.Union([
				Type.Literal("read_only"),
				Type.Literal("reconcilable_write"),
				Type.Literal("process"),
				Type.Literal("external_side_effect"),
			]),
		),
		outcome: Type.Optional(
			Type.Union([Type.Literal("succeeded"), Type.Literal("known_failed"), Type.Literal("unknown")]),
		),
		taskState: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export type EvalDurableEvent = Static<typeof EvalDurableEventSchema>;

export interface EverTaskEvent {
	schemaVersion: 1;
	seq: number;
	taskId: string;
	attemptId?: string;
	type: string;
	payload: Record<string, unknown>;
	createdAt: string;
}

export interface DurableEventSource {
	readDurableEvents(afterSeq: number): readonly EvalDurableEvent[];
}

const durableEventValidator = Compile(EvalDurableEventSchema);

export function assertEvalDurableEvent(value: unknown): asserts value is EvalDurableEvent {
	if (durableEventValidator.Check(value)) {
		if (!Number.isFinite(Date.parse(value.createdAt))) throw new TypeError("Invalid durable event createdAt");
		return;
	}
	const detail = [...durableEventValidator.Errors(value)]
		.slice(0, 5)
		.map((error) => `${error.instancePath || "/"}: ${error.message}`)
		.join("; ");
	throw new TypeError(`Invalid EvalDurableEvent v1: ${detail}`);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
	const field = value[key];
	return typeof field === "string" && field !== "" ? field : undefined;
}

function integerField(value: Record<string, unknown>, key: string): number | undefined {
	const field = value[key];
	return Number.isSafeInteger(field) && Number(field) > 0 ? Number(field) : undefined;
}

interface ExecutionContext {
	executionId: string;
	fencingToken: number;
	attemptId?: string;
}

export class EverDurableEventProjector {
	readonly #events: EvalDurableEvent[] = [];
	readonly #contextByTask = new Map<string, ExecutionContext>();
	readonly #startedTools = new Map<string, EvalDurableEvent>();
	#lastRawSeq = 0;

	append(rawEvents: readonly EverTaskEvent[]): readonly EvalDurableEvent[] {
		const appended: EvalDurableEvent[] = [];
		for (const raw of rawEvents) {
			if (!Number.isSafeInteger(raw.seq) || raw.seq <= this.#lastRawSeq)
				throw new Error(`Ever task event sequence is not strictly increasing at ${raw.seq}`);
			this.#lastRawSeq = raw.seq;
			const projected = this.#project(raw);
			if (projected === undefined) continue;
			assertEvalDurableEvent(projected);
			this.#events.push(projected);
			appended.push(projected);
		}
		return appended;
	}

	read(afterSeq: number): readonly EvalDurableEvent[] {
		return this.#events.filter((event) => event.seq > afterSeq);
	}

	#project(raw: EverTaskEvent): EvalDurableEvent | undefined {
		if (raw.type === "LeaseAcquired") {
			const executionId = stringField(raw.payload, "executionId");
			const fencingToken = integerField(raw.payload, "fencingToken");
			if (executionId === undefined || fencingToken === undefined)
				throw new Error("LeaseAcquired is missing executionId or fencingToken");
			const previous = this.#contextByTask.get(raw.taskId);
			if (previous !== undefined && fencingToken <= previous.fencingToken)
				throw new Error(`LeaseAcquired fencing token did not advance for ${raw.taskId}`);
			this.#contextByTask.set(raw.taskId, {
				executionId,
				fencingToken,
				...(raw.attemptId ? { attemptId: raw.attemptId } : {}),
			});
			return undefined;
		}

		const directExecutionId = stringField(raw.payload, "executionId");
		const directFencingToken = integerField(raw.payload, "fencingToken");
		const previous = this.#contextByTask.get(raw.taskId);
		if (previous === undefined) throw new Error(`${raw.type} cannot be projected before LeaseAcquired`);
		if (
			(directExecutionId !== undefined && directExecutionId !== previous.executionId) ||
			(directFencingToken !== undefined && directFencingToken !== previous.fencingToken)
		) {
			throw new Error(`${raw.type} carries a stale or mismatched execution fence`);
		}
		const context: ExecutionContext = {
			...previous,
			...(raw.attemptId === undefined ? {} : { attemptId: raw.attemptId }),
		};
		this.#contextByTask.set(raw.taskId, context);

		if (raw.type === "ToolStarted") {
			const effect = raw.payload.effect;
			if (
				effect !== "read_only" &&
				effect !== "reconcilable_write" &&
				effect !== "process" &&
				effect !== "external_side_effect"
			)
				throw new Error(`ToolStarted has unsupported effect ${String(effect)}`);
			const event = this.#base(raw, context, "ToolStarted", {
				toolCallId: stringField(raw.payload, "toolCallId"),
				effect,
			});
			this.#startedTools.set(`${raw.taskId}\0${event.toolCallId}`, event);
			return event;
		}
		if (raw.type === "ToolFinished") {
			const toolCallId = stringField(raw.payload, "toolCallId");
			if (toolCallId === undefined) throw new Error("ToolFinished is missing toolCallId");
			const started = this.#startedTools.get(`${raw.taskId}\0${toolCallId}`);
			if (started === undefined) return undefined;
			return this.#base(raw, context, "ToolFinished", {
				toolCallId,
				effect: started.effect,
				outcome: raw.payload.isError === true ? "known_failed" : "succeeded",
			});
		}
		if (raw.type === "CheckpointCreated") {
			return this.#base(raw, context, "CheckpointSettled", {
				checkpointId: stringField(raw.payload, "checkpointId"),
			});
		}
		if (raw.type === "RecoveryStarted") return this.#base(raw, context, "RecoveryStarted", {});
		if (raw.type === "RecoveryCompleted" || raw.type === "RecoveryBlocked") {
			return this.#base(raw, context, "RecoveryFinished", {
				outcome: raw.type === "RecoveryCompleted" ? "succeeded" : "unknown",
			});
		}
		const taskState = stringField(raw.payload, "to");
		if (taskState !== undefined && raw.type.startsWith("Task")) {
			return this.#base(raw, context, "TaskStateChanged", { taskState });
		}
		return undefined;
	}

	#base<T extends EvalDurableEvent["type"]>(
		raw: EverTaskEvent,
		context: ExecutionContext | undefined,
		type: T,
		extra: Partial<EvalDurableEvent>,
	): EvalDurableEvent {
		const attemptId = raw.attemptId ?? context?.attemptId;
		if (context === undefined || attemptId === undefined)
			throw new Error(`${raw.type} cannot be projected without execution and attempt identity`);
		const event = {
			schemaVersion: 1 as const,
			seq: raw.seq,
			taskId: raw.taskId,
			attemptId,
			executionId: context.executionId,
			fencingToken: context.fencingToken,
			createdAt: raw.createdAt,
			type,
			...extra,
		};
		return event as EvalDurableEvent;
	}
}
