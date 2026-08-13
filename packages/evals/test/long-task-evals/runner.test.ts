import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type EvalJobManifest, LongTaskArtifactStore } from "../../src/long-task-evals/artifacts.ts";
import { assertEvalJobPassed } from "../../src/long-task-evals/cli.ts";
import type {
	AgentAdapter,
	AgentRunOutcome,
	BenchmarkAdapter,
	EnvironmentAdapter,
	EnvironmentCommand,
	EnvironmentCommandResult,
	EvalEnvironment,
	OfficialVerification,
} from "../../src/long-task-evals/contracts.ts";
import type { EvalDurableEvent } from "../../src/long-task-evals/durable-events.ts";
import { runProcess } from "../../src/long-task-evals/process.ts";
import { LongTaskEvalRunner } from "../../src/long-task-evals/runner.ts";
import type { AgentIdentity, EvalCase, EvalRunResult } from "../../src/long-task-evals/schemas.ts";
import { assertEvalCase } from "../../src/long-task-evals/schemas.ts";
import { SemanticFaultController } from "../../src/long-task-evals/semantic-faults.ts";
import { selectDeterministicCases } from "../../src/long-task-evals/task-selection.ts";
import type { LongHorizonTrialPlan } from "../../src/long-task-evals/trial-plans.ts";

const digest = (character: string): string => character.repeat(64);
const benchmark = { name: "fake", version: "1.0.0", source: "local", resolvedDigest: digest("a") };

function testCase(id = "case-1"): EvalCase {
	return {
		schemaVersion: 1,
		benchmark,
		id,
		instruction: `solve ${id}`,
		taskRoot: `/fake/${id}`,
		environment: {
			kind: "docker",
			buildContext: `/fake/${id}/environment`,
			workingDirectory: "/app",
			network: "none",
		},
		verifier: { command: ["verify"], testsSource: `/fake/${id}/tests`, timeoutSeconds: 30 },
		limits: { trialTimeoutSeconds: 60, maxCostUsd: 1 },
		metadata: { verifierDigest: digest("b"), taskDigest: digest("e") },
	};
}

class FakeEnvironment implements EvalEnvironment {
	readonly identity = {
		kind: "docker" as const,
		imageDigest: "sha256:fake",
		platform: "linux/arm64" as const,
		network: "none" as const,
	};
	destroyed = false;
	testsVisible = false;

	async exec(command: EnvironmentCommand): Promise<EnvironmentCommandResult> {
		if (command.args.join(" ") === "test ! -e /tests") {
			return { exitCode: this.testsVisible ? 1 : 0, stdout: "", stderr: "", timedOut: false };
		}
		return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
	}

	async copyIn(_source: string, destination: string): Promise<void> {
		if (destination === "/tests") this.testsVisible = true;
	}

	async copyOut(_source: string, destination: string): Promise<void> {
		await mkdir(destination, { recursive: true });
	}

	async readFile(_path: string): Promise<string | undefined> {
		return undefined;
	}

	async destroy(): Promise<void> {
		this.destroyed = true;
	}
}

class FakeEnvironmentAdapter implements EnvironmentAdapter {
	preflightCalls = 0;
	created: FakeEnvironment[] = [];

	async preflight(): Promise<void> {
		this.preflightCalls += 1;
	}

	async create(_testCase: EvalCase, _runDirectory: string): Promise<EvalEnvironment> {
		const environment = new FakeEnvironment();
		this.created.push(environment);
		return environment;
	}
}

class FakeBenchmark implements BenchmarkAdapter {
	readonly #cases: EvalCase[];

	constructor(cases: EvalCase[]) {
		this.#cases = cases;
	}

	async listCases(): Promise<EvalCase[]> {
		return this.#cases;
	}

	async verify(
		_testCase: EvalCase,
		environment: EvalEnvironment,
		_runDirectory: string,
	): Promise<OfficialVerification> {
		await environment.copyIn("hidden", "/tests");
		return { valid: true, metrics: { reward: 1 }, exitCode: 0, errors: [] };
	}
}

class RetryOnceBenchmark extends FakeBenchmark {
	verifications = 0;

	override async verify(
		testCase: EvalCase,
		environment: EvalEnvironment,
		runDirectory: string,
	): Promise<OfficialVerification> {
		this.verifications += 1;
		await super.verify(testCase, environment, runDirectory);
		return this.verifications === 1
			? {
					valid: false,
					metrics: {},
					errors: [{ source: "verifier", code: "invalid_report", message: "fixture" }],
				}
			: { valid: true, metrics: { reward: 1 }, exitCode: 0, errors: [] };
	}
}

