import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
	resolveAgentExecutionContext,
	type ScheduleClaim,
	ScheduleEngine,
	type ScheduleRecord,
	SqliteTaskStore,
	TaskNotificationDispatcher,
} from "@karissa/long-tasks";
import chalk from "chalk";
import { ENV_AGENT_DIR } from "../config.ts";
import { recoverExpiredLongTaskExecutions } from "../core/long-task-runtime.ts";
import { SequencedEventBuffer } from "../daemon/event-stream.ts";
import {
	createDaemonCommand,
	type DaemonCommandEnvelope,
	daemonCommandPayloadSha256,
	daemonResponse,
	parseDaemonCommand,
	parseDaemonResponse,
} from "../daemon/protocol.ts";
import {
	createDaemonServiceDefinition,
	installDaemonService,
	isDaemonServiceLoaded,
	uninstallDaemonService,
} from "../daemon/service-manager.ts";
import { deriveWorkerToken, workerTokenSha256 } from "../daemon/supervisor-credentials.ts";
import { adoptResidentWorkers } from "../daemon/supervisor-takeover.ts";
import { requestWorker } from "../daemon/worker-host.ts";
import { type WorkerDescriptor, WorkerRegistry } from "../daemon/worker-registry.ts";
import { DesktopNotificationAdapter } from "./desktop-notifier.ts";

export interface DaemonResponse {
	ok: boolean;
	pid?: number;
	runningTaskIds?: string[];
	message?: string;
	[key: string]: unknown;
}

export interface DaemonRuntimeSettings {
	maxConcurrentTasks: number;
	maxConcurrentAgentsPerTask: number;
	workerHeartbeatSeconds: number;
	workerLeaseSeconds: number;
	eventReplayMaxCount: number;
	eventReplayMaxBytes: number;
	snapshotChunkBytes: number;
	commandJournalRetentionDays: number;
	continuation: {
		maxIdenticalProgressTurns: number;
		pauseAfterIdenticalProgressTurns: number;
		maxRepeatedFailureTurns: number;
		pauseAfterRepeatedFailureTurns: number;
		maxAutomaticContinuationTurnsPerAttempt: number;
	};
}

const SOCKET_TIMEOUT_MS = 5_000;
const MAX_DAEMON_REQUEST_BYTES = 1_048_576;
const MAX_DAEMON_RESPONSE_BYTES = 4_194_304;

function paths(agentDir: string) {
	const runDir = join(agentDir, "run");
	return {
		runDir,
		socketPath: join(runDir, "karissa.sock"),
		pidPath: join(runDir, "karissa.pid"),
		clientIdPath: join(runDir, "client-id"),
		controlTokenPath: join(runDir, "control-token"),
	};
}

function readOrCreateOwnerSecret(path: string): string {
	try {
		const existing = readFileSync(path, "utf8").trim();
		if (existing) return existing;
	} catch {
		// Create the owner-only secret below.
	}
	const secret = randomUUID();
	try {
		const fd = openSync(path, "wx", 0o600);
		writeFileSync(fd, `${secret}\n`);
		closeSync(fd);
		return secret;
	} catch (error) {
		const existing = readFileSync(path, "utf8").trim();
		if (existing) return existing;
		throw error;
	}
}

function readOrCreateClientId(agentDir: string): string {
	const { runDir, clientIdPath } = paths(agentDir);
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	return readOrCreateOwnerSecret(clientIdPath);
}

function readOrCreateControlToken(agentDir: string): string {
	const { runDir, controlTokenPath } = paths(agentDir);
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	return readOrCreateOwnerSecret(controlTokenPath);
}

