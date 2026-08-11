import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

const TaskSubmitManifestSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		goal: Type.String({ minLength: 1 }),
		title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		workspaceRoot: Type.String({ minLength: 1 }),
		unattendedApproved: Type.Literal(true),
		model: Type.Optional(
			Type.Object(
				{ provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) },
				{ additionalProperties: false },
			),
		),
		verification: Type.Optional(
			Type.Object(
				{
					command: Type.String({ minLength: 1 }),
					cwd: Type.String({ minLength: 1 }),
					timeoutSeconds: Type.Integer({ minimum: 1, maximum: 86_400 }),
				},
				{ additionalProperties: false },
			),
		),
		limits: Type.Object(
			{
				maxTurns: Type.Integer({ minimum: 1 }),
				maxWallTimeMinutes: Type.Integer({ minimum: 1 }),
				maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export type TaskSubmitManifest = Static<typeof TaskSubmitManifestSchema>;

const validator = Compile(TaskSubmitManifestSchema);

export function readTaskSubmitManifest(path: string, cwd: string): TaskSubmitManifest {
	const manifestPath = resolve(cwd, path);
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read Task submit manifest: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!validator.Check(value)) {
		const detail = [...validator.Errors(value)]
			.slice(0, 5)
			.map((error) => `${error.instancePath || "/"}: ${error.message}`)
			.join("; ");
		throw new TypeError(`Invalid Task submit manifest: ${detail}`);
	}
	if (realpathSync(resolve(cwd, value.workspaceRoot)) !== realpathSync(cwd)) {
		throw new Error("Task submit manifest workspaceRoot must resolve to the current working directory");
	}
	return { ...value, workspaceRoot: realpathSync(cwd) };
}
