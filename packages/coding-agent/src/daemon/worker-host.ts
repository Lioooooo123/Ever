import { createHash } from "node:crypto";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import type { TaskRunContext } from "../core/task-run-context.ts";
import { getWorkerStartup } from "../core/worker-startup.ts";
import { toJsonEvent } from "../modes/json-event.ts";
import { SequencedEventBuffer } from "./event-stream.ts";
import type { EventCursor } from "./protocol.ts";
import { workerTokenSha256 } from "./supervisor-credentials.ts";
import { type WorkerDescriptor, WorkerRegistry } from "./worker-registry.ts";

export interface WorkerRequest {
	token: string;
	command: "status" | "attach" | "prompt" | "steer" | "adopt" | "stop";
	payload?: Record<string, unknown>;
	resumeCursor?: EventCursor;
}

export interface WorkerResponse {
	ok: boolean;
	message?: string;
	[key: string]: unknown;
}

export interface ResidentWorkerOptions {
	runDirectory: string;
	descriptor: WorkerDescriptor;
	token: string;
	initialMessage?: string;
	initialImages?: ImageContent[];
	eventReplayMaxCount?: number;
	eventReplayMaxBytes?: number;
	snapshotChunkBytes?: number;
	heartbeatSeconds?: number;
}

const WORKER_SOCKET_TIMEOUT_MS = 5_000;
const MAX_WORKER_REQUEST_BYTES = 1_048_576;
const MAX_WORKER_RESPONSE_BYTES = 20_971_520;

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Resident worker is missing ${name}`);
	return value;
}

export async function runResidentWorkerFromEnvironment(
	runtime: AgentSessionRuntime,
	taskRunContext: TaskRunContext | undefined,
	initialMessage?: string,
	initialImages?: ImageContent[],
): Promise<void> {
	const token = getWorkerStartup().token;
	const startedAt = requiredEnvironment("KARISSA_WORKER_STARTED_AT");
	if (!taskRunContext) throw new Error("Resident worker has no claimed Task run context");
	await runResidentWorkerHost(runtime, {
		runDirectory: requiredEnvironment("KARISSA_RUN_DIRECTORY"),
		token,
		initialMessage,
		initialImages,
		eventReplayMaxCount: Number(process.env.KARISSA_EVENT_REPLAY_MAX_COUNT ?? 10_000),
		eventReplayMaxBytes: Number(process.env.KARISSA_EVENT_REPLAY_MAX_BYTES ?? 16_777_216),
		snapshotChunkBytes: Number(process.env.KARISSA_SNAPSHOT_CHUNK_BYTES ?? 524_288),
		heartbeatSeconds: Number(process.env.KARISSA_WORKER_HEARTBEAT_SECONDS ?? 5),
		descriptor: {
			schemaVersion: 1,
			workerId: requiredEnvironment("KARISSA_WORKER_ID"),
			executionId: requiredEnvironment("KARISSA_EXECUTION_ID"),
			agentId: taskRunContext.agentId,
			taskId: taskRunContext.taskId,
			activeSessionId: runtime.session.sessionId,
			...(runtime.session.sessionFile === undefined ? {} : { sessionPath: runtime.session.sessionFile }),
			pid: process.pid,
			processGroupId: process.pid,
			supervisorGeneration: requiredEnvironment("KARISSA_SUPERVISOR_GENERATION"),
			privateSocketPath: requiredEnvironment("KARISSA_WORKER_SOCKET"),
			tokenSha256: createHash("sha256").update(token).digest("hex"),
			workspaceRoot: runtime.cwd,
			...(process.env.KARISSA_SANDBOX_ID ? { sandboxId: process.env.KARISSA_SANDBOX_ID } : {}),
			...(process.env.KARISSA_SANDBOX_PROFILE_SHA256
				? { sandboxProfileSha256: process.env.KARISSA_SANDBOX_PROFILE_SHA256 }
				: {}),
			lifecycle: "resident",
			state: "starting",
			heartbeatAt: startedAt,
			startedAt,
		},
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseWorkerRequest(value: unknown): WorkerRequest {
	if (!isRecord(value) || typeof value.token !== "string" || typeof value.command !== "string")
		throw new Error("Invalid worker request");
	if (
		!(
			value.command === "status" ||
			value.command === "attach" ||
			value.command === "prompt" ||
			value.command === "steer" ||
			value.command === "adopt" ||
			value.command === "stop"
		)
	)
		throw new Error(`Unknown worker command: ${value.command}`);
	if (value.payload !== undefined && !isRecord(value.payload)) throw new Error("Worker payload must be an object");
	return {
		token: value.token,
		command: value.command,
		...(value.payload === undefined ? {} : { payload: value.payload }),
		...(value.resumeCursor === undefined ? {} : { resumeCursor: value.resumeCursor as EventCursor }),
	};
}

export function requestWorker(socketPath: string, request: WorkerRequest): Promise<WorkerResponse> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let response = "";
		let responseBytes = 0;
		socket.setEncoding("utf8");
		socket.setTimeout(WORKER_SOCKET_TIMEOUT_MS, () => socket.destroy(new Error("Worker request timed out")));
		socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk) => {
			responseBytes += Buffer.byteLength(chunk);
			if (responseBytes > MAX_WORKER_RESPONSE_BYTES) {
				socket.destroy(new Error("Worker response exceeded the byte limit"));
				return;
			}
			response += chunk;
		});
		socket.on("error", reject);
		socket.on("end", () => {
			try {
				const value = JSON.parse(response.trim()) as unknown;
				if (!isRecord(value) || typeof value.ok !== "boolean") throw new Error("Invalid worker response");
				resolve(value as WorkerResponse);
			} catch (error) {
				reject(error);
			}
		});
	});
}

function boundedTranscript(
	messages: readonly unknown[],
	maxBytes: number,
): {
	messages: unknown[];
	truncated: boolean;
	totalMessages: number;
} {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_024) throw new Error("Invalid snapshot chunk byte limit");
	const retained: unknown[] = [];
	let bytes = 2;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		const messageBytes =
			Buffer.byteLength(JSON.stringify(message) ?? "null", "utf8") + (retained.length === 0 ? 0 : 1);
		if (bytes + messageBytes > maxBytes) break;
		retained.unshift(message);
		bytes += messageBytes;
	}
	return { messages: retained, truncated: retained.length < messages.length, totalMessages: messages.length };
}

export async function runResidentWorkerHost(
	runtime: AgentSessionRuntime,
	options: ResidentWorkerOptions,
): Promise<void> {
	const registry = new WorkerRegistry(options.runDirectory);
	const eventReplayMaxCount = options.eventReplayMaxCount ?? 10_000;
	const eventReplayMaxBytes = options.eventReplayMaxBytes ?? 16_777_216;
	let events = new SequencedEventBuffer<unknown>(
		eventReplayMaxCount,
		options.descriptor.supervisorGeneration,
		() => new Date(),
		eventReplayMaxBytes,
	);
	let token = options.token;
	const snapshotChunkBytes = options.snapshotChunkBytes ?? 524_288;
	if (!Number.isSafeInteger(snapshotChunkBytes) || snapshotChunkBytes < 1_024)
		throw new Error("Invalid snapshot chunk byte limit");
	let descriptor: WorkerDescriptor = {
		...options.descriptor,
		activeSessionId: runtime.session.sessionId,
		...(runtime.session.sessionFile === undefined ? {} : { sessionPath: runtime.session.sessionFile }),
		state: "running",
		heartbeatAt: new Date().toISOString(),
	};
	registry.write(descriptor);
	const unsubscribe = runtime.session.subscribe((event) => {
		events.publish(event.type, toJsonEvent(event));
	});
	const heartbeatSeconds = options.heartbeatSeconds ?? 5;
	if (!Number.isFinite(heartbeatSeconds) || heartbeatSeconds <= 0)
		throw new Error("Invalid Worker heartbeat interval");
	const heartbeat = setInterval(() => {
		descriptor = { ...descriptor, heartbeatAt: new Date().toISOString() };
		registry.write(descriptor);
	}, heartbeatSeconds * 1_000);
	let stopRequested = false;
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		let input = "";
		let inputBytes = 0;
		let rejected = false;
		socket.setEncoding("utf8");
		socket.setTimeout(WORKER_SOCKET_TIMEOUT_MS, () => socket.destroy());
		socket.on("data", (chunk) => {
			if (rejected) return;
			inputBytes += Buffer.byteLength(chunk);
			if (inputBytes > MAX_WORKER_REQUEST_BYTES) {
				rejected = true;
				socket.end(JSON.stringify({ ok: false, message: "worker request exceeds byte limit" }));
				return;
			}
			input += chunk;
		});
		socket.on("end", () => {
			if (rejected) return;
			void (async () => {
				try {
					const request = parseWorkerRequest(JSON.parse(input.trim()));
					if (request.token !== token) throw new Error("Worker authentication failed");
					if (request.command === "status") {
						socket.end(JSON.stringify({ ok: true, descriptor, cursor: events.currentCursor() }));
					} else if (request.command === "attach") {
						const replay = events.replay(request.resumeCursor);
						const transcript =
							replay.status === "snapshot_required"
								? boundedTranscript(runtime.session.state.messages, snapshotChunkBytes)
								: undefined;
						socket.end(
							JSON.stringify({
								ok: true,
								replayStatus: replay.status,
								cursor: replay.cursor,
								events: replay.events,
								snapshot:
									replay.status === "snapshot_required"
										? {
												schemaVersion: 1,
												cursor: replay.cursor,
												worker: descriptor,
												transcriptView: transcript?.messages ?? [],
												transcriptTruncated: transcript?.truncated ?? false,
												transcriptMessageCount: transcript?.totalMessages ?? 0,
												currentTurn: { state: runtime.session.isStreaming ? "streaming" : "settled" },
											}
										: undefined,
							}),
						);
					} else if (request.command === "adopt") {
						const supervisorGeneration = request.payload?.supervisorGeneration;
						const newToken = request.payload?.newToken;
						if (typeof supervisorGeneration !== "string" || supervisorGeneration.trim() === "")
							throw new Error("Worker adoption requires supervisorGeneration");
						if (typeof newToken !== "string" || newToken.length < 32)
							throw new Error("Worker adoption requires a new capability token");
						const transitionDescriptor: WorkerDescriptor = {
							...descriptor,
							supervisorGeneration,
							previousSupervisorGeneration: descriptor.supervisorGeneration,
							previousTokenSha256: workerTokenSha256(token),
							tokenSha256: workerTokenSha256(newToken),
							heartbeatAt: new Date().toISOString(),
						};
						registry.write(transitionDescriptor);
						descriptor = transitionDescriptor;
						token = newToken;
						events = new SequencedEventBuffer<unknown>(
							eventReplayMaxCount,
							supervisorGeneration,
							() => new Date(),
							eventReplayMaxBytes,
						);
						descriptor = {
							...transitionDescriptor,
							previousSupervisorGeneration: undefined,
							previousTokenSha256: undefined,
							heartbeatAt: new Date().toISOString(),
						};
						registry.write(descriptor);
						socket.end(JSON.stringify({ ok: true, descriptor, cursor: events.currentCursor() }));
					} else if (request.command === "prompt" || request.command === "steer") {
						const text = request.payload?.text;
						if (typeof text !== "string" || text.trim() === "") throw new Error("Worker prompt text is required");
						if (request.command === "steer") await runtime.session.steer(text);
						else {
							let acceptPrompt: (accepted: boolean) => void = () => {};
							const accepted = new Promise<boolean>((resolve) => {
								acceptPrompt = resolve;
							});
							void runtime.session
								.prompt(text, {
									streamingBehavior: runtime.session.isStreaming ? "followUp" : undefined,
									preflightResult: acceptPrompt,
								})
								.catch((error) => events.publish("WorkerPromptFailed", { message: String(error) }));
							if (!(await accepted)) throw new Error("Worker rejected the prompt before provider dispatch");
						}
						socket.end(JSON.stringify({ ok: true, accepted: true, cursor: events.currentCursor() }));
					} else {
						stopRequested = true;
						descriptor = { ...descriptor, state: "stopping", heartbeatAt: new Date().toISOString() };
						registry.write(descriptor);
						await runtime.session.abort();
						socket.end(JSON.stringify({ ok: true }));
						server.close();
					}
				} catch (error) {
					socket.end(
						JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }),
					);
				}
			})();
		});
	});

	try {
		if (existsSync(descriptor.privateSocketPath)) rmSync(descriptor.privateSocketPath);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(descriptor.privateSocketPath, () => {
				chmodSync(descriptor.privateSocketPath, 0o600);
				resolve();
			});
		});
		if (options.initialMessage)
			await runtime.session.prompt(options.initialMessage, { images: options.initialImages });
		await new Promise<void>((resolve) => server.once("close", resolve));
	} finally {
		clearInterval(heartbeat);
		unsubscribe();
		if (!stopRequested && runtime.session.isStreaming) await runtime.session.abort();
		descriptor = { ...descriptor, state: "exited", heartbeatAt: new Date().toISOString() };
		registry.write(descriptor);
		if (existsSync(descriptor.privateSocketPath)) rmSync(descriptor.privateSocketPath);
		await runtime.dispose();
	}
}
