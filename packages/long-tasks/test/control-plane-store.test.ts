import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryTaskStore, DurableAgentCoordinator, SqliteTaskStore, TaskController } from "../src/index.ts";

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

	it("migrates duplicate legacy Agent names and terminal Episodes without unsafe uniqueness", async () => {
		const directory = mkdtempSync(join(tmpdir(), "ever-dispatch-migration-"));
		temporaryDirectories.push(directory);
		const databasePath = join(directory, "tasks.db");
		const database = new DatabaseSync(databasePath);
		database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
		for (const [version, name] of [
			[1, "long_tasks"],
			[2, "multi_agent"],
			[3, "notifications"],
			[4, "control_plane"],
			[5, "verified_completion"],
			[6, "task_commands"],
			[7, "permissions"],
			[8, "task_authorizations"],
			[9, "flows"],
		] as const) {
			database.exec(readFileSync(new URL(`../src/migrations/00${version}_${name}.sql`, import.meta.url), "utf8"));
			database
				.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
				.run(version, new Date(0).toISOString());
		}
		const createdAt = new Date(0).toISOString();
		database
			.prepare(
				`INSERT INTO tasks(
				 id, title, goal, acceptance_json, constraints_json, budget_json, state,
				 workspace_root, workspace_fingerprint, created_at, updated_at
				) VALUES ('task-legacy', 'legacy', 'legacy', '[]', '{}', ?, 'running', '/repo', 'legacy', ?, ?)`,
			)
			.run(JSON.stringify({ maxTurns: 20, maxWallTimeMinutes: 30 }), createdAt, createdAt);
		const insertAgent = database.prepare(
			`INSERT INTO agents(
			 id, task_id, parent_agent_id, kind, name, role, objective, state, depth,
			 workspace_mode, workspace_root, tool_policy_json, budget_json, created_at, updated_at
			) VALUES (?, 'task-legacy', ?, ?, ?, 'role', 'objective', 'completed', ?, 'read_only_shared', '/repo', ?, ?, ?, ?)`,
		);
		const policy = JSON.stringify({
			allowedTools: [],
			allowedPaths: ["/repo"],
			readOnly: true,
			sandboxRequired: true,
		});
		const budget = JSON.stringify({ maxTurns: 5, maxWallTimeMinutes: 10 });
		insertAgent.run("main", null, "main", "main", 0, policy, budget, createdAt, createdAt);
		insertAgent.run("child-a", "main", "subagent", "researcher", 1, policy, budget, createdAt, createdAt);
		insertAgent.run("child-b", "main", "subagent", "researcher", 1, policy, budget, createdAt, createdAt);
		database
			.prepare(
				`INSERT INTO coordination_results(operation_key, task_id, actor_agent_id, result_json, created_at)
				 VALUES ('legacy-key', 'task-legacy', 'main', '{"kind":"message","messageId":"legacy","replayed":false}', ?)`,
			)
			.run(createdAt);
		const insertEpisode = database.prepare(
			`INSERT INTO episodes(
			 id, task_id, agent_id, status, summary, evidence_json, blockers_json, acceptance_results_json, created_at
			) VALUES (?, 'task-legacy', 'child-a', 'completed', ?, '[]', '[]', '[]', ?)`,
		);
		insertEpisode.run("episode-1", "first", createdAt);
		insertEpisode.run("episode-2", "second", createdAt);
		database.close();

		const store = SqliteTaskStore.open({ databasePath });
		expect(store.listAgents("task-legacy").map((agent) => agent.name)).toEqual([
			"main",
			"researcher",
			"researcher-legacy-child-b",
		]);
		expect(store.listEpisodes({ taskId: "task-legacy", agentId: "child-a" })).toHaveLength(2);
		await expect(
			new DurableAgentCoordinator(store).coordinate(
				{ taskId: "task-legacy", agentId: "main", kind: "main" },
				{
					type: "message",
					operationKey: "legacy-key",
					recipientAgentId: "child-a",
					messageType: "directive",
					body: "must not replay unverifiable legacy input",
				},
			),
		).rejects.toThrow("reused with different input");
		store.close();
	});

	it("fails the legacy Agent-name migration when a generated repair name already exists", () => {
		const directory = mkdtempSync(join(tmpdir(), "ever-dispatch-name-collision-"));
		temporaryDirectories.push(directory);
		const databasePath = join(directory, "tasks.db");
		const database = new DatabaseSync(databasePath);
		database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
		for (const [version, name] of [
			[1, "long_tasks"],
			[2, "multi_agent"],
			[3, "notifications"],
			[4, "control_plane"],
			[5, "verified_completion"],
			[6, "task_commands"],
			[7, "permissions"],
			[8, "task_authorizations"],
			[9, "flows"],
		] as const) {
			database.exec(readFileSync(new URL(`../src/migrations/00${version}_${name}.sql`, import.meta.url), "utf8"));
			database
				.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
				.run(version, new Date(0).toISOString());
		}
		const createdAt = new Date(0).toISOString();
		database
			.prepare(
				`INSERT INTO tasks(
				 id, title, goal, acceptance_json, constraints_json, budget_json, state,
				 workspace_root, workspace_fingerprint, created_at, updated_at
				) VALUES ('task-collision', 'legacy', 'legacy', '[]', '{}', ?, 'running', '/repo', 'legacy', ?, ?)`,
			)
			.run(JSON.stringify({ maxTurns: 20, maxWallTimeMinutes: 30 }), createdAt, createdAt);
		const insertAgent = database.prepare(
			`INSERT INTO agents(
			 id, task_id, parent_agent_id, kind, name, role, objective, state, depth,
			 workspace_mode, workspace_root, tool_policy_json, budget_json, created_at, updated_at
			) VALUES (?, 'task-collision', ?, ?, ?, 'role', 'objective', 'completed', ?, 'read_only_shared', '/repo', ?, ?, ?, ?)`,
		);
		const policy = JSON.stringify({
			allowedTools: [],
			allowedPaths: ["/repo"],
			readOnly: true,
			sandboxRequired: true,
		});
		const budget = JSON.stringify({ maxTurns: 5, maxWallTimeMinutes: 10 });
		insertAgent.run("main", null, "main", "main", 0, policy, budget, createdAt, createdAt);
		insertAgent.run("child-a", "main", "subagent", "researcher", 1, policy, budget, createdAt, createdAt);
		insertAgent.run("child-b", "main", "subagent", "researcher", 1, policy, budget, createdAt, createdAt);
		insertAgent.run(
			"collision",
			"main",
			"subagent",
			"researcher-legacy-child-b",
			1,
			policy,
			budget,
			createdAt,
			createdAt,
		);
		database.close();

		expect(() => SqliteTaskStore.open({ databasePath })).toThrow("UNIQUE constraint failed");
		const rolledBack = new DatabaseSync(databasePath);
		expect(rolledBack.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 9 });
		rolledBack.close();
	});

	it("rejects corrupted Dispatch manifest and embedded Episode hashes", () => {
		const directory = mkdtempSync(join(tmpdir(), "ever-dispatch-integrity-"));
		temporaryDirectories.push(directory);
		const databasePath = join(directory, "tasks.db");
		let store = SqliteTaskStore.open({ databasePath });
		const task = new TaskController(store).create({
			title: "integrity",
			goal: "integrity",
			acceptance: [],
			budget: { maxTurns: 10, maxWallTimeMinutes: 30 },
			workspaceRoot: "/repo",
			workspaceFingerprint: "integrity",
		});
		const main = store.listAgents(task.id)[0]!;
		const child = store.requireAgent(
			store.createDelegation({
				actor: main,
				operationKey: "child",
				name: "child",
				role: "child",
				objective: "first",
				acceptance: [],
				paths: ["."],
				allowedTools: [],
				workspaceMode: "read_only_shared",
				budget: { maxTurns: 2, maxWallTimeMinutes: 10 },
				required: false,
			}).agentId,
		);
		const first = store.getRunnableAgentDispatch(child.id)!;
		store.finalizeAgentDispatch({
			agent: child,
			dispatchId: first.id,
			status: "completed",
			messageId: "first",
			episode: { summary: "trusted", evidence: [], blockers: [], acceptanceResults: [] },
		});
		const second = store.createAgentDispatch({
			actor: main,
			agentId: child.id,
			operationKey: "second",
			action: "second",
		}).dispatch;
		store.close();

		let database = new DatabaseSync(databasePath);
		const row = database
			.prepare("SELECT context_manifest_json FROM agent_dispatches WHERE id = ?")
			.get(second.id) as { context_manifest_json: string };
		database
			.prepare("UPDATE agent_dispatches SET context_manifest_sha256 = ? WHERE id = ?")
			.run("0".repeat(64), second.id);
		database.close();
		store = SqliteTaskStore.open({ databasePath });
		expect(() => store.requireAgentDispatch(second.id)).toThrow("manifest hash");
		store.close();

		const manifest = JSON.parse(row.context_manifest_json) as { selfEpisode: { summary: string } };
		manifest.selfEpisode.summary = "tampered";
		const tamperedJson = JSON.stringify(manifest);
		database = new DatabaseSync(databasePath);
		database
			.prepare("UPDATE agent_dispatches SET context_manifest_json = ?, context_manifest_sha256 = ? WHERE id = ?")
			.run(tamperedJson, createHash("sha256").update(tamperedJson).digest("hex"), second.id);
		database.close();
		store = SqliteTaskStore.open({ databasePath });
		expect(() => store.requireAgentDispatch(second.id)).toThrow("context Episode hash");
		store.close();
	});
});
