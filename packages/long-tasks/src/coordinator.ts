import { createHash } from "node:crypto";
import type { SqliteTaskStore } from "./store.ts";
import type {
	AgentCheckpointCommit,
	AgentCoordinator,
	AgentIdentity,
	AgentLease,
	CoordinationCommand,
	CoordinationResult,
	InboxBatch,
} from "./types.ts";
import type { WorkspaceAllocator } from "./workspace.ts";

function hash(...parts: string[]): string {
	const digest = createHash("sha256");
	for (const part of parts) {
		digest.update(part);
		digest.update("\0");
	}
	return digest.digest("hex");
}

export class DurableAgentCoordinator implements AgentCoordinator {
	private readonly store: SqliteTaskStore;
	private readonly workspaceAllocator?: WorkspaceAllocator;

	constructor(store: SqliteTaskStore, options?: { workspaceAllocator?: WorkspaceAllocator }) {
		this.store = store;
		this.workspaceAllocator = options?.workspaceAllocator;
	}

	async coordinate(actorIdentity: AgentIdentity, command: CoordinationCommand): Promise<CoordinationResult> {
		const actor = this.store.requireAgent(actorIdentity.agentId);
		if (actor.taskId !== actorIdentity.taskId || actor.kind !== actorIdentity.kind)
			throw new Error("Agent identity mismatch");
		return this.store.coordinate(actor.id, command.operationKey, () => {
			switch (command.type) {
				case "delegate": {
					const allocation =
						command.scope.workspaceMode === "isolated_worktree"
							? this.workspaceAllocator?.allocate({
									repoRoot: actor.workspaceRoot,
									taskId: actor.taskId,
									agentId: createHash("sha256").update(command.operationKey).digest("hex").slice(0, 32),
									paths: command.scope.paths,
								})
							: undefined;
					if (command.scope.workspaceMode === "isolated_worktree" && !allocation) {
						throw new Error("Isolated worktree delegation requires a WorkspaceAllocator");
					}
					const created = this.store.createDelegation({
						actor,
						operationKey: command.operationKey,
						name: command.name,
						role: command.role,
						objective: command.objective,
						acceptance: command.acceptance,
						paths: command.scope.paths,
						allowedTools: command.scope.allowedTools,
						workspaceMode: command.scope.workspaceMode,
						budget: command.budget,
						required: command.required,
						...(allocation
							? {
									workspaceRoot: allocation.worktreePath,
									workspaceSnapshot: allocation.snapshot,
									workspaceSnapshotSha256: allocation.snapshotSha256,
								}
							: {}),
					});
					return { kind: "delegated", ...created, replayed: false };
				}
				case "message": {
					const recipient = this.store.requireAgent(command.recipientAgentId);
					const messageId = this.store.queueMessage({
						actor,
						recipient,
						dedupeKey: hash(command.operationKey, recipient.id, "0"),
						type: command.messageType,
						priority: command.priority ?? "normal",
						body: command.body,
						artifactRefs: command.artifactRefs ?? [],
						...(command.replyToMessageId === undefined ? {} : { replyToMessageId: command.replyToMessageId }),
					});
					return { kind: "message", messageId, replayed: false };
				}
				case "report": {
					if (actor.kind !== "subagent" || !actor.parentAgentId)
						throw new Error("Only a subagent may report to its parent");
					let acceptedStatus = command.status;
					if (command.status === "completed") {
						if (command.evidence.length === 0) throw new Error("Completed reports require evidence");
						const delegation = this.store.getDelegationForAgent(actor.id);
						if (!delegation) throw new Error("Subagent has no Delegation");
						const results = command.acceptanceResults ?? [];
						const failed = delegation.acceptance.filter(
							(criterion) => !results.some((result) => result.criterionId === criterion.id && result.passed),
						);
						if (failed.length > 0) {
							acceptedStatus = "progress";
						}
					}
					const parent = this.store.requireAgent(actor.parentAgentId);
					const messageId = this.store.queueMessage({
						actor,
						recipient: parent,
						dedupeKey: hash(command.operationKey, parent.id, "0"),
						type: command.status === "progress" ? "progress" : "result",
						priority: command.status === "progress" ? "normal" : "high",
						body: JSON.stringify({
							status: command.status,
							accepted: acceptedStatus === command.status,
							summary: command.summary,
							evidence: command.evidence,
							blockers: command.blockers ?? [],
							acceptanceResults: command.acceptanceResults ?? [],
						}),
						artifactRefs: command.evidence.map((evidence) => evidence.ref),
					});
					const agentState = this.store.recordAgentReport(actor, acceptedStatus, messageId, {
						summary: command.summary,
						evidence: command.evidence,
						blockers: command.blockers ?? [],
						acceptanceResults: command.acceptanceResults ?? [],
					});
					return { kind: "report", messageId, agentState, replayed: false };
				}
			}
		});
	}

	async claimInbox(agentId: string, lease: AgentLease, limit: number): Promise<InboxBatch> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
			throw new RangeError("Inbox claim limit must be 1..100");
		return { messages: this.store.claimInbox(agentId, lease, limit) };
	}

	async commitCheckpoint(input: AgentCheckpointCommit): Promise<void> {
		this.store.commitCheckpoint(input);
	}
}
