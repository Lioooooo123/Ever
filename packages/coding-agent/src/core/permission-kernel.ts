import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type {
	AgentRecord,
	PermissionGrantLifetime,
	PermissionGrantRecord,
	PermissionScope,
	ToolEffect,
} from "@lioooooo123/ever-long-tasks";
import type { RiskReviewer } from "./risk-reviewer.ts";

export type ToolIdempotency = "native" | "reconcilable" | "none";

export interface ToolDurabilityMetadata {
	effect: ToolEffect;
	idempotency: ToolIdempotency;
	requiresSandbox: boolean;
	metadataComplete: boolean;
}

export interface ToolIntent {
	operationId: string;
	taskId: string;
	attemptId: string;
	sessionId: string;
	toolName: string;
	effect: ToolEffect;
	paths: readonly string[];
	command?: { normalized: string; fingerprint: string };
	networkDomains: readonly string[];
	credentialScopes: readonly string[];
	destructive: boolean;
	reversible: boolean;
	idempotency: ToolIdempotency;
	requiresSandbox: boolean;
	metadataComplete: boolean;
}

export interface PermissionContext {
	agent: AgentRecord;
	attemptId: string;
	workspaceFingerprint: string;
	sandboxProfileSha256: string;
	sandboxAvailable: boolean;
	sandboxAllowedDomains?: readonly string[];
	unattended: boolean;
	unsafeNoSandbox?: boolean;
}

export interface PermissionGrantRepository {
	list(context: PermissionContext): readonly PermissionGrantRecord[];
	wasDenied(intentSha256: string, context: PermissionContext): boolean;
}

export interface PermissionApprovalRequest {
	intent: ToolIntent;
	intentSha256: string;
	code: string;
	reason: string;
	suggestedScope: PermissionScope;
	availableLifetimes: readonly PermissionGrantLifetime[];
}

export type PermissionApproval = { action: "deny" } | { action: "allow"; lifetime: PermissionGrantLifetime };

export type PermissionDecision =
	| { action: "allow"; source: "policy" | "grant"; grantId?: string }
	| { action: "allow"; source: "reviewer"; review: Awaited<ReturnType<RiskReviewer["review"]>> }
	| {
			action: "ask";
			code: string;
			reason: string;
			suggestedScope: PermissionScope;
			review?: Awaited<ReturnType<RiskReviewer["review"]>>;
	  }
	| { action: "deny"; code: string; reason: string; review?: Awaited<ReturnType<RiskReviewer["review"]>> };

const BUILTIN_TOOL_METADATA: Readonly<Record<string, ToolDurabilityMetadata>> = {
	read: { effect: "read_only", idempotency: "native", requiresSandbox: false, metadataComplete: true },
	grep: { effect: "read_only", idempotency: "native", requiresSandbox: false, metadataComplete: true },
	find: { effect: "read_only", idempotency: "native", requiresSandbox: false, metadataComplete: true },
	ls: { effect: "read_only", idempotency: "native", requiresSandbox: false, metadataComplete: true },
	read_only_command: {
		effect: "read_only",
		idempotency: "native",
		requiresSandbox: true,
		metadataComplete: true,
	},
	edit: {
		effect: "reconcilable_write",
		idempotency: "reconcilable",
		requiresSandbox: true,
		metadataComplete: true,
	},
	write: {
		effect: "reconcilable_write",
		idempotency: "reconcilable",
		requiresSandbox: true,
		metadataComplete: true,
	},
	bash: { effect: "process", idempotency: "none", requiresSandbox: true, metadataComplete: true },
	task_update: {
		effect: "reconcilable_write",
		idempotency: "reconcilable",
		requiresSandbox: false,
		metadataComplete: true,
	},
};

const UNKNOWN_TOOL_METADATA: ToolDurabilityMetadata = {
	effect: "external_side_effect",
	idempotency: "none",
	requiresSandbox: true,
	metadataComplete: false,
};

function canonicalize(path: string): string {
	let existing = resolve(path);
	const suffix: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) break;
		suffix.unshift(existing.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
		existing = parent;
	}
	return resolve(realpathSync(existing), ...suffix);
}

