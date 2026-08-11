import { describe, expect, it } from "vitest";
import { createInMemoryTaskStore, ScheduleEngine, TaskController } from "../src/index.ts";

function setup(now: Date) {
	const store = createInMemoryTaskStore(() => now);
	const task = new TaskController(store).create({
		title: "scheduled task",
		goal: "check state",
		acceptance: [{ id: "manual", kind: "manual", description: "reviewed" }],
		budget: { maxTurns: 20, maxWallTimeMinutes: 60 },
		workspaceRoot: "/repo",
		workspaceFingerprint: "fingerprint",
	});
	return { store, task };
}

describe("ScheduleEngine", () => {
	it("claims before delivery and never replays an uncertain once tick", async () => {
		let now = new Date("2026-08-11T00:00:00.000Z");
		const { store, task } = setup(now);
		const engine = new ScheduleEngine(store, () => now);
		const schedule = engine.create({
			taskId: task.id,
			kind: "once",
			expression: "2026-08-11T00:01:00.000Z",
			timezone: "UTC",
		});
		now = new Date("2026-08-11T00:02:00.000Z");
		expect(await engine.deliverDue(async () => false)).toHaveLength(1);
		expect(store.requireSchedule(schedule.id).state).toBe("completed");
		expect(store.requireSchedule(schedule.id).lastDeliveredAt).toBeUndefined();
		expect(engine.claimDue()).toEqual([]);
		store.close();
	});

	it("coalesces missed interval ticks and advances beyond now", () => {
		let now = new Date("2026-08-11T00:00:00.000Z");
		const { store, task } = setup(now);
		const engine = new ScheduleEngine(store, () => now);
		engine.create({ taskId: task.id, kind: "interval", expression: "10m", timezone: "Asia/Shanghai" });
		now = new Date("2026-08-11T00:55:00.000Z");
		const [claim] = engine.claimDue();
		expect(claim).toMatchObject({ missedCount: 5 });
		expect(claim?.schedule.nextRunAt).toBe("2026-08-11T01:00:00.000Z");
		store.close();
	});

	it("records delivery independently for each recurring claim", async () => {
		let now = new Date("2026-08-11T00:00:00.000Z");
		const { store, task } = setup(now);
		const engine = new ScheduleEngine(store, () => now);
		const schedule = engine.create({ taskId: task.id, kind: "interval", expression: "10m", timezone: "UTC" });
		now = new Date("2026-08-11T00:10:00.000Z");
		await engine.deliverDue(async () => true);
		const firstDelivery = store.requireSchedule(schedule.id).lastDeliveredAt;
		now = new Date("2026-08-11T00:20:00.000Z");
		await engine.deliverDue(async () => true);
		expect(store.requireSchedule(schedule.id).lastDeliveredAt).toBe("2026-08-11T00:20:00.000Z");
		expect(store.requireSchedule(schedule.id).lastDeliveredAt).not.toBe(firstDelivery);
		store.close();
	});

	it("uses five-part cron expressions with IANA timezone handling", () => {
		const now = new Date("2026-03-07T14:00:00.000Z");
		const { store, task } = setup(now);
		const schedule = new ScheduleEngine(store, () => now).create({
			taskId: task.id,
			kind: "cron",
			expression: "30 9 * * *",
			timezone: "America/New_York",
		});
		expect(schedule.nextRunAt).toBe("2026-03-07T14:30:00.000Z");
		store.close();
	});

	it("persistently claims matching future events without self-triggering on schedule events", async () => {
		let now = new Date("2026-08-11T00:00:00.000Z");
		const { store, task } = setup(now);
		const engine = new ScheduleEngine(store, () => now);
		const schedule = engine.create({
			taskId: task.id,
			kind: "event",
			expression: "ProviderRecovered",
			timezone: "UTC",
		});
		expect(schedule.nextRunAt).toBeUndefined();
		expect(engine.claimEvents()).toEqual([]);
		store.appendTaskEvent(task.id, "ProviderTimedOut", { schemaVersion: 1 });
		store.appendTaskEvent(task.id, "ProviderRecovered", { schemaVersion: 1 });
		store.appendTaskEvent(task.id, "ProviderRecovered", { retry: 2, schemaVersion: 1 });
		now = new Date("2026-08-11T00:01:00.000Z");
		const delivered: string[] = [];
		expect(
			await engine.deliverEvents(async (claim) => {
				delivered.push(claim.claimId);
				return true;
			}),
		).toHaveLength(1);
		expect(delivered).toHaveLength(1);
		expect(store.requireSchedule(schedule.id)).toMatchObject({
			state: "active",
			lastDeliveredAt: now.toISOString(),
		});
		expect(await engine.deliverEvents(async () => true)).toHaveLength(1);
		expect(engine.claimEvents()).toEqual([]);
		store.close();
	});
});
