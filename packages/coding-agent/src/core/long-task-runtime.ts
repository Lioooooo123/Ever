import { createHash, createHmac, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Api, Model } from "@lioooooo123/ever-ai";
import type { ToolEffect } from "@lioooooo123/ever-long-tasks";
import {
	type AgentLease,
	type AttemptOutcome,
	type ClaimedAttempt,
	ContinuationController,
	type ContinuationPolicy,
	compareRuntimeSnapshots,
	defaultToolEffect,
	type EvidenceRef,
	type Progress,
	RecoveryEngine,
	type RecoveryResult,
	type RuntimeSnapshot,
	runtimeSnapshotHash,
	SqliteTaskStore,
	TaskContextBuilder,
	type TaskRecord,
	VerifiedChangeBundle,
} from "@lioooooo123/ever-long-tasks";
import { VERSION } from "../config.ts";
import { WorkerRegistry } from "../daemon/worker-registry.ts";
import type {
	AgentSessionLifecycle,
	AgentSessionLifecycleDecision,
	AgentSessionLifecycleEvent,
} from "./agent-session-lifecycle.ts";
import type { AgentSessionRuntime } from "./agent-session-runtime.ts";
import { AUTHORIZATION_COMPILER_PROMPT_SHA256, ModelAuthorizationCompiler } from "./authorization-compiler.ts";
import { readGitAuthorizationFacts, readPrHeadSha } from "./authorization-runtime-facts.ts";
import {
	normalizeToolIntent,
	PermissionKernel,
	permissionIntentSha256,
	permissionTaskSummary,
	toolIntentRequiresAuthorizationFacts,
} from "./permission-kernel.ts";
import {
	type ReviewerModelIdentity,
	reviewerWorstCaseCostUsd,
	selectReviewerModel,
} from "./reviewer-model-selector.ts";
import { ModelRiskReviewer, RISK_REVIEWER_PROMPT_SHA256, riskReviewPayload } from "./risk-reviewer.ts";
import { type EvalEffectGateCapability, getWorkerStartupIfLoaded } from "./worker-startup.ts";

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function reviewerPricingSha256(model: Pick<Model<Api>, "cost" | "contextWindow" | "maxTokens">): string {
	return sha256(JSON.stringify({ cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }));
}

function taskReviewerIdentity(task: TaskRecord): ReviewerModelIdentity | undefined {
	const configured = task.constraints.reviewerModel;
	if (configured === undefined) return undefined;
	if (
		typeof configured !== "object" ||
		configured === null ||
		!("provider" in configured) ||
		!("model" in configured) ||
		typeof configured.provider !== "string" ||
		typeof configured.model !== "string"
	)
		throw new Error("Task reviewerModel constraint must contain provider and model strings");
	return { provider: configured.provider, model: configured.model };
}

function selectTaskReviewerModel(runtime: AgentSessionRuntime, task: TaskRecord): Model<Api> | undefined {
	try {
		return selectReviewerModel({
			runtime: runtime.session.modelRuntime,
			task: taskReviewerIdentity(task),
			workspaceOrGlobal: runtime.session.settingsManager.getLongTaskSettings().reviewerModel,
			preferredProvider: runtime.session.model?.provider,
			excludedAutomaticModel: runtime.session.model
				? { provider: runtime.session.model.provider, model: runtime.session.model.id }
				: undefined,
		});
	} catch {
		return undefined;
	}
}

function runtimeSnapshot(
	runtime: AgentSessionRuntime,
	sandboxRequired: boolean,
	reviewerModel?: Model<Api>,
): RuntimeSnapshot {
	const model = runtime.session.model;
	const executionEnvironment = getWorkerStartupIfLoaded()?.executionEnvironment;
	return {
		everVersion: VERSION,
		upstreamCommit: process.env.EVER_UPSTREAM_COMMIT ?? "unknown",
		protocolVersion: 1,
		model: {
			provider: model?.provider ?? "unresolved",
			id: model?.id ?? "unresolved",
			thinkingLevel: runtime.session.thinkingLevel,
		},
		...(reviewerModel
			? {
					reviewer: {
						provider: reviewerModel.provider,
						id: reviewerModel.id,
						authorizationCompilerPromptSha256: AUTHORIZATION_COMPILER_PROMPT_SHA256,
						riskReviewerPromptSha256: RISK_REVIEWER_PROMPT_SHA256,
						minimumConfidence: 0.9,
						pricingSha256: reviewerPricingSha256(reviewerModel),
						maxInputTokens: 2_000,
						maxOutputTokens: 256,
					},
				}
			: {}),
		systemPromptSha256: sha256(runtime.session.systemPrompt),
		contextFiles: [],
		resources: runtime.session.getActiveToolNames().map((identity) => ({
			kind: "tool" as const,
			identity,
			sha256: sha256(identity),
		})),
		toolPolicySha256: sha256(JSON.stringify([...runtime.session.getActiveToolNames()].sort())),
		sandboxPolicySha256:
			executionEnvironment?.profileSha256 ??
			sha256(JSON.stringify({ sandboxRequired, trust: executionEnvironment?.trust ?? "foreground_host" })),
	};
}

