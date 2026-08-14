import { describe, expect, it } from "vitest";
import { createInMemoryTaskStore, TaskController } from "../src/index.ts";

function setup() {
	const store = createInMemoryTaskStore(() => new Date("2026-08-15T00:00:00.000Z"));
	const task = new TaskController(store).create({
		title: "dispatch",
		goal: "coordinate named agents",
		acceptance: [],
		budget: { maxTurns: 20, maxWallTimeMinutes: 30 },
		workspaceRoot: "/repo",
		workspaceFingerprint: "repo",
		toolPolicy: {
			allowedTools: ["read", "agent_report"],
			allowedPaths: ["/repo"],
			readOnly: false,
			sandboxRequired: false,
		},
	});
	const main = store.listAgents(task.id)[0]!;
	const child = store.createDelegation({
		actor: main,
		operationKey: "spawn-researcher",
		name: "researcher",
		role: "researcher",
		objective: "first pass",
		acceptance: [],
		paths: ["."],
		allowedTools: ["read", "agent_report"],
		workspaceMode: "read_only_shared",
		budget: { maxTurns: 5, maxWallTimeMinutes: 10 },
		required: false,
	});
	return { store, main, child: store.requireAgent(child.agentId) };
}

describe("stable Agent Dispatch persistence", () => {
	it("creates fresh FIFO Dispatches with bounded retained Episode context", () => {
		const { store, main, child } = setup();
		const first = store.listAgentDispatches(child.id)[0]!;
		store.bindInteractiveAgentSession(child.id, "session-1");
		store.finalizeAgentDispatch({
			agent: child,
			dispatchId: first.id,
			status: "completed",
			messageId: "first-result",
			episode: { summary: "first result", evidence: [], blockers: [], acceptanceResults: [] },
		});

		const created = store.createAgentDispatch({
			actor: main,
			agentId: child.id,
			operationKey: "follow-up",
			action: "second pass",
		});
		expect(created.replayed).toBe(false);
		expect(created.dispatch.sequence).toBe(2);
		expect(created.dispatch.contextManifest.selfEpisode?.summary).toBe("first result");
		expect(store.requireAgent(child.id).state).toBe("queued");
		store.bindInteractiveAgentSession(child.id, "session-2");
		expect(store.requireAgentDispatch(created.dispatch.id).sessionId).toBe("session-2");
		expect(store.requireAgentDispatch(first.id).sessionId).toBe("session-1");
		expect(
			store.createAgentDispatch({
				actor: main,
				agentId: child.id,
				operationKey: "follow-up",
				action: "second pass",
			}).replayed,
		).toBe(true);
		store.close();
	});

	it("keeps live-delivered messages pending until durable acknowledgement", () => {
		let now = new Date("2026-08-15T00:00:00.000Z");
		const store = createInMemoryTaskStore(() => now);
		const task = new TaskController(store).create({
			title: "delivery",
			goal: "deliver safely",
			acceptance: [],
			budget: { maxTurns: 20, maxWallTimeMinutes: 30 },
			workspaceRoot: "/repo",
			workspaceFingerprint: "repo",
		});
		const main = store.listAgents(task.id)[0]!;
		const child = store.requireAgent(
			store.createDelegation({
				actor: main,
				operationKey: "spawn-delivery",
				name: "delivery",
				role: "delivery",
				objective: "receive",
				acceptance: [],
				paths: ["."],
				allowedTools: [],
				workspaceMode: "read_only_shared",
				budget: { maxTurns: 5, maxWallTimeMinutes: 10 },
				required: false,
			}).agentId,
		);
		const messageId = store.queueMessage({
			actor: main,
			recipient: child,
			dedupeKey: "steer-1",
			type: "steering",
			priority: "high",
			body: "change direction",
			artifactRefs: [],
		});
		expect(store.claimAgentMessageForLiveDelivery(messageId, child.id)).toBe(true);
		expect(store.readAgentInbox(child.id)).toEqual([]);
		now = new Date("2026-08-15T00:34:59.000Z");
		expect(store.recoverStaleAgentMessageDeliveries()).toBe(0);
		now = new Date("2026-08-15T00:35:01.000Z");
		expect(store.recoverStaleAgentMessageDeliveries()).toBe(1);
		expect(store.claimAgentMessageForLiveDelivery(messageId, child.id)).toBe(true);
		expect(store.completeAgentMessageLiveDelivery(messageId, child.id, true)).toBe("delivered");
		expect(store.readAgentInbox(child.id)).toMatchObject([{ id: messageId, state: "delivered" }]);
		expect(store.countPendingAgentMessages(child.id)).toBe(1);
		store.acknowledgeAgentInbox(child.id, [messageId]);
		expect(store.countPendingAgentMessages(child.id)).toBe(0);
		store.close();
	});

	it("peeks before durable Session append and marks delivery explicitly", () => {
		const { store, main, child } = setup();
		const messageId = store.queueMessage({
			actor: main,
			recipient: child,
			dedupeKey: "local-1",
			type: "directive",
			priority: "normal",
			body: "persist before marking",
			artifactRefs: [],
		});
		expect(store.peekAgentInbox(child.id)).toMatchObject([{ id: messageId, state: "queued" }]);
		expect(store.peekAgentInbox(child.id)).toMatchObject([{ id: messageId, state: "queued" }]);
		store.markAgentMessagesDelivered(child.id, [messageId]);
		expect(store.peekAgentInbox(child.id)).toEqual([]);
		expect(store.readAgentInbox(child.id)).toMatchObject([{ id: messageId, state: "delivered" }]);
		store.close();
	});

	it("atomically settles model-visible queued and delivered messages", () => {
		const { store, main, child } = setup();
		const deliveredId = store.queueMessage({
			actor: main,
			recipient: child,
			dedupeKey: "settle-delivered",
			type: "directive",
			priority: "normal",
			body: "already marked delivered",
			artifactRefs: [],
		});
		const queuedId = store.queueMessage({
			actor: main,
			recipient: child,
			dedupeKey: "settle-queued",
			type: "directive",
			priority: "normal",
			body: "durably appended while queued",
			artifactRefs: [],
		});
		store.markAgentMessagesDelivered(child.id, [deliveredId]);
		store.markAgentMessagesModelVisible(child.id, [deliveredId, queuedId], {
			sessionId: "session-model-visible",
			requestId: "request-model-visible",
		});
		store.markAgentMessagesModelVisible(child.id, [deliveredId, queuedId], {
			sessionId: "session-model-visible",
			requestId: "request-model-visible",
		});
		expect(() =>
			store.markAgentMessagesModelVisible(child.id, [deliveredId], {
				sessionId: "session-model-visible",
				requestId: "different-request",
			}),
		).toThrow(`Model-visible receipt identity conflict: ${deliveredId}`);
		const unsettled = store.listUnsettledAgentMessageReceipts(child.id);
		expect(unsettled).toHaveLength(2);
		expect(unsettled).toEqual(
			expect.arrayContaining([
				{
					messageId: deliveredId,
					sessionId: "session-model-visible",
					requestId: "request-model-visible",
					modelVisibleAt: expect.any(String),
				},
				{
					messageId: queuedId,
					sessionId: "session-model-visible",
					requestId: "request-model-visible",
					modelVisibleAt: expect.any(String),
				},
			]),
		);
		expect(store.listUnsettledAgentMessageReceipts(main.id)).toEqual([]);
		expect(store.listUnsettledAgentMessageReceipts(child.id, "different-session")).toEqual([]);

		store.settleAgentMessages(child.id, [deliveredId, queuedId]);
		store.settleAgentMessages(child.id, [deliveredId, queuedId]);
		expect(store.listUnsettledAgentMessageReceipts(child.id, "session-model-visible")).toEqual([]);

		expect(store.countPendingAgentMessages(child.id)).toBe(0);
		expect(
			store
				.listMessages(child.taskId, child.id)
				.filter((message) => message.id === deliveredId || message.id === queuedId)
				.map((message) => message.state),
		).toEqual(["acknowledged", "acknowledged"]);
		const messageEvents = store
			.listEvents(child.taskId)
			.filter(
				(event) =>
					(event.payload.messageId === deliveredId || event.payload.messageId === queuedId) &&
					(event.type === "MessageDelivered" ||
						event.type === "MessageModelVisible" ||
						event.type === "MessageAcknowledged"),
			);
		expect(messageEvents.filter((event) => event.type === "MessageDelivered")).toHaveLength(2);
		expect(messageEvents.filter((event) => event.type === "MessageModelVisible")).toHaveLength(2);
		expect(messageEvents.filter((event) => event.type === "MessageAcknowledged")).toHaveLength(2);

		const noReceiptId = store.queueMessage({
			actor: main,
			recipient: child,
			dedupeKey: "settle-no-receipt",
			type: "directive",
			priority: "normal",
			body: "must not settle without model visibility",
			artifactRefs: [],
		});
		expect(() => store.settleAgentMessages(child.id, [noReceiptId])).toThrow(
			`Model-visible receipt not found: ${noReceiptId}`,
		);
		const rollbackId = store.queueMessage({
			actor: main,
			recipient: child,
			dedupeKey: "settle-rollback",
			type: "directive",
			priority: "normal",
			body: "remain queued when batch fails",
			artifactRefs: [],
		});
		store.markAgentMessagesModelVisible(child.id, [rollbackId], {
			sessionId: "session-rollback",
			requestId: "request-rollback",
		});
		expect(() => store.settleAgentMessages(child.id, [rollbackId, "missing-message"])).toThrow(
			"Model-visible receipt not found: missing-message",
		);
		expect(store.readAgentInbox(child.id)).toContainEqual(
			expect.objectContaining({ id: rollbackId, state: "delivered" }),
		);
		store.close();
	});

	it("settles an in-flight live delivery before a late completion callback", () => {
		const { store, main, child } = setup();
		const messageId = store.queueMessage({
			actor: main,
			recipient: child,
			dedupeKey: "settle-delivering",
			type: "steering",
			priority: "high",
			body: "already visible to the provider",
			artifactRefs: [],
		});
		expect(store.claimAgentMessageForLiveDelivery(messageId, child.id)).toBe(true);
		store.markAgentMessagesModelVisible(child.id, [messageId], {
			sessionId: "session-live",
			requestId: "request-live",
		});

		store.settleAgentMessages(child.id, [messageId]);

		expect(store.countPendingAgentMessages(child.id)).toBe(0);
		expect(store.completeAgentMessageLiveDelivery(messageId, child.id, true)).toBe("delivered");
		expect(store.completeAgentMessageLiveDelivery(messageId, child.id, false)).toBe("delivered");
		expect(store.listMessages(child.taskId, child.id).find((message) => message.id === messageId)?.state).toBe(
			"acknowledged",
		);
		expect(
			store
				.listEvents(child.taskId)
				.filter(
					(event) =>
						event.payload.messageId === messageId &&
						(event.type === "MessageDelivered" ||
							event.type === "MessageModelVisible" ||
							event.type === "MessageAcknowledged"),
				),
		).toHaveLength(3);
		store.close();
	});

	it("rejects stale reports instead of settling a later Dispatch", () => {
		const { store, main, child } = setup();
		const first = store.getRunnableAgentDispatch(child.id)!;
		store.finalizeAgentDispatch({
			agent: child,
			dispatchId: first.id,
			status: "completed",
			messageId: "first",
			episode: { summary: "first", evidence: [], blockers: [], acceptanceResults: [] },
		});
		const second = store.createAgentDispatch({
			actor: main,
			agentId: child.id,
			operationKey: "second",
			action: "second",
		}).dispatch;
		expect(() =>
			store.recordAgentReport(child, first.id, "completed", "stale", {
				summary: "stale",
				evidence: [],
				blockers: [],
				acceptanceResults: [],
			}),
		).toThrow("cannot accept reports");
		expect(store.requireAgentDispatch(second.id).state).toBe("queued");
		store.close();
	});

	it("scopes Dispatch idempotency to the main actor operation and retires cancelled Agents", () => {
		const { store, main, child } = setup();
		const other = store.requireAgent(
			store.createDelegation({
				actor: main,
				operationKey: "spawn-other",
				name: "other",
				role: "other",
				objective: "other",
				acceptance: [],
				paths: ["."],
				allowedTools: [],
				workspaceMode: "read_only_shared",
				budget: { maxTurns: 5, maxWallTimeMinutes: 10 },
				required: false,
			}).agentId,
		);
		store.createAgentDispatch({ actor: main, agentId: child.id, operationKey: "same-call", action: "first" });
		expect(() =>
			store.createAgentDispatch({ actor: main, agentId: other.id, operationKey: "same-call", action: "first" }),
		).toThrow("identity conflict");
		store.transitionAgent(other.id, "cancelled");
		expect(store.getRunnableAgentDispatch(other.id)).toBeUndefined();
		expect(() =>
			store.createAgentDispatch({ actor: main, agentId: other.id, operationKey: "after-cancel", action: "no" }),
		).toThrow("Cancelled Agent");
		store.close();
	});

	it("does not count an interactive main Agent against resident subagent capacity", () => {
		const { store, main, child } = setup();
		store.bindInteractiveAgentSession(main.id, "main-session");
		expect(store.listRunnableAgents(main.taskId, 1).map((agent) => agent.id)).toEqual([child.id]);
		store.close();
	});
});
