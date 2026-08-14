import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		session: { getActiveToolNames: () => ["read", "bash"] },
		requestPermissionApproval,
	} as unknown as AgentSessionRuntime;
	return { cwd, lifecycle: new ForegroundPermissionLifecycle(runtime, () => false), requestPermissionApproval };
}

describe("ForegroundPermissionLifecycle", () => {
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
			session: { getActiveToolNames: () => ["bash"] },
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