function xml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function usageRecord(value: object): Record<string, unknown> {
	return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export async function waitForEvalEffectRelease(
	event: Extract<AgentSessionLifecycleEvent, { type: "after_tool" }>,
	effect: ToolEffect,
	cwd: string,
	signal: AbortSignal,
	gate: EvalEffectGateCapability | undefined,
): Promise<void> {
	if (gate === undefined || gate.effect !== effect) return;
	if (gate.expectedToolError === undefined ? event.isError : gate.expectedToolError !== event.isError) return;
	if (!isAbsolute(gate.directory) || !/^[a-f0-9]{64}$/.test(gate.secret))
		throw new Error("Invalid Eval effect gate capability");
	if (gate.toolName !== undefined && gate.toolName !== event.toolName) return;
	const inputPath = typeof event.input.path === "string" ? resolve(cwd, event.input.path) : undefined;
	if (gate.targetPath !== undefined && gate.targetPath !== inputPath) return;
	const command = typeof event.input.command === "string" ? event.input.command : undefined;
	if (gate.commandIncludes !== undefined && !command?.includes(gate.commandIncludes)) return;
	if (gate.toolName === undefined && gate.targetPath === undefined && gate.commandIncludes === undefined)
		throw new Error("Eval effect gate requires a domain selector");
	let domainEvidence: string;
	try {
		domainEvidence = readFileSync(gate.evidencePath, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	if (gate.evidenceIncludes !== undefined && !domainEvidence.includes(gate.evidenceIncludes)) return;
	mkdirSync(gate.directory, { recursive: true, mode: 0o700 });
	const createdAt = new Date().toISOString();
	const recordWithoutMac = {
		schemaVersion: 1,
		type: "EffectCommitted",
		createdAt,
		operationId: event.operationId,
		idempotencyKey: event.operationId,
		toolCallId: event.toolCallId,
		effect,
		toolName: event.toolName,
		toolErrored: event.isError,
		domainCommitId: gate.domainCommitId,
		evidencePath: gate.evidencePath,
		evidenceDigest: sha256(domainEvidence),
		...(gate.evidenceIncludes === undefined ? {} : { evidenceIncludes: gate.evidenceIncludes }),
		...(inputPath === undefined ? {} : { targetPath: inputPath }),
		...(gate.commandIncludes === undefined ? {} : { commandMarker: gate.commandIncludes }),
		payloadDigest: sha256(event.resultSummary),
	};
	const authenticationPayload = [
		recordWithoutMac.operationId,
		recordWithoutMac.idempotencyKey,
		recordWithoutMac.toolCallId,
		recordWithoutMac.effect,
		recordWithoutMac.toolName,
		String(recordWithoutMac.toolErrored),
		recordWithoutMac.domainCommitId,
		recordWithoutMac.evidencePath,
		recordWithoutMac.evidenceDigest,
		recordWithoutMac.evidenceIncludes ?? "",
		recordWithoutMac.targetPath ?? "",
		recordWithoutMac.commandMarker ?? "",
		recordWithoutMac.payloadDigest,
		recordWithoutMac.createdAt,
	].join("\0");
	const record = {
		...recordWithoutMac,
		mac: createHmac("sha256", gate.secret).update(authenticationPayload).digest("hex"),
	};
	const descriptor = openSync(join(gate.directory, "events.jsonl"), "a", 0o600);
	try {
		writeSync(descriptor, `${JSON.stringify(record)}\n`);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	const releaseToken = createHmac("sha256", gate.secret).update(event.operationId).digest("hex");
	const releasePath = join(gate.directory, `release-${releaseToken}`);
	while (!existsSync(releasePath)) {
		signal.throwIfAborted();
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function outcome(taskId: string, attemptId: string, state: string, reason?: string): AttemptOutcome {
	if (state === "completed") return { kind: "completed", taskId, attemptId };
	if (state === "failed") return { kind: "failed", taskId, attemptId, reason: reason ?? "Task failed" };
	if (state === "unknown_outcome")
		return { kind: "unknown_outcome", taskId, attemptId, reason: reason ?? "Execution outcome is unknown" };
	if (state === "waiting_input" || state === "waiting_external")
		return { kind: "waiting", taskId, attemptId, reason: reason ?? state };
	if (state === "paused") return { kind: "paused", taskId, attemptId, reason: reason ?? "Task paused" };
	return { kind: "settled", taskId, attemptId };
}

export interface LongTaskRuntimeHandle {
	drainAndClose(): Promise<AttemptOutcome>;
}

interface NativeLongTaskAgentOptions {
	runtime: AgentSessionRuntime;
	store: SqliteTaskStore;
	continuationPolicy: ContinuationPolicy;
	leaseSeconds: number;
	heartbeatSeconds: number;
	stopSignal: AbortSignal;
	onReady?: () => void;
	resident: boolean;
	artifactsRoot: string;
}

/** The only module that joins Ever Session execution to durable Task facts. */
class NativeLongTaskAgent implements AgentSessionLifecycle {
	private readonly runtime: AgentSessionRuntime;
	private readonly store: SqliteTaskStore;
	private readonly continuationPolicy: ContinuationPolicy;
	private readonly leaseSeconds: number;
	private readonly heartbeatSeconds: number;
	private readonly stopSignal: AbortSignal;
	private readonly onReady?: () => void;
	private readonly resident: boolean;
	private readonly artifactsRoot: string;
	private readonly permissionKernel: PermissionKernel;
	private readonly authorizationCompiler: ModelAuthorizationCompiler;
	private reviewerModel?: Model<Api>;
	private claim?: ClaimedAttempt;
	private lease?: AgentLease;
	private deadlineAt?: string;
	private heartbeat?: ReturnType<typeof setInterval>;
	private heartbeatError?: Error;
	private readonly reservations = new Map<string, string>();
	private consumedMessageIds = new Set<string>();
	private progress: Progress = {
		summary: "Attempt claimed; awaiting the next settled Turn.",
		completedItems: [],
		nextActions: ["Continue working toward verified Task acceptance."],
		blockers: [],
		filesRead: [],
		filesModified: [],
		verification: [],
		consumedMessageIds: [],
		outboundMessageIds: [],
	};
	private evidence: EvidenceRef[] = [];

	constructor(options: NativeLongTaskAgentOptions) {
		this.runtime = options.runtime;
		this.store = options.store;
		this.continuationPolicy = options.continuationPolicy;
		this.leaseSeconds = options.leaseSeconds;
		this.heartbeatSeconds = options.heartbeatSeconds;
		this.stopSignal = options.stopSignal;
		this.onReady = options.onReady;
		this.resident = options.resident;
		this.artifactsRoot = options.artifactsRoot;
		this.authorizationCompiler = new ModelAuthorizationCompiler((compileContext, signal) =>
			this.runtime.session.completeLifecycleRequest("authorization_compile", compileContext, signal, {
				model: this.requireReviewerModel(),
				maxTokens: 256,
			}),
		);
		this.permissionKernel = new PermissionKernel({
			reviewer: new ModelRiskReviewer((reviewContext, signal) =>
				this.runtime.session.completeLifecycleRequest("permission_review", reviewContext, signal, {
					model: this.requireReviewerModel(),
					maxTokens: 192,
				}),
			),
			grants: {
				list: (context) =>
					typeof this.store.listActivePermissionGrants === "function"
						? this.store.listActivePermissionGrants({
								taskId: context.agent.taskId,
								attemptId: context.attemptId,
								workspaceFingerprint: context.workspaceFingerprint,
								sandboxProfileSha256: context.sandboxProfileSha256,
							})
						: [],
				wasDenied: (intentSha256, context) =>
					typeof this.store.hasAttemptPermissionDenial === "function" &&
					this.store.hasAttemptPermissionDenial(context.attemptId, intentSha256),
			},
			authorizations: {
				list: (context) => this.store.listActiveTaskAuthorizations(context.agent.taskId),
				revision: (context) => this.store.getTaskAuthorizationRevision(context.agent.taskId),
			},
			onReviewCacheHit: (intent) =>
				this.store.appendTaskEvent(intent.taskId, "RiskReviewCacheHit", {
					operationId: intent.operationId,
					authorizationRevision: this.store.getTaskAuthorizationRevision(intent.taskId),
					schemaVersion: 1,
				}),
			onReviewFailure: (intent, error) =>
				this.store.appendTaskEvent(
					intent.taskId,
					error instanceof Error && error.name === "TimeoutError" ? "RiskReviewTimedOut" : "RiskReviewInvalid",
					{
						operationId: intent.operationId,
						authorizationRevision: this.store.getTaskAuthorizationRevision(intent.taskId),
						errorCode:
							error instanceof Error && error.name === "TimeoutError"
								? "reviewer_timeout"
								: "reviewer_invalid_or_unavailable",
						schemaVersion: 1,
					},
				),
			onReviewConsumed: (operationId) =>
				this.store.appendTaskEvent(
					this.store.resolveAttemptClaim(this.requireClaim()).task.id,
					"RiskReviewConsumed",
					{
						operationId,
						schemaVersion: 1,
					},
				),
		});
	}

	async run(claim: ClaimedAttempt): Promise<AttemptOutcome> {
		if (this.claim) throw new Error("NativeLongTaskAgent can run only one Attempt");
		this.claim = claim;
		const context = this.store.resolveAttemptClaim(claim);
		this.lease = context.lease;
		this.deadlineAt = context.deadlineAt;
		const checkpoint = this.store.getLatestCheckpoint(context.agent.id);
		if (checkpoint) {
			this.progress = { ...checkpoint.progress, consumedMessageIds: [], outboundMessageIds: [] };
			this.evidence = checkpoint.evidence;
			if (checkpoint.sessionCheckpoint.sessionId === this.runtime.session.sessionId)
				await this.runtime.restoreCheckpoint(checkpoint.sessionCheckpoint);
		}
		const uninstallLifecycle = this.runtime.installLifecycle(this);
		this.heartbeat = setInterval(() => this.renewLease(), this.heartbeatSeconds * 1000);
		try {
			await this.compilePendingAuthorizations(context.task.id);
			this.onReady?.();
			await new Promise<void>((resolve) => {
				if (this.stopSignal.aborted) resolve();
				else this.stopSignal.addEventListener("abort", () => resolve(), { once: true });
			});
		} finally {
			if (this.heartbeat) clearInterval(this.heartbeat);
			uninstallLifecycle();
		}
		let task = this.store.requireTask(context.task.id);
		if (!this.heartbeatError) {
			try {
				this.store.releaseLease(this.requireLease());
				const agent = this.store.requireAgent(context.agent.id);
				if (task.state === "running" && agent.state === "running")
					this.store.transitionAgent(agent.id, "queued", "attempt_settled");
				task = this.store.requireTask(context.task.id);
			} catch (error) {
				this.heartbeatError = error instanceof Error ? error : new Error(String(error));
			}
		}
		if (this.heartbeatError) throw this.heartbeatError;
		if (task.state === "completed") {
			const bundle = new VerifiedChangeBundle({ store: this.store, artifactsRoot: this.artifactsRoot }).rebuild(
				task.id,
			);
			this.store.appendTaskEvent(task.id, "VerifiedChangeBundleCreated", {
				manifestPath: bundle.manifestPath,
				manifestSha256: bundle.manifestSha256,
				verified: bundle.manifest.verified,
				schemaVersion: 1,
			});
		}
		return outcome(task.id, context.attempt.id, task.state, task.stateReason);
	}

	async handle(event: AgentSessionLifecycleEvent): Promise<AgentSessionLifecycleDecision | undefined> {
		if (
			event.type === "before_turn" ||
			event.type === "before_request" ||
			event.type === "before_tool" ||
			event.type === "before_compaction"
		)
			this.assertRunnable(event.type);
		const context = this.store.resolveAttemptClaim(this.requireClaim());
		if (event.type === "before_turn") {
			await this.compilePendingAuthorizations(context.task.id);
			const checkpoint = this.store.getLatestCheckpoint(context.agent.id);
			const taskContext = new TaskContextBuilder().build({
				task: context.task,
				agent: context.agent,
				progress: checkpoint?.progress ?? this.progress,
				evidence: checkpoint?.evidence ?? this.evidence,
			});
			const inbox = this.store.claimInbox(context.agent.id, this.requireLease(), 20);
			for (const message of inbox) this.consumedMessageIds.add(message.id);
			const inboxContext = inbox.length
				? `\n<agent_inbox>\n${inbox
						.map(
							(message) =>
								`<message id="${xml(message.id)}" from="${xml(message.senderAgentId)}" type="${xml(message.type)}">${xml(message.body)}</message>`,
						)
						.join("\n")}\n</agent_inbox>`
				: "";
			return { systemPrompt: `${event.baseSystemPrompt}\n\n${taskContext}${inboxContext}` };
		}
		if (event.type === "before_request") {
			const reviewerRequest = event.kind === "authorization_compile" || event.kind === "permission_review";
			const rates = [event.model.cost, ...(event.model.cost.tiers ?? [])];
			const worstCaseCostUsd = reviewerRequest
				? reviewerWorstCaseCostUsd(event.model, event.kind === "authorization_compile" ? 256 : 192)
				: (event.model.contextWindow * Math.max(...rates.map((rate) => rate.input + rate.cacheWrite)) +
						event.model.maxTokens * Math.max(...rates.map((rate) => rate.output))) /
					1_000_000;
			const reservationId = this.store.startProviderRequest(this.requireLease(), context.attempt.id, {
				providerRequestId: event.requestId,
				provider: event.model.provider,
				modelId: event.model.id,
				requestKind: event.kind,
				...(reviewerRequest || context.task.budget.maxCostUsd !== undefined ? { worstCaseCostUsd } : {}),
			});
			this.reservations.set(event.requestId, reservationId);
			return undefined;
		}
		if (event.type === "after_response") {
			const reservationId = this.reservations.get(event.requestId);
			if (!reservationId) throw new Error(`Provider request was not reserved: ${event.requestId}`);
			if (
				(event.kind === "authorization_compile" || event.kind === "permission_review") &&
				event.message.stopReason === "error"
			) {
				const reason = `Provider request outcome is unknown: ${event.message.errorMessage ?? "request failed"}`;
				this.store.markProviderOutcomeUnknown(this.requireLease(), context.attempt.id, event.requestId, reason);
				this.reservations.delete(event.requestId);
				throw new Error(reason);
			}
			try {
				this.store.finishProviderRequest(this.requireLease(), context.attempt.id, {
					providerRequestId: event.requestId,
					reservationId,
					actualCostUsd: event.usage.cost.total,
					usage: usageRecord(event.usage),
					stopReason: event.message.stopReason,
				});
			} catch (error) {
				const reason = `Provider outcome could not be persisted: ${error instanceof Error ? error.message : String(error)}`;
				try {
					this.store.markProviderOutcomeUnknown(this.requireLease(), context.attempt.id, event.requestId, reason);
				} catch {
					// The active reservation remains as the durable recovery barrier.
				}
				throw new Error(reason, { cause: error });
			}
			this.reservations.delete(event.requestId);
			return undefined;
		}
		if (event.type === "before_tool") {
			await this.compilePendingAuthorizations(context.task.id);
			const intent = normalizeToolIntent({
				operationId: event.operationId,
				taskId: context.task.id,
				attemptId: context.attempt.id,
				sessionId: event.sessionId,
				toolName: event.toolName,
				input: event.input,
				workspaceRoot: this.runtime.cwd,
				...(event.durability ? { metadata: event.durability } : {}),
			});
			const executionEnvironment = getWorkerStartupIfLoaded()?.executionEnvironment;
			const needsAuthorizationFacts = toolIntentRequiresAuthorizationFacts(intent);
			const gitFacts = needsAuthorizationFacts ? readGitAuthorizationFacts(this.runtime.cwd) : {};
			const permissionContext = {
				agent: context.agent,
				attemptId: context.attempt.id,
				workspaceFingerprint: context.task.workspaceFingerprint,
				sandboxProfileSha256: context.attempt.runtimeSnapshot.sandboxPolicySha256,
				sandboxAvailable: executionEnvironment?.trust === "sandboxed",
				sandboxAllowedDomains: executionEnvironment?.allowedDomains,
				unattended: executionEnvironment !== undefined,
				unsafeNoSandbox: executionEnvironment?.trust === "unsafe_host",
				...gitFacts,
				prHeadSha: needsAuthorizationFacts
					? readPrHeadSha(intent.command?.normalized, this.runtime.cwd)
					: undefined,
			};
			const intentFingerprint = permissionIntentSha256(intent);
			let decision = await this.permissionKernel.authorize(intent, permissionContext, this.stopSignal);
			const riskReview = "review" in decision ? decision.review : undefined;
			if (riskReview) {
				const model = this.requireReviewerModel();
				this.store.recordRiskReview({
					taskId: context.task.id,
					attemptId: context.attempt.id,
					intentSha256: intentFingerprint,
					modelProvider: model.provider,
					modelId: model.id,
					promptSha256: RISK_REVIEWER_PROMPT_SHA256,
					inputSha256: sha256(
						riskReviewPayload(intent, {
							taskSummary: permissionTaskSummary(context.agent.objective),
							workspaceRoot: context.agent.workspaceRoot,
						}),
					),
					outputSha256: sha256(JSON.stringify(riskReview)),
					verdict: riskReview.verdict,
					risk: riskReview.risk,
					confidence: riskReview.confidence,
				});
			}
			if (decision.action === "ask") {
				const approval = await this.runtime.requestPermissionApproval({
					intent,
					intentSha256: intentFingerprint,
					code: decision.code,
					reason: decision.reason,
					suggestedScope: decision.suggestedScope,
					availableLifetimes:
						decision.code === "sandbox_profile_expansion_required"
							? ["task", "workspace"]
							: !intent.metadataComplete || intent.effect === "external_side_effect" || intent.destructive
								? ["once"]
								: ["once", "attempt", "task", "workspace"],
				});
				if (approval?.action === "allow") {
					if (typeof this.store.createPermissionGrant !== "function")
						throw new Error("Durable permission store is unavailable");
					this.store.createPermissionGrant({
						source: "user",
						lifetime: approval.lifetime,
						scope: decision.suggestedScope,
						taskId: context.task.id,
						...(["once", "attempt"].includes(approval.lifetime) ? { attemptId: context.attempt.id } : {}),
						workspaceFingerprint: context.task.workspaceFingerprint,
						sandboxProfileSha256: context.attempt.runtimeSnapshot.sandboxPolicySha256,
					});
					decision = await this.permissionKernel.authorize(intent, permissionContext, this.stopSignal);
				} else if (approval?.action === "deny") {
					decision = { action: "deny", code: "user_denied", reason: "User denied this action" };
				}
			}
			if (decision.action === "allow" && decision.source === "user_authorization" && needsAuthorizationFacts) {
				const refreshedGitFacts = readGitAuthorizationFacts(this.runtime.cwd);
				const refreshedPrHeadSha = readPrHeadSha(intent.command?.normalized, this.runtime.cwd);
				if (
					refreshedGitFacts.gitHead !== permissionContext.gitHead ||
					refreshedGitFacts.changeSetSha256 !== permissionContext.changeSetSha256 ||
					refreshedPrHeadSha !== permissionContext.prHeadSha
				)
					decision = await this.permissionKernel.authorize(
						intent,
						{ ...permissionContext, ...refreshedGitFacts, prHeadSha: refreshedPrHeadSha },
						this.stopSignal,
					);
			}
			if (decision.action !== "allow") {
				if (typeof this.store.recordPermissionDecision === "function")
					this.store.recordPermissionDecision({
						taskId: context.task.id,
						attemptId: context.attempt.id,
						operationId: intent.operationId,
						intentSha256: intentFingerprint,
						action: decision.action,
						source: decision.code === "user_denied" ? "user" : riskReview ? "reviewer" : "policy",
						reasonCode: decision.code,
					});
				this.store.appendAgentEvent(
					this.requireLease(),
					context.attempt.id,
					decision.action === "ask" ? "PermissionRequested" : "SecurityPolicyDenied",
					{
						operationId: intent.operationId,
						toolCallId: event.toolCallId,
						toolName: intent.toolName,
						intentSha256: intentFingerprint,
						code: decision.code,
						reason: decision.reason,
						schemaVersion: 1,
					},
				);
				if (decision.action === "ask" && context.task.state === "running") {
					this.store.transitionTask(context.task.id, "waiting_input", "permission_required");
				}
				return { block: true, reason: decision.reason, terminate: true };
			}
			this.store.startToolExecution(this.requireLease(), context.attempt.id, {
				operationId: intent.operationId,
				toolCallId: event.toolCallId,
				toolName: intent.toolName,
				inputSha256: sha256(JSON.stringify(event.input)),
				effect: intent.effect,
				paths: [...intent.paths],
				permissionSource: decision.source,
				intentSha256: intentFingerprint,
				...(decision.source === "grant" && decision.grantId ? { grantId: decision.grantId } : {}),
				...(decision.source === "user_authorization" ? { authorizationId: decision.authorizationId } : {}),
			});
			if (decision.source === "reviewer") this.permissionKernel.consumeReviewerAllowance(intent.operationId);
			return undefined;
		}
		if (event.type === "after_tool") {
			const effect = defaultToolEffect(event.toolName);
			await waitForEvalEffectRelease(
				event,
				effect,
				this.runtime.cwd,
				this.stopSignal,
				getWorkerStartupIfLoaded()?.evalEffectGate,
			);
			try {
				this.store.finishToolExecution(this.requireLease(), context.attempt.id, {
					operationId: event.operationId,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
					summary: event.resultSummary,
				});
			} catch (error) {
				const reason = `Tool result could not be persisted: ${error instanceof Error ? error.message : String(error)}`;
				try {
					this.store.markExecutionOutcomeUnknown(this.requireLease(), context.attempt.id, reason);
				} catch {
					// Unfinished ToolStarted remains as the durable recovery barrier.
				}
				throw new Error(reason, { cause: error });
			}
			return undefined;
		}
		if (event.type === "before_compaction") {
			await this.commitCheckpoint(true);
			this.store.appendAgentEvent(this.requireLease(), context.attempt.id, "CompactionStarted", {
				reason: event.reason,
				schemaVersion: 1,
			});
			return undefined;
		}
		if (event.type === "after_compaction") {
			this.store.appendAgentEvent(this.requireLease(), context.attempt.id, "CompactionFinished", {
				reason: event.reason,
				entryId: event.entryId,
				schemaVersion: 1,
			});
			return undefined;
		}
		await this.commitCheckpoint(false);
		this.assertRunnable("continuation decision");
		this.lease = this.store.renewLease(this.requireLease(), this.leaseSeconds);
		const checkpoint = this.store.getLatestCheckpoint(context.agent.id);
		if (checkpoint) {
			const continuation = new ContinuationController(this.store, this.continuationPolicy).evaluate({
				lease: this.requireLease(),
				attemptId: context.attempt.id,
				settledTurnIndex: checkpoint.sessionCheckpoint.settledTurnIndex,
				progress: this.progress,
			});
			if (!continuation.duplicate && continuation.decision.nextPrompt && this.resident) {
				const prompt = continuation.decision.nextPrompt;
				setTimeout(() => {
					if (this.stopSignal.aborted) return;
					void this.runtime.session.prompt(prompt).catch((error) => {
						this.store.appendTaskEvent(context.task.id, "ContinuationPromptFailed", {
							decisionId: continuation.decision.id,
							message: error instanceof Error ? error.message : String(error),
							schemaVersion: 1,
						});
						const task = this.store.requireTask(context.task.id);
						if (task.state === "running")
							this.store.transitionTask(task.id, "waiting_external", "continuation_prompt_failed");
					});
				}, 0);
			}
		}
		return undefined;
	}

	private assertRunnable(boundary: string): void {
		if (this.heartbeatError) throw this.heartbeatError;
		if (this.deadlineAt && Date.now() >= Date.parse(this.deadlineAt)) {
			const context = this.store.resolveAttemptClaim(this.requireClaim());
			if (context.task.state === "running")
				this.store.transitionTask(context.task.id, "paused", "deadline_exceeded");
			throw new Error(`Task wall-time deadline exceeded before ${boundary}`);
		}
	}

	private renewLease(): void {
		try {
			this.assertRunnable("lease renewal");
			const context = this.store.resolveAttemptClaim(this.requireClaim());
			if (["paused", "cancelled"].includes(context.agent.state)) {
				void this.runtime.session.abort();
				return;
			}
			this.lease = this.store.renewLease(this.requireLease(), this.leaseSeconds);
		} catch (error) {
			this.heartbeatError = error instanceof Error ? error : new Error(String(error));
			void this.runtime.session.abort();
		}
	}

	private async commitCheckpoint(beforeCompaction: boolean): Promise<void> {
		const context = this.store.resolveAttemptClaim(this.requireClaim());
		const update = this.store.getPendingCheckpointUpdate(context.task.id, context.agent.id);
		if (update) {
			this.progress = {
				...this.progress,
				summary: update.summary,
				completedItems: update.completedItems,
				...(update.currentItem ? { currentItem: update.currentItem } : {}),
				nextActions: update.nextActions,
			};
			this.evidence = update.evidence;
		}
		const checkpoint = beforeCompaction
			? await this.runtime.createPreCompactionCheckpoint()
			: await this.runtime.createCheckpoint();
		const checkpointProgress = { ...this.progress, consumedMessageIds: [...this.consumedMessageIds] };
		this.store.commitCheckpoint({
			taskId: context.task.id,
			agentId: context.agent.id,
			attemptId: context.attempt.id,
			lease: this.requireLease(),
			sessionCheckpoint: {
				...checkpoint,
				runtimeSnapshotSha256: context.attempt.runtimeSnapshotSha256,
			},
			progress: checkpointProgress,
			evidence: this.evidence,
			workspaceSnapshot: this.store.getLatestCheckpoint(context.agent.id)?.workspaceSnapshot ?? {},
		});
		this.progress = { ...checkpointProgress, consumedMessageIds: [] };
		this.consumedMessageIds.clear();
	}

	private async compilePendingAuthorizations(taskId: string): Promise<void> {
		for (const source of this.store.listPendingTaskAuthorizationSources(taskId)) {
			try {
				const candidates = await this.authorizationCompiler.compile(source, this.stopSignal);
				const model = this.requireReviewerModel();
				this.store.completeTaskAuthorizationSource({
					sourceId: source.id,
					compilerProvider: model.provider,
					compilerModel: model.id,
					compilerPromptSha256: AUTHORIZATION_COMPILER_PROMPT_SHA256,
					...readGitAuthorizationFacts(this.runtime.cwd),
					candidates,
				});
			} catch {
				this.store.failTaskAuthorizationSource(source.id, "authorization_compile_invalid_or_unavailable");
			}
		}
	}

	private requireReviewerModel(): Model<Api> {
		if (this.reviewerModel) return this.reviewerModel;
		const context = this.store.resolveAttemptClaim(this.requireClaim());
		const frozen = context.attempt.runtimeSnapshot.reviewer;
		if (!frozen) throw new Error("Reviewer is disabled for this Attempt");
		const model = this.runtime.session.modelRuntime.getModel(frozen.provider, frozen.id);
		if (!model || !this.runtime.session.modelRuntime.hasConfiguredAuth(model.provider))
			throw new Error("Frozen Reviewer model is unavailable");
		if (reviewerPricingSha256(model) !== frozen.pricingSha256)
			throw new Error("Frozen Reviewer pricing changed during the Attempt");
		this.reviewerModel = model;
		return this.reviewerModel;
	}

	private requireClaim(): ClaimedAttempt {
		if (!this.claim) throw new Error("NativeLongTaskAgent has no active Attempt claim");
		return this.claim;
	}

	private requireLease(): AgentLease {
		if (!this.lease) throw new Error("NativeLongTaskAgent has no active lease");
		return this.lease;
	}
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}

export async function recoverExpiredLongTaskExecutions(
	store: SqliteTaskStore,
	workerRegistry?: WorkerRegistry,
): Promise<RecoveryResult[]> {
	return new RecoveryEngine(store, {
		async stopExecution(execution) {
			if (execution.pid === undefined) return false;
			if (workerRegistry) {
				const descriptor = workerRegistry
					.list()
					.find(
						(candidate) =>
							candidate.agentId === execution.agentId &&
							candidate.workerId === execution.workerId &&
							candidate.executionId === execution.executionId &&
							candidate.pid === execution.pid &&
							candidate.sandboxId === execution.sandboxId,
					);
				if (!descriptor) return false;
				if (descriptor.state === "exited") return true;
				if (!processExists(descriptor.pid)) {
					workerRegistry.write({ ...descriptor, state: "exited", heartbeatAt: new Date().toISOString() });
					return true;
				}
				return false;
			}
			if (!execution.workerId.startsWith("foreground:")) return false;
			return !processExists(execution.pid);
		},
	}).recoverExpired();
}

class NativeLongTaskExecution {
	async attach(
		runtime: AgentSessionRuntime,
		agentDir: string,
		taskId: string,
		agentId: string,
		acceptRuntimeDrift: boolean,
		continuationPolicy: ContinuationPolicy,
	): Promise<LongTaskRuntimeHandle> {
		const store = SqliteTaskStore.open({
			databasePath: join(agentDir, "long-tasks.sqlite"),
			artifactsRoot: join(agentDir, "tasks"),
		});
		const task = store.requireTask(taskId);
		const actor = store.listAgents(taskId).find((agent) => agent.id === agentId);
		if (!actor) {
			store.close();
			throw new Error(`Task ${taskId} has no main Agent`);
		}
		if (realpathSync(runtime.cwd) !== realpathSync(actor.workspaceRoot)) {
			store.close();
			throw new Error(`Agent workspace mismatch: expected ${actor.workspaceRoot}, got ${runtime.cwd}`);
		}
		const runDirectory = process.env.EVER_RUN_DIRECTORY;
		const blockedRecovery = (
			await recoverExpiredLongTaskExecutions(store, runDirectory ? new WorkerRegistry(runDirectory) : undefined)
		).find((result) => result.agentId === actor.id && !result.recovered);
		if (blockedRecovery) {
			store.close();
			throw new Error(
				`Recovery blocked for Agent ${blockedRecovery.agentId}: ${blockedRecovery.reason ?? "unknown"}`,
			);
		}
		const snapshot = runtimeSnapshot(
			runtime,
			actor.toolPolicy.sandboxRequired,
			selectTaskReviewerModel(runtime, task),
		);
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
		const leaseSeconds = Number(process.env.EVER_WORKER_LEASE_SECONDS ?? 30);
		const heartbeatSeconds = Number(process.env.EVER_WORKER_HEARTBEAT_SECONDS ?? 5);
		if (
			!Number.isFinite(leaseSeconds) ||
			leaseSeconds <= 0 ||
			!Number.isFinite(heartbeatSeconds) ||
			heartbeatSeconds <= 0
		) {
			store.close();
			throw new Error("Invalid long-task Worker lease or heartbeat configuration");
		}
		const workerStartup = getWorkerStartupIfLoaded();
		const residentWorker = workerStartup !== undefined;
		const workerId = residentWorker ? process.env.EVER_WORKER_ID : `foreground:${process.pid}`;
		const executionId = residentWorker ? process.env.EVER_EXECUTION_ID : randomUUID();
		if (!workerId || !executionId) {
			store.close();
			throw new Error("Resident Worker execution identity is missing");
		}
		const claim = store.claimAttempt({
			agentId: actor.id,
			sessionId: runtime.session.sessionId,
			runtimeSnapshot: snapshot,
			runtimeSnapshotSha256: runtimeSnapshotHash(snapshot),
			workerId,
			executionId,
			leaseSeconds,
			pid: process.pid,
			...(workerStartup?.executionEnvironment.sandboxId
				? { sandboxId: workerStartup.executionEnvironment.sandboxId }
				: {}),
		});
		const stopController = new AbortController();
		let markReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			markReady = resolve;
		});
		const nativeAgent = new NativeLongTaskAgent({
			runtime,
			store,
			continuationPolicy,
			leaseSeconds,
			heartbeatSeconds,
			stopSignal: stopController.signal,
			onReady: markReady,
			resident: true,
			artifactsRoot: join(agentDir, "tasks"),
		});
		const running = nativeAgent.run(claim);
		try {
			await Promise.race([
				ready,
				running.then(() => {
					throw new Error("NativeLongTaskAgent stopped before becoming ready");
				}),
			]);
		} catch (error) {
			stopController.abort();
			try {
				await running;
			} finally {
				store.close();
			}
			throw error;
		}
		return {
			async drainAndClose() {
				stopController.abort();
				try {
					return await running;
				} finally {
					store.close();
				}
			},
		};
	}
}

/** Attach one Session runtime to the durable Attempt execution module. */
export function attachLongTaskRuntime(
	runtime: AgentSessionRuntime,
	agentDir: string,
	taskId: string,
	agentId: string,
	acceptRuntimeDrift: boolean,
	continuationPolicy: ContinuationPolicy,
): Promise<LongTaskRuntimeHandle> {
	return new NativeLongTaskExecution().attach(
		runtime,
		agentDir,
		taskId,
		agentId,
		acceptRuntimeDrift,
		continuationPolicy,
	);
}
