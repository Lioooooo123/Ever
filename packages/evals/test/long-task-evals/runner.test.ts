import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type EvalJobManifest, LongTaskArtifactStore } from "../../src/long-task-evals/artifacts.ts";
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
import { LongTaskEvalRunner } from "../../src/long-task-evals/runner.ts";
import type { AgentIdentity, EvalCase } from "../../src/long-task-evals/schemas.ts";
import { assertEvalCase } from "../../src/long-task-evals/schemas.ts";
import { selectDeterministicCases } from "../../src/long-task-evals/task-selection.ts";

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
		metadata: { verifierDigest: digest("b") },
	};
}

class FakeEnvironment implements EvalEnvironment {
	readonly identity = { kind: "docker" as const, imageDigest: "sha256:fake", network: "none" as const };
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

	async copyOut(_source: string, _destination: string): Promise<void> {}

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
