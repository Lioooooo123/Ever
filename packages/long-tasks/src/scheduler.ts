import type { SqliteTaskStore } from "./store.ts";
import type { AgentRecord, TaskRecord } from "./types.ts";

export interface DispatchPlan {
	task: TaskRecord;
	agents: AgentRecord[];
}

export class TaskScheduler {
	private readonly store: SqliteTaskStore;
	private readonly maxConcurrentTasks: number;
	private readonly maxConcurrentAgentsPerTask: number;
	private readonly random: () => number;

	constructor(
		store: SqliteTaskStore,
		options?: { maxConcurrentTasks?: number; maxConcurrentAgentsPerTask?: number; random?: () => number },
	) {
		this.store = store;
		this.maxConcurrentTasks = options?.maxConcurrentTasks ?? 1;
		this.maxConcurrentAgentsPerTask = options?.maxConcurrentAgentsPerTask ?? 4;
		this.random = options?.random ?? Math.random;
	}

	plan(): DispatchPlan[] {
		return this.store.listRunnableTasks(this.maxConcurrentTasks).map((task) => ({
			task,
			agents: this.store.listRunnableAgents(task.id, this.maxConcurrentAgentsPerTask),
		}));
	}

	providerBackoffMs(failureCount: number): number {
		const base = Math.min(300_000, 5_000 * 2 ** Math.max(0, failureCount - 1));
		return Math.round(base * (0.8 + this.random() * 0.4));
	}

	recordProviderExhausted(agentId: string, failureCount: number, now = new Date()): string {
		const retryAt = new Date(now.getTime() + this.providerBackoffMs(failureCount)).toISOString();
		this.store.markProviderUnavailable(agentId, retryAt, failureCount);
		return retryAt;
	}

	detectDeadlocks(taskId: string): boolean {
		return this.store.detectCoordinationDeadlock(taskId);
	}
}
