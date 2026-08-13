import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { writeEvalJobIndex } from "../eval-product/job.ts";
import type { EvalJobManifest } from "./artifacts.ts";
import { LongTaskArtifactStore } from "./artifacts.ts";
import { auditTaskCalibration } from "./calibration.ts";
import { assertEvalJobPassed, assertOracleGate } from "./cli.ts";
import { CommandAgentAdapter, type CommandAgentConfig } from "./command-agent.ts";
import { DockerEnvironmentAdapter } from "./docker-environment.ts";
import { EverAgentAdapter } from "./ever-agent.ts";
import { hashDirectory } from "./hash.ts";
import { NoopAgentAdapter, OwnedOracleAgentAdapter } from "./owned-agents.ts";
import { OwnedLongHorizonBenchmarkAdapter } from "./owned-benchmark.ts";
import { LongTaskEvalRunner } from "./runner.ts";
import type { AgentIdentity, EvalCase } from "./schemas.ts";
import {
	capabilityTrialPlan,
	type LongHorizonTrialPlan,
	requiredPlanBudget,
	resilienceTrialPlans,
} from "./trial-plans.ts";

interface StoredAgentConfig {
	kind: "oracle" | "no-op" | "ever" | "command";
	name: string;
	version: string;
	executableDigest: string;
	configurationDigest: string;
	command: string[];
	forwardEnvironment?: string[];
	preparation?: CommandAgentConfig["preparation"];
}

interface StoredLongHorizonJob {
	schemaVersion: 1;
	benchmarkRoot: string;
	suite: string;
	lane?: "capability" | "resilience";
	seed?: number;
	provider: string;
	model: string;
	maxCostUsd?: number;
	agents: StoredAgentConfig[];
	selectedCaseIds: string[];
	manifest: EvalJobManifest;
	oracleJobId?: string;
	plans?: LongHorizonTrialPlan[];
}

function required(value: string | undefined, option: string): string {
	if (value === undefined || value.trim() === "") throw new Error(`${option} is required`);
	return value;
}

