import { describe, expect, it } from "vitest";
import { parseWorkerStartupEnvelope } from "../src/core/worker-startup.ts";

describe("Resident Worker startup envelope", () => {
	it("accepts one provider-scoped credential and capability token", () => {
		const envelope = parseWorkerStartupEnvelope({
			schemaVersion: 1,
			token: "a".repeat(32),
			provider: "anthropic",
			credential: { type: "api_key", key: "secret" },
		});
		expect(envelope).toEqual({
			schemaVersion: 1,
			token: "a".repeat(32),
			provider: "anthropic",
			credential: { type: "api_key", key: "secret" },
		});
	});

	it("rejects malformed or incomplete credentials", () => {
		expect(() =>
			parseWorkerStartupEnvelope({
				schemaVersion: 1,
				token: "a".repeat(32),
				provider: "anthropic",
				credential: { type: "api_key" },
			}),
		).toThrow("has no key");
		expect(() =>
			parseWorkerStartupEnvelope({
				schemaVersion: 1,
				token: "a".repeat(32),
				provider: "anthropic",
				credential: { type: "oauth", access: "access" },
			}),
		).toThrow("incomplete");
	});

	it("accepts only authenticated Eval gates with a domain selector", () => {
		const base = {
			schemaVersion: 1,
			token: "a".repeat(32),
			provider: "anthropic",
			credential: { type: "api_key", key: "secret" },
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
