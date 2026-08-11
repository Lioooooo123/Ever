import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

const DigestSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const JsonScalarSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);

export const BenchmarkIdentitySchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	version: Type.String({ minLength: 1 }),
	source: Type.String({ minLength: 1 }),
	resolvedDigest: DigestSchema,
});

export const AgentIdentitySchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	version: Type.String({ minLength: 1 }),
	executableDigest: DigestSchema,
	modelProvider: Type.String({ minLength: 1 }),
	modelId: Type.String({ minLength: 1 }),
	configurationDigest: DigestSchema,
});

export const EnvironmentIdentitySchema = Type.Object({
	kind: Type.Literal("docker"),
	imageDigest: Type.String({ minLength: 1 }),
	network: Type.Union([Type.Literal("none"), Type.Literal("benchmark_declared")]),
});

export const EvalCaseSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	benchmark: BenchmarkIdentitySchema,
	id: Type.String({ minLength: 1 }),
	instruction: Type.String({ minLength: 1 }),
	taskRoot: Type.String({ minLength: 1 }),
	environment: Type.Object({
		kind: Type.Literal("docker"),
		buildContext: Type.String({ minLength: 1 }),
		imageDigest: Type.Optional(Type.String({ minLength: 1 })),
		workingDirectory: Type.String({ minLength: 1 }),
		network: Type.Union([Type.Literal("none"), Type.Literal("benchmark_declared")]),
	}),
	verifier: Type.Object({
		command: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		testsSource: Type.String({ minLength: 1 }),
		timeoutSeconds: Type.Integer({ minimum: 1 }),
	}),
	limits: Type.Object({
		trialTimeoutSeconds: Type.Integer({ minimum: 1 }),
		maxInputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
		maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
		maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
	}),
	metadata: Type.Record(Type.String(), JsonScalarSchema),
});

export const EvalRunResultSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	runId: Type.String({ minLength: 1 }),
	caseId: Type.String({ minLength: 1 }),
	repetition: Type.Integer({ minimum: 1 }),
	benchmark: BenchmarkIdentitySchema,
	agent: AgentIdentitySchema,
	environment: EnvironmentIdentitySchema,
	outcome: Type.Union([
		Type.Literal("completed"),
		Type.Literal("failed"),
		Type.Literal("timed_out"),
		Type.Literal("waiting_input"),
		Type.Literal("waiting_external"),
		Type.Literal("paused"),
		Type.Literal("unknown_outcome"),
		Type.Literal("infrastructure_error"),
	]),
	official: Type.Object({
		valid: Type.Boolean(),
		metrics: Type.Record(Type.String(), Type.Number()),
		verifierExitCode: Type.Optional(Type.Integer()),
	}),
	usage: Type.Object({
		inputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
		outputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
		totalTokens: Type.Optional(Type.Integer({ minimum: 0 })),
		estimatedCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
		wallTimeMs: Type.Number({ minimum: 0 }),
		toolCalls: Type.Optional(Type.Integer({ minimum: 0 })),
	}),
	integrity: Type.Object({
		environmentDigest: Type.String({ minLength: 1 }),
		instructionDigest: DigestSchema,
		verifierDigest: DigestSchema,
		artifactsDigest: DigestSchema,
		violations: Type.Array(Type.String()),
	}),
	karissa: Type.Optional(
		Type.Object({
			taskId: Type.String({ minLength: 1 }),
			terminalState: Type.String({ minLength: 1 }),
			turns: Type.Integer({ minimum: 0 }),
			checkpoints: Type.Integer({ minimum: 0 }),
			recoveries: Type.Integer({ minimum: 0 }),
			recoveryLatencyMs: Type.Optional(Type.Number({ minimum: 0 })),
			unknownToolOutcomes: Type.Integer({ minimum: 0 }),
			duplicateSideEffects: Type.Integer({ minimum: 0 }),
		}),
	),
	artifacts: Type.Array(
		Type.Object({ name: Type.String({ minLength: 1 }), path: Type.String({ minLength: 1 }), sha256: DigestSchema }),
	),
	errors: Type.Array(
		Type.Object({
			source: Type.String({ minLength: 1 }),
			code: Type.String({ minLength: 1 }),
			message: Type.String(),
		}),
	),
});

export type BenchmarkIdentity = Static<typeof BenchmarkIdentitySchema>;
export type AgentIdentity = Static<typeof AgentIdentitySchema>;
export type EnvironmentIdentity = Static<typeof EnvironmentIdentitySchema>;
export type EvalCase = Static<typeof EvalCaseSchema>;
export type EvalRunResult = Static<typeof EvalRunResultSchema>;

const evalCaseValidator = Compile(EvalCaseSchema);
const resultValidator = Compile(EvalRunResultSchema);

export function assertEvalCase(value: unknown): asserts value is EvalCase {
	if (evalCaseValidator.Check(value)) return;
	const detail = [...evalCaseValidator.Errors(value)]
		.slice(0, 5)
		.map((error) => `${error.instancePath || "/"}: ${error.message}`)
		.join("; ");
	throw new TypeError(`Invalid EvalCase v1: ${detail}`);
}

export function assertEvalRunResult(value: unknown): asserts value is EvalRunResult {
	if (resultValidator.Check(value)) return;
	const detail = [...resultValidator.Errors(value)]
		.slice(0, 5)
		.map((error) => `${error.instancePath || "/"}: ${error.message}`)
		.join("; ");
	throw new TypeError(`Invalid EvalRunResult v1: ${detail}`);
}
