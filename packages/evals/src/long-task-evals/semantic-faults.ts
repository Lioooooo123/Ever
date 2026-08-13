import { type Static, Type } from "typebox";
import type { EvalEnvironment } from "./contracts.ts";
import type { DurableEventSource, EvalDurableEvent } from "./durable-events.ts";

const SemanticEventTypeSchema = Type.Union([
	Type.Literal("CheckpointSettled"),
	Type.Literal("ToolStarted"),
	Type.Literal("ToolFinished"),
	Type.Literal("RecoveryStarted"),
	Type.Literal("RecoveryFinished"),
	Type.Literal("TaskStateChanged"),
]);

export const SemanticFaultScenarioSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	trigger: Type.Union([
		Type.Object({
			source: Type.Literal("agent_event"),
			type: SemanticEventTypeSchema,
			where: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
			occurrence: Type.Integer({ minimum: 1 }),
			waitTimeoutSeconds: Type.Number({ exclusiveMinimum: 0 }),
		}),
		Type.Object({
			source: Type.Literal("environment_event"),
			type: Type.Literal("EffectCommitted"),
			where: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
			occurrence: Type.Integer({ minimum: 1 }),
			waitTimeoutSeconds: Type.Number({ exclusiveMinimum: 0 }),
		}),
	]),
	action: Type.Union([
		Type.Object({ type: Type.Literal("kill_worker"), signal: Type.Literal("SIGKILL") }),
		Type.Object({ type: Type.Literal("kill_daemon"), signal: Type.Literal("SIGKILL") }),
		Type.Object({ type: Type.Literal("pause_worker"), durationMs: Type.Integer({ minimum: 1 }) }),
		Type.Object({ type: Type.Literal("terminate_environment") }),
	]),
	expectation: Type.Union([
		Type.Object({
			kind: Type.Literal("eventual_completion"),
			maxRecoverySeconds: Type.Number({ exclusiveMinimum: 0 }),
		}),
		Type.Object({ kind: Type.Literal("fail_closed"), terminalState: Type.Literal("unknown_outcome") }),
	]),
});

export type SemanticFaultScenario = Static<typeof SemanticFaultScenarioSchema>;
export type SemanticFaultTrigger = SemanticFaultScenario["trigger"];
export type SemanticFaultAction = SemanticFaultScenario["action"];

export interface EnvironmentFaultEvent {
	schemaVersion: 1;
	seq: number;
	createdAt: string;
	type: "EffectCommitted";
	operationId: string;
	idempotencyKey: string;
	toolCallId: string;
	effect: "reconcilable_write" | "external_side_effect" | "process";
	toolName: string;
	toolErrored: boolean;
	domainCommitId: string;
	evidencePath: string;
	evidenceDigest: string;
	evidenceIncludes?: string;
	targetPath?: string;
	commandMarker?: string;
	payloadDigest: string;
	mac: string;
}

export interface EnvironmentFaultEventSource {
	armEnvironmentTrigger(trigger: SemanticFaultTrigger): void;
	readEnvironmentEvents(
		afterSeq: number,
	): Promise<readonly EnvironmentFaultEvent[]> | readonly EnvironmentFaultEvent[];
	releaseEnvironmentEvent(event: EnvironmentFaultEvent): Promise<void> | void;
}

export interface SemanticFaultSources {
	agent: DurableEventSource;
	environment?: EnvironmentFaultEventSource;
}

export interface SemanticFaultRecord {
	schemaVersion: 1;
	type: "FaultArmed" | "FaultTriggered" | "FaultApplied" | "FaultObserved";
	scenarioId: string;
	createdAt: string;
	eventSeq?: number;
	message?: string;
}

export interface SemanticFaultExecution {
	apply(action: SemanticFaultAction): Promise<void>;
}

export interface SemanticFaultResult {
	status: "observed" | "not_observed" | "cancelled" | "failed";
	matchedEvent?: EvalDurableEvent | EnvironmentFaultEvent;
	records: SemanticFaultRecord[];
	error?: string;
}

function matches(event: EvalDurableEvent | EnvironmentFaultEvent, trigger: SemanticFaultTrigger): boolean {
	if (event.type !== trigger.type) return false;
	const fields = event as unknown as Record<string, unknown>;
	return Object.entries(trigger.where).every(([key, value]) => fields[key] === value);
}

function record(
	records: SemanticFaultRecord[],
	scenarioId: string,
	type: SemanticFaultRecord["type"],
	eventSeq?: number,
	message?: string,
): void {
	records.push({
		schemaVersion: 1,
		type,
		scenarioId,
		createdAt: new Date().toISOString(),
		...(eventSeq === undefined ? {} : { eventSeq }),
		...(message === undefined ? {} : { message }),
	});
}

export class SemanticFaultController {
	readonly #pollIntervalMs: number;

