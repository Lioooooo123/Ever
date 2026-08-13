import { describe, expect, it } from "vitest";
import type {
	EnvironmentCommand,
	EnvironmentCommandResult,
	EvalEnvironment,
} from "../../src/long-task-evals/contracts.ts";
import type { DurableEventSource, EvalDurableEvent } from "../../src/long-task-evals/durable-events.ts";
import {
	type EnvironmentFaultEvent,
	type EnvironmentFaultEventSource,
	EnvironmentSemanticFaultExecution,
	SemanticFaultController,
	type SemanticFaultScenario,
} from "../../src/long-task-evals/semantic-faults.ts";

function checkpoint(seq: number, checkpointId: string): EvalDurableEvent {
	return {
		schemaVersion: 1,
		seq,
		taskId: "task-1",
		attemptId: "attempt-1",
		executionId: "execution-1",
		fencingToken: 1,
		createdAt: "2026-08-13T00:00:00.000Z",
		type: "CheckpointSettled",
		checkpointId,
	};
}

class MutableSource implements DurableEventSource {
	readonly events: EvalDurableEvent[] = [];

	readDurableEvents(afterSeq: number): readonly EvalDurableEvent[] {
		return this.events.filter((event) => event.seq > afterSeq);
	}
}

class ProcessEnvironment implements EvalEnvironment {
	readonly identity = {
		kind: "docker" as const,
		imageDigest: "sha256:test",
		platform: "linux/arm64" as const,
		network: "none" as const,
	};
	readonly commands: string[][] = [];
	#aliveChecks = 0;

