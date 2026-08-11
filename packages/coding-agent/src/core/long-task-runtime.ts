import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentLease,
	compareRuntimeSnapshots,
	type InboxMessage,
	type Progress,
	RecoveryEngine,
	type RecoveryResult,
	type RuntimeSnapshot,
	runtimeSnapshotHash,
	SqliteTaskStore,
} from "@karissa/long-tasks";
import { VERSION } from "../config.ts";
import type { AgentSessionEvent } from "./agent-session.ts";
import type { AgentSessionRuntime } from "./agent-session-runtime.ts";

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function createRuntimeSnapshot(runtime: AgentSessionRuntime, sandboxRequired: boolean): RuntimeSnapshot {
	const model = runtime.session.model;
	return {
		karissaVersion: VERSION,
		upstreamCommit: process.env.KARISSA_UPSTREAM_COMMIT ?? "unknown",
		protocolVersion: 1,
		model: {
			provider: model?.provider ?? "unresolved",
			id: model?.id ?? "unresolved",
			thinkingLevel: runtime.session.thinkingLevel,
		},
		systemPromptSha256: sha256(runtime.session.systemPrompt),
		contextFiles: [],
		resources: runtime.session.getActiveToolNames().map((identity) => ({
			kind: "tool" as const,
			identity,
			sha256: sha256(identity),
		})),
		toolPolicySha256: sha256(JSON.stringify([...runtime.session.getActiveToolNames()].sort())),
		sandboxPolicySha256: sha256(JSON.stringify({ sandboxRequired })),
	};
}

export interface LongTaskRuntimeHandle {
	drainAndClose(): Promise<void>;
}

const preCompactionCheckpoints = new Map<string, () => Promise<void>>();
const providerBudgetReservations = new Map<string, () => void>();
const inboxClaims = new Map<string, () => InboxMessage[]>();

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}

