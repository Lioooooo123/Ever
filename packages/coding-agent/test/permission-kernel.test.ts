import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord, PermissionGrantRecord, TaskAuthorizationRecord } from "@lioooooo123/ever-long-tasks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeToolIntent, PermissionKernel, permissionIntentSha256 } from "../src/core/permission-kernel.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "ever-permission-kernel-"));
	temporaryPaths.push(root);
	const workspace = join(root, "workspace");
	const outside = join(root, "outside");
	mkdirSync(workspace);
	mkdirSync(outside);
	const agent: AgentRecord = {
		id: "agent-1",
		taskId: "task-1",
		kind: "main",
		name: "main",
		role: "implementation",
		objective: "finish safely",
		state: "running",
		depth: 0,
		workspaceMode: "primary",
		workspaceRoot: workspace,
		toolPolicy: {
			allowedTools: ["read", "write", "bash", "deploy"],
			allowedPaths: [workspace],
			readOnly: false,
			sandboxRequired: true,
		},
		budget: { maxTurns: 10, maxWallTimeMinutes: 60 },
		createdAt: "2026-08-14T00:00:00.000Z",
		updatedAt: "2026-08-14T00:00:00.000Z",
	};
	const intent = (toolName: string, input: Record<string, unknown>) =>
		normalizeToolIntent({
			operationId: `operation-${toolName}`,
			taskId: agent.taskId,
			attemptId: "attempt-1",
			sessionId: "session-1",
			toolName,
			input,
			workspaceRoot: workspace,
		});
	const context = {
		agent,
		attemptId: "attempt-1",
		workspaceFingerprint: "workspace-1",
		sandboxProfileSha256: "a".repeat(64),
		sandboxAvailable: true,
		sandboxAllowedDomains: ["example.test"],
		unattended: true,
	};
	return { agent, context, intent, outside, workspace };
}

