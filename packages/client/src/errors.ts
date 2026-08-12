import type { JsonValue, ProtocolError, ProtocolErrorCode } from "@lioooooo123/ever-protocol";

export class EverServerError extends Error {
	readonly code: ProtocolErrorCode;
	readonly details: JsonValue | undefined;

	constructor(error: ProtocolError) {
		super(error.message);
		this.name = "EverServerError";
		this.code = error.code;
		this.details = error.details;
	}
}

export class EverDisconnectedError extends Error {
	constructor(message = "Ever client is disconnected") {
		super(message);
		this.name = "EverDisconnectedError";
	}
}

export class EverClientDisposedError extends Error {
	constructor() {
		super("Ever client is disposed");
		this.name = "EverClientDisposedError";
	}
}

export class EverSessionOwnershipError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string, message: string) {
		super(message);
		this.name = "EverSessionOwnershipError";
		this.sessionId = sessionId;
	}
}

export class EverSessionDetachedError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Session ${sessionId} is not attached`);
		this.name = "EverSessionDetachedError";
		this.sessionId = sessionId;
	}
}

export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function toDisconnectedError(error: unknown): EverDisconnectedError {
	const cause = toError(error);
	return cause instanceof EverDisconnectedError ? cause : new EverDisconnectedError(cause.message);
}
