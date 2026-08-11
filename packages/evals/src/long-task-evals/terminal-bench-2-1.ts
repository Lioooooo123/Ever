import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { BenchmarkAdapter, EvalEnvironment, OfficialVerification } from "./contracts.ts";
import { hashDirectory, hashFile, sha256 } from "./hash.ts";
import type { BenchmarkIdentity, EvalCase } from "./schemas.ts";
import { assertEvalCase } from "./schemas.ts";

function assertInside(root: string, path: string): void {
	const prefix = resolve(root) + sep;
	if (!resolve(path).startsWith(prefix)) throw new Error(`Benchmark path escapes resolved root: ${path}`);
}

function tomlSection(source: string, name: string): string {
	const lines = source.split(/\r?\n/);
	const header = `[${name}]`;
	const start = lines.findIndex((line) => line.trim() === header);
	if (start < 0) return "";
	const section: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.trimStart().startsWith("[")) break;
		section.push(line);
	}
	return section.join("\n");
}

function tomlScalar(source: string, section: string, key: string): string | number | boolean | undefined {
	const match = new RegExp(`^${key}\\s*=\\s*([^#\\r\\n]+)`, "m").exec(tomlSection(source, section));
	if (match === null) return undefined;
	const raw = match[1]!.trim();
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return Number(raw);
	if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) return JSON.parse(raw) as string;
	if (/^'[^']*'$/.test(raw)) return raw.slice(1, -1);
	throw new Error(`Unsupported task.toml value for [${section}].${key}`);
}

async function findTaskRoots(root: string): Promise<string[]> {
	const taskRoots: string[] = [];
	async function visit(directory: string): Promise<void> {
		const children = await readdir(directory, { withFileTypes: true });
		if (children.some((child) => child.isFile() && child.name === "task.toml")) {
			taskRoots.push(directory);
			return;
		}
		for (const child of children) {
			if (child.isSymbolicLink())
				throw new Error(`Benchmark sources may not contain symlinks: ${join(directory, child.name)}`);
			if (child.isDirectory() && child.name !== ".git") await visit(join(directory, child.name));
		}
	}
	await visit(root);
	return taskRoots.sort((left, right) => left.localeCompare(right));
}

function parseRewardJson(value: unknown): Record<string, number> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("reward.json must contain an object");
	const metrics: Record<string, number> = {};
	for (const [key, metric] of Object.entries(value)) {
		if (typeof metric !== "number" || !Number.isFinite(metric))
			throw new Error(`reward.json metric ${key} is not finite`);
		metrics[key] = metric;
	}
	if (Object.keys(metrics).length === 0) throw new Error("reward.json contains no metrics");
	return metrics;
}

export class TerminalBench21Adapter implements BenchmarkAdapter {
	readonly #root: string;
	readonly #source: string;
	#identity?: BenchmarkIdentity;

	constructor(root: string, source = "terminal-bench/terminal-bench-2-1") {
		this.#root = resolve(root);
		this.#source = source;
	}

