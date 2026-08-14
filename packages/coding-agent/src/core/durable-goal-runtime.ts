import { join } from "node:path";
import { type ContinuationPolicy, SqliteTaskStore, type TaskRecord } from "@lioooooo123/ever-long-tasks";
import type { AgentSessionRuntime } from "./agent-session-runtime.ts";
import type {
	DurableGoalHost,
	DurableGoalSnapshot,
	DurableGoalUpdate,
	DurablePermissionGrantSummary,
	DurableTaskAuthorizationSummary,
} from "./extensions/types.ts";
import { attachLongTaskRuntime, type LongTaskRuntimeHandle } from "./long-task-runtime.ts";
import { applyNativeTaskUpdate } from "./native-task-tool.ts";
import { TaskApplication } from "./task-application.ts";
import type { TaskRunContext } from "./task-run-context.ts";

const TERMINAL_STATES = new Set<TaskRecord["state"]>(["completed", "failed", "cancelled"]);

function snapshot(
	task: TaskRecord,
	reviewer?: ReturnType<SqliteTaskStore["getReviewerCostSummary"]>,
): DurableGoalSnapshot {
	const reviewerCostUsd = (reviewer?.compilerCostUsd ?? 0) + (reviewer?.judgeCostUsd ?? 0);
	return {
		taskId: task.id,
		goal: task.goal,
		...(task.constraints.executionMode === "flow"
			? { executionMode: "flow" as const }
			: { executionMode: "session" as const }),
		state: task.state,
		...(task.stateReason ? { stateReason: task.stateReason } : {}),
		totalTurns: task.totalTurns,
		totalCostUsd: task.totalCostUsd,
		mainAgentCostUsd: Math.max(0, task.totalCostUsd - reviewerCostUsd),
		compilerCostUsd: reviewer?.compilerCostUsd ?? 0,
		judgeCostUsd: reviewer?.judgeCostUsd ?? 0,
		reviewerReservedUsd: reviewer?.reviewerReservedUsd ?? 0,
		compilerRequestCount: reviewer?.compilerRequestCount ?? 0,
		reviewerRequestCount: reviewer?.reviewerRequestCount ?? 0,
		maxTurns: task.budget.maxTurns,
		maxWallTimeMinutes: task.budget.maxWallTimeMinutes,
	};
}

/** Adapts `/goal` to the single durable Task execution chain. */
export class DurableGoalRuntime implements DurableGoalHost {
	private readonly runtime: AgentSessionRuntime;
	private readonly agentDir: string;
	private readonly continuationPolicy: ContinuationPolicy;
	private readonly application: TaskApplication;
	private activeTaskId?: string;
	private handle?: LongTaskRuntimeHandle;
	private closePromise?: Promise<void>;
	private adopting = false;

	constructor(runtime: AgentSessionRuntime, agentDir: string, continuationPolicy: ContinuationPolicy) {
		this.runtime = runtime;
		this.agentDir = agentDir;
		this.continuationPolicy = continuationPolicy;
		this.application = new TaskApplication(agentDir);
		this.runtime.setDurableGoalHost(this);
		this.runtime.setSessionReplacementGuard(() => {
			const goal = this.status();
			if (!this.adopting && goal && !TERMINAL_STATES.has(goal.state))
				throw new Error(`Pause or cancel Task ${goal.taskId.slice(0, 8)} before replacing its Session`);
		});
	}

	async adopt(context: TaskRunContext): Promise<void> {
		if (this.activeTaskId) throw new Error("A durable Goal is already attached");
		this.activeTaskId = context.taskId;
		this.adopting = true;
		try {
			this.handle = await attachLongTaskRuntime(
				this.runtime,
				this.agentDir,
				context.taskId,
				context.agentId,
				context.acceptRuntimeDrift,
				this.continuationPolicy,
			);
		} catch (error) {
			this.activeTaskId = undefined;
			throw error;
		} finally {
			this.adopting = false;
		}
	}

	status(): DurableGoalSnapshot | undefined {
		if (!this.activeTaskId) return undefined;
		return this.snapshot(this.application.resolve(this.activeTaskId));
	}

	async start(goal: string, options?: { mode?: "session" | "flow" }): Promise<DurableGoalSnapshot> {
		if (!this.runtime.session.isIdle) throw new Error("Wait for the current Turn to settle before starting a Goal");
		const current = this.status();
		if (current && !TERMINAL_STATES.has(current.state))
			throw new Error(`Task ${current.taskId.slice(0, 8)} is already ${current.state}`);
		await this.closeHandle();
		this.activeTaskId = undefined;
		const model = this.runtime.session.model;
		if (!model) throw new Error("Select a model before starting a Goal");
		const task = this.application.submit({
			kind: "interactive",
			mode: options?.mode ?? "session",
			workspaceRoot: this.runtime.cwd,
			goal,
			model: { provider: model.provider, id: model.id },
		});
		const agent = this.application.snapshot(task.id).agents.find((candidate) => candidate.kind === "main");
		if (!agent) throw new Error(`Task ${task.id} has no main Agent`);
		await this.adopt({ taskId: task.id, agentId: agent.id, acceptRuntimeDrift: false });
		return this.snapshot(this.application.resolve(task.id));
	}

	async pause(): Promise<DurableGoalSnapshot> {
		const taskId = this.requireTaskId();
		const task = this.application.control(
			{ action: "pause", taskRef: taskId },
			{ clientId: `goal:${process.pid}` },
		).task;
		await this.runtime.session.abort();
		await this.closeHandle();
		return this.snapshot(task);
	}

