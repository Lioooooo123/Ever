import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

export const EvalJobIndexSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		jobId: Type.String({ pattern: "^[A-Za-z0-9._-]+$" }),
		profile: Type.Union([
			Type.Literal("quick"),
			Type.Literal("benchmark"),
			Type.Literal("external"),
			Type.Literal("long-horizon"),
		]),
		createdAt: Type.String({ minLength: 1 }),
		model: Type.Optional(
			Type.Object(
				{ provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) },
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export type EvalJobIndex = Static<typeof EvalJobIndexSchema>;

const validator = Compile(EvalJobIndexSchema);

export function assertEvalJobId(jobId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(jobId) || jobId === "." || jobId === "..")
		throw new Error(`Invalid Eval job ID: ${jobId}`);
}

export function assertEvalJobIndex(value: unknown): asserts value is EvalJobIndex {
	if (validator.Check(value)) {
		assertEvalJobId(value.jobId);
		if (!Number.isFinite(Date.parse(value.createdAt))) throw new TypeError("Invalid EvalJobIndex v1 createdAt");
		return;
	}
	const detail = [...validator.Errors(value)]
		.slice(0, 5)
		.map((error) => `${error.instancePath || "/"}: ${error.message}`)
		.join("; ");
	throw new TypeError(`Invalid EvalJobIndex v1: ${detail}`);
}

export async function writeEvalJobIndex(jobDirectory: string, index: EvalJobIndex): Promise<void> {
	assertEvalJobIndex(index);
	await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
	const path = join(jobDirectory, "eval-job.json");
	try {
		const existing = JSON.parse(await readFile(path, "utf8")) as unknown;
		assertEvalJobIndex(existing);
		if (JSON.stringify(existing) !== JSON.stringify(index))
			throw new Error(`Eval job index differs for ${index.jobId}`);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		await writeFile(path, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	}
}

export async function readEvalJobIndex(jobDirectory: string): Promise<EvalJobIndex> {
	const value = JSON.parse(await readFile(join(resolve(jobDirectory), "eval-job.json"), "utf8")) as unknown;
	assertEvalJobIndex(value);
	if (basename(resolve(jobDirectory)) !== value.jobId)
		throw new Error(`Eval job directory does not match jobId ${value.jobId}`);
	return value;
}

export async function listEvalJobs(artifactRoot: string): Promise<EvalJobIndex[]> {
	let children: Dirent[];
	try {
		children = await readdir(artifactRoot, { withFileTypes: true });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const jobs: EvalJobIndex[] = [];
	for (const child of children) {
		if (!child.isDirectory()) continue;
		try {
			jobs.push(await readEvalJobIndex(join(artifactRoot, child.name)));
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		}
	}
	return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
