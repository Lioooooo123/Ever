import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { writeEvalJobIndex } from "../eval-product/job.ts";
import type { EvalJobManifest } from "./artifacts.ts";
import { assertEvalJobManifest, LongTaskArtifactStore } from "./artifacts.ts";
import {
	CodexAgentAdapter,
	CommandAgentAdapter,
	type CommandAgentConfig,
	TerminusAgentAdapter,
} from "./command-agent.ts";
import { formatComparisonMarkdown, summarizeResults } from "./comparison.ts";
import { DockerEnvironmentAdapter } from "./docker-environment.ts";
import { EverAgentAdapter } from "./ever-agent.ts";
import { type FaultSpec, ProcessFaultInjector } from "./faults.ts";
import { exportRedactedJob } from "./redaction.ts";
import { LongTaskEvalRunner } from "./runner.ts";
import type { AgentIdentity, EvalCase } from "./schemas.ts";
import { selectDeterministicCases } from "./task-selection.ts";
import { TerminalBench21Adapter } from "./terminal-bench-2-1.ts";

interface StoredAgentConfig {
	kind: "ever" | "command";
	name: string;
	version: string;
	executableDigest: string;
	configurationDigest: string;
	command: string[];
	forwardEnvironment?: string[];
	preparation?: CommandAgentConfig["preparation"];
}

interface StoredJobConfig {
	schemaVersion: 1;
	benchmarkRoot: string;
	provider: string;
	model: string;
	maxCostUsd?: number;
	agents: StoredAgentConfig[];
	selectedCaseIds: string[];
	manifest: EvalJobManifest;
	faults?: { profile: string; schedule: FaultSpec[] };
	oracleJobId?: string;
}

function required(value: string | undefined, option: string): string {
	if (value === undefined || value.trim() === "") throw new Error(`${option} is required`);
	return value;
}

function finiteBudget(value: string | undefined): number {
	const parsed = Number(required(value, "--max-cost-usd"));
	if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--max-cost-usd must be a positive number");
	return parsed;
}

function environmentFor(keys: readonly string[] | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key of keys ?? []) {
		const value = process.env[key];
		if (value === undefined) throw new Error(`Required credential environment variable is missing: ${key}`);
		result[key] = value;
	}
	return result;
}

function assertAgentConfig(value: unknown): asserts value is StoredAgentConfig[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("Agent config must be a non-empty JSON array");
	for (const agent of value) {
		if (typeof agent !== "object" || agent === null || Array.isArray(agent))
			throw new Error("Agent config entry must be an object");
		for (const key of ["kind", "name", "version", "executableDigest", "configurationDigest"] as const) {
			if (typeof Reflect.get(agent, key) !== "string" || Reflect.get(agent, key) === "")
				throw new Error(`Agent config ${key} is required`);
		}
		if (
			!Array.isArray(Reflect.get(agent, "command")) ||
			!Reflect.get(agent, "command").every((item: unknown) => typeof item === "string")
		) {
			throw new Error("Agent config command must be a string array");
		}
		if (!/^[a-f0-9]{64}$/.test(String(Reflect.get(agent, "executableDigest"))))
			throw new Error("Agent executableDigest must be SHA-256");
		if (!/^[a-f0-9]{64}$/.test(String(Reflect.get(agent, "configurationDigest"))))
			throw new Error("Agent configurationDigest must be SHA-256");
		if (Reflect.get(agent, "kind") !== "ever" && Reflect.get(agent, "kind") !== "command")
			throw new Error("Agent kind must be ever or command");
	}
}

function assertFaultSchedule(value: unknown): asserts value is FaultSpec[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("Fault schedule must be a non-empty JSON array");
	const supported = new Set([
		"kill_agent_process",
		"kill_daemon_process",
		"pause_agent_process",
		"terminate_container",
	]);
	for (const fault of value) {
		if (typeof fault !== "object" || fault === null || Array.isArray(fault))
			throw new Error("Fault entry must be an object");
		const type = Reflect.get(fault, "type");
		const afterMs = Reflect.get(fault, "afterMs");
		if (!supported.has(String(type))) throw new Error(`Unsupported fault type: ${String(type)}`);
		if (!Number.isSafeInteger(afterMs) || Number(afterMs) < 0)
			throw new Error("Fault afterMs must be a non-negative integer");
		const durationMs = Reflect.get(fault, "durationMs");
		if (type === "pause_agent_process" && (!Number.isSafeInteger(durationMs) || Number(durationMs) < 1)) {
			throw new Error("pause_agent_process durationMs must be a positive integer");
		}
	}
}

function makeIdentity(config: StoredAgentConfig, provider: string, model: string): AgentIdentity {
	return {
		name: config.name,
		version: config.version,
		executableDigest: config.executableDigest,
		modelProvider: provider,
		modelId: model,
		configurationDigest: config.configurationDigest,
	};
}

