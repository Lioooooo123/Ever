import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionLifecycle } from "../src/core/agent-session-lifecycle.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createWorkerSocketPath, workerSocketDirectory } from "../src/core/worker-socket.ts";
import { requestWorker, runResidentWorkerHost } from "../src/daemon/worker-host.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function waitForPath(path: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (existsSync(path)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

describe("ResidentWorkerHost", () => {
	it("accepts steer after durable Session persistence and acknowledges it only after settlement", async () => {
		const directory = mkdtempSync(join(tmpdir(), "ever-worker-steer-settled-"));
		temporaryDirectories.push(directory, workerSocketDirectory(directory));
		const socketPath = createWorkerSocketPath(directory, "worker");
		const branch: Array<{ type: "message"; message: { role: "user"; content: string } }> = [];
		const listeners = new Set<(event: { type: string; message?: { role: string; content: string } }) => void>();
		let steered = "";
		let steerCalls = 0;
		let modelVisible = false;
		let acknowledged = false;
		let lifecycle: AgentSessionLifecycle | undefined;
		const runtime = {
			cwd: "/repo",
			session: {
				sessionId: "session-1",
				sessionFile: undefined,
				isStreaming: true,
				state: { messages: [] },
				sessionManager: { getBranch: () => branch },
				subscribe(listener: (event: { type: string; message?: { role: string; content: string } }) => void) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				async steer(text: string) {
					steerCalls++;
					steered = text;
				},
				async abort() {},
			},
			installLifecycle(value: AgentSessionLifecycle) {
				lifecycle = value;
				return () => {
					if (lifecycle === value) lifecycle = undefined;
				};
			},
			async dispose() {},
		} as unknown as AgentSessionRuntime;
		const host = runResidentWorkerHost(runtime, {
			runDirectory: directory,
			token: "private-token",
			onSteeringModelVisible: async (messageIds, receipt) => {
				expect(messageIds).toEqual(["message-1"]);
				expect(receipt).toEqual({ sessionId: "session-1", requestId: "request-1" });
				modelVisible = true;
			},
			onSteeringSettled: async (messageId) => {
				expect(messageId).toBe("message-1");
				acknowledged = true;
			},
			descriptor: {
				schemaVersion: 1,
				workerId: "worker-1",
				executionId: "execution-1",
				agentId: "agent-1",
				taskId: "task-1",
				activeSessionId: "",
				pid: process.pid,
				processGroupId: process.pid,
				supervisorGeneration: "generation-1",
				privateSocketPath: socketPath,
				tokenSha256: "hash",
				workspaceRoot: "/repo",
				lifecycle: "resident",
				state: "starting",
				heartbeatAt: new Date(0).toISOString(),
				startedAt: new Date(0).toISOString(),
			},
		});
		await waitForPath(socketPath);
		let resolved = false;
		const response = requestWorker(socketPath, {
			token: "private-token",
			command: "steer",
			payload: { text: "durable steering", messageId: "message-1" },
		}).then((value) => {
			resolved = true;
			return value;
		});
		const replay = requestWorker(socketPath, {
			token: "private-token",
			command: "steer",
			payload: { text: "durable steering", messageId: "message-1" },
		});
		for (let attempt = 0; attempt < 100 && steered === ""; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(steered).toContain('"messageId":"message-1"');
		expect(steerCalls).toBe(1);
		expect(resolved).toBe(false);
		for (const listener of listeners) listener({ type: "message_end", message: { role: "user", content: steered } });
		branch.push({ type: "message", message: { role: "user", content: steered } });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(resolved).toBe(false);
		await lifecycle?.handle({
			type: "before_request",
			sessionId: "session-1",
			requestId: "request-1",
			kind: "agent",
			model: {
				provider: "test",
				id: "faux",
				contextWindow: 1000,
				maxTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		});
		await expect(response).resolves.toMatchObject({ ok: true, durable: true, providerVisible: true });
		await expect(replay).resolves.toMatchObject({ ok: true, durable: true, providerVisible: true });
		expect(modelVisible).toBe(true);
		expect(acknowledged).toBe(false);
		await lifecycle?.handle({ type: "settled", sessionId: "session-1" });
		for (let attempt = 0; attempt < 100 && !acknowledged; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(acknowledged).toBe(true);
		const cancelledSteer = requestWorker(socketPath, {
			token: "private-token",
			command: "steer",
			payload: { text: "cancel this steering", messageId: "message-2" },
		});
		for (let attempt = 0; attempt < 100 && !steered.includes("message-2"); attempt++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		const stopped = requestWorker(socketPath, { token: "private-token", command: "stop" });
		await expect(cancelledSteer).resolves.toMatchObject({ ok: false });
		await expect(stopped).resolves.toEqual({ ok: true });
		await host;
	});

	it("settles steering before terminal shutdown and waits for Session abort", async () => {
		const directory = mkdtempSync(join(tmpdir(), "ever-worker-terminal-steer-"));
		temporaryDirectories.push(directory, workerSocketDirectory(directory));
		const socketPath = createWorkerSocketPath(directory, "worker");
		const branch: Array<{ type: "message"; message: { role: "user"; content: string } }> = [];
		let lifecycle: AgentSessionLifecycle | undefined;
		let steered = "";
		let settled = false;
		let abortStarted = false;
		let finishAbort: () => void = () => {};
		const abortFinished = new Promise<void>((resolve) => {
			finishAbort = resolve;
		});
		let signalTerminal: () => void = () => {};
		const dispatchTerminal = new Promise<void>((resolve) => {
			signalTerminal = resolve;
		});
		const runtime = {
			cwd: "/repo",
			session: {
				sessionId: "session-terminal",
				sessionFile: undefined,
				isStreaming: true,
				state: { messages: [] },
				sessionManager: { getBranch: () => branch },
				subscribe() {
					return () => {};
				},
				async steer(text: string) {
					steered = text;
					branch.push({ type: "message", message: { role: "user", content: text } });
				},
				async abort() {
					abortStarted = true;
					await abortFinished;
				},
			},
			installLifecycle(value: AgentSessionLifecycle) {
				lifecycle = value;
				return () => {
					if (lifecycle === value) lifecycle = undefined;
				};
			},
			async dispose() {},
		} as unknown as AgentSessionRuntime;
		const host = runResidentWorkerHost(runtime, {
			runDirectory: directory,
			token: "private-token",
			dispatchTerminal,
			onSteeringSettled: async () => {
				settled = true;
			},
			descriptor: {
				schemaVersion: 1,
				workerId: "worker-terminal",
				executionId: "execution-terminal",
				agentId: "agent-terminal",
				taskId: "task-terminal",
				activeSessionId: "",
				pid: process.pid,
				processGroupId: process.pid,
				supervisorGeneration: "generation-terminal",
				privateSocketPath: socketPath,
				tokenSha256: "hash",
				workspaceRoot: "/repo",
				lifecycle: "resident",
				state: "starting",
				heartbeatAt: new Date(0).toISOString(),
				startedAt: new Date(0).toISOString(),
			},
		});
		await waitForPath(socketPath);
		const response = requestWorker(socketPath, {
			token: "private-token",
			command: "steer",
			payload: { text: "terminal steering", messageId: "message-terminal" },
		});
		for (let attempt = 0; attempt < 100 && steered === ""; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		await lifecycle?.handle({
			type: "before_request",
			sessionId: "session-terminal",
			requestId: "request-terminal",
			kind: "agent",
			model: {
				provider: "test",
				id: "faux",
				contextWindow: 1000,
				maxTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		});
		await expect(response).resolves.toMatchObject({ ok: true, providerVisible: true });

		signalTerminal();
		await Promise.resolve();
		await lifecycle?.handle({ type: "settled", sessionId: "session-terminal" });
		for (let attempt = 0; attempt < 100 && !settled; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(settled).toBe(true);
		for (let attempt = 0; attempt < 100 && !abortStarted; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(abortStarted).toBe(true);
		let hostFinished = false;
		void host.then(() => {
			hostFinished = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(hostFinished).toBe(false);
		finishAbort();
		await host;
	});

	it("stays alive without a client and accepts attach, prompt, and graceful stop", async () => {
		const directory = mkdtempSync(join(tmpdir(), "ever-worker-host-"));
		temporaryDirectories.push(directory, workerSocketDirectory(directory));
		const socketPath = createWorkerSocketPath(directory, "worker");
		const prompts: string[] = [];
		let disposed = false;
		let taskRuntimeDrained = false;
		const runtime = {
			cwd: "/repo",
			session: {
				sessionId: "session-1",
				sessionFile: undefined,
				isStreaming: false,
				state: { messages: [] },
				subscribe() {
					return () => {};
				},
				async prompt(text: string, options?: { preflightResult?: (accepted: boolean) => void }) {
					prompts.push(text);
					options?.preflightResult?.(true);
				},
				async steer(text: string) {
					prompts.push(`steer:${text}`);
				},
				async abort() {},
			},
			installLifecycle() {
				return () => {};
			},
			async dispose() {
				disposed = true;
			},
		} as unknown as AgentSessionRuntime;
		const host = runResidentWorkerHost(runtime, {
			runDirectory: directory,
			token: "private-token",
			onBeforeStop: async () => {
				taskRuntimeDrained = true;
			},
			descriptor: {
				schemaVersion: 1,
				workerId: "worker-1",
				executionId: "execution-1",
				agentId: "agent-1",
				taskId: "task-1",
				activeSessionId: "",
				pid: process.pid,
				processGroupId: process.pid,
				supervisorGeneration: "generation-1",
				privateSocketPath: socketPath,
				tokenSha256: "hash",
				workspaceRoot: "/repo",
				lifecycle: "resident",
				state: "starting",
				heartbeatAt: new Date(0).toISOString(),
				startedAt: new Date(0).toISOString(),
			},
		});
		await waitForPath(socketPath);
		expect(await requestWorker(socketPath, { token: "private-token", command: "attach" })).toMatchObject({
			ok: true,
			replayStatus: "snapshot_required",
		});
		expect(
			await requestWorker(socketPath, {
				token: "private-token",
				command: "prompt",
				payload: { text: "continue safely" },
			}),
		).toMatchObject({ ok: true, accepted: true });
		expect(prompts).toEqual(["continue safely"]);
		expect(
			await requestWorker(socketPath, {
				token: "private-token",
				command: "adopt",
				payload: { supervisorGeneration: "generation-2", newToken: "replacement-token-with-at-least-32-bytes" },
			}),
		).toMatchObject({ ok: true, descriptor: { supervisorGeneration: "generation-2" } });
		expect(await requestWorker(socketPath, { token: "private-token", command: "status" })).toMatchObject({
			ok: false,
			message: "Worker authentication failed",
		});
		expect(
			await requestWorker(socketPath, {
				token: "replacement-token-with-at-least-32-bytes",
				command: "stop",
			}),
		).toEqual({ ok: true });
		expect(taskRuntimeDrained).toBe(true);
		await host;
		expect(disposed).toBe(true);
		expect(existsSync(socketPath)).toBe(false);
	});

	it("bounds snapshot transcripts and retains the newest messages", async () => {
		const directory = mkdtempSync(join(tmpdir(), "ever-worker-snapshot-"));
		temporaryDirectories.push(directory, workerSocketDirectory(directory));
		const socketPath = createWorkerSocketPath(directory, "worker");
		const runtime = {
			cwd: "/repo",
			session: {
				sessionId: "session-1",
				sessionFile: undefined,
				isStreaming: false,
				state: {
					messages: [
						{ role: "user", content: `old-${"a".repeat(700)}` },
						{ role: "assistant", content: `new-${"b".repeat(700)}` },
					],
				},
				subscribe() {
					return () => {};
				},
				async abort() {},
			},
			installLifecycle() {
				return () => {};
			},
			async dispose() {},
		} as unknown as AgentSessionRuntime;
		const host = runResidentWorkerHost(runtime, {
			runDirectory: directory,
			token: "private-token",
			snapshotChunkBytes: 1_024,
			descriptor: {
				schemaVersion: 1,
				workerId: "worker-1",
				executionId: "execution-1",
				agentId: "agent-1",
				taskId: "task-1",
				activeSessionId: "",
				pid: process.pid,
				processGroupId: process.pid,
				supervisorGeneration: "generation-1",
				privateSocketPath: socketPath,
				tokenSha256: "hash",
				workspaceRoot: "/repo",
				lifecycle: "resident",
				state: "starting",
				heartbeatAt: new Date(0).toISOString(),
				startedAt: new Date(0).toISOString(),
			},
		});
		await waitForPath(socketPath);
		const response = await requestWorker(socketPath, { token: "private-token", command: "attach" });
		expect(response).toMatchObject({
			snapshot: {
				transcriptTruncated: true,
				transcriptMessageCount: 2,
				transcriptView: [{ role: "assistant" }],
			},
		});
		expect(Buffer.byteLength(JSON.stringify(response.snapshot))).toBeLessThan(2_048);
		await requestWorker(socketPath, { token: "private-token", command: "stop" });
		await host;
	});
});
