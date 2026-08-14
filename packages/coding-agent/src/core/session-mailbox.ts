import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

type DatabaseSync = DatabaseSyncType;

const originalEmitWarning = process.emitWarning;
let DatabaseSync: typeof DatabaseSyncType;
try {
	process.emitWarning = (() => {}) as typeof process.emitWarning;
	const sqliteModule = createRequire(import.meta.url)(process.versions.bun ? "bun:sqlite" : "node:sqlite") as {
		Database?: typeof DatabaseSyncType;
		DatabaseSync?: typeof DatabaseSyncType;
	};
	DatabaseSync = process.versions.bun ? sqliteModule.Database! : sqliteModule.DatabaseSync!;
} finally {
	process.emitWarning = originalEmitWarning;
}

export interface SessionAddress {
	sessionId: string;
	name?: string;
	cwd: string;
	sessionPath?: string;
	taskId?: string;
	agentId?: string;
	acceptsMessages: boolean;
	lastSeenAt: string;
}

export interface SessionEnvelope {
	id: string;
	senderSessionId: string;
	recipientSessionId: string;
	subject: string;
	body: string;
	artifactRefs: string[];
	state: "queued" | "delivered" | "acknowledged";
	createdAt: string;
}

interface SessionRow {
	session_id: string;
	name: string | null;
	cwd: string;
	session_path: string | null;
	task_id: string | null;
	agent_id: string | null;
	receive_token_sha256: string | null;
	receive_enabled: 0 | 1;
	last_seen_at: string;
}

interface MessageRow {
	id: string;
	sender_session_id: string;
	recipient_session_id: string;
	subject: string;
	body: string;
	artifact_refs_json: string;
	state: SessionEnvelope["state"];
	created_at: string;
}

function fromSessionRow(row: SessionRow): SessionAddress {
	return {
		sessionId: row.session_id,
		...(row.name ? { name: row.name } : {}),
		cwd: row.cwd,
		...(row.session_path ? { sessionPath: row.session_path } : {}),
		...(row.task_id ? { taskId: row.task_id } : {}),
		...(row.agent_id ? { agentId: row.agent_id } : {}),
		acceptsMessages: row.receive_enabled === 1,
		lastSeenAt: row.last_seen_at,
	};
}

function fromMessageRow(row: MessageRow): SessionEnvelope {
	const artifactRefs = JSON.parse(row.artifact_refs_json) as unknown;
	if (!Array.isArray(artifactRefs) || !artifactRefs.every((item) => typeof item === "string"))
		throw new Error(`Corrupt Session message ${row.id}`);
	return {
		id: row.id,
		senderSessionId: row.sender_session_id,
		recipientSessionId: row.recipient_session_id,
		subject: row.subject,
		body: row.body,
		artifactRefs,
		state: row.state,
		createdAt: row.created_at,
	};
}

