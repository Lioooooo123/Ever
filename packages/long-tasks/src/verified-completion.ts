import { AcceptanceRunner } from "./acceptance.ts";
import { EvidenceResolver } from "./evidence-resolver.ts";
import type { SqliteTaskStore } from "./store.ts";
import type { EvidenceRef, TaskState } from "./types.ts";

export interface VerifiedCompletionResult {
	accepted: boolean;
	state: TaskState;
	acceptance: {
		passed: string[];
		failed: string[];
		pendingManual: string[];
		outcomeUnknown: string[];
	};
	verifiedEvidence: EvidenceRef[];
	replayed: boolean;
}

export class VerifiedCompletion {
	private readonly store: SqliteTaskStore;

	constructor(store: SqliteTaskStore) {
		this.store = store;
	}

	request(input: {
		taskId: string;
		requestId: string;
		summary: string;
		evidence: readonly EvidenceRef[];
	}): VerifiedCompletionResult {
		const request = this.store.beginVerifiedCompletion(input);
		if (request.status === "completed") {
			if (!request.result) throw new Error(`Verified completion result is missing: ${input.requestId}`);
			return this.readStoredResult(request.result);
		}
		if (request.status === "running") {
			return {
				accepted: false,
				state: this.store.requireTask(input.taskId).state,
				acceptance: { passed: [], failed: [], pendingManual: [], outcomeUnknown: ["completion_request"] },
				verifiedEvidence: [],
				replayed: true,
			};
		}

		const automated = new AcceptanceRunner(this.store).runAutomated(input.taskId, input.requestId);
		const resolved = new EvidenceResolver(this.store).resolve(input.taskId, input.evidence);
		const verifiedEvidence = resolved.filter((item) => item.verified).map((item) => item.evidence);
		const task = this.store.requireTask(input.taskId);
		for (const criterion of task.acceptance) {
			if (criterion.kind !== "agent_evidence") continue;
			this.store.recordAcceptance(input.taskId, criterion.id, verifiedEvidence.length >= criterion.minEvidence, {
				requestId: input.requestId,
				summary: input.summary,
				resolved,
			});
		}

		const outcomeUnknown = automated.outcomeUnknown;
		const passed: string[] = [];
		const failed: string[] = [];
		const pendingManual: string[] = [];
		for (const criterion of task.acceptance) {
			if (outcomeUnknown.includes(criterion.id)) continue;
			if (this.store.hasPassedAcceptance(input.taskId, criterion.id)) passed.push(criterion.id);
			else if (criterion.kind === "manual") pendingManual.push(criterion.id);
			else failed.push(criterion.id);
		}
		const result: VerifiedCompletionResult = {
			accepted: failed.length === 0 && pendingManual.length === 0 && outcomeUnknown.length === 0,
			state: task.state,
			acceptance: { passed, failed, pendingManual, outcomeUnknown },
			verifiedEvidence,
			replayed: false,
		};
		this.store.finishVerifiedCompletion(input.taskId, input.requestId, { ...result });
		return result;
	}

	private readStoredResult(result: Record<string, unknown>): VerifiedCompletionResult {
		const acceptance = result.acceptance;
		if (
			typeof result.accepted !== "boolean" ||
			typeof result.state !== "string" ||
			typeof result.replayed !== "boolean" ||
			!acceptance ||
			typeof acceptance !== "object" ||
			!Array.isArray(result.verifiedEvidence)
		)
			throw new Error("Stored verified completion result is corrupt");
		return { ...(result as Omit<VerifiedCompletionResult, "replayed">), replayed: true };
	}
}
