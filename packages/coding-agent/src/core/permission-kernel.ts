import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type {
	AgentRecord,
	PermissionGrantLifetime,
	PermissionGrantRecord,
	PermissionScope,
	TaskAuthorizationRecord,
	ToolEffect,
} from "@lioooooo123/ever-long-tasks";
import type { RiskReviewer } from "./risk-reviewer.ts";

export type ToolIdempotency = "native" | "reconcilable" | "none";

export interface ToolDurabilityMetadata {
	effect: ToolEffect;
	idempotency: ToolIdempotency;
	requiresSandbox: boolean;
	metadataComplete: boolean;
	packageIdentity?: { name?: string; version?: string };
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
	packageIdentity?: { name?: string; version?: string };
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
	gitHead?: string;
	changeSetSha256?: string;
	prHeadSha?: string;
}

export interface PermissionGrantRepository {
	list(context: PermissionContext): readonly PermissionGrantRecord[];
	wasDenied(intentSha256: string, context: PermissionContext): boolean;
}

export interface TaskAuthorizationRepository {
	list(context: PermissionContext): readonly TaskAuthorizationRecord[];
	revision?(context: PermissionContext): number;
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
	| { action: "allow"; source: "user_authorization"; authorizationId: string }
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
	const deleteOperands =
		command && /^(?:rm|rmdir|truncate|shred)\s/u.test(command)
			? command
					.split(" ")
					.slice(1)
					.filter((value) => value.length > 0 && !value.startsWith("-"))
			: [];
	const paths = [input.input.path, ...(deleteOperands.length > 0 ? [] : [input.input.cwd]), ...deleteOperands]
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
	let packageIdentity: ToolIntent["packageIdentity"];
	if (command && /^(?:npm|pnpm|yarn) publish(?:\s|$)/u.test(command)) {
		try {
			const commandCwd =
				typeof input.input.cwd === "string" ? resolve(input.workspaceRoot, input.input.cwd) : input.workspaceRoot;
			const packageJson = JSON.parse(readFileSync(resolve(commandCwd, "package.json"), "utf8")) as Record<
				string,
				unknown
			>;
			packageIdentity = {
				...(typeof packageJson.name === "string" ? { name: packageJson.name } : {}),
				...(typeof packageJson.version === "string" ? { version: packageJson.version } : {}),
			};
		} catch {
			packageIdentity = undefined;
		}
	}
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
		...(packageIdentity ? { packageIdentity } : {}),
	};
}

const SAFE_PROCESS_COMMAND =
	/^(?:git\s+(?:diff|log|show)|git\s+status(?:\s+(?:--short|--porcelain(?:=v[12])?|--branch))*|(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:check|test|lint|typecheck|build)))$/u;
