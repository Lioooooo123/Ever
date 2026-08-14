import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@lioooooo123/ever-ai";
import {
	DEFAULT_CONTINUATION_POLICY,
	type RuntimeSnapshot,
	SqliteTaskStore,
	TaskController,
	VerifiedCompletion,
} from "@lioooooo123/ever-long-tasks";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionLifecycle, AgentSessionLifecycleEvent } from "../src/core/agent-session-lifecycle.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import {
	attachLongTaskRuntime,
	waitForEvalEffectRelease,
	waitForLongTaskDispatchTerminal,
} from "../src/core/long-task-runtime.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function createRuntimeAdapter(workspaceRoot: string, sessionId: string) {
	let lifecycle: AgentSessionLifecycle | undefined;
	let idle = true;
	const prompts: string[] = [];
	const messages: Array<ReturnType<typeof fauxAssistantMessage>> = [];
	return {
		cwd: workspaceRoot,
		session: {
			sessionId,
			state: { messages },
			model: {
				provider: "test",
				id: "faux",
				contextWindow: 1000,
				maxTokens: 100,
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			},
			thinkingLevel: "medium",
			systemPrompt: "test system prompt",
			getActiveToolNames: () => ["read"],
			abort: async () => {},
			get isIdle() {
				return idle;
			},
			prompt: async (prompt: string) => {
				prompts.push(prompt);
			},
		},
		prompts,
		messages,
		setIdle(value: boolean) {
			idle = value;
		},
		restoreCheckpoint: async () => {},
		createCheckpoint: async () => ({
			sessionId,
			settledTurnIndex: 1,
			runtimeSnapshotSha256: "runtime",
			createdAt: new Date().toISOString(),
		}),
		createPreCompactionCheckpoint: async () => ({
			sessionId,
			settledTurnIndex: 1,
			runtimeSnapshotSha256: "runtime",
			createdAt: new Date().toISOString(),
		}),
		installLifecycle(value: AgentSessionLifecycle) {
			lifecycle = value;
			return () => {
				if (lifecycle === value) lifecycle = undefined;
			};
		},
		async emit(event: AgentSessionLifecycleEvent) {
			if (!lifecycle) throw new Error("Native lifecycle did not become ready");
			return lifecycle.handle(event);
		},
	};
}