	constructor(pollIntervalMs = 100) {
		if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1)
			throw new Error("Semantic fault poll interval must be a positive integer");
		this.#pollIntervalMs = pollIntervalMs;
	}

	async inject(
		scenario: SemanticFaultScenario,
		sources: SemanticFaultSources,
		execution: SemanticFaultExecution,
		signal: AbortSignal,
	): Promise<SemanticFaultResult> {
		if (!Number.isSafeInteger(scenario.trigger.occurrence) || scenario.trigger.occurrence < 1)
			throw new Error("Semantic fault occurrence must be a positive integer");
		if (!Number.isFinite(scenario.trigger.waitTimeoutSeconds) || scenario.trigger.waitTimeoutSeconds <= 0)
			throw new Error("Semantic fault wait timeout must be positive");
		const records: SemanticFaultRecord[] = [];
		record(records, scenario.id, "FaultArmed");
		const source = scenario.trigger.source === "agent_event" ? sources.agent : sources.environment;
		if (source === undefined) throw new Error("Environment-event fault trigger has no controlled event source");
		const deadline = Date.now() + scenario.trigger.waitTimeoutSeconds * 1000;
		let cursor = 0;
		let occurrences = 0;
		while (!signal.aborted && Date.now() < deadline) {
			const events =
				scenario.trigger.source === "agent_event"
					? (source as DurableEventSource).readDurableEvents(cursor)
					: await (source as EnvironmentFaultEventSource).readEnvironmentEvents(cursor);
			for (const event of events) {
				if (event.seq <= cursor) throw new Error("Durable event source returned a non-increasing sequence");
				cursor = event.seq;
				if (!matches(event, scenario.trigger)) continue;
				occurrences += 1;
				if (occurrences !== scenario.trigger.occurrence) {
					if (scenario.trigger.source === "environment_event") {
						await (sources.environment as EnvironmentFaultEventSource).releaseEnvironmentEvent(
							event as EnvironmentFaultEvent,
						);
					}
					continue;
				}
				record(records, scenario.id, "FaultTriggered", event.seq);
				try {
					await execution.apply(scenario.action);
					record(records, scenario.id, "FaultApplied", event.seq);
					record(records, scenario.id, "FaultObserved", event.seq);
					return { status: "observed", matchedEvent: event, records };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return { status: "failed", matchedEvent: event, records, error: message };
				} finally {
					if (
						scenario.trigger.source === "environment_event" &&
						scenario.action.type !== "terminate_environment"
					) {
						await (sources.environment as EnvironmentFaultEventSource).releaseEnvironmentEvent(
							event as EnvironmentFaultEvent,
						);
					}
				}
			}
			await new Promise((resolve) => setTimeout(resolve, this.#pollIntervalMs));
		}
		if (signal.aborted) return { status: "cancelled", records };
		return { status: "not_observed", records, error: "fault_not_injected" };
	}
}

async function requireSignal(label: string, result: { exitCode: number | null; stderr: string; timedOut: boolean }) {
	if (result.exitCode === 0 && !result.timedOut) return;
	throw new Error(`${label} failed: ${result.stderr.trim() || `exit ${result.exitCode ?? "unknown"}`}`);
}

export class EnvironmentSemanticFaultExecution implements SemanticFaultExecution {
	readonly #environment: EvalEnvironment;

	constructor(environment: EvalEnvironment) {
		this.#environment = environment;
	}

	async apply(action: SemanticFaultAction): Promise<void> {
		if (action.type === "terminate_environment") {
			await this.#environment.destroy();
			return;
		}
		const pattern = action.type === "kill_daemon" ? "[e]ver.*daemon.*serve" : "[e]ver.*task.*run";
		const found = await this.#environment.exec({ args: ["pgrep", "-o", "-f", pattern], timeoutSeconds: 30 });
		if (found.exitCode !== 0 || found.timedOut) throw new Error(`${action.type} target process was not found`);
		const pid = found.stdout.trim();
		if (!/^[1-9]\d*$/.test(pid)) throw new Error(`${action.type} returned an invalid PID`);
		const groupResult = await this.#environment.exec({ args: ["ps", "-o", "pgid=", "-p", pid], timeoutSeconds: 30 });
		if (groupResult.exitCode !== 0 || groupResult.timedOut)
			throw new Error(`${action.type} process group was not found`);
		const processGroup = groupResult.stdout.trim();
		if (!/^[1-9]\d*$/.test(processGroup)) throw new Error(`${action.type} returned an invalid process group`);
		const signal = action.type === "pause_worker" ? "STOP" : "KILL";
		await requireSignal(
			`${action.type} process group ${signal}`,
			await this.#environment.exec({ args: ["kill", `-${signal}`, `-${processGroup}`], timeoutSeconds: 30 }),
		);
		if (action.type !== "pause_worker") {
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				const alive = await this.#environment.exec({ args: ["kill", "-0", `-${processGroup}`], timeoutSeconds: 5 });
				if (alive.exitCode !== 0) return;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			throw new Error(`${action.type} target PID ${pid} remained alive`);
		}
		await new Promise((resolve) => setTimeout(resolve, action.durationMs));
		await requireSignal(
			"resume worker process group",
			await this.#environment.exec({ args: ["kill", "-CONT", `-${processGroup}`], timeoutSeconds: 30 }),
		);
	}
}