function tokensEqual(actual: string | undefined, expected: string): boolean {
	if (!actual) return false;
	const actualBytes = Buffer.from(actual);
	const expectedBytes = Buffer.from(expected);
	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readPid(pidPath: string): number | undefined {
	try {
		const pid = Number(readFileSync(pidPath, "utf8").trim());
		return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

export function requestDaemon(
	agentDir: string,
	request: Record<string, unknown>,
	identity: { clientId?: string; commandId?: string; authToken?: string } = {},
): Promise<DaemonResponse> {
	const { socketPath } = paths(agentDir);
	const command = createDaemonCommand(request, {
		clientId: identity.clientId ?? readOrCreateClientId(agentDir),
		commandId: identity.commandId,
		authToken: identity.authToken ?? readOrCreateControlToken(agentDir),
	});
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let response = "";
		let responseBytes = 0;
		socket.setEncoding("utf8");
		socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy(new Error("Daemon request timed out")));
		socket.on("connect", () => socket.end(`${JSON.stringify(command)}\n`));
		socket.on("data", (chunk) => {
			responseBytes += Buffer.byteLength(chunk);
			if (responseBytes > MAX_DAEMON_RESPONSE_BYTES) {
				socket.destroy(new Error("Daemon response exceeded the byte limit"));
				return;
			}
			response += chunk;
		});
		socket.on("error", reject);
		socket.on("end", () => {
			try {
				const envelope = parseDaemonResponse(JSON.parse(response.trim()));
				if (envelope.commandId !== command.commandId) throw new Error("Daemon response commandId mismatch");
				resolve(envelope.body);
			} catch (error) {
				reject(error instanceof Error ? error : new Error("Daemon returned an invalid response"));
			}
		});
	});
}

async function waitForDaemon(agentDir: string, attempts = 20): Promise<DaemonResponse> {
	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await requestDaemon(agentDir, { command: "status" });
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Daemon did not start");
}

