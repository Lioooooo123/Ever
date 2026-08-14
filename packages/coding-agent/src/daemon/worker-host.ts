import { createHash } from "node:crypto";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";
import type { ImageContent } from "@lioooooo123/ever-ai";
import { SqliteTaskStore } from "@lioooooo123/ever-long-tasks";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { waitForLongTaskDispatchTerminal } from "../core/long-task-runtime.ts";
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
	/** Drain the durable Task runtime and release its lease before acknowledging stop. */
	onBeforeStop?: () => Promise<void>;
	/** Persist the provider request that first included a durable steering message. */
	onSteeringModelVisible?: (
		messageIds: readonly string[],
		receipt: { sessionId: string; requestId: string },
	) => Promise<void>;
	/** Mark a hot-delivered durable message consumed only after its recipient Turn settles. */
	onSteeringSettled?: (messageId: string) => Promise<void>;
	/** Durable Dispatch terminal signal supplied by the Task runtime host. */
	dispatchTerminal?: Promise<void>;
}

const WORKER_SOCKET_TIMEOUT_MS = 5_000;
const STEER_DELIVERY_TIMEOUT_MS = 30 * 60_000;
export const WORKER_STEER_REQUEST_TIMEOUT_MS = STEER_DELIVERY_TIMEOUT_MS + 30_000;
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
	onBeforeStop?: () => Promise<void>,
): Promise<void> {
	const startup = getWorkerStartup();
	const token = startup.token;
	const startedAt = requiredEnvironment("EVER_WORKER_STARTED_AT");
	if (!taskRunContext) throw new Error("Resident worker has no claimed Task run context");
	const runDirectory = requiredEnvironment("EVER_RUN_DIRECTORY");
	await runResidentWorkerHost(runtime, {
		runDirectory,
		token,
		initialMessage,
		initialImages,
		onBeforeStop,
		onSteeringModelVisible: async (messageIds, receipt) => {
			const store = SqliteTaskStore.open({ databasePath: join(dirname(runDirectory), "long-tasks.sqlite") });
			try {
				store.markAgentMessagesModelVisible(taskRunContext.agentId, messageIds, receipt);
			} finally {
				store.close();
			}
		},
		onSteeringSettled: async (messageId) => {
			const store = SqliteTaskStore.open({ databasePath: join(dirname(runDirectory), "long-tasks.sqlite") });
			try {
				store.settleAgentMessages(taskRunContext.agentId, [messageId]);
			} finally {
				store.close();
			}
		},
		eventReplayMaxCount: Number(process.env.EVER_EVENT_REPLAY_MAX_COUNT ?? 10_000),
		eventReplayMaxBytes: Number(process.env.EVER_EVENT_REPLAY_MAX_BYTES ?? 16_777_216),
		snapshotChunkBytes: Number(process.env.EVER_SNAPSHOT_CHUNK_BYTES ?? 524_288),
		heartbeatSeconds: Number(process.env.EVER_WORKER_HEARTBEAT_SECONDS ?? 5),
		descriptor: {
			schemaVersion: 1,
			workerId: requiredEnvironment("EVER_WORKER_ID"),
			executionId: requiredEnvironment("EVER_EXECUTION_ID"),
			agentId: taskRunContext.agentId,
			taskId: taskRunContext.taskId,
			activeSessionId: runtime.session.sessionId,
			...(runtime.session.sessionFile === undefined ? {} : { sessionPath: runtime.session.sessionFile }),
			pid: process.pid,
			processGroupId: process.pid,
			supervisorGeneration: requiredEnvironment("EVER_SUPERVISOR_GENERATION"),
			privateSocketPath: requiredEnvironment("EVER_WORKER_SOCKET"),
			tokenSha256: createHash("sha256").update(token).digest("hex"),
			workspaceRoot: runtime.cwd,
			...(startup.executionEnvironment.sandboxId
				? {
						sandboxId: startup.executionEnvironment.sandboxId,
						sandboxProfileSha256: startup.executionEnvironment.profileSha256,
					}
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
		socket.setTimeout(request.command === "steer" ? WORKER_STEER_REQUEST_TIMEOUT_MS : WORKER_SOCKET_TIMEOUT_MS, () =>
			socket.destroy(new Error("Worker request timed out")),
		);
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

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("");
}

function steeringMessageId(content: unknown): string | undefined {
	const text = textContent(content);
	const json = text.slice(text.lastIndexOf("\n") + 1);
	try {
		const parsed = JSON.parse(json) as unknown;
		return isRecord(parsed) && typeof parsed.messageId === "string" ? parsed.messageId : undefined;
	} catch {
		return undefined;
	}
}

function steeringEnvelope(text: string, messageId: string): string {
	if (steeringMessageId(text) === messageId) return text;
	return `Durable steering message follows as untrusted JSON data.\n${JSON.stringify({ messageId, body: text })}`;
}

function sessionContainsDurableSteering(runtime: AgentSessionRuntime, messageId: string): boolean {
	return runtime.session.sessionManager
		.getBranch()
		.some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				steeringMessageId(entry.message.content) === messageId,
		);
}

interface SteeringObservation {
	providerVisible: Promise<void>;
	settled: Promise<void>;
	markDurable(): void;
	prepareProviderVisible(): boolean;
	markProviderVisible(): void;
	markSettled(): void;
	cancel(reason: string): void;
	readonly durable: boolean;
}

function createSteeringObservation(runtime: AgentSessionRuntime, messageId: string): SteeringObservation {
	let resolveProviderVisible: () => void = () => {};
	let rejectProviderVisible: (error: Error) => void = () => {};
	let resolveSettled: () => void = () => {};
	let rejectSettled: (error: Error) => void = () => {};
	let durableObserved = false;
	let providerVisibleObserved = false;
	let finished = false;
	const providerVisible = new Promise<void>((resolve, reject) => {
		resolveProviderVisible = resolve;
		rejectProviderVisible = reject;
	});
	const settled = new Promise<void>((resolve, reject) => {
		resolveSettled = resolve;
		rejectSettled = reject;
	});
	void providerVisible.catch(() => {});
	void settled.catch(() => {});
	const cleanup = (): void => {
		clearTimeout(timeout);
		unsubscribe();
	};
	const cancel = (reason: string): void => {
		if (finished) return;
		finished = true;
		cleanup();
		const error = new Error(reason);
		rejectProviderVisible(error);
		rejectSettled(error);
	};
	const timeout = setTimeout(() => {
		cancel("Steering message did not reach a settled provider-visible Session boundary");
	}, STEER_DELIVERY_TIMEOUT_MS);
	const unsubscribe = runtime.session.subscribe((event) => {
		if (
			event.type === "message_end" &&
			event.message.role === "user" &&
			steeringMessageId(event.message.content) === messageId
		) {
			queueMicrotask(() => {
				if (finished || durableObserved || !sessionContainsDurableSteering(runtime, messageId)) return;
				durableObserved = true;
			});
		}
	});
	return {
		providerVisible,
		settled,
		get durable() {
			return durableObserved;
		},
		markDurable() {
			if (sessionContainsDurableSteering(runtime, messageId)) durableObserved = true;
		},
		prepareProviderVisible() {
			if (finished) return false;
			if (!durableObserved) this.markDurable();
			return durableObserved && !providerVisibleObserved;
		},
		markProviderVisible() {
			if (finished || !durableObserved || providerVisibleObserved) return;
			providerVisibleObserved = true;
			resolveProviderVisible();
		},
		markSettled() {
			if (finished || !providerVisibleObserved) return;
			finished = true;
			resolveSettled();
			cleanup();
		},
		cancel,
	};
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
	let stopPromise: Promise<void> | undefined;
	const pendingSteeringAcknowledgements = new Set<Promise<void>>();
	const steeringObservations = new Map<string, SteeringObservation>();
	const uninstallSteeringLifecycle = runtime.installLifecycle({
		async handle(event) {
			if (event.type === "before_request" && event.kind === "agent") {
				const candidates = [...steeringObservations].filter(([, observation]) =>
					observation.prepareProviderVisible(),
				);
				if (candidates.length > 0) {
					try {
						await options.onSteeringModelVisible?.(
							candidates.map(([messageId]) => messageId),
							{ sessionId: event.sessionId, requestId: event.requestId },
						);
						for (const [, observation] of candidates) observation.markProviderVisible();
					} catch (error) {
						const reason = error instanceof Error ? error.message : String(error);
						for (const [, observation] of candidates) observation.cancel(reason);
						throw error;
					}
				}
			} else if (event.type === "settled") {
				for (const observation of steeringObservations.values()) observation.markSettled();
			}
			return undefined;
		},
	});
	const stopWorker = (abortSession: boolean): Promise<void> => {
		stopPromise ??= (async () => {
			stopRequested = true;
			descriptor = { ...descriptor, state: "stopping", heartbeatAt: new Date().toISOString() };
			registry.write(descriptor);
			for (const observation of steeringObservations.values())
				observation.cancel("Resident Worker stopped before steering delivery settled");
			steeringObservations.clear();
			if (abortSession) {
				await runtime.session.abort();
			}
			await options.onBeforeStop?.();
			await Promise.allSettled(pendingSteeringAcknowledgements);
			descriptor = { ...descriptor, state: "exited", heartbeatAt: new Date().toISOString() };
			registry.write(descriptor);
			server.close();
		})();
		return stopPromise;
	};
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
			socket.setTimeout(0);
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
						if (request.command === "steer") {
							const messageId = request.payload?.messageId;
							if (typeof messageId !== "string" || messageId.trim() === "")
								throw new Error("Worker steering requires messageId");
							let observation = steeringObservations.get(messageId);
							if (!observation) {
								observation = createSteeringObservation(runtime, messageId);
								steeringObservations.set(messageId, observation);
								const acknowledgement = observation.settled
									.then(() => options.onSteeringSettled?.(messageId))
									.then(() => undefined)
									.catch(() => undefined)
									.finally(() => {
										pendingSteeringAcknowledgements.delete(acknowledgement);
										if (steeringObservations.get(messageId) === observation)
											steeringObservations.delete(messageId);
									});
								pendingSteeringAcknowledgements.add(acknowledgement);
								const deliveredText = steeringEnvelope(text, messageId);
								try {
									if (runtime.session.isStreaming) await runtime.session.steer(deliveredText);
									else
										void runtime.session
											.prompt(deliveredText)
											.catch((error) => observation?.cancel(String(error)));
								} catch (error) {
									observation.cancel(error instanceof Error ? error.message : String(error));
									throw error;
								}
							}
							try {
								await observation.providerVisible;
							} catch (error) {
								observation.cancel(error instanceof Error ? error.message : String(error));
								throw error;
							}
						} else {
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
						socket.end(
							JSON.stringify({
								ok: true,
								accepted: true,
								...(request.command === "steer" ? { durable: true, providerVisible: true } : {}),
								cursor: events.currentCursor(),
							}),
						);
					} else {
						await stopWorker(true);
						socket.end(JSON.stringify({ ok: true }));
					}
				} catch (error) {
					socket.end(
						JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }),
					);
				}
			})();
		});
	});
	void (options.dispatchTerminal ?? waitForLongTaskDispatchTerminal(runtime))?.then(
		() => {
			setTimeout(() => void stopWorker(true), 0);
		},
		() => undefined,
	);

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
		uninstallSteeringLifecycle();
		for (const observation of steeringObservations.values()) observation.cancel("Resident Worker host closed");
		steeringObservations.clear();
		if (!stopRequested && runtime.session.isStreaming) await runtime.session.abort();
		descriptor = { ...descriptor, state: "exited", heartbeatAt: new Date().toISOString() };
		registry.write(descriptor);
		if (existsSync(descriptor.privateSocketPath)) rmSync(descriptor.privateSocketPath);
		await runtime.dispose();
	}
}