function isInside(path: string, root: string): boolean {
	const child = relative(realpathSync(root), canonicalize(path));
	return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

export function toolDurabilityMetadata(toolName: string): ToolDurabilityMetadata {
	return BUILTIN_TOOL_METADATA[toolName] ?? UNKNOWN_TOOL_METADATA;
}

export function normalizeToolIntent(input: {
	operationId: string;
	taskId: string;
	attemptId: string;
	sessionId: string;
	toolName: string;
	input: Readonly<Record<string, unknown>>;
	workspaceRoot: string;
	metadata?: Omit<ToolDurabilityMetadata, "metadataComplete">;
}): ToolIntent {
	const metadata = input.metadata
		? { ...input.metadata, metadataComplete: true }
		: toolDurabilityMetadata(input.toolName);
	const rawCommand = typeof input.input.command === "string" ? input.input.command : undefined;
	const command = rawCommand?.trim().replace(/\s+/gu, " ");
	const paths = [input.input.path, input.input.cwd]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.map((path) => canonicalize(isAbsolute(path) ? path : resolve(input.workspaceRoot, path)));
	if (metadata.effect === "process" && paths.length === 0) paths.push(canonicalize(input.workspaceRoot));
	const networkDomains = command
		? [
				...new Set(
					[...command.matchAll(/\bhttps?:\/\/[^\s'"`<>]+/gu)].flatMap((match) => {
						try {
							return [new URL(match[0]).hostname.toLowerCase()];
						} catch {
							return [];
						}
					}),
				),
			]
		: [];
	return {
		operationId: input.operationId,
		taskId: input.taskId,
		attemptId: input.attemptId,
		sessionId: input.sessionId,
		toolName: input.toolName,
		effect: metadata.effect,
		paths: [...new Set(paths)],
		...(command
			? { command: { normalized: command, fingerprint: createHash("sha256").update(command).digest("hex") } }
			: {}),
		networkDomains,
		credentialScopes: [],
		destructive:
			command !== undefined &&
			/(?:^|[;&|]\s*)(?:rm|rmdir|truncate|shred)\b|\bgit\s+(?:clean|reset)\b/u.test(command),
		reversible: metadata.effect === "read_only" || metadata.effect === "reconcilable_write",
		idempotency: metadata.idempotency,
		requiresSandbox: metadata.requiresSandbox,
		metadataComplete: metadata.metadataComplete,
	};
}

const SAFE_PROCESS_COMMAND =
	/^(?:git\s+(?:diff|log|show)|git\s+status(?:\s+(?:--short|--porcelain(?:=v[12])?|--branch))*|(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:check|test|lint|typecheck|build)))$/u;
const SHELL_COMPOSITION = /[\n\r;&|<>`$()]/u;
const MANUAL_CONFIRMATION_COMMAND =
	/\b(?:git\s+push|npm\s+publish|gh\s+pr\s+(?:create|merge|comment)|docker\s+push|kubectl\s+(?:apply|delete)|terraform\s+apply|curl|wget|scp|ssh|rsync)\b/u;

/** Stable fingerprint for one permission meaning, excluding per-execution identities. */
export function permissionIntentSha256(intent: ToolIntent): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				toolName: intent.toolName,
				effect: intent.effect,
				paths: intent.paths,
				command: intent.command,
				networkDomains: intent.networkDomains,
				credentialScopes: intent.credentialScopes,
				destructive: intent.destructive,
				reversible: intent.reversible,
				idempotency: intent.idempotency,
				requiresSandbox: intent.requiresSandbox,
				metadataComplete: intent.metadataComplete,
			}),
		)
		.digest("hex");
}

function permissionScope(intent: ToolIntent): PermissionScope {
	return {
		toolNames: [intent.toolName],
		effects: [intent.effect],
		pathPrefixes: [...intent.paths],
		commandFingerprints: intent.command ? [intent.command.fingerprint] : [],
		networkDomains: [...intent.networkDomains],
		credentialScopes: [...intent.credentialScopes],
	};
}

function domainAllowed(domain: string, allowedDomains: readonly string[]): boolean {
	return allowedDomains.some(
		(allowed) =>
			allowed === domain ||
			(allowed.startsWith("*.") && domain.endsWith(allowed.slice(1)) && domain !== allowed.slice(2)),
	);
}

function scopeIncludes(scope: PermissionScope, intent: ToolIntent): boolean {
	return (
		scope.toolNames.includes(intent.toolName) &&
		scope.effects.includes(intent.effect) &&
		intent.paths.every((path) => scope.pathPrefixes.some((prefix) => isInside(path, prefix))) &&
		(!intent.command || scope.commandFingerprints.includes(intent.command.fingerprint)) &&
		intent.networkDomains.every((domain) => scope.networkDomains.includes(domain)) &&
		intent.credentialScopes.every((credential) => scope.credentialScopes.includes(credential))
	);
}

function ask(code: string, reason: string, intent: ToolIntent): Extract<PermissionDecision, { action: "ask" }> {
	return { action: "ask", code, reason, suggestedScope: permissionScope(intent) };
}

/** Permission seam combining deterministic policy, durable grants, and a bounded risk reviewer. */
export class PermissionKernel {
	private readonly reviewer: RiskReviewer | undefined;
	private readonly grants: PermissionGrantRepository | undefined;
	private readonly minimumReviewerConfidence: number;
	private readonly reviewCacheTtlMs: number;
	private readonly reviewCache = new Map<string, { expiresAt: number; review: ReturnType<RiskReviewer["review"]> }>();

	constructor(options?: {
		reviewer?: RiskReviewer;
		grants?: PermissionGrantRepository;
		minimumReviewerConfidence?: number;
		reviewCacheTtlMs?: number;
	}) {
		this.reviewer = options?.reviewer;
		this.grants = options?.grants;
		this.minimumReviewerConfidence = options?.minimumReviewerConfidence ?? 0.8;
		this.reviewCacheTtlMs = options?.reviewCacheTtlMs ?? 60 * 60 * 1000;
	}

	async authorize(intent: ToolIntent, context: PermissionContext, signal?: AbortSignal): Promise<PermissionDecision> {
		const { agent } = context;
		if (intent.taskId !== agent.taskId)
			return { action: "deny", code: "task_mismatch", reason: "Tool intent belongs to another Task" };
		if (!agent.toolPolicy.allowedTools.includes(intent.toolName))
			return {
				action: "deny",
				code: "tool_not_allowed",
				reason: `${intent.toolName} is outside the agent tool policy`,
			};
		if (!intent.paths.every((path) => agent.toolPolicy.allowedPaths.some((root) => isInside(path, root))))
			return { action: "deny", code: "path_not_allowed", reason: "Tool path is outside the delegated scope" };
		if (agent.toolPolicy.readOnly && intent.effect !== "read_only")
			return {
				action: "deny",
				code: "read_only_violation",
				reason: "Read-only agents cannot execute side-effecting tools",
			};
		if (
			(agent.toolPolicy.sandboxRequired || (context.unattended && intent.requiresSandbox)) &&
			!context.sandboxAvailable
		)
			return {
				action: "deny",
				code: "sandbox_required",
				reason: "The tool or agent policy requires an execution sandbox",
			};
		if (
			context.unattended &&
			intent.effect !== "read_only" &&
			!context.sandboxAvailable &&
			context.unsafeNoSandbox !== true
		)
			return {
				action: "deny",
				code: "unattended_sandbox_required",
				reason: "Unattended side-effecting tools require an execution sandbox",
			};
		if (
			context.sandboxAvailable &&
			intent.networkDomains.some((domain) => !domainAllowed(domain, context.sandboxAllowedDomains ?? []))
		)
			return ask(
				"sandbox_profile_expansion_required",
				"The operation requires network domains outside the current sandbox profile",
				intent,
			);
		const manualConfirmation =
			!intent.metadataComplete ||
			intent.effect === "external_side_effect" ||
			(intent.command !== undefined && MANUAL_CONFIRMATION_COMMAND.test(intent.command.normalized));
		const destructive = intent.destructive;
		const hash = permissionIntentSha256(intent);
		if (this.grants?.wasDenied(hash, context))
			return {
				action: "deny",
				code: "permission_previously_denied",
				reason: "This action was denied for the Attempt",
			};
		const grant = this.grants
			?.list(context)
			.find(
				(candidate) =>
					scopeIncludes(candidate.scope, intent) &&
					(!(manualConfirmation || destructive) || (candidate.source === "user" && candidate.lifetime === "once")),
			);
		if (grant) return { action: "allow", source: "grant", grantId: grant.id };
		if (manualConfirmation)
			return ask(
				intent.metadataComplete ? "external_side_effect_confirmation_required" : "tool_metadata_required",
				intent.metadataComplete
					? "Publishing, deployment, push, and external communication require explicit user confirmation"
					: `${intent.toolName} has no complete durability metadata`,
				intent,
			);
		if (destructive)
			return ask(
				"destructive_process_confirmation_required",
				"Destructive process commands require explicit user confirmation",
				intent,
			);
		if (
			intent.effect !== "process" ||
			(intent.command &&
				!SHELL_COMPOSITION.test(intent.command.normalized) &&
				SAFE_PROCESS_COMMAND.test(intent.command.normalized))
		)
			return { action: "allow", source: "policy" };
		if (!this.reviewer || !context.sandboxAvailable)
			return ask(
				"process_review_required",
				"This process command requires risk review or user confirmation",
				intent,
			);
		try {
			const review = await this.review(intent, context, signal);
			if (
				review.verdict === "allow_once" &&
				review.risk === "low" &&
				review.confidence >= this.minimumReviewerConfidence
			)
				return { action: "allow", source: "reviewer", review };
			return review.verdict === "deny"
				? { action: "deny", code: review.reasonCode, reason: review.explanation, review }
				: { ...ask(review.reasonCode, review.explanation, intent), review };
		} catch (error) {
			return ask(
				"risk_reviewer_unavailable",
				error instanceof Error ? error.message : "Risk reviewer failed",
				intent,
			);
		}
	}

	private review(intent: ToolIntent, context: PermissionContext, signal?: AbortSignal) {
		if (!this.reviewer) throw new Error("Risk reviewer is unavailable");
		const cacheKey = createHash("sha256")
			.update(
				JSON.stringify({
					toolName: intent.toolName,
					effect: intent.effect,
					paths: intent.paths,
					commandFingerprint: intent.command?.fingerprint,
					networkDomains: intent.networkDomains,
					credentialScopes: intent.credentialScopes,
					metadataComplete: intent.metadataComplete,
					workspaceRoot: context.agent.workspaceRoot,
				}),
			)
			.digest("hex");
		const cached = this.reviewCache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) return cached.review;
		const review = this.reviewer.review(
			intent,
			{ goal: context.agent.objective, workspaceRoot: context.agent.workspaceRoot },
			signal,
		);
		this.reviewCache.set(cacheKey, { expiresAt: Date.now() + this.reviewCacheTtlMs, review });
		void review.catch(() => this.reviewCache.delete(cacheKey));
		return review;
	}
}
