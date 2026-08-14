import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Credential } from "@lioooooo123/ever-ai";
import type { ToolEffect } from "@lioooooo123/ever-long-tasks";
import type { SessionExecutionEnvironment } from "./session-execution-host.ts";

export interface EvalEffectGateCapability {
	directory: string;
	effect: ToolEffect;
	secret: string;
	domainCommitId: string;
	evidencePath: string;
	evidenceIncludes?: string;
	expectedToolError?: boolean;
	toolName?: string;
	targetPath?: string;
	commandIncludes?: string;
}

export interface WorkerStartupEnvelope {
	schemaVersion: 1;
	token: string;
	credentials: Record<string, Credential>;
	executionEnvironment: SessionExecutionEnvironment;
	evalEffectGate?: EvalEffectGateCapability;
}

let startupEnvelope: WorkerStartupEnvelope | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCredential(value: unknown, provider: string): Credential {
	if (!isRecord(value) || (value.type !== "api_key" && value.type !== "oauth"))
		throw new Error(`Worker startup envelope has an invalid credential for ${provider}`);
	if (value.type === "api_key" && typeof value.key !== "string")
		throw new Error(`Worker startup API-key credential for ${provider} has no key`);
	if (
		value.type === "oauth" &&
		(typeof value.access !== "string" || typeof value.refresh !== "string" || typeof value.expires !== "number")
	)
		throw new Error(`Worker startup OAuth credential for ${provider} is incomplete`);
	return value as Credential;
}

export function parseWorkerStartupEnvelope(value: unknown): WorkerStartupEnvelope {
	if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("Invalid Worker startup envelope version");
	if (typeof value.token !== "string" || value.token.length < 32)
		throw new Error("Worker startup envelope has an invalid token");
	if (!isRecord(value.credentials) || Object.keys(value.credentials).length === 0)
		throw new Error("Worker startup envelope has no credentials");
	const credentials: Record<string, Credential> = {};
	for (const [provider, credential] of Object.entries(value.credentials)) {
		if (provider.trim() === "") throw new Error("Worker startup envelope has an empty credential provider");
		credentials[provider] = parseCredential(credential, provider);
	}
	if (!isRecord(value.executionEnvironment)) throw new Error("Worker execution environment is missing");
	const environment = value.executionEnvironment;
	if (environment.trust !== "sandboxed" && environment.trust !== "unsafe_host")
		throw new Error("Worker execution environment has invalid trust");
	if (!["seatbelt", "bubblewrap", "unsupported"].includes(String(environment.backend)))
		throw new Error("Worker execution environment has invalid backend");
	if (typeof environment.workspaceRoot !== "string" || !isAbsolute(environment.workspaceRoot))
		throw new Error("Worker execution environment workspace must be absolute");
	if (
		!Array.isArray(environment.allowedDomains) ||
		!environment.allowedDomains.every((domain) => typeof domain === "string")
	)
		throw new Error("Worker execution environment has invalid allowed domains");
	if (
		!Array.isArray(environment.writableRoots) ||
		!environment.writableRoots.every((root) => typeof root === "string" && isAbsolute(root))
	)
		throw new Error("Worker execution environment has invalid writable roots");
	if (environment.trust === "sandboxed") {
		if (typeof environment.sandboxId !== "string" || environment.sandboxId === "")
			throw new Error("Sandboxed Worker execution environment has no sandbox ID");
		if (typeof environment.profileSha256 !== "string" || !/^[a-f0-9]{64}$/.test(environment.profileSha256))
			throw new Error("Sandboxed Worker execution environment has invalid profile hash");
	}
	if (value.evalEffectGate !== undefined) {
		if (!isRecord(value.evalEffectGate)) throw new Error("Worker Eval effect gate is invalid");
		const gate = value.evalEffectGate;
		if (typeof gate.directory !== "string" || !isAbsolute(gate.directory))
			throw new Error("Worker Eval effect gate directory must be absolute");
		if (!["read_only", "reconcilable_write", "external_side_effect", "process"].includes(String(gate.effect)))
			throw new Error("Worker Eval effect gate has an invalid effect");
		if (typeof gate.secret !== "string" || !/^[a-f0-9]{64}$/.test(gate.secret))
			throw new Error("Worker Eval effect gate has an invalid secret");
		if (typeof gate.domainCommitId !== "string" || gate.domainCommitId === "")
			throw new Error("Worker Eval effect gate has an invalid domain commit ID");
		if (typeof gate.evidencePath !== "string" || !isAbsolute(gate.evidencePath))
			throw new Error("Worker Eval effect gate evidence path must be absolute");
		if (
			gate.evidenceIncludes !== undefined &&
			(typeof gate.evidenceIncludes !== "string" || gate.evidenceIncludes === "")
		)
			throw new Error("Worker Eval effect gate has invalid evidence content");
		if (gate.expectedToolError !== undefined && typeof gate.expectedToolError !== "boolean")
			throw new Error("Worker Eval effect gate has invalid tool outcome selector");
		for (const selector of [gate.toolName, gate.targetPath, gate.commandIncludes]) {
			if (selector !== undefined && (typeof selector !== "string" || selector === ""))
				throw new Error("Worker Eval effect gate has an invalid selector");
		}
		if (gate.toolName === undefined && gate.targetPath === undefined && gate.commandIncludes === undefined)
			throw new Error("Worker Eval effect gate requires a domain selector");
	}
	return { ...(value as object), credentials } as unknown as WorkerStartupEnvelope;
}

/** Read the owner-only startup envelope exactly once, before normal CLI initialization. */
export function loadWorkerStartup(): void {
	if ((process.env.EVER_DAEMON_WORKER !== "1" && process.env.EVER_FOREGROUND_SANDBOX !== "1") || startupEnvelope)
		return;
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
