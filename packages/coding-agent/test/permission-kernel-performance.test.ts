import { performance } from "node:perf_hooks";
import type { AgentRecord } from "@lioooooo123/ever-long-tasks";
import { describe, expect, it, vi } from "vitest";
import { normalizeToolIntent, PermissionKernel } from "../src/core/permission-kernel.ts";

describe("PermissionKernel fixed-workload overhead", () => {
	it("keeps deterministic policy P95 below 5ms for 1000 intents", async () => {
		const workspace = process.cwd();
		const agent: AgentRecord = {
			id: "agent-performance",
			taskId: "task-performance",
			kind: "main",
			name: "main",
			role: "test",
			objective: "measure permission overhead",
			state: "running",
			depth: 0,
			workspaceMode: "primary",
			workspaceRoot: workspace,
			toolPolicy: {
				allowedTools: ["read"],
				allowedPaths: [workspace],
				readOnly: false,
				sandboxRequired: false,
			},
			budget: { maxTurns: 1, maxWallTimeMinutes: 1 },
			createdAt: "2026-08-14T00:00:00.000Z",
			updatedAt: "2026-08-14T00:00:00.000Z",
		};
		const kernel = new PermissionKernel();
		const durations: number[] = [];
		for (let index = 0; index < 1_000; index++) {
			const intent = normalizeToolIntent({
				operationId: `operation-${index}`,
				taskId: agent.taskId,
				attemptId: "attempt-performance",
				sessionId: "session-performance",
				toolName: "read",
				input: { path: "package.json" },
				workspaceRoot: workspace,
			});
			const started = performance.now();
			const decision = await kernel.authorize(intent, {
				agent,
				attemptId: "attempt-performance",
				workspaceFingerprint: "workspace-performance",
				sandboxProfileSha256: "a".repeat(64),
				sandboxAvailable: true,
				unattended: true,
			});
			const duration = performance.now() - started;
			expect(decision).toEqual({ action: "allow", source: "policy" });
			durations.push(duration);
		}
		durations.sort((left, right) => left - right);
		expect(durations[Math.floor(durations.length * 0.95)]).toBeLessThan(5);
	});

	it("keeps Reviewer cache-hit P95 below 10ms and coalesces one operation", async () => {
		const workspace = process.cwd();
		const agent: AgentRecord = {
			id: "agent-cache-performance",
			taskId: "task-cache-performance",
			kind: "main",
			name: "main",
			role: "test",
			objective: "measure Reviewer cache overhead",
			state: "running",
			depth: 0,
			workspaceMode: "primary",
			workspaceRoot: workspace,
			toolPolicy: {
				allowedTools: ["bash"],
				allowedPaths: [workspace],
				readOnly: false,
				sandboxRequired: true,
			},
			budget: { maxTurns: 1, maxWallTimeMinutes: 1 },
			createdAt: "2026-08-14T00:00:00.000Z",
			updatedAt: "2026-08-14T00:00:00.000Z",
		};
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
		const kernel = new PermissionKernel({ reviewer: { review } });
		const intent = normalizeToolIntent({
			operationId: "operation-cache-performance",
			taskId: agent.taskId,
			attemptId: "attempt-cache-performance",
			sessionId: "session-cache-performance",
			toolName: "bash",
			input: { command: "node scripts/ambiguous.mjs" },
			workspaceRoot: workspace,
		});
		const context = {
			agent,
			attemptId: "attempt-cache-performance",
			workspaceFingerprint: "workspace-cache-performance",
			sandboxProfileSha256: "a".repeat(64),
			sandboxAvailable: true,
			unattended: true,
		};
		await kernel.authorize(intent, context);
		const durations: number[] = [];
		for (let index = 0; index < 1_000; index++) {
			const started = performance.now();
			expect(await kernel.authorize(intent, context)).toMatchObject({ action: "allow", source: "reviewer" });
			durations.push(performance.now() - started);
		}
		durations.sort((left, right) => left - right);
		expect(review).toHaveBeenCalledOnce();
		expect(durations[Math.floor(durations.length * 0.95)]).toBeLessThan(10);
	});
});
