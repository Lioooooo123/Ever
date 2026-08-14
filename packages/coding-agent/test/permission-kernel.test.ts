import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord, PermissionGrantRecord } from "@lioooooo123/ever-long-tasks";
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
		expect(first.paths).toEqual([realpathSync(workspace)]);
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
});
