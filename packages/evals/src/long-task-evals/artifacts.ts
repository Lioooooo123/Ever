import { chmod, lstat, mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { hashFile, sha256 } from "./hash.ts";
import type { EvalRunResult } from "./schemas.ts";
import { AgentIdentitySchema, assertEvalRunResult, BenchmarkIdentitySchema } from "./schemas.ts";

export const EvalJobManifestSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	jobId: Type.String({ minLength: 1 }),
	createdAt: Type.String({ minLength: 1 }),
	benchmark: BenchmarkIdentitySchema,
	agents: Type.Array(AgentIdentitySchema, { minItems: 1 }),
	caseIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	repetitions: Type.Integer({ minimum: 1 }),
	maxCostUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	faultProfile: Type.Optional(Type.String({ minLength: 1 })),
});

export type EvalJobManifest = Static<typeof EvalJobManifestSchema>;

const manifestValidator = Compile(EvalJobManifestSchema);

export function assertEvalJobManifest(value: unknown): asserts value is EvalJobManifest {
	if (manifestValidator.Check(value)) {
		if (!Number.isFinite(Date.parse(value.createdAt)))
			throw new TypeError("Invalid EvalJobManifest v1: /createdAt is not an ISO date-time");
		return;
	}
	const detail = [...manifestValidator.Errors(value)]
		.slice(0, 5)
		.map((error) => `${error.instancePath || "/"}: ${error.message}`)
		.join("; ");
	throw new TypeError(`Invalid EvalJobManifest v1: ${detail}`);
}

export function resultKey(caseId: string, agentName: string, repetition: number): string {
	return `${caseId}\0${agentName}\0${repetition}`;
}

export async function collectRunArtifacts(
	runDirectory: string,
): Promise<{ artifacts: EvalRunResult["artifacts"]; digest: string }> {
	const artifacts: EvalRunResult["artifacts"] = [];
	async function visit(directory: string): Promise<void> {
		const children = await readdir(directory, { withFileTypes: true });
		children.sort((left, right) => left.name.localeCompare(right.name));
		for (const child of children) {
			const path = join(directory, child.name);
			const stat = await lstat(path);
			if (stat.isSymbolicLink()) throw new Error(`Eval artifact may not be a symlink: ${path}`);
			if (stat.isDirectory()) {
				await visit(path);
				continue;
			}
			if (!stat.isFile()) throw new Error(`Unsupported Eval artifact: ${path}`);
			await chmod(path, 0o600);
			const artifactPath = relative(runDirectory, path);
			artifacts.push({ name: artifactPath, path: artifactPath, sha256: await hashFile(path) });
		}
	}
	await visit(runDirectory);
	return { artifacts, digest: sha256(JSON.stringify(artifacts)) };
}

export class LongTaskArtifactStore {
	readonly jobDirectory: string;
	readonly resultsPath: string;

	constructor(root: string, jobId: string) {
		this.jobDirectory = resolve(root, jobId);
		this.resultsPath = join(this.jobDirectory, "results.jsonl");
	}

	async initialize(manifest: EvalJobManifest): Promise<void> {
		assertEvalJobManifest(manifest);
		await mkdir(this.jobDirectory, { recursive: true, mode: 0o700 });
		await chmod(this.jobDirectory, 0o700);
		const manifestPath = join(this.jobDirectory, "job.json");
		try {
			const existing = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
			assertEvalJobManifest(existing);
			if (JSON.stringify(existing) !== JSON.stringify(manifest)) {
				throw new Error(`Eval job ${manifest.jobId} already exists with a different manifest`);
			}
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
		}
	}

	async loadResults(): Promise<EvalRunResult[]> {
		let text: string;
		try {
			text = await readFile(this.resultsPath, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
			throw error;
		}
		const results: EvalRunResult[] = [];
		for (const [index, line] of text.split("\n").entries()) {
			if (line.trim() === "") continue;
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				throw new Error(`Invalid JSON in ${this.resultsPath}:${index + 1}`);
			}
			assertEvalRunResult(value);
			results.push(value);
		}
		return results;
	}

	async completedKeys(): Promise<Set<string>> {
		return new Set(
			(await this.loadResults()).map((result) => resultKey(result.caseId, result.agent.name, result.repetition)),
		);
	}

	async createRunDirectory(runId: string): Promise<string> {
		const safe = (value: string): string => value.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
		const path = join(this.jobDirectory, "runs", safe(runId));
		await mkdir(path, { recursive: true, mode: 0o700 });
		await chmod(path, 0o700);
		return path;
	}

	async appendResult(result: EvalRunResult): Promise<void> {
		assertEvalRunResult(result);
		await mkdir(dirname(this.resultsPath), { recursive: true, mode: 0o700 });
		const handle = await open(this.resultsPath, "a", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(result)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	async writeComparison(markdown: string): Promise<void> {
		await mkdir(this.jobDirectory, { recursive: true, mode: 0o700 });
		await writeFile(join(this.jobDirectory, "comparison.md"), markdown, { encoding: "utf8", mode: 0o600 });
	}

	async writeComparisonJson(value: unknown): Promise<void> {
		await mkdir(this.jobDirectory, { recursive: true, mode: 0o700 });
		await writeFile(join(this.jobDirectory, "comparison.json"), `${JSON.stringify(value, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	}
}