function makeAgents(config: StoredJobConfig) {
	return config.agents.map((agent) => {
		const identity = makeIdentity(agent, config.provider, config.model);
		const environment = (): Record<string, string> => environmentFor(agent.forwardEnvironment);
		if (agent.kind === "ever") {
			if (agent.command.length !== 1) throw new Error("Ever agent command must contain exactly one executable");
			if (config.maxCostUsd === undefined) throw new Error("Ever agent requires a job cost budget");
			return new EverAgentAdapter({
				identity,
				command: agent.command[0],
				environment,
				preparation: agent.preparation,
				maxCostUsd: config.maxCostUsd,
			});
		}
		const commandConfig: CommandAgentConfig = {
			identity,
			command: agent.command,
			environment,
			preparation: agent.preparation,
		};
		if (agent.name === "codex") return new CodexAgentAdapter(commandConfig);
		if (agent.name === "terminus-2") return new TerminusAgentAdapter(commandConfig);
		return new CommandAgentAdapter(commandConfig);
	});
}

async function report(artifactRoot: string, jobId: string): Promise<void> {
	const store = new LongTaskArtifactStore(artifactRoot, jobId);
	await readFile(join(store.jobDirectory, "job.json"), "utf8");
	const comparison = summarizeResults(await store.loadResults());
	const markdown = formatComparisonMarkdown(comparison);
	await store.writeComparisonJson({ schemaVersion: 1, jobId, agents: comparison });
	await store.writeComparison(markdown);
	process.stdout.write(markdown);
}

async function assertOracleGate(
	artifactRoot: string,
	jobId: string,
	benchmarkDigest: string,
	caseIds: readonly string[],
): Promise<void> {
	const store = new LongTaskArtifactStore(artifactRoot, jobId);
	const manifestValue = JSON.parse(await readFile(join(store.jobDirectory, "job.json"), "utf8")) as unknown;
	assertEvalJobManifest(manifestValue);
	if (manifestValue.benchmark.resolvedDigest !== benchmarkDigest)
		throw new Error("Oracle job benchmark digest does not match");
	const results = await store.loadResults();
	for (const caseId of caseIds) {
		const passed = results.some(
			(result) =>
				result.caseId === caseId &&
				result.agent.name === "oracle" &&
				result.official.valid &&
				(result.official.metrics.reward ?? Number.NEGATIVE_INFINITY) >= 1,
		);
		if (!passed) throw new Error(`Oracle gate has no passing official result for ${caseId}`);
	}
}

