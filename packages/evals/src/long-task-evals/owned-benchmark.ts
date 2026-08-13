import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { BenchmarkAdapter, EvalEnvironment, OfficialVerification } from "./contracts.ts";
import { hashDirectory, hashFile } from "./hash.ts";
import type { BenchmarkIdentity, EvalCase } from "./schemas.ts";
import { assertEvalCase } from "./schemas.ts";
import { SemanticFaultScenarioSchema } from "./semantic-faults.ts";

const RelativePathSchema = Type.String({ minLength: 1, pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$" });
const PlatformSchema = Type.Union([Type.Literal("linux/amd64"), Type.Literal("linux/arm64")]);
const CheckGroupSchema = Type.Object({
	passed: Type.Boolean(),
	checks: Type.Array(
		Type.Object({
			id: Type.String({ minLength: 1 }),
			passed: Type.Boolean(),
			message: Type.Optional(Type.String()),
		}),
	),
});

export const LongHorizonBenchmarkManifestSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	id: Type.String({ minLength: 1 }),
	version: Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+$" }),
	canary: Type.String({ minLength: 16 }),
	taskIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
	suites: Type.Record(Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
});

export const LongHorizonTaskSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	id: Type.String({ minLength: 1 }),
	version: Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+$" }),
	family: Type.String({ minLength: 1 }),
	instructionPath: RelativePathSchema,
	environment: Type.Object({
		buildContext: RelativePathSchema,
		workingDirectory: Type.String({ pattern: "^/" }),
		network: Type.Union([Type.Literal("none"), Type.Literal("declared_local_services")]),
		platforms: Type.Array(PlatformSchema, { minItems: 1, uniqueItems: true }),
		cpu: Type.Number({ exclusiveMinimum: 0 }),
		memoryMb: Type.Integer({ minimum: 128 }),
		pids: Type.Integer({ minimum: 16 }),
	}),
	calibration: Type.Object({
		status: Type.Union([Type.Literal("development_proxy"), Type.Literal("human_calibrated")]),
		successfulBaselines: Type.Integer({ minimum: 0 }),
		medianActiveMinutes: Type.Number({ minimum: 0 }),
	}),
	limits: Type.Object({
		trialTimeoutSeconds: Type.Integer({ minimum: 1 }),
		verifierTimeoutSeconds: Type.Integer({ minimum: 1 }),
		maxTurns: Type.Integer({ minimum: 1 }),
		maxCostUsd: Type.Number({ exclusiveMinimum: 0 }),
	}),
	verification: Type.Object({
		objective: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		regression: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		safety: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		integrity: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	}),
	scenarios: Type.Array(SemanticFaultScenarioSchema),
	metadata: Type.Object({
		expertise: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		stages: Type.Array(Type.String({ minLength: 1 }), { minItems: 3 }),
		canary: Type.String({ minLength: 16 }),
	}),
});

export const LongHorizonVerifierReportSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	started: Type.Literal(true),
	completed: Type.Literal(true),
	components: Type.Object({
		objective: CheckGroupSchema,
		regression: CheckGroupSchema,
		safety: CheckGroupSchema,
		integrity: CheckGroupSchema,
		continuity: Type.Optional(CheckGroupSchema),
		terminalSemantics: Type.Optional(CheckGroupSchema),
	}),
});

export type LongHorizonBenchmarkManifest = Static<typeof LongHorizonBenchmarkManifestSchema>;
export type LongHorizonTask = Static<typeof LongHorizonTaskSchema>;
export type LongHorizonVerifierReport = Static<typeof LongHorizonVerifierReportSchema>;

const manifestValidator = Compile(LongHorizonBenchmarkManifestSchema);
const taskValidator = Compile(LongHorizonTaskSchema);
const reportValidator = Compile(LongHorizonVerifierReportSchema);

function validationMessage(
	label: string,
	validator: { Errors(value: unknown): Iterable<{ instancePath?: string; message: string }> },
	value: unknown,
): never {
	const detail = [...validator.Errors(value)]
		.slice(0, 5)
		.map((error) => `${error.instancePath || "/"}: ${error.message}`)
		.join("; ");
	throw new TypeError(`Invalid ${label}: ${detail}`);
}