export async function recoverExpiredLongTaskExecutions(store: SqliteTaskStore): Promise<RecoveryResult[]> {
	const recovery = new RecoveryEngine(store, {
		async stopExecution(execution) {
			if (execution.sandboxId) return false;
			if (execution.pid === undefined) return false;
			if (!processExists(execution.pid)) return true;
			if (execution.pid === process.pid) return false;
			try {
				process.kill(execution.pid, "SIGTERM");
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
				return false;
			}
			const deadline = Date.now() + 5_000;
			while (processExists(execution.pid) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			return !processExists(execution.pid);
		},
	});
	return recovery.recoverExpired();
}

export async function checkpointLongTaskBeforeCompaction(sessionId: string): Promise<boolean> {
	const checkpoint = preCompactionCheckpoints.get(sessionId);
	if (!checkpoint) return true;
	try {
		await checkpoint();
		return true;
	} catch {
		return false;
	}
}

export function reserveLongTaskProviderBudget(sessionId: string): void {
	providerBudgetReservations.get(sessionId)?.();
}

export function claimLongTaskInbox(sessionId: string): InboxMessage[] {
	return inboxClaims.get(sessionId)?.() ?? [];
}

export async function attachLongTaskRuntime(
	runtime: AgentSessionRuntime,
	agentDir: string,
	taskId: string,
	acceptRuntimeDrift: boolean,
): Promise<LongTaskRuntimeHandle> {
	const store = SqliteTaskStore.open({
		databasePath: join(agentDir, "long-tasks.sqlite"),
		artifactsRoot: join(agentDir, "tasks"),
	});
	const task = store.requireTask(taskId);
	if (realpathSync(runtime.cwd) !== realpathSync(task.workspaceRoot)) {
		store.close();
		throw new Error(`Task workspace mismatch: expected ${task.workspaceRoot}, got ${runtime.cwd}`);
	}
	const foundMainAgent = store.listAgents(taskId).find((agent) => agent.kind === "main");
	if (!foundMainAgent) {
		store.close();
		throw new Error(`Task ${taskId} has no main Agent`);
	}
	const requestedAgentId = process.env.KARISSA_AGENT_RUN_ID;
	const foundActor = requestedAgentId ? store.getAgent(requestedAgentId) : foundMainAgent;
	if (!foundActor || foundActor.taskId !== taskId) {
		store.close();
		throw new Error(`Agent ${requestedAgentId ?? "main"} does not belong to Task ${taskId}`);
	}
	const actor = foundActor;
	const recoveryResults = await recoverExpiredLongTaskExecutions(store);
	const blockedRecovery = recoveryResults.find((result) => !result.recovered);
	if (blockedRecovery) {
		store.close();
		throw new Error(`Recovery blocked for Agent ${blockedRecovery.agentId}: ${blockedRecovery.reason ?? "unknown"}`);
	}
	const recoveredActor = store.requireAgent(actor.id);
	if (actor.kind === "main") {
		if (task.state === "queued") {
			store.transitionTask(taskId, "running", "foreground_worker_started");
		} else if (task.state !== "running" || recoveredActor.state !== "queued") {
			store.close();
			throw new Error(`Task ${taskId} is not runnable from state ${task.state}`);
		}
	} else if (task.state !== "running") {
		store.close();
		throw new Error(`Subagent cannot run while Task is ${task.state}`);
	}

	const snapshot = createRuntimeSnapshot(runtime, actor.toolPolicy.sandboxRequired);
	const snapshotSha256 = runtimeSnapshotHash(snapshot);
	const previousAttempt = store.getLatestAttempt(actor.id);
	if (previousAttempt) {
		const drift = compareRuntimeSnapshots(previousAttempt.runtimeSnapshot, snapshot);
		if (!drift.compatible && !acceptRuntimeDrift) {
			store.appendTaskEvent(taskId, "RuntimeDriftDetected", { ...drift, schemaVersion: 1 });
			store.transitionTask(taskId, "waiting_input", "runtime_drift");
			store.close();
			throw new Error(`Runtime drift requires explicit acceptance: ${drift.changedFields.join(", ")}`);
		}
		if (!drift.compatible) {
			store.appendTaskEvent(taskId, "RuntimeDriftAccepted", { ...drift, schemaVersion: 1 });
		}
	}

	let lease: AgentLease = store.acquireLease(actor.id, `foreground:${process.pid}`, randomUUID(), 30, {
		pid: process.pid,
	});
	const attemptId = store.createAttempt(actor.id, runtime.session.sessionId, snapshot, snapshotSha256);
	const previousCheckpoint = store.getLatestCheckpoint(actor.id);
	if (previousCheckpoint?.sessionCheckpoint.sessionId === runtime.session.sessionId) {
		await runtime.restoreCheckpoint(previousCheckpoint.sessionCheckpoint);
	}

	const reservationIds: string[] = [];
	let actualTurnCostUsd = 0;
	let chain = Promise.resolve();
	let closed = false;
	let heartbeatError: Error | undefined;
	let progress: Progress = previousCheckpoint
		? { ...previousCheckpoint.progress, consumedMessageIds: [], outboundMessageIds: [] }
		: {
				summary: "Task runtime attached; awaiting the next settled Turn.",
				completedItems: [],
				nextActions: ["Continue working toward the Task acceptance criteria."],
				blockers: [],
				filesRead: [],
				filesModified: [],
				verification: [],
				consumedMessageIds: [],
				outboundMessageIds: [],
			};
	let evidence = previousCheckpoint?.evidence ?? [];
	const consumedMessageIds = new Set<string>();
	const model = runtime.session.model;
	const worstCaseCostUsd = model
		? (() => {
				const rates = [model.cost, ...(model.cost.tiers ?? [])];
				const inputRate = Math.max(...rates.map((rate) => rate.input + rate.cacheWrite));
				const outputRate = Math.max(...rates.map((rate) => rate.output));
				return (model.contextWindow * inputRate + model.maxTokens * outputRate) / 1_000_000;
			})()
		: undefined;

	async function commitSessionCheckpoint(beforeCompaction: boolean): Promise<void> {
		const update = store.getPendingCheckpointUpdate(taskId, actor.id);
		if (update) {
			progress = {
				...progress,
				summary: update.summary,
				completedItems: update.completedItems,
				...(update.currentItem ? { currentItem: update.currentItem } : {}),
				nextActions: update.nextActions,
			};
			evidence = update.evidence;
		}
		const sessionCheckpoint = beforeCompaction
			? await runtime.createPreCompactionCheckpoint()
			: await runtime.createCheckpoint();
		const checkpointProgress = { ...progress, consumedMessageIds: [...consumedMessageIds] };
		store.commitCheckpoint({
			taskId,
			agentId: actor.id,
			attemptId,
			lease,
			sessionCheckpoint: { ...sessionCheckpoint, runtimeSnapshotSha256: snapshotSha256 },
			progress: checkpointProgress,
			evidence,
			workspaceSnapshot: previousCheckpoint?.workspaceSnapshot ?? {},
		});
		progress = { ...checkpointProgress, consumedMessageIds: [] };
		consumedMessageIds.clear();
	}

	preCompactionCheckpoints.set(runtime.session.sessionId, async () => {
		try {
			await commitSessionCheckpoint(true);
		} catch (error) {
			const current = store.requireTask(taskId);
			if (current.state === "running") store.transitionTask(taskId, "paused", "checkpoint_failed");
			throw error;
		}
	});
	providerBudgetReservations.set(runtime.session.sessionId, () => {
		if (heartbeatError) throw heartbeatError;
		reservationIds.push(
			store.reserveBudget(
				actor.id,
				attemptId,
				randomUUID(),
				task.budget.maxCostUsd === undefined ? undefined : worstCaseCostUsd,
			),
		);
	});
	inboxClaims.set(runtime.session.sessionId, () => {
		const messages = store.claimInbox(actor.id, lease, 20);
		for (const message of messages) consumedMessageIds.add(message.id);
		return messages;
	});
	const heartbeat = setInterval(() => {
		try {
			const currentAgent = store.requireAgent(actor.id);
			if (["paused", "cancelled"].includes(currentAgent.state)) {
				void runtime.session.abort();
				return;
			}
			lease = store.renewLease(lease);
		} catch (error) {
			heartbeatError = error instanceof Error ? error : new Error(String(error));
			void runtime.session.abort();
		}
	}, 5_000);

	async function handleEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "agent_start") {
			store.appendAgentEvent(lease, attemptId, "TurnStarted", { schemaVersion: 1 });
		} else if (event.type === "agent_end") {
			actualTurnCostUsd = event.messages.reduce(
				(total, message) => total + (message.role === "assistant" ? message.usage.cost.total : 0),
				0,
			);
		} else if (event.type === "tool_execution_start") {
			const inputSha256 = sha256(JSON.stringify(event.args));
			const effect =
				event.toolName === "bash"
					? "process"
					: ["edit", "write"].includes(event.toolName)
						? "reconcilable_write"
						: "read_only";
			store.appendAgentEvent(lease, attemptId, "ToolPlanned", {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				inputSha256,
				effect,
				schemaVersion: 1,
			});
			store.appendAgentEvent(lease, attemptId, "ToolStarted", {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				inputSha256,
				effect,
				executionId: lease.executionId,
				fencingToken: lease.fencingToken,
				schemaVersion: 1,
			});
		} else if (event.type === "tool_execution_end") {
			store.appendAgentEvent(lease, attemptId, "ToolFinished", {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
				schemaVersion: 1,
			});
		} else if (event.type === "compaction_start") {
			store.appendAgentEvent(lease, attemptId, "CompactionStarted", { reason: event.reason, schemaVersion: 1 });
		} else if (event.type === "compaction_end") {
			store.appendAgentEvent(lease, attemptId, "CompactionFinished", {
				reason: event.reason,
				aborted: event.aborted,
				schemaVersion: 1,
			});
		} else if (event.type === "agent_settled") {
			for (const [index, reservationId] of reservationIds.splice(0).entries()) {
				store.settleBudget(reservationId, index === 0 ? actualTurnCostUsd : 0);
			}
			actualTurnCostUsd = 0;
			await commitSessionCheckpoint(false);
			lease = store.renewLease(lease);
		}
	}

	const unsubscribe = runtime.session.subscribe((event) => {
		chain = chain.then(() => handleEvent(event));
	});

	return {
		async drainAndClose(): Promise<void> {
			if (closed) return;
			closed = true;
			clearInterval(heartbeat);
			unsubscribe();
			preCompactionCheckpoints.delete(runtime.session.sessionId);
			providerBudgetReservations.delete(runtime.session.sessionId);
			inboxClaims.delete(runtime.session.sessionId);
			await chain;
			if (!heartbeatError) {
				store.releaseLease(lease);
				const currentTask = store.requireTask(taskId);
				const currentAgent = store.requireAgent(actor.id);
				if (currentTask.state === "running" && currentAgent.state === "running") {
					store.transitionAgent(actor.id, "queued", "worker_turn_settled");
				}
			}
			store.close();
			if (heartbeatError) throw heartbeatError;
		},
	};
}
