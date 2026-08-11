import { Cron } from "croner";
import type { SqliteTaskStore } from "./store.ts";
import type { ScheduleClaim, ScheduleKind, ScheduleRecord } from "./types.ts";

function validateTimezone(timezone: string): void {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
	} catch {
		throw new Error(`Invalid IANA timezone: ${timezone}`);
	}
}

export function parseScheduleInterval(expression: string): number {
	const compact = expression.trim().toLowerCase();
	const match = /^(\d+)(s|m|h|d)$/.exec(compact);
	if (match) {
		const amount = Number(match[1]);
		const unit = match[2];
		const multiplier = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
		const milliseconds = amount * multiplier;
		if (Number.isSafeInteger(milliseconds) && milliseconds >= 1_000) return milliseconds;
	}
	const iso = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(expression.trim());
	if (iso) {
		const milliseconds = (Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0)) * 1_000;
		if (Number.isSafeInteger(milliseconds) && milliseconds >= 1_000) return milliseconds;
	}
	throw new Error(`Invalid interval duration: ${expression}`);
}

function cronFor(schedule: Pick<ScheduleRecord, "expression" | "timezone">): Cron {
	validateTimezone(schedule.timezone);
	return new Cron(schedule.expression, { timezone: schedule.timezone, mode: "5-part", paused: true });
}

export function firstScheduleRun(
	kind: ScheduleKind,
	expression: string,
	timezone: string,
	from: Date,
): string | undefined {
	validateTimezone(timezone);
	if (kind === "event") return undefined;
	if (kind === "once") {
		const timestamp = Date.parse(expression);
		if (!Number.isFinite(timestamp)) throw new Error("Once schedule requires an ISO date-time");
		return new Date(timestamp).toISOString();
	}
	if (kind === "interval") return new Date(from.getTime() + parseScheduleInterval(expression)).toISOString();
	const next = cronFor({ expression, timezone }).nextRun(from);
	if (!next) throw new Error("Cron schedule has no future occurrence");
	return next.toISOString();
}

function nextAfterClaim(schedule: ScheduleRecord, now: Date): { nextRunAt?: string; missedCount: number } {
	if (!schedule.nextRunAt) throw new Error(`Schedule ${schedule.id} has no due time`);
	const due = new Date(schedule.nextRunAt);
	if (schedule.kind === "once") return { missedCount: 1 };
	if (schedule.kind === "interval") {
		const interval = parseScheduleInterval(schedule.expression);
		const missedCount = Math.max(1, Math.floor((now.getTime() - due.getTime()) / interval) + 1);
		return { missedCount, nextRunAt: new Date(due.getTime() + missedCount * interval).toISOString() };
	}
	if (schedule.kind === "cron") {
		const cron = cronFor(schedule);
		const next = cron.nextRun(now);
		if (!next) throw new Error(`Cron schedule ${schedule.id} has no future occurrence`);
		const missedCount = Math.max(
			1,
			cron.previousRuns(1_000, now).filter((occurrence) => occurrence.getTime() >= due.getTime()).length,
		);
		return { missedCount, nextRunAt: next.toISOString() };
	}
	throw new Error("Event schedules are not claimed by time");
}

export class ScheduleEngine {
	private readonly store: SqliteTaskStore;
	private readonly now: () => Date;

	constructor(store: SqliteTaskStore, now: () => Date = () => new Date()) {
		this.store = store;
		this.now = now;
	}

	create(input: {
		taskId: string;
		agentId?: string;
		kind: ScheduleKind;
		expression: string;
		timezone: string;
		payload?: Record<string, unknown>;
	}): ScheduleRecord {
		return this.store.createSchedule({
			...input,
			nextRunAt: firstScheduleRun(input.kind, input.expression, input.timezone, this.now()),
		});
	}

	claimDue(limit = 100, eligible: (schedule: ScheduleRecord) => boolean = () => true): ScheduleClaim[] {
		const now = this.now();
		const claimedAt = now.toISOString();
		const claims: ScheduleClaim[] = [];
		for (const schedule of this.store.listDueSchedules(claimedAt, limit)) {
			if (!eligible(schedule)) continue;
			if (!schedule.nextRunAt) continue;
			const next = nextAfterClaim(schedule, now);
			const claim = this.store.claimSchedule({
				scheduleId: schedule.id,
				dueAt: schedule.nextRunAt,
				claimedAt,
				...next,
			});
			if (claim) claims.push(claim);
		}
		return claims;
	}

	claimEvents(limit = 100, eligible: (schedule: ScheduleRecord) => boolean = () => true): ScheduleClaim[] {
		const claimedAt = this.now().toISOString();
		const claims: ScheduleClaim[] = [];
		const claimedScheduleIds = new Set<string>();
		for (const trigger of this.store.listPendingEventScheduleTriggers(limit)) {
			if (claimedScheduleIds.has(trigger.schedule.id)) continue;
			if (!eligible(trigger.schedule)) continue;
			const claim = this.store.claimEventSchedule(trigger, claimedAt);
			if (claim) {
				claims.push(claim);
				claimedScheduleIds.add(trigger.schedule.id);
			}
		}
		return claims;
	}

	async deliverDue(
		deliver: (claim: ScheduleClaim) => Promise<boolean>,
		limit = 100,
		eligible: (schedule: ScheduleRecord) => boolean = () => true,
	): Promise<ScheduleClaim[]> {
		const claims = this.claimDue(limit, eligible);
		for (const claim of claims) {
			if (await deliver(claim))
				this.store.markScheduleDelivered(claim.schedule.id, claim.claimId, this.now().toISOString());
		}
		return claims;
	}

	async deliverEvents(
		deliver: (claim: ScheduleClaim) => Promise<boolean>,
		limit = 100,
		eligible: (schedule: ScheduleRecord) => boolean = () => true,
	): Promise<ScheduleClaim[]> {
		const claims = this.claimEvents(limit, eligible);
		for (const claim of claims) {
			if (await deliver(claim))
				this.store.markScheduleDelivered(claim.schedule.id, claim.claimId, this.now().toISOString());
		}
		return claims;
	}
}
