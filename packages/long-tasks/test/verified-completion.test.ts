import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInMemoryTaskStore, EvidenceResolver, TaskController, VerifiedCompletion } from "../src/index.ts";

function createTask(workspaceRoot: string, acceptance: Parameters<TaskController["create"]>[0]["acceptance"]) {
	const store = createInMemoryTaskStore();
	const task = new TaskController(store).create({
		title: "verified completion",
		goal: "finish exactly once",
		acceptance,
		budget: { maxTurns: 5, maxWallTimeMinutes: 60 },
		workspaceRoot,
		workspaceFingerprint: "test",
	});
	return { store, task };
}

describe("VerifiedCompletion", () => {
	it("executes a command criterion once and replays the durable result", () => {
		const root = mkdtempSync(join(tmpdir(), "ever-verified-completion-"));
		const marker = join(root, "runs.txt");
		const { store, task } = createTask(root, [
			{
				id: "command",
				kind: "command",
				command: `printf 'run\\n' >> ${JSON.stringify(marker)}`,
				cwd: ".",
				timeoutSeconds: 5,
			},
		]);
		const completion = new VerifiedCompletion(store);
		const input = { taskId: task.id, requestId: "tool-call-1", summary: "done", evidence: [] } as const;

		const first = completion.request(input);
		const replay = completion.request(input);

		expect(first).toMatchObject({ accepted: true, replayed: false });
		expect(replay).toMatchObject({ accepted: true, replayed: true });
		expect(readFileSync(marker, "utf8").trim().split("\n")).toEqual(["run"]);
		expect(store.listEvents(task.id, 0, 100).filter((event) => event.type === "AcceptanceRequested")).toHaveLength(1);
		store.close();
	});

	it("does not repeat a command whose persisted start has an unknown outcome", () => {
		const root = mkdtempSync(join(tmpdir(), "ever-verified-completion-"));
		const marker = join(root, "must-not-run.txt");
		const { store, task } = createTask(root, [
			{
				id: "command",
				kind: "command",
				command: `printf run > ${JSON.stringify(marker)}`,
				cwd: ".",
				timeoutSeconds: 5,
			},
		]);
		const input = { taskId: task.id, requestId: "interrupted", summary: "done", evidence: [] } as const;
		store.beginVerifiedCompletion(input);

		const result = new VerifiedCompletion(store).request(input);

		expect(result).toMatchObject({ accepted: false, replayed: true });
		expect(result.acceptance.outcomeUnknown).toEqual(["completion_request"]);
		expect(existsSync(marker)).toBe(false);
		store.close();
	});

	it("resolves an event beyond the former 10,000 event window", () => {
		const { store, task } = createTask(process.cwd(), []);
		let targetSeq = 0;
		for (let index = 0; index < 12_001; index++) {
			targetSeq = store.appendTaskEvent(task.id, "BenchmarkEvent", { index });
		}
		const target = store.listEvents(task.id, targetSeq - 1, 1)[0]!;

		const result = new EvidenceResolver(store).resolve(task.id, [
			{ id: "late-event", kind: "event", ref: target.id },
		]);

		expect(result[0]).toMatchObject({ verified: true });
		store.close();
	});

	it("treats the latest failed acceptance fact as authoritative", () => {
		const { store, task } = createTask(process.cwd(), [{ id: "artifact", kind: "artifact", path: "result.txt" }]);
		store.recordAcceptance(task.id, "artifact", true, { source: "old" });
		store.recordAcceptance(task.id, "artifact", false, { source: "new" });

		expect(store.hasPassedAcceptance(task.id, "artifact")).toBe(false);
		expect(
			new EvidenceResolver(store).resolve(task.id, [{ id: "command", kind: "command", ref: "artifact" }])[0],
		).toMatchObject({ verified: false });
		store.close();
	});
});