export function assertLongHorizonBenchmarkManifest(value: unknown): asserts value is LongHorizonBenchmarkManifest {
	if (!manifestValidator.Check(value)) validationMessage("long-horizon benchmark manifest", manifestValidator, value);
}

export function assertLongHorizonTask(value: unknown): asserts value is LongHorizonTask {
	if (!taskValidator.Check(value)) validationMessage("long-horizon task", taskValidator, value);
}

export function assertLongHorizonVerifierReport(value: unknown): asserts value is LongHorizonVerifierReport {
	if (!reportValidator.Check(value)) validationMessage("long-horizon verifier report", reportValidator, value);
}

function assertInside(root: string, path: string): void {
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(path);
	if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
		throw new Error(`Long-horizon benchmark path escapes task root: ${path}`);
	}
}

function hostPlatform(): "linux/amd64" | "linux/arm64" {
	if (process.arch === "x64") return "linux/amd64";
	if (process.arch === "arm64") return "linux/arm64";
	throw new Error(`Unsupported native Eval architecture: ${process.arch}`);
}

function allChecksPassed(report: LongHorizonVerifierReport): boolean {
	return (
		report.components.objective.passed &&
		report.components.regression.passed &&
		report.components.safety.passed &&
		report.components.integrity.passed
	);
}

export class OwnedLongHorizonBenchmarkAdapter implements BenchmarkAdapter {
	readonly #root: string;
	readonly #tasks = new Map<string, LongHorizonTask>();
	#manifest?: LongHorizonBenchmarkManifest;
	#identity?: BenchmarkIdentity;

	constructor(root: string) {
		this.#root = resolve(root);
	}