export async function executeLongTaskCommand(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			benchmark: { type: "string" },
			"benchmark-root": { type: "string" },
			agents: { type: "string" },
			provider: { type: "string" },
			model: { type: "string" },
			"max-cost-usd": { type: "string" },
			"agent-config": { type: "string" },
			subset: { type: "string" },
			repetitions: { type: "string" },
			resume: { type: "string" },
			report: { type: "string" },
			"artifact-root": { type: "string" },
			redact: { type: "string" },
			"secret-env": { type: "string", multiple: true },
			"fault-profile": { type: "string" },
			"fault-schedule": { type: "string" },
			"oracle-job": { type: "string" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: false,
	});
	if (values.help) {
		console.log(`Usage:
  npm run eval -- benchmark --benchmark terminal-bench-2-1 --benchmark-root <path> --agent-config <path> --agents oracle --subset development
  npm run eval -- benchmark --benchmark terminal-bench-2-1 --benchmark-root <path> --agent-config <path> --agents <names> --oracle-job <id> --provider <provider> --model <exact-id> --max-cost-usd <amount>
  npm run eval -- benchmark --resume <job-id>`);
		return;
	}
	const artifactRoot = resolve(values["artifact-root"] ?? join(import.meta.dirname, "../../.eval"));
	if (values.redact !== undefined) {
		const source = new LongTaskArtifactStore(artifactRoot, values.redact).jobDirectory;
		await readFile(join(source, "job.json"), "utf8");
		const secretValues = (values["secret-env"] ?? []).map((name) =>
			required(process.env[name], `environment ${name}`),
		);
		const destination = join(artifactRoot, `${values.redact}-redacted-${Date.now()}`);
		const redaction = await exportRedactedJob(source, destination, secretValues);
		console.log(`Redacted Eval export: ${destination} (${redaction.redactedFiles.length} files changed)`);
		return;
	}
	if (values.report !== undefined) {
		await report(artifactRoot, values.report);
		return;
	}

	let stored: StoredJobConfig;
	let store: LongTaskArtifactStore;
	if (values.resume !== undefined) {
		store = new LongTaskArtifactStore(artifactRoot, values.resume);
		stored = JSON.parse(await readFile(join(store.jobDirectory, "resume.json"), "utf8")) as StoredJobConfig;
		if (stored.schemaVersion !== 1) throw new Error("Unsupported resume config schemaVersion");
	} else {
		if (values.benchmark !== "terminal-bench-2-1") throw new Error("V1 supports --benchmark terminal-bench-2-1");
		const benchmarkRoot = resolve(
			required(values["benchmark-root"] ?? process.env.TERMINAL_BENCH_ROOT, "--benchmark-root"),
		);
		const configured = JSON.parse(
			await readFile(resolve(required(values["agent-config"], "--agent-config")), "utf8"),
		) as unknown;
		assertAgentConfig(configured);
		const selectedNames = new Set(
			required(values.agents, "--agents")
				.split(",")
				.map((name) => name.trim()),
		);
		const agents = configured.filter((agent) => selectedNames.has(agent.name));
		if (agents.length !== selectedNames.size) throw new Error("--agents contains a name missing from --agent-config");
		const modelBacked = agents.some((agent) => agent.name !== "oracle");
		const provider = modelBacked ? required(values.provider, "--provider") : (values.provider ?? "none");
		const model = modelBacked ? required(values.model, "--model") : (values.model ?? "oracle");
		const maxCostUsd = modelBacked ? finiteBudget(values["max-cost-usd"]) : undefined;
		const oracleJobId = modelBacked ? required(values["oracle-job"], "--oracle-job") : undefined;
		let faults: StoredJobConfig["faults"];
		if (values["fault-profile"] !== undefined || values["fault-schedule"] !== undefined) {
			const profile = required(values["fault-profile"], "--fault-profile");
			if (!profile.startsWith("ever-reliability"))
				throw new Error("--fault-profile must start with ever-reliability");
			const schedule = JSON.parse(
				await readFile(resolve(required(values["fault-schedule"], "--fault-schedule")), "utf8"),
			) as unknown;
			assertFaultSchedule(schedule);
			faults = { profile, schedule };
		}
		const benchmark = new TerminalBench21Adapter(benchmarkRoot);
		const allCases = await benchmark.listCases();
		const selectedCases = selectDeterministicCases(
			allCases,
			"terminal-bench-2-1",
			values.subset === "development" || values.subset === undefined ? 10 : Number(values.subset),
		);
		const repetitions = values.repetitions === undefined ? 3 : Number(values.repetitions);
		if (!Number.isSafeInteger(repetitions) || repetitions < 1)
			throw new Error("--repetitions must be a positive integer");
		const jobId = `${new Date().toISOString().replaceAll(":", "-")}_${randomUUID()}`;
		const manifest: EvalJobManifest = {
			schemaVersion: 1,
			jobId,
			createdAt: new Date().toISOString(),
			benchmark: await benchmark.identity(),
			agents: agents.map((agent) => makeIdentity(agent, provider, model)),
			caseIds: selectedCases.map((testCase) => testCase.id),
			repetitions,
			...(maxCostUsd === undefined ? {} : { maxCostUsd }),
			...(faults === undefined ? {} : { faultProfile: faults.profile }),
		};
		stored = {
			schemaVersion: 1,
			benchmarkRoot,
			provider,
			model,
			...(maxCostUsd === undefined ? {} : { maxCostUsd }),
			agents,
			selectedCaseIds: manifest.caseIds,
			manifest,
			...(faults === undefined ? {} : { faults }),
			...(oracleJobId === undefined ? {} : { oracleJobId }),
		};
		store = new LongTaskArtifactStore(artifactRoot, jobId);
		await store.initialize(manifest);
		await writeFile(join(store.jobDirectory, "resume.json"), `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
	}

	const benchmark = new TerminalBench21Adapter(stored.benchmarkRoot);
	const byId = new Map((await benchmark.listCases()).map((testCase) => [testCase.id, testCase]));
	const cases = stored.selectedCaseIds.map((id): EvalCase => {
		const testCase = byId.get(id);
		if (testCase === undefined) throw new Error(`Resolved benchmark no longer contains selected case ${id}`);
		return testCase;
	});
	if ((await benchmark.identity()).resolvedDigest !== stored.manifest.benchmark.resolvedDigest)
		throw new Error("Resolved benchmark digest changed since job creation");
	await writeEvalJobIndex(store.jobDirectory, {
		schemaVersion: 1,
		jobId: stored.manifest.jobId,
		profile: "benchmark",
		createdAt: stored.manifest.createdAt,
		model: { provider: stored.provider, id: stored.model },
	});
	if (stored.agents.some((agent) => agent.name !== "oracle")) {
		await assertOracleGate(
			artifactRoot,
			required(stored.oracleJobId, "--oracle-job for model-backed jobs"),
			stored.manifest.benchmark.resolvedDigest,
			stored.selectedCaseIds,
		);
	}
	const runner = new LongTaskEvalRunner(benchmark, new DockerEnvironmentAdapter(), store);
	await runner.run({
		manifest: stored.manifest,
		cases,
		agents: makeAgents(stored),
		...(stored.faults === undefined ? {} : { faults: { ...stored.faults, injector: new ProcessFaultInjector() } }),
	});
	console.log(`Eval job completed: ${store.jobDirectory}`);
}
