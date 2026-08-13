import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

const DigestSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const MetricThresholdsSchema = Type.Record(Type.String({ minLength: 1 }), Type.Number());

const BenchmarkSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("dataset"),
			name: Type.String({ minLength: 1 }),
			ref: Type.String({ minLength: 1 }),
			taskNames: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
			nTasks: Type.Optional(Type.Integer({ minimum: 1 })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("local"),
			path: Type.String({ minLength: 1 }),
			sha256: DigestSchema,
			taskNames: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
			nTasks: Type.Optional(Type.Integer({ minimum: 1 })),
		},
		{ additionalProperties: false },
	),
]);

const EverAgentSchema = Type.Object(
	{
		kind: Type.Literal("ever"),
		name: Type.Literal("ever"),
		version: Type.String({ minLength: 1 }),
		model: Type.String({ minLength: 1 }),
		artifact: Type.Object(
			{
				path: Type.String({ minLength: 1 }),
				sha256: DigestSchema,
				command: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		credentialFileEnv: Type.Optional(Type.String({ pattern: "^[A-Z_][A-Z0-9_]*$" })),
		maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

const HarborAgentSchema = Type.Object(
	{
		kind: Type.Literal("harbor"),
		name: Type.String({ minLength: 1 }),
		version: Type.String({ minLength: 1 }),
		model: Type.Optional(Type.String({ minLength: 1 })),
		env: Type.Optional(Type.Array(Type.String({ pattern: "^[A-Z_][A-Z0-9_]*$" }), { uniqueItems: true })),
	},
	{ additionalProperties: false },
);

export const ExternalEvalConfigSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		engine: Type.Object(
			{
				name: Type.Literal("harbor"),
				version: Type.String({ pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" }),
				executable: Type.Optional(Type.String({ minLength: 1 })),
			},
			{ additionalProperties: false },
		),
		benchmark: BenchmarkSchema,
		agent: Type.Union([EverAgentSchema, HarborAgentSchema]),
		execution: Type.Object(
			{
				environment: Type.String({ minLength: 1 }),
				repetitions: Type.Integer({ minimum: 1 }),
				concurrency: Type.Integer({ minimum: 1 }),
				maxTrials: Type.Integer({ minimum: 1 }),
				maxWallTimeMinutes: Type.Number({ exclusiveMinimum: 0 }),
				maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
			},
			{ additionalProperties: false },
		),
		acceptance: Type.Object(
			{
				metrics: MetricThresholdsSchema,
				allowIncomplete: Type.Boolean(),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export type ExternalEvalConfig = Static<typeof ExternalEvalConfigSchema>;

export interface ExternalEvalTrialResult {
	trialName: string;
	taskName: string;
	taskDigest?: string;
	agent: { name: string; version: string; model?: string };
	completed: boolean;
	metrics: Record<string, number>;
	wallTimeMs?: number;
	inputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
	error?: string;
}

const validator = Compile(ExternalEvalConfigSchema);

export function assertExternalEvalConfig(value: unknown): asserts value is ExternalEvalConfig {
	if (validator.Check(value)) {
		if (Object.keys(value.acceptance.metrics).length === 0)
			throw new TypeError("External Eval acceptance.metrics must not be empty");
		if (value.benchmark.kind === "dataset" && value.benchmark.ref === "latest")
			throw new TypeError("External Eval dataset ref must be pinned; latest is not allowed");
		if (value.execution.maxTrials < value.execution.repetitions)
			throw new TypeError("External Eval maxTrials must be at least repetitions");
		if (value.execution.concurrency > value.execution.maxTrials)
			throw new TypeError("External Eval concurrency must not exceed maxTrials");
		if (value.agent.kind === "ever" && !value.agent.model.includes("/"))
			throw new TypeError("External Eval Ever model must be pinned as provider/model");
		if (
			value.agent.kind === "ever" &&
			value.agent.credentialFileEnv !== undefined &&
			value.benchmark.kind !== "local"
		) {
			throw new TypeError("External Eval credential forwarding requires a reviewed digest-pinned local benchmark");
		}
		return;
	}
	const detail = [...validator.Errors(value)]
		.slice(0, 5)
		.map((error) => `${error.instancePath || "/"}: ${error.message}`)
		.join("; ");
	throw new TypeError(`Invalid ExternalEvalConfig v1: ${detail}`);
}
