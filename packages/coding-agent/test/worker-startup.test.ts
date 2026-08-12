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
});
