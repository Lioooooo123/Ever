import { describe, expect, it } from "vitest";
import { deriveWorkerToken, workerTokenMatches, workerTokenSha256 } from "../src/daemon/supervisor-credentials.ts";

describe("Supervisor Worker credentials", () => {
	it("derives generation-scoped credentials and verifies descriptor hashes", () => {
		const first = deriveWorkerToken("owner-secret", "worker-1", "generation-1");
		const second = deriveWorkerToken("owner-secret", "worker-1", "generation-2");
		expect(first).not.toBe(second);
		expect(workerTokenMatches(first, workerTokenSha256(first))).toBe(true);
		expect(workerTokenMatches(second, workerTokenSha256(first))).toBe(false);
	});
});
