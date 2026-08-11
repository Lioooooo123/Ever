import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalJobManifest, LongTaskArtifactStore } from "./artifacts.ts";
import { collectRunArtifacts, resultKey } from "./artifacts.ts";
import { formatComparisonMarkdown, summarizeResults } from "./comparison.ts";
import type {
	AgentAdapter,
	AgentRunOutcome,
	BenchmarkAdapter,
	EnvironmentAdapter,
	EvalEnvironment,
} from "./contracts.ts";
import type { FaultInjector, FaultSpec } from "./faults.ts";
import { hashDirectory, sha256 } from "./hash.ts";
import type { EnvironmentIdentity, EvalCase, EvalRunResult } from "./schemas.ts";
import { assertEvalCase, assertEvalRunResult } from "./schemas.ts";

export interface EvalJobConfig {
	manifest: EvalJobManifest;
	cases: EvalCase[];
	agents: AgentAdapter[];
	retryInfrastructureFailures?: number;
	faults?: { profile: string; schedule: FaultSpec[]; injector: FaultInjector };
}

function validatePinnedIdentity(config: EvalJobConfig): void {
	if (!Number.isSafeInteger(config.manifest.repetitions) || config.manifest.repetitions < 1) {
		throw new Error("Eval repetitions must be a positive integer");
	}
	if (
		config.manifest.maxCostUsd !== undefined &&
		(!Number.isFinite(config.manifest.maxCostUsd) || config.manifest.maxCostUsd <= 0)
	) {
		throw new Error("Eval maxCostUsd must be a positive finite number");
	}
	if (config.agents.length === 0) throw new Error("Eval job requires at least one agent");
	const names = new Set<string>();
	const digestPattern = /^[a-f0-9]{64}$/;
	const expectedModel = `${config.agents[0]!.identity.modelProvider}\0${config.agents[0]!.identity.modelId}`;
	for (const agent of config.agents) {
		if (names.has(agent.identity.name)) throw new Error(`Duplicate agent name: ${agent.identity.name}`);
		names.add(agent.identity.name);
		if (
			!digestPattern.test(agent.identity.executableDigest) ||
			!digestPattern.test(agent.identity.configurationDigest)
		) {
			throw new Error(`Agent ${agent.identity.name} has an unpinned digest`);
		}
		if (/^(latest|main|master|head)$/i.test(agent.identity.version))
			throw new Error(`Agent ${agent.identity.name} uses a floating version`);
		if (/(^|[-_/])latest$/i.test(agent.identity.modelId))
			throw new Error(`Agent ${agent.identity.name} uses a floating model alias`);
		if (`${agent.identity.modelProvider}\0${agent.identity.modelId}` !== expectedModel) {
			throw new Error("Every compared agent must use the same exact model identity");
		}
	}
	if (config.agents.some((agent) => agent.identity.name !== "oracle") && config.manifest.maxCostUsd === undefined) {
		throw new Error("Model-backed Eval jobs require maxCostUsd");
	}
	if (config.faults !== undefined) {
		if (
			config.manifest.faultProfile !== config.faults.profile ||
			!config.faults.profile.startsWith("karissa-reliability")
		) {
			throw new Error("Fault runs require a separately named karissa-reliability profile in the job manifest");
		}
		if (config.agents.some((agent) => agent.identity.name !== "karissa")) {
			throw new Error("Fault profiles may only run the Karissa adapter");
		}
	} else if (config.manifest.faultProfile !== undefined) {
		throw new Error("Job manifest declares a fault profile without a FaultInjector");
	}
	if (config.manifest.agents.length !== config.agents.length)
		throw new Error("Job manifest agent count does not match adapters");
	for (const [index, agent] of config.agents.entries()) {
		if (JSON.stringify(config.manifest.agents[index]) !== JSON.stringify(agent.identity)) {
			throw new Error(`Job manifest identity does not match adapter ${agent.identity.name}`);
		}
	}
	if (config.manifest.caseIds.length !== config.cases.length)
		throw new Error("Job manifest case count does not match cases");
	for (const [index, testCase] of config.cases.entries()) {
		assertEvalCase(testCase);
		if (config.manifest.caseIds[index] !== testCase.id)
			throw new Error(`Job manifest case order differs at ${testCase.id}`);
		if (testCase.benchmark.resolvedDigest !== config.manifest.benchmark.resolvedDigest) {
			throw new Error(`Benchmark digest differs for ${testCase.id}`);
		}
	}
}

