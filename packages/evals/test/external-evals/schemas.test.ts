import { describe, expect, it } from "vitest";
import { assertExternalEvalConfig } from "../../src/external-evals/schemas.ts";

function config(): unknown {
	return {
		schemaVersion: 1,
		engine: { name: "harbor", version: "0.21.0" },
		benchmark: { kind: "dataset", name: "terminal-bench@2.1", ref: "2.1.0", nTasks: 1 },
		agent: { kind: "harbor", name: "oracle", version: "1.0.0" },
		execution: {
			environment: "docker",
			repetitions: 1,
			concurrency: 1,
			maxTrials: 1,
			maxWallTimeMinutes: 10,
		},
		acceptance: { metrics: { reward: 1 }, allowIncomplete: false },
	};
}

describe("ExternalEvalConfig", () => {
	it("accepts a pinned Harbor dataset without benchmark-specific code", () => {
		expect(() => assertExternalEvalConfig(config())).not.toThrow();
	});

	it("rejects an unpinned latest dataset", () => {
		const value = config() as { benchmark: { ref: string } };
		value.benchmark.ref = "latest";
		expect(() => assertExternalEvalConfig(value)).toThrow("must be pinned");
	});

	it("requires at least one acceptance metric", () => {
		const value = config() as { acceptance: { metrics: Record<string, number> } };
		value.acceptance.metrics = {};
		expect(() => assertExternalEvalConfig(value)).toThrow("must not be empty");
	});

	it("does not forward credential files into registry datasets", () => {
		const value = config() as Record<string, unknown>;
		value.agent = {
			kind: "ever",
			name: "ever",
			version: "1.0.0",
			model: "openai/codex-model",
			artifact: { path: "/tmp/ever", sha256: "a".repeat(64), command: "ever.js" },
			credentialFileEnv: "EVER_EVAL_AUTH_FILE",
		};
		expect(() => assertExternalEvalConfig(value)).toThrow("digest-pinned local benchmark");
	});
});
