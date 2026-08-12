import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerRegistry } from "../src/daemon/worker-registry.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("WorkerRegistry", () => {
	it("writes owner-only descriptors without the raw startup token", () => {
		const directory = mkdtempSync(join(tmpdir(), "karissa-worker-registry-"));
		temporaryDirectories.push(directory);
		const registry = new WorkerRegistry(directory);
		registry.write({
			schemaVersion: 1,
			workerId: "worker-1",
			executionId: "execution-1",
			agentId: "agent-1",
			taskId: "task-1",
			activeSessionId: "session-1",
			pid: 123,
			processGroupId: 123,
			supervisorGeneration: "generation-1",
			privateSocketPath: join(directory, "agent-1.sock"),
			tokenSha256: "hash-only",
			workspaceRoot: "/repo",
			lifecycle: "resident",
			state: "running",
			heartbeatAt: new Date(0).toISOString(),
			startedAt: new Date(0).toISOString(),
		});
		const path = join(directory, "workers", "agent-1.json");
		expect(statSync(join(directory, "workers")).mode & 0o777).toBe(0o700);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("token");
		expect(registry.list()).toMatchObject([{ workerId: "worker-1", tokenSha256: "hash-only" }]);
	});
});
