import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listEvalJobs, writeEvalJobIndex } from "./eval-product/job.ts";
import { formatEvalOverview, persistEvalOverview } from "./eval-product/report.ts";
import { executeLongTaskCommand } from "./long-task-evals/cli.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = resolve(packageRoot, ".eval");

function printHelp(): void {
	console.log(`Usage:
  npm run eval -- quick --provider <provider> --model <model> [--suite smoke|all]
  npm run eval -- benchmark <benchmark-options>
  npm run eval -- report [job-id]

Profiles:
  quick      Lightweight Pi Agent eval. Defaults to src/smoke.eval.ts and does not use Docker.
  benchmark  Docker-isolated external benchmark with official verifier and Oracle gate.
  report     List Eval jobs or render one unified report.`);
}

function quickSelection(args: string[]): {
	provider: string;
	model: string;
	suite: "smoke" | "all";
	vitestArgs: string[];
} {
	let provider: string | undefined;
	let model: string | undefined;
	let suite: "smoke" | "all" = "smoke";
	const vitestArgs: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--provider" || arg === "--model" || arg === "--suite") {
			const value = args[index + 1];
			if (value === undefined || value.startsWith("-")) throw new Error(`${arg} requires a value`);
			if (arg === "--provider") provider = value;
			else if (arg === "--model") model = value;
			else if (value === "smoke" || value === "all") suite = value;
			else throw new Error("--suite must be smoke or all");
			index += 1;
			continue;
		}
		if (arg.startsWith("--provider=")) provider = arg.slice("--provider=".length);
		else if (arg.startsWith("--model=")) model = arg.slice("--model=".length);
		else if (arg.startsWith("--suite=")) {
			const value = arg.slice("--suite=".length);
			if (value !== "smoke" && value !== "all") throw new Error("--suite must be smoke or all");
			suite = value;
		} else vitestArgs.push(arg);
	}
	provider = provider?.trim() || process.env.PI_PROVIDER?.trim() || undefined;
	model = model?.trim() || process.env.PI_MODEL?.trim() || undefined;
	if (Boolean(provider) !== Boolean(model)) throw new Error("Quick Eval requires both provider and model");
	if (provider === undefined || model === undefined) {
		throw new Error("Quick Eval requires --provider and --model, or PI_PROVIDER and PI_MODEL");
	}
	return { provider, model, suite, vitestArgs };
}

async function runQuick(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(`Usage: npm run eval -- quick --provider <provider> --model <model> [--suite smoke|all] [vitest-options]

The smoke suite runs one end-to-end Pi Agent prompt. The all suite runs every src/**/*.eval.ts file.`);
		return 0;
	}
	const selection = quickSelection(args);
	const configuredDirectory = process.env.PI_EVAL_ARTIFACT_DIR?.trim();
	const jobId = configuredDirectory
		? basename(resolve(packageRoot, configuredDirectory))
		: `${new Date().toISOString().replaceAll(":", "-")}_${randomUUID()}`;
	const jobDirectory = configuredDirectory ? resolve(packageRoot, configuredDirectory) : join(artifactRoot, jobId);
	await writeEvalJobIndex(jobDirectory, {
		schemaVersion: 1,
		jobId,
		profile: "quick",
		createdAt: new Date().toISOString(),
		model: { provider: selection.provider, id: selection.model },
	});

	const require = createRequire(import.meta.url);
	const vitestPackagePath = require.resolve("vitest/package.json");
	const vitestCliPath = resolve(dirname(vitestPackagePath), "vitest.mjs");
	const testArgs =
		selection.vitestArgs.length > 0 ? selection.vitestArgs : selection.suite === "smoke" ? ["src/smoke.eval.ts"] : [];
	const childEnvironment: NodeJS.ProcessEnv = {
		...process.env,
		PI_EVAL_ARTIFACT_DIR: jobDirectory,
		PI_EVAL_JOB_ID: jobId,
		PI_EVAL_PROFILE: "quick",
	};
	childEnvironment.PI_PROVIDER = selection.provider;
	childEnvironment.PI_MODEL = selection.model;
	mkdirSync(jobDirectory, { recursive: true, mode: 0o700 });
	console.error(`[eval] profile=quick job=${jobId}`);
	console.error(`[eval] model=${selection.provider}/${selection.model}`);
	const result = spawnSync(process.execPath, [vitestCliPath, "run", "--config", "vitest.config.ts", ...testArgs], {
		cwd: packageRoot,
		stdio: "inherit",
		env: childEnvironment,
	});
	if (result.error) throw result.error;
	return result.status ?? 1;
}

async function runReport(args: string[]): Promise<number> {
	const jobId = args.find((arg) => !arg.startsWith("-"));
	if (jobId === undefined) {
		const jobs = await listEvalJobs(artifactRoot);
		if (jobs.length === 0) {
			console.log("No Eval jobs found.");
			return 0;
		}
		console.log("JOB ID\tPROFILE\tMODEL\tCREATED");
		for (const job of jobs.slice(0, 20)) {
			console.log(
				`${job.jobId}\t${job.profile}\t${job.model ? `${job.model.provider}/${job.model.id}` : "-"}\t${job.createdAt}`,
			);
		}
		return 0;
	}
	const report = await persistEvalOverview(artifactRoot, jobId);
	process.stdout.write(formatEvalOverview(report));
	return 0;
}

export async function runEvalCommand(args: string[]): Promise<number> {
	const command = args[0];
	if (command === undefined || command === "help" || command === "--help" || command === "-h") {
		printHelp();
		return 0;
	}
	if (command === "quick") return await runQuick(args.slice(1));
	if (command === "benchmark") {
		await executeLongTaskCommand(args.slice(1));
		return typeof process.exitCode === "number" ? process.exitCode : 0;
	}
	if (command === "report") return await runReport(args.slice(1));
	throw new Error(`Unknown Eval command: ${command}. Expected quick, benchmark, or report.`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runEvalCommand(process.argv.slice(2))
		.then((status) => {
			process.exitCode = status;
		})
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
}
