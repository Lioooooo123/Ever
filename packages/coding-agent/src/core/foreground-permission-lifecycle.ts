import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { type Api, type Context, contentText, type Model } from "@lioooooo123/ever-ai";
import {
	type AgentRecord,
	SqliteTaskStore,
	type TaskAuthorizationRecord,
	type TaskAuthorizationSourceRecord,
} from "@lioooooo123/ever-long-tasks";
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
	toolIntentRequiresAuthorizationFacts,
} from "./permission-kernel.ts";
import { reviewerWorstCaseCostUsd, selectReviewerModel } from "./reviewer-model-selector.ts";
import { ModelRiskReviewer } from "./risk-reviewer.ts";
import { requestSandboxControl } from "./sandbox-control.ts";
import { getWorkerStartupIfLoaded } from "./worker-startup.ts";
import { workspaceIdentity } from "./workspace-identity.ts";

const foregroundSessionInstanceId = randomUUID();

/** Applies the same deterministic permission seam to ordinary, non-Task Sessions. */
export class ForegroundPermissionLifecycle implements AgentSessionLifecycle {
	private readonly runtime: AgentSessionRuntime;
	private readonly agentDir: string;
	private readonly taskOwnsPermission: () => boolean;
	private readonly authorizations: TaskAuthorizationRecord[] = [];
	private readonly compiledSources = new Set<string>();
	private readonly reviewerReservations = new Map<string, number>();
	private readonly allowedDomains = new Set<string>(
		getWorkerStartupIfLoaded()?.executionEnvironment.allowedDomains ?? [],
	);
	private reviewerSettledCostUsd = 0;
	private mainAgentSettledCostUsd = 0;
	private compilerRequestCount = 0;
	private reviewerRequestCount = 0;
	private authorizationRevision = 0;
	private selectedReviewerModel?: Model<Api>;
	private store?: SqliteTaskStore;
	private readonly compiler: ModelAuthorizationCompiler;
	private readonly kernel: PermissionKernel;
	private readonly workspace: ReturnType<typeof workspaceIdentity>;

	constructor(runtime: AgentSessionRuntime, agentDir: string, taskOwnsPermission: () => boolean) {
		this.runtime = runtime;
		this.agentDir = agentDir;
		this.taskOwnsPermission = taskOwnsPermission;
		this.workspace = workspaceIdentity(runtime.cwd);
		const complete =
			(kind: "authorization_compile" | "permission_review") => (context: Context, signal?: AbortSignal) =>
				this.runtime.session.completeLifecycleRequest(kind, context, signal, {
					model: this.reviewerModel(),
					maxTokens: kind === "authorization_compile" ? 256 : 192,
				});
		this.compiler = new ModelAuthorizationCompiler(complete("authorization_compile"));
		this.kernel = new PermissionKernel({
			authorizations: { list: () => this.authorizations, revision: () => this.authorizationRevision },
			reviewer: new ModelRiskReviewer(complete("permission_review")),
			grants: {
				list: (context) =>
					this.getStore()
						.listPermissionGrants()
						.filter(
							(grant) =>
								grant.state === "active" &&
								grant.workspaceFingerprint === context.workspaceFingerprint &&
								(grant.lifetime === "workspace" ||
									grant.lifetime === "project_policy" ||
									(grant.lifetime === "session" &&
										grant.sessionId === this.runtime.session.sessionId &&
										grant.sessionInstanceId === foregroundSessionInstanceId) ||
									(grant.lifetime !== "session" && grant.taskId === context.agent.taskId)),
						),
				wasDenied: () => false,
			},
		});
	}

	private getStore(): SqliteTaskStore {
		this.store ??= SqliteTaskStore.open({
			databasePath: join(this.agentDir, "long-tasks.sqlite"),
			artifactsRoot: join(this.agentDir, "tasks"),
		});
		return this.store;
	}

