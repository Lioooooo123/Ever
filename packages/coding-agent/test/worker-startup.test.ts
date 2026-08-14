import { describe, expect, it } from "vitest";
import { parseWorkerStartupEnvelope } from "../src/core/worker-startup.ts";

const executionEnvironment = {
	trust: "sandboxed",
	backend: "seatbelt",
	workspaceRoot: "/tmp/workspace",
	sandboxId: "seatbelt:sandbox-1",
	profileSha256: "c".repeat(64),
	allowedDomains: ["api.anthropic.com"],
	writableRoots: ["/tmp/workspace"],
} as const;

describe("Resident Worker startup envelope", () => {
	it("accepts a provider-scoped credential map and explicit execution environment", () => {
		const envelope = parseWorkerStartupEnvelope({
			schemaVersion: 1,
			token: "a".repeat(32),
			credentials: { anthropic: { type: "api_key", key: "secret" } },
			executionEnvironment,
		});
		expect(envelope).toEqual({
			schemaVersion: 1,
			token: "a".repeat(32),
			credentials: { anthropic: { type: "api_key", key: "secret" } },
			executionEnvironment,
		});
	});

	it("rejects an empty credential map", () => {
		expect(() =>
			parseWorkerStartupEnvelope({
				schemaVersion: 1,
				token: "a".repeat(32),
				credentials: {},
				executionEnvironment,
			}),
		).toThrow("no credentials");
	});

	it("rejects malformed or incomplete credentials", () => {
		expect(() =>
			parseWorkerStartupEnvelope({
				schemaVersion: 1,
				token: "a".repeat(32),
				credentials: { anthropic: { type: "api_key" } },
				executionEnvironment,
			}),
		).toThrow("has no key");
		expect(() =>
			parseWorkerStartupEnvelope({
				schemaVersion: 1,
				token: "a".repeat(32),
				credentials: { anthropic: { type: "oauth", access: "access" } },
				executionEnvironment,
			}),
		).toThrow("incomplete");
	});

	it("accepts only authenticated Eval gates with a domain selector", () => {
		const base = {
			schemaVersion: 1,
			token: "a".repeat(32),
			credentials: { anthropic: { type: "api_key", key: "secret" } },
			executionEnvironment,
		};
		expect(
			parseWorkerStartupEnvelope({
				...base,
				evalEffectGate: {
					directory: "/tmp/eval-gate",
					effect: "reconcilable_write",
					secret: "b".repeat(64),
					domainCommitId: "source:/app/src/cli.mjs",
					evidencePath: "/app/src/cli.mjs",
					targetPath: "/app/src/cli.mjs",
				},
			}).evalEffectGate,
		).toMatchObject({ targetPath: "/app/src/cli.mjs" });
		expect(() =>
			parseWorkerStartupEnvelope({
				...base,
				evalEffectGate: {
					directory: "/tmp/eval-gate",
					effect: "reconcilable_write",
					secret: "b".repeat(64),
					domainCommitId: "source:/app/src/cli.mjs",
					evidencePath: "/app/src/cli.mjs",
				},
			}),
		).toThrow("domain selector");
	});
});