async function serve(
	agentDir: string,
	unsafeNoSandbox: boolean,
	settings: DaemonRuntimeSettings = {
		maxConcurrentTasks: 1,
		maxConcurrentAgentsPerTask: 4,
		workerHeartbeatSeconds: 5,
		workerLeaseSeconds: 30,
		eventReplayMaxCount: 10_000,
		eventReplayMaxBytes: 16_777_216,
		snapshotChunkBytes: 524_288,
		commandJournalRetentionDays: 7,
		continuation: {
			maxIdenticalProgressTurns: 2,
			pauseAfterIdenticalProgressTurns: 3,
			maxRepeatedFailureTurns: 2,
			pauseAfterRepeatedFailureTurns: 3,
			maxAutomaticContinuationTurnsPerAttempt: 25,
		},
	},
): Promise<void> {
	const { runDir, socketPath, pidPath } = paths(agentDir);
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	chmodSync(runDir, 0o700);
	const previousPid = readPid(pidPath);
	if (previousPid && isProcessAlive(previousPid)) throw new Error(`Daemon already running with PID ${previousPid}`);
	if (existsSync(pidPath)) rmSync(pidPath);
	if (existsSync(socketPath)) rmSync(socketPath);
	const pidFd = openSync(pidPath, "wx", 0o600);
	writeFileSync(pidFd, `${process.pid}\n`);
	closeSync(pidFd);

	const store = SqliteTaskStore.open({
		databasePath: join(agentDir, "long-tasks.sqlite"),
		artifactsRoot: join(agentDir, "tasks"),
	});
	const controlToken = readOrCreateControlToken(agentDir);
	const notifications = new TaskNotificationDispatcher(store, new DesktopNotificationAdapter());
	const scheduleEngine = new ScheduleEngine(store);
	store.markInterruptedDaemonCommandsUncertain();
	store.pruneDaemonCommands(settings.commandJournalRetentionDays);
	const workerRegistry = new WorkerRegistry(runDir);
	const supervisorGeneration = randomUUID();
	const eventBuffer = new SequencedEventBuffer<unknown>(
		settings.eventReplayMaxCount,
		supervisorGeneration,
		() => new Date(),
		settings.eventReplayMaxBytes,
	);
	const workers = new Map<
		string,
		{ child?: ReturnType<typeof spawn>; taskId: string; descriptor: WorkerDescriptor; token: string }
	>();
	let stopping = false;
	const cliEntry = process.argv[1];

	for (const adopted of await adoptResidentWorkers({
		descriptors: workerRegistry.list(),
		controlToken,
		supervisorGeneration,
		isProcessAlive,
	})) {
		workers.set(adopted.descriptor.agentId, adopted);
		eventBuffer.publish("WorkerAdopted", adopted.descriptor);
	}

	let scheduling = false;
	const schedule = async (): Promise<void> => {
		if (scheduling) return;
		scheduling = true;
		try {
			await recoverExpiredLongTaskExecutions(store);
			await notifications.dispatchPending();
			for (const due of store.listDueSchedules(new Date().toISOString(), 100)) {
				const hasWorker =
					(due.agentId && workers.has(due.agentId)) ||
					(!due.agentId && [...workers.values()].some((worker) => worker.taskId === due.taskId));
				const task = store.requireTask(due.taskId);
				if (task.state === "waiting_external") {
					store.transitionTask(task.id, "queued", "schedule_due");
					if (hasWorker) store.transitionTask(task.id, "running", "resident_worker_resumed");
				}
			}
			for (const worker of workers.values()) {
				const taskState = store.requireTask(worker.taskId).state;
				if (taskState === "queued" || taskState === "running") continue;
				try {
					await requestWorker(worker.descriptor.privateSocketPath, {
						token: worker.token,
						command: "stop",
					});
				} catch {
					// The process exit and recovery paths reconcile an unreachable Worker.
				}
			}
			const readyWorkerIds = new Set<string>();
			for (const worker of workers.values()) {
				try {
					const status = await requestWorker(worker.descriptor.privateSocketPath, {
						token: worker.token,
						command: "status",
					});
					if (status.ok) {
						const currentDescriptor = status.descriptor;
						if (
							currentDescriptor &&
							typeof currentDescriptor === "object" &&
							"workerId" in currentDescriptor &&
							currentDescriptor.workerId === worker.descriptor.workerId
						) {
							worker.descriptor = currentDescriptor as WorkerDescriptor;
						}
						readyWorkerIds.add(worker.descriptor.agentId);
					}
				} catch {
					if (!isProcessAlive(worker.descriptor.pid)) {
						workers.delete(worker.descriptor.agentId);
						const exited = {
							...worker.descriptor,
							state: "exited" as const,
							heartbeatAt: new Date().toISOString(),
						};
						workerRegistry.write(exited);
						eventBuffer.publish("WorkerLost", exited);
					}
				}
			}
			const deliverScheduleClaim = async (claim: ScheduleClaim) => {
				const worker = [...workers.values()].find(
					(candidate) =>
						candidate.taskId === claim.schedule.taskId &&
						(claim.schedule.agentId === undefined || candidate.descriptor.agentId === claim.schedule.agentId),
				);
				if (!worker) return false;
				if (claim.schedule.payload.heartbeat === true && claim.schedule.payload.hasAction === false) {
					store.appendTaskEvent(claim.schedule.taskId, "ScheduleNoAction", {
						scheduleId: claim.schedule.id,
						claimId: claim.claimId,
						schemaVersion: 1,
					});
					return true;
				}
				const configuredPrompt = claim.schedule.payload.prompt;
				const prompt = `${typeof configuredPrompt === "string" ? configuredPrompt : "Evaluate the scheduled durable Task."}
Schedule claim: ${claim.claimId}
Due at: ${claim.dueAt}
Coalesced ticks: ${claim.missedCount}`;
				const response = await requestWorker(worker.descriptor.privateSocketPath, {
					token: worker.token,
					command: "prompt",
					payload: { text: prompt, scheduleId: claim.schedule.id, claimId: claim.claimId },
				});
				return response.ok;
			};
			const scheduleEligible = (candidateSchedule: ScheduleRecord) => {
				if (candidateSchedule.agentId) return readyWorkerIds.has(candidateSchedule.agentId);
				return [...workers.values()].some(
					(worker) => worker.taskId === candidateSchedule.taskId && readyWorkerIds.has(worker.descriptor.agentId),
				);
			};
			await scheduleEngine.deliverDue(deliverScheduleClaim, 100, scheduleEligible);
			await scheduleEngine.deliverEvents(deliverScheduleClaim, 100, scheduleEligible);
			if (stopping || !cliEntry) return;
			const workerCountsByTask = new Map<string, number>();
			for (const worker of workers.values()) {
				workerCountsByTask.set(worker.taskId, (workerCountsByTask.get(worker.taskId) ?? 0) + 1);
			}
			const activeTaskIds = new Set(workerCountsByTask.keys());
			const task = store.listRunnableTasks(100).find((candidate) => {
				const activeWorkers = workerCountsByTask.get(candidate.id) ?? 0;
				if (activeWorkers >= settings.maxConcurrentAgentsPerTask) return false;
				return activeTaskIds.has(candidate.id) || activeTaskIds.size < settings.maxConcurrentTasks;
			});
			if (!task) return;
			if (!unsafeNoSandbox && process.env.KARISSA_UNATTENDED_SANDBOX !== "1") {
				if (task.state === "queued") {
					store.transitionTask(task.id, "paused", "sandbox_required");
					store.appendTaskEvent(task.id, "SecurityPolicyDenied", {
						reason: "background execution requires a sandbox",
						schemaVersion: 1,
					});
				}
				return;
			}
			const agent = store.listRunnableAgents(task.id, 4)[0];
			if (!agent || workers.has(agent.id)) return;
			const executionContext = resolveAgentExecutionContext(store, task.id, agent.id);
			const logDir = join(agentDir, "tasks", task.id);
			mkdirSync(logDir, { recursive: true, mode: 0o700 });
			const logFd = openSync(join(logDir, "daemon.log"), "a", 0o600);
			const workerArgs =
				agent.kind === "main"
					? [cliEntry, "task", "run", task.id, "--print"]
					: [cliEntry, "task", "agent", "run", task.id, agent.id, "--print"];
			const workerId = randomUUID();
			const token = deriveWorkerToken(controlToken, workerId, supervisorGeneration);
			const privateSocketPath = join(runDir, "workers", `${agent.id}.sock`);
			const startedAt = new Date().toISOString();
			const child = spawn(process.execPath, workerArgs, {
				cwd: executionContext.canonicalWorkspaceRoot,
				detached: true,
				stdio: ["ignore", logFd, logFd, "pipe"],
				env: {
					...process.env,
					KARISSA_DAEMON_WORKER: "1",
					KARISSA_RESIDENT_WORKER: "1",
					KARISSA_TASK_RUN_ID: task.id,
					KARISSA_AGENT_RUN_ID: agent.id,
					KARISSA_WORKER_ID: workerId,
					KARISSA_WORKER_SOCKET: privateSocketPath,
					KARISSA_WORKER_STARTED_AT: startedAt,
					KARISSA_SUPERVISOR_GENERATION: supervisorGeneration,
					KARISSA_RUN_DIRECTORY: runDir,
					KARISSA_WORKER_HEARTBEAT_SECONDS: String(settings.workerHeartbeatSeconds),
					KARISSA_WORKER_LEASE_SECONDS: String(settings.workerLeaseSeconds),
					KARISSA_EVENT_REPLAY_MAX_COUNT: String(settings.eventReplayMaxCount),
					KARISSA_EVENT_REPLAY_MAX_BYTES: String(settings.eventReplayMaxBytes),
					KARISSA_SNAPSHOT_CHUNK_BYTES: String(settings.snapshotChunkBytes),
					...(unsafeNoSandbox ? { KARISSA_UNSAFE_NO_SANDBOX: "1" } : {}),
				},
			});
			const tokenChannel = child.stdio[3];
			if (!(tokenChannel instanceof Writable))
				throw new Error(`Worker token channel did not open for agent ${agent.id}`);
			tokenChannel.end(`${token}\n`);
			closeSync(logFd);
			if (!child.pid) throw new Error(`Worker process did not start for agent ${agent.id}`);
			const descriptor: WorkerDescriptor = {
				schemaVersion: 1,
				workerId,
				agentId: agent.id,
				taskId: task.id,
				activeSessionId: "",
				pid: child.pid,
				processGroupId: child.pid,
				supervisorGeneration,
				privateSocketPath,
				tokenSha256: workerTokenSha256(token),
				workspaceRoot: executionContext.canonicalWorkspaceRoot,
				lifecycle: "resident",
				state: "starting",
				heartbeatAt: startedAt,
				startedAt,
			};
			workerRegistry.write(descriptor);
			workers.set(agent.id, { child, taskId: task.id, descriptor, token });
			eventBuffer.publish("WorkerStarted", descriptor);
			child.once("exit", (code) => {
				workers.delete(agent.id);
				const latestDescriptor = workerRegistry
					.list()
					.find((candidate) => candidate.workerId === descriptor.workerId);
				const exitedDescriptor: WorkerDescriptor = {
					...(latestDescriptor ?? descriptor),
					state: "exited",
					heartbeatAt: new Date().toISOString(),
				};
				workerRegistry.write(exitedDescriptor);
				eventBuffer.publish("WorkerExited", { ...exitedDescriptor, exitCode: code });
				if (code && code !== 0) {
					const currentTask = store.requireTask(task.id);
					const currentAgent = store.requireAgent(agent.id);
					if (["queued", "running"].includes(currentTask.state) && currentAgent.state === "queued") {
						store.transitionAgent(agent.id, "paused", "worker_failed");
						store.transitionTask(task.id, "waiting_input", "worker_failed");
					}
				}
				runSchedule();
			});
		} finally {
			scheduling = false;
		}
	};
	const runSchedule = (): void => {
		void schedule().catch((error) => {
			eventBuffer.publish("SchedulerFailed", {
				message: error instanceof Error ? error.message : String(error),
			});
		});
	};

	const interval = setInterval(runSchedule, 1000);
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		let input = "";
		let inputBytes = 0;
		let rejected = false;
		socket.setEncoding("utf8");
		socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
		socket.on("data", (chunk) => {
			if (rejected) return;
			inputBytes += Buffer.byteLength(chunk);
			if (inputBytes > MAX_DAEMON_REQUEST_BYTES) {
				rejected = true;
				socket.end(
					JSON.stringify(
						daemonResponse("invalid", "rejected", { ok: false, message: "daemon request exceeds byte limit" }),
					),
				);
				return;
			}
			input += chunk;
		});
		socket.on("end", () => {
			if (rejected) return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(input.trim());
			} catch {
				socket.end(JSON.stringify(daemonResponse("invalid", "rejected", { ok: false, message: "invalid JSON" })));
				return;
			}
			void (async () => {
				let command: DaemonCommandEnvelope;
				try {
					command = parseDaemonCommand(parsed);
				} catch (error) {
					socket.end(
						JSON.stringify(
							daemonResponse("invalid", "rejected", {
								ok: false,
								message: error instanceof Error ? error.message : String(error),
							}),
						),
					);
					return;
				}
				let journaled = false;
				try {
					if (!tokensEqual(command.authToken, controlToken)) throw new Error("Daemon authentication failed");
					if (command.command === "acknowledge") {
						const targetClientId = command.payload.clientId;
						const targetCommandId = command.payload.commandId;
						if (typeof targetClientId !== "string" || typeof targetCommandId !== "string")
							throw new Error("acknowledge requires clientId and commandId");
						store.acknowledgeDaemonCommand(targetClientId, targetCommandId);
						socket.end(JSON.stringify(daemonResponse(command.commandId, "completed", { ok: true })));
						return;
					}
					const received = store.receiveDaemonCommand({
						clientId: command.clientId,
						commandId: command.commandId,
						commandType: command.command,
						payloadSha256: daemonCommandPayloadSha256(command),
						payload: command.payload,
					});
					if (received.duplicate) {
						if (received.command.state === "completed" || received.command.state === "acknowledged") {
							const result = received.command.result;
							if (!result || typeof result.ok !== "boolean")
								throw new Error("Stored daemon response is corrupt");
							socket.end(
								JSON.stringify(daemonResponse(command.commandId, "completed", { ...result, ok: result.ok })),
							);
							return;
						}
						if (received.command.state === "uncertain") {
							socket.end(
								JSON.stringify(
									daemonResponse(command.commandId, "uncertain", {
										ok: false,
										message: received.command.error ?? "command outcome is uncertain",
									}),
								),
							);
							return;
						}
						socket.end(
							JSON.stringify(
								daemonResponse(command.commandId, "in_progress", {
									ok: false,
									message: "Daemon command is already in progress",
								}),
							),
						);
						return;
					}
					journaled = true;
					store.markDaemonCommandDispatched(command.clientId, command.commandId);
					const runningTaskIds = [...new Set([...workers.values()].map((worker) => worker.taskId))];
					let body: DaemonResponse;
					if (command.command === "hello") {
						body = {
							ok: true,
							pid: process.pid,
							protocolVersion: 1,
							supervisorGeneration,
							capabilities: ["resident-worker", "attach", "prompt", "steer", "command-journal"],
						};
					} else if (command.command === "status" || command.command === "wake") {
						runSchedule();
						body = {
							ok: true,
							pid: process.pid,
							runningTaskIds,
							supervisorGeneration,
							workers: [...workers.values()].map((worker) => worker.descriptor),
						};
					} else if (
						command.command === "attach" ||
						command.command === "prompt" ||
						command.command === "steer" ||
						command.command === "stop-agent" ||
						command.command === "pause-agent" ||
						command.command === "cancel-agent"
					) {
						const taskId = command.payload.taskId;
						const agentId = command.payload.agentId;
						if (typeof taskId !== "string" && typeof agentId !== "string")
							throw new Error("Worker command requires taskId or agentId");
						let resolvedMatches = [...workers.values()];
						if (typeof taskId === "string") {
							const exactTaskMatches = resolvedMatches.filter((candidate) => candidate.taskId === taskId);
							resolvedMatches =
								exactTaskMatches.length > 0
									? exactTaskMatches
									: resolvedMatches.filter((candidate) => candidate.taskId.startsWith(taskId));
						}
						if (typeof agentId === "string") {
							const exactAgentMatches = resolvedMatches.filter(
								(candidate) => candidate.descriptor.agentId === agentId,
							);
							resolvedMatches =
								exactAgentMatches.length > 0
									? exactAgentMatches
									: resolvedMatches.filter((candidate) => candidate.descriptor.agentId.startsWith(agentId));
						}
						if (resolvedMatches.length > 1) throw new Error("Worker command target prefix is ambiguous");
						const worker = resolvedMatches[0];
						if (!worker) throw new Error("Resident worker not found for command target");
						if (
							command.command === "pause-agent" ||
							command.command === "stop-agent" ||
							command.command === "cancel-agent"
						) {
							const agent = store.requireAgent(worker.descriptor.agentId);
							const cancelled = command.command === "cancel-agent";
							if (agent.kind === "main") {
								store.transitionTask(agent.taskId, cancelled ? "cancelled" : "paused", "user_requested");
							} else {
								store.transitionAgent(agent.id, cancelled ? "cancelled" : "paused", "user_requested");
							}
						}
						const workerCommand =
							command.command === "pause-agent" ||
							command.command === "cancel-agent" ||
							command.command === "stop-agent"
								? "stop"
								: command.command;
						body = await requestWorker(worker.descriptor.privateSocketPath, {
							token: worker.token,
							command: workerCommand,
							payload: command.payload,
							...(command.resumeCursor ? { resumeCursor: command.resumeCursor } : {}),
						});
					} else if (command.command === "detach") {
						body = { ok: true, message: "detached" };
					} else if (command.command === "stop") {
						stopping = true;
						for (const worker of workers.values()) {
							await requestWorker(worker.descriptor.privateSocketPath, {
								token: worker.token,
								command: "stop",
							});
						}
						body = {
							ok: true,
							pid: process.pid,
							message: "stopping",
						};
					} else {
						throw new Error(`Unsupported daemon command: ${command.command}`);
					}
					store.completeDaemonCommand(command.clientId, command.commandId, body);
					socket.end(JSON.stringify(daemonResponse(command.commandId, "completed", body)));
					if (command.command === "stop") server.close();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (journaled) {
						const stored = store.getDaemonCommand(command.clientId, command.commandId);
						if (stored?.state === "received" || stored?.state === "dispatched")
							store.markDaemonCommandUncertain(command.clientId, command.commandId, message);
					}
					socket.end(JSON.stringify(daemonResponse(command.commandId, "rejected", { ok: false, message })));
				}
			})();
		});
	});

	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				chmodSync(socketPath, 0o600);
				resolve();
			});
		});
		runSchedule();
		await new Promise<void>((resolve) => server.once("close", resolve));
		const deadline = Date.now() + 30_000;
		while (workers.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
		for (const worker of workers.values()) {
			try {
				process.kill(-worker.descriptor.processGroupId, "SIGTERM");
			} catch {
				worker.child?.kill("SIGTERM");
			}
		}
	} finally {
		clearInterval(interval);
		store.close();
		if (existsSync(socketPath)) rmSync(socketPath);
		if (existsSync(pidPath)) rmSync(pidPath);
	}
}