const SHELL_COMPOSITION = /[\n\r;&|<>`$()]/u;
const MANUAL_CONFIRMATION_COMMAND =
	/\b(?:git\s+push|npm\s+publish|gh\s+pr\s+(?:create|merge|comment)|docker\s+push|kubectl\s+(?:apply|delete)|terraform\s+apply|curl|wget|scp|ssh|rsync)\b/u;

interface AuthorizationIntent {
	action: TaskAuthorizationRecord["action"];
	targets: Record<string, unknown>;
	limits: Record<string, unknown>;
}

const CHANGE_SET_BOUND_ACTIONS = new Set<TaskAuthorizationRecord["action"]>([
	"git_push",
	"pr_create",
	"pr_merge",
	"package_publish",
	"release_publish",
	"deploy",
]);

function authorizationIntent(intent: ToolIntent): AuthorizationIntent | undefined {
	const command = intent.command?.normalized;
	if (!command || SHELL_COMPOSITION.test(command) || /['"\\]/u.test(command)) return undefined;
	const parts = command.split(" ");
	const valueAfter = (flag: string) => {
		const index = parts.indexOf(flag);
		if (index >= 0) return parts[index + 1];
		return parts.find((part) => part.startsWith(`${flag}=`))?.slice(flag.length + 1);
	};
	if (parts[0] === "git" && parts[1] === "push") {
		const args = parts.slice(2);
		const force = args.some((arg) => arg === "-f" || arg === "--force" || arg.startsWith("--force-with-lease"));
		const positional = args.filter((arg) => !arg.startsWith("-"));
		const remote = positional[0];
		if (!remote) return undefined;
		return {
			action: "git_push",
			targets: { repository: "current", remote, branch: positional[1] ?? "current" },
			limits: { force },
		};
	}
	if (parts[0] === "gh" && parts[1] === "pr" && parts[2] === "create") {
		return {
			action: "pr_create",
			targets: {
				repository: valueAfter("--repo") ?? "current",
				base: valueAfter("--base") ?? "current",
				head: valueAfter("--head") ?? "current",
			},
			limits: { draft: parts.includes("--draft") },
		};
	}
	if (["npm", "pnpm", "yarn"].includes(parts[0] ?? "") && parts[1] === "publish") {
		const registry = valueAfter("--registry");
		if (!registry || !intent.packageIdentity?.name || !intent.packageIdentity.version) return undefined;
		return {
			action: "package_publish",
			targets: {
				package: intent.packageIdentity.name,
				version: intent.packageIdentity.version,
				registry,
			},
			limits: {
				...(valueAfter("--tag") ? { tag: valueAfter("--tag") } : {}),
				...(valueAfter("--access") ? { access: valueAfter("--access") } : {}),
			},
		};
	}
	if (parts[0] === "gh" && parts[1] === "release" && parts[2] === "create") {
		const tag = parts[3]?.startsWith("-") ? undefined : parts[3];
		if (!tag) return undefined;
		return {
			action: "release_publish",
			targets: {
				repository: valueAfter("--repo") ?? "current",
				tag,
			},
			limits: { draft: parts.includes("--draft"), prerelease: parts.includes("--prerelease") },
		};
	}
	if (
		(parts[0] === "kubectl" && ["apply", "delete"].includes(parts[1] ?? "")) ||
		(parts[0] === "terraform" && parts[1] === "apply") ||
		(parts[0] === "vercel" && parts[1] === "deploy")
	) {
		const provider = parts[0] === "kubectl" ? "kubernetes" : parts[0];
		const environment =
			parts[0] === "kubectl"
				? (valueAfter("--namespace") ?? valueAfter("-n"))
				: parts[0] === "vercel"
					? parts.includes("--prod")
						? "production"
						: "preview"
					: valueAfter("--environment");
		const project = valueAfter("--project") ?? valueAfter("--context");
		if (!environment || !project) return undefined;
		return {
			action: "deploy",
			targets: {
				provider,
				project,
				environment,
			},
			limits: { destructive: parts[1] === "delete" },
		};
	}
	if (
		parts[0] === "gh" &&
		((parts[1] === "pr" && parts[2] === "comment") || (parts[1] === "issue" && parts[2] === "comment"))
	) {
		const body = valueAfter("--body");
		const recipient = parts[3]?.startsWith("-") ? undefined : parts[3];
		if (!body || !recipient || valueAfter("--body-file")) return undefined;
		return {
			action: "external_message",
			targets: {
				channel: `github_${parts[1]}`,
				repository: valueAfter("--repo") ?? "current",
				recipient,
				body,
			},
			limits: {},
		};
	}
	if (
		(parts[0] === "gh" && parts[1] === "auth" && ["login", "setup-git"].includes(parts[2] ?? "")) ||
		(parts[0] === "npm" && ["login", "adduser"].includes(parts[1] ?? ""))
	) {
		const account = parts[0] === "gh" ? valueAfter("--hostname") : valueAfter("--registry");
		const scope = valueAfter(parts[0] === "gh" ? "--scopes" : "--scope");
		if (!account || !scope) return undefined;
		return {
			action: "credential_configure",
			targets: { provider: parts[0], account, scope },
			limits: {},
		};
	}
	if (parts[0] === "ever" && parts[1] === "sandbox" && parts[2] === "allow-domain") {
		const domain = parts[3];
		if (!domain) return undefined;
		return { action: "network_expand", targets: { domains: [domain] }, limits: { workspace: "current" } };
	}
	if (parts[0] === "gh" && parts[1] === "pr" && parts[2] === "merge") {
		const pr = parts[3]?.startsWith("-") ? undefined : parts[3];
		if (!pr) return undefined;
		return {
			action: "pr_merge",
			targets: { repository: valueAfter("--repo") ?? "current", pr },
			limits: {
				bypass: parts.includes("--admin"),
				method: parts.includes("--squash") ? "squash" : parts.includes("--rebase") ? "rebase" : "merge",
			},
		};
	}
	if (intent.destructive) {
		return {
			action: "delete",
			targets: { paths: intent.paths },
			limits: { recursive: /(?:^|\s)(?:-r|-rf|-fr|--recursive)(?:\s|$)/u.test(command), permanent: true },
		};
	}
	return undefined;
}

export function toolIntentRequiresAuthorizationFacts(intent: ToolIntent): boolean {
	return authorizationIntent(intent) !== undefined;
}

function authorizationValueMatches(expected: unknown, actual: unknown): boolean {
	if (Array.isArray(actual))
		return (
			Array.isArray(expected) &&
			expected.length === actual.length &&
			actual.every((value, index) => authorizationValueMatches(expected[index], value))
		);
	if (actual !== null && typeof actual === "object") {
		if (expected === null || typeof expected !== "object" || Array.isArray(expected)) return false;
		const expectedRecord = expected as Record<string, unknown>;
		const actualEntries = Object.entries(actual as Record<string, unknown>);
		return (
			Object.keys(expectedRecord).length === actualEntries.length &&
			actualEntries.every(([key, value]) => authorizationValueMatches(expectedRecord[key], value))
		);
	}
	return expected === actual;
}

function authorizationMatches(
	authorization: TaskAuthorizationRecord,
	intent: AuthorizationIntent,
	context: PermissionContext,
): boolean {
	const expectedTargets =
		authorization.action === "delete" && Array.isArray(authorization.targets.paths)
			? {
					...authorization.targets,
					paths: authorization.targets.paths.map((path) =>
						typeof path === "string"
							? canonicalize(isAbsolute(path) ? path : resolve(context.agent.workspaceRoot, path))
							: path,
					),
				}
			: authorization.targets;
	const changeSetMatches = CHANGE_SET_BOUND_ACTIONS.has(authorization.action)
		? authorization.gitHead !== undefined &&
			authorization.changeSetSha256 !== undefined &&
			authorization.gitHead === context.gitHead &&
			authorization.changeSetSha256 === context.changeSetSha256
		: (authorization.gitHead === undefined || authorization.gitHead === context.gitHead) &&
			(authorization.changeSetSha256 === undefined || authorization.changeSetSha256 === context.changeSetSha256);
	return (
		authorization.state === "active" &&
		authorization.usedCount < authorization.maxUses &&
		authorization.action === intent.action &&
		(authorization.action !== "pr_merge" ||
			(context.gitHead !== undefined && context.prHeadSha !== undefined && context.gitHead === context.prHeadSha)) &&
		changeSetMatches &&
		authorizationValueMatches(expectedTargets, intent.targets) &&
		authorizationValueMatches(authorization.limits, intent.limits)
	);
}

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

export function permissionTaskSummary(objective: string): string {
	let summary = "";
	for (const character of objective) {
		if (Buffer.byteLength(summary + character, "utf8") > 500) break;
		summary += character;
	}
	return summary;
}

/** Permission seam combining deterministic policy, durable grants, and a bounded risk reviewer. */
export class PermissionKernel {
	private readonly reviewer: RiskReviewer | undefined;
	private readonly grants: PermissionGrantRepository | undefined;
	private readonly authorizations: TaskAuthorizationRepository | undefined;
	private readonly minimumReviewerConfidence: number;
	private readonly reviewCacheTtlMs: number;
	private readonly onReviewCacheHit: ((intent: ToolIntent) => void) | undefined;
	private readonly onReviewFailure: ((intent: ToolIntent, error: unknown) => void) | undefined;
	private readonly onReviewConsumed: ((operationId: string) => void) | undefined;
	private readonly reviewCache = new Map<
		string,
		{ expiresAt: number; operationId: string; review: ReturnType<RiskReviewer["review"]> }
	>();
	private reviewTail: Promise<void> = Promise.resolve();

	constructor(options?: {
		reviewer?: RiskReviewer;
		grants?: PermissionGrantRepository;
		authorizations?: TaskAuthorizationRepository;
		minimumReviewerConfidence?: number;
		reviewCacheTtlMs?: number;
		onReviewCacheHit?: (intent: ToolIntent) => void;
		onReviewFailure?: (intent: ToolIntent, error: unknown) => void;
		onReviewConsumed?: (operationId: string) => void;
	}) {
		this.reviewer = options?.reviewer;
		this.grants = options?.grants;
		this.authorizations = options?.authorizations;
		this.minimumReviewerConfidence = options?.minimumReviewerConfidence ?? 0.9;
		this.reviewCacheTtlMs = options?.reviewCacheTtlMs ?? 60 * 60 * 1000;
		this.onReviewCacheHit = options?.onReviewCacheHit;
		this.onReviewFailure = options?.onReviewFailure;
		this.onReviewConsumed = options?.onReviewConsumed;
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
		const normalizedAuthorizationIntent = authorizationIntent(intent);
		const manualConfirmation =
			!intent.metadataComplete ||
			intent.effect === "external_side_effect" ||
			(normalizedAuthorizationIntent !== undefined && normalizedAuthorizationIntent.action !== "delete") ||
			(intent.command !== undefined && MANUAL_CONFIRMATION_COMMAND.test(intent.command.normalized));
		const destructive = intent.destructive;
		const hash = permissionIntentSha256(intent);
		if (this.grants?.wasDenied(hash, context))
			return {
				action: "deny",
				code: "permission_previously_denied",
				reason: "This action was denied for the Attempt",
			};
		const authorization = normalizedAuthorizationIntent
			? this.authorizations
					?.list(context)
					.find((candidate) => authorizationMatches(candidate, normalizedAuthorizationIntent, context))
			: undefined;
		if (authorization) return { action: "allow", source: "user_authorization", authorizationId: authorization.id };
		if (
			normalizedAuthorizationIntent &&
			this.authorizations
				?.list(context)
				.some(
					(candidate) =>
						candidate.state === "active" &&
						candidate.usedCount < candidate.maxUses &&
						candidate.action === normalizedAuthorizationIntent.action,
				)
		)
			return ask(
				"authorization_scope_mismatch",
				"The operation conflicts with an active user authorization target, limit, or runtime snapshot",
				intent,
			);
		if (
			!manualConfirmation &&
			!destructive &&
			(intent.effect !== "process" ||
				(intent.command &&
					!SHELL_COMPOSITION.test(intent.command.normalized) &&
					SAFE_PROCESS_COMMAND.test(intent.command.normalized)))
		)
			return { action: "allow", source: "policy" };
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
				review.authorizationMatch === "none" &&
				review.targetMatch === "exact" &&
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

	/** Consumes cached allow-once reviews after ToolStarted is durably recorded. */
	consumeReviewerAllowance(operationId: string): void {
		let consumed = false;
		for (const [key, cached] of this.reviewCache) {
			if (cached.operationId === operationId) {
				this.reviewCache.delete(key);
				consumed = true;
			}
		}
		if (consumed) this.onReviewConsumed?.(operationId);
	}

	private review(intent: ToolIntent, context: PermissionContext, signal?: AbortSignal) {
		if (!this.reviewer) throw new Error("Risk reviewer is unavailable");
		const cacheKey = createHash("sha256")
			.update(
				JSON.stringify({
					taskId: intent.taskId,
					attemptId: intent.attemptId,
					operationId: intent.operationId,
					toolName: intent.toolName,
					effect: intent.effect,
					paths: intent.paths,
					commandFingerprint: intent.command?.fingerprint,
					networkDomains: intent.networkDomains,
					credentialScopes: intent.credentialScopes,
					metadataComplete: intent.metadataComplete,
					workspaceRoot: context.agent.workspaceRoot,
					workspaceFingerprint: context.workspaceFingerprint,
					sandboxProfileSha256: context.sandboxProfileSha256,
					authorizationRevision: this.authorizations?.revision?.(context) ?? 0,
				}),
			)
			.digest("hex");
		const cached = this.reviewCache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) {
			this.onReviewCacheHit?.(intent);
			return cached.review;
		}
		let release: (() => void) | undefined;
		const previous = this.reviewTail;
		this.reviewTail = new Promise<void>((resolveReview) => {
			release = resolveReview;
		});
		const reviewer = this.reviewer;
		const review = (async () => {
			await previous;
			try {
				return await reviewer.review(
					intent,
					{
						taskSummary: permissionTaskSummary(context.agent.objective),
						workspaceRoot: context.agent.workspaceRoot,
					},
					signal,
				);
			} finally {
				release?.();
			}
		})();
		this.reviewCache.set(cacheKey, {
			expiresAt: Date.now() + this.reviewCacheTtlMs,
			operationId: intent.operationId,
			review,
		});
		void review.catch((error: unknown) => {
			this.reviewCache.delete(cacheKey);
			this.onReviewFailure?.(intent, error);
		});
		return review;
	}
}
