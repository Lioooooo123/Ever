import { join } from "node:path";
import { SqliteTaskStore } from "@lioooooo123/ever-long-tasks";
import { Type } from "typebox";
import { getAgentDir } from "../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { SessionMailboxStore } from "../core/session-mailbox.ts";

function openMailbox(): SessionMailboxStore {
	return new SessionMailboxStore(join(getAgentDir(), "session-mailbox.sqlite"));
}

function taskAgent(taskId: string, sessionId: string): string | undefined {
	const store = SqliteTaskStore.open({ databasePath: join(getAgentDir(), "long-tasks.sqlite") });
	try {
		return store.listAgents(taskId).find((agent) => agent.activeSessionId === sessionId)?.id;
	} finally {
		store.close();
	}
}

function registerCurrentSession(ctx: ExtensionContext): void {
	const sessionId = ctx.sessionManager.getSessionId();
	const taskId = ctx.durableGoal.status()?.taskId;
	const mailbox = openMailbox();
	try {
		mailbox.register({
			sessionId,
			...(ctx.sessionManager.getSessionName() ? { name: ctx.sessionManager.getSessionName() } : {}),
			cwd: ctx.cwd,
			...(ctx.sessionManager.getSessionFile() ? { sessionPath: ctx.sessionManager.getSessionFile() } : {}),
			...(taskId ? { taskId, agentId: taskAgent(taskId, sessionId) } : {}),
		});
	} finally {
		mailbox.close();
	}
}

export default function sessionMessagingExtension(ever: ExtensionAPI): void {
	ever.registerTool({
		name: "session_message",
		label: "Session Message",
		description: "Send a durable message to an Ever Session that explicitly shared a capability address.",
		promptSnippet: "session_message: send a durable cross-Session message",
		parameters: Type.Object({
			recipient: Type.String({ minLength: 1 }),
			subject: Type.String({ minLength: 1, maxLength: 200 }),
			body: Type.String({ minLength: 1, maxLength: 16384 }),
			artifactRefs: Type.Optional(Type.Array(Type.String())),
		}),
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
			registerCurrentSession(ctx);
			const mailbox = openMailbox();
			try {
				const envelope = mailbox.send({
					senderSessionId: ctx.sessionManager.getSessionId(),
					recipient: params.recipient,
					dedupeKey: toolCallId,
					subject: params.subject,
					body: params.body,
					artifactRefs: params.artifactRefs ?? [],
				});
				return { content: [{ type: "text", text: JSON.stringify(envelope) }], details: envelope };
			} finally {
				mailbox.close();
			}
		},
	});

	ever.registerTool({
		name: "session_address",
		label: "Session Address",
		description: "Open, rotate, close, or inspect the current Session's receive capability.",
		promptSnippet: "session_address: explicitly opt this Session into cross-Session messages",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("open"), Type.Literal("close"), Type.Literal("status")]),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			registerCurrentSession(ctx);
			const sessionId = ctx.sessionManager.getSessionId();
			const mailbox = openMailbox();
			try {
				if (params.action === "close") {
					mailbox.closeAddress(sessionId);
					return { content: [{ type: "text", text: JSON.stringify({ open: false }) }], details: { open: false } };
				}
				if (params.action === "status") {
					const status = { open: mailbox.isAddressOpen(sessionId), sessionId };
					return { content: [{ type: "text", text: JSON.stringify(status) }], details: status };
				}
				const opened = { open: true, address: mailbox.openAddress(sessionId) };
				return { content: [{ type: "text", text: JSON.stringify(opened) }], details: opened };
			} finally {
				mailbox.close();
			}
		},
	});

	ever.registerTool({
		name: "session_inbox",
		label: "Session Inbox",
		description: "Read or explicitly acknowledge durable messages addressed to the current Ever Session.",
		promptSnippet: "session_inbox: inspect cross-Session messages",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("read"), Type.Literal("acknowledge")]),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
			messageIds: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			registerCurrentSession(ctx);
			const mailbox = openMailbox();
			try {
				if (params.action === "acknowledge") {
					if (!params.messageIds?.length)
						throw new Error("messageIds are required to acknowledge Session messages");
					mailbox.acknowledge(ctx.sessionManager.getSessionId(), params.messageIds);
					const result = { acknowledged: params.messageIds };
					return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
				}
				const messages = mailbox.claim(ctx.sessionManager.getSessionId(), params.limit ?? 50);
				return { content: [{ type: "text", text: JSON.stringify(messages) }], details: messages };
			} finally {
				mailbox.close();
			}
		},
	});

	ever.registerCommand("sessions", {
		description: "Manage the current Session's cross-Session receive capability",
		handler: async (args, ctx) => {
			registerCurrentSession(ctx);
			const mailbox = openMailbox();
			try {
				const sessionId = ctx.sessionManager.getSessionId();
				const action = args.trim() || "status";
				if (action === "open") {
					ctx.ui.notify(
						`Session address (share only with trusted Sessions):\n${mailbox.openAddress(sessionId)}`,
						"info",
					);
					return;
				}
				if (action === "close") {
					mailbox.closeAddress(sessionId);
					ctx.ui.notify("Session messaging is closed.", "info");
					return;
				}
				if (action !== "status") throw new Error("Usage: /sessions open|close|status");
				ctx.ui.notify(`Session messaging is ${mailbox.isAddressOpen(sessionId) ? "open" : "closed"}.`, "info");
			} finally {
				mailbox.close();
			}
		},
	});

	ever.on("session_start", (_event, ctx) => registerCurrentSession(ctx));
	ever.on("session_info_changed", (_event, ctx) => registerCurrentSession(ctx));
	ever.on("before_agent_start", (event, ctx) => {
		registerCurrentSession(ctx);
		const mailbox = openMailbox();
		try {
			const count = mailbox.pendingCount(ctx.sessionManager.getSessionId());
			if (count === 0) return undefined;
			return {
				systemPrompt: `${event.systemPrompt}\n\n<session_mailbox pending="${count}">Use session_inbox to inspect typed cross-Session messages before acting on them.</session_mailbox>`,
			};
		} finally {
			mailbox.close();
		}
	});
}