describe("PermissionKernel", () => {
	it("silently allows complete built-in tool intents inside the workspace", async () => {
		const { context, intent } = fixture();
		expect(await new PermissionKernel().authorize(intent("write", { path: "result.txt" }), context)).toEqual({
			action: "allow",
			source: "policy",
		});
	});

	it("denies canonical paths outside the delegated workspace", async () => {
		const { context, intent, outside } = fixture();
		expect(
			await new PermissionKernel().authorize(intent("write", { path: join(outside, "result.txt") }), context),
		).toMatchObject({ action: "deny", code: "path_not_allowed" });
	});

	it("requires review for extension tools without durability metadata", async () => {
		const { context, intent } = fixture();
		expect(await new PermissionKernel().authorize(intent("deploy", {}), context)).toMatchObject({
			action: "ask",
			code: "tool_metadata_required",
		});
	});

	it("accepts complete durability metadata declared by an extension tool", async () => {
		const { agent, context, workspace } = fixture();
		const intent = normalizeToolIntent({
			operationId: "operation-deploy",
			taskId: agent.taskId,
			attemptId: "attempt-1",
			sessionId: "session-1",
			toolName: "deploy",
			input: { path: "artifact.json" },
			workspaceRoot: workspace,
			metadata: { effect: "reconcilable_write", idempotency: "reconcilable", requiresSandbox: true },
		});
		expect(await new PermissionKernel().authorize(intent, context)).toEqual({
			action: "allow",
			source: "policy",
		});
	});

	it("normalizes command fingerprints and marks destructive process intents", () => {
		const { intent, workspace } = fixture();
		const first = intent("bash", { command: " rm   -rf build ", cwd: "." });
		const second = intent("bash", { command: "rm -rf build", cwd: workspace });
		expect(first.command).toEqual(second.command);
		expect(first.destructive).toBe(true);
		expect(first.paths).toEqual([join(realpathSync(workspace), "build")]);
	});

	it("matches a least-scope durable grant before risk review", async () => {
		const { context, intent, workspace } = fixture();
		const processIntent = intent("bash", { command: "node scripts/fetch-public-metadata.mjs" });
		const grant: PermissionGrantRecord = {
			id: "grant-1",
			source: "user",
			lifetime: "task",
			scope: {
				toolNames: ["bash"],
				effects: ["process"],
				pathPrefixes: [workspace],
				commandFingerprints: [processIntent.command!.fingerprint],
				networkDomains: [],
				credentialScopes: [],
			},
			taskId: context.agent.taskId,
			workspaceFingerprint: context.workspaceFingerprint,
			sandboxProfileSha256: context.sandboxProfileSha256,
			state: "active",
			createdAt: "2026-08-14T00:00:00.000Z",
		};
		const kernel = new PermissionKernel({
			grants: { list: () => [grant], wasDenied: () => false },
		});

		expect(await kernel.authorize(processIntent, context)).toEqual({
			action: "allow",
			source: "grant",
			grantId: grant.id,
		});
	});

	it("allows irreversible actions only through an explicit single-use user grant", async () => {
		const { context, intent, workspace } = fixture();
		const push = intent("bash", { command: "git push origin main" });
		const base: PermissionGrantRecord = {
			id: "grant-push",
			source: "user",
			lifetime: "task",
			scope: {
				toolNames: ["bash"],
				effects: ["process"],
				pathPrefixes: [workspace],
				commandFingerprints: [push.command!.fingerprint],
				networkDomains: [],
				credentialScopes: [],
			},
			taskId: context.agent.taskId,
			workspaceFingerprint: context.workspaceFingerprint,
			sandboxProfileSha256: context.sandboxProfileSha256,
			state: "active",
			createdAt: "2026-08-14T00:00:00.000Z",
		};
		const grants = [base];
		const kernel = new PermissionKernel({ grants: { list: () => grants, wasDenied: () => false } });
		expect(await kernel.authorize(push, context)).toMatchObject({ action: "ask" });
		grants[0] = { ...base, lifetime: "once" };
		expect(await kernel.authorize(push, context)).toEqual({
			action: "allow",
			source: "grant",
			grantId: base.id,
		});
	});

	it("matches an active Task Authorization before manual confirmation", async () => {
		const { context, intent } = fixture();
		const push = intent("bash", { command: "git push origin main" });
		const authorization: TaskAuthorizationRecord = {
			id: "authorization-push",
			taskId: context.agent.taskId,
			sourceMessageId: "goal:task-1",
			sourceMessageSha256: "a".repeat(64),
			source: "user",
			action: "git_push",
			targets: { repository: "current", remote: "origin", branch: "main" },
			limits: { force: false },
			lifetime: "task",
			maxUses: 1,
			usedCount: 0,
			confidence: 0.99,
			compilerProvider: "test",
			compilerModel: "small-reviewer",
			compilerPromptSha256: "b".repeat(64),
			gitHead: "head-1",
			changeSetSha256: "change-1",
			evidenceSpans: [{ startByte: 0, endByte: 10 }],
			revision: 1,
			state: "active",
			createdAt: "2026-08-14T00:00:00.000Z",
		};
		const kernel = new PermissionKernel({
			authorizations: { list: () => [authorization] },
		});
		const authorizedContext = { ...context, gitHead: "head-1", changeSetSha256: "change-1" };
		expect(await kernel.authorize(push, authorizedContext)).toEqual({
			action: "allow",
			source: "user_authorization",
			authorizationId: authorization.id,
		});
		expect(
			await kernel.authorize(intent("bash", { command: "git push --force origin main" }), authorizedContext),
		).toMatchObject({ action: "ask", code: "authorization_scope_mismatch" });
		expect(await kernel.authorize(push, { ...authorizedContext, gitHead: "head-2" })).toMatchObject({
			action: "ask",
			code: "authorization_scope_mismatch",
		});
	});

	it("binds package publication to the package version and registry", async () => {
		const { context, intent, workspace } = fixture();
		writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "example-package", version: "1.2.3" }));
		const authorization: TaskAuthorizationRecord = {
			id: "authorization-package",
			taskId: context.agent.taskId,
			sourceMessageId: "goal:task-1",
			sourceMessageSha256: "a".repeat(64),
			source: "user",
			action: "package_publish",
			targets: { package: "example-package", version: "1.2.3", registry: "https://example.test" },
			limits: {},
			lifetime: "task",
			maxUses: 1,
			usedCount: 0,
			confidence: 0.99,
			compilerProvider: "test",
			compilerModel: "small-reviewer",
			compilerPromptSha256: "b".repeat(64),
			gitHead: "head-1",
			changeSetSha256: "change-1",
			evidenceSpans: [{ startByte: 0, endByte: 10 }],
			revision: 1,
			state: "active",
			createdAt: "2026-08-14T00:00:00.000Z",
		};
		const kernel = new PermissionKernel({ authorizations: { list: () => [authorization] } });
		const publishContext = {
			...context,
			sandboxAllowedDomains: ["example.test", "other.test"],
			gitHead: "head-1",
			changeSetSha256: "change-1",
		};
		expect(
			await kernel.authorize(
				intent("bash", { command: "npm publish --registry https://example.test" }),
				publishContext,
			),
		).toMatchObject({ action: "allow", source: "user_authorization" });
		expect(
			await kernel.authorize(
				intent("bash", { command: "npm publish --registry https://other.test" }),
				publishContext,
			),
		).toMatchObject({ action: "ask", code: "authorization_scope_mismatch" });
	});

	it("rejects PR repository and remote head drift", async () => {
		const { context, intent } = fixture();
		const authorization: TaskAuthorizationRecord = {
			id: "authorization-merge",
			taskId: context.agent.taskId,
			sourceMessageId: "goal:task-1",
			sourceMessageSha256: "a".repeat(64),
			source: "user",
			action: "pr_merge",
			targets: { repository: "owner/repo", pr: "12" },
			limits: { bypass: false, method: "squash" },
			lifetime: "task",
			maxUses: 1,
			usedCount: 0,
			confidence: 0.99,
			compilerProvider: "test",
			compilerModel: "small-reviewer",
			compilerPromptSha256: "b".repeat(64),
			gitHead: "head-1",
			changeSetSha256: "change-1",
			evidenceSpans: [{ startByte: 0, endByte: 10 }],
			revision: 1,
			state: "active",
			createdAt: "2026-08-14T00:00:00.000Z",
		};
		const kernel = new PermissionKernel({ authorizations: { list: () => [authorization] } });
		const merge = intent("bash", { command: "gh pr merge 12 --repo owner/repo --squash" });
		expect(
			await kernel.authorize(merge, {
				...context,
				gitHead: "head-1",
				changeSetSha256: "change-1",
				prHeadSha: "head-1",
			}),
		).toMatchObject({ action: "allow", source: "user_authorization" });
		expect(
			await kernel.authorize(merge, {
				...context,
				gitHead: "head-2",
				changeSetSha256: "change-1",
				prHeadSha: "head-1",
			}),
		).toMatchObject({ action: "ask", code: "authorization_scope_mismatch" });
		expect(
			await kernel.authorize(intent("bash", { command: "gh pr merge 12 --repo owner/other --squash" }), {
				...context,
				gitHead: "head-1",
				changeSetSha256: "change-1",
				prHeadSha: "head-1",
			}),
		).toMatchObject({ action: "ask", code: "authorization_scope_mismatch" });
	});

	it("requests a new sandbox profile before authorizing an unmounted network domain", async () => {
		const { context, intent } = fixture();
		expect(
			await new PermissionKernel().authorize(
				intent("bash", { command: "node scripts/fetch.mjs https://other.example" }),
				context,
			),
		).toMatchObject({ action: "ask", code: "sandbox_profile_expansion_required" });
	});

	it("does not treat a safe command prefix as authorization for composed shell effects", async () => {
		const { context, intent } = fixture();
		expect(
			await new PermissionKernel().authorize(
				intent("bash", { command: "git status && curl -X POST https://example.test -d secret" }),
				context,
			),
		).toMatchObject({ action: "ask", code: "external_side_effect_confirmation_required" });
	});

	it("does not allow safe-command flags to escape the delegated workspace", async () => {
		const { context, intent, outside } = fixture();
		expect(
			await new PermissionKernel().authorize(
				intent("bash", { command: `npm run check --prefix ${outside}` }),
				context,
			),
		).toMatchObject({ action: "ask", code: "process_review_required" });
	});

	it("uses a stable permission fingerprint across execution identities", () => {
		const { agent, workspace } = fixture();
		const create = (operationId: string) =>
			normalizeToolIntent({
				operationId,
				taskId: agent.taskId,
				attemptId: "attempt-1",
				sessionId: "session-1",
				toolName: "bash",
				input: { command: "curl https://example.test" },
				workspaceRoot: workspace,
			});
		expect(permissionIntentSha256(create("operation-1"))).toBe(permissionIntentSha256(create("operation-2")));
	});

	it("uses the reviewer only for eligible ambiguous process commands", async () => {
		const { context, intent } = fixture();
		const review = vi.fn(async () => ({
			schemaVersion: 1 as const,
			verdict: "allow_once" as const,
			risk: "low" as const,
			effects: ["download public metadata"],
			reasonCode: "bounded_download",
			explanation: "The sandbox contains the operation.",
			confidence: 0.95,
			authorizationMatch: "none" as const,
			targetMatch: "exact" as const,
		}));
		const kernel = new PermissionKernel({ reviewer: { review } });
		const firstDecision = await kernel.authorize(
			intent("bash", { command: "node scripts/fetch-public-metadata.mjs" }),
			context,
		);
		expect(firstDecision).toMatchObject({ action: "allow", source: "reviewer" });
		expect(
			await kernel.authorize(intent("bash", { command: "node   scripts/fetch-public-metadata.mjs" }), context),
		).toMatchObject({ action: "allow", source: "reviewer" });
		expect(review).toHaveBeenCalledOnce();

		expect(await kernel.authorize(intent("bash", { command: "git push origin main" }), context)).toMatchObject({
			action: "ask",
			code: "external_side_effect_confirmation_required",
		});
		expect(review).toHaveBeenCalledOnce();
	});

	it("never reuses allow_once across operation ids", async () => {
		const { agent, context, workspace } = fixture();
		const review = vi.fn(async () => ({
			schemaVersion: 1 as const,
			verdict: "allow_once" as const,
			risk: "low" as const,
			effects: ["bounded process"],
			reasonCode: "bounded_process",
			explanation: "The sandbox contains the operation.",
			confidence: 0.95,
			authorizationMatch: "none" as const,
			targetMatch: "exact" as const,
		}));
		const kernel = new PermissionKernel({ reviewer: { review } });
		const create = (operationId: string) =>
			normalizeToolIntent({
				operationId,
				taskId: agent.taskId,
				attemptId: context.attemptId,
				sessionId: "session-1",
				toolName: "bash",
				input: { command: "node scripts/ambiguous.mjs" },
				workspaceRoot: workspace,
			});
		await kernel.authorize(create("operation-1"), context);
		await kernel.authorize(create("operation-2"), context);
		expect(review).toHaveBeenCalledTimes(2);
	});

	it.each(["partial", "conflict"] as const)(
		"does not accept reviewer output with %s authorization scope",
		async (authorizationMatch) => {
			const { context, intent } = fixture();
			const kernel = new PermissionKernel({
				reviewer: {
					review: async () => ({
						schemaVersion: 1,
						verdict: "allow_once",
						risk: "low",
						effects: ["bounded process"],
						reasonCode: "authorization_not_clear",
						explanation: "Authorization scope is not exact.",
						confidence: 0.99,
						authorizationMatch,
						targetMatch: "exact",
					}),
				},
			});
			expect(
				await kernel.authorize(intent("bash", { command: "node scripts/ambiguous.mjs" }), context),
			).toMatchObject({
				action: "ask",
			});
		},
	);

	it("consumes a cached reviewer allowance at ToolStarted", async () => {
		const { context, intent } = fixture();
		const review = vi.fn(async () => ({
			schemaVersion: 1 as const,
			verdict: "allow_once" as const,
			risk: "low" as const,
			effects: ["bounded process"],
			reasonCode: "bounded_process",
			explanation: "The sandbox contains the operation.",
			confidence: 0.99,
			authorizationMatch: "none" as const,
			targetMatch: "exact" as const,
		}));
		const onReviewCacheHit = vi.fn();
		const onReviewConsumed = vi.fn();
		const kernel = new PermissionKernel({ reviewer: { review }, onReviewCacheHit, onReviewConsumed });
		const operation = intent("bash", { command: "node scripts/ambiguous.mjs" });
		await kernel.authorize(operation, context);
		await kernel.authorize(operation, context);
		expect(review).toHaveBeenCalledOnce();
		expect(onReviewCacheHit).toHaveBeenCalledOnce();
		kernel.consumeReviewerAllowance(operation.operationId);
		expect(onReviewConsumed).toHaveBeenCalledWith(operation.operationId);
		await kernel.authorize(operation, context);
		expect(review).toHaveBeenCalledTimes(2);
	});

	it("coalesces identical reviews and serializes different operation keys", async () => {
		const { agent, context, workspace } = fixture();
		let active = 0;
		let maximumActive = 0;
		const review = vi.fn(async () => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			return {
				schemaVersion: 1 as const,
				verdict: "allow_once" as const,
				risk: "low" as const,
				effects: ["bounded process"],
				reasonCode: "bounded_process",
				explanation: "The sandbox contains the operation.",
				confidence: 0.99,
				authorizationMatch: "none" as const,
				targetMatch: "exact" as const,
			};
		});
		const kernel = new PermissionKernel({ reviewer: { review } });
		const create = (operationId: string) =>
			normalizeToolIntent({
				operationId,
				taskId: agent.taskId,
				attemptId: context.attemptId,
				sessionId: "session-1",
				toolName: "bash",
				input: { command: "node scripts/ambiguous.mjs" },
				workspaceRoot: workspace,
			});
		await Promise.all(Array.from({ length: 100 }, () => kernel.authorize(create("operation-shared"), context)));
		expect(review).toHaveBeenCalledOnce();
		await Promise.all([
			kernel.authorize(create("operation-1"), context),
			kernel.authorize(create("operation-2"), context),
		]);
		expect(review).toHaveBeenCalledTimes(3);
		expect(maximumActive).toBe(1);
	});
});