class FakeAgent implements AgentAdapter {
	readonly identity: AgentIdentity;
	runs = 0;

	constructor(name: string) {
		this.identity = {
			name,
			version: "1.0.0",
			executableDigest: digest("c"),
			modelProvider: "fake-provider",
			modelId: "fake-model-2026-01-01",
			configurationDigest: digest("d"),
		};
	}

	async run(_testCase: EvalCase, environment: EvalEnvironment, _runDirectory: string): Promise<AgentRunOutcome> {
		this.runs += 1;
		expect((environment as FakeEnvironment).testsVisible).toBe(false);
		return { outcome: "completed", usage: { totalTokens: 10, estimatedCostUsd: 0.01 }, errors: [] };
	}

	async stop(_reason: "timeout" | "cancelled" | "fault"): Promise<void> {}
}

class DurableFakeAgent extends FakeAgent {
	#events: EvalDurableEvent[] = [];

	readDurableEvents(afterSeq: number): readonly EvalDurableEvent[] {
		return this.#events.filter((event) => event.seq > afterSeq);
	}

	override async run(
		_testCase: EvalCase,
		_environment: EvalEnvironment,
		_runDirectory: string,
	): Promise<AgentRunOutcome> {
		this.runs += 1;
		const base = {
			schemaVersion: 1 as const,
			taskId: "case-1",
			attemptId: `attempt-${this.runs}`,
			executionId: `execution-${this.runs}`,
			fencingToken: this.runs,
		};
		this.#events = [
			{
				...base,
				seq: 2,
				createdAt: "2026-08-13T00:00:00.000Z",
				type: "CheckpointSettled",
				checkpointId: "before-fault",
			},
			{
				...base,
				seq: 3,
				createdAt: "2026-08-13T00:00:01.000Z",
				type: "RecoveryStarted",
			},
			{
				...base,
				seq: 4,
				createdAt: "2026-08-13T00:00:02.000Z",
				type: "RecoveryFinished",
				outcome: "succeeded",
			},
			{
				...base,
				seq: 5,
				createdAt: "2026-08-13T00:00:03.000Z",
				type: "CheckpointSettled",
				checkpointId: "after-recovery",
			},
		];
		return {
			outcome: "completed",
			usage: { estimatedCostUsd: 0.01 },
			ever: {
				taskId: "case-1",
				terminalState: "completed",
				turns: 2,
				checkpoints: 2,
				recoveries: 1,
				unknownToolOutcomes: 0,
				duplicateSideEffects: 0,
			},
			errors: [],
		};
	}
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("long-task Eval runner", () => {
	it("runs agents sequentially, hides tests, persists results, and resumes without duplicates", async () => {
		const root = await mkdtemp(join(tmpdir(), "ever-eval-test-"));
		temporaryDirectories.push(root);
		const cases = [testCase()];
		const agents = [new FakeAgent("ever"), new FakeAgent("codex"), new FakeAgent("terminus-2")];
		const manifest: EvalJobManifest = {
			schemaVersion: 1,
			jobId: "job-1",
			createdAt: "2026-08-11T00:00:00.000Z",
			benchmark,
			agents: agents.map((agent) => agent.identity),
			caseIds: ["case-1"],
			repetitions: 2,
			maxCostUsd: 10,
		};
		const store = new LongTaskArtifactStore(root, manifest.jobId);
		const environmentAdapter = new FakeEnvironmentAdapter();
		const runner = new LongTaskEvalRunner(new FakeBenchmark(cases), environmentAdapter, store);

		const first = await runner.run({ manifest, cases, agents });
		expect(first).toHaveLength(6);
		expect(agents.map((agent) => agent.runs)).toEqual([2, 2, 2]);
		expect(environmentAdapter.created.every((environment) => environment.destroyed)).toBe(true);
		expect((await readFile(store.resultsPath, "utf8")).trim().split("\n")).toHaveLength(6);

		const second = await runner.run({ manifest, cases, agents });
		expect(second).toHaveLength(6);
		expect(agents.map((agent) => agent.runs)).toEqual([2, 2, 2]);
		expect(await readFile(join(store.jobDirectory, "comparison.md"), "utf8")).toContain("ever");
	});

	it("rejects model-backed jobs without a cost budget before environment preflight", async () => {
		const root = await mkdtemp(join(tmpdir(), "ever-eval-test-"));
		temporaryDirectories.push(root);
		const agent = new FakeAgent("ever");
		const environmentAdapter = new FakeEnvironmentAdapter();
		const manifest: EvalJobManifest = {
			schemaVersion: 1,
			jobId: "job-no-budget",
			createdAt: "2026-08-11T00:00:00.000Z",
			benchmark,
			agents: [agent.identity],
			caseIds: ["case-1"],
			repetitions: 1,
		};
		const runner = new LongTaskEvalRunner(
			new FakeBenchmark([testCase()]),
			environmentAdapter,
			new LongTaskArtifactStore(root, manifest.jobId),
		);

		await expect(runner.run({ manifest, cases: [testCase()], agents: [agent] })).rejects.toThrow("maxCostUsd");
		expect(environmentAdapter.preflightCalls).toBe(0);
	});

	it("rejects completed jobs when an official result does not pass", async () => {
		const root = await mkdtemp(join(tmpdir(), "ever-eval-test-"));
		temporaryDirectories.push(root);
		const agent = new FakeAgent("ever");
		const manifest: EvalJobManifest = {
			schemaVersion: 1,
			jobId: "job-failed-official-result",
			createdAt: "2026-08-11T00:00:00.000Z",
			benchmark,
			agents: [agent.identity],
			caseIds: ["case-1"],
			repetitions: 1,
			maxCostUsd: 1,
		};
		const results = await new LongTaskEvalRunner(
			new FakeBenchmark([testCase()]),
			new FakeEnvironmentAdapter(),
			new LongTaskArtifactStore(root, manifest.jobId),
		).run({ manifest, cases: [testCase()], agents: [agent] });
		const failed = [{ ...results[0]!, official: { ...results[0]!.official, metrics: { reward: 0 } } }];

		expect(() => assertEvalJobPassed(results)).not.toThrow();
		expect(() => assertEvalJobPassed(failed)).toThrow("1/1 runs did not pass");
	});

	it("accepts a fail-closed unknown outcome with only its expected Ever diagnostic", () => {
		const result: EvalRunResult = {
			schemaVersion: 1,
			runId: "fail-closed-run",
			caseId: "case-1",
			repetition: 1,
			benchmark,
			agent: new FakeAgent("ever").identity,
			environment: new FakeEnvironment().identity,
			outcome: "unknown_outcome",
			official: { valid: true, metrics: { reward: 1 } },
			usage: { wallTimeMs: 1 },
			integrity: {
				environmentDigest: "sha256:fake",
				instructionDigest: digest("1"),
				verifierDigest: digest("2"),
				artifactsDigest: digest("3"),
				violations: [],
			},
			longHorizon: {
				planId: digest("4"),
				pairId: digest("5"),
				lane: "resilience",
				variant: "fault",
				scenarioId: "external-effect",
				valid: true,
				verdict: { capabilityPass: false, safetyPass: true, terminalSemanticsPass: true },
				recovery: {
					triggerMatched: true,
					faultApplied: true,
					recoveryCount: 0,
					duplicateSideEffects: 0,
					forbiddenReplays: 0,
					unknownToolOutcomes: 1,
				},
				verifier: { started: true, completed: true, reportDigest: digest("6") },
				scoreStateDigest: digest("7"),
			},
			artifacts: [],
			errors: [{ source: "ever", code: "unknown_outcome", message: "Ever ended in unknown_outcome" }],
		};

		expect(() => assertEvalJobPassed([result])).not.toThrow();
		expect(() =>
			assertEvalJobPassed([
				{ ...result, errors: [...result.errors, { source: "verifier", code: "failed", message: "bad" }] },
			]),
		).toThrow("1/1 runs did not pass");
	});

	it("runs paired semantic plans and persists continuity evidence", async () => {
		const root = await mkdtemp(join(tmpdir(), "ever-eval-test-"));
		temporaryDirectories.push(root);
		const agent = new DurableFakeAgent("ever");
		const scenario = {
			id: "checkpoint-fault",
			trigger: {
				source: "agent_event" as const,
				type: "CheckpointSettled" as const,
				where: { checkpointId: "before-fault" },
				occurrence: 1,
				waitTimeoutSeconds: 1,
			},
			action: { type: "kill_worker" as const, signal: "SIGKILL" as const },
			expectation: { kind: "eventual_completion" as const, maxRecoverySeconds: 30 },
		};
		const shared = {
			schemaVersion: 1 as const,
			taskId: "case-1",
			taskDigest: digest("e"),
			lane: "resilience" as const,
			seed: 1,
			repetition: 1,
			pairId: digest("b"),
			scenario,
			agent: agent.identity,
			limits: { trialTimeoutSeconds: 60, maxTurns: 10, maxCostUsd: 1 },
		};
		const plans: LongHorizonTrialPlan[] = [
			{ ...shared, planId: digest("f"), variant: "no_fault" },
			{ ...shared, planId: digest("a"), variant: "fault" },
		];
		const manifest: EvalJobManifest = {
			schemaVersion: 1,
			jobId: "semantic-pair",
			createdAt: "2026-08-13T00:00:00.000Z",
			benchmark,
			agents: [agent.identity],
			caseIds: ["case-1"],
			repetitions: 1,
			maxCostUsd: 1,
		};
		const applied: string[] = [];
		const results = await new LongTaskEvalRunner(
			new FakeBenchmark([testCase()]),
			new FakeEnvironmentAdapter(),
			new LongTaskArtifactStore(root, manifest.jobId),
		).run({
			manifest,
			cases: [testCase()],
			agents: [agent],
			longHorizon: {
				plans,
				controller: new SemanticFaultController(1),
				executionFactory: () => ({ apply: async (action) => void applied.push(action.type) }),
			},
		});

		expect(results).toHaveLength(2);
		expect(results[0]!.longHorizon?.verdict.continuityPass).toBeUndefined();
		expect(results[1]!.longHorizon).toMatchObject({
			planId: digest("a"),
			valid: true,
			verdict: { capabilityPass: true, safetyPass: true, continuityPass: true },
			recovery: {
				triggerMatched: true,
				faultApplied: true,
				faultEventSeq: 2,
				checkpointBeforeFault: "before-fault",
				checkpointAfterRecovery: "after-recovery",
				recoveryCount: 1,
				recoveryLatencyMs: 1000,
			},
		});
		expect(applied).toEqual(["kill_worker"]);
		expect(results[1]!.artifacts.some((artifact) => artifact.name === "fault-events.jsonl")).toBe(true);
	});

	it("persists invalid attempts, scores the valid retry, and resumes without another attempt", async () => {
		const root = await mkdtemp(join(tmpdir(), "ever-eval-test-"));
		temporaryDirectories.push(root);
		const agent = new FakeAgent("ever");
		const manifest: EvalJobManifest = {
			schemaVersion: 1,
			jobId: "retry-invalid-plan",
			createdAt: "2026-08-13T00:00:00.000Z",
			benchmark,
			agents: [agent.identity],
			caseIds: ["case-1"],
			repetitions: 1,
			maxCostUsd: 1,
		};
		const plan: LongHorizonTrialPlan = {
			schemaVersion: 1,
			planId: digest("9"),
			taskId: "case-1",
			taskDigest: digest("e"),
			lane: "capability",
			variant: "standard",
			seed: 0,
			repetition: 1,
			agent: agent.identity,
			limits: { trialTimeoutSeconds: 60, maxTurns: 10, maxCostUsd: 1 },
		};
		const store = new LongTaskArtifactStore(root, manifest.jobId);
		const benchmarkAdapter = new RetryOnceBenchmark([testCase()]);
		const runner = new LongTaskEvalRunner(benchmarkAdapter, new FakeEnvironmentAdapter(), store);

		const first = await runner.run({
			manifest,
			cases: [testCase()],
			agents: [agent],
			longHorizon: { plans: [plan], lane: "capability" },
		});
		expect(first).toHaveLength(1);
		expect(first[0]!.longHorizon?.valid).toBe(true);
		expect(agent.runs).toBe(2);
		expect((await readFile(store.resultsPath, "utf8")).trim().split("\n")).toHaveLength(2);

		const resumed = await runner.run({
			manifest,
			cases: [testCase()],
			agents: [agent],
			longHorizon: { plans: [plan], lane: "capability" },
		});
		expect(resumed).toHaveLength(1);
		expect(agent.runs).toBe(2);
	});

	it("uses a finite default timeout when callers omit one", async () => {
		const result = await runProcess(process.execPath, ["-e", "process.stdout.write('ok')"], {});

		expect(result).toMatchObject({ exitCode: 0, stdout: "ok", timedOut: false });
	});
});

describe("long-task Eval schemas and selection", () => {
	it("rejects malformed external cases", () => {
		const value = { ...testCase(), schemaVersion: 2 };
		expect(() => assertEvalCase(value)).toThrow("EvalCase v1");
	});

	it("selects a stable subset without depending on input order", () => {
		const cases = [testCase("a"), testCase("b"), testCase("c"), testCase("d")];
		const forward = selectDeterministicCases(cases, "terminal-bench-2-1", 2).map((value) => value.id);
		const reverse = selectDeterministicCases([...cases].reverse(), "terminal-bench-2-1", 2).map((value) => value.id);
		expect(reverse).toEqual(forward);
	});
});
