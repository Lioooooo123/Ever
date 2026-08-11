import { createHash } from "node:crypto";
import type { EvalCase } from "./schemas.ts";

export function selectDeterministicCases(cases: readonly EvalCase[], namespace: string, limit: number): EvalCase[] {
	if (!Number.isSafeInteger(limit) || limit < 1)
		throw new RangeError("Case selection limit must be a positive integer");
	const ids = new Set<string>();
	for (const testCase of cases) {
		if (ids.has(testCase.id)) throw new Error(`Duplicate Eval case ID: ${testCase.id}`);
		ids.add(testCase.id);
	}
	return [...cases]
		.sort((left, right) => {
			const leftHash = createHash("sha256").update(`${namespace}\0${left.id}`).digest("hex");
			const rightHash = createHash("sha256").update(`${namespace}\0${right.id}`).digest("hex");
			return leftHash.localeCompare(rightHash) || left.id.localeCompare(right.id);
		})
		.slice(0, limit);
}
