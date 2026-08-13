import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertEvalJobId, writeEvalJobIndex } from "../eval-product/job.ts";
import { persistEvalOverview } from "../eval-product/report.ts";
import { runProcess } from "../long-task-evals/process.ts";
import { digestPath } from "./hash.ts";
import { assertExternalEvalConfig, type ExternalEvalConfig, type ExternalEvalTrialResult } from "./schemas.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultArtifactRoot = join(packageRoot, ".eval");
const shimRoot = join(packageRoot, "harbor_agent");

interface HarborTrialResult {
	task_name?: unknown;
	trial_name?: unknown;
	task_checksum?: unknown;
	agent_info?: unknown;
	agent_result?: unknown;
	verifier_result?: unknown;
	exception_info?: unknown;
	started_at?: unknown;
	finished_at?: unknown;
}

interface HarborJobResult {
	n_total_trials?: unknown;
	trial_results?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeTrial(value: unknown, index: number): ExternalEvalTrialResult {
	const trial = record(value) as HarborTrialResult | undefined;
	if (trial === undefined) throw new Error(`Invalid Harbor trial result at index ${index}`);
	const verifier = record(trial.verifier_result);
	const rewards = record(verifier?.rewards) ?? {};
	const metrics: Record<string, number> = {};
	for (const [name, metric] of Object.entries(rewards)) {
		const numeric = finite(metric);
		if (numeric !== undefined) metrics[name] = numeric;
	}
	const agent = record(trial.agent_result);
	const agentInfo = record(trial.agent_info);
	const modelInfo = record(agentInfo?.model_info);
	const modelName = text(modelInfo?.name);
	const modelProvider = text(modelInfo?.provider);
	const model =
		modelName === undefined ? undefined : modelProvider === undefined ? modelName : `${modelProvider}/${modelName}`;
	const startedAt = text(trial.started_at);
	const finishedAt = text(trial.finished_at);
	const wallTimeMs =
		startedAt !== undefined && finishedAt !== undefined
			? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt))
			: undefined;
	const exception = record(trial.exception_info);
	return {
		trialName: text(trial.trial_name) ?? `trial-${index + 1}`,
		taskName: text(trial.task_name) ?? `task-${index + 1}`,
		...(text(trial.task_checksum) === undefined ? {} : { taskDigest: text(trial.task_checksum) }),
		agent: {
			name: text(agentInfo?.name) ?? "unknown",
			version: text(agentInfo?.version) ?? "unknown",
			...(model === undefined ? {} : { model }),
		},
		completed: exception === undefined,
		metrics,
		...(Number.isFinite(wallTimeMs) ? { wallTimeMs } : {}),
		...(finite(agent?.n_input_tokens) === undefined ? {} : { inputTokens: finite(agent?.n_input_tokens) }),
		...(finite(agent?.n_output_tokens) === undefined ? {} : { outputTokens: finite(agent?.n_output_tokens) }),
		...(finite(agent?.cost_usd) === undefined ? {} : { costUsd: finite(agent?.cost_usd) }),
		...(exception === undefined
			? {}
			: { error: text(exception.exception_message) ?? text(exception.message) ?? JSON.stringify(exception) }),
	};
}

