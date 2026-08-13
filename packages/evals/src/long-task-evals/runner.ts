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
import type { DurableEventSource } from "./durable-events.ts";
import { selectEffectiveLongHorizonResults } from "./effective-results.ts";
import type { FaultInjector, FaultSpec } from "./faults.ts";
import { hashDirectory, sha256 } from "./hash.ts";
import { formatLongHorizonReport, summarizeLongHorizonResults } from "./long-horizon-report.ts";
import type { EnvironmentIdentity, EvalCase, EvalRunResult } from "./schemas.ts";
import { assertEvalCase, assertEvalRunResult } from "./schemas.ts";
import {
	type EnvironmentFaultEventSource,
	EnvironmentSemanticFaultExecution,
	SemanticFaultController,
	type SemanticFaultExecution,
	type SemanticFaultResult,
} from "./semantic-faults.ts";
import type { LongHorizonTrialPlan } from "./trial-plans.ts";

export interface EvalJobConfig {
	manifest: EvalJobManifest;
	cases: EvalCase[];
	agents: AgentAdapter[];
	retryInfrastructureFailures?: number;
	faults?: { profile: string; schedule: FaultSpec[]; injector: FaultInjector };
	longHorizon?: {
		plans: LongHorizonTrialPlan[];
		suite?: string;
		lane?: "capability" | "resilience";
		controller?: SemanticFaultController;
		executionFactory?: (environment: EvalEnvironment) => SemanticFaultExecution;
	};
}

interface TrialExecution {
	testCase: EvalCase;
	agent: AgentAdapter;
	repetition: number;
	plan?: LongHorizonTrialPlan;
}

function isDurableEventSource(agent: AgentAdapter): agent is AgentAdapter & DurableEventSource {
	return "readDurableEvents" in agent && typeof agent.readDurableEvents === "function";
}

function isEnvironmentFaultEventSource(agent: AgentAdapter): agent is AgentAdapter & EnvironmentFaultEventSource {
	return (
		"armEnvironmentTrigger" in agent &&
		typeof agent.armEnvironmentTrigger === "function" &&
		"readEnvironmentEvents" in agent &&
		typeof agent.readEnvironmentEvents === "function" &&
		"releaseEnvironmentEvent" in agent &&
		typeof agent.releaseEnvironmentEvent === "function"
	);
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
	if (
		config.agents.some((agent) => agent.identity.modelProvider !== "none") &&
		config.manifest.maxCostUsd === undefined
	) {
		throw new Error("Model-backed Eval jobs require maxCostUsd");
	}
	if (config.faults !== undefined) {
		if (
			config.manifest.faultProfile !== config.faults.profile ||
			!config.faults.profile.startsWith("ever-reliability")
		) {
			throw new Error("Fault runs require a separately named ever-reliability profile in the job manifest");
		}
		if (config.agents.some((agent) => agent.identity.name !== "ever")) {
			throw new Error("Fault profiles may only run the Ever adapter");
		}
	} else if (config.manifest.faultProfile !== undefined) {
		throw new Error("Job manifest declares a fault profile without a FaultInjector");
	}
	if (config.longHorizon !== undefined) {
		if (config.faults !== undefined) throw new Error("Semantic and elapsed-time fault profiles cannot be combined");
		if (config.longHorizon.plans.length === 0) throw new Error("Long-horizon execution requires trial plans");
		const caseIds = new Set(config.cases.map((testCase) => testCase.id));
		const agents = new Map(config.agents.map((agent) => [agent.identity.name, agent]));
		const planIds = new Set<string>();
		const pairs = new Map<string, LongHorizonTrialPlan[]>();
		for (const plan of config.longHorizon.plans) {
			if (planIds.has(plan.planId)) throw new Error(`Duplicate long-horizon plan ${plan.planId}`);
			planIds.add(plan.planId);
			if (!caseIds.has(plan.taskId)) throw new Error(`Long-horizon plan references unknown case ${plan.taskId}`);
			const testCase = config.cases.find((candidate) => candidate.id === plan.taskId)!;
			if (testCase.metadata.taskDigest !== plan.taskDigest)
				throw new Error(`Long-horizon plan task digest mismatch for ${plan.taskId}`);
			const agent = agents.get(plan.agent.name);
			if (agent === undefined || JSON.stringify(agent.identity) !== JSON.stringify(plan.agent))
				throw new Error(`Long-horizon plan agent identity mismatch for ${plan.agent.name}`);
			if (plan.lane === "resilience") {
				if (!isDurableEventSource(agent)) throw new Error("Resilience plans require explicit durable events");
				if (plan.pairId === undefined || plan.scenario === undefined)
					throw new Error("Resilience plans require pairId and scenario");
				if (plan.scenario.trigger.source === "environment_event" && !isEnvironmentFaultEventSource(agent)) {
					throw new Error("Environment-event resilience plans require a controlled event source");
				}
				const pair = pairs.get(plan.pairId) ?? [];
				pair.push(plan);
				pairs.set(plan.pairId, pair);
			}
		}
		for (const [pairId, pair] of pairs) {
			const variants = new Set(pair.map((plan) => plan.variant));
			if (pair.length !== 2 || variants.size !== 2 || !variants.has("no_fault") || !variants.has("fault"))
				throw new Error(`Resilience pair ${pairId} must contain one no-fault and one fault plan`);
			const controlled = pair.map(({ planId: _planId, variant: _variant, ...plan }) => JSON.stringify(plan));
			if (controlled[0] !== controlled[1])
				throw new Error(`Resilience pair ${pairId} changes variables other than fault injection`);
		}
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
		platform: process.arch === "arm64" ? "linux/arm64" : "linux/amd64",
		network: testCase.environment.network,
	};
}

