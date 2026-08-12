import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryTaskStore, SqliteTaskStore } from "../src/index.ts";

const temporaryDirectories: string[] = [];

function hashPayload(payload: Record<string, unknown>): string {
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("daemon command journal", () => {
	it("deduplicates the same command identity and rejects conflicting payloads", () => {
		const store = createInMemoryTaskStore();
		const payload = { taskId: "task-1" };
		const input = {
			clientId: "client-1",
			commandId: "command-1",
			commandType: "wake",
			payload,
			payloadSha256: hashPayload(payload),
		};

		expect(store.receiveDaemonCommand(input).duplicate).toBe(false);
		expect(store.receiveDaemonCommand(input)).toMatchObject({
			duplicate: true,
			command: { state: "received", payload },
		});
		expect(() =>
			store.receiveDaemonCommand({ ...input, commandType: "stop", payloadSha256: "a".repeat(64) }),
		).toThrow("identity conflict");
		store.close();
	});

	it("persists terminal results for retry replay", () => {
		const directory = mkdtempSync(join(tmpdir(), "ever-control-plane-"));
		temporaryDirectories.push(directory);
		const databasePath = join(directory, "tasks.db");
		const payload = { taskId: "task-1" };
		const input = {
			clientId: "client-1",
			commandId: "command-1",
			commandType: "wake",
			payload,
			payloadSha256: hashPayload(payload),
		};
		let store = SqliteTaskStore.open({ databasePath });
		store.receiveDaemonCommand(input);
		store.markDaemonCommandDispatched(input.clientId, input.commandId);
		store.completeDaemonCommand(input.clientId, input.commandId, { ok: true });
		store.close();

		store = SqliteTaskStore.open({ databasePath });
		expect(store.receiveDaemonCommand(input)).toMatchObject({
			duplicate: true,
			command: { state: "completed", result: { ok: true } },
		});
		store.close();
	});

	it("marks interrupted commands uncertain after daemon recovery", () => {
		const store = createInMemoryTaskStore();
		const receivedPayload = { taskId: "task-1" };
		const dispatchedPayload = { taskId: "task-2" };
		store.receiveDaemonCommand({
			clientId: "client-1",
			commandId: "received",
			commandType: "wake",
			payload: receivedPayload,
			payloadSha256: hashPayload(receivedPayload),
		});
		store.receiveDaemonCommand({
			clientId: "client-1",
			commandId: "dispatched",
			commandType: "wake",
			payload: dispatchedPayload,
			payloadSha256: hashPayload(dispatchedPayload),
		});
		store.markDaemonCommandDispatched("client-1", "dispatched");

		expect(store.markInterruptedDaemonCommandsUncertain()).toBe(2);
		expect(store.getDaemonCommand("client-1", "received")).toMatchObject({ state: "uncertain" });
		expect(store.getDaemonCommand("client-1", "dispatched")).toMatchObject({ state: "uncertain" });
		store.close();
	});

	it("prunes only terminal commands older than the configured retention", () => {
		let now = new Date("2026-08-01T00:00:00.000Z");
		const store = createInMemoryTaskStore(() => now);
		const receive = (commandId: string) => {
			const payload = { commandId };
			store.receiveDaemonCommand({
				clientId: "client-1",
				commandId,
				commandType: "wake",
				payload,
				payloadSha256: hashPayload(payload),
			});
		};
		receive("old-completed");
		store.markDaemonCommandDispatched("client-1", "old-completed");
		store.completeDaemonCommand("client-1", "old-completed", { ok: true });
		receive("old-active");
		now = new Date("2026-08-10T00:00:00.000Z");
		receive("recent-completed");
		store.markDaemonCommandDispatched("client-1", "recent-completed");
		store.completeDaemonCommand("client-1", "recent-completed", { ok: true });

		expect(store.pruneDaemonCommands(7)).toBe(1);
		expect(store.getDaemonCommand("client-1", "old-completed")).toBeUndefined();
		expect(store.getDaemonCommand("client-1", "old-active")?.state).toBe("received");
		expect(store.getDaemonCommand("client-1", "recent-completed")?.state).toBe("completed");
		store.close();
	});

	it("migrates legacy nextWakeAt values into once schedules without deleting the old field", () => {
		const directory = mkdtempSync(join(tmpdir(), "ever-control-plane-migration-"));
		temporaryDirectories.push(directory);
		const databasePath = join(directory, "tasks.db");
		const database = new DatabaseSync(databasePath);
		database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
		for (const [version, name] of [
			[1, "long_tasks"],
			[2, "multi_agent"],
			[3, "notifications"],
		] as const) {
			database.exec(readFileSync(new URL(`../src/migrations/00${version}_${name}.sql`, import.meta.url), "utf8"));
			database
				.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
				.run(version, new Date(0).toISOString());
		}
		const wakeAt = "2026-08-12T00:00:00.000Z";
		database
			.prepare(
				`INSERT INTO tasks
				 (id, title, goal, acceptance_json, constraints_json, budget_json, state, workspace_root,
				  workspace_fingerprint, next_wake_at, created_at, updated_at)
				 VALUES ('task-1', 'title', 'goal', '[]', '{}', '{"maxTurns":10,"maxWallTimeMinutes":10}',
				  'waiting_external', '/repo', 'fingerprint', ?, ?, ?)`,
			)
			.run(wakeAt, new Date(0).toISOString(), new Date(0).toISOString());
		database.close();

		const store = SqliteTaskStore.open({ databasePath });
		expect(store.requireTask("task-1").nextWakeAt).toBe(wakeAt);
		expect(store.listSchedules("task-1")).toMatchObject([
			{ kind: "once", expression: wakeAt, nextRunAt: wakeAt, payload: { legacyNextWakeAt: true } },
		]);
		store.close();
	});
});
