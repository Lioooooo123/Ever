import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type RuntimeSnapshot,
	runtimeSnapshotHash,
	SqliteTaskStore,
	TaskController,
	VerifiedChangeBundle,
} from "../src/index.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runtimeSnapshot(): RuntimeSnapshot {
	return {
		everVersion: "0.1.0",
		upstreamCommit: "test",
		protocolVersion: 1,
		model: { provider: "faux", id: "faux-model" },
		systemPromptSha256: "system",
		contextFiles: [],
		resources: [],
		toolPolicySha256: "tools",
		sandboxPolicySha256: "sandbox",
	};
}

describe("VerifiedChangeBundle", () => {
	it("rebuilds a stable verified artifact from durable facts and the Git workspace", () => {
		const root = mkdtempSync(join(tmpdir(), "ever-change-bundle-"));
		temporaryPaths.push(root);
		const workspaceRoot = join(root, "workspace");
		const artifactsRoot = join(root, "artifacts");
		mkdirSync(workspaceRoot);
		git(workspaceRoot, ["init"]);
		git(workspaceRoot, ["config", "user.name", "Ever Test"]);
		git(workspaceRoot, ["config", "user.email", "ever@example.invalid"]);
		writeFileSync(join(workspaceRoot, "result.txt"), "before\n");
		git(workspaceRoot, ["add", "result.txt"]);
		git(workspaceRoot, ["commit", "-m", "base"]);
		const baseCommit = git(workspaceRoot, ["rev-parse", "HEAD"]);
		const store = SqliteTaskStore.open({ databasePath: join(root, "tasks.sqlite"), artifactsRoot });
		const controller = new TaskController(store);
		const task = controller.create({
			title: "bundle",
			goal: "produce verified change",
			acceptance: [{ id: "manual", kind: "manual", description: "reviewed" }],
			constraints: { mode: "balanced" },
			budget: { maxTurns: 5, maxWallTimeMinutes: 60, maxCostUsd: 1 },
			workspaceRoot,
			workspaceFingerprint: "workspace",
			initialGitHead: baseCommit,
		});
		controller.submit(task.id);
		const agent = store.listAgents(task.id).find((candidate) => candidate.kind === "main")!;
		const snapshot = runtimeSnapshot();
		const snapshotSha256 = runtimeSnapshotHash(snapshot);
		const claim = store.claimAttempt({
			agentId: agent.id,
			sessionId: "session",
			runtimeSnapshot: snapshot,
			runtimeSnapshotSha256: snapshotSha256,
			workerId: "worker",
			executionId: "execution",
		});
		const context = store.resolveAttemptClaim(claim);
		const reservationId = store.startProviderRequest(context.lease, context.attempt.id, {
			providerRequestId: "provider-request",
			provider: "faux",
			modelId: "faux-model",
			requestKind: "turn",
			worstCaseCostUsd: 0.1,
		});
		store.finishProviderRequest(context.lease, context.attempt.id, {
			providerRequestId: "provider-request",
			reservationId,
			actualCostUsd: 0.02,
			usage: { input: 10, output: 5, cacheRead: 3 },
			stopReason: "stop",
		});
		store.recordAcceptance(task.id, "manual", true, { confirmedBy: "user" });
		store.commitCheckpoint({
			taskId: task.id,
			agentId: agent.id,
			attemptId: context.attempt.id,
			lease: context.lease,
			sessionCheckpoint: {
				sessionId: "session",
				settledTurnIndex: 1,
				runtimeSnapshotSha256: snapshotSha256,
				createdAt: "2026-08-12T00:00:00.000Z",
			},
			progress: {
				summary: "verified",
				completedItems: ["change"],
				nextActions: [],
				blockers: [],
				filesRead: [],
				filesModified: ["result.txt"],
				verification: [],
				consumedMessageIds: [],
				outboundMessageIds: [],
			},
			evidence: [{ id: "result", kind: "file", ref: "result.txt" }],
			workspaceSnapshot: { baseCommit },
		});
		writeFileSync(join(workspaceRoot, "result.txt"), "after\n");
		store.transitionTask(task.id, "completed", "verified");

		const bundle = new VerifiedChangeBundle({
			store,
			artifactsRoot,
			now: () => new Date("2026-08-12T01:00:00.000Z"),
		});
		const first = bundle.rebuild(task.id);
		const rebuilt = bundle.rebuild(task.id);

		expect(first.manifest).toMatchObject({
			verified: true,
			task: { state: "completed", goal: "produce verified change" },
			workspace: { baseCommit, changedFiles: ["result.txt"] },
			acceptance: [{ status: "passed" }],
			provider: {
				confidence: "exact",
				actualCostUsd: 0.02,
				requests: [{ providerRequestId: "provider-request", state: "finished", actualCostUsd: 0.02 }],
			},
			manualDecisions: [{ criterionId: "manual" }],
			warnings: [],
		});
		expect(first.manifest.evidence).toHaveLength(2);
		expect(first.manifest.workspace.diffSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.parse(readFileSync(first.manifestPath, "utf8"))).toMatchObject({ verified: true });
		expect(rebuilt.manifestSha256).toBe(first.manifestSha256);
		store.close();
	});
});