function fallbackEnvironment(testCase: EvalCase): EnvironmentIdentity {
	return {
		kind: "docker",
		imageDigest: testCase.environment.imageDigest ?? "unresolved",
		network: testCase.environment.network,
	};
}

export class LongTaskEvalRunner {
	readonly #benchmark: BenchmarkAdapter;
	readonly #environmentAdapter: EnvironmentAdapter;
	readonly #artifacts: LongTaskArtifactStore;

	constructor(benchmark: BenchmarkAdapter, environmentAdapter: EnvironmentAdapter, artifacts: LongTaskArtifactStore) {
		this.#benchmark = benchmark;
		this.#environmentAdapter = environmentAdapter;
		this.#artifacts = artifacts;
	}

	async run(config: EvalJobConfig): Promise<EvalRunResult[]> {
		validatePinnedIdentity(config);
		await this.#environmentAdapter.preflight();
		await this.#artifacts.initialize(config.manifest);
		const existing = await this.#artifacts.loadResults();
		const completed = new Set(
			existing.map((result) => resultKey(result.caseId, result.agent.name, result.repetition)),
		);
		let observedCost = existing.reduce((total, result) => total + (result.usage.estimatedCostUsd ?? 0), 0);
		const results = [...existing];

		for (const testCase of config.cases) {
			for (let repetition = 1; repetition <= config.manifest.repetitions; repetition += 1) {
				for (const agent of config.agents) {
					const key = resultKey(testCase.id, agent.identity.name, repetition);
					if (completed.has(key)) continue;
					if (config.manifest.maxCostUsd !== undefined && observedCost >= config.manifest.maxCostUsd) {
						throw new Error(
							`Eval cost budget exhausted before ${testCase.id}/${agent.identity.name}/${repetition}`,
						);
					}

					const remainingBudget =
						config.manifest.maxCostUsd === undefined ? undefined : config.manifest.maxCostUsd - observedCost;
					let result = await this.#runTrial(testCase, agent, repetition, remainingBudget, config.faults);
					for (
						let retry = 0;
						result.outcome === "infrastructure_error" && retry < (config.retryInfrastructureFailures ?? 1);
						retry += 1
					) {
						result = await this.#runTrial(testCase, agent, repetition, remainingBudget, config.faults);
					}
					await this.#artifacts.appendResult(result);
					completed.add(key);
					results.push(result);
					observedCost += result.usage.estimatedCostUsd ?? 0;
				}
			}
		}

		const comparison = summarizeResults(results);
		await this.#artifacts.writeComparisonJson({ schemaVersion: 1, jobId: config.manifest.jobId, agents: comparison });
		await this.#artifacts.writeComparison(formatComparisonMarkdown(comparison));
		return results;
	}