function finitePositive(value: string | undefined, option: string): number {
	const parsed = Number(required(value, option));
	if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${option} must be a positive number`);
	return parsed;
}

function environmentFor(keys: readonly string[] | undefined): Record<string, string> {
	const values: Record<string, string> = {};
	for (const key of keys ?? []) {
		const value = process.env[key];
		if (value === undefined) throw new Error(`Required credential environment variable is missing: ${key}`);
		values[key] = value;
	}
	return values;
}

function assertAgentConfig(value: unknown): asserts value is StoredAgentConfig[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("Agent config must be a non-empty JSON array");
	for (const agent of value) {
		if (typeof agent !== "object" || agent === null || Array.isArray(agent))
			throw new Error("Agent config entry must be an object");
		const kind = Reflect.get(agent, "kind");
		if (kind !== "ever" && kind !== "command") throw new Error("Configured agent kind must be ever or command");
		for (const key of ["name", "version", "executableDigest", "configurationDigest"] as const) {
			if (typeof Reflect.get(agent, key) !== "string" || Reflect.get(agent, key) === "")
				throw new Error(`Agent config ${key} is required`);
		}
		if (!/^[a-f0-9]{64}$/.test(String(Reflect.get(agent, "executableDigest"))))
			throw new Error("Agent executableDigest must be SHA-256");
		if (!/^[a-f0-9]{64}$/.test(String(Reflect.get(agent, "configurationDigest"))))
			throw new Error("Agent configurationDigest must be SHA-256");
		const command = Reflect.get(agent, "command");
		if (!Array.isArray(command) || !command.every((item) => typeof item === "string"))
			throw new Error("Agent config command must be a string array");
	}
}

function identity(config: StoredAgentConfig, provider: string, model: string): AgentIdentity {
	return {
		name: config.name,
		version: config.version,
		executableDigest: config.executableDigest,
		modelProvider: provider,
		modelId: model,
		configurationDigest: config.configurationDigest,
	};
}

function makeAgents(config: StoredLongHorizonJob, cases: readonly EvalCase[]) {
	const maxTurns = Math.max(
		...cases.map((testCase) => (typeof testCase.metadata.maxTurns === "number" ? testCase.metadata.maxTurns : 200)),
	);
	return config.agents.map((agent) => {
		if (agent.kind === "oracle") return new OwnedOracleAgentAdapter(identity(agent, config.provider, config.model));
		if (agent.kind === "no-op") return new NoopAgentAdapter(identity(agent, config.provider, config.model));
		const agentIdentity = identity(agent, config.provider, config.model);
		const environment = (): Record<string, string> => environmentFor(agent.forwardEnvironment);
		if (agent.kind === "ever") {
			if (agent.command.length !== 1) throw new Error("Ever agent command must contain exactly one executable");
			return new EverAgentAdapter({
				identity: agentIdentity,
				command: agent.command[0],
				environment,
				preparation: agent.preparation,
				maxTurns,
				maxCostUsd: requiredBudget(config.maxCostUsd),
			});
		}
		return new CommandAgentAdapter({
			identity: agentIdentity,
			command: agent.command,
			environment,
			preparation: agent.preparation,
		});
	});
}

function requiredBudget(value: number | undefined): number {
	if (value === undefined) throw new Error("Model-backed long-horizon jobs require a cost budget");
	return value;
}

export async function executeLongHorizonCommand(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			"benchmark-root": { type: "string" },
			suite: { type: "string" },
			lane: { type: "string" },
			seed: { type: "string" },
			agents: { type: "string" },
			provider: { type: "string" },
			model: { type: "string" },
			"max-cost-usd": { type: "string" },
			"agent-config": { type: "string" },
			repetitions: { type: "string" },
			resume: { type: "string" },
			"artifact-root": { type: "string" },
			"oracle-job": { type: "string" },
			"audit-calibration": { type: "boolean" },
			"author-gate": { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: false,
	});
	if (values.help) {
		console.log(`Usage:
  npm run eval -- long-horizon --suite dev --agents oracle
  npm run eval -- long-horizon --suite dev --agents no-op
  npm run eval -- long-horizon --suite dev --agents <names> --agent-config <path> --oracle-job <id> --provider <provider> --model <exact-id> --max-cost-usd <amount>
  npm run eval -- long-horizon --suite dev --lane resilience --agents ever --agent-config <path> --oracle-job <id> --provider <provider> --model <exact-id> --max-cost-usd <amount>
  npm run eval -- long-horizon --suite full --agents oracle --author-gate
  npm run eval -- long-horizon --suite full --audit-calibration --agents oracle
  npm run eval -- long-horizon --resume <job-id>`);
		return;
	}

	const defaultRoot = join(import.meta.dirname, "../../benchmarks/long-horizon-v1");
	const artifactRoot = resolve(values["artifact-root"] ?? join(import.meta.dirname, "../../.eval"));
	let stored: StoredLongHorizonJob;
	let store: LongTaskArtifactStore;
	if (values.resume !== undefined) {
		store = new LongTaskArtifactStore(artifactRoot, values.resume);
		stored = JSON.parse(await readFile(join(store.jobDirectory, "resume.json"), "utf8")) as StoredLongHorizonJob;
		if (stored.schemaVersion !== 1) throw new Error("Unsupported long-horizon resume schemaVersion");
	} else {
		const benchmarkRoot = resolve(values["benchmark-root"] ?? defaultRoot);
		const suite = values.suite ?? "dev";
		const lane = values.lane ?? "capability";
		if (lane !== "capability" && lane !== "resilience") throw new Error("--lane must be capability or resilience");
		const seed = values.seed === undefined ? 0 : Number(values.seed);
		if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("--seed must be a non-negative integer");
		const benchmark = new OwnedLongHorizonBenchmarkAdapter(benchmarkRoot);
		const selectedCases = await benchmark.listCases(suite);
		const agentNames = required(values.agents, "--agents")
			.split(",")
			.map((name) => name.trim())
			.filter((name) => name !== "");
		if (agentNames.length === 0 || new Set(agentNames).size !== agentNames.length)
			throw new Error("--agents must contain unique agent names");
		if (values["author-gate"] && (agentNames.length !== 1 || !["oracle", "no-op"].includes(agentNames[0]!))) {
			throw new Error("--author-gate only permits a single oracle or no-op agent");
		}
		if (values["audit-calibration"] || (suite === "full" && !values["author-gate"])) {
			const manifest = await benchmark.manifest();
			const audits = await Promise.all(
				selectedCases.map(async (testCase) => ({
					taskId: testCase.id,
					...(await auditTaskCalibration(testCase.taskRoot, await benchmark.task(testCase.id), manifest.version)),
				})),
			);
			if (values["audit-calibration"]) {
				process.stdout.write(
					`${JSON.stringify({ schemaVersion: 1, benchmarkVersion: manifest.version, audits }, null, 2)}\n`,
				);
				return;
			}
			const blocked = audits.filter((audit) => !audit.ready);
			if (blocked.length > 0) {
				throw new Error(
					`Full suite calibration gate failed: ${blocked.map((audit) => `${audit.taskId}[${audit.reasons.join(",")}]`).join("; ")}`,
				);
			}
		}
		let agents: StoredAgentConfig[];
		if (agentNames.length === 1 && (agentNames[0] === "oracle" || agentNames[0] === "no-op")) {
			const name = agentNames[0];
			agents = [
				{
					kind: name,
					name,
					version: "1.0.0",
					executableDigest:
						name === "oracle"
							? await hashDirectory(join(benchmarkRoot, "tasks"))
							: "c32d19e2e5e63f458c9e51dfe39d2e5c6ad9f1d75ef304bf1264744efc7133bc",
					configurationDigest: "cdaf5f23eb2796e9e6c499e9d9f5299ca768dbb1727b8b96e06d281b539af61a",
					command: [],
				},
			];
		} else {
			if (agentNames.includes("oracle")) throw new Error("Oracle must run in a separate gate job");
			const configured = JSON.parse(
				await readFile(resolve(required(values["agent-config"], "--agent-config")), "utf8"),
			) as unknown;
			assertAgentConfig(configured);
			const selected = new Set(agentNames);
			agents = configured.filter((agent) => selected.has(agent.name));
			if (agents.length !== selected.size) throw new Error("--agents contains a name missing from --agent-config");
		}
		const modelBacked = agents[0]!.kind !== "oracle" && agents[0]!.kind !== "no-op";
		const provider = modelBacked ? required(values.provider, "--provider") : "none";
		const model = modelBacked ? required(values.model, "--model") : agents[0]!.name;
		const maxCostUsd = modelBacked ? finitePositive(values["max-cost-usd"], "--max-cost-usd") : undefined;
		const oracleJobId = modelBacked ? required(values["oracle-job"], "--oracle-job") : undefined;
		const repetitions = values.repetitions === undefined ? (suite === "full" ? 3 : 1) : Number(values.repetitions);
		if (!Number.isSafeInteger(repetitions) || repetitions < 1)
			throw new Error("--repetitions must be a positive integer");
		if (lane === "resilience" && (agents.length !== 1 || agents[0]!.kind !== "ever" || agents[0]!.name !== "ever"))
			throw new Error("Resilience lane requires exactly the Ever adapter");
		const agentIdentities = agents.map((agent) => identity(agent, provider, model));
		const plans = (
			await Promise.all(
				selectedCases.map(async (testCase) => {
					const task = await benchmark.task(testCase.id);
					return Array.from({ length: repetitions }, (_, index) =>
						lane === "resilience"
							? resilienceTrialPlans(task, testCase, agentIdentities[0]!, index + 1, seed)
							: agentIdentities.map((agent) => capabilityTrialPlan(task, testCase, agent, index + 1, seed)),
					).flat();
				}),
			)
		).flat();
		if (lane === "resilience" && plans?.length === 0)
			throw new Error(`Suite ${suite} contains no resilience scenarios`);
		const admittedBudget = requiredPlanBudget(plans);
		if (modelBacked && maxCostUsd! < admittedBudget)
			throw new Error(`--max-cost-usd must cover the admitted plan budget: ${maxCostUsd} < ${admittedBudget}`);
		const jobId = `${new Date().toISOString().replaceAll(":", "-")}_${randomUUID()}`;
		const manifest: EvalJobManifest = {
			schemaVersion: 1,
			jobId,
			createdAt: new Date().toISOString(),
			benchmark: await benchmark.identity(),
			agents: agentIdentities,
			caseIds: selectedCases.map((testCase) => testCase.id),
			repetitions,
			...(maxCostUsd === undefined ? {} : { maxCostUsd }),
		};
		stored = {
			schemaVersion: 1,
			benchmarkRoot,
			suite,
			lane,
			seed,
			provider,
			model,
			...(maxCostUsd === undefined ? {} : { maxCostUsd }),
			agents,
			selectedCaseIds: manifest.caseIds,
			manifest,
			...(oracleJobId === undefined ? {} : { oracleJobId }),
			plans,
		};
		store = new LongTaskArtifactStore(artifactRoot, jobId);
		await store.initialize(manifest);
		await writeFile(join(store.jobDirectory, "resume.json"), `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
	}

	const benchmark = new OwnedLongHorizonBenchmarkAdapter(stored.benchmarkRoot);
	const identityValue = await benchmark.identity();
	if (identityValue.resolvedDigest !== stored.manifest.benchmark.resolvedDigest)
		throw new Error("Resolved long-horizon benchmark digest changed since job creation");
	const byId = new Map((await benchmark.listCases(stored.suite)).map((testCase) => [testCase.id, testCase]));
	const cases = stored.selectedCaseIds.map((id): EvalCase => {
		const testCase = byId.get(id);
		if (testCase === undefined) throw new Error(`Benchmark no longer contains selected case ${id}`);
		return testCase;
	});
	await writeEvalJobIndex(store.jobDirectory, {
		schemaVersion: 1,
		jobId: stored.manifest.jobId,
		profile: "long-horizon",
		createdAt: stored.manifest.createdAt,
		model: { provider: stored.provider, id: stored.model },
	});
	if (stored.agents[0]!.kind === "ever" || stored.agents[0]!.kind === "command") {
		await assertOracleGate(
			artifactRoot,
			required(stored.oracleJobId, "--oracle-job for model-backed jobs"),
			stored.manifest.benchmark.resolvedDigest,
			stored.selectedCaseIds,
		);
	}
	const runner = new LongTaskEvalRunner(benchmark, new DockerEnvironmentAdapter(), store);
	if (stored.plans !== undefined) await store.writePlans(stored.plans);
	const results = await runner.run({
		manifest: stored.manifest,
		cases,
		agents: makeAgents(stored, cases),
		...(stored.plans === undefined
			? {}
			: {
					longHorizon: {
						plans: stored.plans,
						suite: stored.suite,
						lane: stored.lane ?? "resilience",
					},
				}),
	});
	assertEvalJobPassed(results);
	console.log(`Long-horizon Eval job passed: ${store.jobDirectory}`);
}