function infrastructureLongHorizon(plan: LongHorizonTrialPlan): NonNullable<EvalRunResult["longHorizon"]> {
	return {
		planId: plan.planId,
		...(plan.pairId === undefined ? {} : { pairId: plan.pairId }),
		lane: plan.lane,
		variant: plan.variant,
		...(plan.scenario === undefined ? {} : { scenarioId: plan.scenario.id }),
		valid: false,
		invalidReason: "infrastructure_error",
		verdict: { capabilityPass: false, safetyPass: false },
		recovery: {
			triggerMatched: false,
			faultApplied: false,
			recoveryCount: 0,
			duplicateSideEffects: 0,
			forbiddenReplays: 0,
			unknownToolOutcomes: 0,
		},
		verifier: { started: false, completed: false, reportDigest: sha256("missing") },
		scoreStateDigest: sha256("missing"),
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
			existing
				.filter((result) => result.longHorizon === undefined || result.longHorizon.valid)
				.map(
					(result) => result.longHorizon?.planId ?? resultKey(result.caseId, result.agent.name, result.repetition),
				),
		);
		let observedCost = existing.reduce((total, result) => total + (result.usage.estimatedCostUsd ?? 0), 0);
		const attempts = [...existing];

		const cases = new Map(config.cases.map((testCase) => [testCase.id, testCase]));
		const agents = new Map(config.agents.map((agent) => [agent.identity.name, agent]));
		const executions: TrialExecution[] =
			config.longHorizon === undefined
				? config.cases.flatMap((testCase) =>
						Array.from({ length: config.manifest.repetitions }, (_, index) =>
							config.agents.map((agent) => ({ testCase, agent, repetition: index + 1 })),
						).flat(),
					)
				: config.longHorizon.plans.map((plan) => ({
						testCase: cases.get(plan.taskId)!,
						agent: agents.get(plan.agent.name)!,
						repetition: plan.repetition,
						plan,
					}));
		for (const execution of executions) {
			const { testCase, agent, repetition, plan } = execution;
			const key = plan?.planId ?? resultKey(testCase.id, agent.identity.name, repetition);
			if (completed.has(key)) continue;
			if (config.manifest.maxCostUsd !== undefined && observedCost >= config.manifest.maxCostUsd) {
				throw new Error(`Eval cost budget exhausted before ${testCase.id}/${agent.identity.name}/${repetition}`);
			}

			const remainingBudget =
				config.manifest.maxCostUsd === undefined ? undefined : config.manifest.maxCostUsd - observedCost;
			let retry = 0;
			let result: EvalRunResult;
			do {
				const currentRemainingBudget =
					config.manifest.maxCostUsd === undefined ? undefined : config.manifest.maxCostUsd - observedCost;
				if (currentRemainingBudget !== undefined && currentRemainingBudget <= 0)
					throw new Error(
						`Eval cost budget exhausted before retrying ${testCase.id}/${agent.identity.name}/${repetition}`,
					);
				result = await this.#runTrial(
					testCase,
					agent,
					repetition,
					currentRemainingBudget ?? remainingBudget,
					config.faults,
					plan,
					config.longHorizon,
				);
				await this.#artifacts.appendResult(result);
				attempts.push(result);
				observedCost += result.usage.estimatedCostUsd ?? 0;
				retry += 1;
			} while (
				(result.outcome === "infrastructure_error" || result.longHorizon?.valid === false) &&
				retry <= (config.retryInfrastructureFailures ?? 1)
			);
			completed.add(key);
		}

		const results = config.longHorizon ? selectEffectiveLongHorizonResults(attempts) : attempts;
		const comparison = summarizeResults(results);
		await this.#artifacts.writeComparisonJson({ schemaVersion: 1, jobId: config.manifest.jobId, agents: comparison });
		await this.#artifacts.writeComparison(formatComparisonMarkdown(comparison));
		if (config.longHorizon !== undefined) {
			const report = summarizeLongHorizonResults(results, {
				suite: config.longHorizon.suite ?? "unknown",
				lane: config.longHorizon.lane ?? "resilience",
				repetitions: config.manifest.repetitions,
			});
			await writeFile(
				join(this.#artifacts.jobDirectory, "long-horizon-report.json"),
				`${JSON.stringify(report, null, 2)}\n`,
				{
					mode: 0o600,
				},
			);
			await writeFile(
				join(this.#artifacts.jobDirectory, "long-horizon-report.md"),
				formatLongHorizonReport(report),
				{
					mode: 0o600,
				},
			);
		}
		return results;
	}

	async #runTrial(
		testCase: EvalCase,
		agent: AgentAdapter,
		repetition: number,
		remainingBudget: number | undefined,
		faults: EvalJobConfig["faults"],
		plan?: LongHorizonTrialPlan,
		longHorizon?: EvalJobConfig["longHorizon"],
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
			let semanticResult: SemanticFaultResult | undefined;
			let semanticPromise: Promise<SemanticFaultResult> | undefined;
			if (plan?.variant === "fault" && plan.scenario !== undefined && longHorizon !== undefined) {
				if (plan.scenario.trigger.source === "environment_event") {
					(agent as AgentAdapter & EnvironmentFaultEventSource).armEnvironmentTrigger(plan.scenario.trigger);
				}
				semanticPromise = (longHorizon.controller ?? new SemanticFaultController()).inject(
					plan.scenario,
					{
						agent: agent as AgentAdapter & DurableEventSource,
						...(isEnvironmentFaultEventSource(agent) ? { environment: agent } : {}),
					},
					longHorizon.executionFactory?.(environment) ?? new EnvironmentSemanticFaultExecution(environment),
					new AbortController().signal,
				);
			}
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
			if (semanticPromise !== undefined) semanticResult = await semanticPromise;
			if (faultResults !== undefined) {
				await writeFile(join(runDirectory, "faults.json"), `${JSON.stringify(await faultResults, null, 2)}\n`, {
					mode: 0o600,
				});
			}
			if (semanticResult !== undefined) {
				await writeFile(
					join(runDirectory, "fault-events.jsonl"),
					`${semanticResult.records.map((record) => JSON.stringify(record)).join("\n")}\n`,
					{ mode: 0o600 },
				);
			}
			await environment.copyOut(testCase.environment.workingDirectory, join(runDirectory, "workspace-after"));
			const workspaceAfterDigest = await hashDirectory(join(runDirectory, "workspace-after"));
			const verification = await this.#benchmark.verify(testCase, environment, runDirectory);
			if (plan?.variant === "fault" && semanticResult?.status !== "observed") {
				verification.valid = false;
				verification.errors.push({
					source: "fault",
					code: semanticResult?.error ?? "fault_not_injected",
					message: `Semantic fault status: ${semanticResult?.status ?? "missing"}`,
				});
			}
			const verifierDigest =
				typeof testCase.metadata.verifierDigest === "string"
					? testCase.metadata.verifierDigest
					: await hashDirectory(testCase.verifier.testsSource);
			const collectedArtifacts = await collectRunArtifacts(runDirectory);
			const verifierReport = await environment.readFile("/logs/verifier/report.json");
			const verifierReportDigest = sha256(verifierReport ?? "missing");
			const scoreStateDigest = sha256(`${workspaceAfterDigest}\0${verifierReportDigest}`);
			const durableEvents = isDurableEventSource(agent) ? agent.readDurableEvents(0) : [];
			const matchedFaultEvent = semanticResult?.matchedEvent;
			const faultSeq =
				matchedFaultEvent === undefined
					? undefined
					: "toolCallId" in matchedFaultEvent
						? durableEvents.find(
								(event) => event.type === "ToolStarted" && event.toolCallId === matchedFaultEvent.toolCallId,
							)?.seq
						: matchedFaultEvent.seq;
			const checkpoints = durableEvents.filter((event) => event.type === "CheckpointSettled");
			const checkpointBeforeFault = checkpoints
				.filter((event) => faultSeq === undefined || event.seq <= faultSeq)
				.at(-1);
			const checkpointAfterRecovery = checkpoints.find((event) => faultSeq !== undefined && event.seq > faultSeq);
			const recoveries = durableEvents.filter((event) => event.type === "RecoveryFinished");
			const recoveryStarted = durableEvents.find(
				(event) => event.type === "RecoveryStarted" && (faultSeq === undefined || event.seq > faultSeq),
			);
			const recoveryFinished = durableEvents.find(
				(event) =>
					event.type === "RecoveryFinished" && (recoveryStarted === undefined || event.seq > recoveryStarted.seq),
			);
			const recoveryLatencyMs =
				recoveryStarted === undefined || recoveryFinished === undefined
					? undefined
					: Date.parse(recoveryFinished.createdAt) - Date.parse(recoveryStarted.createdAt);
			const capabilityPass =
				agentOutcome.outcome === "completed" &&
				verification.valid &&
				(verification.metrics.capability_pass ?? verification.metrics.reward ?? 0) >= 1;
			const safetyPass =
				verification.valid && (verification.metrics.safety_pass ?? verification.metrics.reward ?? 0) >= 1;
			const faultObserved = semanticResult?.status === "observed";
			const continuityPass =
				plan?.variant === "fault" && plan.scenario?.expectation.kind === "eventual_completion"
					? Boolean(faultObserved && capabilityPass && safetyPass && recoveryFinished)
					: undefined;
			const terminalSemanticsPass =
				plan?.variant === "fault" && plan.scenario?.expectation.kind === "fail_closed"
					? Boolean(
							faultObserved &&
								agentOutcome.outcome === "unknown_outcome" &&
								(agentOutcome.ever?.duplicateSideEffects ?? 0) === 0,
						)
					: undefined;
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
				...(agentOutcome.ever === undefined ? {} : { ever: agentOutcome.ever }),
				...(plan === undefined
					? {}
					: {
							longHorizon: {
								planId: plan.planId,
								...(plan.pairId === undefined ? {} : { pairId: plan.pairId }),
								lane: plan.lane,
								variant: plan.variant,
								...(plan.scenario === undefined ? {} : { scenarioId: plan.scenario.id }),
								valid: verification.valid,
								...(verification.valid
									? {}
									: { invalidReason: semanticResult?.error ?? "verification_invalid" }),
								verdict: {
									capabilityPass,
									safetyPass,
									...(continuityPass === undefined ? {} : { continuityPass }),
									...(terminalSemanticsPass === undefined ? {} : { terminalSemanticsPass }),
								},
								recovery: {
									triggerMatched: semanticResult?.matchedEvent !== undefined,
									faultApplied: semanticResult?.status === "observed",
									...(faultSeq === undefined ? {} : { faultEventSeq: faultSeq }),
									...(checkpointBeforeFault?.checkpointId === undefined
										? {}
										: { checkpointBeforeFault: checkpointBeforeFault.checkpointId }),
									...(checkpointAfterRecovery?.checkpointId === undefined
										? {}
										: { checkpointAfterRecovery: checkpointAfterRecovery.checkpointId }),
									recoveryCount: recoveries.length,
									...(recoveryLatencyMs === undefined ? {} : { recoveryLatencyMs }),
									duplicateSideEffects: agentOutcome.ever?.duplicateSideEffects ?? 0,
									forbiddenReplays: 0,
									unknownToolOutcomes: agentOutcome.ever?.unknownToolOutcomes ?? 0,
								},
								verifier: {
									started: verifierReport !== undefined,
									completed: verification.valid,
									reportDigest: verifierReportDigest,
								},
								scoreStateDigest,
							},
						}),
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
				...(plan === undefined ? {} : { longHorizon: infrastructureLongHorizon(plan) }),
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
		if (result.longHorizon !== undefined) {
			await writeFile(
				join(runDirectory, "long-horizon-result.json"),
				`${JSON.stringify(result.longHorizon, null, 2)}\n`,
				{ mode: 0o600 },
			);
		}
		return result;
	}
}
