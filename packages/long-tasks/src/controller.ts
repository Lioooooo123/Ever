import type { SqliteTaskStore } from "./store.ts";
import type { CreateTaskInput, TaskRecord } from "./types.ts";

export class TaskController {
	private readonly store: SqliteTaskStore;

	constructor(store: SqliteTaskStore) {
		this.store = store;
	}

	create(input: CreateTaskInput): TaskRecord {
		return this.store.createTask(input).task;
	}

	submit(taskId: string): TaskRecord {
		return this.store.transitionTask(taskId, "queued", "submitted");
	}

	pause(taskId: string, reason = "user_requested"): TaskRecord {
		return this.store.transitionTask(taskId, "paused", reason);
	}

	resume(taskId: string, acceptRuntimeDrift = false): TaskRecord {
		const task = this.store.requireTask(taskId);
		if (task.state === "waiting_input" && task.stateReason === "runtime_drift" && !acceptRuntimeDrift) {
			throw new Error("Runtime drift must be explicitly accepted");
		}
		return this.store.transitionTask(
			taskId,
			"queued",
			acceptRuntimeDrift ? "runtime_drift_accepted" : "user_resumed",
		);
	}

	cancel(taskId: string, reason = "user_requested"): TaskRecord {
		return this.store.transitionTask(taskId, "cancelled", reason);
	}

	requestCompletion(taskId: string): TaskRecord {
		return this.store.transitionTask(taskId, "completed", "acceptance_passed");
	}

	recordAcceptance(taskId: string, criterionId: string, passed: boolean, evidence: Record<string, unknown>): void {
		this.store.recordAcceptance(taskId, criterionId, passed, evidence);
	}

	fail(taskId: string, code: string): TaskRecord {
		return this.store.transitionTask(taskId, "failed", code);
	}
}
