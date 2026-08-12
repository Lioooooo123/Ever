import { describe, expect, it } from "vitest";
import { deriveWorkerToken, workerTokenSha256 } from "../src/daemon/supervisor-credentials.ts";
import { adoptResidentWorkers } from "../src/daemon/supervisor-takeover.ts";
import type { WorkerDescriptor } from "../src/daemon/worker-registry.ts";

function descriptor(token: string): WorkerDescriptor {
	return {
		schemaVersion: 1,
		workerId: "worker-1",
		executionId: "execution-1",
		agentId: "agent-1",
		taskId: "task-1",
		activeSessionId: "session-1",
		pid: 123,
		processGroupId: 123,
		supervisorGeneration: "old-generation",
		privateSocketPath: "/tmp/worker.sock",
		tokenSha256: workerTokenSha256(token),
		workspaceRoot: "/repo",
		lifecycle: "resident",
		state: "running",
		heartbeatAt: new Date(0).toISOString(),
		startedAt: new Date(0).toISOString(),
	};
}

describe("Supervisor takeover", () => {
	it("adopts only after the old generation capability succeeds and rotates it", async () => {
		const controlToken = "owner-secret";
		const oldToken = deriveWorkerToken(controlToken, "worker-1", "old-generation");
		let receivedToken = "";
		let replacementToken = "";
		const workers = await adoptResidentWorkers({
			descriptors: [descriptor(oldToken)],
			controlToken,
			supervisorGeneration: "new-generation",
			isProcessAlive: () => true,
			request: async (_socketPath, request) => {
				receivedToken = request.token;
				replacementToken = String(request.payload?.newToken);
				return {
					ok: true,
					descriptor: {
						...descriptor(replacementToken),
						supervisorGeneration: "new-generation",
						tokenSha256: workerTokenSha256(replacementToken),
					},
				};
			},
		});
		expect(receivedToken).toBe(oldToken);
		expect(replacementToken).toBe(deriveWorkerToken(controlToken, "worker-1", "new-generation"));
		expect(workers).toHaveLength(1);
	});

	it("refuses dead or descriptor-tampered Workers", async () => {
		const workers = await adoptResidentWorkers({
			descriptors: [descriptor("wrong-token")],
			controlToken: "owner-secret",
			supervisorGeneration: "new-generation",
			isProcessAlive: () => true,
			request: async () => ({ ok: true }),
		});
		expect(workers).toEqual([]);
	});
});
