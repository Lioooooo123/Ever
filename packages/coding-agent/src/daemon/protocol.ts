import { createHash, randomUUID } from "node:crypto";

export const DAEMON_PROTOCOL_VERSION = 1 as const;
export const DAEMON_SCHEMA_REVISION = 1 as const;

export type DaemonCommandType =
	| "hello"
	| "status"
	| "wake"
	| "stop"
	| "attach"
	| "detach"
	| "prompt"
	| "steer"
	| "pause-agent"
	| "cancel-agent"
	| "stop-agent"
	| "acknowledge";

export interface EventCursor {
	generation: string;
	sequence: number;
}

export interface DaemonCommandEnvelope {
	protocolVersion: typeof DAEMON_PROTOCOL_VERSION;
	schemaRevision: typeof DAEMON_SCHEMA_REVISION;
	clientId: string;
	commandId: string;
	command: DaemonCommandType;
	payload: Record<string, unknown>;
	authToken?: string;
	resumeCursor?: EventCursor;
}

export interface DaemonResponseBody {
	ok: boolean;
	pid?: number;
	runningTaskIds?: string[];
	message?: string;
	[key: string]: unknown;
}

export interface DaemonResponseEnvelope {
	protocolVersion: typeof DAEMON_PROTOCOL_VERSION;
	schemaRevision: typeof DAEMON_SCHEMA_REVISION;
	commandId: string;
	status: "completed" | "in_progress" | "uncertain" | "rejected";
	body: DaemonResponseBody;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (!isRecord(value)) return JSON.stringify(value) ?? "null";
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
		.join(",")}}`;
}

export function daemonCommandPayloadSha256(command: DaemonCommandEnvelope): string {
	return createHash("sha256")
		.update(canonicalJson({ command: command.command, payload: command.payload, resumeCursor: command.resumeCursor }))
		.digest("hex");
}

export function createDaemonCommand(
	request: Record<string, unknown>,
	identity: { clientId?: string; commandId?: string; authToken?: string } = {},
): DaemonCommandEnvelope {
	const command = request.command;
	if (!isDaemonCommandType(command)) {
		throw new Error(`Unknown daemon command: ${typeof command === "string" ? command : "missing"}`);
	}
	const { command: _command, resumeCursor: requestedCursor, ...payload } = request;
	const resumeCursor =
		isRecord(requestedCursor) &&
		typeof requestedCursor.generation === "string" &&
		Number.isSafeInteger(requestedCursor.sequence)
			? { generation: requestedCursor.generation, sequence: requestedCursor.sequence as number }
			: undefined;
	return {
		protocolVersion: DAEMON_PROTOCOL_VERSION,
		schemaRevision: DAEMON_SCHEMA_REVISION,
		clientId: identity.clientId ?? `cli:${process.pid}`,
		commandId: identity.commandId ?? randomUUID(),
		command,
		payload,
		...(identity.authToken ? { authToken: identity.authToken } : {}),
		...(resumeCursor ? { resumeCursor } : {}),
	};
}

export function parseDaemonCommand(value: unknown): DaemonCommandEnvelope {
	if (!isRecord(value)) throw new Error("Daemon request must be an object");
	if (value.protocolVersion !== DAEMON_PROTOCOL_VERSION)
		throw new Error(`Unsupported daemon protocol version: ${String(value.protocolVersion)}`);
	if (value.schemaRevision !== DAEMON_SCHEMA_REVISION)
		throw new Error(`Unsupported daemon schema revision: ${String(value.schemaRevision)}`);
	if (typeof value.clientId !== "string" || value.clientId.trim() === "") throw new Error("Missing clientId");
	if (typeof value.commandId !== "string" || value.commandId.trim() === "") throw new Error("Missing commandId");
	if (!isDaemonCommandType(value.command)) throw new Error(`Unknown daemon command: ${String(value.command)}`);
	if (!isRecord(value.payload)) throw new Error("Daemon command payload must be an object");
	if (value.authToken !== undefined && typeof value.authToken !== "string")
		throw new Error("Daemon auth token must be a string");
	let resumeCursor: EventCursor | undefined;
	if (value.resumeCursor !== undefined) {
		if (
			!isRecord(value.resumeCursor) ||
			typeof value.resumeCursor.generation !== "string" ||
			!Number.isSafeInteger(value.resumeCursor.sequence) ||
			(value.resumeCursor.sequence as number) < 0
		) {
			throw new Error("Invalid event cursor");
		}
		resumeCursor = {
			generation: value.resumeCursor.generation,
			sequence: value.resumeCursor.sequence as number,
		};
	}
	return {
		protocolVersion: DAEMON_PROTOCOL_VERSION,
		schemaRevision: DAEMON_SCHEMA_REVISION,
		clientId: value.clientId,
		commandId: value.commandId,
		command: value.command,
		payload: value.payload,
		...(typeof value.authToken === "string" ? { authToken: value.authToken } : {}),
		...(resumeCursor ? { resumeCursor } : {}),
	};
}

function isDaemonCommandType(value: unknown): value is DaemonCommandType {
	return (
		typeof value === "string" &&
		[
			"hello",
			"status",
			"wake",
			"stop",
			"attach",
			"detach",
			"prompt",
			"steer",
			"pause-agent",
			"cancel-agent",
			"stop-agent",
			"acknowledge",
		].includes(value)
	);
}

export function daemonResponse(
	commandId: string,
	status: DaemonResponseEnvelope["status"],
	body: DaemonResponseBody,
): DaemonResponseEnvelope {
	return {
		protocolVersion: DAEMON_PROTOCOL_VERSION,
		schemaRevision: DAEMON_SCHEMA_REVISION,
		commandId,
		status,
		body,
	};
}

export function parseDaemonResponse(value: unknown): DaemonResponseEnvelope {
	if (!isRecord(value)) throw new Error("Daemon response must be an object");
	if (value.protocolVersion !== DAEMON_PROTOCOL_VERSION || value.schemaRevision !== DAEMON_SCHEMA_REVISION)
		throw new Error("Daemon returned an unsupported protocol response");
	if (typeof value.commandId !== "string") throw new Error("Daemon response is missing commandId");
	if (
		!(
			value.status === "completed" ||
			value.status === "in_progress" ||
			value.status === "uncertain" ||
			value.status === "rejected"
		)
	)
		throw new Error("Daemon response has an invalid status");
	if (!isRecord(value.body) || typeof value.body.ok !== "boolean")
		throw new Error("Daemon response has an invalid body");
	return value as unknown as DaemonResponseEnvelope;
}