	async handle(event: AgentSessionLifecycleEvent): Promise<AgentSessionLifecycleDecision | undefined> {
		if (this.taskOwnsPermission()) return undefined;
		if (event.type === "before_request") {
			if (event.kind !== "authorization_compile" && event.kind !== "permission_review") return undefined;
			if (this.compilerRequestCount + this.reviewerRequestCount >= 32)
				throw new Error("Foreground Attempt Reviewer request limit exceeded");
			const count = event.kind === "authorization_compile" ? this.compilerRequestCount : this.reviewerRequestCount;
			const limit = event.kind === "authorization_compile" ? 32 : 128;
			if (count >= limit) throw new Error("Foreground reviewer request limit exceeded");
			const worstCaseCostUsd = reviewerWorstCaseCostUsd(
				event.model,
				event.kind === "authorization_compile" ? 256 : 192,
			);
			const committed =
				this.reviewerSettledCostUsd + [...this.reviewerReservations.values()].reduce((a, b) => a + b, 0);
			if (worstCaseCostUsd > Math.min(0.05 - committed, 0.002 + this.mainAgentSettledCostUsd * 0.05 - committed))
				throw new Error("Foreground reviewer cost budget exceeded");
			this.reviewerReservations.set(event.requestId, worstCaseCostUsd);
			if (event.kind === "authorization_compile") this.compilerRequestCount++;
			else this.reviewerRequestCount++;
			return undefined;
		}
		if (event.type === "after_response") {
			const reserved = this.reviewerReservations.get(event.requestId);
			if (reserved !== undefined) {
				if (event.message.stopReason === "error") return undefined;
				if (event.usage.cost.total > reserved + 1e-9)
					throw new Error("Foreground reviewer actual cost exceeded its reservation");
				this.reviewerReservations.delete(event.requestId);
				this.reviewerSettledCostUsd += event.usage.cost.total;
			} else if (event.kind === "agent") {
				this.mainAgentSettledCostUsd += event.usage.cost.total;
			}
			return undefined;
		}
		if (event.type !== "before_tool") return undefined;
		const now = new Date().toISOString();
		const taskId = `foreground:${event.sessionId}`;
		await this.compileUserMessages(taskId);
		const agent: AgentRecord = {
			id: taskId,
			taskId,
			kind: "main",
			name: "foreground",
			role: "interactive",
			objective: "Execute the current interactive Session safely",
			state: "running",
			depth: 0,
			workspaceMode: "primary",
			workspaceRoot: this.runtime.cwd,
			toolPolicy: {
				allowedTools: [...this.runtime.session.getActiveToolNames()],
				allowedPaths: [this.runtime.cwd],
				readOnly: false,
				sandboxRequired: false,
			},
			budget: { maxTurns: 1, maxWallTimeMinutes: 1 },
			createdAt: now,
			updatedAt: now,
		};
		const intent = normalizeToolIntent({
			operationId: event.operationId,
			taskId,
			attemptId: taskId,
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
			agent,
			attemptId: taskId,
			workspaceFingerprint: this.workspace.fingerprint,
			sandboxProfileSha256: executionEnvironment?.profileSha256 ?? "0".repeat(64),
			sandboxAvailable: executionEnvironment?.trust === "sandboxed",
			sandboxAllowedDomains: [...this.allowedDomains],
			unattended: false,
			...gitFacts,
			prHeadSha: needsAuthorizationFacts ? readPrHeadSha(intent.command?.normalized, this.runtime.cwd) : undefined,
		};
		let decision = await this.kernel.authorize(intent, permissionContext);
		if (decision.action === "allow" && decision.source === "user_authorization" && needsAuthorizationFacts) {
			const refreshedGitFacts = readGitAuthorizationFacts(this.runtime.cwd);
			const refreshedPrHeadSha = readPrHeadSha(intent.command?.normalized, this.runtime.cwd);
			if (
				refreshedGitFacts.gitHead !== permissionContext.gitHead ||
				refreshedGitFacts.changeSetSha256 !== permissionContext.changeSetSha256 ||
				refreshedPrHeadSha !== permissionContext.prHeadSha
			)
				decision = await this.kernel.authorize(intent, {
					...permissionContext,
					...refreshedGitFacts,
					prHeadSha: refreshedPrHeadSha,
				});
		}
		if (decision.action === "allow") {
			if (decision.source === "user_authorization") {
				const authorization = this.authorizations.find((candidate) => candidate.id === decision.authorizationId);
				if (!authorization || authorization.state !== "active")
					throw new Error("Foreground Task Authorization is unavailable");
				authorization.usedCount++;
				if (authorization.usedCount >= authorization.maxUses) {
					authorization.state = "consumed";
					authorization.consumedAt = now;
				}
				this.authorizationRevision++;
			}
			if (decision.source === "reviewer") this.kernel.consumeReviewerAllowance(intent.operationId);
			return undefined;
		}
		if (decision.action === "deny") return { block: true, reason: decision.reason, terminate: true };
		const approval = await this.runtime.requestPermissionApproval({
			intent,
			intentSha256: permissionIntentSha256(intent),
			code: decision.code,
			reason: decision.reason,
			suggestedScope: decision.suggestedScope,
			availableLifetimes:
				decision.code === "sandbox_profile_expansion_required" ? ["session", "workspace"] : ["once"],
		});
		if (approval?.action === "allow") {
			if (
				approval.lifetime === "session" ||
				approval.lifetime === "workspace" ||
				approval.lifetime === "project_policy"
			) {
				this.getStore().createPermissionGrant({
					source: "user",
					lifetime: approval.lifetime,
					scope: decision.suggestedScope,
					...(approval.lifetime === "session"
						? { sessionId: this.runtime.session.sessionId, sessionInstanceId: foregroundSessionInstanceId }
						: {}),
					workspaceFingerprint: permissionContext.workspaceFingerprint,
					sandboxProfileSha256: permissionContext.sandboxProfileSha256,
				});
			}
			if (decision.code === "sandbox_profile_expansion_required") {
				for (const domain of decision.suggestedScope.networkDomains) this.allowedDomains.add(domain);
				requestSandboxControl({
					type: "updateAllowedDomains",
					domains: decision.suggestedScope.networkDomains,
				});
			}
			return undefined;
		}
		return { block: true, reason: approval ? "User denied this action" : decision.reason, terminate: true };
	}

	private reviewerModel(): Model<Api> {
		this.selectedReviewerModel ??= selectReviewerModel({
			runtime: this.runtime.session.modelRuntime,
			workspaceOrGlobal: this.runtime.session.settingsManager.getLongTaskSettings().reviewerModel,
			preferredProvider: this.runtime.session.model?.provider,
			excludedAutomaticModel: this.runtime.session.model
				? { provider: this.runtime.session.model.provider, model: this.runtime.session.model.id }
				: undefined,
		});
		return this.selectedReviewerModel;
	}

	private async compileUserMessages(taskId: string): Promise<void> {
		let message = this.runtime.session.messages[this.runtime.session.messages.length - 1];
		for (let index = this.runtime.session.messages.length - 1; index >= 0; index--) {
			const candidate = this.runtime.session.messages[index];
			if (candidate.role === "user") {
				message = candidate;
				break;
			}
		}
		if (!message || message.role !== "user") return;
		const text = contentText(message.content).trim();
		if (!text) return;
		const textSha256 = createHash("sha256").update(text).digest("hex");
		if (this.compiledSources.has(textSha256)) return;
		this.compiledSources.add(textSha256);
		const source: TaskAuthorizationSourceRecord = {
			id: `foreground:${textSha256}`,
			taskId,
			kind: "steering",
			textSha256,
			text,
			state: "pending",
			createdAt: new Date(message.timestamp).toISOString(),
		};
		try {
			const candidates = await this.compiler.compile(source);
			const gitFacts = readGitAuthorizationFacts(this.runtime.cwd);
			for (const candidate of candidates) {
				this.authorizations.push({
					...candidate,
					...gitFacts,
					id: randomUUID(),
					taskId,
					sourceMessageId: source.id,
					sourceMessageSha256: source.textSha256,
					source: "user",
					usedCount: 0,
					compilerProvider: this.reviewerModel().provider,
					compilerModel: this.reviewerModel().id,
					compilerPromptSha256: AUTHORIZATION_COMPILER_PROMPT_SHA256,
					revision: this.authorizations.length + 1,
					state: "active",
					createdAt: new Date().toISOString(),
				});
				this.authorizationRevision++;
			}
		} catch {
			// Invalid, unavailable, or over-budget Compiler output falls back to foreground approval.
		}
	}
}
