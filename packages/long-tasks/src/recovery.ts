import type { SqliteTaskStore } from "./store.ts";
import type { StaleExecution, UnfinishedToolExecution } from "./types.ts";

export interface RecoveryAdapter {
	stopExecution(execution: StaleExecution): Promise<boolean>;
	reconcileWrite?(tool: UnfinishedToolExecution): Promise<"finished" | "retry" | "unknown">;
}

export interface RecoveryResult {
	agentId: string;
	recovered: boolean;
	reason?: string;
}

export class RecoveryEngine {
	private readonly store: SqliteTaskStore;
	private readonly adapter: RecoveryAdapter;

	constructor(store: SqliteTaskStore, adapter: RecoveryAdapter) {
		this.store = store;
		this.adapter = adapter;
	}

	async recoverExpired(): Promise<RecoveryResult[]> {
		const results: RecoveryResult[] = [];
		for (const execution of this.store.listExpiredExecutions()) {
			results.push(await this.recover(execution.agentId));
		}
		return results;
	}

	async recover(agentId: string): Promise<RecoveryResult> {
		const execution = this.store.listExpiredExecutions().find((candidate) => candidate.agentId === agentId);
		if (!execution) throw new Error(`No expired execution to recover for Agent ${agentId}`);
		if (!(await this.adapter.stopExecution(execution))) {
			return { agentId, recovered: false, reason: "old_execution_not_stopped" };
		}
		const recovery = this.store.beginRecovery(agentId);

		const providerRequest = recovery.unfinishedProviderRequests[0];
		if (providerRequest) {
			const reason = `provider_outcome_unknown:${providerRequest.providerRequestId}`;
			this.store.finishRecovery(agentId, false, reason);
			return { agentId, recovered: false, reason };
		}

		for (const tool of recovery.unfinishedTools) {
			if (tool.effect === "read_only") continue;
			if (tool.effect === "reconcilable_write" && this.adapter.reconcileWrite) {
				const result = await this.adapter.reconcileWrite(tool);
				if (result === "finished" || result === "retry") continue;
			}
			const reason = `unknown_tool_outcome:${tool.toolCallId}`;
			this.store.finishRecovery(agentId, false, reason);
			return { agentId, recovered: false, reason };
		}

		this.store.finishRecovery(agentId, true);
		return { agentId, recovered: true };
	}
}
