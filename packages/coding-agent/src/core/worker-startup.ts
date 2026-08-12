import { readFileSync } from "node:fs";
import type { Credential } from "@earendil-works/pi-ai";

export interface WorkerStartupEnvelope {
	schemaVersion: 1;
	token: string;
	provider: string;
	credential: Credential;
}

let startupEnvelope: WorkerStartupEnvelope | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseWorkerStartupEnvelope(value: unknown): WorkerStartupEnvelope {
	if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("Invalid Worker startup envelope version");
	if (typeof value.token !== "string" || value.token.length < 32)
		throw new Error("Worker startup envelope has an invalid token");
	if (typeof value.provider !== "string" || value.provider.trim() === "")
		throw new Error("Worker startup envelope has an invalid provider");
	if (!isRecord(value.credential) || (value.credential.type !== "api_key" && value.credential.type !== "oauth"))
		throw new Error("Worker startup envelope has an invalid credential");
	if (value.credential.type === "api_key" && typeof value.credential.key !== "string")
		throw new Error("Worker startup API-key credential has no key");
	if (
		value.credential.type === "oauth" &&
		(typeof value.credential.access !== "string" ||
			typeof value.credential.refresh !== "string" ||
			typeof value.credential.expires !== "number")
	)
		throw new Error("Worker startup OAuth credential is incomplete");
	return value as unknown as WorkerStartupEnvelope;
}

/** Read the owner-only startup envelope exactly once, before normal CLI initialization. */
export function loadWorkerStartup(): void {
	if (process.env.EVER_DAEMON_WORKER !== "1" || startupEnvelope) return;
	const serialized = readFileSync(3, "utf8").trim();
	if (serialized === "") throw new Error("Resident Worker received an empty startup envelope");
	startupEnvelope = parseWorkerStartupEnvelope(JSON.parse(serialized) as unknown);
}

export function getWorkerStartup(): WorkerStartupEnvelope {
	if (!startupEnvelope) throw new Error("Resident Worker startup envelope was not loaded");
	return startupEnvelope;
}

export function getWorkerStartupIfLoaded(): WorkerStartupEnvelope | undefined {
	return startupEnvelope;
}