function serviceDefinition(agentDir: string) {
	const cliEntry = process.argv[1] ?? "karissa";
	return createDaemonServiceDefinition({
		platform: process.platform,
		homeDirectory: process.env.HOME ?? agentDir,
		agentDirectory: agentDir,
		agentDirectoryEnvironmentName: ENV_AGENT_DIR,
		nodePath: process.execPath,
		cliEntry,
	});
}

function printHelp(): void {
	console.log(
		`karissa daemon commands:\n  karissa daemon start [--unsafe-no-sandbox]\n  karissa daemon status\n  karissa daemon workers\n  karissa daemon shutdown\n  karissa daemon install\n  karissa daemon uninstall\n  karissa daemon doctor`,
	);
}

export async function startDaemon(agentDir: string, unsafeNoSandbox = false): Promise<DaemonResponse> {
	try {
		const status = await requestDaemon(agentDir, { command: "status" });
		if (status.ok) return status;
	} catch {
		// Start a new daemon below.
	}
	const cliEntry = process.argv[1];
	if (!cliEntry) throw new Error("Cannot determine CLI entry point");
	const child = spawn(
		process.execPath,
		[cliEntry, "daemon", "serve", ...(unsafeNoSandbox ? ["--unsafe-no-sandbox"] : [])],
		{ detached: true, stdio: "ignore", env: process.env },
	);
	child.unref();
	return waitForDaemon(agentDir);
}