	async resume(): Promise<DurableGoalSnapshot> {
		const taskId = this.requireTaskId();
		await this.closeHandle();
		const task = this.application.control(
			{ action: "resume", taskRef: taskId },
			{ clientId: `goal:${process.pid}` },
		).task;
		const agent = this.application.snapshot(taskId).agents.find((candidate) => candidate.kind === "main");
		if (!agent) throw new Error(`Task ${taskId} has no main Agent`);
		this.handle = await attachLongTaskRuntime(
			this.runtime,
			this.agentDir,
			taskId,
			agent.id,
			false,
			this.continuationPolicy,
		);
		return this.snapshot(task);
	}

	async cancel(): Promise<DurableGoalSnapshot> {
		const taskId = this.requireTaskId();
		const task = this.application.control(
			{ action: "cancel", taskRef: taskId },
			{ clientId: `goal:${process.pid}` },
		).task;
		await this.runtime.session.abort();
		await this.closeHandle();
		return this.snapshot(task);
	}

	async update(toolCallId: string, update: DurableGoalUpdate): Promise<unknown> {
		const result = applyNativeTaskUpdate(this.agentDir, this.requireTaskId(), toolCallId, update);
		if (update.action === "wait" || update.action === "complete" || update.action === "fail") {
			void this.runtime.session.waitForIdle().then(() => this.closeHandle());
		}
		return result;
	}

	listPermissionGrants(): DurablePermissionGrantSummary[] {
		const store = SqliteTaskStore.open({ databasePath: join(this.agentDir, "long-tasks.sqlite") });
		try {
			if (typeof store.listPermissionGrants !== "function") return [];
			const task = store.requireTask(this.requireTaskId());
			return store
				.listPermissionGrants()
				.filter(
					(grant) =>
						grant.taskId === task.id ||
						(["workspace", "project_policy"].includes(grant.lifetime) &&
							grant.workspaceFingerprint === task.workspaceFingerprint),
				)
				.map((grant) => ({
					id: grant.id,
					lifetime: grant.lifetime,
					state: grant.state,
					tools: grant.scope.toolNames,
					effects: grant.scope.effects,
					paths: grant.scope.pathPrefixes,
					createdAt: grant.createdAt,
				}));
		} finally {
			store.close();
		}
	}

	revokePermissionGrant(grantId: string): DurablePermissionGrantSummary {
		const store = SqliteTaskStore.open({ databasePath: join(this.agentDir, "long-tasks.sqlite") });
		try {
			if (typeof store.revokePermissionGrant !== "function" || typeof store.listPermissionGrants !== "function")
				throw new Error("Durable permission store is unavailable");
			const task = store.requireTask(this.requireTaskId());
			const candidate = store
				.listPermissionGrants()
				.find(
					(grant) =>
						grant.id === grantId &&
						(grant.taskId === task.id ||
							(["workspace", "project_policy"].includes(grant.lifetime) &&
								grant.workspaceFingerprint === task.workspaceFingerprint)),
				);
			if (!candidate) throw new Error("Permission grant is outside the current Task workspace or does not exist");
			const grant = store.revokePermissionGrant(grantId);
			return {
				id: grant.id,
				lifetime: grant.lifetime,
				state: grant.state,
				tools: grant.scope.toolNames,
				effects: grant.scope.effects,
				paths: grant.scope.pathPrefixes,
				createdAt: grant.createdAt,
			};
		} finally {
			store.close();
		}
	}

	listTaskAuthorizations(): DurableTaskAuthorizationSummary[] {
		const store = SqliteTaskStore.open({ databasePath: join(this.agentDir, "long-tasks.sqlite") });
		try {
			return store.listTaskAuthorizations(this.requireTaskId()).map((authorization) => ({
				id: authorization.id,
				action: authorization.action,
				state: authorization.state,
				targets: authorization.targets,
				limits: authorization.limits,
				usedCount: authorization.usedCount,
				maxUses: authorization.maxUses,
				createdAt: authorization.createdAt,
			}));
		} finally {
			store.close();
		}
	}

	revokeTaskAuthorization(authorizationId: string): DurableTaskAuthorizationSummary {
		const store = SqliteTaskStore.open({ databasePath: join(this.agentDir, "long-tasks.sqlite") });
		try {
			const candidate = store
				.listTaskAuthorizations(this.requireTaskId())
				.find((authorization) => authorization.id === authorizationId);
			if (!candidate) throw new Error("Task Authorization is outside the current Task or does not exist");
			const authorization = store.revokeTaskAuthorization(authorizationId);
			return {
				id: authorization.id,
				action: authorization.action,
				state: authorization.state,
				targets: authorization.targets,
				limits: authorization.limits,
				usedCount: authorization.usedCount,
				maxUses: authorization.maxUses,
				createdAt: authorization.createdAt,
			};
		} finally {
			store.close();
		}
	}

	async close(): Promise<void> {
		this.runtime.setDurableGoalHost(undefined);
		this.runtime.setSessionReplacementGuard(undefined);
		await this.closeHandle();
	}

	private requireTaskId(): string {
		if (!this.activeTaskId) throw new Error("No durable Goal Task is attached");
		return this.activeTaskId;
	}

	private snapshot(task: TaskRecord): DurableGoalSnapshot {
		const store = SqliteTaskStore.open({ databasePath: join(this.agentDir, "long-tasks.sqlite") });
		try {
			return snapshot(task, store.getReviewerCostSummary(task.id));
		} finally {
			store.close();
		}
	}

	private async closeHandle(): Promise<void> {
		if (!this.handle) return;
		this.closePromise ??= this.handle.drainAndClose().then(() => undefined);
		try {
			await this.closePromise;
		} finally {
			this.handle = undefined;
			this.closePromise = undefined;
		}
	}
}
