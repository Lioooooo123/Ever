import { EventEmitter } from "node:events";
import { type FSWatcher, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "@lioooooo123/ever-long-tasks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCoordinationActor } from "../src/core/coordination-actor.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import agentCoordinationExtension, {
	type CoordinationWatch,
	createAgentCoordinationExtension,
} from "../src/extensions/agent-coordination.ts";

const temporaryPaths: string[] = [];
const previousAgentDir = process.env.EVER_CODING_AGENT_DIR;

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.EVER_CODING_AGENT_DIR;
	else process.env.EVER_CODING_AGENT_DIR = previousAgentDir;
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup(extensionFactory: (ever: ExtensionAPI) => void = agentCoordinationExtension) {
	const root = mkdtempSync(join(tmpdir(), "ever-agent-coordination-extension-"));
	temporaryPaths.push(root);
	const agentDir = join(root, "agent");
	const workspace = join(root, "workspace");
	mkdirSync(agentDir);
	mkdirSync(workspace);
	process.env.EVER_CODING_AGENT_DIR = agentDir;
	const branch: Array<Record<string, unknown>> = [];
	const context = {
		cwd: workspace,
		model: { provider: "openai-codex", id: "gpt-5.4" },
		durableGoal: { status: () => undefined },
		sessionManager: {
			getSessionId: () => "ordinary-session",
			getSessionName: () => "ordinary",
			getSessionFile: () => join(root, "ordinary.jsonl"),
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext;
	const actor = resolveCoordinationActor(agentDir, context, { create: true });
	const store = SqliteTaskStore.open({ databasePath: join(agentDir, "long-tasks.sqlite") });
	const main = store.requireAgent(actor.agentId);
	const delegated = store.createDelegation({
		actor: main,
		operationKey: "child",
		name: "child",
		role: "researcher",
		objective: "report",
		acceptance: [],
		paths: ["."],
		allowedTools: ["agent_report"],
		workspaceMode: "read_only_shared",
		budget: { maxTurns: 5, maxWallTimeMinutes: 10 },
		required: false,
	});
	store.close();
	let messageSequence = 0;
	const queueMessage = (): string => {
		const queueStore = SqliteTaskStore.open({ databasePath: join(agentDir, "long-tasks.sqlite") });
		try {
			messageSequence++;
			return queueStore.queueMessage({
				actor: queueStore.requireAgent(delegated.agentId),
				recipient: queueStore.requireAgent(actor.agentId),
				dedupeKey: `result-${messageSequence}`,
				type: "result",
				priority: "high",
				body: "done",
				artifactRefs: [],
			});
		} finally {
			queueStore.close();
		}
	};

	type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => void | Promise<void>;
	const handlers = new Map<string, Handler[]>();
	const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>((message) => {
		branch.push({
			type: "custom_message",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
		});
	});
	const providerPayload = () => ({
		messages: branch.map((entry) => ({ content: entry.content })),
	});
	const api = {
		registerTool() {},
		on(event: string, handler: Handler) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		sendMessage,
	} as unknown as ExtensionAPI;
	const restartExtension = (): void => {
		handlers.clear();
		extensionFactory(api);
	};
	restartExtension();
	const emit = async (event: Record<string, unknown>) => {
		for (const handler of handlers.get(String(event.type)) ?? []) await handler(event, context);
	};
	return { actor, agentDir, branch, context, emit, providerPayload, queueMessage, restartExtension, sendMessage };
}

function messageState(agentDir: string, taskId: string, messageId: string) {
	const store = SqliteTaskStore.open({ databasePath: join(agentDir, "long-tasks.sqlite") });
	try {
		return store.listMessages(taskId).find((message) => message.id === messageId)?.state;
	} finally {
		store.close();
	}
}

describe("Agent coordination Session delivery", () => {
	it("acknowledges only after the durable message is provider-visible and its run settles", async () => {
		const runtime = setup();
		const messageId = runtime.queueMessage();
		await runtime.emit({ type: "session_start", reason: "startup" });
		expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
		expect(messageState(runtime.agentDir, runtime.actor.taskId, messageId)).toBe("queued");

		await runtime.emit({ type: "agent_start" });
		await runtime.emit({
			type: "provider_request_prepared",
			requestId: "request-1",
			requestKind: "agent",
			payload: runtime.providerPayload(),
		});
		expect(messageState(runtime.agentDir, runtime.actor.taskId, messageId)).toBe("queued");
		await runtime.emit({
			type: "after_provider_response",
			requestId: "request-1",
			requestKind: "agent",
			status: 200,
			headers: {},
		});
		expect(messageState(runtime.agentDir, runtime.actor.taskId, messageId)).toBe("delivered");
		await runtime.emit({
			type: "agent_end",
			messages: [{ role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() }],
		});
		await runtime.emit({ type: "agent_settled" });

		expect(messageState(runtime.agentDir, runtime.actor.taskId, messageId)).toBe("acknowledged");
		await runtime.emit({ type: "session_shutdown", reason: "quit" });
	});

	it("leaves the durable message queued when the provider response is unsuccessful or the Session is replaced", async () => {
		const runtime = setup();
		const messageId = runtime.queueMessage();
		await runtime.emit({ type: "session_start", reason: "startup" });
		await runtime.emit({ type: "agent_start" });
		await runtime.emit({
			type: "provider_request_prepared",
			requestId: "request-failed",
			requestKind: "agent",
			payload: runtime.providerPayload(),
		});
		await runtime.emit({
			type: "after_provider_response",
			requestId: "request-failed",
			requestKind: "agent",
			status: 500,
			headers: {},
		});
		await runtime.emit({
			type: "agent_end",
			messages: [{ role: "assistant", content: [], stopReason: "error", timestamp: Date.now() }],
		});
		await runtime.emit({ type: "agent_settled" });
		expect(messageState(runtime.agentDir, runtime.actor.taskId, messageId)).toBe("queued");

		await runtime.emit({ type: "session_shutdown", reason: "resume" });
		expect(messageState(runtime.agentDir, runtime.actor.taskId, messageId)).toBe("queued");
	});

	it("acknowledges a provider-visible message when an error run reaches its final settled boundary", async () => {
		const runtime = setup();
		const messageId = runtime.queueMessage();
		await runtime.emit({ type: "session_start", reason: "startup" });
		await runtime.emit({ type: "agent_start" });
		await runtime.emit({
			type: "provider_request_prepared",
			requestId: "request-error-run",
			requestKind: "agent",
			payload: runtime.providerPayload(),
		});
		await runtime.emit({
			type: "after_provider_response",
			requestId: "request-error-run",
			requestKind: "agent",
			status: 200,
			headers: {},
		});
		await runtime.emit({
			type: "agent_end",
			messages: [{ role: "assistant", content: [], stopReason: "error", timestamp: Date.now() }],
		});
		await runtime.emit({ type: "agent_settled" });

		expect(messageState(runtime.agentDir, runtime.actor.taskId, messageId)).toBe("acknowledged");
		await runtime.emit({ type: "session_shutdown", reason: "quit" });
	});

	it("recovers an unsettled model-visible receipt after the extension restarts in the same Session", async () => {
		const runtime = setup();
		const messageId = runtime.queueMessage();
		await runtime.emit({ type: "session_start", reason: "startup" });
		await runtime.emit({ type: "agent_start" });
		await runtime.emit({
			type: "provider_request_prepared",
			requestId: "request-before-crash",
			requestKind: "agent",
			payload: runtime.providerPayload(),
		});
		await runtime.emit({
			type: "after_provider_response",
			requestId: "request-before-crash",
			requestKind: "agent",
			status: 200,
			headers: {},
		});
		expect(messageState(runtime.agentDir, runtime.actor.taskId, messageId)).toBe("delivered");

		await runtime.emit({ type: "session_shutdown", reason: "crash" });
		runtime.restartExtension();
		await runtime.emit({ type: "session_start", reason: "resume" });
		await runtime.emit({ type: "agent_start" });
		await runtime.emit({
			type: "provider_request_prepared",
			requestId: "request-after-restart",
			requestKind: "agent",
			payload: runtime.providerPayload(),
		});
		await runtime.emit({
			type: "after_provider_response",
			requestId: "request-after-restart",
			requestKind: "agent",
			status: 200,
			headers: {},
		});
		await runtime.emit({ type: "agent_settled" });

		expect(messageState(runtime.agentDir, runtime.actor.taskId, messageId)).toBe("acknowledged");
		await runtime.emit({ type: "session_shutdown", reason: "quit" });
	});

	it("does not infer visibility from a raw branch after compaction or a payload hook removes the message", async () => {
		const runtime = setup();
		const messageId = runtime.queueMessage();
		await runtime.emit({ type: "session_start", reason: "startup" });
		expect(runtime.branch).toHaveLength(1);
		await runtime.emit({ type: "agent_start" });
		await runtime.emit({
			type: "provider_request_prepared",
			requestId: "request-compacted",
			requestKind: "agent",
			payload: { messages: [{ role: "user", content: "compaction summary without inbox payload" }] },
		});
		await runtime.emit({
			type: "after_provider_response",
			requestId: "request-compacted",
			requestKind: "agent",
			status: 200,
			headers: {},
		});
		await runtime.emit({ type: "agent_settled" });

		expect(messageState(runtime.agentDir, runtime.actor.taskId, messageId)).toBe("queued");
		await runtime.emit({ type: "session_shutdown", reason: "quit" });
	});

	it("wakes an ordinary Session when a child result is committed after startup", async () => {
		const runtime = setup();
		await runtime.emit({ type: "session_start", reason: "startup" });
		expect(runtime.sendMessage).not.toHaveBeenCalled();

		const messageId = runtime.queueMessage();
		await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(1));
		expect(messageState(runtime.agentDir, runtime.actor.taskId, messageId)).toBe("queued");

		await runtime.emit({ type: "session_shutdown", reason: "quit" });
	});

	it("handles asynchronous watcher errors and re-subscribes with backoff", async () => {
		vi.useFakeTimers();
		try {
			const watchers: EventEmitter[] = [];
			const watchDirectory = vi.fn<CoordinationWatch>((_path, _listener) => {
				const watcher = new EventEmitter();
				Object.assign(watcher, { close: vi.fn(), ref: vi.fn(), unref: vi.fn() });
				watchers.push(watcher);
				return watcher as unknown as FSWatcher;
			});
			const runtime = setup(createAgentCoordinationExtension(watchDirectory));
			await runtime.emit({ type: "session_start", reason: "startup" });
			expect(watchDirectory).toHaveBeenCalledTimes(1);

			expect(() => watchers[0]!.emit("error", new Error("watch backend failed"))).not.toThrow();
			await vi.advanceTimersByTimeAsync(100);
			expect(watchDirectory).toHaveBeenCalledTimes(2);

			await runtime.emit({ type: "session_shutdown", reason: "quit" });
		} finally {
			vi.useRealTimers();
		}
	});
});
