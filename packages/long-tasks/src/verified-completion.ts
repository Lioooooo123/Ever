import { AcceptanceRunner } from "./acceptance.ts";
import { EvidenceResolver } from "./evidence-resolver.ts";
import type { SqliteTaskStore } from "./store.ts";
import type { CompletionRequirement, EvidenceRef, TaskState } from "./types.ts";

export interface CompletionRequirementResult extends CompletionRequirement {
	verified: boolean;
	reason?: string;
}

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
	requirementAudit: CompletionRequirementResult[];
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
		requirements?: readonly CompletionRequirement[];
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
				requirementAudit: [],
				replayed: true,
			};
		}

		const automated = new AcceptanceRunner(this.store).runAutomated(input.taskId, input.requestId);
		const resolved = new EvidenceResolver(this.store).resolve(input.taskId, input.evidence);
		const verifiedEvidence = resolved.filter((item) => item.verified).map((item) => item.evidence);
		const task = this.store.requireTask(input.taskId);
		const verifiedById = new Map(resolved.map((item) => [item.evidence.id, item.verified]));
		const requirementNames = new Set<string>();
		const requirementAudit = (input.requirements ?? []).map((item): CompletionRequirementResult => {
			const requirement = item.requirement.trim();
			const evidenceIds = item.evidenceIds.map((id) => id.trim()).filter(Boolean);
			let reason: string | undefined;
			if (!requirement) reason = "Requirement must not be empty";
			else if (requirementNames.has(requirement)) reason = "Requirement is duplicated";
			else if (evidenceIds.length === 0) reason = "Requirement has no evidence";
			else if (new Set(evidenceIds).size !== evidenceIds.length) reason = "Requirement repeats an evidence ID";
			else if (evidenceIds.some((id) => verifiedById.get(id) !== true))
				reason = "Requirement references missing or unverified evidence";
			requirementNames.add(requirement);
			return { requirement, evidenceIds, verified: reason === undefined, ...(reason ? { reason } : {}) };
		});
		const objectiveAuditPassed = requirementAudit.length > 0 && requirementAudit.every((item) => item.verified);
		for (const criterion of task.acceptance) {
			if (criterion.kind !== "objective_audit") continue;
			this.store.recordAcceptance(input.taskId, criterion.id, objectiveAuditPassed, {
				requestId: input.requestId,
				requirements: requirementAudit,
			});
		}
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
			requirementAudit,
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
			!Array.isArray(result.verifiedEvidence) ||
			!Array.isArray(result.requirementAudit)
		)
			throw new Error("Stored verified completion result is corrupt");
		return { ...(result as Omit<VerifiedCompletionResult, "replayed">), replayed: true };
	}
}