	async exec(command: EnvironmentCommand): Promise<EnvironmentCommandResult> {
		this.commands.push(command.args);
		if (command.args[0] === "pgrep") return { exitCode: 0, stdout: "123\n", stderr: "", timedOut: false };
		if (command.args[0] === "ps") return { exitCode: 0, stdout: "  456\n", stderr: "", timedOut: false };
		if (command.args[0] === "kill" && command.args[1] === "-0") {
			this.#aliveChecks += 1;
			return { exitCode: this.#aliveChecks === 1 ? 0 : 1, stdout: "", stderr: "", timedOut: false };
		}
		return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
	}

	async copyIn(): Promise<void> {}
	async copyOut(): Promise<void> {}
	async readFile(): Promise<string | undefined> {
		return undefined;
	}
	async destroy(): Promise<void> {}
}

const scenario: SemanticFaultScenario = {
	id: "checkpoint-two",
	trigger: {
		source: "agent_event",
		type: "CheckpointSettled",
		where: {},
		occurrence: 2,
		waitTimeoutSeconds: 1,
	},
	action: { type: "kill_worker", signal: "SIGKILL" },
	expectation: { kind: "eventual_completion", maxRecoverySeconds: 30 },
};

describe("SemanticFaultController", () => {
	it.each([1, 20])("matches the same semantic boundary with %ims event timing", async (delayMs) => {
		const source = new MutableSource();
		const applied: string[] = [];
		const controller = new SemanticFaultController(1);
		setTimeout(() => source.events.push(checkpoint(10, "checkpoint-1")), delayMs);
		setTimeout(() => source.events.push(checkpoint(20, "checkpoint-2")), delayMs * 2);
		const result = await controller.inject(
			scenario,
			{ agent: source },
			{ apply: async (action) => void applied.push(action.type) },
			new AbortController().signal,
		);

		expect(result.status).toBe("observed");
		expect(result.matchedEvent?.seq).toBe(20);
		expect(applied).toEqual(["kill_worker"]);
		expect(result.records.map((record) => record.type)).toEqual([
			"FaultArmed",
			"FaultTriggered",
			"FaultApplied",
			"FaultObserved",
		]);
	});

	it("returns fault_not_injected when the trigger is not observed", async () => {
		const result = await new SemanticFaultController(1).inject(
			{ ...scenario, trigger: { ...scenario.trigger, waitTimeoutSeconds: 0.01 } },
			{ agent: new MutableSource() },
			{ apply: async () => {} },
			new AbortController().signal,
		);
		expect(result).toMatchObject({ status: "not_observed", error: "fault_not_injected" });
	});

	it("applies an environment fault after EffectCommitted and releases the response barrier", async () => {
		const source = new MutableSource();
		const event: EnvironmentFaultEvent = {
			schemaVersion: 1,
			seq: 1,
			createdAt: "2026-08-13T00:00:00.000Z",
			type: "EffectCommitted",
			operationId: "12:tool-1",
			idempotencyKey: "task-1:tool-1",
			toolCallId: "tool-1",
			effect: "reconcilable_write",
			toolName: "write",
			toolErrored: false,
			domainCommitId: "source:/app/src/cli.mjs",
			evidencePath: "/app/src/cli.mjs",
			evidenceDigest: "c".repeat(64),
			payloadDigest: "a".repeat(64),
			mac: "b".repeat(64),
		};
		const released: string[] = [];
		const environment: EnvironmentFaultEventSource = {
			armEnvironmentTrigger: () => {},
			readEnvironmentEvents: () => [event],
			releaseEnvironmentEvent: (matched) => void released.push(matched.operationId),
		};
		const applied: string[] = [];
		const result = await new SemanticFaultController(1).inject(
			{
				id: "committed-write",
				trigger: {
					source: "environment_event",
					type: "EffectCommitted",
					where: { effect: "reconcilable_write" },
					occurrence: 1,
					waitTimeoutSeconds: 1,
				},
				action: { type: "kill_worker", signal: "SIGKILL" },
				expectation: { kind: "eventual_completion", maxRecoverySeconds: 30 },
			},
			{ agent: source, environment },
			{ apply: async (action) => void applied.push(action.type) },
			new AbortController().signal,
		);

		expect(result).toMatchObject({ status: "observed", matchedEvent: event });
		expect(applied).toEqual(["kill_worker"]);
		expect(released).toEqual(["12:tool-1"]);
	});

	it("releases earlier environment barriers while waiting for the selected occurrence", async () => {
		const source = new MutableSource();
		const environmentEvents: EnvironmentFaultEvent[] = [1, 2].map((seq) => ({
			schemaVersion: 1,
			seq,
			createdAt: "2026-08-13T00:00:00.000Z",
			type: "EffectCommitted",
			operationId: `operation-${seq}`,
			idempotencyKey: `key-${seq}`,
			toolCallId: `tool-${seq}`,
			effect: "reconcilable_write",
			toolName: "write",
			toolErrored: false,
			domainCommitId: "source:/app/src/cli.mjs",
			evidencePath: "/app/src/cli.mjs",
			evidenceDigest: "c".repeat(64),
			payloadDigest: "a".repeat(64),
			mac: "b".repeat(64),
		}));
		const released: string[] = [];
		const environment: EnvironmentFaultEventSource = {
			armEnvironmentTrigger: () => {},
			readEnvironmentEvents: (afterSeq) => environmentEvents.filter((event) => event.seq > afterSeq),
			releaseEnvironmentEvent: (event) => void released.push(event.operationId),
		};
		const applied: string[] = [];
		const result = await new SemanticFaultController(1).inject(
			{
				id: "second-write",
				trigger: {
					source: "environment_event",
					type: "EffectCommitted",
					where: { effect: "reconcilable_write" },
					occurrence: 2,
					waitTimeoutSeconds: 1,
				},
				action: { type: "kill_worker", signal: "SIGKILL" },
				expectation: { kind: "eventual_completion", maxRecoverySeconds: 30 },
			},
			{ agent: source, environment },
			{ apply: async (action) => void applied.push(action.type) },
			new AbortController().signal,
		);

		expect(result.matchedEvent?.seq).toBe(2);
		expect(applied).toEqual(["kill_worker"]);
		expect(released).toEqual(["operation-1", "operation-2"]);
	});

	it("confirms the exact target PID has stopped", async () => {
		const environment = new ProcessEnvironment();
		await new EnvironmentSemanticFaultExecution(environment).apply({ type: "kill_worker", signal: "SIGKILL" });
		expect(environment.commands).toEqual([
			["pgrep", "-o", "-f", "[e]ver.*task.*run"],
			["ps", "-o", "pgid=", "-p", "123"],
			["kill", "-KILL", "-456"],
			["kill", "-0", "-456"],
			["kill", "-0", "-456"],
		]);
	});
});