describe("NativeLongTaskAgent", () => {
	it("terminates the resident runtime when lease renewal fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "ever-native-lease-failure-"));
		temporaryPaths.push(root);
		const agentDir = join(root, "agent");
		const workspaceRoot = join(root, "workspace");
		mkdirSync(workspaceRoot);
		const store = SqliteTaskStore.open({
			databasePath: join(agentDir, "long-tasks.sqlite"),
			artifactsRoot: join(agentDir, "tasks"),
		});
		const controller = new TaskController(store);
		const task = controller.create({
			title: "lease failure",
			goal: "stop the worker",
			acceptance: [],
			budget: { maxTurns: 5, maxWallTimeMinutes: 60 },
			workspaceRoot,
			workspaceFingerprint: "fingerprint",
		});
		controller.submit(task.id);
		const agent = store.listAgents(task.id)[0]!;
		store.close();
		const previousHeartbeat = process.env.EVER_WORKER_HEARTBEAT_SECONDS;
		const renewLease = SqliteTaskStore.prototype.renewLease;
		process.env.EVER_WORKER_HEARTBEAT_SECONDS = "0.01";
		try {
			const runtime = createRuntimeAdapter(workspaceRoot, "lease-session");
			const running = await attachLongTaskRuntime(
				runtime as unknown as AgentSessionRuntime,
				agentDir,
				task.id,
				agent.id,
				false,
				DEFAULT_CONTINUATION_POLICY,
			);
			SqliteTaskStore.prototype.renewLease = () => {
				throw new Error("lease renewal failed");
			};
			await expect(
				waitForLongTaskDispatchTerminal(runtime as unknown as AgentSessionRuntime),
			).resolves.toBeUndefined();
			await expect(running.drainAndClose()).rejects.toThrow("lease renewal failed");
		} finally {
			SqliteTaskStore.prototype.renewLease = renewLease;
			if (previousHeartbeat === undefined) delete process.env.EVER_WORKER_HEARTBEAT_SECONDS;
			else process.env.EVER_WORKER_HEARTBEAT_SECONDS = previousHeartbeat;
		}
	});

	it("does not finalize a subagent from a pre-compaction checkpoint", async () => {
		const root = mkdtempSync(join(tmpdir(), "ever-native-subagent-recovery-"));
		temporaryPaths.push(root);
		const agentDir = join(root, "agent");
		const workspaceRoot = join(root, "workspace");
		mkdirSync(workspaceRoot);
		const databasePath = join(agentDir, "long-tasks.sqlite");
		const store = SqliteTaskStore.open({ databasePath, artifactsRoot: join(agentDir, "tasks") });
		const controller = new TaskController(store);
		const task = controller.create({
			title: "recover compacting subagent",
			goal: "continue after checkpoint crash",
			acceptance: [],
			budget: { maxTurns: 5, maxWallTimeMinutes: 60 },
			workspaceRoot,
			workspaceFingerprint: "fingerprint",
		});
		const main = store.listAgents(task.id)[0]!;
		const delegated = store.createDelegation({
			actor: main,
			operationKey: "recover-compacting-worker",
			name: "recoverer",
			role: "worker",
			objective: "continue after compaction",
			acceptance: [],
			paths: [workspaceRoot],
			allowedTools: [],
			workspaceMode: "read_only_shared",
			budget: { maxTurns: 5, maxWallTimeMinutes: 10 },
			required: true,
		});
		controller.submit(task.id);
		const snapshot: RuntimeSnapshot = {
			everVersion: "test",
			upstreamCommit: "test",
			protocolVersion: 1,
			model: { provider: "test", id: "faux", thinkingLevel: "medium" },
			systemPromptSha256: "prompt",
			contextFiles: [],
			resources: [],
			toolPolicySha256: "tools",
			sandboxPolicySha256: "sandbox",
		};
		const runtimeHash = "a".repeat(64);
		const claim = store.claimAttempt({
			agentId: delegated.agentId,
			sessionId: "recovered-session",
			runtimeSnapshot: snapshot,
			runtimeSnapshotSha256: runtimeHash,
			workerId: "crashed-worker",
			executionId: "crashed-execution",
		});
		const context = store.resolveAttemptClaim(claim);
		store.commitCheckpoint({
			taskId: task.id,
			agentId: delegated.agentId,
			attemptId: context.attempt.id,
			lease: context.lease,
			sessionCheckpoint: {
				sessionId: "recovered-session",
				settledTurnIndex: 1,
				runtimeSnapshotSha256: runtimeHash,
				createdAt: new Date().toISOString(),
			},
			progress: {
				summary: "compaction checkpoint persisted",
				completedItems: [],
				nextActions: [],
				blockers: [],
				filesRead: [],
				filesModified: [],
				verification: [],
				consumedMessageIds: [],
				outboundMessageIds: [],
			},
			evidence: [],
			workspaceSnapshot: {},
		});
		store.releaseLease(context.lease);
		store.transitionAgent(delegated.agentId, "queued", "crash_recovery");
		store.close();

		const runtime = createRuntimeAdapter(workspaceRoot, "recovered-session");
		runtime.messages.push({ ...fauxAssistantMessage("call a tool next"), stopReason: "toolUse" });
		const running = await attachLongTaskRuntime(
			runtime as unknown as AgentSessionRuntime,
			agentDir,
			task.id,
			delegated.agentId,
			true,
			DEFAULT_CONTINUATION_POLICY,
		);
		let terminal = false;
		void waitForLongTaskDispatchTerminal(runtime as unknown as AgentSessionRuntime)?.then(() => {
			terminal = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(terminal).toBe(false);
		await running.drainAndClose();
		const inspection = SqliteTaskStore.open({ databasePath });
		const dispatch = inspection.listAgentDispatches(delegated.agentId)[0]!;
		expect(dispatch.state).toBe("running");
		expect(inspection.listEpisodes({ taskId: task.id, agentId: delegated.agentId })).toEqual([]);
		inspection.close();
	});

	it("turns an unreported settled subagent response into a Dispatch-bound raw Episode", async () => {
		const root = mkdtempSync(join(tmpdir(), "ever-native-subagent-settled-"));
		temporaryPaths.push(root);
		const agentDir = join(root, "agent");
		const workspaceRoot = join(root, "workspace");
		mkdirSync(workspaceRoot);
		const databasePath = join(agentDir, "long-tasks.sqlite");
		const store = SqliteTaskStore.open({ databasePath, artifactsRoot: join(agentDir, "tasks") });
		const controller = new TaskController(store);
		const task = controller.create({
			title: "settled subagent",
			goal: "retain a raw response",
			acceptance: [],
			budget: { maxTurns: 5, maxWallTimeMinutes: 60 },
			workspaceRoot,
			workspaceFingerprint: "fingerprint",
			toolPolicy: {
				allowedTools: ["read", "agent_report"],
				allowedPaths: [workspaceRoot],
				readOnly: false,
				sandboxRequired: false,
			},
		});
		const main = store.listAgents(task.id)[0]!;
		const delegated = store.createDelegation({
			actor: main,
			operationKey: "delegate-review",
			name: "reviewer",
			role: "reviewer",
			objective: "review the result",
			acceptance: [{ id: "review", kind: "manual", description: "review supplied" }],
			paths: [workspaceRoot],
			allowedTools: ["read", "agent_report"],
			workspaceMode: "read_only_shared",
			budget: { maxTurns: 5, maxWallTimeMinutes: 10 },
			required: true,
		});
		controller.submit(task.id);
		const agent = store.requireAgent(delegated.agentId);
		const dispatch = store.getRunnableAgentDispatch(agent.id)!;
		store.close();

		const runtimeAdapter = createRuntimeAdapter(workspaceRoot, "session-subagent");
		const running = await attachLongTaskRuntime(
			runtimeAdapter as unknown as AgentSessionRuntime,
			agentDir,
			task.id,
			agent.id,
			false,
			DEFAULT_CONTINUATION_POLICY,
		);
		const terminalDispatch = waitForLongTaskDispatchTerminal(runtimeAdapter as unknown as AgentSessionRuntime)!;
		const message = fauxAssistantMessage("review found one actionable issue");
		await runtimeAdapter.emit({
			type: "before_request",
			sessionId: "session-subagent",
			requestId: "request-subagent",
			kind: "agent",
			model: runtimeAdapter.session.model,
		});
		await runtimeAdapter.emit({
			type: "after_response",
			sessionId: "session-subagent",
			requestId: "request-subagent",
			kind: "agent",
			message,
			usage: message.usage,
		});
		await runtimeAdapter.emit({ type: "settled", sessionId: "session-subagent" });
		await expect(terminalDispatch).resolves.toBeUndefined();
		await running.drainAndClose();

		const inspectionStore = SqliteTaskStore.open({ databasePath });
		const episode = inspectionStore.listEpisodes({ taskId: task.id, agentId: agent.id }).at(-1)!;
		expect(inspectionStore.requireAgentDispatch(dispatch.id).state).toBe("completed_unaccepted");
		expect(inspectionStore.getLatestCheckpoint(agent.id, dispatch.id)).toBeUndefined();
		expect(episode).toMatchObject({
			dispatchId: dispatch.id,
			status: "completed_unaccepted",
			summary: "review found one actionable issue",
		});
		expect(episode.originalResponseArtifactRef).toBeTruthy();
		expect(JSON.parse(readFileSync(episode.originalResponseArtifactRef!, "utf8"))).toMatchObject({
			schemaVersion: 1,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "review found one actionable issue" }],
			},
		});
		const secondDispatch = inspectionStore.createAgentDispatch({
			actor: inspectionStore.listAgents(task.id).find((candidate) => candidate.kind === "main")!,
			agentId: agent.id,
			operationKey: "retry-after-truncated-response",
			action: "retry the review",
		}).dispatch;
		inspectionStore.close();

		const retryRuntime = createRuntimeAdapter(workspaceRoot, "session-subagent-retry");
		const retryRunning = await attachLongTaskRuntime(
			retryRuntime as unknown as AgentSessionRuntime,
			agentDir,
			task.id,
			agent.id,
			false,
			DEFAULT_CONTINUATION_POLICY,
		);
		await retryRuntime.emit({
			type: "before_request",
			sessionId: "session-subagent-retry",
			requestId: "request-subagent-retry",
			kind: "agent",
			model: retryRuntime.session.model,
		});
		const failedMessage = {
			...fauxAssistantMessage(""),
			content: [],
			stopReason: "length" as const,
		};
		await retryRuntime.emit({
			type: "after_response",
			sessionId: "session-subagent-retry",
			requestId: "request-subagent-retry",
			kind: "agent",
			message: failedMessage,
			usage: failedMessage.usage,
		});
		await retryRuntime.emit({ type: "settled", sessionId: "session-subagent-retry" });
		await retryRunning.drainAndClose();
		const retryInspection = SqliteTaskStore.open({ databasePath });
		expect(retryInspection.requireAgentDispatch(secondDispatch.id).state).toBe("failed");
		expect(retryInspection.listEpisodes({ taskId: task.id, agentId: agent.id }).at(-1)).toMatchObject({
			dispatchId: secondDispatch.id,
			status: "failed",
			summary: "Subagent did not complete cleanly (length).",
			blockers: ["Subagent did not complete cleanly (length)."],
		});
		retryInspection.close();
	});

	it("journals Provider and tool boundaries through the awaited lifecycle", async () => {
		const root = mkdtempSync(join(tmpdir(), "ever-native-agent-"));
		temporaryPaths.push(root);
		const agentDir = join(root, "agent");
		const workspaceRoot = join(root, "workspace");
		mkdirSync(workspaceRoot);
		const databasePath = join(agentDir, "long-tasks.sqlite");
		const store = SqliteTaskStore.open({ databasePath, artifactsRoot: join(agentDir, "tasks") });
		const controller = new TaskController(store);
		const task = controller.create({
			title: "native lifecycle",
			goal: "persist external boundaries",
			acceptance: [],
			budget: { maxTurns: 5, maxWallTimeMinutes: 60 },
			workspaceRoot,
			workspaceFingerprint: "fingerprint",
		});
		controller.submit(task.id);
		const agent = store.listAgents(task.id)[0]!;
		store.close();
		const runtimeAdapter = createRuntimeAdapter(workspaceRoot, "session-1");
		const runtime = runtimeAdapter as unknown as AgentSessionRuntime;
		const running = await attachLongTaskRuntime(
			runtime,
			agentDir,
			task.id,
			agent.id,
			false,
			DEFAULT_CONTINUATION_POLICY,
		);
		const model = {
			provider: "test",
			id: "faux",
			contextWindow: 1000,
			maxTokens: 100,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		};
		await runtimeAdapter.emit({
			type: "before_request",
			sessionId: "session-1",
			requestId: "request-1",
			kind: "agent",
			model,
		});
		const message = fauxAssistantMessage("done");
		await runtimeAdapter.emit({
			type: "after_response",
			sessionId: "session-1",
			requestId: "request-1",
			kind: "agent",
			message,
			usage: message.usage,
		});
		await runtimeAdapter.emit({
			type: "before_tool",
			sessionId: "session-1",
			operationId: "operation-1",
			toolCallId: "tool-1",
			toolName: "write",
			input: { path: "result.txt" },
		});
		await runtimeAdapter.emit({
			type: "after_tool",
			sessionId: "session-1",
			operationId: "operation-1",
			toolCallId: "tool-1",
			toolName: "write",
			input: { path: "result.txt" },
			isError: false,
			resultSummary: "written",
		});
		await runtimeAdapter.emit({ type: "settled", sessionId: "session-1" });
		await expect(running.drainAndClose()).resolves.toMatchObject({ kind: "settled", taskId: task.id });
		const inspectionStore = SqliteTaskStore.open({ databasePath });
		const types = inspectionStore.listEvents(task.id).map((event) => event.type);
		expect(types.indexOf("ProviderRequestStarted")).toBeLessThan(types.indexOf("ProviderRequestFinished"));
		expect(types.indexOf("ToolStarted")).toBeLessThan(types.indexOf("ToolFinished"));
		expect(types.indexOf("ToolFinished")).toBeLessThan(types.indexOf("CheckpointCreated"));
		expect(inspectionStore.requireTask(task.id).totalTurns).toBe(1);
		inspectionStore.close();
	});

	it("defers automatic continuation when user work already occupies the Session", async () => {
		const root = mkdtempSync(join(tmpdir(), "ever-native-agent-user-priority-"));
		temporaryPaths.push(root);
		const agentDir = join(root, "agent");
		const workspaceRoot = join(root, "workspace");
		mkdirSync(workspaceRoot);
		const databasePath = join(agentDir, "long-tasks.sqlite");
		const store = SqliteTaskStore.open({ databasePath, artifactsRoot: join(agentDir, "tasks") });
		const controller = new TaskController(store);
		const task = controller.create({
			title: "user priority",
			goal: "continue only while idle",
			acceptance: [],
			budget: { maxTurns: 5, maxWallTimeMinutes: 60 },
			workspaceRoot,
			workspaceFingerprint: "fingerprint",
		});
		controller.submit(task.id);
		const agent = store.listAgents(task.id)[0]!;
		store.close();
		const runtimeAdapter = createRuntimeAdapter(workspaceRoot, "session-user-priority");
		const running = await attachLongTaskRuntime(
			runtimeAdapter as unknown as AgentSessionRuntime,
			agentDir,
			task.id,
			agent.id,
			true,
			DEFAULT_CONTINUATION_POLICY,
		);
		runtimeAdapter.setIdle(false);
		await runtimeAdapter.emit({ type: "settled", sessionId: "session-user-priority" });
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(runtimeAdapter.prompts).toEqual([]);
		const inspectionStore = SqliteTaskStore.open({ databasePath });
		expect(inspectionStore.listEvents(task.id).map((event) => event.type)).toContain("ContinuationPromptDeferred");
		inspectionStore.close();
		await running.drainAndClose();
	});

	it("authenticates an fd3-style Eval gate and binds it to the selected domain path", async () => {
		const root = mkdtempSync(join(tmpdir(), "ever-native-gate-"));
		temporaryPaths.push(root);
		const gateDirectory = join(root, "gate");
		const workspaceRoot = join(root, "workspace");
		const targetPath = join(workspaceRoot, "result.txt");
		const secret = "b".repeat(64);
		mkdirSync(workspaceRoot);
		writeFileSync(targetPath, "durable domain evidence\n");
		const event: Extract<AgentSessionLifecycleEvent, { type: "after_tool" }> = {
			type: "after_tool",
			sessionId: "session-1",
			operationId: "operation-1",
			toolCallId: "tool-1",
			toolName: "write",
			input: { path: "result.txt" },
			isError: false,
			resultSummary: "written",
		};
		const waiting = waitForEvalEffectRelease(
			event,
			"reconcilable_write",
			workspaceRoot,
			new AbortController().signal,
			{
				directory: gateDirectory,
				effect: "reconcilable_write",
				secret,
				domainCommitId: "source:result.txt",
				evidencePath: targetPath,
				targetPath,
			},
		);
		const gateEvents = join(gateDirectory, "events.jsonl");
		for (let attempt = 0; attempt < 100 && !existsSync(gateEvents); attempt += 1)
			await new Promise((resolve) => setTimeout(resolve, 5));
		const gateEvent = JSON.parse(readFileSync(gateEvents, "utf8")) as Record<string, unknown>;
		expect(gateEvent).toMatchObject({
			type: "EffectCommitted",
			operationId: "operation-1",
			toolCallId: "tool-1",
			effect: "reconcilable_write",
			targetPath,
			domainCommitId: "source:result.txt",
			evidencePath: targetPath,
			evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(gateEvent.mac).toMatch(/^[a-f0-9]{64}$/);
		const releaseDigest = createHmac("sha256", secret).update("operation-1").digest("hex");
		writeFileSync(join(gateDirectory, `release-${releaseDigest}`), "");
		await waiting;
	});

	it("completes through a faux Provider boundary and emits a verified change bundle", async () => {
		const root = mkdtempSync(join(tmpdir(), "ever-native-agent-complete-"));
		temporaryPaths.push(root);
		const agentDir = join(root, "agent");
		const workspaceRoot = join(root, "workspace");
		mkdirSync(workspaceRoot);
		execFileSync("git", ["init"], { cwd: workspaceRoot });
		execFileSync("git", ["config", "user.name", "Ever Test"], { cwd: workspaceRoot });
		execFileSync("git", ["config", "user.email", "ever@example.invalid"], { cwd: workspaceRoot });
		writeFileSync(join(workspaceRoot, "result.txt"), "before\n");
		execFileSync("git", ["add", "result.txt"], { cwd: workspaceRoot });
		execFileSync("git", ["commit", "-m", "base"], { cwd: workspaceRoot });
		const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot, encoding: "utf8" }).trim();
		const databasePath = join(agentDir, "long-tasks.sqlite");
		const store = SqliteTaskStore.open({ databasePath, artifactsRoot: join(agentDir, "tasks") });
		const controller = new TaskController(store);
		const task = controller.create({
			title: "verified completion",
			goal: "finish with durable proof",
			acceptance: [{ id: "verification", kind: "command", command: "true", cwd: ".", timeoutSeconds: 5 }],
			budget: { maxTurns: 5, maxWallTimeMinutes: 60 },
			workspaceRoot,
			workspaceFingerprint: "fingerprint",
			initialGitHead: baseCommit,
		});
		controller.submit(task.id);
		expect(
			new VerifiedCompletion(store).request({
				taskId: task.id,
				requestId: "completion-tool-call",
				summary: "done",
				evidence: [],
			}),
		).toMatchObject({ accepted: true });
		const agent = store.listAgents(task.id)[0]!;
		store.close();
		writeFileSync(join(workspaceRoot, "result.txt"), "after\n");

		const runtimeAdapter = createRuntimeAdapter(workspaceRoot, "session-complete");
		const runtime = runtimeAdapter as unknown as AgentSessionRuntime;
		const running = await attachLongTaskRuntime(
			runtime,
			agentDir,
			task.id,
			agent.id,
			false,
			DEFAULT_CONTINUATION_POLICY,
		);
		const model = runtimeAdapter.session.model;
		await runtimeAdapter.emit({
			type: "before_request",
			sessionId: "session-complete",
			requestId: "request-complete",
			kind: "agent",
			model,
		});
		const message = fauxAssistantMessage("verified");
		await runtimeAdapter.emit({
			type: "after_response",
			sessionId: "session-complete",
			requestId: "request-complete",
			kind: "agent",
			message,
			usage: message.usage,
		});
		await runtimeAdapter.emit({ type: "settled", sessionId: "session-complete" });
		await expect(running.drainAndClose()).resolves.toMatchObject({ kind: "completed", taskId: task.id });

		const manifestPath = join(agentDir, "tasks", task.id, "verified-change-bundle.json");
		expect(existsSync(manifestPath)).toBe(true);
		expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
			verified: true,
			task: { state: "completed" },
			attempt: { state: "completed", runtimeSnapshot: { model: { provider: "test", id: "faux" } } },
			provider: { confidence: "exact", requests: [{ providerRequestId: "request-complete", state: "finished" }] },
		});
		const inspectionStore = SqliteTaskStore.open({ databasePath });
		expect(inspectionStore.listEvents(task.id, 0, 200).map((event) => event.type)).toContain(
			"VerifiedChangeBundleCreated",
		);
		inspectionStore.close();
	});
});
