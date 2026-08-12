import { createHash } from "node:crypto";
import { createInMemoryTaskStore, ScheduleEngine, TaskController } from "@ever/long-tasks";
import { describe, expect, it } from "vitest";
import { SequencedEventBuffer } from "../src/daemon/event-stream.ts";
import { createDaemonCommand, daemonCommandPayloadSha256, parseDaemonCommand } from "../src/daemon/protocol.ts";
import { deriveWorkerToken } from "../src/daemon/supervisor-credentials.ts";

const EIGHT_HOURS_IN_SECONDS = 8 * 60 * 60;

describe("eight-hour control-plane soak", () => {
	it(
		"keeps replay and recovery state bounded across one-second cycles with injected failures",
		async () => {
			const realtime = process.env.EVER_SOAK_REALTIME === "1";
			const configuredSeconds = Number(process.env.EVER_SOAK_DURATION_SECONDS ?? EIGHT_HOURS_IN_SECONDS);
			if (!Number.isSafeInteger(configuredSeconds) || configuredSeconds < 1)
				throw new Error("Invalid EVER_SOAK_DURATION_SECONDS");
			let now = new Date("2026-08-11T00:00:00.000Z");
			const store = createInMemoryTaskStore(() => now);
			const task = new TaskController(store).create({
				title: "soak",
				goal: "remain stable under control-plane faults",
				acceptance: [],
				budget: { maxTurns: 100_000, maxWallTimeMinutes: 600 },
				workspaceRoot: "/repo",
				workspaceFingerprint: "fingerprint",
			});
			const schedule = new ScheduleEngine(store, () => now).create({
				taskId: task.id,
				kind: "event",
				expression: "ProviderRecovered",
				timezone: "UTC",
			});
			const events = new SequencedEventBuffer<Record<string, unknown>>(128, "generation-0", () => now, 65_536);
			const initialCursor = events.currentCursor();
			const ownerToken = createHash("sha256").update("soak-owner").digest("hex");
			let generation = 0;
			let workerToken = deriveWorkerToken(ownerToken, "worker-1", `generation-${generation}`);
			let providerRecoveries = 0;

			for (let tick = 1; tick <= configuredSeconds; tick++) {
				if (realtime) await new Promise((resolve) => setTimeout(resolve, 1_000));
				now = new Date(now.getTime() + 1_000);
				events.publish("WorkerHeartbeat", { tick });

				if (tick % 60 === 0) {
					const command = createDaemonCommand(
						{ command: "status" },
						{ clientId: "soak-cli", commandId: `reconnect-${tick}` },
					);
					parseDaemonCommand(command);
					store.receiveDaemonCommand({
						clientId: command.clientId,
						commandId: command.commandId,
						commandType: command.command,
						payloadSha256: daemonCommandPayloadSha256(command),
						payload: command.payload,
					});
					store.markDaemonCommandDispatched(command.clientId, command.commandId);
					store.completeDaemonCommand(command.clientId, command.commandId, { ok: true });
				}

				if (tick % 900 === 1) store.appendTaskEvent(task.id, "ProviderTimedOut", { tick, schemaVersion: 1 });
				if (tick % 900 === 2) {
					store.appendTaskEvent(task.id, "ProviderRecovered", { tick, schemaVersion: 1 });
					for (const claim of new ScheduleEngine(store, () => now).claimEvents()) {
						store.markScheduleDelivered(schedule.id, claim.claimId, now.toISOString());
						providerRecoveries += 1;
					}
				}

				if (tick % 3_600 === 0) {
					const oldToken = workerToken;
					generation += 1;
					workerToken = deriveWorkerToken(ownerToken, "worker-1", `generation-${generation}`);
					expect(workerToken).not.toBe(oldToken);
					events.publish("SupervisorRestarted", { generation });
				}
				if (tick === Math.floor(configuredSeconds / 2)) events.publish("WorkerCrashed", { tick });
			}

			expect(providerRecoveries).toBe(Math.floor((configuredSeconds - 2) / 900) + 1);
			expect(events.replay(initialCursor).status).toBe(configuredSeconds > 128 ? "snapshot_required" : "complete");
			if (configuredSeconds >= 2) expect(store.requireSchedule(schedule.id).lastDeliveredAt).toBeDefined();
			if (configuredSeconds >= 60) {
				expect(
					store.getDaemonCommand("soak-cli", `reconnect-${Math.floor(configuredSeconds / 60) * 60}`),
				).toMatchObject({ state: "completed" });
			}
			store.close();
		},
		EIGHT_HOURS_IN_SECONDS * 1_000 + 60_000,
	);
});
