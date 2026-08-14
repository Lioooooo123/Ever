import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionMailboxStore } from "../src/core/session-mailbox.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SessionMailboxStore", () => {
	it("routes durable messages across ordinary Sessions with replay and acknowledgement", () => {
		const directory = mkdtempSync(join(tmpdir(), "ever-session-mailbox-"));
		temporaryDirectories.push(directory);
		const store = new SessionMailboxStore(join(directory, "mailbox.sqlite"));
		store.register({ sessionId: "session-a", name: "planner", cwd: "/repo" });
		store.register({ sessionId: "session-b", name: "reviewer", cwd: "/repo", agentId: "agent-b" });
		const address = store.openAddress("session-b");
		const sent = store.send({
			senderSessionId: "session-a",
			recipient: address,
			dedupeKey: "tool-1",
			subject: "handoff",
			body: "Review the plan",
			artifactRefs: ["artifact:plan"],
		});
		const replay = store.send({
			senderSessionId: "session-a",
			recipient: address,
			dedupeKey: "tool-1",
			subject: "handoff",
			body: "Review the plan",
			artifactRefs: ["artifact:plan"],
		});
		expect(replay.id).toBe(sent.id);
		expect(store.claim("session-b")).toMatchObject([{ id: sent.id, state: "delivered" }]);
		expect(store.claim("session-b")).toMatchObject([{ id: sent.id, state: "delivered" }]);
		expect(() => store.acknowledge("session-a", [sent.id])).toThrow("Cannot acknowledge undelivered");
		expect(store.claim("session-b")).toMatchObject([{ id: sent.id, state: "delivered" }]);
		store.acknowledge("session-b", [sent.id]);
		expect(store.claim("session-b")).toEqual([]);
		expect(store.listInbox("session-b")).toMatchObject([{ id: sent.id, state: "acknowledged" }]);
		store.closeAddress("session-b");
		expect(() =>
			store.send({
				senderSessionId: "session-a",
				recipient: address,
				dedupeKey: "tool-2",
				subject: "blocked",
				body: "must not deliver",
				artifactRefs: [],
			}),
		).toThrow("unavailable");
		store.close();
	});
});
