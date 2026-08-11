import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
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
	it("stays alive without a client and accepts attach, prompt, and graceful stop", async () => {
		const directory = mkdtempSync(join(tmpdir(), "karissa-worker-host-"));
		temporaryDirectories.push(directory);
		const socketPath = join(directory, "worker.sock");
		const prompts: string[] = [];
		let disposed = false;
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
			async dispose() {
				disposed = true;
			},
		} as unknown as AgentSessionRuntime;
		const host = runResidentWorkerHost(runtime, {
			runDirectory: directory,
			token: "private-token",
			descriptor: {
				schemaVersion: 1,
				workerId: "worker-1",
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
		await host;
		expect(disposed).toBe(true);
		expect(existsSync(socketPath)).toBe(false);
	});

	it("bounds snapshot transcripts and retains the newest messages", async () => {
		const directory = mkdtempSync(join(tmpdir(), "karissa-worker-snapshot-"));
		temporaryDirectories.push(directory);
		const socketPath = join(directory, "worker.sock");
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
			async dispose() {},
		} as unknown as AgentSessionRuntime;
		const host = runResidentWorkerHost(runtime, {
			runDirectory: directory,
			token: "private-token",
			snapshotChunkBytes: 1_024,
			descriptor: {
				schemaVersion: 1,
				workerId: "worker-1",
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