	async identity(): Promise<BenchmarkIdentity> {
		if (this.#identity !== undefined) return this.#identity;
		const taskRoots = await findTaskRoots(this.#root);
		const resolvedDigest = sha256(
			(
				await Promise.all(
					taskRoots.map(async (taskRoot) => `${relative(this.#root, taskRoot)}\0${await hashDirectory(taskRoot)}`),
				)
			).join("\n"),
		);
		this.#identity = {
			name: "terminal-bench",
			version: "2.1",
			source: this.#source,
			resolvedDigest,
		};
		return this.#identity;
	}

	async listCases(): Promise<EvalCase[]> {
		const identity = await this.identity();
		const cases: EvalCase[] = [];
		for (const taskRoot of await findTaskRoots(this.#root)) {
			const manifestPath = join(taskRoot, "task.toml");
			const instructionPath = join(taskRoot, "instruction.md");
			const environment = join(taskRoot, "environment");
			const tests = join(taskRoot, "tests");
			for (const path of [manifestPath, instructionPath, environment, tests]) assertInside(this.#root, path);
			const manifest = await readFile(manifestPath, "utf8");
			const instruction = (await readFile(instructionPath, "utf8")).trimEnd();
			if (instruction === "") throw new Error(`Task instruction is empty: ${instructionPath}`);
			await readFile(join(environment, "Dockerfile"));
			await readFile(join(tests, "test.sh"));
			const declaredName = tomlScalar(manifest, "task", "name");
			const id =
				typeof declaredName === "string" && declaredName !== "" ? declaredName : relative(this.#root, taskRoot);
			const agentTimeout = tomlScalar(manifest, "agent", "timeout_sec");
			const verifierTimeout = tomlScalar(manifest, "verifier", "timeout_sec");
			const networkMode = tomlScalar(manifest, "agent", "network_mode");
			if (networkMode === "allowlist") throw new Error(`V1 cannot enforce allowlisted networking for ${id}`);
			const allowInternet = tomlScalar(manifest, "environment", "allow_internet");
			const cpus = tomlScalar(manifest, "environment", "cpus");
			const memoryMb = tomlScalar(manifest, "environment", "memory_mb");
			const testCase: EvalCase = {
				schemaVersion: 1,
				benchmark: identity,
				id,
				instruction,
				taskRoot,
				environment: {
					kind: "docker",
					buildContext: environment,
					workingDirectory: "/app",
					network:
						networkMode === "public" || networkMode === "allowlist" || allowInternet === true
							? "benchmark_declared"
							: "none",
				},
				verifier: {
					command: ["bash", "/tests/test.sh"],
					testsSource: tests,
					timeoutSeconds:
						typeof verifierTimeout === "number" && verifierTimeout > 0 ? Math.ceil(verifierTimeout) : 300,
				},
				limits: {
					trialTimeoutSeconds:
						typeof agentTimeout === "number" && agentTimeout > 0 ? Math.ceil(agentTimeout) : 1200,
				},
				metadata: {
					manifestDigest: await hashFile(manifestPath),
					verifierDigest: await hashDirectory(tests),
					...(typeof cpus === "number" && cpus > 0 ? { cpus } : {}),
					...(typeof memoryMb === "number" && memoryMb > 0 ? { memoryMb } : {}),
				},
			};
			assertEvalCase(testCase);
			cases.push(testCase);
		}
		return cases;
	}

	async verify(testCase: EvalCase, environment: EvalEnvironment, runDirectory: string): Promise<OfficialVerification> {
		await environment.copyIn(testCase.verifier.testsSource, "/tests");
		const startedAt = performance.now();
		const result = await environment.exec({
			args: testCase.verifier.command,
			cwd: testCase.environment.workingDirectory,
			timeoutSeconds: testCase.verifier.timeoutSeconds,
		});
		const verifierDirectory = join(runDirectory, "verifier");
		await mkdir(verifierDirectory, { recursive: true, mode: 0o700 });
		await writeFile(join(verifierDirectory, "stdout.txt"), result.stdout, { mode: 0o600 });
		await writeFile(join(verifierDirectory, "stderr.txt"), result.stderr, { mode: 0o600 });
		await writeFile(
			join(verifierDirectory, "execution.json"),
			`${JSON.stringify({ exitCode: result.exitCode, timedOut: result.timedOut, wallTimeMs: performance.now() - startedAt }, null, 2)}\n`,
			{ mode: 0o600 },
		);
		if (result.timedOut) {
			return {
				valid: false,
				metrics: {},
				exitCode: result.exitCode ?? undefined,
				errors: [{ source: "verifier", code: "timeout", message: "Official verifier timed out" }],
			};
		}

		try {
			const rewardJson = await environment.readFile("/logs/verifier/reward.json");
			if (rewardJson !== undefined) {
				await writeFile(join(verifierDirectory, "reward.json"), rewardJson, { mode: 0o600 });
				return {
					valid: true,
					metrics: parseRewardJson(JSON.parse(rewardJson) as unknown),
					exitCode: result.exitCode ?? undefined,
					errors: [],
				};
			}
			const rewardText = await environment.readFile("/logs/verifier/reward.txt");
			if (rewardText === undefined) throw new Error("Official verifier did not produce reward.json or reward.txt");
			const reward = Number(rewardText.trim());
			if (!Number.isFinite(reward)) throw new Error("reward.txt is not a finite number");
			await writeFile(join(verifierDirectory, "reward.txt"), rewardText, { mode: 0o600 });
			return { valid: true, metrics: { reward }, exitCode: result.exitCode ?? undefined, errors: [] };
		} catch (error) {
			return {
				valid: false,
				metrics: {},
				exitCode: result.exitCode ?? undefined,
				errors: [
					{
						source: "verifier",
						code: "invalid_reward",
						message: error instanceof Error ? error.message : String(error),
					},
				],
			};
		}
	}
}