export async function handleDaemonCommand(
	args: string[],
	agentDir: string,
	enabled = true,
	settings?: DaemonRuntimeSettings,
): Promise<boolean> {
	if (args[0] === "attach" || args[0] === "detach") {
		if (!enabled) {
			console.error(chalk.red("Error: Long Tasks are disabled by longTasks.enabled"));
			process.exitCode = 1;
			return true;
		}
		try {
			const taskId = args[1];
			if (!taskId) throw new Error(`${args[0]} requires a Task ID`);
			const agentIndex = args.indexOf("--agent");
			const agentId = agentIndex >= 0 ? args[agentIndex + 1] : undefined;
			const response = await requestDaemon(agentDir, {
				command: args[0],
				taskId,
				...(agentId ? { agentId } : {}),
			});
			console.log(JSON.stringify(response));
		} catch (error) {
			console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
			process.exitCode = 1;
		}
		return true;
	}
	if (args[0] !== "daemon") return false;
	if (!enabled) {
		console.error(chalk.red("Error: Long Tasks are disabled by longTasks.enabled"));
		process.exitCode = 1;
		return true;
	}
	const command = args[1];
	try {
		if (!command || command === "help" || command === "--help") {
			printHelp();
		} else if (command === "serve") {
			await serve(agentDir, args.includes("--unsafe-no-sandbox"), settings);
		} else if (command === "start") {
			console.log(JSON.stringify(await startDaemon(agentDir, args.includes("--unsafe-no-sandbox"))));
		} else if (command === "status" || command === "stop" || command === "shutdown") {
			const daemonCommand = command === "shutdown" ? "stop" : command;
			console.log(JSON.stringify(await requestDaemon(agentDir, { command: daemonCommand })));
		} else if (command === "workers") {
			const response = await requestDaemon(agentDir, { command: "status" });
			console.log(JSON.stringify(response.workers ?? []));
		} else if (command === "install") {
			const service = serviceDefinition(agentDir);
			await installDaemonService(service);
			console.log(service.path);
		} else if (command === "uninstall") {
			const service = serviceDefinition(agentDir);
			await uninstallDaemonService(service);
			console.log(service.path);
		} else if (command === "doctor") {
			const { socketPath, pidPath } = paths(agentDir);
			const pid = readPid(pidPath);
			const service = serviceDefinition(agentDir);
			const serviceLoaded = await isDaemonServiceLoaded(service);
			console.log(
				JSON.stringify(
					{
						agentDir,
						socketPath,
						socketExists: existsSync(socketPath),
						pid,
						processAlive: pid ? isProcessAlive(pid) : false,
						servicePath: service.path,
						serviceInstalled: existsSync(service.path),
						serviceLoaded,
					},
					null,
					2,
				),
			);
		} else {
			throw new Error(`Unknown daemon command: ${command}`);
		}
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		process.exitCode = 1;
	}
	return true;
}