	async #runTrial(
		testCase: EvalCase,
		agent: AgentAdapter,
		repetition: number,
		remainingBudget: number | undefined,
		faults: EvalJobConfig["faults"],
	): Promise<EvalRunResult> {
		const runId = randomUUID();
		const runDirectory = await this.#artifacts.createRunDirectory(runId);
		const startedAt = performance.now();
		let environment: EvalEnvironment | undefined;
		let result: EvalRunResult | undefined;
		try {
			environment = await this.#environmentAdapter.create(testCase, runDirectory);
			const hiddenTests = await environment.exec({ args: ["test", "!", "-e", "/tests"], timeoutSeconds: 30 });
			if (hiddenTests.exitCode !== 0 || hiddenTests.timedOut) {
				throw new Error("Hidden benchmark tests are visible before agent execution");
			}
			await environment.copyOut(testCase.environment.workingDirectory, join(runDirectory, "workspace-before"));

			let agentOutcome: AgentRunOutcome;
			const faultAbort = new AbortController();
			const faultResults = faults?.injector.inject(faults.schedule, { agent, environment }, faultAbort.signal);
			try {
				agentOutcome = await agent.run(testCase, environment, runDirectory, {
					...(remainingBudget === undefined ? {} : { maxCostUsd: remainingBudget }),
				});
			} catch (error) {
				agentOutcome = {
					outcome: "failed" as const,
					usage: {},
					errors: [
						{
							source: "agent",
							code: "adapter_error",
							message: error instanceof Error ? error.message : String(error),
						},
					],
				};
			} finally {
				faultAbort.abort();
			}
			if (faultResults !== undefined) {
				await writeFile(join(runDirectory, "faults.json"), `${JSON.stringify(await faultResults, null, 2)}\n`, {
					mode: 0o600,
				});
			}
			await environment.copyOut(testCase.environment.workingDirectory, join(runDirectory, "workspace-after"));
			const verification = await this.#benchmark.verify(testCase, environment, runDirectory);
			const verifierDigest =
				typeof testCase.metadata.verifierDigest === "string"
					? testCase.metadata.verifierDigest
					: await hashDirectory(testCase.verifier.testsSource);
			const collectedArtifacts = await collectRunArtifacts(runDirectory);
			result = {
				schemaVersion: 1,
				runId,
				caseId: testCase.id,
				repetition,
				benchmark: testCase.benchmark,
				agent: agent.identity,
				environment: environment.identity,
				outcome: agentOutcome.outcome,
				official: {
					valid: verification.valid,
					metrics: verification.metrics,
					...(verification.exitCode === undefined ? {} : { verifierExitCode: verification.exitCode }),
				},
				usage: { ...agentOutcome.usage, wallTimeMs: performance.now() - startedAt },
				integrity: {
					environmentDigest: environment.identity.imageDigest,
					instructionDigest: sha256(testCase.instruction),
					verifierDigest,
					artifactsDigest: collectedArtifacts.digest,
					violations: [],
				},
				...(agentOutcome.karissa === undefined ? {} : { karissa: agentOutcome.karissa }),
				artifacts: collectedArtifacts.artifacts,
				errors: [...agentOutcome.errors, ...verification.errors],
			};
		} catch (error) {
			result = {
				schemaVersion: 1,
				runId,
				caseId: testCase.id,
				repetition,
				benchmark: testCase.benchmark,
				agent: agent.identity,
				environment: environment?.identity ?? fallbackEnvironment(testCase),
				outcome: "infrastructure_error",
				official: { valid: false, metrics: {} },
				usage: { wallTimeMs: performance.now() - startedAt },
				integrity: {
					environmentDigest: environment?.identity.imageDigest ?? fallbackEnvironment(testCase).imageDigest,
					instructionDigest: sha256(testCase.instruction),
					verifierDigest: sha256(JSON.stringify(testCase.verifier)),
					artifactsDigest: sha256("[]"),
					violations: [],
				},
				artifacts: [],
				errors: [
					{
						source: "runner",
						code: "infrastructure_error",
						message: error instanceof Error ? error.message : String(error),
					},
				],
			};
		} finally {
			if (environment !== undefined) {
				try {
					await environment.destroy();
				} catch (error) {
					if (result !== undefined) {
						result.errors.push({
							source: "environment",
							code: "cleanup_failed",
							message: error instanceof Error ? error.message : String(error),
						});
						result.official.valid = false;
					}
				}
			}
		}
		if (result === undefined) throw new Error(`Trial ${runId} produced no result`);
		assertEvalRunResult(result);
		await writeFile(join(runDirectory, "run.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
		return result;
	}
}
