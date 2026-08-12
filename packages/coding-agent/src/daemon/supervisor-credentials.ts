import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function deriveWorkerToken(controlToken: string, workerId: string, supervisorGeneration: string): string {
	if (!controlToken || !workerId || !supervisorGeneration) throw new Error("Worker credential inputs are required");
	return createHmac("sha256", controlToken).update(`ever-worker\0${workerId}\0${supervisorGeneration}`).digest("hex");
}

export function workerTokenSha256(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function workerTokenMatches(token: string, expectedSha256: string): boolean {
	const actual = Buffer.from(workerTokenSha256(token));
	const expected = Buffer.from(expectedSha256);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}