async function readHarborTrials(jobDirectory: string): Promise<unknown[]> {
	const resultPath = join(jobDirectory, "result.json");
	const summary = JSON.parse(await readFile(resultPath, "utf8")) as HarborJobResult;
	if (Array.isArray(summary.trial_results)) return summary.trial_results;

	const trials: unknown[] = [];
	for (const entry of await readdir(jobDirectory, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		try {
			trials.push(JSON.parse(await readFile(join(jobDirectory, entry.name, "result.json"), "utf8")) as unknown);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	if (trials.length === 0 && summary.n_total_trials !== 0)
		throw new Error("Harbor result has no embedded or per-trial results");
	return trials;
}

async function readConfig(path: string): Promise<ExternalEvalConfig> {
	const value = JSON.parse(await readFile(path, "utf8")) as unknown;
	assertExternalEvalConfig(value);
	return value;
}

async function verifyBenchmark(config: ExternalEvalConfig): Promise<void> {
	if (config.benchmark.kind !== "local") return;
	const actualDigest = await digestPath(config.benchmark.path);
	if (actualDigest !== config.benchmark.sha256)
		throw new Error(`Local benchmark digest mismatch: expected ${config.benchmark.sha256}, got ${actualDigest}`);
}

async function snapshotBenchmark(config: ExternalEvalConfig, jobDirectory: string): Promise<ExternalEvalConfig> {
	if (config.benchmark.kind !== "local") return config;
	const snapshotPath = join(jobDirectory, "benchmark-snapshot");
	await cp(config.benchmark.path, snapshotPath, { recursive: true, errorOnExist: true, force: false });
	const snapshot = { ...config, benchmark: { ...config.benchmark, path: snapshotPath } };
	await verifyBenchmark(snapshot);
	return snapshot;
}

function resolveConfigPaths(config: ExternalEvalConfig, configDirectory: string): ExternalEvalConfig {
	return {
		...config,
		benchmark:
			config.benchmark.kind === "local"
				? { ...config.benchmark, path: resolve(configDirectory, config.benchmark.path) }
				: config.benchmark,
		agent:
			config.agent.kind === "ever"
				? {
						...config.agent,
						artifact: { ...config.agent.artifact, path: resolve(configDirectory, config.agent.artifact.path) },
					}
				: config.agent,
	};
}

function harborConfig(config: ExternalEvalConfig, jobDirectory: string): Record<string, unknown> {
	const admittedTasks = Math.floor(config.execution.maxTrials / config.execution.repetitions);
	const dataset =
		config.benchmark.kind === "dataset"
			? {
					name: config.benchmark.name,
					ref: config.benchmark.ref,
					...(config.benchmark.taskNames === undefined ? {} : { task_names: config.benchmark.taskNames }),
					n_tasks: Math.min(config.benchmark.nTasks ?? admittedTasks, admittedTasks),
				}
			: {
					path: config.benchmark.path,
					...(config.benchmark.taskNames === undefined ? {} : { task_names: config.benchmark.taskNames }),
					n_tasks: Math.min(config.benchmark.nTasks ?? admittedTasks, admittedTasks),
				};
	const agent =
		config.agent.kind === "ever"
			? {
					name: config.agent.name,
					import_path: "ever_agent:EverAgent",
					model_name: config.agent.model,
					kwargs: {
						version: config.agent.version,
						artifact_path: config.agent.artifact.path,
						artifact_sha256: config.agent.artifact.sha256,
						command: config.agent.artifact.command,
						...(config.agent.credentialFileEnv === undefined
							? {}
							: { credential_file_env: config.agent.credentialFileEnv }),
						...(config.agent.maxTurns === undefined ? {} : { max_turns: config.agent.maxTurns }),
						max_wall_time_minutes: Math.ceil(config.execution.maxWallTimeMinutes),
						...(config.execution.maxCostUsd === undefined
							? {}
							: { max_cost_usd: config.execution.maxCostUsd / config.execution.maxTrials }),
					},
				}
			: {
					name: config.agent.name,
					...(config.agent.model === undefined ? {} : { model_name: config.agent.model }),
				};
	return {
		job_name: "harbor-job",
		jobs_dir: join(jobDirectory, "harbor"),
		n_attempts: config.execution.repetitions,
		n_concurrent_trials: config.execution.concurrency,
		quiet: true,
		environment: { type: config.execution.environment },
		agents: [agent],
		datasets: [dataset],
	};
}

function assertEnvironmentNames(config: ExternalEvalConfig): void {
	const names =
		config.agent.kind === "ever"
			? config.agent.credentialFileEnv === undefined
				? []
				: [config.agent.credentialFileEnv]
			: (config.agent.env ?? []);
	for (const name of names) {
		if (!process.env[name]?.trim()) throw new Error(`External Eval requires environment variable ${name}`);
	}
}

export interface ExternalBenchmarkRun {
	jobId: string;
	jobDirectory: string;
	results: ExternalEvalTrialResult[];
}

export class ExternalBenchmarkRunner {
	readonly artifactRoot: string;

	constructor(artifactRoot = defaultArtifactRoot) {
		this.artifactRoot = resolve(artifactRoot);
	}

	async run(configPath: string): Promise<ExternalBenchmarkRun> {
		const absoluteConfigPath = resolve(configPath);
		let config = resolveConfigPaths(await readConfig(absoluteConfigPath), dirname(absoluteConfigPath));
		assertEnvironmentNames(config);
		const jobId = `${new Date().toISOString().replaceAll(":", "-")}_${randomUUID()}`;
		const jobDirectory = join(this.artifactRoot, jobId);
		const modelSeparator = config.agent.model?.indexOf("/") ?? -1;
		const modelIdentity =
			config.agent.model === undefined
				? undefined
				: modelSeparator === -1
					? { provider: config.agent.name, id: config.agent.model }
					: {
							provider: config.agent.model.slice(0, modelSeparator),
							id: config.agent.model.slice(modelSeparator + 1),
						};
		await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
		config = await snapshotBenchmark(config, jobDirectory);
		await writeEvalJobIndex(jobDirectory, {
			schemaVersion: 1,
			jobId,
			profile: "external",
			createdAt: new Date().toISOString(),
			...(modelIdentity === undefined ? {} : { model: modelIdentity }),
		});
		await writeFile(join(jobDirectory, "external-config.json"), `${JSON.stringify(config, null, 2)}\n`, {
			mode: 0o600,
		});
		await writeFile(
			join(jobDirectory, "harbor-config.json"),
			`${JSON.stringify(harborConfig(config, jobDirectory), null, 2)}\n`,
			{
				mode: 0o600,
			},
		);
		return await this.execute(config, jobId, jobDirectory, false);
	}

	async resume(jobId: string): Promise<ExternalBenchmarkRun> {
		assertEvalJobId(jobId);
		const jobDirectory = join(this.artifactRoot, jobId);
		const config = await readConfig(join(jobDirectory, "external-config.json"));
		assertEnvironmentNames(config);
		await verifyBenchmark(config);
		return await this.execute(config, jobId, jobDirectory, true);
	}

	private async execute(
		config: ExternalEvalConfig,
		jobId: string,
		jobDirectory: string,
		resume: boolean,
	): Promise<ExternalBenchmarkRun> {
		const executable = config.engine.executable ?? "harbor";
		const version = await runProcess(executable, ["--version"], { timeoutSeconds: 30 });
		if (version.exitCode !== 0 || version.timedOut)
			throw new Error(`Harbor preflight failed: ${version.stderr.trim()}`);
		const versionPattern = new RegExp(`(^|\\s)${config.engine.version.replaceAll(".", "\\.")}($|\\s)`);
		if (!versionPattern.test(`${version.stdout}\n${version.stderr}`))
			throw new Error(`Harbor version mismatch: required ${config.engine.version}`);
		const args = resume
			? ["job", "resume", "-p", join(jobDirectory, "harbor", "harbor-job")]
			: ["run", "--config", join(jobDirectory, "harbor-config.json"), "--yes"];
		const environment = {
			...process.env,
			PYTHONPATH: [shimRoot, process.env.PYTHONPATH]
				.filter((value) => value !== undefined && value !== "")
				.join(delimiter),
		};
		const result = await runProcess(executable, args, {
			cwd: packageRoot,
			env: environment,
			timeoutSeconds: config.execution.maxWallTimeMinutes * 60,
		});
		await writeFile(
			join(jobDirectory, resume ? "harbor-resume.log" : "harbor-run.log"),
			`${result.stdout}\n${result.stderr}`,
			{
				mode: 0o600,
			},
		);
		if (result.timedOut)
			throw new Error(`External Eval exceeded ${config.execution.maxWallTimeMinutes} minute wall-time budget`);
		if (result.exitCode !== 0) throw new Error(`Harbor exited with code ${result.exitCode}`);
		const rawTrials = await readHarborTrials(join(jobDirectory, "harbor", "harbor-job"));
		if (rawTrials.length > config.execution.maxTrials)
			throw new Error(
				`Harbor produced ${rawTrials.length} trials, exceeding maxTrials=${config.execution.maxTrials}`,
			);
		const results = rawTrials.map(normalizeTrial);
		await writeFile(join(jobDirectory, "external-results.json"), `${JSON.stringify(results, null, 2)}\n`, {
			mode: 0o600,
		});
		const failures = await this.writeAcceptance(config, jobDirectory, results);
		await persistEvalOverview(this.artifactRoot, jobId);
		if (failures.length > 0) throw new Error(`External Eval acceptance failed: ${failures.join("; ")}`);
		return { jobId, jobDirectory, results };
	}

	private async writeAcceptance(
		config: ExternalEvalConfig,
		jobDirectory: string,
		results: ExternalEvalTrialResult[],
	): Promise<string[]> {
		const failures: string[] = [];
		if (results.length === 0) failures.push("Harbor produced no trials");
		if (config.benchmark.nTasks !== undefined) {
			const expectedTrials =
				Math.min(config.benchmark.nTasks, Math.floor(config.execution.maxTrials / config.execution.repetitions)) *
				config.execution.repetitions;
			if (results.length !== expectedTrials) failures.push(`trials=${results.length}, expected=${expectedTrials}`);
		}
		for (const result of results) {
			if (result.agent.name !== config.agent.name || result.agent.version !== config.agent.version)
				failures.push(
					`${result.trialName}: agent=${result.agent.name}@${result.agent.version}, required ${config.agent.name}@${config.agent.version}`,
				);
			if (config.agent.model !== undefined && result.agent.model !== config.agent.model)
				failures.push(
					`${result.trialName}: model=${result.agent.model ?? "missing"}, required ${config.agent.model}`,
				);
			if (!result.completed) {
				if (!config.acceptance.allowIncomplete) failures.push(`${result.trialName}: incomplete`);
				continue;
			}
			for (const [metric, threshold] of Object.entries(config.acceptance.metrics)) {
				const actual = result.metrics[metric];
				if (actual === undefined || actual < threshold)
					failures.push(`${result.trialName}: ${metric}=${actual ?? "missing"} < ${threshold}`);
			}
		}
		const totalCostUsd = results.reduce((total, result) => total + (result.costUsd ?? 0), 0);
		if (config.execution.maxCostUsd !== undefined) {
			if (results.some((result) => result.completed && result.costUsd === undefined))
				failures.push("cost telemetry missing for a completed trial");
			else if (totalCostUsd > config.execution.maxCostUsd)
				failures.push(`cost=$${totalCostUsd.toFixed(4)} > $${config.execution.maxCostUsd.toFixed(4)}`);
		}
		const acceptance = { passed: failures.length === 0, failures, totalCostUsd };
		await writeFile(join(jobDirectory, "acceptance.json"), `${JSON.stringify(acceptance, null, 2)}\n`, {
			mode: 0o600,
		});
		return failures;
	}
}