	async manifest(): Promise<LongHorizonBenchmarkManifest> {
		if (this.#manifest !== undefined) return this.#manifest;
		const value = JSON.parse(await readFile(join(this.#root, "benchmark.json"), "utf8")) as unknown;
		assertLongHorizonBenchmarkManifest(value);
		const known = new Set(value.taskIds);
		for (const [suite, ids] of Object.entries(value.suites)) {
			for (const id of ids) if (!known.has(id)) throw new Error(`Suite ${suite} references unknown task ${id}`);
		}
		this.#manifest = value;
		return value;
	}

	async identity(): Promise<BenchmarkIdentity> {
		if (this.#identity !== undefined) return this.#identity;
		const manifest = await this.manifest();
		this.#identity = {
			name: manifest.id,
			version: manifest.version,
			source: this.#root,
			resolvedDigest: await hashDirectory(this.#root),
		};
		return this.#identity;
	}

	async task(id: string): Promise<LongHorizonTask> {
		const existing = this.#tasks.get(id);
		if (existing !== undefined) return existing;
		const taskRoot = join(this.#root, "tasks", id);
		assertInside(this.#root, taskRoot);
		const value = JSON.parse(await readFile(join(taskRoot, "task.json"), "utf8")) as unknown;
		assertLongHorizonTask(value);
		if (value.id !== id) throw new Error(`Task ID mismatch: expected ${id}, got ${value.id}`);
		this.#tasks.set(id, value);
		return value;
	}

	async listCases(suite?: string): Promise<EvalCase[]> {
		const manifest = await this.manifest();
		const selected = suite === undefined ? manifest.taskIds : manifest.suites[suite];
		if (selected === undefined) throw new Error(`Unknown long-horizon suite: ${suite}`);
		const identity = await this.identity();
		const cases: EvalCase[] = [];
		for (const id of selected) {
			const taskRoot = join(this.#root, "tasks", id);
			assertInside(this.#root, taskRoot);
			const entries = await readdir(taskRoot, { withFileTypes: true });
			if (entries.some((entry) => entry.isSymbolicLink())) {
				throw new Error(`Long-horizon task root contains a symlink: ${taskRoot}`);
			}
			const taskValue = await this.task(id);
			if (!taskValue.environment.platforms.includes(hostPlatform())) {
				throw new Error(`Task ${id} does not support native host platform ${hostPlatform()}`);
			}
			const instructionPath = join(taskRoot, taskValue.instructionPath);
			const buildContext = join(taskRoot, taskValue.environment.buildContext);
			const verifierRoot = join(taskRoot, "verifier");
			for (const path of [instructionPath, buildContext, verifierRoot]) assertInside(taskRoot, path);
			const instruction = (await readFile(instructionPath, "utf8")).trimEnd();
			if (instruction === "") throw new Error(`Task instruction is empty: ${instructionPath}`);
			await readFile(join(buildContext, "Dockerfile"));
			await readFile(join(verifierRoot, "run.sh"));
			const testCase: EvalCase = {
				schemaVersion: 1,
				benchmark: identity,
				id,
				instruction,
				taskRoot,
				environment: {
					kind: "docker",
					buildContext,
					workingDirectory: taskValue.environment.workingDirectory,
					network: taskValue.environment.network === "none" ? "none" : "benchmark_declared",
				},
				verifier: {
					command: ["sh", "/tests/run.sh"],
					testsSource: verifierRoot,
					timeoutSeconds: taskValue.limits.verifierTimeoutSeconds,
				},
				limits: {
					trialTimeoutSeconds: taskValue.limits.trialTimeoutSeconds,
					maxCostUsd: taskValue.limits.maxCostUsd,
				},
				metadata: {
					cpus: taskValue.environment.cpu,
					memoryMb: taskValue.environment.memoryMb,
					pids: taskValue.environment.pids,
					maxTurns: taskValue.limits.maxTurns,
					calibrationStatus: taskValue.calibration.status,
					taskVersion: taskValue.version,
					taskDigest: await hashDirectory(taskRoot),
					manifestDigest: await hashFile(join(taskRoot, "task.json")),
					verifierDigest: await hashDirectory(verifierRoot),
					platform: hostPlatform(),
				},
			};
			assertEvalCase(testCase);
			cases.push(testCase);
		}
		return cases;
	}

	async verify(testCase: EvalCase, environment: EvalEnvironment, runDirectory: string): Promise<OfficialVerification> {
		await environment.copyIn(testCase.verifier.testsSource, "/tests");
		const verifierDirectory = join(runDirectory, "verifier");
		await mkdir(verifierDirectory, { recursive: true, mode: 0o700 });
		const startedAt = performance.now();
		const result = await environment.exec({
			args: testCase.verifier.command,
			cwd: testCase.environment.workingDirectory,
			timeoutSeconds: testCase.verifier.timeoutSeconds,
		});
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
				errors: [{ source: "verifier", code: "timeout", message: "Long-horizon verifier timed out" }],
			};
		}
		try {
			const reportText = await environment.readFile("/logs/verifier/report.json");
			if (reportText === undefined) throw new Error("Verifier did not produce /logs/verifier/report.json");
			const reportValue = JSON.parse(reportText) as unknown;
			assertLongHorizonVerifierReport(reportValue);
			await writeFile(join(verifierDirectory, "report.json"), `${JSON.stringify(reportValue, null, 2)}\n`, {
				mode: 0o600,
			});
			const capabilityPass = reportValue.components.objective.passed && reportValue.components.regression.passed;
			const safetyPass = reportValue.components.safety.passed && reportValue.components.integrity.passed;
			const processPassed = result.exitCode === 0;
			return {
				valid: true,
				metrics: {
					reward: processPassed && allChecksPassed(reportValue) ? 1 : 0,
					capability_pass: capabilityPass ? 1 : 0,
					safety_pass: safetyPass ? 1 : 0,
				},
				exitCode: result.exitCode ?? undefined,
				errors: [],
			};
		} catch (error) {
			return {
				valid: false,
				metrics: {},
				exitCode: result.exitCode ?? undefined,
				errors: [
					{
						source: "verifier",
						code: "invalid_report",
						message: error instanceof Error ? error.message : String(error),
					},
				],
			};
		}
	}
}

export function longHorizonTaskRelativePath(root: string, testCase: EvalCase): string {
	return relative(resolve(root), resolve(testCase.taskRoot));
}
