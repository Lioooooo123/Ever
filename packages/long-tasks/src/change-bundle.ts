import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteTaskStore } from "./store.ts";
import type { AcceptanceCriterion, AttemptRecord, TaskEvent, WorkspaceSnapshot } from "./types.ts";

export interface VerifiedChangeBundleManifest {
	schemaVersion: 1;
	generatedAt: string;
	verified: boolean;
	task: {
		id: string;
		title: string;
		goal: string;
		state: string;
		constraints: Record<string, unknown>;
		budget: Record<string, unknown>;
		workspaceFingerprint: string;
	};
	attempt?: {
		id: string;
		agentId: string;
		state: string;
		runtimeSnapshot: AttemptRecord["runtimeSnapshot"];
		runtimeSnapshotSha256: string;
		turnCount: number;
		costUsd: number;
	};
	workspace: {
		root: string;
		baseCommit?: string;
		headCommit?: string;
		status: string;
		changedFiles: string[];
		diffArtifact?: string;
		diffSha256?: string;
		diffBytes: number;
		checkpointSnapshot?: WorkspaceSnapshot | Record<string, unknown>;
	};
	acceptance: Array<{
		criterion: AcceptanceCriterion;
		status: "passed" | "failed" | "pending";
		eventId?: string;
		evaluatedAt?: string;
		evidence?: unknown;
	}>;
	evidence: Array<{ source: "acceptance" | "checkpoint"; contentSha256: string; value: unknown }>;
	provider: {
		confidence: "exact" | "partial" | "unknown";
		actualCostUsd: number;
		requests: Array<{
			providerRequestId: string;
			provider?: string;
			modelId?: string;
			actualCostUsd?: number;
			usage?: unknown;
			stopReason?: string;
			state: "finished" | "unknown";
		}>;
	};
	manualDecisions: Array<{ criterionId: string; eventId: string; decidedAt: string; evidence?: unknown }>;
	warnings: Array<{ code: string; message: string; eventId?: string }>;
}

export interface VerifiedChangeBundleResult {
	manifest: VerifiedChangeBundleManifest;
	manifestPath: string;
	manifestSha256: string;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
	const field = value[key];
	return typeof field === "string" ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
	const field = value[key];
	return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function gitText(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return undefined;
	}
}

function gitBytes(cwd: string, args: string[]): Buffer | undefined {
	try {
		return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return undefined;
	}
}

function allEvents(store: SqliteTaskStore, taskId: string): TaskEvent[] {
	const events: TaskEvent[] = [];
	let afterSeq = 0;
	for (;;) {
		const page = store.listEvents(taskId, afterSeq, 1000);
		events.push(...page);
		if (page.length < 1000) return events;
		afterSeq = page.at(-1)!.seq;
	}
}

function atomicWrite(path: string, value: string | Uint8Array): void {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, value, { mode: 0o600 });
		renameSync(temporary, path);
		chmodSync(path, 0o600);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Rebuilds the user-facing proof artifact exclusively from durable Task facts and the current Git workspace. */
export class VerifiedChangeBundle {
	private readonly store: SqliteTaskStore;
	private readonly artifactsRoot: string;
	private readonly now: () => Date;

	constructor(options: { store: SqliteTaskStore; artifactsRoot: string; now?: () => Date }) {
		this.store = options.store;
		this.artifactsRoot = options.artifactsRoot;
		this.now = options.now ?? (() => new Date());
	}