export class SessionMailboxStore {
	private readonly database: DatabaseSync;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.database = new DatabaseSync(path);
		this.database.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA foreign_keys = ON;
			PRAGMA busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS sessions (
			  session_id TEXT PRIMARY KEY,
			  name TEXT,
			  cwd TEXT NOT NULL,
			  session_path TEXT,
			  task_id TEXT,
			  agent_id TEXT,
			  receive_token_sha256 TEXT,
			  receive_enabled INTEGER NOT NULL DEFAULT 0 CHECK(receive_enabled IN (0, 1)),
			  last_seen_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS sessions_name_idx ON sessions(name);
			CREATE INDEX IF NOT EXISTS sessions_agent_idx ON sessions(agent_id);
			CREATE TABLE IF NOT EXISTS session_messages (
			  id TEXT PRIMARY KEY,
			  sender_session_id TEXT NOT NULL REFERENCES sessions(session_id),
			  recipient_session_id TEXT NOT NULL REFERENCES sessions(session_id),
			  subject TEXT NOT NULL,
			  body TEXT NOT NULL,
			  artifact_refs_json TEXT NOT NULL,
			  dedupe_key TEXT NOT NULL,
			  state TEXT NOT NULL CHECK(state IN ('queued', 'delivered', 'acknowledged')),
			  created_at TEXT NOT NULL,
			  delivered_at TEXT,
			  acknowledged_at TEXT,
			  UNIQUE(sender_session_id, dedupe_key)
			);
			CREATE INDEX IF NOT EXISTS session_messages_inbox_idx
			  ON session_messages(recipient_session_id, state, created_at);
		`);
		const columns = new Set(
			(this.database.prepare("PRAGMA table_info(sessions)").all() as unknown as Array<{ name: string }>).map(
				(column) => column.name,
			),
		);
		if (!columns.has("receive_token_sha256"))
			this.database.exec("ALTER TABLE sessions ADD COLUMN receive_token_sha256 TEXT");
		if (!columns.has("receive_enabled"))
			this.database.exec("ALTER TABLE sessions ADD COLUMN receive_enabled INTEGER NOT NULL DEFAULT 0");
		chmodSync(path, 0o600);
	}

	close(): void {
		this.database.close();
	}

	register(address: Omit<SessionAddress, "lastSeenAt" | "acceptsMessages">): SessionAddress {
		const now = new Date().toISOString();
		this.database
			.prepare(
				`INSERT INTO sessions(session_id, name, cwd, session_path, task_id, agent_id, last_seen_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
				 name = excluded.name, cwd = excluded.cwd, session_path = excluded.session_path,
				 task_id = excluded.task_id, agent_id = excluded.agent_id, last_seen_at = excluded.last_seen_at`,
			)
			.run(
				address.sessionId,
				address.name ?? null,
				address.cwd,
				address.sessionPath ?? null,
				address.taskId ?? null,
				address.agentId ?? null,
				now,
			);
		this.prune();
		const registered = this.database.prepare("SELECT * FROM sessions WHERE session_id = ?").get(address.sessionId) as
			| SessionRow
			| undefined;
		if (!registered) throw new Error(`Session registration failed: ${address.sessionId}`);
		return fromSessionRow(registered);
	}

	listSessions(limit = 100): SessionAddress[] {
		return (
			this.database
				.prepare("SELECT * FROM sessions ORDER BY last_seen_at DESC LIMIT ?")
				.all(limit) as unknown as SessionRow[]
		).map(fromSessionRow);
	}

	resolve(reference: string): SessionAddress {
		const separator = reference.indexOf("#");
		if (separator < 1 || separator === reference.length - 1)
			throw new Error("Session recipient must be an explicit capability address");
		const sessionId = reference.slice(0, separator);
		const token = reference.slice(separator + 1);
		const row = this.database.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as
			| SessionRow
			| undefined;
		if (!row || row.receive_enabled !== 1 || !row.receive_token_sha256)
			throw new Error("Session recipient is unavailable");
		const actual = Buffer.from(createHash("sha256").update(token).digest("hex"));
		const expected = Buffer.from(row.receive_token_sha256);
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
			throw new Error("Session recipient capability is invalid");
		return fromSessionRow(row);
	}

	openAddress(sessionId: string): string {
		const token = `${randomUUID()}${randomUUID()}`;
		const result = this.database
			.prepare("UPDATE sessions SET receive_token_sha256 = ?, receive_enabled = 1 WHERE session_id = ?")
			.run(createHash("sha256").update(token).digest("hex"), sessionId);
		if (Number(result.changes) !== 1) throw new Error(`Session is not registered: ${sessionId}`);
		return `${sessionId}#${token}`;
	}

	closeAddress(sessionId: string): void {
		this.database
			.prepare("UPDATE sessions SET receive_token_sha256 = NULL, receive_enabled = 0 WHERE session_id = ?")
			.run(sessionId);
	}

	isAddressOpen(sessionId: string): boolean {
		const row = this.database.prepare("SELECT receive_enabled FROM sessions WHERE session_id = ?").get(sessionId) as
			| { receive_enabled: 0 | 1 }
			| undefined;
		return row?.receive_enabled === 1;
	}

	send(input: {
		senderSessionId: string;
		recipient: string;
		dedupeKey: string;
		subject: string;
		body: string;
		artifactRefs: string[];
	}): SessionEnvelope {
		if (Buffer.byteLength(input.body, "utf8") > 16_384) throw new RangeError("Session message exceeds 16 KiB");
		if (Buffer.byteLength(input.subject, "utf8") > 512)
			throw new RangeError("Session message subject exceeds 512 bytes");
		if (input.artifactRefs.length > 100) throw new RangeError("Session message has too many artifact references");
		return this.transaction(() => {
			const recipient = this.resolve(input.recipient);
			const quota = this.database
				.prepare(
					`SELECT COUNT(*) AS count, COALESCE(SUM(length(body)), 0) AS bytes
					 FROM session_messages WHERE recipient_session_id = ? AND state <> 'acknowledged'`,
				)
				.get(recipient.sessionId) as { count: number; bytes: number };
			if (quota.count >= 100 || quota.bytes + Buffer.byteLength(input.body, "utf8") > 524_288)
				throw new Error("Session recipient mailbox quota exceeded");
			const existing = this.database
				.prepare("SELECT * FROM session_messages WHERE sender_session_id = ? AND dedupe_key = ?")
				.get(input.senderSessionId, input.dedupeKey) as MessageRow | undefined;
			if (existing) {
				const envelope = fromMessageRow(existing);
				if (
					envelope.recipientSessionId !== recipient.sessionId ||
					envelope.subject !== input.subject ||
					envelope.body !== input.body ||
					JSON.stringify(envelope.artifactRefs) !== JSON.stringify(input.artifactRefs)
				)
					throw new Error(`Session message dedupe key was reused with different input: ${input.dedupeKey}`);
				return envelope;
			}
			const id = randomUUID();
			const now = new Date().toISOString();
			this.database
				.prepare(
					`INSERT INTO session_messages(
					 id, sender_session_id, recipient_session_id, subject, body, artifact_refs_json,
					 dedupe_key, state, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
				)
				.run(
					id,
					input.senderSessionId,
					recipient.sessionId,
					input.subject,
					input.body,
					JSON.stringify(input.artifactRefs),
					input.dedupeKey,
					now,
				);
			return this.requireMessage(id);
		});
	}

	claim(sessionId: string, limit = 20): SessionEnvelope[] {
		return this.transaction(() => {
			const rows = this.database
				.prepare(
					"SELECT * FROM session_messages WHERE recipient_session_id = ? AND state IN ('queued', 'delivered') ORDER BY created_at LIMIT ?",
				)
				.all(sessionId, limit) as unknown as MessageRow[];
			const now = new Date().toISOString();
			for (const row of rows) {
				if (row.state === "queued")
					this.database
						.prepare("UPDATE session_messages SET state = 'delivered', delivered_at = ? WHERE id = ?")
						.run(now, row.id);
			}
			return rows.map((row) => fromMessageRow({ ...row, state: "delivered" }));
		});
	}

	acknowledge(sessionId: string, ids: readonly string[]): void {
		this.transaction(() => {
			const now = new Date().toISOString();
			for (const id of ids) {
				const result = this.database
					.prepare(
						"UPDATE session_messages SET state = 'acknowledged', acknowledged_at = ? WHERE id = ? AND recipient_session_id = ? AND state = 'delivered'",
					)
					.run(now, id, sessionId);
				if (Number(result.changes) !== 1) throw new Error(`Cannot acknowledge undelivered Session message ${id}`);
			}
		});
	}

	listInbox(sessionId: string, limit = 50): SessionEnvelope[] {
		return (
			this.database
				.prepare("SELECT * FROM session_messages WHERE recipient_session_id = ? ORDER BY created_at DESC LIMIT ?")
				.all(sessionId, limit) as unknown as MessageRow[]
		).map(fromMessageRow);
	}

	pendingCount(sessionId: string): number {
		const row = this.database
			.prepare(
				"SELECT COUNT(*) AS count FROM session_messages WHERE recipient_session_id = ? AND state <> 'acknowledged'",
			)
			.get(sessionId) as { count: number };
		return row.count;
	}

	private requireMessage(id: string): SessionEnvelope {
		const row = this.database.prepare("SELECT * FROM session_messages WHERE id = ?").get(id) as
			| MessageRow
			| undefined;
		if (!row) throw new Error(`Session message not found: ${id}`);
		return fromMessageRow(row);
	}

	private transaction<T>(operation: () => T): T {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	private prune(): void {
		this.database
			.prepare(
				"DELETE FROM session_messages WHERE state = 'acknowledged' AND acknowledged_at < datetime('now', '-30 days')",
			)
			.run();
	}
}
