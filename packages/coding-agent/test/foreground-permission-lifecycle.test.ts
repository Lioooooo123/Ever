import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, fauxAssistantMessage, type Model } from "@lioooooo123/ever-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionLifecycleRef } from "../src/core/agent-session-lifecycle.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { ForegroundPermissionLifecycle } from "../src/core/foreground-permission-lifecycle.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(approval: "allow" | "deny") {
	const cwd = mkdtempSync(join(tmpdir(), "ever-foreground-permission-"));
	temporaryPaths.push(cwd);
	mkdirSync(join(cwd, "src"));
	const requestPermissionApproval = vi.fn(async () =>
		approval === "allow" ? ({ action: "allow", lifetime: "once" } as const) : ({ action: "deny" } as const),
	);
	const runtime = {
		cwd,
		session: { getActiveToolNames: () => ["read", "bash"], messages: [] },
		requestPermissionApproval,
	} as unknown as AgentSessionRuntime;
	return { cwd, lifecycle: new ForegroundPermissionLifecycle(runtime, () => false), requestPermissionApproval };
}

describe("ForegroundPermissionLifecycle", () => {
	it("automates an exact foreground action explicitly authorized by the user", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "ever-foreground-authorization-"));
		temporaryPaths.push(cwd);
		execFileSync("git", ["init", "--quiet"], { cwd });
		execFileSync("git", ["config", "user.email", "test@example.test"], { cwd });
		execFileSync("git", ["config", "user.name", "Ever Test"], { cwd });
		writeFileSync(join(cwd, "README.md"), "test\n");
		execFileSync("git", ["add", "README.md"], { cwd });
		execFileSync("git", ["commit", "--quiet", "-m", "test fixture"], { cwd });
		const userText = "push origin main";
		const reviewerModel: Model<Api> = {
			id: "small-reviewer",
			name: "Small Reviewer",
			api: "openai-completions",
			provider: "test",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8_000,
			maxTokens: 1_000,
		};
		const requestPermissionApproval = vi.fn();
		const runtime = {
			cwd,
			session: {
				getActiveToolNames: () => ["bash"],
				messages: [{ role: "user", content: userText, timestamp: Date.now() }],
				modelRuntime: {
					getAvailableSnapshot: () => [reviewerModel],
					getModel: () => reviewerModel,
					hasConfiguredAuth: () => true,
				},
				settingsManager: { getLongTaskSettings: () => ({ reviewerModel: undefined }) },
				completeLifecycleRequest: vi.fn(async () =>
					fauxAssistantMessage(
						JSON.stringify({
							schemaVersion: 1,
							candidates: [
								{
									action: "git_push",
									targets: { repository: "current", remote: "origin", branch: "main" },
									limits: { force: false },
									lifetime: "task",
									maxUses: 1,
									confidence: 0.99,
									evidenceSpans: [{ startByte: 0, endByte: Buffer.byteLength(userText) }],
								},
							],
						}),
					),
				),
			},
			requestPermissionApproval,
		} as unknown as AgentSessionRuntime;
		const lifecycle = new ForegroundPermissionLifecycle(runtime, () => false);
		expect(
			await lifecycle.handle({
				type: "before_tool",
				sessionId: "session-1",
				operationId: "operation-push",
				toolCallId: "tool-push",
				toolName: "bash",
				input: { command: "git push origin main" },
			}),
		).toBeUndefined();
		expect(requestPermissionApproval).not.toHaveBeenCalled();
	});

	it("awaits approval for ambiguous ordinary-Session process tools", async () => {
		const { lifecycle, requestPermissionApproval } = fixture("deny");
		const result = await lifecycle.handle({
			type: "before_tool",
			sessionId: "session-1",
			operationId: "operation-1",
			toolCallId: "tool-1",
			toolName: "bash",
			input: { command: "node scripts/do-work.mjs" },
		});
		expect(requestPermissionApproval).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ block: true, reason: "User denied this action" });
	});

	it("composes foreground and Task lifecycle owners in installation order", async () => {
		const calls: string[] = [];
		const lifecycleRef: AgentSessionLifecycleRef = {};
		const runtime = new AgentSessionRuntime(
			{} as never,
			{} as never,
			async () => {
				throw new Error("not used");
			},
			[],
			undefined,
			lifecycleRef,
		);
		const uninstallForeground = runtime.installLifecycle({
			handle: async () => {
				calls.push("foreground");
				return undefined;
			},
		});
		const uninstallTask = runtime.installLifecycle({
			handle: async () => {
				calls.push("task");
				return undefined;
			},
		});
		await lifecycleRef.current?.handle({ type: "before_turn", sessionId: "session-1", baseSystemPrompt: "base" });
		expect(calls).toEqual(["foreground", "task"]);
		uninstallTask();
		calls.length = 0;
		await lifecycleRef.current?.handle({ type: "before_turn", sessionId: "session-1", baseSystemPrompt: "base" });
		expect(calls).toEqual(["foreground"]);
		uninstallForeground();
		expect(lifecycleRef.current).toBeUndefined();
	});

	it("does not duplicate Task-owned permission decisions", async () => {
		const { cwd, requestPermissionApproval } = fixture("allow");
		const runtime = {
			cwd,
			session: { getActiveToolNames: () => ["bash"], messages: [] },
			requestPermissionApproval,
		} as unknown as AgentSessionRuntime;
		const lifecycle = new ForegroundPermissionLifecycle(runtime, () => true);
		expect(
			await lifecycle.handle({
				type: "before_tool",
				sessionId: "session-1",
				operationId: "operation-1",
				toolCallId: "tool-1",
				toolName: "bash",
				input: { command: "node scripts/do-work.mjs" },
			}),
		).toBeUndefined();
		expect(requestPermissionApproval).not.toHaveBeenCalled();
	});
});