	rebuild(taskId: string): VerifiedChangeBundleResult {
		const task = this.store.requireTask(taskId);
		const events = allEvents(this.store, taskId);
		const mainAgent = this.store.listAgents(taskId).find((agent) => agent.kind === "main");
		const attempt = mainAgent ? this.store.getLatestAttempt(mainAgent.id) : undefined;
		const checkpoint = mainAgent ? this.store.getLatestCheckpoint(mainAgent.id) : undefined;
		const warnings: VerifiedChangeBundleManifest["warnings"] = [];
		const taskDirectory = join(this.artifactsRoot, task.id);
		mkdirSync(taskDirectory, { recursive: true, mode: 0o700 });
		chmodSync(taskDirectory, 0o700);

		const checkpointBaseCommit = checkpoint ? stringField(checkpoint.workspaceSnapshot, "baseCommit") : undefined;
		const baseCommit = task.initialGitHead ?? checkpointBaseCommit;
		const headCommit = gitText(task.workspaceRoot, ["rev-parse", "HEAD"])?.trim() || undefined;
		const status = gitText(task.workspaceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
		let diff: Buffer | undefined;
		if (baseCommit) diff = gitBytes(task.workspaceRoot, ["diff", "--binary", baseCommit, "--"]);
		if (status === undefined || headCommit === undefined) {
			warnings.push({ code: "git_workspace_unavailable", message: "Git workspace status could not be read." });
		}
		if (!baseCommit) warnings.push({ code: "git_base_missing", message: "Task has no durable Git base commit." });
		if (baseCommit && diff === undefined)
			warnings.push({
				code: "git_diff_unavailable",
				message: "Final Git diff could not be reconstructed from its base.",
			});
		const diffArtifact = diff ? join(taskDirectory, "verified-change.diff") : undefined;
		if (diff && diffArtifact) atomicWrite(diffArtifact, diff);
		const tracked = baseCommit
			? (gitText(task.workspaceRoot, ["diff", "--name-only", "-z", baseCommit, "--"]) ?? "").split("\0")
			: [];
		const untracked = (gitText(task.workspaceRoot, ["ls-files", "--others", "--exclude-standard", "-z"]) ?? "").split(
			"\0",
		);
		const changedFiles = [...new Set([...tracked, ...untracked].filter((path) => path.length > 0))].sort();

		const latestAcceptance = new Map<string, TaskEvent>();
		for (const event of events) {
			if (event.type !== "AcceptancePassed" && event.type !== "AcceptanceFailed") continue;
			const criterionId = stringField(event.payload, "criterionId");
			if (criterionId) latestAcceptance.set(criterionId, event);
		}
		const acceptance = task.acceptance.map((criterion) => {
			const event = latestAcceptance.get(criterion.id);
			return {
				criterion,
				status: (event?.type === "AcceptancePassed"
					? "passed"
					: event?.type === "AcceptanceFailed"
						? "failed"
						: "pending") as "passed" | "failed" | "pending",
				...(event ? { eventId: event.id, evaluatedAt: event.createdAt } : {}),
				...(event && event.payload.evidence !== undefined ? { evidence: event.payload.evidence } : {}),
			};
		});

		const evidence: VerifiedChangeBundleManifest["evidence"] = [];
		const seenEvidence = new Set<string>();
		const addEvidence = (source: "acceptance" | "checkpoint", value: unknown): void => {
			const contentSha256 = sha256(stableJson(value));
			if (seenEvidence.has(contentSha256)) return;
			seenEvidence.add(contentSha256);
			evidence.push({ source, contentSha256, value });
		};
		for (const result of acceptance) if (result.evidence !== undefined) addEvidence("acceptance", result.evidence);
		for (const value of checkpoint?.evidence ?? []) addEvidence("checkpoint", value);

		const started = new Map<string, TaskEvent>();
		const finished = new Map<string, TaskEvent>();
		for (const event of events) {
			const providerRequestId = stringField(event.payload, "providerRequestId");
			if (!providerRequestId) continue;
			if (event.type === "ProviderRequestStarted") started.set(providerRequestId, event);
			if (event.type === "ProviderRequestFinished") finished.set(providerRequestId, event);
		}
		const providerRequests: VerifiedChangeBundleManifest["provider"]["requests"] = [];
		for (const [providerRequestId, start] of started) {
			const finish = finished.get(providerRequestId);
			providerRequests.push({
				providerRequestId,
				...(stringField(start.payload, "provider") ? { provider: stringField(start.payload, "provider") } : {}),
				...(stringField(start.payload, "modelId") ? { modelId: stringField(start.payload, "modelId") } : {}),
				...(finish && numberField(finish.payload, "actualCostUsd") !== undefined
					? { actualCostUsd: numberField(finish.payload, "actualCostUsd") }
					: {}),
				...(finish?.payload.usage !== undefined ? { usage: finish.payload.usage } : {}),
				...(finish && stringField(finish.payload, "stopReason")
					? { stopReason: stringField(finish.payload, "stopReason") }
					: {}),
				state: finish ? "finished" : "unknown",
			});
		}
		for (const event of events) {
			if (!["ProviderOutcomeUnknown", "ToolOutcomeUnknown", "ContinuationPromptFailed"].includes(event.type))
				continue;
			warnings.push({
				code: event.type,
				message: stringField(event.payload, "reason") ?? stringField(event.payload, "message") ?? event.type,
				eventId: event.id,
			});
		}
		for (const request of providerRequests) {
			if (request.state === "unknown")
				warnings.push({
					code: "provider_request_unknown",
					message: `Provider request ${request.providerRequestId} has no durable result.`,
				});
		}
		if (task.state === "unknown_outcome")
			warnings.push({ code: "task_outcome_unknown", message: task.stateReason ?? "Task outcome is unknown." });

		const manualIds = new Set(
			task.acceptance.filter((criterion) => criterion.kind === "manual").map((criterion) => criterion.id),
		);
		const manualDecisions = [...latestAcceptance]
			.filter(([criterionId, event]) => manualIds.has(criterionId) && event.type === "AcceptancePassed")
			.map(([criterionId, event]) => ({
				criterionId,
				eventId: event.id,
				decidedAt: event.createdAt,
				...(event.payload.evidence !== undefined ? { evidence: event.payload.evidence } : {}),
			}));
		const allAcceptancePassed = acceptance.every((result) => result.status === "passed");
		const providerUnknown = providerRequests.some((request) => request.state === "unknown");
		const manifest: VerifiedChangeBundleManifest = {
			schemaVersion: 1,
			generatedAt: this.now().toISOString(),
			verified: task.state === "completed" && allAcceptancePassed && warnings.length === 0,
			task: {
				id: task.id,
				title: task.title,
				goal: task.goal,
				state: task.state,
				constraints: task.constraints,
				budget: task.budget,
				workspaceFingerprint: task.workspaceFingerprint,
			},
			...(attempt
				? {
						attempt: {
							id: attempt.id,
							agentId: attempt.agentId,
							state: attempt.state,
							runtimeSnapshot: attempt.runtimeSnapshot,
							runtimeSnapshotSha256: attempt.runtimeSnapshotSha256,
							turnCount: attempt.turnCount,
							costUsd: attempt.costUsd,
						},
					}
				: {}),
			workspace: {
				root: task.workspaceRoot,
				...(baseCommit ? { baseCommit } : {}),
				...(headCommit ? { headCommit } : {}),
				status: status ?? "unavailable",
				changedFiles,
				...(diffArtifact ? { diffArtifact } : {}),
				...(diff ? { diffSha256: sha256(diff) } : {}),
				diffBytes: diff?.byteLength ?? 0,
				...(checkpoint ? { checkpointSnapshot: checkpoint.workspaceSnapshot } : {}),
			},
			acceptance,
			evidence,
			provider: {
				confidence: providerUnknown ? "partial" : providerRequests.length > 0 ? "exact" : "unknown",
				actualCostUsd: task.totalCostUsd,
				requests: providerRequests,
			},
			manualDecisions,
			warnings,
		};
		const manifestJson = `${stableJson(manifest)}\n`;
		const manifestPath = join(taskDirectory, "verified-change-bundle.json");
		atomicWrite(manifestPath, manifestJson);
		return { manifest, manifestPath, manifestSha256: sha256(manifestJson) };
	}
}
